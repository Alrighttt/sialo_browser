// Video streaming pipelines for the Sia Browser.
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

// --- WebCodecs streaming pipeline (handles B-frames correctly) ---

export async function webcodecStream(sdk, obj, canvasEl, statusEl, progressEl, objectUrl, helpers) {
  const { formatSize, getUrl, getKeyHex, getMaxDownloads, getLogLevel } = helpers;

  if (typeof VideoDecoder === 'undefined') {
    throw new Error('WebCodecs API not supported in this browser');
  }

  const totalSize = obj.size();
  statusEl.textContent = `File size: ${formatSize(totalSize)}. Initializing WebCodecs...`;

  // State
  let byteOffset = 0;
  let demuxWorker = null;   // worker handle (needed by seekTo before worker is created)
  let seekPendingFlag = false; // true between seek request and worker flush
  let downloadComplete = false;
  let mp4boxReady = false;
  let aborted = false;
  let resolveAbort, rejectAbort;
  const abortPromise = new Promise((resolve, reject) => {
    resolveAbort = resolve;
    rejectAbort = reject;
  });

  // WebCodecs video decoder
  let videoDecoder = null;

  // Video rendering
  const ctx = canvasEl.getContext('2d');
  const frameBuffer = []; // holds only UNDISPLAYED future frames
  const FRAME_BUFFER_MAX = 6;
  let renderLoopRunning = false;
  let canvasSized = false;
  let paused = false;
  let pauseOffsetUs = 0; // microseconds of media time accumulated before pause

  // Audio via MSE (hidden <audio> element with SourceBuffer)
  let audioEl = null;
  let audioMediaSource = null;
  let audioSourceBuffer = null;
  const audioAppendQueue = [];
  let audioSbAppending = false;
  let hasAudio = false;
  let audioMode = null; // 'fmp4-mse' (setSegmentOptions) or 'raw-mse' (setExtractionOptions → audio/mpeg)

  // Video-only timing (used when no audio clock is available)
  let wallClockStart = 0;   // performance.now() when first frame is displayed
  let videoTimeBase = -1;   // PTS (microseconds) of the first displayed video frame
  let wallClockSynced = false; // true once first frame display establishes timing

  // Stall compensation: when the main thread is blocked (WASM slab processing),
  // rAF stops firing. When it resumes, the wall clock has jumped forward.
  // Instead of skipping frames (visible stutter), we absorb the excess time
  // so the video effectively "pauses" during the stall and resumes smoothly.
  let lastRafTime = 0;
  const STALL_THRESHOLD_MS = 50; // gaps longer than 3 frames at 60fps = stall
  const NORMAL_FRAME_MS = 16.67; // expected rAF interval at 60Hz

  // Controls state
  let mediaDuration = 0; // from worker stream-init, seconds

  // Seek state
  let isSeeking = false;        // true while user is dragging the scrub bar
  let seekInProgress = false;   // prevents concurrent seeks
  let pendingSeekTime = null;   // queued seek during an in-progress seek
  let seekPendingDraw = false;  // true after seekTo(), cleared after drawing one frame while paused
  let bufferedDurationSec = 0;
  let lastBufferedUpdateTime = 0;

  // Returns current media time in microseconds
  function getCurrentMediaTimeUs() {
    if (paused) return pauseOffsetUs;
    if (hasAudio && audioEl) {
      // Always use audio as the clock when audio is active.
      // Stall video (return -1) until audio actually starts playing,
      // so video and audio are in sync from the very first frame.
      if (audioEl.paused || audioEl.currentTime === 0) return -1;
      return audioEl.currentTime * 1e6;
    }
    // No audio: use wall clock synced to first displayed frame
    if (!wallClockSynced) return -1; // timing not yet established
    const elapsedUs = (performance.now() - wallClockStart) * 1000;
    return videoTimeBase + elapsedUs;
  }

  // Approximate buffered duration from download progress (mp4box is in worker)
  function getBufferedDuration() {
    if (mediaDuration <= 0) return 0;
    if (downloadComplete) return mediaDuration;
    const max = progressEl.max || 1;
    const current = progressEl.value || 0;
    return (current / max) * mediaDuration;
  }

  function getBufferedDurationThrottled() {
    const now = performance.now();
    if (now - lastBufferedUpdateTime < 1000) return bufferedDurationSec;
    lastBufferedUpdateTime = now;
    bufferedDurationSec = getBufferedDuration();
    return bufferedDurationSec;
  }

  async function seekTo(timeSec) {
    if (!mp4boxReady || mediaDuration <= 0) return;

    if (seekInProgress) {
      pendingSeekTime = timeSec;
      return;
    }
    seekInProgress = true;

    // Clamp to buffered range
    const maxSeekable = downloadComplete ? mediaDuration : getBufferedDuration();
    timeSec = Math.max(0, Math.min(timeSec, maxSeekable - 0.1));

    console.log(`[webcodec] seekTo: ${timeSec.toFixed(2)}s (buffered: ${maxSeekable.toFixed(2)}s)`);

    // 1. Tell worker to seek (mp4box.stop/seek/start happens in worker thread)
    seekPendingFlag = true;
    if (demuxWorker) demuxWorker.postMessage({ type: 'seek', timeSec });

    // 2. Flush VideoDecoder — drains in-flight decodes
    if (videoDecoder && videoDecoder.state === 'configured') {
      try {
        await videoDecoder.flush();
      } catch (e) {
        console.warn('[webcodec] decoder flush on seek:', e);
      }
    }

    // 3. Clear pending video samples and frame buffer
    pendingVideoSamples.length = 0;
    while (frameBuffer.length > 0) frameBuffer.shift().close();

    // 4. Reset timing
    const seekTimeUs = timeSec * 1e6;
    pauseOffsetUs = seekTimeUs;
    videoTimeBase = seekTimeUs;
    wallClockStart = performance.now();
    wallClockSynced = true;
    lastRafTime = wallClockStart;

    // 5. Handle audio seek
    if (hasAudio && audioEl) {
      audioAppendQueue.length = 0;

      // Abort any in-progress SourceBuffer operation
      if (audioSourceBuffer && audioSourceBuffer.updating) {
        try { audioSourceBuffer.abort(); } catch (e) {}
        audioSbAppending = false;
      }

      // For raw-mse, set timestampOffset so new data is positioned correctly
      if (audioMode === 'raw-mse' && audioSourceBuffer) {
        try { audioSourceBuffer.timestampOffset = timeSec; } catch (e) {}
      }

      audioEl.currentTime = timeSec;
      if (paused) {
        audioEl.pause();
      } else {
        audioEl.play().catch(() => {});
      }
    }

    // 6. Re-anchor wall clock for non-audio case
    if (!hasAudio && !paused) {
      wallClockStart = performance.now();
      videoTimeBase = seekTimeUs;
    }

    seekPendingDraw = true;
    seekInProgress = false;

    // If another seek was requested during this one, execute it
    if (pendingSeekTime !== null) {
      const t = pendingSeekTime;
      pendingSeekTime = null;
      seekTo(t);
    }
  }

  // --- Video frame rendering ---
  // Key design: frames are CONSUMED (shifted + closed) immediately after drawing.
  // The canvas retains the drawn pixels, so we don't need to hold the VideoFrame.
  // This frees buffer slots so the decoder output callback doesn't evict
  // undisplayed frames.
  function renderLoop() {
    if (aborted) {
      while (frameBuffer.length > 0) frameBuffer.shift().close();
      return;
    }

    // Stall compensation: if the main thread was blocked (WASM slab processing,
    // mp4box parsing), absorb the excess time so the clock doesn't jump forward.
    // This makes the video "pause" during stalls instead of skipping frames.
    const now = performance.now();
    if (lastRafTime > 0) {
      const gapMs = now - lastRafTime;
      if (gapMs > 50) {
        console.warn(`[perf] rAF gap: ${gapMs.toFixed(1)}ms (missed ${Math.floor(gapMs/16.67)} frames) bufLen=${frameBuffer.length} pending=${pendingVideoSamples.length} audioQ=${audioAppendQueue.length} dlComplete=${downloadComplete}`);
      }
    }
    if (lastRafTime > 0 && wallClockSynced && !hasAudio && !paused) {
      const gapMs = now - lastRafTime;
      if (gapMs > STALL_THRESHOLD_MS) {
        const excessMs = gapMs - NORMAL_FRAME_MS;
        wallClockStart += excessMs; // shift clock forward = time "didn't pass"
      }
    }
    lastRafTime = now;

    // Drip-feed queued samples to decoders (backpressure via decodeQueueSize)
    feedSamples();

    if (paused) {
      // After a seek while paused, draw the first available frame as a preview
      if (seekPendingDraw && frameBuffer.length > 0) {
        seekPendingDraw = false;
        let frameToDraw = null;
        while (frameBuffer.length > 0) {
          if (frameToDraw) frameToDraw.close();
          frameToDraw = frameBuffer.shift();
        }
        if (frameToDraw) {
          ctx.drawImage(frameToDraw, 0, 0, canvasEl.width, canvasEl.height);
          frameToDraw.close();
        }
      }
      requestAnimationFrame(renderLoop);
      return;
    }

    // Establish timing on first available frame (not on onReady)
    if (!wallClockSynced && !hasAudio && frameBuffer.length > 0) {
      videoTimeBase = frameBuffer[0].timestamp; // microseconds
      wallClockStart = performance.now();
      wallClockSynced = true;
      lastRafTime = wallClockStart; // reset so first real frame doesn't trigger stall detection
      console.log(`[webcodec] timing synced: videoTimeBase=${videoTimeBase} bufLen=${frameBuffer.length}`);
    }

    const mediaTimeUs = getCurrentMediaTimeUs();
    if (mediaTimeUs < 0) {
      requestAnimationFrame(renderLoop);
      return;
    }

    // Find the latest frame whose time has arrived, consume all older ones
    let frameToDraw = null;
    while (frameBuffer.length > 0 && frameBuffer[0].timestamp <= mediaTimeUs) {
      if (frameToDraw) frameToDraw.close(); // skip intermediate frames
      frameToDraw = frameBuffer.shift();
    }

    if (frameToDraw) {
      // Size canvas to video's native resolution for full quality rendering.
      // CSS object-fit:contain handles display scaling without quality loss.
      if (!canvasSized) {
        canvasEl.width = frameToDraw.displayWidth;
        canvasEl.height = frameToDraw.displayHeight;
        canvasSized = true;
        console.log(`[webcodec] canvas sized to native ${frameToDraw.displayWidth}x${frameToDraw.displayHeight}`);
      }

      ctx.drawImage(frameToDraw, 0, 0, canvasEl.width, canvasEl.height);
      frameToDraw.close();
    }
    // else: no new frame ready — canvas retains the last drawn content

    // Update time display and seek bar
    const mediaTimeSec = mediaTimeUs / 1e6;
    const timeEl = document.getElementById('vc-time');
    if (timeEl) {
      const m = Math.floor(mediaTimeSec / 60);
      const s = Math.floor(mediaTimeSec % 60);
      const pad = s < 10 ? '0' : '';
      if (mediaDuration > 0) {
        const dm = Math.floor(mediaDuration / 60);
        const ds = Math.floor(mediaDuration % 60);
        const dpad = ds < 10 ? '0' : '';
        timeEl.textContent = `${m}:${pad}${s} / ${dm}:${dpad}${ds}`;
      } else {
        timeEl.textContent = `${m}:${pad}${s}`;
      }
    }

    // Update seek bar (unless user is dragging)
    if (!isSeeking && mediaDuration > 0) {
      const playedPct = Math.min(100, (mediaTimeSec / mediaDuration) * 100);
      if (seekPlayedEl) seekPlayedEl.style.width = playedPct + '%';
      if (seekThumbEl) seekThumbEl.style.left = playedPct + '%';

      // Update buffered indicator (throttled to 1Hz)
      const bufDur = getBufferedDurationThrottled();
      const bufPct = Math.min(100, (bufDur / mediaDuration) * 100);
      if (seekBufferedEl) seekBufferedEl.style.width = bufPct + '%';
    }

    requestAnimationFrame(renderLoop);
  }

  let framesReceived = 0;
  function bufferVideoFrame(frame) {
    if (aborted) { frame.close(); return; }
    framesReceived++;
    if (framesReceived <= 5) {
      console.log(`[webcodec] bufferVideoFrame #${framesReceived}: ts=${frame.timestamp} bufLen=${frameBuffer.length}`);
    }
    // No eviction — feed rate is controlled to prevent overflow
    frameBuffer.push(frame);
  }

  // --- Rate-controlled sample feeding ---
  // Feed based on total pipeline depth (decode queue + frame buffer).
  // At most 1 video sample per call to prevent flooding.
  const pendingVideoSamples = [];
  const PIPELINE_MAX = 12; // max total items in decode queue + frame buffer

  let samplesFed = 0;
  function feedSamples() {
    if (!videoDecoder || videoDecoder.state !== 'configured') return;
    // Feed more aggressively when buffer is empty (startup / seeking)
    // Otherwise feed 2 per tick (handles up to 120fps video at 60Hz display)
    const maxFeed = frameBuffer.length === 0 ? 8 : 2;
    let fed = 0;
    while (pendingVideoSamples.length > 0 && fed < maxFeed) {
      const pipelineDepth = videoDecoder.decodeQueueSize + frameBuffer.length;
      if (pipelineDepth >= PIPELINE_MAX) break;
      const s = pendingVideoSamples.shift();
      fed++;
      samplesFed++;
      if (samplesFed <= 10) {
        console.log(`[webcodec] feed #${samplesFed}: cts=${s.cts} sync=${s.is_sync} pipeline=${pipelineDepth} pending=${pendingVideoSamples.length}`);
      }
      try {
        videoDecoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: (s.cts * 1e6) / s.timescale,
          duration: (s.duration * 1e6) / s.timescale,
          data: s.data,
        }));
      } catch (e) {}
    }
    // Audio is handled via MSE (onSegment → SourceBuffer), not WebCodecs
  }

  // --- Audio via MSE: drain fMP4 segments into SourceBuffer ---
  function drainAudioQueue() {
    if (!audioSourceBuffer || audioSbAppending || audioAppendQueue.length === 0) return;
    if (audioMediaSource.readyState !== 'open') return;
    const buf = audioAppendQueue.shift();
    audioSbAppending = true;
    try {
      audioSourceBuffer.appendBuffer(buf);
    } catch (e) {
      audioSbAppending = false;
      if (e.name === 'QuotaExceededError') {
        audioAppendQueue.unshift(buf);
        // Evict old audio data
        if (audioSourceBuffer.buffered.length > 0 && audioEl) {
          const removeEnd = audioEl.currentTime - 5;
          if (removeEnd > audioSourceBuffer.buffered.start(0)) {
            audioSourceBuffer.remove(audioSourceBuffer.buffered.start(0), removeEnd);
          }
        }
      } else {
        console.warn('[webcodec] Audio appendBuffer error:', e);
      }
    }
  }

  function maybeEndAudioStream() {
    if (!downloadComplete || audioAppendQueue.length > 0 || audioSbAppending) return;
    console.log(`[perf] maybeEndAudioStream: calling endOfStream at ${performance.now().toFixed(1)}`);
    if (audioMediaSource && audioMediaSource.readyState === 'open') {
      try { audioMediaSource.endOfStream(); } catch (e) {}
    }
  }

  // --- Handle stream-init from worker: configure VideoDecoder + audio MSE ---
  function handleStreamInit(msg) {
    mp4boxReady = true;

    if (msg.duration && msg.duration > 0) {
      mediaDuration = msg.duration;
    }

    const trackDescs = [];
    if (msg.videoConfig) trackDescs.push(`video (${msg.videoConfig.codec})`);
    if (msg.audioConfig) trackDescs.push(`audio (${msg.audioConfig.mime})`);
    statusEl.textContent = `Tracks: ${trackDescs.join(', ')}. Configuring decoders...`;

    // --- Audio setup (via MSE) ---
    if (msg.audioConfig && audioMediaSource && audioMediaSource.readyState === 'open') {
      try {
        audioMode = msg.audioConfig.mode;
        audioSourceBuffer = audioMediaSource.addSourceBuffer(msg.audioConfig.mime);
        audioSourceBuffer.addEventListener('updateend', () => {
          audioSbAppending = false;
          drainAudioQueue();
          maybeEndAudioStream();
        });
        audioSourceBuffer.addEventListener('error', (e) => {
          console.warn('[webcodec] Audio SourceBuffer error:', e);
        });
        hasAudio = true;

        if (msg.audioConfig.initSegment) {
          audioAppendQueue.push(msg.audioConfig.initSegment);
          drainAudioQueue();
        }

        audioEl.play().catch(() => {});
        console.log(`[webcodec] Audio MSE ready: ${msg.audioConfig.mime} (${msg.audioConfig.mode})`);
      } catch (e) {
        console.warn('[webcodec] Audio setup failed:', e);
        hasAudio = false;
      }
    }

    // --- Video decoder setup ---
    if (msg.videoConfig) {
      const config = {
        codec: msg.videoConfig.codec,
        codedWidth: msg.videoConfig.codedWidth,
        codedHeight: msg.videoConfig.codedHeight,
      };
      if (msg.videoConfig.description) {
        config.description = new Uint8Array(msg.videoConfig.description);
      }

      videoDecoder = new VideoDecoder({
        output: bufferVideoFrame,
        error: (e) => {
          console.error('[webcodec] VideoDecoder error:', e);
          if (!aborted) {
            aborted = true;
            rejectAbort(new Error(`Video decoder error: ${e.message}`));
          }
        }
      });
      videoDecoder.configure(config);

      console.log(`[webcodec] VideoDecoder configured: ${msg.videoConfig.codec} ${msg.videoConfig.codedWidth}x${msg.videoConfig.codedHeight}`);
    }

    if (!videoDecoder) {
      rejectAbort(new Error('No supported video codec found'));
      return;
    }

    // Start render loop
    renderLoopRunning = true;
    requestAnimationFrame(renderLoop);

    statusEl.textContent = `Streaming: ${trackDescs.join(', ')}`;
  }

  // --- Controls wiring (set up before download starts so controls work during streaming) ---
  const container = document.getElementById('video-container');
  const controlsEl = document.getElementById('video-controls');
  const playBtn = document.getElementById('vc-playpause');
  const volSlider = document.getElementById('vc-volume');
  const fsBtn = document.getElementById('vc-fullscreen');
  const seekbarEl = document.getElementById('vc-seekbar');
  const seekPlayedEl = document.getElementById('vc-seek-played');
  const seekBufferedEl = document.getElementById('vc-seek-buffered');
  const seekThumbEl = document.getElementById('vc-seek-thumb');

  let hideTimeout;
  function showControls() {
    controlsEl.style.opacity = '1';
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => { controlsEl.style.opacity = '0'; }, 3000);
  }
  container.addEventListener('mousemove', showControls);
  container.addEventListener('mouseenter', showControls);
  showControls();

  function togglePause() {
    if (paused) {
      // Resume: adjust wall clock so timing picks up from where we paused
      paused = false;
      if (wallClockSynced && !hasAudio) {
        wallClockStart = performance.now() - ((pauseOffsetUs - videoTimeBase) / 1000);
      }
      if (audioEl && audioEl.paused) audioEl.play().catch(() => {});
      playBtn.innerHTML = '&#9646;&#9646;';
    } else {
      // Pause: snapshot current media time
      paused = true;
      pauseOffsetUs = getCurrentMediaTimeUs();
      if (audioEl && !audioEl.paused) audioEl.pause();
      playBtn.innerHTML = '&#9654;';
    }
  }
  canvasEl.addEventListener('click', togglePause);
  playBtn.addEventListener('click', togglePause);
  playBtn.innerHTML = '&#9646;&#9646;';

  volSlider.addEventListener('input', () => {
    if (audioEl) audioEl.volume = parseFloat(volSlider.value);
  });

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {});
    }
  });

  // --- Seek bar interaction ---
  let seekbarDragging = false;

  function seekbarPctFromEvent(e) {
    const rect = seekbarEl.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }

  function seekbarUpdateTimeDisplay(timeSec) {
    const timeEl = document.getElementById('vc-time');
    if (!timeEl || mediaDuration <= 0) return;
    const m = Math.floor(timeSec / 60);
    const s = Math.floor(timeSec % 60);
    const pad = s < 10 ? '0' : '';
    const dm = Math.floor(mediaDuration / 60);
    const ds = Math.floor(mediaDuration % 60);
    const dpad = ds < 10 ? '0' : '';
    timeEl.textContent = `${m}:${pad}${s} / ${dm}:${dpad}${ds}`;
  }

  function seekbarClampPct(pct) {
    if (!downloadComplete && mediaDuration > 0) {
      const maxPct = Math.min(1, getBufferedDuration() / mediaDuration);
      return Math.min(pct, maxPct);
    }
    return pct;
  }

  function seekbarStartDrag(e) {
    if (mediaDuration <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    seekbarDragging = true;
    isSeeking = true;
    seekThumbEl.style.opacity = '1';

    let pct = seekbarPctFromEvent(e);
    pct = seekbarClampPct(pct);
    seekPlayedEl.style.width = (pct * 100) + '%';
    seekThumbEl.style.left = (pct * 100) + '%';
    seekbarUpdateTimeDisplay(pct * mediaDuration);
  }

  function seekbarMoveDrag(e) {
    if (!seekbarDragging) return;
    e.preventDefault();
    let pct = seekbarPctFromEvent(e);
    pct = seekbarClampPct(pct);
    seekPlayedEl.style.width = (pct * 100) + '%';
    seekThumbEl.style.left = (pct * 100) + '%';
    seekbarUpdateTimeDisplay(pct * mediaDuration);
  }

  function seekbarEndDrag(e) {
    if (!seekbarDragging) return;
    seekbarDragging = false;
    isSeeking = false;

    // Calculate final position from last visual state
    const pctStr = seekPlayedEl.style.width;
    const pct = parseFloat(pctStr) / 100;
    seekTo(pct * mediaDuration);
  }

  seekbarEl.addEventListener('mousedown', seekbarStartDrag);
  document.addEventListener('mousemove', seekbarMoveDrag);
  document.addEventListener('mouseup', seekbarEndDrag);

  seekbarEl.addEventListener('touchstart', seekbarStartDrag, { passive: false });
  document.addEventListener('touchmove', seekbarMoveDrag, { passive: false });
  document.addEventListener('touchend', seekbarEndDrag);

  // Single click to seek (without drag)
  seekbarEl.addEventListener('click', (e) => {
    if (mediaDuration <= 0) return;
    e.stopPropagation();
    let pct = seekbarPctFromEvent(e);
    pct = seekbarClampPct(pct);
    seekTo(pct * mediaDuration);
  });

  // --- Set up hidden <audio> element with MSE for audio playback ---
  // The browser's native audio decoder (via MSE) handles multichannel AAC, Opus, etc.
  // that WebCodecs AudioDecoder cannot decode.
  if (window.MediaSource) {
    audioEl = document.createElement('audio');
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    audioMediaSource = new MediaSource();
    audioEl.src = URL.createObjectURL(audioMediaSource);

    // Wait for sourceopen before starting download (must be ready before onReady fires)
    await new Promise((resolve) => {
      if (audioMediaSource.readyState === 'open') resolve();
      else audioMediaSource.addEventListener('sourceopen', resolve, { once: true });
    });
    console.log('[webcodec] Audio MediaSource ready');
  }

  // --- Stream data from SDK via Web Worker (demuxing in worker) ---
  // mp4box.appendBuffer() runs in the worker thread, so the main thread
  // is never blocked by MP4 parsing at slab boundaries.
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
        if (aborted || seekPendingFlag) return;
        for (const s of msg.samples) pendingVideoSamples.push(s);
        const _dt = performance.now() - _msgT0;
        if (_dt > 5) console.warn(`[perf] stream-video handler: ${_dt.toFixed(1)}ms (${msg.samples.length} samples, pendingTotal=${pendingVideoSamples.length})`);
      } else if (msg.type === 'stream-audio') {
        if (aborted || seekPendingFlag) return;
        audioAppendQueue.push(msg.buffer);
        drainAudioQueue();
        const _dt = performance.now() - _msgT0;
        if (_dt > 5) console.warn(`[perf] stream-audio handler: ${_dt.toFixed(1)}ms (queueLen=${audioAppendQueue.length})`);
      } else if (msg.type === 'stream-progress') {
        if (aborted) return;
        progressEl.max = msg.total;
        progressEl.value = msg.current;
        byteOffset = msg.byteOffset;
        const pct = msg.total > 0 ? ((msg.current / msg.total) * 100).toFixed(0) : 0;
        statusEl.textContent = `Streaming: ${msg.current}/${msg.total} slabs (${pct}%) — ${formatSize(msg.byteOffset)} / ${formatSize(msg.totalSize)}`;
        if (msg.current === msg.total) console.log(`[perf] last progress message received at ${_msgT0.toFixed(1)}`);
      } else if (msg.type === 'stream-seek-flushed') {
        // Clear any stale samples that arrived between seek request and worker flush
        pendingVideoSamples.length = 0;
        while (frameBuffer.length > 0) frameBuffer.shift().close();
        seekPendingFlag = false;
      } else if (msg.type === 'stream-complete') {
        console.log(`[perf] stream-complete received at ${performance.now().toFixed(1)}`);
        // Defer resolution by one frame so the render loop can process
        // the burst of samples from mp4box.flush() before the completion
        // continuation (DOM updates, localStorage, etc.) blocks the thread.
        requestAnimationFrame(() => {
          console.log(`[perf] stream-complete resolving at ${performance.now().toFixed(1)}`);
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

  // Start the download + demux worker
  worker.postMessage({
    type: 'stream-demux',
    indexerUrl: getUrl(),
    keyHex: getKeyHex(),
    maxDownloads: getMaxDownloads(),
    objectUrl: objectUrl,
    logLevel: getLogLevel(),
  });

  try {
    await Promise.race([streamPromise, abortPromise]);
  } catch (e) {
    aborted = true;
    worker.terminate();
    throw e;
  }
  // Do NOT terminate worker here — it's still needed for post-download seeking.
  // Worker is terminated by the abort handler when the stream is cleaned up.

  if (!aborted) {
    const _completionT0 = performance.now();
    console.log(`[perf] completion continuation starting at ${_completionT0.toFixed(1)}`);
    downloadComplete = true;
    progressEl.value = progressEl.max;

    // Don't flush the VideoDecoder here — flushing forces all queued chunks
    // through immediately and puts the decoder in "key frame required" state,
    // which causes a visible stutter. Instead, let the normal feedSamples() →
    // renderLoop() pipeline drain remaining samples smoothly.
    // Audio MSE will be ended by maybeEndAudioStream() once its queue drains
    // naturally via the drainAudioQueue() callback chain.

    const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(1);
    statusEl.textContent = `Stream complete! ${formatSize(totalSize)} in ${elapsed}s.`;
    console.log(`[perf] completion continuation done in ${(performance.now() - _completionT0).toFixed(1)}ms`);
  }

  return {
    abort: () => {
      aborted = true;
      worker.terminate();
      if (videoDecoder) try { videoDecoder.close(); } catch (e) {}
      if (audioEl) {
        try { audioEl.pause(); } catch (e) {}
        try { audioEl.remove(); } catch (e) {}
      }
      if (audioMediaSource && audioMediaSource.readyState === 'open') {
        try { audioMediaSource.endOfStream(); } catch (e) {}
      }
      while (frameBuffer.length > 0) frameBuffer.shift().close();
      clearTimeout(hideTimeout);
      resolveAbort();
    }
  };
}

// --- MSE streaming pipeline (legacy fallback for browsers without WebCodecs) ---

export async function transmuxAndStream(sdk, obj, videoEl, statusEl, progressEl, helpers) {
  const { formatSize, getMaxDownloads, DownloadOptions, createMP4Box } = helpers;

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

  // mp4box v2 returns a single init segment for all tracks.
  // Use one combined SourceBuffer with all codecs.
  let sourceBuffer = null;
  const appendQueue = [];
  let sbAppending = false;

  mp4box.onReady = (info) => {
    mp4boxReady = true;
    console.log('[stream] onReady fired. All tracks:', info.tracks.map(t => ({
      id: t.id, codec: t.codec, video: !!t.video, audio: !!t.audio,
      type: t.type, name: t.name
    })));

    // Filter to only video and audio tracks (skip timecode, metadata, etc.)
    const mediaTracks = info.tracks.filter(t => t.video || t.audio);
    console.log('[stream] Media tracks:', mediaTracks.map(t => ({
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

    // Build combined codec string from media tracks only
    const codecs = mediaTracks.map(t => t.codec).join(', ');
    const mime = `video/mp4; codecs="${codecs}"`;
    console.log(`[stream] Combined MIME: ${mime}`);

    if (!MediaSource.isTypeSupported(mime)) {
      console.error(`[stream] MIME not supported: ${mime}`);
      rejectAbort(new Error(`Codec not supported by browser: ${mime}`));
      return;
    }

    sourceBuffer = mediaSource.addSourceBuffer(mime);
    sourceBuffer.addEventListener('updateend', () => {
      sbAppending = false;
      // After any operation completes, try to drain queued data
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

    // Periodically evict old buffer data as video plays
    videoEl.addEventListener('timeupdate', () => {
      if (needsEviction && !sbAppending && sourceBuffer && !sourceBuffer.updating) {
        tryEvict();
      }
    });

    // Set segment options only for media tracks
    for (const track of mediaTracks) {
      mp4box.setSegmentOptions(track.id, null, { nbSamples: 100, rapAlignment: true });
    }

    // Get single combined init segment (mp4box v2 API)
    const initResult = mp4box.initializeSegmentation();
    console.log('[stream] Init segment:', {
      tracks: initResult.tracks,
      bufferSize: initResult.buffer?.byteLength
    });

    if (initResult.buffer) {
      appendQueue.push(initResult.buffer);
      drainAppendQueue();
    }

    mp4box.start();
    videoEl.play().catch(e => console.log('[stream] autoplay blocked:', e.message));
  };

  let needsEviction = false;

  function tryEvict() {
    if (aborted || !sourceBuffer || sourceBuffer.updating || sbAppending) return;
    if (mediaSource.readyState !== 'open') return;
    if (!sourceBuffer.buffered || sourceBuffer.buffered.length === 0) {
      // No buffered data yet, just retry the append
      needsEviction = false;
      drainAppendQueue();
      return;
    }

    const currentTime = videoEl.currentTime;
    const bufferedStart = sourceBuffer.buffered.start(0);
    const keepBehind = 5; // keep 5 seconds behind playhead

    if (currentTime - bufferedStart > keepBehind) {
      const removeEnd = currentTime - keepBehind;
      console.log(`[stream] Evicting buffer: ${bufferedStart.toFixed(1)}s → ${removeEnd.toFixed(1)}s (playhead at ${currentTime.toFixed(1)}s)`);
      sbAppending = true;
      sourceBuffer.remove(bufferedStart, removeEnd);
      needsEviction = false;
      // updateend will fire → sbAppending=false → drainAppendQueue resumes
    } else {
      // Playhead hasn't advanced enough to evict. Wait for timeupdate.
      // Don't spam retries — the timeupdate listener will trigger us.
    }
  }

  function drainAppendQueue() {
    if (aborted) return;
    if (!sourceBuffer || sbAppending || appendQueue.length === 0) {
      maybeEndOfStream();
      return;
    }
    // Guard against SourceBuffer removed from MediaSource
    if (mediaSource.readyState !== 'open') return;
    // Proactively evict if we have a lot buffered ahead
    if (sourceBuffer.buffered && sourceBuffer.buffered.length > 0) {
      const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      const bufferedStart = sourceBuffer.buffered.start(0);
      const currentTime = videoEl.currentTime;
      // If buffer exceeds 60 seconds ahead of playhead, evict old data first
      if (bufferedEnd - currentTime > 60 && currentTime - bufferedStart > 5) {
        console.log(`[stream] Proactive eviction: ${(bufferedEnd - currentTime).toFixed(0)}s buffered ahead`);
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
          console.warn('[stream] QuotaExceededError, waiting for playback to advance...');
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
      console.log(`[stream] onSegment #${segmentCount}: track=${trackId} size=${buffer.byteLength}`);
    }
    appendQueue.push(buffer);
    if (!needsEviction) {
      drainAppendQueue();
    }
    // If needsEviction, don't try to drain — wait for eviction to complete
  };

  mp4box.onError = (e) => {
    console.error('[stream] mp4box error:', e);
  };

  // Stream data
  progressEl.style.display = 'block';
  const downloadStart = performance.now();

  let chunkCount = 0;
  const dlOpts2 = new DownloadOptions();
  dlOpts2.maxInflight = getMaxDownloads();
  const streamPromise = sdk.downloadStreaming(obj, dlOpts2,
    (chunk) => {
      if (aborted) return;
      chunkCount++;
      const buf = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength
      );
      buf.fileStart = byteOffset;
      if (chunkCount <= 3) {
        console.log(`[stream] chunk #${chunkCount}: size=${chunk.byteLength} fileStart=${byteOffset}`);
      }
      byteOffset += chunk.byteLength;
      mp4box.appendBuffer(buf);
    },
    (current, total) => {
      if (aborted) return;
      progressEl.max = total;
      progressEl.value = current;
      const pct = total > 0 ? ((current / total) * 100).toFixed(0) : 0;
      statusEl.textContent = `Streaming: ${current}/${total} slabs (${pct}%) — ${formatSize(byteOffset)} / ${formatSize(totalSize)}`;

      // Detect moov-at-end or non-MP4: if enough data delivered and mp4box still hasn't parsed moov.
      // We check byteOffset (bytes actually fed to mp4box) rather than slab count because
      // the progress callback can fire before all chunk data from a slab is flushed.
      if (byteOffset > 50 * 1024 * 1024 && !mp4boxReady) {
        aborted = true;
        rejectAbort(new Error(
          'No moov atom found after 50 MB. The file may have moov at the end (common with GoPro/camera recordings). ' +
          'Re-encode with "ffmpeg -i input.mp4 -movflags +faststart output.mp4" to fix, or use the Download section.'
        ));
      }
    },
  );

  try {
    await Promise.race([streamPromise, abortPromise]);
  } catch (e) {
    // Silence callbacks from the still-running WASM download before
    // propagating the error — prevents it from clobbering the status
    // element if the caller starts a fallback download.
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
