// Shared video pipeline core — rendering, timing, audio MSE, and decode feeding.
//
// Used by both video-streaming.js (ES module, main page) and sia-injected.js
// (classic script, sandboxed iframe). Works in both contexts via an IIFE that
// attaches to self.VideoPipelineCore.
//
// All functions operate on a "state" object (s) with a standard set of fields.
// Consumers create the state object and call these functions.

(function(exports) {
  'use strict';

  // --- Constants ---
  var PIPELINE_MAX = 12;       // max items in decode queue + frame buffer
  var STALL_THRESHOLD_MS = 50; // rAF gaps longer than this = stall
  var NORMAL_FRAME_MS = 16.67; // expected rAF interval at 60Hz

  // --- Time formatting ---
  function formatTime(sec) {
    if (!sec || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // --- Media time calculation ---
  // Returns current media time in microseconds, or -1 if timing not yet established.
  function getMediaTimeUs(s) {
    if (s.paused) return s.pauseOffsetUs;
    if (s.hasAudio && s.audioEl) {
      // Use audio as master clock when available and playing
      if (s.audioEl.paused || s.audioEl.readyState < 3) {
        // Audio not ready — fall through to wall-clock
      } else {
        var t = s.audioEl.currentTime * 1e6;
        // Re-sync wall-clock baseline so fallback picks up seamlessly if audio stalls
        s.videoTimeBase = t;
        s.wallClockStart = performance.now();
        s.wallClockSynced = true;
        return t;
      }
    }
    // No audio or audio not ready: use wall-clock synced to first displayed frame
    if (!s.wallClockSynced) return -1;
    return s.videoTimeBase + (performance.now() - s.wallClockStart) * 1000;
  }

  // --- Toggle pause/resume ---
  function togglePause(s) {
    if (s.paused) {
      // Resume: adjust wall clock so timing picks up from where we paused
      s.paused = false;
      if (s.wallClockSynced && !s.hasAudio) {
        s.wallClockStart = performance.now() - ((s.pauseOffsetUs - s.videoTimeBase) / 1000);
      }
      if (s.audioEl && s.audioEl.paused) s.audioEl.play().catch(function(){});
      if (s.playBtn) s.playBtn.innerHTML = '&#9646;&#9646;';
    } else {
      // Pause: snapshot current media time BEFORE setting paused flag
      var t = getMediaTimeUs(s);
      s.paused = true;
      s.pauseOffsetUs = t >= 0 ? t : 0;
      if (s.audioEl && !s.audioEl.paused) s.audioEl.pause();
      if (s.playBtn) s.playBtn.innerHTML = '&#9654;';
    }
  }

  // --- Rate-controlled sample feeding ---
  // Drip-feeds queued samples to the VideoDecoder, respecting backpressure
  // via total pipeline depth (decode queue + frame buffer).
  function feedSamples(s) {
    if (!s.decoder || s.decoder.state !== 'configured') return;
    // After decoder reset, skip delta frames until a keyframe arrives
    if (s._needsKeyframe) {
      while (s.pendingSamples.length > 0 && !s.pendingSamples[0].is_sync) {
        s.pendingSamples.shift();
      }
      if (s.pendingSamples.length > 0 && s.pendingSamples[0].is_sync) {
        s._needsKeyframe = false;
      } else {
        return; // still waiting for keyframe
      }
    }
    // Feed more aggressively when buffer is empty (startup / seeking)
    var maxFeed = s.frameBuffer.length === 0 ? 8 : 2;
    var fed = 0;
    while (s.pendingSamples.length > 0 && fed < maxFeed) {
      var pipelineDepth = s.decoder.decodeQueueSize + s.frameBuffer.length;
      if (pipelineDepth >= PIPELINE_MAX) break;
      var sample = s.pendingSamples.shift();
      fed++;
      try {
        s.decoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1e6) / sample.timescale,
          duration: (sample.duration * 1e6) / sample.timescale,
          data: sample.data,
        }));
      } catch (e) {
        // Decode errors are reported via the decoder's error callback
      }
    }
  }

  // --- Audio MSE: drain fMP4/raw segments into SourceBuffer ---
  function drainAudioQueue(s) {
    if (!s.audioSourceBuffer || s.audioSbAppending || s.audioAppendQueue.length === 0) return;
    if (s.audioMediaSource.readyState !== 'open') return;
    var buf = s.audioAppendQueue.shift();
    s.audioSbAppending = true;
    try {
      s.audioSourceBuffer.appendBuffer(buf);
    } catch (e) {
      s.audioSbAppending = false;
      if (e.name === 'QuotaExceededError') {
        s.audioAppendQueue.unshift(buf);
        // Evict old audio data
        if (s.audioSourceBuffer.buffered.length > 0 && s.audioEl) {
          var removeEnd = s.audioEl.currentTime - 5;
          if (removeEnd > s.audioSourceBuffer.buffered.start(0)) {
            s.audioSourceBuffer.remove(s.audioSourceBuffer.buffered.start(0), removeEnd);
          }
        }
      }
    }
  }

  // --- End audio stream when download is complete and queue is drained ---
  function maybeEndAudio(s) {
    if (!s.downloadComplete || s.audioAppendQueue.length > 0 || s.audioSbAppending) return;
    if (s.audioMediaSource && s.audioMediaSource.readyState === 'open') {
      try { s.audioMediaSource.endOfStream(); } catch (e) {}
    }
  }

  // --- Stall compensation ---
  // When the main thread is blocked (WASM slab processing, mp4box parsing),
  // rAF stops firing. When it resumes, the wall clock has jumped forward.
  // We absorb the excess time so the video "pauses" during the stall instead
  // of skipping frames.
  function applyStallCompensation(s) {
    var now = performance.now();
    var usingAudioClock = s.hasAudio && s.audioEl && !s.audioEl.paused &&
      s.audioEl.readyState >= 3;
    if (s.lastRafTime > 0 && s.wallClockSynced && !usingAudioClock && !s.paused) {
      var gapMs = now - s.lastRafTime;
      if (gapMs > STALL_THRESHOLD_MS) {
        s.wallClockStart += (gapMs - NORMAL_FRAME_MS);
      }
    }
    s.lastRafTime = now;
  }

  // --- Establish timing on first available frame (when no audio) ---
  function syncTimingIfNeeded(s) {
    if (!s.wallClockSynced && !s.hasAudio && s.frameBuffer.length > 0) {
      s.videoTimeBase = s.frameBuffer[0].timestamp;
      s.wallClockStart = performance.now();
      s.wallClockSynced = true;
      s.lastRafTime = s.wallClockStart;
    }
  }

  // --- Draw the latest frame whose presentation time has arrived ---
  // Returns true if a frame was drawn.
  function presentFrame(s) {
    var mediaTimeUs = getMediaTimeUs(s);
    if (mediaTimeUs < 0) return false;

    var frameToDraw = null;
    while (s.frameBuffer.length > 0 && s.frameBuffer[0].timestamp <= mediaTimeUs) {
      if (frameToDraw) frameToDraw.close(); // skip intermediate frames
      frameToDraw = s.frameBuffer.shift();
    }

    if (frameToDraw) {
      if (!s.canvasSized) {
        s.canvas.width = frameToDraw.displayWidth;
        s.canvas.height = frameToDraw.displayHeight;
        s.canvasSized = true;
      }
      s.ctx.drawImage(frameToDraw, 0, 0, s.canvas.width, s.canvas.height);
      frameToDraw.close();
      return true;
    }
    return false;
  }

  // --- Draw seek preview while paused ---
  // After a seek while paused, draw the first available frame as a static preview.
  function drawSeekPreview(s) {
    if (!s.seekPendingDraw || s.frameBuffer.length === 0) return;
    s.seekPendingDraw = false;
    var frameToDraw = null;
    while (s.frameBuffer.length > 0) {
      if (frameToDraw) frameToDraw.close();
      frameToDraw = s.frameBuffer.shift();
    }
    if (frameToDraw) {
      if (!s.canvasSized) {
        s.canvas.width = frameToDraw.displayWidth;
        s.canvas.height = frameToDraw.displayHeight;
        s.canvasSized = true;
      }
      s.ctx.drawImage(frameToDraw, 0, 0, s.canvas.width, s.canvas.height);
      frameToDraw.close();
    }
  }

  // --- Update time display and seekbar position ---
  function updateTimeUI(s) {
    var mediaTimeUs = getMediaTimeUs(s);
    if (mediaTimeUs < 0) return;
    var mediaTimeSec = mediaTimeUs / 1e6;

    if (s.timeSpan) {
      if (s.mediaDuration > 0) {
        s.timeSpan.textContent = formatTime(mediaTimeSec) + ' / ' + formatTime(s.mediaDuration);
      } else {
        s.timeSpan.textContent = formatTime(mediaTimeSec);
      }
    }

    if (s.mediaDuration > 0 && !s.seeking) {
      var playedPct = Math.min(100, (mediaTimeSec / s.mediaDuration) * 100);
      if (s.seekPlayed) s.seekPlayed.style.width = playedPct + '%';
      if (s.seekThumb) s.seekThumb.style.left = playedPct + '%';
    }
  }

  // --- Core render loop tick ---
  // Performs one frame of the render loop. Returns true if the loop should continue.
  // Callers are responsible for scheduling the next tick via requestAnimationFrame.
  function renderTick(s) {
    if (s.aborted) {
      while (s.frameBuffer.length > 0) s.frameBuffer.shift().close();
      return false; // stop the loop
    }

    applyStallCompensation(s);
    feedSamples(s);

    if (s.paused) {
      drawSeekPreview(s);
      updateTimeUI(s);
      return true; // keep looping (need to process samples and show seek previews)
    }

    syncTimingIfNeeded(s);
    presentFrame(s);
    updateTimeUI(s);
    return true; // keep looping
  }

  // --- Reset timing state for a seek ---
  function resetTimingForSeek(s, seekTimeUs) {
    s.pauseOffsetUs = seekTimeUs;
    s.videoTimeBase = seekTimeUs;
    s.wallClockStart = performance.now();
    s.wallClockSynced = true;
    s.lastRafTime = s.wallClockStart;
  }

  // --- Flush buffers (after seek) ---
  function flushBuffers(s) {
    s.pendingSamples.length = 0;
    while (s.frameBuffer.length > 0) s.frameBuffer.shift().close();
  }

  // --- Create a new state object with default values ---
  function createState() {
    return {
      // Video decoder
      decoder: null,
      decoderConfig: null,
      frameBuffer: [],
      pendingSamples: [],
      _needsKeyframe: false,

      // Canvas
      canvas: null,
      ctx: null,
      canvasSized: false,

      // Timing
      paused: false,
      pauseOffsetUs: 0,
      wallClockStart: 0,
      videoTimeBase: -1,
      wallClockSynced: false,
      lastRafTime: 0,

      // Audio
      hasAudio: false,
      audioEl: null,
      audioMediaSource: null,
      audioSourceBuffer: null,
      audioAppendQueue: [],
      audioSbAppending: false,
      audioMode: null,
      audioInitSegment: null,

      // Progress
      downloadComplete: false,
      mediaDuration: 0,

      // State flags
      aborted: false,
      renderRunning: false,
      seeking: false,
      seekPendingDraw: false,

      // UI elements (optional, may be null)
      playBtn: null,
      timeSpan: null,
      seekPlayed: null,
      seekBuffered: null,
      seekThumb: null,
    };
  }

  // --- Abort / cleanup ---
  function abort(s) {
    s.aborted = true;
    if (s.decoder) try { s.decoder.close(); } catch (e) {}
    if (s.audioEl) {
      try { s.audioEl.pause(); } catch (e) {}
      try { s.audioEl.remove(); } catch (e) {}
    }
    if (s.audioMediaSource && s.audioMediaSource.readyState === 'open') {
      try { s.audioMediaSource.endOfStream(); } catch (e) {}
    }
    while (s.frameBuffer.length > 0) s.frameBuffer.shift().close();
  }

  // --- Configure VideoDecoder from stream-init config ---
  function configureDecoder(s, videoConfig, onFrame, onError) {
    var config = {
      codec: videoConfig.codec,
      codedWidth: videoConfig.codedWidth,
      codedHeight: videoConfig.codedHeight,
    };
    if (videoConfig.description) {
      config.description = new Uint8Array(videoConfig.description);
    }

    s.decoder = new VideoDecoder({
      output: onFrame || function(frame) {
        if (s.aborted) { frame.close(); return; }
        s.frameBuffer.push(frame);
      },
      error: onError || function(e) {
        console.error('VideoDecoder error:', e);
      },
    });
    s.decoderConfig = config;
    s.decoder.configure(config);
    return config;
  }

  // --- Set up audio via MSE ---
  // Returns a promise that resolves when sourceopen fires (or immediately if no audio).
  // Caller should provide audioConfig from stream-init message.
  function setupAudioMSE(s, audioConfig) {
    if (!audioConfig || typeof MediaSource === 'undefined') {
      return Promise.resolve(false);
    }

    var audioEl = document.createElement('audio');
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    var ms = new MediaSource();
    audioEl.src = URL.createObjectURL(ms);
    s.audioEl = audioEl;
    s.audioMediaSource = ms;
    s.audioMode = audioConfig.mode || null;

    return new Promise(function(resolve) {
      ms.addEventListener('sourceopen', function() {
        try {
          s.audioSourceBuffer = ms.addSourceBuffer(audioConfig.mime);
          s.audioSourceBuffer.addEventListener('updateend', function() {
            s.audioSbAppending = false;
            drainAudioQueue(s);
            maybeEndAudio(s);
          });
          s.audioSourceBuffer.addEventListener('error', function(e) {
            console.warn('Audio SourceBuffer error:', e);
          });
          s.hasAudio = true;

          if (audioConfig.initSegment) {
            s.audioInitSegment = audioConfig.initSegment.slice
              ? audioConfig.initSegment.slice(0) : audioConfig.initSegment;
            s.audioAppendQueue.push(audioConfig.initSegment);
            drainAudioQueue(s);
          }

          audioEl.play().catch(function(){});
          resolve(true);
        } catch (e) {
          console.warn('Audio setup failed:', e);
          s.hasAudio = false;
          resolve(false);
        }
      }, { once: true });
    });
  }

  // --- Handle seek on audio side ---
  function seekAudio(s, timeSec) {
    s.audioAppendQueue.length = 0;
    if (s.audioSourceBuffer) {
      if (s.audioSourceBuffer.updating) {
        try { s.audioSourceBuffer.abort(); } catch (e) {}
      }
      s.audioSbAppending = false;
      if (s.audioMode === 'raw-mse') {
        try { s.audioSourceBuffer.timestampOffset = timeSec; } catch (e) {}
      }
      if (s.audioMode === 'fmp4-mse' && s.audioInitSegment) {
        s.audioAppendQueue.push(s.audioInitSegment.slice
          ? s.audioInitSegment.slice(0) : s.audioInitSegment);
      }
      try { s.audioSourceBuffer.remove(0, Infinity); } catch (e) {}
    }
    if (s.audioEl) {
      s.audioEl.currentTime = timeSec;
      if (s.paused) {
        s.audioEl.pause();
      } else {
        s.audioEl.play().catch(function(){});
      }
    }
  }

  // --- Export ---
  exports.PIPELINE_MAX = PIPELINE_MAX;
  exports.STALL_THRESHOLD_MS = STALL_THRESHOLD_MS;
  exports.NORMAL_FRAME_MS = NORMAL_FRAME_MS;

  exports.formatTime = formatTime;
  exports.getMediaTimeUs = getMediaTimeUs;
  exports.togglePause = togglePause;
  exports.feedSamples = feedSamples;
  exports.drainAudioQueue = drainAudioQueue;
  exports.maybeEndAudio = maybeEndAudio;
  exports.applyStallCompensation = applyStallCompensation;
  exports.syncTimingIfNeeded = syncTimingIfNeeded;
  exports.presentFrame = presentFrame;
  exports.drawSeekPreview = drawSeekPreview;
  exports.updateTimeUI = updateTimeUI;
  exports.renderTick = renderTick;
  exports.resetTimingForSeek = resetTimingForSeek;
  exports.flushBuffers = flushBuffers;
  exports.createState = createState;
  exports.abort = abort;
  exports.configureDecoder = configureDecoder;
  exports.setupAudioMSE = setupAudioMSE;
  exports.seekAudio = seekAudio;

})(typeof self !== 'undefined'
  ? (self.VideoPipelineCore = self.VideoPipelineCore || {})
  : (this.VideoPipelineCore = this.VideoPipelineCore || {}));
