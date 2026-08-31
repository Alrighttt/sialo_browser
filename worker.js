// Web Worker for WASM download pipeline
// Runs shard decryption, RS reconstruction, and object-level decryption
// off the main thread, posting decrypted chunks back via Transferable ArrayBuffers.
//
// Modes:
// - 'start': Raw download — posts chunks back to main thread
// - 'stream-demux': Download + MP4 demux — posts parsed video/audio samples
//   (moves mp4box.appendBuffer off the main thread to prevent render stalls)

import init, { AppKey, Builder, setLogger } from './pkg/sia_storage_wasm.js';
import { createFile as createMP4Box, DataStream, Endianness } from './vendor/mp4box.bundle.js';
import { fromHex } from './worker-utils.js';

// Module-level mp4box reference for seek access across message handlers
let _mp4box = null;

// Debug logging — gated by logLevel passed from main thread
let _debugEnabled = false;
function _dbg(...args) { if (_debugEnabled) console.log(...args); }
function _dbgWarn(...args) { if (_debugEnabled) console.warn(...args); }

// Score an audio track codec by how well browsers can play it. Higher is
// better. Used to pick among multiple audio tracks so AC-3 (unsupported on
// Chrome/macOS) never wins over MP3/AAC/Opus.
function audioCodecScore(codec) {
  if (codec.startsWith('mp4a.40.2')) return 100; // AAC-LC — universally supported
  if (codec.startsWith('mp4a.40')) return 90;    // other AAC profiles / MP3-in-MP4
  if (codec === 'mp4a.6b' || codec === 'mp4a.69') return 80; // raw MP3
  if (codec.startsWith('opus')) return 70;       // Opus
  if (codec === 'ac-3' || codec === 'ec-3') return 10; // AC-3/EC-3 — platform-dependent
  return 50;
}

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
      _debugEnabled = !!logLevel;
      if (logLevel) setLogger((msg) => console.log(msg), logLevel);

      // Build SDK
      const appKey = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(keyHex)));
      const builder = new Builder(indexerUrl, { appId: 'c0000000000000000000000000000000000000000000000000000000000000de', name: 'Sialo', description: 'Sialo Browser worker', serviceUrl: 'https://sialo.io' });

      const sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'error', message: 'SDK connection failed — app key not recognized' });
        return;
      }

      // Get object
      const obj = objectUrl.startsWith('sia://')
        ? await sdk.objectFromShareUrl(objectUrl)
        : await sdk.object(objectUrl);

      // Stream download — post chunks back to main thread
      let byteOffset = 0;
      const totalSize = obj.size();
      const stream = sdk.download(obj, { maxInflight: maxDownloads });
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        );
        self.postMessage(
          { type: 'chunk', offset: byteOffset, size: value.byteLength, data: buf },
          [buf],
        );
        byteOffset += value.byteLength;
        self.postMessage({ type: 'progress', current: byteOffset, total: totalSize });
      }

      _dbg(`[worker-perf] download resolved (start mode) at ${performance.now().toFixed(1)}`);
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
    _dbg('[worker-demux] Starting stream-demux:', objectUrl);

    try {
      _dbg('[worker-demux] Initializing WASM...');
      await init();
      _debugEnabled = !!logLevel;
      if (logLevel) setLogger((msg) => console.log(msg), logLevel);
      _dbg('[worker-demux] WASM initialized. Connecting SDK...');

      const appKey = new AppKey(((s) => s.length === 64 ? s.slice(0, 32) : s)(fromHex(keyHex)));
      const builder = new Builder(indexerUrl, { appId: 'c0000000000000000000000000000000000000000000000000000000000000de', name: 'Sialo', description: 'Sialo Browser worker', serviceUrl: 'https://sialo.io' });

      const sdk = await builder.connected(appKey);
      if (!sdk) {
        self.postMessage({ type: 'stream-error', message: 'SDK connection failed — app key not recognized' });
        return;
      }
      _dbg('[worker-demux] SDK connected. Getting object...');

      const obj = objectUrl.startsWith('sia://')
        ? await sdk.objectFromShareUrl(objectUrl)
        : await sdk.object(objectUrl);

      const totalSize = obj.size();
      _dbg('[worker-demux] Object ready, size:', totalSize, 'Starting download + demux...');

      _dbg('[worker-demux] Creating mp4box instance...');
      const mp4box = createMP4Box();
      _mp4box = mp4box;
      let byteOffset = 0;
      let mp4boxReady = false;
      let audioMode = null;
      _dbg('[worker-demux] mp4box created. Setting up handlers...');

      // --- mp4box.onReady: extract codec config, set extraction options, post init ---
      // MUST be fully synchronous (mp4box calls it during appendBuffer).
      mp4box.onReady = (info) => {
        mp4boxReady = true;
        _dbg('[worker-demux] mp4box.onReady fired, tracks:', info.tracks.length);

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

        // Pick the best audio track by codec preference so files with
        // multiple audio streams (e.g. AC-3 + MP3) don't land on a codec
        // Chrome can't play.
        const rawMimeMap = { 'mp4a.6b': 'audio/mpeg', 'mp4a.69': 'audio/mpeg' };
        let audioTrackId = null;
        let audioTrack = null;
        let bestScore = -1;
        for (const track of mediaTracks) {
          if (!track.audio) continue;
          const isRaw = !!rawMimeMap[track.codec];
          const isFmp4 = track.codec.startsWith('mp4a.40') || track.codec.startsWith('opus') || track.codec === 'ac-3' || track.codec === 'ec-3';
          if (!isRaw && !isFmp4) continue;
          const score = audioCodecScore(track.codec);
          if (score > bestScore) {
            bestScore = score;
            audioTrackId = track.id;
            audioTrack = track;
            audioMode = isRaw ? 'raw-mse' : 'fmp4-mse';
          }
        }

        if (videoTrackId !== null) {
          mp4box.setExtractionOptions(videoTrackId, 'video', { nbSamples: 200 });
        }
        if (audioTrackId !== null && audioMode === 'raw-mse') {
          mp4box.setExtractionOptions(audioTrackId, 'audio', { nbSamples: 200 });
        }
        if (audioTrackId !== null && audioMode === 'fmp4-mse') {
          mp4box.setSegmentOptions(audioTrackId, 'audio', { nbSamples: 100, rapAlignment: true });
        }

        let audioInitBuf = null;
        let audioMime = null;
        let audioConfig = null;
        if (audioTrackId !== null && audioMode === 'fmp4-mse') {
          const initResult = mp4box.initializeSegmentation();
          audioInitBuf = initResult && initResult.buffer ? initResult.buffer : null;
          audioMime = `video/mp4; codecs="${audioTrack.codec}"`;
        } else if (audioTrackId !== null && audioMode === 'raw-mse') {
          audioMime = rawMimeMap[audioTrack.codec];
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
      _dbg('[worker-demux] Starting download...');
      const stream = sdk.download(obj, { maxInflight: maxDownloads });
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const _chunkT0 = performance.now();
        const buf = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        );
        buf.fileStart = byteOffset;
        byteOffset += value.byteLength;
        mp4box.appendBuffer(buf);
        const _chunkDt = performance.now() - _chunkT0;
        if (_chunkDt > 20) _dbgWarn(`[worker-perf] chunk callback: ${_chunkDt.toFixed(1)}ms (${value.byteLength} bytes, offset=${byteOffset})`);

        if (byteOffset > 50 * 1024 * 1024 && !mp4boxReady) {
          throw new Error(
            'No moov atom found after 50 MB. The file may have moov at the end. ' +
            'Re-encode with "ffmpeg -i input.mp4 -movflags +faststart output.mp4" to fix.'
          );
        }
        self.postMessage({ type: 'stream-progress', current: byteOffset, total: totalSize, byteOffset, totalSize });
      }

      _dbg(`[worker-perf] download resolved at ${performance.now().toFixed(1)}`);
      const _flushT0 = performance.now();
      mp4box.flush();
      _dbg(`[worker-perf] mp4box.flush() took ${(performance.now() - _flushT0).toFixed(1)}ms`);
      _mp4box = null;
      self.postMessage({ type: 'stream-complete' });
    } catch (err) {
      _mp4box = null;
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
