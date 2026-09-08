// Browser-playback compatibility check for files the user is about to upload.
//
// Two independent sources of evidence, because neither alone is enough:
//
//   1. mp4box.js parses MP4 headers and gives exact codec strings, which is
//      what lets us name the culprit ("AC-3 audio, Safari only") instead of
//      shrugging. MP4-family containers only.
//   2. An actual `<video>` element loads the file and reports what it managed
//      to decode. This works on any container the browser will open at all,
//      and it is the only thing that catches the case where a file half-plays
//      — a track the browser silently drops because it cannot decode it.
//
// The second one matters more than it looks. A Theora .ogv opens, reports a
// duration, and plays its Vorbis audio perfectly while showing nothing at all.
// Nothing in the file's name or headers says "broken"; the only way to know is
// to notice the decoded picture is 0x0.
//
// This is pre-upload advice, nothing more. The upload itself is a byte-for-byte
// copy and does not care about codec support.

import { createFile as createMP4Box } from './vendor/mp4box.bundle.js';

// How much of the file to sniff. MP4s with `moov` before `mdat` (faststart
// layout) report every track within the first few MB. Files with `moov` at the
// end will not parse in this window and we fall back to the playback probe.
const MP4_SNIFF_BYTES = 4 * 1024 * 1024;
const MP4_PARSE_TIMEOUT_MS = 5000;

// Loading metadata is header-only and quick even for a multi-GB file. The
// budget is generous because a cold page may still be fetching the decoder.
const PROBE_METADATA_TIMEOUT_MS = 10000;
// How long to let it decode before deciding whether an audio track exists.
const PROBE_DECODE_MS = 700;

/**
 * Extensions whose usual codec no browser decodes any more, with the reason.
 * Only consulted when the playback probe could not run — the probe is direct
 * evidence and this is an educated guess about a typical file.
 */
const DEAD_CODEC_NOTES = {
  ogv: 'Ogg video is almost always Theora, which Chrome removed in version 123 '
    + 'and other browsers never widely supported. Its Vorbis audio still decodes, '
    + 'so it plays as sound with no picture.',
  ogg: 'An .ogg holding video is almost always Theora, which browsers no longer '
    + 'decode. Audio-only .ogg (Vorbis) plays fine.',
};

// Containers we cannot inspect and browsers generally refuse to open. Used only
// as a fallback when the probe itself could not load the file.
const COARSE_WARN_EXTENSIONS = new Set(['mkv', 'avi', 'flv', 'wmv', 'ts', 'ogv', 'ogg']);

// Friendly labels for codec strings browsers refuse, so we can name the problem
// rather than print a raw fourcc.
const UNSUPPORTED_CODEC_LABELS = {
  'dts':    'DTS / DTS-HD Master Audio audio (patent-encumbered, no browser decodes it)',
  'truehd': 'Dolby TrueHD audio (no browser decodes it)',
  'ac-3':   'AC-3 / Dolby Digital audio (Safari only)',
  'ec-3':   'E-AC-3 / Dolby Digital Plus audio (Safari only)',
  'hvc1':   'H.265 / HEVC video (Safari and Edge only, not Chrome or Firefox)',
  'hev1':   'H.265 / HEVC video (Safari and Edge only, not Chrome or Firefox)',
  'vp09':   'VP9 video in an MP4 container (poorly supported; VP9 belongs in WebM)',
  'av01':   'AV1 video (not decoded by Safari before 17 or by older hardware)',
};

/**
 * Codecs that are not portable across browsers, whatever the machine doing the
 * uploading happens to support.
 *
 * This exists because the rest of this module answers "will it play *here*",
 * and that is the wrong question for a site other people open. Safari decodes
 * HEVC and AC-3 quite happily, so an uploader on a Mac gets a clean bill of
 * health for a file no Chrome or Firefox viewer can watch. These are flagged on
 * name alone, so the warning does not depend on who is uploading.
 *
 * AV1 is deliberately absent: it is decoded by current Chrome, Firefox and
 * Safari, so warning about it would be noise.
 */
const NARROW_SUPPORT = new Set(['hvc1', 'hev1', 'dts', 'truehd', 'ac-3', 'ec-3']);

// Which track a codec string belongs to, for codecs we know by name. Used to
// aim the ffmpeg command when the probe cannot tell us.
const AUDIO_CODEC_PREFIXES = ['mp4a', 'ac-3', 'ec-3', 'dts', 'truehd', 'opus', 'vorbis', 'alac', 'flac'];

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|ts|m2ts|mts|ogv|3gp|mpg|mpeg)$/i;

/**
 * Decide if a file is plausibly a video worth checking. Falls back to extension
 * sniffing when `File.type` is empty or wrong, which is usual for files dragged
 * in from a folder.
 */
export function isVideoFile(file) {
  if (file.type && file.type.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.test(file.name || '');
}

function extensionOf(name) {
  return (String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
}

function isMp4Like(file) {
  return ['mp4', 'm4v', 'mov'].includes(extensionOf(file.name))
    || /^video\/(mp4|quicktime)$/.test(file.type || '');
}

function isAudioCodec(codec) {
  const base = String(codec).split('.')[0].toLowerCase();
  return AUDIO_CODEC_PREFIXES.includes(base);
}

/**
 * Load the file in a real `<video>` element and report what the browser
 * actually decoded. Resolves to:
 *   { opened, hasVideo, hasAudio, error }
 * where `hasAudio` is `null` when the browser gives us no way to tell — Chrome
 * only exposes it as a decoded-byte counter, so a file that never started
 * decoding is genuinely unknown rather than silent.
 *
 * Never rejects: an inconclusive probe must not stop the upload.
 */
export async function probePlayback(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;              // required for play() without a user gesture
  v.playsInline = true;
  v.src = url;

  const cleanup = () => {
    try { v.pause(); } catch (_) {}
    v.removeAttribute('src');
    try { v.load(); } catch (_) {}
    URL.revokeObjectURL(url);
  };

  try {
    const opened = await new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => done(false), PROBE_METADATA_TIMEOUT_MS);
      v.addEventListener('loadedmetadata', () => done(true), { once: true });
      v.addEventListener('error', () => done(false), { once: true });
    });

    if (!opened) {
      const code = v.error ? v.error.code : 0;
      return {
        opened: false,
        hasVideo: false,
        hasAudio: null,
        // MEDIA_ERR_SRC_NOT_SUPPORTED is the one that means "this browser
        // cannot play this at all", as opposed to a decode error partway in.
        error: code === 4 ? 'unsupported' : (code ? 'decode' : 'timeout'),
      };
    }

    // A decodable video track reports real dimensions. Theora in Chrome, or an
    // HEVC track Chrome drops, leaves this at 0 while the file otherwise looks
    // healthy — duration, audio and all.
    const hasVideo = v.videoWidth > 0 && v.videoHeight > 0;

    // Firefox and Safari answer directly.
    let hasAudio = null;
    if (typeof v.mozHasAudio === 'boolean') hasAudio = v.mozHasAudio;
    else if (v.audioTracks && typeof v.audioTracks.length === 'number') {
      hasAudio = v.audioTracks.length > 0;
    } else if (typeof v.webkitAudioDecodedByteCount === 'number') {
      // Chrome only counts decoded bytes, so it has to actually decode some.
      // Muted playback is permitted without a gesture; if the policy blocks it
      // anyway we stay at `null` rather than guessing.
      try {
        await v.play();
        await new Promise((r) => setTimeout(r, PROBE_DECODE_MS));
        const audioBytes = v.webkitAudioDecodedByteCount || 0;
        const videoBytes = v.webkitVideoDecodedByteCount || 0;
        // Zero audio bytes only means something once decoding is demonstrably
        // under way. If nothing decoded at all, the answer is unknown.
        if (audioBytes > 0) hasAudio = true;
        else if (videoBytes > 0 || v.currentTime > 0) hasAudio = false;
      } catch (_) {
        // Autoplay refused, or the file cannot be played. Leave it unknown.
      }
    }

    return { opened: true, hasVideo, hasAudio, error: null };
  } catch (_) {
    return { opened: false, hasVideo: false, hasAudio: null, error: 'probe-failed' };
  } finally {
    cleanup();
  }
}

async function extractMp4Codecs(file) {
  const size = Math.min(MP4_SNIFF_BYTES, file.size);
  const buf = await file.slice(0, size).arrayBuffer();
  buf.fileStart = 0;
  const mp4box = createMP4Box();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), MP4_PARSE_TIMEOUT_MS);
    mp4box.onReady = (info) => {
      clearTimeout(timer);
      resolve(info.tracks.filter((t) => t.video || t.audio).map((t) => t.codec).filter(Boolean));
    };
    mp4box.onError = (e) => {
      clearTimeout(timer);
      reject(new Error(String(e)));
    };
    mp4box.appendBuffer(buf);
    mp4box.flush();
  });
}

/**
 * Check a file's browser-playback compatibility. Resolves to:
 *   - `null` when the file is not a video, or when nothing conclusive was
 *     found. An inconclusive probe says nothing rather than crying wolf.
 *   - `{ ok: true }` when it plays.
 *   - `{ ok: false, problems, videoBad, audioBad, sourceIsMp4 }` otherwise.
 *
 * `problems` is plain text for display; callers must escape it for HTML.
 * `videoBad` / `audioBad` say which track needs re-encoding, which is what
 * makes the suggested ffmpeg command correct rather than generic.
 */
export async function checkVideoCompat(file) {
  if (!isVideoFile(file)) return null;

  const ext = extensionOf(file.name);
  const sourceIsMp4 = isMp4Like(file);
  const problems = [];
  let videoBad = false;
  let audioBad = false;

  // Exact codec names, when the container allows it.
  let codecs = null;
  if (sourceIsMp4) {
    try { codecs = await extractMp4Codecs(file); } catch (_) { codecs = null; }
  }
  // Whether the container says it holds an audio track at all. `null` means we
  // could not look, which is not the same as "no audio" and must not be
  // treated as such.
  const declaredAudio = (codecs && codecs.length) ? codecs.some(isAudioCodec) : null;
  if (codecs && codecs.length) {
    const probe = document.createElement('video');
    for (const codec of codecs) {
      const base = codec.split('.')[0].toLowerCase();
      const playsHere = probe.canPlayType(`video/mp4; codecs="${codec}"`) !== '';
      const portable = !NARROW_SUPPORT.has(base);
      if (playsHere && portable) continue;
      const label = UNSUPPORTED_CODEC_LABELS[codec]
        || UNSUPPORTED_CODEC_LABELS[base]
        || `Codec "${codec}" is not supported by this browser`;
      // Say which of the two problems it is, because they read very
      // differently to someone whose own machine plays the file perfectly.
      problems.push(playsHere
        ? `${label} — it plays for you, but not for most people opening the site.`
        : label);
      if (isAudioCodec(codec)) audioBad = true; else videoBad = true;
    }
  }

  // What the browser actually manages to decode. Runs even when the header
  // parse succeeded, because canPlayType is a claim and this is a result.
  const played = await probePlayback(file);

  if (!played.opened) {
    if (played.error === 'unsupported') {
      problems.push('This browser cannot open the file at all, so it will not play in a site either.');
      videoBad = true;
      audioBad = true;
    } else if (problems.length === 0) {
      // The probe was inconclusive (timeout, or a decode error partway in).
      // Fall back to what the extension suggests, and say nothing otherwise.
      if (DEAD_CODEC_NOTES[ext]) {
        problems.push(DEAD_CODEC_NOTES[ext]);
        videoBad = true;
      } else if (COARSE_WARN_EXTENSIONS.has(ext)) {
        problems.push(`.${ext} files commonly carry codecs browsers cannot decode `
          + '(HEVC video, DTS or Dolby audio). This one could not be checked here.');
        videoBad = true;
        audioBad = true;
      } else {
        return null;
      }
    }
  } else {
    if (!played.hasVideo) {
      problems.push('No picture: the browser opened the file but decoded no video track. '
        + (DEAD_CODEC_NOTES[ext] || 'It will play as sound over a blank screen.'));
      videoBad = true;
    }
    // Only raise this when the container is known to hold an audio track. A
    // silent video is a perfectly normal thing to upload — screen recordings
    // and animations usually are — and warning about every one of them would
    // teach the reader to ignore the warning that matters. mp4box gives us the
    // track list for MP4, so there we can tell "audio we cannot decode" from
    // "no audio"; for other containers we cannot, and so say nothing.
    if (played.hasAudio === false && declaredAudio === true && !audioBad) {
      problems.push('Silent: the file declares an audio track, but this browser decoded no '
        + 'sound from it, so its audio codec is one browsers do not support.');
      audioBad = true;
    }
  }

  if (problems.length === 0) return { ok: true };
  return { ok: false, problems, videoBad, audioBad, sourceIsMp4 };
}

/**
 * An ffmpeg command that actually fixes the problem found.
 *
 * The important part is that a stream is only copied when it is known good AND
 * the source is already MP4. Copying is fast and lossless, but a working VP9 or
 * Vorbis stream cannot simply be dropped into an MP4 container, so for any
 * other source both streams are re-encoded. The previous version of this always
 * emitted `-c:v copy -c:a aac`, which for a Theora .ogv or an HEVC file copied
 * the broken track through and produced a file that still would not play.
 *
 * `result` is what `checkVideoCompat` returned; without it we assume the worst
 * and re-encode everything, which is always correct if not always fastest.
 */
export function suggestFfmpegFix(filename, result) {
  const inName = String(filename || 'input.mp4');
  const quote = (s) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
  const out = inName.replace(/\.[a-z0-9]+$/i, '') + '_web.mp4';

  const canCopy = result && result.sourceIsMp4;
  const videoOk = result ? !result.videoBad : false;
  const audioOk = result ? !result.audioBad : false;

  const vArg = (canCopy && videoOk)
    ? '-c:v copy'
    : '-c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p';
  const aArg = (canCopy && audioOk) ? '-c:a copy' : '-c:a aac -b:a 192k';

  // +faststart moves the moov atom to the front so the file starts playing
  // before it has fully arrived, which is what makes range-seeking work when
  // it is streamed out of a site.
  return `ffmpeg -i ${quote(inName)} ${vArg} ${aArg} -movflags +faststart ${quote(out)}`;
}

/**
 * One line explaining what the suggested command will do, so the reader can
 * judge the cost before running it. Re-encoding video is minutes-to-hours;
 * remuxing is seconds.
 */
export function describeFfmpegFix(result) {
  const canCopy = result && result.sourceIsMp4;
  const reencVideo = !(canCopy && result && !result.videoBad);
  const reencAudio = !(canCopy && result && !result.audioBad);
  if (reencVideo && reencAudio) {
    return 'Re-encodes both tracks to H.264 and AAC. This is the slow one — expect '
      + 'it to take a while on a long video.';
  }
  if (reencVideo) {
    return 'Re-encodes the video to H.264 and keeps the existing audio. Expect it to '
      + 'take a while on a long video.';
  }
  if (reencAudio) {
    return 'Converts the audio to AAC and copies the video across untouched, so it '
      + 'runs in seconds rather than re-encoding the picture.';
  }
  return 'Repackages the file without re-encoding either track.';
}
