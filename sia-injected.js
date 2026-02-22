// This script is injected into every sandboxed iframe that renders sia:// content.
// It bridges the iframe back to the parent browser chrome via postMessage, handling:
//   - Link interception: rewrites sia:// link clicks into SIA_NAVIGATE messages
//   - Resource loading: intercepts sia:// images/css/subresources, requests them from
//     the parent via SIA_RESOURCE messages, and swaps in blob URLs when they arrive
//   - Video streaming: implements a full WebCodecs + MSE playback pipeline that receives
//     MP4 samples from the parent's Web Worker, decodes video frames to canvas, and
//     feeds audio through MediaSource — including seek support and buffered-range UI
//   - Dynamic content observation: MutationObserver watches for lazily-added sia://
//     references and rewrites them on the fly
(function() {
  // --- 1. Link navigation ---
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (href && href.indexOf('sia://') === 0) {
      e.preventDefault();
      window.parent.postMessage({ type: 'SIA_NAVIGATE', url: href }, '*');
    }
  });

  // --- 2. Embedded resource loading (images, CSS, etc.) ---
  var _reqId = 0;
  var _pending = {};

  function requestResource(el, attr) {
    var url = el.getAttribute(attr);
    if (!url || url.indexOf('sia://') !== 0) return;
    var id = 'r' + (++_reqId);
    _pending[id] = { el: el, attr: attr };
    if (el.tagName === 'IMG') {
      el.setAttribute('data-sia-loading', '1');
      if (!el.style.minHeight) el.style.minHeight = '40px';
      el.style.opacity = '0.3';
    }
    window.parent.postMessage({ type: 'SIA_RESOURCE', url: url, requestId: id }, '*');
  }

  // --- 3. Video streaming via WebCodecs ---
  var _streamSessions = {};
  var _streamIdCounter = 0;

  function formatTime(sec) {
    if (!sec || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function drawPlayButton(canvas) {
    var ctx0 = canvas.getContext('2d');
    ctx0.fillStyle = '#000';
    ctx0.fillRect(0, 0, canvas.width, canvas.height);
    ctx0.fillStyle = 'rgba(255,255,255,0.7)';
    ctx0.beginPath();
    var cx = canvas.width / 2;
    var cy = canvas.height / 2;
    var sz = Math.min(canvas.width, canvas.height) * 0.15;
    ctx0.moveTo(cx - sz * 0.5, cy - sz);
    ctx0.lineTo(cx - sz * 0.5, cy + sz);
    ctx0.lineTo(cx + sz, cy);
    ctx0.closePath();
    ctx0.fill();
  }

  function togglePause(session) {
    if (session.paused) {
      session.paused = false;
      if (session.wallClockSynced && !session.hasAudio) {
        session.wallClockStart = performance.now() - ((session.pauseOffsetUs - session.videoTimeBase) / 1000);
      }
      if (session.audioEl && session.audioEl.paused) session.audioEl.play().catch(function(){});
      if (session.playBtn) session.playBtn.innerHTML = '&#9646;&#9646;';
    } else {
      // Snapshot time BEFORE setting paused (getMediaTimeUs checks s.paused first)
      var t = getMediaTimeUs(session);
      session.paused = true;
      session.pauseOffsetUs = t >= 0 ? t : 0;
      if (session.audioEl && !session.audioEl.paused) session.audioEl.pause();
      if (session.playBtn) session.playBtn.innerHTML = '&#9654;';
    }
  }

  function requestVideoStream(videoEl) {
    var url = videoEl.getAttribute('src');
    if (!url || url.indexOf('sia://') !== 0) return;
    if (typeof VideoDecoder === 'undefined') {
      requestResource(videoEl, 'src');
      return;
    }

    var sessionId = 's' + (++_streamIdCounter);

    // Container (position:relative for controls overlay)
    var container = document.createElement('div');
    container.style.cssText = 'position:relative;overflow:hidden;background:#000;border-radius:4px;max-width:100%;';

    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;cursor:pointer;background:#000;';
    if (videoEl.width) canvas.width = videoEl.width;
    else canvas.width = 640;
    if (videoEl.height) canvas.height = videoEl.height;
    else canvas.height = 360;
    if (videoEl.className) canvas.className = videoEl.className;
    container.appendChild(canvas);

    // Controls overlay (matches main player design)
    var controls = document.createElement('div');
    controls.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:linear-gradient(transparent,rgba(0,0,0,0.8));display:flex;align-items:center;gap:10px;opacity:0;transition:opacity 0.3s;';

    var playBtn = document.createElement('button');
    playBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px 8px;';
    playBtn.innerHTML = '&#9654;';

    var timeSpan = document.createElement('span');
    timeSpan.style.cssText = 'color:#ccc;font-size:12px;font-family:monospace;min-width:60px;';
    timeSpan.textContent = '0:00';

    var seekbar = document.createElement('div');
    seekbar.style.cssText = 'flex:1;height:20px;display:flex;align-items:center;cursor:pointer;position:relative;';
    var seekTrack = document.createElement('div');
    seekTrack.style.cssText = 'width:100%;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;position:relative;overflow:visible;transition:height 0.15s;';
    var seekBuffered = document.createElement('div');
    seekBuffered.style.cssText = 'position:absolute;top:0;left:0;height:100%;background:rgba(255,255,255,0.25);border-radius:2px;width:0%;';
    var seekPlayed = document.createElement('div');
    seekPlayed.style.cssText = 'position:absolute;top:0;left:0;height:100%;background:#10b981;border-radius:2px;width:0%;';
    var seekThumb = document.createElement('div');
    seekThumb.style.cssText = 'position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:#10b981;transform:translate(-50%,-50%);left:0%;opacity:0;transition:opacity 0.15s;';
    seekTrack.appendChild(seekBuffered);
    seekTrack.appendChild(seekPlayed);
    seekTrack.appendChild(seekThumb);
    seekbar.appendChild(seekTrack);
    seekbar.addEventListener('mouseenter', function() { seekThumb.style.opacity = '1'; seekTrack.style.height = '6px'; });
    seekbar.addEventListener('mouseleave', function() { seekThumb.style.opacity = '0'; seekTrack.style.height = '4px'; });

    var volSlider = document.createElement('input');
    volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.01'; volSlider.value = '1';
    volSlider.style.cssText = 'width:60px;cursor:pointer;accent-color:#10b981;';

    var fsBtn = document.createElement('button');
    fsBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:4px 8px;';
    fsBtn.innerHTML = '&#x26F6;';

    controls.appendChild(playBtn);
    controls.appendChild(timeSpan);
    controls.appendChild(seekbar);
    controls.appendChild(volSlider);
    controls.appendChild(fsBtn);
    container.appendChild(controls);

    // Show/hide controls on hover
    var hideTimeout;
    function showControls() {
      controls.style.opacity = '1';
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(function() { controls.style.opacity = '0'; }, 3000);
    }
    container.addEventListener('mousemove', showControls);
    container.addEventListener('mouseenter', showControls);

    // Status line
    var statusDiv = document.createElement('div');
    statusDiv.style.cssText = 'color:#888;font-size:0.8rem;padding:0.5rem 1.25rem;';

    var autoplay = videoEl.hasAttribute('autoplay');
    if (!autoplay) {
      statusDiv.textContent = 'Click to play';
      drawPlayButton(canvas);
    } else {
      statusDiv.textContent = 'Loading video...';
    }

    videoEl.style.display = 'none';
    videoEl.parentNode.insertBefore(container, videoEl.nextSibling);
    videoEl.parentNode.insertBefore(statusDiv, container.nextSibling);

    var session = {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      container: container,
      controls: controls,
      playBtn: playBtn,
      timeSpan: timeSpan,
      seekPlayed: seekPlayed,
      seekBuffered: seekBuffered,
      seekThumb: seekThumb,
      statusDiv: statusDiv,
      videoEl: videoEl,
      decoder: null,
      frameBuffer: [],
      pendingSamples: [],
      canvasSized: false,
      paused: false,
      pauseOffsetUs: 0,
      wallClockStart: 0,
      videoTimeBase: -1,
      wallClockSynced: false,
      lastRafTime: 0,
      downloadComplete: false,
      mediaDuration: 0,
      hasAudio: false,
      audioEl: null,
      audioMediaSource: null,
      audioSourceBuffer: null,
      audioAppendQueue: [],
      audioSbAppending: false,
      renderRunning: false,
      aborted: false,
      started: false,
      seeking: false,
      decoderConfig: null,
      audioMode: null,
    };
    _streamSessions[sessionId] = session;

    // Play/pause via canvas click or play button
    canvas.addEventListener('click', function() {
      if (!session.started) {
        session.started = true;
        statusDiv.textContent = 'Loading video...';
        playBtn.innerHTML = '&#9646;&#9646;';
        window.parent.postMessage({ type: 'SIA_STREAM_REQUEST', url: url, sessionId: sessionId }, '*');
        return;
      }
      togglePause(session);
    });
    playBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!session.started) {
        session.started = true;
        statusDiv.textContent = 'Loading video...';
        playBtn.innerHTML = '&#9646;&#9646;';
        window.parent.postMessage({ type: 'SIA_STREAM_REQUEST', url: url, sessionId: sessionId }, '*');
        return;
      }
      togglePause(session);
    });

    // Volume
    volSlider.addEventListener('input', function() {
      if (session.audioEl) session.audioEl.volume = parseFloat(volSlider.value);
    });
    volSlider.addEventListener('click', function(e) { e.stopPropagation(); });

    // Fullscreen
    fsBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        container.requestFullscreen().catch(function() {});
      }
    });

    // Seek bar: click + drag to seek
    function seekFrac(e) {
      var rect = seekbar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    }
    function updateSeekVisual(frac) {
      var pct = (frac * 100) + '%';
      if (session.seekPlayed) session.seekPlayed.style.width = pct;
      if (session.seekThumb) session.seekThumb.style.left = pct;
      if (session.timeSpan && session.mediaDuration > 0) {
        session.timeSpan.textContent = formatTime(frac * session.mediaDuration) + ' / ' + formatTime(session.mediaDuration);
      }
    }
    seekbar.addEventListener('click', function(e) { e.stopPropagation(); });
    var dragging = false;
    seekbar.addEventListener('mousedown', function(e) {
      if (!session.started || session.mediaDuration <= 0) return;
      e.preventDefault();
      dragging = true;
      session.seeking = true;
      updateSeekVisual(seekFrac(e));
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      updateSeekVisual(seekFrac(e));
    });
    document.addEventListener('mouseup', function(e) {
      if (!dragging) return;
      dragging = false;
      session.seeking = false;
      var frac = seekFrac(e);
      var timeSec = frac * session.mediaDuration;
      updateSeekVisual(frac);
      window.parent.postMessage({ type: 'SIA_STREAM_SEEK', sessionId: sessionId, timeSec: timeSec }, '*');
    });

    if (autoplay) {
      session.started = true;
      statusDiv.textContent = 'Loading video...';
      playBtn.innerHTML = '&#9646;&#9646;';
      window.parent.postMessage({ type: 'SIA_STREAM_REQUEST', url: url, sessionId: sessionId }, '*');
    }
  }

  function getMediaTimeUs(s) {
    if (s.paused) return s.pauseOffsetUs;
    if (s.hasAudio && s.audioEl && !s.audioEl.paused && s.audioEl.readyState >= 3) {
      // Audio is playing with data — use as master clock.
      // Re-sync wall-clock baseline so fallback picks up seamlessly if audio stalls.
      var t = s.audioEl.currentTime * 1e6;
      s.videoTimeBase = t;
      s.wallClockStart = performance.now();
      s.wallClockSynced = true;
      return t;
    }
    // Audio not ready (buffering after seek, or no audio) — use wall-clock timing
    if (!s.wallClockSynced) return -1;
    return s.videoTimeBase + (performance.now() - s.wallClockStart) * 1000;
  }

  function feedSamples(s) {
    if (!s.decoder || s.decoder.state !== 'configured') return;
    var maxFeed = s.frameBuffer.length === 0 ? 8 : 2;
    var fed = 0;
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
    while (s.pendingSamples.length > 0 && fed < maxFeed) {
      if (s.decoder.decodeQueueSize + s.frameBuffer.length >= 12) break;
      var sample = s.pendingSamples.shift();
      fed++;
      var ts = (sample.cts * 1e6) / sample.timescale;
      try {
        s.decoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: ts,
          duration: (sample.duration * 1e6) / sample.timescale,
          data: sample.data,
        }));
      } catch (e) {}
    }
  }

  function drainAudioQueue(s) {
    if (!s.audioSourceBuffer || s.audioSbAppending || s.audioSourceBuffer.updating || s.audioAppendQueue.length === 0) return;
    if (s.audioMediaSource.readyState !== 'open') return;
    var buf = s.audioAppendQueue.shift();
    s.audioSbAppending = true;
    try {
      s.audioSourceBuffer.appendBuffer(buf);
    } catch (e) {
      s.audioSbAppending = false;
      if (e.name === 'QuotaExceededError') {
        s.audioAppendQueue.unshift(buf);
        if (s.audioSourceBuffer.buffered.length > 0 && s.audioEl) {
          var removeEnd = s.audioEl.currentTime - 5;
          if (removeEnd > s.audioSourceBuffer.buffered.start(0)) {
            s.audioSourceBuffer.remove(s.audioSourceBuffer.buffered.start(0), removeEnd);
          }
        }
      }
    }
  }

  function maybeEndAudio(s) {
    if (!s.downloadComplete || s.audioAppendQueue.length > 0 || s.audioSbAppending) return;
    if (s.audioMediaSource && s.audioMediaSource.readyState === 'open') {
      try { s.audioMediaSource.endOfStream(); } catch (e) {}
    }
  }

  function renderLoop(sessionId) {
    var s = _streamSessions[sessionId];
    if (!s || s.aborted) {
      if (s) { while (s.frameBuffer.length > 0) s.frameBuffer.shift().close(); }
      return;
    }

    // Stall compensation (when using wall-clock timing)
    var now = performance.now();
    var usingAudioClock = s.hasAudio && s.audioEl && !s.audioEl.paused && s.audioEl.readyState >= 3;
    if (s.lastRafTime > 0 && s.wallClockSynced && !usingAudioClock && !s.paused) {
      var gapMs = now - s.lastRafTime;
      if (gapMs > 50) s.wallClockStart += (gapMs - 16.67);
    }
    s.lastRafTime = now;

    feedSamples(s);

    if (s.paused) {
      // Update time display while paused
      var pausedSec = s.pauseOffsetUs / 1e6;
      if (s.timeSpan && s.mediaDuration > 0) {
        s.timeSpan.textContent = formatTime(pausedSec) + ' / ' + formatTime(s.mediaDuration);
      }
      requestAnimationFrame(function() { renderLoop(sessionId); });
      return;
    }

    // Establish timing on first frame
    if (!s.wallClockSynced && !s.hasAudio && s.frameBuffer.length > 0) {
      s.videoTimeBase = s.frameBuffer[0].timestamp;
      s.wallClockStart = performance.now();
      s.wallClockSynced = true;
      s.lastRafTime = s.wallClockStart;
    }

    var mediaTimeUs = getMediaTimeUs(s);
    if (mediaTimeUs < 0) {
      requestAnimationFrame(function() { renderLoop(sessionId); });
      return;
    }

    // Draw the latest frame whose time has arrived
    var frameToDraw = null;
    while (s.frameBuffer.length > 0 && s.frameBuffer[0].timestamp <= mediaTimeUs) {
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

    // Update controls
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

    requestAnimationFrame(function() { renderLoop(sessionId); });
  }

  function handleStreamInit(sessionId, d) {
    var s = _streamSessions[sessionId];
    if (!s) return;

    // Set up audio MSE if audio config provided
    if (d.audioConfig && typeof MediaSource !== 'undefined') {
      var audioEl = document.createElement('audio');
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      var ms = new MediaSource();
      audioEl.src = URL.createObjectURL(ms);
      s.audioEl = audioEl;
      s.audioMediaSource = ms;

      ms.addEventListener('sourceopen', function() {
        try {
          s.audioSourceBuffer = ms.addSourceBuffer(d.audioConfig.mime);
          s.audioSourceBuffer.addEventListener('updateend', function() {
            s.audioSbAppending = false;
            drainAudioQueue(s);
            maybeEndAudio(s);
          });
          s.hasAudio = true;
          if (d.audioConfig.initSegment) {
            s.audioInitSegment = d.audioConfig.initSegment.slice(0); // keep a copy for seek recovery
            s.audioAppendQueue.push(d.audioConfig.initSegment);
            drainAudioQueue(s);
          }
          audioEl.play().catch(function(){});
        } catch (e) {
          console.warn('Audio setup failed:', e);
        }
      }, { once: true });
    }

    // Set up VideoDecoder
    if (d.videoConfig) {
      var config = {
        codec: d.videoConfig.codec,
        codedWidth: d.videoConfig.codedWidth,
        codedHeight: d.videoConfig.codedHeight,
      };
      if (d.videoConfig.description) {
        config.description = new Uint8Array(d.videoConfig.description);
      }

      s.decoder = new VideoDecoder({
        output: function(frame) {
          if (s.aborted) { frame.close(); return; }
          s.frameBuffer.push(frame);
        },
        error: function(e) {
          console.error('VideoDecoder error:', e);
        }
      });
      s.decoderConfig = config;
      s.decoder.configure(config);

      if (!s.renderRunning) {
        s.renderRunning = true;
        requestAnimationFrame(function() { renderLoop(sessionId); });
      }
    }

    s.mediaDuration = d.duration || 0;
    if (d.audioConfig && d.audioConfig.mode) s.audioMode = d.audioConfig.mode;
    if (s.mediaDuration > 0) {
      s.timeSpan.textContent = '0:00 / ' + formatTime(s.mediaDuration);
      s.statusDiv.textContent = 'Streaming video (' + formatTime(s.mediaDuration) + ')...';
    } else {
      s.statusDiv.textContent = 'Streaming video...';
    }
  }

  // --- 4. Message dispatcher ---
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d) return;

    // Resource response (images, etc.)
    if (d.type === 'SIA_RESOURCE_RESPONSE') {
      var req = _pending[d.requestId];
      if (!req) return;
      delete _pending[d.requestId];
      if (d.error) { console.error('sia:// resource failed:', d.error); return; }
      var blob = new Blob([d.data], { type: d.mimeType || 'application/octet-stream' });
      var blobUrl = URL.createObjectURL(blob);
      req.el.setAttribute(req.attr, blobUrl);
      if (req.el.tagName === 'IMG') {
        req.el.style.opacity = '';
        req.el.removeAttribute('data-sia-loading');
        req.el.style.minHeight = '';
      }
      return;
    }

    // Stream messages
    var sid = d.sessionId;
    var s = sid ? _streamSessions[sid] : null;

    if (d.type === 'SIA_STREAM_INIT' && s) {
      handleStreamInit(sid, d);
      return;
    }
    if (d.type === 'SIA_STREAM_VIDEO' && s && d.samples) {
      for (var i = 0; i < d.samples.length; i++) {
        s.pendingSamples.push(d.samples[i]);
      }
      return;
    }
    if (d.type === 'SIA_STREAM_AUDIO' && s && d.buffer) {
      s.audioAppendQueue.push(d.buffer);
      drainAudioQueue(s);
      return;
    }
    if (d.type === 'SIA_STREAM_PROGRESS' && s) {
      var pct = d.total > 0 ? Math.round((d.current / d.total) * 100) : 0;
      s.statusDiv.textContent = 'Streaming: slab ' + d.current + '/' + d.total + ' (' + pct + '%)';
      if (s.mediaDuration > 0 && d.total > 0 && s.seekBuffered) {
        var bufPct = Math.min(100, (d.current / d.total) * 100);
        s.seekBuffered.style.width = bufPct + '%';
      }
      return;
    }
    if (d.type === 'SIA_STREAM_SEEK_FLUSH' && s) {
      var timeSec = d.timeSec;
      var seekTimeUs = timeSec * 1e6;
      // Reset decoder (immediately stops pending work, no stale frames)
      if (s.decoder) {
        if (s.decoder.state === 'configured') s.decoder.reset();
        if (s.decoderConfig) s.decoder.configure(s.decoderConfig);
        s._needsKeyframe = true;
      }

      // Clear buffers
      s.pendingSamples.length = 0;
      while (s.frameBuffer.length > 0) s.frameBuffer.shift().close();

      // Reset timing
      s.pauseOffsetUs = seekTimeUs;
      s.videoTimeBase = seekTimeUs;
      s.wallClockStart = performance.now();
      s.wallClockSynced = true;
      s.lastRafTime = s.wallClockStart;

      // Handle audio — clear SourceBuffer entirely, let re-extracted audio fill fresh.
      // Previous approach of suppressing duplicate audio on the parent side was unreliable.
      s.audioAppendQueue.length = 0;
      if (s.audioSourceBuffer) {
        if (s.audioSourceBuffer.updating) {
          try { s.audioSourceBuffer.abort(); } catch (ex) {}
        }
        s.audioSbAppending = false;
        // Set timestampOffset for raw-mse before remove (must be while updating=false)
        if (s.audioMode === 'raw-mse') {
          try { s.audioSourceBuffer.timestampOffset = timeSec; } catch (ex) {}
        }
        // Re-queue init segment for fMP4 (SourceBuffer stays configured after remove,
        // but re-appending init segment ensures clean segment boundary)
        if (s.audioMode === 'fmp4-mse' && s.audioInitSegment) {
          s.audioAppendQueue.push(s.audioInitSegment.slice(0));
        }
        // Clear all buffered audio — re-extracted + new audio fills from seek point
        try { s.audioSourceBuffer.remove(0, Infinity); } catch (ex) {}
      }
      if (s.audioEl) {
        s.audioEl.pause();
        s.audioEl.currentTime = timeSec;
        if (!s.paused) {
          s.audioEl.play().catch(function(){});
        }
      }

      // Update visual
      if (s.mediaDuration > 0) {
        var pct = Math.min(100, (timeSec / s.mediaDuration) * 100);
        if (s.seekPlayed) s.seekPlayed.style.width = pct + '%';
        if (s.seekThumb) s.seekThumb.style.left = pct + '%';
      }
      if (s.timeSpan && s.mediaDuration > 0) {
        s.timeSpan.textContent = formatTime(timeSec) + ' / ' + formatTime(s.mediaDuration);
      }
      return;
    }
    if (d.type === 'SIA_STREAM_END' && s) {
      s.downloadComplete = true;
      if (s.seekBuffered) s.seekBuffered.style.width = '100%';
      // Don't flush the VideoDecoder here — flushing puts the decoder in
      // "key frame required" state which drops pending non-keyframe samples,
      // causing a visible freeze. Let feedSamples/renderLoop drain naturally.
      // Audio MSE endOfStream is handled by the updateend chain via maybeEndAudio.
      s.statusDiv.textContent = 'Download complete.';
      return;
    }
    if (d.type === 'SIA_STREAM_ERROR' && s) {
      s.statusDiv.textContent = 'Stream error: ' + d.error;
      s.statusDiv.style.color = '#f87171';
      return;
    }
  });

  // --- 5. Scan + MutationObserver ---
  function scan(root) {
    var selectors = [
      'img[src^="sia://"]',
      'video[src^="sia://"]',
      'video[poster^="sia://"]',
      'audio[src^="sia://"]',
      'source[src^="sia://"]',
      'link[href^="sia://"]'
    ];
    var els = root.querySelectorAll(selectors.join(','));
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // Video elements: use streaming path
      if ((el.tagName === 'VIDEO') && el.hasAttribute('src') && el.getAttribute('src').indexOf('sia://') === 0) {
        requestVideoStream(el);
        continue;
      }
      if (el.hasAttribute('src') && el.getAttribute('src').indexOf('sia://') === 0)
        requestResource(el, 'src');
      if (el.hasAttribute('href') && el.getAttribute('href').indexOf('sia://') === 0)
        requestResource(el, 'href');
      if (el.hasAttribute('poster') && el.getAttribute('poster').indexOf('sia://') === 0)
        requestResource(el, 'poster');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scan(document); });
  } else {
    scan(document);
  }

  new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var nodes = muts[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].nodeType === 1) scan(nodes[j]);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
