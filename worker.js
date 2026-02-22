// Web Worker for WASM download pipeline
// Runs shard decryption, RS reconstruction, and object-level decryption
// off the main thread, posting decrypted chunks back via Transferable ArrayBuffers.
//
// Modes:
// - 'start': Raw download — posts chunks back to main thread
// - 'stream-demux': Download + MP4 demux — posts parsed video/audio samples
//   (moves mp4box.appendBuffer off the main thread to prevent render stalls)

import init, { AppKey, Builder, DownloadOptions, setLogLevel } from './pkg/indexd_wasm.js';
import { createFile as createMP4Box, DataStream, Endianness } from './vendor/mp4box.bundle.js';

function fromHex(h) {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Module-level mp4box reference for seek access across message handlers
let _mp4box = null;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'start') {
    const {
      indexerUrl,
      keyHex,
      maxDownloads,
      objectUrl,
      logLevel,
    } = e.data;

    try {
      // Initialize WASM module
      await init();
      if (logLevel) setLogLevel(logLevel);

      // Build SDK
      const seed = fromHex(keyHex);
      const appKey = new AppKey(seed);
      const builder = new Builder(indexerUrl);

      const sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'error', message: 'SDK connection failed — app key not recognized' });
        return;
      }

      // Get object
      const obj = objectUrl.startsWith('sia://')
        ? await sdk.sharedObject(objectUrl)
        : await sdk.object(objectUrl);

      // Stream download — post chunks back to main thread
      let byteOffset = 0;
      const opts = new DownloadOptions();
      opts.maxInflight = maxDownloads;
      await sdk.downloadStreaming(
        obj,
        opts,
        (chunk) => {
          const buf = chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength,
          );
          self.postMessage(
            { type: 'chunk', offset: byteOffset, size: chunk.byteLength, data: buf },
            [buf], // Transfer the ArrayBuffer (zero-copy)
          );
          byteOffset += chunk.byteLength;
        },
        (current, total) => {
          self.postMessage({ type: 'progress', current, total });
        },
      );

      console.log(`[worker-perf] downloadStreaming resolved (start mode) at ${performance.now().toFixed(1)}`);
      self.postMessage({ type: 'complete' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
  }

  // --- stream-demux: Download + MP4 demuxing in the worker ---
  // Keeps mp4box.appendBuffer() off the main thread so the render loop
  // (rAF + VideoDecoder) is never blocked by MP4 parsing at slab boundaries.
  if (type === 'stream-demux') {
    const { indexerUrl, keyHex, maxDownloads, objectUrl, logLevel } = e.data;
    console.log('[worker-demux] Starting stream-demux:', objectUrl);

    try {
      console.log('[worker-demux] Initializing WASM...');
      await init();
      if (logLevel) setLogLevel(logLevel);
      console.log('[worker-demux] WASM initialized. Connecting SDK...');

      const seed = fromHex(keyHex);
      const appKey = new AppKey(seed);
      const builder = new Builder(indexerUrl);

      const sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'stream-error', message: 'SDK connection failed — app key not recognized' });
        return;
      }
      console.log('[worker-demux] SDK connected. Getting object...');

      const obj = objectUrl.startsWith('sia://')
        ? await sdk.sharedObject(objectUrl)
        : await sdk.object(objectUrl);

      const totalSize = obj.size();
      console.log('[worker-demux] Object ready, size:', totalSize, 'Starting download + demux...');

      console.log('[worker-demux] Creating mp4box instance...');
      const mp4box = createMP4Box();
      _mp4box = mp4box;
      let byteOffset = 0;
      let mp4boxReady = false;
      let audioMode = null;
      console.log('[worker-demux] mp4box created. Setting up handlers...');

      // --- mp4box.onReady: extract codec config, set extraction options, post init ---
      // MUST be fully synchronous (mp4box calls it during appendBuffer).
      mp4box.onReady = (info) => {
        mp4boxReady = true;
        console.log('[worker-demux] mp4box.onReady fired, tracks:', info.tracks.length);

        const mediaTracks = info.tracks.filter(t => t.video || t.audio);
        if (mediaTracks.length === 0) {
          self.postMessage({ type: 'stream-error', message: 'No media tracks found' });
          return;
        }

        const duration = (info.duration && info.timescale) ? info.duration / info.timescale : 0;

        // Video config
        let videoTrackId = null;
        let videoConfig = null;
        for (const track of mediaTracks) {
          if (!track.video || videoTrackId !== null) continue;
          videoTrackId = track.id;
          try {
            const trak = mp4box.getTrackById(track.id);
            const entry = trak.mdia.minf.stbl.stsd.entries[0];
            const descBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            let descBuf = null;
            if (descBox) {
              const s = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
              descBox.write(s);
              descBuf = s.buffer.slice(8);
            }
            videoConfig = {
              codec: track.codec,
              codedWidth: track.video.width,
              codedHeight: track.video.height,
              description: descBuf,
            };
          } catch (err) {
            console.error('[worker-demux] video config extraction failed:', err);
          }
        }

        // Audio config — Pass 1: fMP4 MSE (AAC, Opus, AC-3)
        let audioTrackId = null;
        let audioConfig = null;
        const rawMimeMap = { 'mp4a.6b': 'audio/mpeg', 'mp4a.69': 'audio/mpeg' };

        for (const track of mediaTracks) {
          if (!track.audio || audioTrackId !== null) continue;
          // Worker can't call MediaSource.isTypeSupported — assume common codecs work.
          // Main thread gracefully handles unsupported codecs.
          if (track.codec.startsWith('mp4a.40') || track.codec.startsWith('opus')) {
            audioTrackId = track.id;
            audioMode = 'fmp4-mse';
            mp4box.setSegmentOptions(audioTrackId, 'audio', { nbSamples: 100, rapAlignment: true });
          }
        }

        // Pass 2: raw MSE (MP3)
        if (!audioTrackId) {
          for (const track of mediaTracks) {
            if (!track.audio) continue;
            if (rawMimeMap[track.codec]) {
              audioTrackId = track.id;
              audioMode = 'raw-mse';
              break;
            }
          }
        }

        // Set extraction options SYNCHRONOUSLY before mp4box.start()
        if (videoTrackId !== null) {
          mp4box.setExtractionOptions(videoTrackId, 'video', { nbSamples: 200 });
        }
        if (audioTrackId !== null && audioMode === 'raw-mse') {
          mp4box.setExtractionOptions(audioTrackId, 'audio', { nbSamples: 200 });
        }

        // Init segment for fMP4 audio
        let audioInitBuf = null;
        let audioMime = null;
        if (audioTrackId !== null && audioMode === 'fmp4-mse') {
          const initResult = mp4box.initializeSegmentation();
          audioInitBuf = initResult.buffer || null;
          const t = mediaTracks.find(x => x.id === audioTrackId);
          audioMime = `video/mp4; codecs="${t.codec}"`;
        } else if (audioTrackId !== null && audioMode === 'raw-mse') {
          const t = mediaTracks.find(x => x.id === audioTrackId);
          audioMime = rawMimeMap[t.codec];
        }
        if (audioTrackId !== null) {
          audioConfig = { mode: audioMode, mime: audioMime, initSegment: audioInitBuf };
        }

        mp4box.start();

        const transfers = [];
        if (videoConfig && videoConfig.description) transfers.push(videoConfig.description);
        if (audioConfig && audioConfig.initSegment) transfers.push(audioConfig.initSegment);
        self.postMessage({ type: 'stream-init', videoConfig, audioConfig, duration, totalSize }, transfers);
      };

      // --- mp4box.onSamples: post parsed video/audio samples to main thread ---
      mp4box.onSamples = (trackId, user, samples) => {
        if (user === 'audio' && audioMode === 'raw-mse') {
          for (const sample of samples) {
            const buf = sample.data.buffer.slice(
              sample.data.byteOffset,
              sample.data.byteOffset + sample.data.byteLength
            );
            self.postMessage({ type: 'stream-audio', buffer: buf }, [buf]);
          }
          return;
        }
        if (user !== 'video') return;
        const batch = [];
        const transfers = [];
        for (const sample of samples) {
          const buf = sample.data.buffer.slice(
            sample.data.byteOffset,
            sample.data.byteOffset + sample.data.byteLength
          );
          batch.push({
            data: buf,
            cts: sample.cts,
            duration: sample.duration,
            timescale: sample.timescale,
            is_sync: sample.is_sync,
          });
          transfers.push(buf);
        }
        if (batch.length > 0) {
          self.postMessage({ type: 'stream-video', samples: batch }, transfers);
        }
      };

      // --- mp4box.onSegment: post fMP4 audio segments ---
      mp4box.onSegment = (trackId, user, buffer) => {
        if (user !== 'audio') return;
        self.postMessage({ type: 'stream-audio', buffer }, [buffer]);
      };

      mp4box.onError = (e) => {
        console.error('[worker-demux] mp4box error:', e);
      };

      // Download + demux
      console.log('[worker-demux] Starting downloadStreaming...');
      const opts = new DownloadOptions();
      opts.maxInflight = maxDownloads;
      await sdk.downloadStreaming(
        obj,
        opts,
        (chunk) => {
          const _chunkT0 = performance.now();
          const buf = chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength,
          );
          buf.fileStart = byteOffset;
          byteOffset += chunk.byteLength;
          mp4box.appendBuffer(buf);
          const _chunkDt = performance.now() - _chunkT0;
          if (_chunkDt > 20) console.warn(`[worker-perf] chunk callback: ${_chunkDt.toFixed(1)}ms (${chunk.byteLength} bytes, offset=${byteOffset})`);

          if (byteOffset > 50 * 1024 * 1024 && !mp4boxReady) {
            throw new Error(
              'No moov atom found after 50 MB. The file may have moov at the end. ' +
              'Re-encode with "ffmpeg -i input.mp4 -movflags +faststart output.mp4" to fix.'
            );
          }
        },
        (current, total) => {
          self.postMessage({ type: 'stream-progress', current, total, byteOffset, totalSize });
        },
      );

      console.log(`[worker-perf] downloadStreaming resolved at ${performance.now().toFixed(1)}`);
      const _flushT0 = performance.now();
      mp4box.flush();
      console.log(`[worker-perf] mp4box.flush() took ${(performance.now() - _flushT0).toFixed(1)}ms`);
      self.postMessage({ type: 'stream-complete' });
    } catch (err) {
      self.postMessage({ type: 'stream-error', message: err.message || String(err) });
    }
  }

  // --- seek: manipulate mp4box during an active stream-demux session ---
  if (type === 'seek') {
    if (!_mp4box) return;
    const { timeSec } = e.data;
    _mp4box.stop();
    _mp4box.seek(timeSec, true);
    // Clear stale sample accumulators left over from pre-stop extraction
    if (_mp4box.extractedTracks) {
      for (const t of _mp4box.extractedTracks) t.samples = [];
    }
    if (_mp4box.fragmentedTracks) {
      for (const t of _mp4box.fragmentedTracks) {
        const ns = t.trak.nextSample;
        t.segmentStream = undefined;
        if (t.state) {
          t.state.lastFragmentSampleNumber = ns;
          t.state.lastSegmentSampleNumber = ns;
          t.state.accumulatedSize = 0;
        }
      }
    }
    self.postMessage({ type: 'stream-seek-flushed', timeSec });
    _mp4box.start();
  }
};
