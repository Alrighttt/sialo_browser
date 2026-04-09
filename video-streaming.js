// Video streaming pipelines for the Sialo Browser.
//
// Exports two functions:
//   webcodecStream  — preferred path using WebCodecs VideoDecoder + canvas rendering
//                     with audio via MSE. Handles B-frames, seeking, pause, fullscreen.
//   transmuxAndStream — legacy fallback using MediaSource Extensions (MSE) with a single
//                       SourceBuffer. Works in browsers without WebCodecs support.
//
// Both functions take an SDK object handle, DOM elements, and a helpers object
// containing utility functions (formatSize, getUrl, etc.) so they remain decoupled
// from the main index.html script.
//
// The WebCodecs pipeline delegates rendering, timing, audio MSE, and decode feeding
// to video-pipeline-core.js (shared with sia-injected.js for iframe playback).

const VPC = self.VideoPipelineCore;

// --- WebCodecs streaming pipeline (handles B-frames correctly) ---

export async function webcodecStream(sdk, obj, canvasEl, statusEl, progressEl, objectUrl, helpers) {
  const { formatSize, getUrl, getKeyHex, getMaxDownloads, getLogLevel, _dbg, _dbgWarn } = helpers;

  if (typeof VideoDecoder === 'undefined') {
    throw new Error('WebCodecs API not supported in this browser');
  }

  const totalSize = obj.size();
  statusEl.textContent = `File size: ${formatSize(totalSize)}. Initializing WebCodecs...`;

  // Build shared pipeline state
  const s = VPC.createState();
  s.canvas = canvasEl;
  s.ctx = canvasEl.getContext('2d');

  // Local state (not shared with core)
  let byteOffset = 0;
  let demuxWorker = null;
  let seekPendingFlag = false;
  let mp4boxReady = false;
  let resolveAbort, rejectAbort;
  const abortPromise = new Promise((resolve, reject) => {
    resolveAbort = resolve;
    rejectAbort = reject;
  });

  // Seek state
  let seekInProgress = false;
  let pendingSeekTime = null;
  let bufferedDurationSec = 0;
  let lastBufferedUpdateTime = 0;

  // Approximate buffered duration from download progress (mp4box is in worker)
  function getBufferedDuration() {
    if (s.mediaDuration <= 0) return 0;
    if (s.downloadComplete) return s.mediaDuration;
    const max = progressEl.max || 1;
    const current = progressEl.value || 0;
    return (current / max) * s.mediaDuration;
  }

  function getBufferedDurationThrottled() {
    const now = performance.now();
    if (now - lastBufferedUpdateTime < 1000) return bufferedDurationSec;
    lastBufferedUpdateTime = now;
    bufferedDurationSec = getBufferedDuration();
    return bufferedDurationSec;
  }

  async function seekTo(timeSec) {
    if (!mp4boxReady || s.mediaDuration <= 0) return;

    if (seekInProgress) {
      pendingSeekTime = timeSec;
      return;
    }
    seekInProgress = true;

    // Clamp to buffered range
    const maxSeekable = s.downloadComplete ? s.mediaDuration : getBufferedDuration();
    timeSec = Math.max(0, Math.min(timeSec, maxSeekable - 0.1));

    _dbg(`[webcodec] seekTo: ${timeSec.toFixed(2)}s (buffered: ${maxSeekable.toFixed(2)}s)`);

    // 1. Tell worker to seek (mp4box.stop/seek/start happens in worker thread)
    seekPendingFlag = true;
    if (demuxWorker) demuxWorker.postMessage({ type: 'seek', timeSec });

    // 2. Flush VideoDecoder — drains in-flight decodes
    if (s.decoder && s.decoder.state === 'configured') {
      try {
        await s.decoder.flush();
      } catch (e) {
        _dbgWarn('[webcodec] decoder flush on seek:', e);
      }
    }

    // 3. Clear buffers and reset timing
    VPC.flushBuffers(s);
    VPC.resetTimingForSeek(s, timeSec * 1e6);

    // 4. Handle audio seek
    VPC.seekAudio(s, timeSec);

    // 5. Re-anchor wall clock for non-audio case
    if (!s.hasAudio && !s.paused) {
      s.wallClockStart = performance.now();
      s.videoTimeBase = timeSec * 1e6;
    }

    s.seekPendingDraw = true;
    seekInProgress = false;

    // If another seek was requested during this one, execute it
    if (pendingSeekTime !== null) {
      const t = pendingSeekTime;
      pendingSeekTime = null;
      seekTo(t);
    }
  }

  // --- Render loop (delegates to shared core) ---
  function renderLoop() {
    // Extended stall logging (debug only, not in core)
    const now = performance.now();
    if (s.lastRafTime > 0) {
      const gapMs = now - s.lastRafTime;
      if (gapMs > 50) {
        _dbgWarn(`[perf] rAF gap: ${gapMs.toFixed(1)}ms (missed ${Math.floor(gapMs/16.67)} frames) bufLen=${s.frameBuffer.length} pending=${s.pendingSamples.length} audioQ=${s.audioAppendQueue.length} dlComplete=${s.downloadComplete}`);
      }
    }

    if (!VPC.renderTick(s)) return; // aborted

    // Update buffered indicator (throttled to 1Hz) — specific to main-page player
    if (s.mediaDuration > 0 && !s.seeking) {
      const bufDur = getBufferedDurationThrottled();
      const bufPct = Math.min(100, (bufDur / s.mediaDuration) * 100);
      if (seekBufferedEl) seekBufferedEl.style.width = bufPct + '%';
    }

    requestAnimationFrame(renderLoop);
  }

  let framesReceived = 0;
  function bufferVideoFrame(frame) {
    if (s.aborted) { frame.close(); return; }
    framesReceived++;
    if (framesReceived <= 5) {
      _dbg(`[webcodec] bufferVideoFrame #${framesReceived}: ts=${frame.timestamp} bufLen=${s.frameBuffer.length}`);
    }
    s.frameBuffer.push(frame);
  }

  // --- Handle stream-init from worker: configure VideoDecoder + audio MSE ---
  function handleStreamInit(msg) {
    mp4boxReady = true;

    if (msg.duration && msg.duration > 0) {
      s.mediaDuration = msg.duration;
    }

    const trackDescs = [];
    if (msg.videoConfig) trackDescs.push(`video (${msg.videoConfig.codec})`);
    if (msg.audioConfig) trackDescs.push(`audio (${msg.audioConfig.mime})`);
    statusEl.textContent = `Tracks: ${trackDescs.join(', ')}. Configuring decoders...`;

    // --- Audio setup (via shared core MSE helpers) ---
    if (msg.audioConfig && audioMediaSourceReady) {
      try {
        s.audioMode = msg.audioConfig.mode;
        s.audioSourceBuffer = s.audioMediaSource.addSourceBuffer(msg.audioConfig.mime);
        s.audioSourceBuffer.addEventListener('updateend', () => {
          s.audioSbAppending = false;
          VPC.drainAudioQueue(s);
          VPC.maybeEndAudio(s);
        });
        s.audioSourceBuffer.addEventListener('error', (e) => {
          _dbgWarn('[webcodec] Audio SourceBuffer error:', e);
        });
        s.hasAudio = true;

        if (msg.audioConfig.initSegment) {
          s.audioInitSegment = msg.audioConfig.initSegment.slice
            ? msg.audioConfig.initSegment.slice(0) : msg.audioConfig.initSegment;
          s.audioAppendQueue.push(msg.audioConfig.initSegment);
          VPC.drainAudioQueue(s);
        }

        s.audioEl.play().catch(() => {});
        _dbg(`[webcodec] Audio MSE ready: ${msg.audioConfig.mime} (${msg.audioConfig.mode})`);
      } catch (e) {
        _dbgWarn('[webcodec] Audio setup failed:', e);
        s.hasAudio = false;
      }
    }

    // --- Video decoder setup (via shared core) ---
    if (msg.videoConfig) {
      VPC.configureDecoder(s, msg.videoConfig, bufferVideoFrame, (e) => {
        console.error('[webcodec] VideoDecoder error:', e);
        if (!s.aborted) {
          s.aborted = true;
          rejectAbort(new Error(`Video decoder error: ${e.message}`));
        }
      });

      _dbg(`[webcodec] VideoDecoder configured: ${msg.videoConfig.codec} ${msg.videoConfig.codedWidth}x${msg.videoConfig.codedHeight}`);
    }

    if (!s.decoder) {
      rejectAbort(new Error('No supported video codec found'));
      return;
    }

    // Start render loop
    s.renderRunning = true;
    requestAnimationFrame(renderLoop);

    statusEl.textContent = `Streaming: ${trackDescs.join(', ')}`;
  }

  // --- Controls wiring ---
  const container = document.getElementById('video-container');
  const controlsEl = document.getElementById('video-controls');
  const playBtn = document.getElementById('vc-playpause');
  const volSlider = document.getElementById('vc-volume');
  const fsBtn = document.getElementById('vc-fullscreen');
  const seekbarEl = document.getElementById('vc-seekbar');
  const seekPlayedEl = document.getElementById('vc-seek-played');
  const seekBufferedEl = document.getElementById('vc-seek-buffered');
  const seekThumbEl = document.getElementById('vc-seek-thumb');

  // Wire shared state to UI elements
  s.playBtn = playBtn;
  s.seekPlayed = seekPlayedEl;
  s.seekThumb = seekThumbEl;
  // timeSpan is updated by core's updateTimeUI
  s.timeSpan = document.getElementById('vc-time');

  let hideTimeout;
  function showControls() {
    controlsEl.style.opacity = '1';
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (!s.paused) controlsEl.style.opacity = '0';
    }, 3000);
  }
  container.addEventListener('mousemove', showControls);
  container.addEventListener('mouseenter', showControls);
  container.addEventListener('touchstart', showControls);
  container.addEventListener('click', showControls);
  // Always show controls when paused
  const origToggle = VPC.togglePause;
  const showOnPause = () => { if (s.paused) showControls(); };
  // Keep controls visible while paused (checked in hide timeout above)
  showControls();

  canvasEl.addEventListener('click', () => VPC.togglePause(s));
  playBtn.addEventListener('click', () => VPC.togglePause(s));
  playBtn.innerHTML = '&#9646;&#9646;';

  volSlider.addEventListener('input', () => {
    if (s.audioEl) s.audioEl.volume = parseFloat(volSlider.value);
  });

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {});
    }
  });

  // Keyboard controls (Space=pause, F=fullscreen)
  const keyHandler = (e) => {
    if (!container.offsetParent && !document.fullscreenElement) return; // not visible
    if (e.key === ' ') { e.preventDefault(); VPC.togglePause(s); showControls(); }
    else if (e.key === 'f' || e.key === 'F') { fsBtn.click(); }
  };
  document.addEventListener('keydown', keyHandler);

  // --- Seek bar interaction ---
  let seekbarDragging = false;

  function seekbarPctFromEvent(e) {
    const rect = seekbarEl.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }

  function seekbarUpdateTimeDisplay(timeSec) {
    const timeEl = document.getElementById('vc-time');
    if (!timeEl || s.mediaDuration <= 0) return;
    timeEl.textContent = VPC.formatTime(timeSec) + ' / ' + VPC.formatTime(s.mediaDuration);
  }

  function seekbarClampPct(pct) {
    if (!s.downloadComplete && s.mediaDuration > 0) {
      const maxPct = Math.min(1, getBufferedDuration() / s.mediaDuration);
      return Math.min(pct, maxPct);
    }
    return pct;
  }

  function seekbarStartDrag(e) {
    if (s.mediaDuration <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    seekbarDragging = true;
    s.seeking = true;
    seekThumbEl.style.opacity = '1';

    let pct = seekbarPctFromEvent(e);
    pct = seekbarClampPct(pct);
    seekPlayedEl.style.width = (pct * 100) + '%';
    seekThumbEl.style.left = (pct * 100) + '%';
    seekbarUpdateTimeDisplay(pct * s.mediaDuration);
  }

  function seekbarMoveDrag(e) {
    if (!seekbarDragging) return;
    e.preventDefault();
    let pct = seekbarPctFromEvent(e);
    pct = seekbarClampPct(pct);
    seekPlayedEl.style.width = (pct * 100) + '%';
    seekThumbEl.style.left = (pct * 100) + '%';
    seekbarUpdateTimeDisplay(pct * s.mediaDuration);
  }

  function seekbarEndDrag(e) {
    if (!seekbarDragging) return;
    seekbarDragging = false;
    s.seeking = false;

    const pctStr = seekPlayedEl.style.width;
    const pct = parseFloat(pctStr) / 100;
    seekTo(pct * s.mediaDuration);
  }

  seekbarEl.addEventListener('mousedown', seekbarStartDrag);
  document.addEventListener('mousemove', seekbarMoveDrag);
  document.addEventListener('mouseup', seekbarEndDrag);

  seekbarEl.addEventListener('touchstart', seekbarStartDrag, { passive: false });
  document.addEventListener('touchmove', seekbarMoveDrag, { passive: false });
  document.addEventListener('touchend', seekbarEndDrag);

  seekbarEl.addEventListener('click', (e) => {
    if (s.mediaDuration <= 0) return;
    e.stopPropagation();
    let pct = seekbarPctFromEvent(e);
    pct = seekbarClampPct(pct);
    seekTo(pct * s.mediaDuration);
  });

  // --- Set up hidden <audio> element with MSE for audio playback ---
  let audioMediaSourceReady = false;
  if (window.MediaSource) {
    s.audioEl = document.createElement('audio');
    s.audioEl.style.display = 'none';
    document.body.appendChild(s.audioEl);
    s.audioMediaSource = new MediaSource();
    s.audioEl.src = URL.createObjectURL(s.audioMediaSource);

    await new Promise((resolve) => {
      if (s.audioMediaSource.readyState === 'open') resolve();
      else s.audioMediaSource.addEventListener('sourceopen', resolve, { once: true });
    });
    audioMediaSourceReady = true;
    _dbg('[webcodec] Audio MediaSource ready');
  }

  // --- Stream data from SDK via Web Worker (demuxing in worker) ---
  progressEl.style.display = 'block';
  const downloadStart = performance.now();

  const worker = new Worker('./worker.js', { type: 'module' });
  demuxWorker = worker;

  const streamPromise = new Promise((resolveStream, rejectStream) => {
    worker.onmessage = (e) => {
      const msg = e.data;

      const _msgT0 = performance.now();
      if (msg.type === 'stream-init') {
        handleStreamInit(msg);
      } else if (msg.type === 'stream-video') {
        if (s.aborted || seekPendingFlag) return;
        for (const sample of msg.samples) s.pendingSamples.push(sample);
        const _dt = performance.now() - _msgT0;
        if (_dt > 5) _dbgWarn(`[perf] stream-video handler: ${_dt.toFixed(1)}ms (${msg.samples.length} samples, pendingTotal=${s.pendingSamples.length})`);
      } else if (msg.type === 'stream-audio') {
        if (s.aborted || seekPendingFlag) return;
        s.audioAppendQueue.push(msg.buffer);
        VPC.drainAudioQueue(s);
        const _dt = performance.now() - _msgT0;
        if (_dt > 5) _dbgWarn(`[perf] stream-audio handler: ${_dt.toFixed(1)}ms (queueLen=${s.audioAppendQueue.length})`);
      } else if (msg.type === 'stream-progress') {
        if (s.aborted) return;
        progressEl.max = msg.total;
        progressEl.value = msg.current;
        byteOffset = msg.byteOffset;
        const pct = msg.total > 0 ? ((msg.current / msg.total) * 100).toFixed(0) : 0;
        statusEl.textContent = `Streaming: ${pct}% — ${formatSize(msg.current)} / ${formatSize(msg.total)}`;
        if (msg.current === msg.total) _dbg(`[perf] last progress message received at ${_msgT0.toFixed(1)}`);
      } else if (msg.type === 'stream-seek-flushed') {
        VPC.flushBuffers(s);
        seekPendingFlag = false;
      } else if (msg.type === 'stream-complete') {
        _dbg(`[perf] stream-complete received at ${performance.now().toFixed(1)}`);
        requestAnimationFrame(() => {
          _dbg(`[perf] stream-complete resolving at ${performance.now().toFixed(1)}`);
          resolveStream();
        });
      } else if (msg.type === 'stream-error') {
        rejectStream(new Error(msg.message));
      }
    };

    worker.onerror = (e) => {
      rejectStream(new Error(`Worker error: ${e.message}`));
    };
  });

  // Start the download + demux worker. If overrideConfig is set (fallback
  // indexer), use those credentials instead of the active profile.
  const overrideConfig = helpers.overrideConfig;
  worker.postMessage({
    type: 'stream-demux',
    indexerUrl: overrideConfig?.indexerUrl || getUrl(),
    keyHex: overrideConfig?.keyHex || getKeyHex(),
    maxDownloads: getMaxDownloads(),
    objectUrl: objectUrl,
    logLevel: getLogLevel(),
  });

  try {
    await Promise.race([streamPromise, abortPromise]);
  } catch (e) {
    s.aborted = true;
    worker.terminate();
    throw e;
  }

  if (!s.aborted) {
    const _completionT0 = performance.now();
    _dbg(`[perf] completion continuation starting at ${_completionT0.toFixed(1)}`);
    s.downloadComplete = true;
    progressEl.value = progressEl.max;

    const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
    statusEl.textContent = `Stream complete! ${formatSize(totalSize)} in ${elapsed}s.`;
    _dbg(`[perf] completion continuation done in ${(performance.now() - _completionT0).toFixed(1)}ms`);
  }

  return {
    abort: () => {
      VPC.abort(s);
      worker.terminate();
      clearTimeout(hideTimeout);
      resolveAbort();
    }
  };
}

// --- MSE streaming pipeline (legacy fallback for browsers without WebCodecs) ---

export async function transmuxAndStream(sdk, obj, videoEl, statusEl, progressEl, helpers) {
  const { formatSize, getMaxDownloads, DownloadOptions, createMP4Box, _dbg, _dbgWarn } = helpers;

  if (!window.MediaSource) {
    throw new Error('MediaSource Extensions not supported in this browser');
  }

  const totalSize = obj.size();
  statusEl.textContent = `File size: ${formatSize(totalSize)}. Initializing...`;

  const mp4box = createMP4Box();
  const mediaSource = new MediaSource();
  videoEl.src = URL.createObjectURL(mediaSource);

  // State
  let byteOffset = 0;
  let downloadComplete = false;
  let mp4boxReady = false;
  let aborted = false;
  let resolveAbort, rejectAbort;
  const abortPromise = new Promise((resolve, reject) => {
    resolveAbort = resolve;
    rejectAbort = reject;
  });

  // Wait for sourceopen
  await new Promise((resolve, reject) => {
    mediaSource.addEventListener('sourceopen', resolve, { once: true });
    mediaSource.addEventListener('error', () => reject(new Error('MediaSource failed to open')), { once: true });
    setTimeout(() => reject(new Error('MediaSource sourceopen timeout')), 5000);
  });

  statusEl.textContent = 'MediaSource opened. Downloading first slab...';

  function maybeEndOfStream() {
    if (!downloadComplete) return;
    if (appendQueue.length > 0 || sbAppending) return;
    if (mediaSource.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch (e) {}
    }
  }

  let sourceBuffer = null;
  const appendQueue = [];
  let sbAppending = false;

  mp4box.onReady = (info) => {
    mp4boxReady = true;
    _dbg('[stream] onReady fired. All tracks:', info.tracks.map(t => ({
      id: t.id, codec: t.codec, video: !!t.video, audio: !!t.audio,
      type: t.type, name: t.name
    })));

    const mediaTracks = info.tracks.filter(t => t.video || t.audio);
    _dbg('[stream] Media tracks:', mediaTracks.map(t => ({
      id: t.id, codec: t.codec, video: !!t.video, audio: !!t.audio,
    })));

    if (mediaTracks.length === 0) {
      rejectAbort(new Error('No video or audio tracks found'));
      return;
    }

    const trackDescs = mediaTracks.map(t =>
      `${t.video ? 'video' : 'audio'} (${t.codec})`
    ).join(', ');
    statusEl.textContent = `Tracks: ${trackDescs}. Starting playback...`;

    const codecs = mediaTracks.map(t => t.codec).join(', ');
    const mime = `video/mp4; codecs="${codecs}"`;
    _dbg(`[stream] Combined MIME: ${mime}`);

    if (!MediaSource.isTypeSupported(mime)) {
      console.error(`[stream] MIME not supported: ${mime}`);
      rejectAbort(new Error(`Codec not supported by browser: ${mime}`));
      return;
    }

    sourceBuffer = mediaSource.addSourceBuffer(mime);
    sourceBuffer.addEventListener('updateend', () => {
      sbAppending = false;
      if (needsEviction) {
        tryEvict();
      } else {
        drainAppendQueue();
      }
    });
    sourceBuffer.addEventListener('error', (e) => {
      console.error('[stream] SourceBuffer error:', e, 'readyState:', mediaSource.readyState);
      if (!aborted) {
        aborted = true;
        rejectAbort(new Error('SourceBuffer error — the video may use features incompatible with browser streaming'));
      }
    });

    videoEl.addEventListener('timeupdate', () => {
      if (needsEviction && !sbAppending && sourceBuffer && !sourceBuffer.updating) {
        tryEvict();
      }
    });

    for (const track of mediaTracks) {
      mp4box.setSegmentOptions(track.id, null, { nbSamples: 100, rapAlignment: true });
    }

    const initResult = mp4box.initializeSegmentation();
    _dbg('[stream] Init segment:', {
      tracks: initResult.tracks,
      bufferSize: initResult.buffer?.byteLength
    });

    if (initResult.buffer) {
      appendQueue.push(initResult.buffer);
      drainAppendQueue();
    }

    mp4box.start();
    videoEl.play().catch(e => _dbg('[stream] autoplay blocked:', e.message));
  };

  let needsEviction = false;

  function tryEvict() {
    if (aborted || !sourceBuffer || sourceBuffer.updating || sbAppending) return;
    if (mediaSource.readyState !== 'open') return;
    if (!sourceBuffer.buffered || sourceBuffer.buffered.length === 0) {
      needsEviction = false;
      drainAppendQueue();
      return;
    }

    const currentTime = videoEl.currentTime;
    const bufferedStart = sourceBuffer.buffered.start(0);
    const keepBehind = 5;

    if (currentTime - bufferedStart > keepBehind) {
      const removeEnd = currentTime - keepBehind;
      _dbg(`[stream] Evicting buffer: ${bufferedStart.toFixed(1)}s → ${removeEnd.toFixed(1)}s (playhead at ${currentTime.toFixed(1)}s)`);
      sbAppending = true;
      sourceBuffer.remove(bufferedStart, removeEnd);
      needsEviction = false;
    }
  }

  function drainAppendQueue() {
    if (aborted) return;
    if (!sourceBuffer || sbAppending || appendQueue.length === 0) {
      maybeEndOfStream();
      return;
    }
    if (mediaSource.readyState !== 'open') return;
    if (sourceBuffer.buffered && sourceBuffer.buffered.length > 0) {
      const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      const bufferedStart = sourceBuffer.buffered.start(0);
      const currentTime = videoEl.currentTime;
      if (bufferedEnd - currentTime > 60 && currentTime - bufferedStart > 5) {
        _dbg(`[stream] Proactive eviction: ${(bufferedEnd - currentTime).toFixed(0)}s buffered ahead`);
        needsEviction = true;
        tryEvict();
        return;
      }
    }
    const buf = appendQueue.shift();
    sbAppending = true;
    try {
      sourceBuffer.appendBuffer(buf);
    } catch (e) {
      sbAppending = false;
      if (e.name === 'QuotaExceededError') {
        appendQueue.unshift(buf);
        if (!needsEviction) {
          _dbgWarn('[stream] QuotaExceededError, waiting for playback to advance...');
        }
        needsEviction = true;
        tryEvict();
      } else {
        console.error('[stream] appendBuffer error:', e);
      }
    }
  }

  let segmentCount = 0;
  mp4box.onSegment = (trackId, user, buffer) => {
    segmentCount++;
    if (segmentCount <= 5 || segmentCount % 20 === 0) {
      _dbg(`[stream] onSegment #${segmentCount}: track=${trackId} size=${buffer.byteLength}`);
    }
    appendQueue.push(buffer);
    if (!needsEviction) {
      drainAppendQueue();
    }
  };

  mp4box.onError = (e) => {
    console.error('[stream] mp4box error:', e);
  };

  // Stream data
  progressEl.style.display = 'block';
  const downloadStart = performance.now();

  let chunkCount = 0;
  const dlOpts2 = new DownloadOptions(getMaxDownloads());
  const streamPromise = sdk.downloadStreaming(obj,
    (chunk) => {
      if (aborted) return;
      chunkCount++;
      const buf = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength
      );
      buf.fileStart = byteOffset;
      if (chunkCount <= 3) {
        _dbg(`[stream] chunk #${chunkCount}: size=${chunk.byteLength} fileStart=${byteOffset}`);
      }
      byteOffset += chunk.byteLength;
      mp4box.appendBuffer(buf);
    },
    (current, total) => {
      if (aborted) return;
      progressEl.max = total;
      progressEl.value = current;
      const pct = total > 0 ? ((current / total) * 100).toFixed(0) : 0;
      statusEl.textContent = `Streaming: ${pct}% — ${formatSize(current)} / ${formatSize(total)}`;

      if (byteOffset > 50 * 1024 * 1024 && !mp4boxReady) {
        aborted = true;
        rejectAbort(new Error(
          'No moov atom found after 50 MB. The file may have moov at the end (common with GoPro/camera recordings). ' +
          'Re-encode with "ffmpeg -i input.mp4 -movflags +faststart output.mp4" to fix, or use the Download section.'
        ));
      }
    },
    dlOpts2,
  );

  try {
    await Promise.race([streamPromise, abortPromise]);
  } catch (e) {
    aborted = true;
    throw e;
  }

  if (!aborted) {
    downloadComplete = true;
    mp4box.flush();
    progressEl.value = progressEl.max;
    drainAppendQueue();
    const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
    statusEl.textContent = `Stream complete! ${formatSize(totalSize)} downloaded in ${elapsed}s.`;
  }

  return {
    abort: () => {
      aborted = true;
      try { mp4box.flush(); } catch (e) {}
      if (mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch (e) {}
      }
      resolveAbort();
    }
  };
}
