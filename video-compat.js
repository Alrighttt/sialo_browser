// Browser-playback compatibility check for files the user is about to
// upload. Uses mp4box.js to parse MP4 headers, extract track codec
// strings, and test them against the current browser's
// `<video>.canPlayType()`. For non-MP4 containers we only warn by
// extension since we don't ship parsers for MKV/AVI/WebM here.
//
// This is pre-upload advice, nothing more. The upload itself is a
// byte-for-byte copy and doesn't care about codec support.

import { createFile as createMP4Box } from './vendor/mp4box.bundle.js';

// How much of the file to sniff. MP4s with `moov` before `mdat`
// (faststart layout) report every track within the first few MB.
// Files with `moov` at the end won't parse in this window and we
// return `null` — better to say nothing than a false negative.
const MP4_SNIFF_BYTES = 4 * 1024 * 1024;
const MP4_PARSE_TIMEOUT_MS = 5000;

// Extensions we can't inspect deeply but are historically associated
// with codec combinations browsers won't play without re-muxing.
const COARSE_WARN_EXTENSIONS = new Set(['mkv', 'avi', 'flv', 'wmv', 'ts']);

// Friendly labels for codec strings browsers refuse, so we can show a
// useful message instead of just the raw fourcc.
const UNSUPPORTED_CODEC_LABELS = {
  'dts':     'DTS / DTS-HD Master Audio (patent-encumbered, no browser decodes it)',
  'truehd':  'Dolby TrueHD (no browser decodes it)',
  'ac-3':    'AC-3 / Dolby Digital (Safari only)',
  'ec-3':    'E-AC-3 / Dolby Digital Plus (Safari only)',
  'hvc1':    'H.265 / HEVC video (Safari and Edge only; not Chrome/Firefox)',
  'hev1':    'H.265 / HEVC video (Safari and Edge only; not Chrome/Firefox)',
};

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|ts|ogv|3gp)$/i;

/**
 * Decide if a file is plausibly a video worth checking.
 * Falls back to extension sniffing when `File.type` is empty or wrong.
 */
function isVideoFile(file) {
  if (file.type && file.type.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.test(file.name || '');
}

/**
 * Check a file's browser-playback compatibility. Resolves to:
 *   - `null` when the file isn't a video, or when we couldn't
 *     determine codec support (don't warn on inconclusive probes).
 *   - `{ ok: true }` when the detected codecs all play.
 *   - `{ ok: false, problems: [string, ...] }` when something won't
 *     play. `problems` is a list of human-readable messages suitable
 *     for UI display (already plain text; callers must `_esc` for HTML).
 */
export async function checkVideoCompat(file) {
  if (!isVideoFile(file)) return null;

  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const isMp4Like = ['mp4', 'm4v', 'mov'].includes(ext) ||
                    /^video\/(mp4|quicktime)$/.test(file.type || '');

  if (!isMp4Like) {
    if (ext && COARSE_WARN_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        problems: [
          `.${ext} files often carry codecs (DTS audio, HEVC video, etc.) that web browsers can't decode. Consider transcoding to MP4 (H.264 + AAC) before upload.`,
        ],
      };
    }
    return null;
  }

  let codecs;
  try {
    codecs = await extractMp4Codecs(file);
  } catch {
    return null;
  }
  if (codecs.length === 0) return null;

  const probe = document.createElement('video');
  const combined = `video/mp4; codecs="${codecs.join(', ')}"`;
  if (probe.canPlayType(combined) !== '') return { ok: true };

  const problems = [];
  for (const codec of codecs) {
    if (probe.canPlayType(`video/mp4; codecs="${codec}"`) !== '') continue;
    const label =
      UNSUPPORTED_CODEC_LABELS[codec] ||
      UNSUPPORTED_CODEC_LABELS[codec.split('.')[0]] ||
      `Codec \`${codec}\` isn't supported by this browser`;
    problems.push(label);
  }
  if (problems.length === 0) {
    // Combined probe failed but each individual codec passes — usually
    // a weird profile / level combination. Flag it at coarser detail.
    problems.push(`Browser reports it won't play ${combined}`);
  }
  return { ok: false, problems };
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
      const codecs = info.tracks
        .filter((t) => t.video || t.audio)
        .map((t) => t.codec)
        .filter(Boolean);
      resolve(codecs);
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
 * A generic ffmpeg one-liner that fixes the common case: audio codec
 * isn't browser-playable, video codec already is. Copies the video
 * stream (fast, lossless) and transcodes audio to AAC. Moves the moov
 * atom to the front so Sia streams the result with Range seeking.
 */
export function suggestFfmpegFix(filename) {
  const safe = filename.replace(/"/g, '\\"');
  const out = filename.replace(/\.[a-z0-9]+$/i, '') + '_web.mp4';
  const safeOut = out.replace(/"/g, '\\"');
  return `ffmpeg -i "${safe}" -c:v copy -c:a aac -b:a 192k -movflags +faststart "${safeOut}"`;
}
