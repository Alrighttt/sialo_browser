// Upload Site page — turn a folder into a Sia-hosted site.
//
// The page is three steps, in order:
//
//   1. Add files.    A dropped folder is read into the Site Builder draft.
//                    Nothing is uploaded: the point of staging is that the
//                    user can still add objects from My Objects and fix
//                    paths before committing bytes to hosts.
//   2. Site Builder. The draft. Holds pending local files and objects that
//                    already exist on Sia, side by side; either can be
//                    renamed or removed.
//   3. Hand it out.  Publish and Share, independent and both available for
//                    one site.
//
// Publish writes a manifest object mapping each path to a signed `sia://`
// URL, and hands back a `sialo://` URL that resolves from any account.
// Share creates a sharing key and attaches every object to it; a shared
// site has no manifest, so each file's path is read from its own metadata.
// That difference is why sharing may rewrite metadata (see `applyPath`).
//
// Pending files are uploaded through the SDK's PackedUpload handle, which
// bin-packs them into shared slabs. For a typical site — many small
// HTML/CSS/JS files plus a few images — that is dramatically cheaper than
// one full 10/20-shard slab per file: ~40 MiB of content packs into a
// single slab instead of 30+ per-file slabs. Whichever action runs first
// pays for the upload; it then rewrites those draft entries to real object
// IDs, so running the other action afterwards uploads nothing.

import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { _esc, formatSize } from './utils.js';
import { connectSdk, getMaxUploads, getUrl, getKeyHex, getLastConnectError } from './config.js';
import { uploadOptions } from './transfer-options.js';
import { withKeepAlive } from './keep-alive.js';
import {
  getActiveTab, trackAbort, tabStatusProxy, openOrActivateInternalTab,
  openUrlInNewTab, makeOpenable,
} from './tabs.js';
import {
  encodeMetadata, sanitizeDisplayFilename, stripUploadUuid, extractUploadUuid,
  filenameForDisplay,
  siteNameForDisplay,
} from './object-metadata.js';
import {
  getDraft, addFilesToDraft, materializeEntry, pendingFiles, removeFromDraft,
  clearDraft, updateFilename as updateDraftFilename, onDraftChange, KIND_FILE,
} from './site-builder.js';
import { buildSiaSiteManifest, publishedSiteLink, MANIFEST_NAME_MAX } from './sia-site.js';
import {
  isVideoFile, checkVideoCompat, suggestFfmpegFix, describeFfmpegFix,
} from './video-compat.js';
import { siteLink } from './sharing-keys.js';

// Bottom-right status bar proxy for the currently-active tab.
function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

/**
 * Per-entry upload status, keyed by draft entry ID. Kept outside the draft
 * because it is transient display state, and outside the table because the
 * table is rebuilt from scratch on every draft change — including the
 * changes made by the upload itself as it materialises entries.
 */
const statusById = new Map();

/**
 * Browser-playability results for pending video files, keyed by draft entry
 * id. A `null` value means the file was checked and there is nothing to say,
 * which is what stops it being re-checked on every re-render.
 *
 * Kept beside `statusById` and for the same reason: the table is rebuilt from
 * scratch on every draft change, so nothing may live inside it.
 */
const videoCompatById = new Map();

// A slab is 10 data shards of 4 MiB, so ~40 MiB of content fills one on its
// own. Packing exists to stop many small files each wasting a whole slab; a
// file at or above this size fills slabs regardless and gains nothing from it.
//
// It also loses something: `packed.add()` buffers into slabs and the network
// upload only starts at `finalize()`, so a large file spends minutes
// accumulating with nothing in flight and no progress to show. Uploaded on its
// own it streams to hosts as it reads.
const PACK_MAX_BYTES = 32 * 1024 * 1024;

const STATUS_STYLES = {
  stored:    { color: '#555',    label: 'on Sia' },
  pending:   { color: '#666',    label: 'not uploaded' },
  packing:   { color: '#eab308', label: 'packing…' },
  uploading: { color: '#3b82f6', label: 'uploading…' },
  pinning:   { color: '#a855f7', label: 'pinning…' },
  done:      { color: '#10b981', label: '✓ uploaded' },
  failed:    { color: '#dc2626', label: '⚠ failed' },
};

/**
 * Wrap a File's stream so bytes are counted as the SDK pulls them.
 *
 * Neither `sdk.upload()` nor `packed.add()` reports progress, so a large file
 * shows nothing for minutes — the earlier symptom was a 673 MB video sitting
 * at "0 / 7 files" for a minute and a half with no way to tell whether it was
 * working or wedged. The one thing we do control is the source stream, and how
 * much of it has been consumed is a genuine measure of progress.
 *
 * Reported as bytes *read*, not uploaded: the SDK reads ahead to fill slabs
 * before erasure-coding them, so this leads the network slightly. It is a
 * truthful description of what is being measured.
 *
 * `onBytes` is called at most a few times a second — a chunk callback can fire
 * hundreds of times a second and each one would touch the DOM.
 */
function countingStream(file, onBytes) {
  const reader = file.stream().getReader();
  let total = 0;
  let lastReport = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        onBytes(total, true);
        controller.close();
        return;
      }
      total += value.byteLength;
      const now = performance.now();
      if (now - lastReport > 250) {
        lastReport = now;
        onBytes(total, false);
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Seconds as a short human duration. Module scope: used by module-level
 * helpers as well as by the panel, and being local to the panel is what broke
 * `progressDetail` at runtime. */
function formatElapsed(sec) {
  if (sec < 60) return Math.round(sec) + 's';
  const m = Math.floor(sec / 60);
  return m + 'm ' + Math.round(sec % 60) + 's';
}

/** A rate and a remaining-time estimate, once there is enough to estimate from. */
function progressDetail(bytes, totalBytes, startedAt) {
  const secs = (performance.now() - startedAt) / 1000;
  if (secs < 1 || bytes <= 0) return '';
  const rate = bytes / secs;
  const parts = [`${formatSize(rate)}/s`];
  if (totalBytes > bytes && rate > 0) {
    parts.push(`~${formatElapsed((totalBytes - bytes) / rate)} left`);
  }
  return ' · ' + parts.join(' · ');
}

/**
 * Object IDs that `text` references by published URL, e.g. a
 * `<video src="sia://host/objects/<id>/shared?…">` embed.
 *
 * A published URL resolves through the *viewer's* indexer account, which a
 * sharing-key recipient does not have — so a site that embeds one is broken
 * for them unless that object is attached to the same key. Finding the IDs up
 * front lets Share attach them automatically instead of leaving the reader
 * with a dead player and an instruction to go fix it by hand.
 */
export function extractSiaObjectIds(text) {
  const ids = new Set();
  const re = /sia:\/\/[^\s"'<>)]*?\/objects\/([0-9a-f]{64})/gi;
  let m;
  while ((m = re.exec(String(text || '')))) ids.add(m[1].toLowerCase());
  return ids;
}

/** Files worth scanning for embeds, and the size beyond which we do not bother. */
const SCANNABLE = /\.(?:x?html?|css|js|mjs|json|svg|md|txt)$/i;
const SCAN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Scan the draft's pending local files for embedded published URLs. Only text
 * files, and only small ones — reading a 600 MB video as text would be
 * catastrophic, and no media file references anything anyway.
 *
 * Runs before the upload, while the File handles still exist: materialising an
 * entry replaces it with an object ID and drops the File.
 */
async function collectEmbeddedIds(entries) {
  const ids = new Set();
  for (const e of entries) {
    if (e.kind !== KIND_FILE || !e.file) continue;
    if (!SCANNABLE.test(e.filename) || (e.size || 0) > SCAN_MAX_BYTES) continue;
    try {
      for (const id of extractSiaObjectIds(await e.file.text())) ids.add(id);
    } catch (_) { /* unreadable: nothing to attach from it */ }
  }
  return ids;
}

/** A label for the site's sharing key, so the Sharing Keys page reads sensibly. */
function siteDescription(count) {
  return `sialo site (${count} file${count === 1 ? '' : 's'})`;
}

/**
 * Paths claimed by more than one entry, as `path -> entries`.
 *
 * A site is a path-to-file map, so two entries claiming one path is not a
 * detail to resolve quietly: for a published site one manifest key wins, and
 * for a shared site the loader builds `files[path] = obj` so the last object
 * listed silently shadows the other — in an order the indexer's paging does
 * not guarantee. Either way a file the author put in the site is not there,
 * and nothing says so.
 *
 * It happens as soon as sources are mixed: a folder drop and an "Add to site"
 * object both offering `index.html`.
 */
function duplicatePaths(entries) {
  const byPath = new Map();
  for (const e of entries) {
    const path = (e.filename || '').replace(/^\/+/, '');
    if (!path) continue;
    const list = byPath.get(path) || [];
    list.push(e);
    byPath.set(path, list);
  }
  const clashes = new Map();
  for (const [path, list] of byPath) {
    if (list.length > 1) clashes.set(path, list);
  }
  return clashes;
}

/**
 * Draft paths, de-duplicated. Two entries can legitimately end up with the
 * same path (the same filename added from two folders, say); suffixing the
 * later one keeps manifest keys unique instead of silently overwriting.
 */
/**
 * The draft list's sortable columns. A folder row answers each one about its
 * contents rather than about itself, which is the only reading that makes a
 * folder comparable to a file: "how big" means the total inside it, and "what
 * state" means whether anything inside is still to upload.
 */
const SB_COLUMNS = [
  { key: 'name',   label: 'Name',      cls: 'sb-path' },
  { key: 'id',     label: 'Object ID', cls: 'sb-id' },
  { key: 'size',   label: 'Size',      cls: 'sb-size' },
  { key: 'status', label: 'Status',    cls: 'sb-status' },
];

// Numeric collation, so `2021` sorts before `2023` and `part2` before
// `part10`. A plain string sort puts `part10` first, which reads as broken on
// exactly the kind of numbered folder these drafts are full of.
const sbCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sbCompare(a, b, asc) {
  const dir = asc ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
  return sbCollator.compare(String(a), String(b)) * dir;
}

/**
 * Split a resolved draft into the folders and files directly inside `dir`.
 *
 * Grouping by the first path segment below the current folder is the same rule
 * the site's own auto-index uses, so what the builder shows is what a visitor
 * gets when the site has no index.html of its own.
 *
 * `statusOf` is passed in rather than read from the panel, so this stays a
 * function of its arguments.
 */
function sbSplitFolder(resolved, dir, sort, statusOf) {
  const dirs = new Map();
  const files = [];
  for (const r of resolved) {
    if (!r.path.startsWith(dir)) continue;
    const rest = r.path.slice(dir.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      files.push({ ...r, name: rest });
      continue;
    }
    const name = rest.slice(0, slash + 1);
    const agg = dirs.get(name) || { name, count: 0, bytes: 0, pending: 0 };
    agg.count += 1;
    agg.bytes += r.entry.size || 0;
    if (statusOf(r.entry) === 'pending') agg.pending += 1;
    dirs.set(name, agg);
  }
  const key = sort.key;
  const dirValue = (d) => (
    key === 'name' ? d.name : key === 'size' ? d.bytes : key === 'id' ? d.count : d.pending);
  const fileValue = (f) => {
    if (key === 'name') return f.name;
    if (key === 'size') return f.entry.size || 0;
    if (key === 'id') return f.entry.kind === KIND_FILE ? '' : f.entry.id;
    return statusOf(f.entry) === 'pending' ? 1 : 0;
  };
  // Folders stay above files whichever column is sorted. Interleaving them by
  // size or status would scatter the things you navigate through among the
  // things you act on, and the sort is for finding a file, not for reordering
  // the folder structure.
  const dirsSorted = [...dirs.values()].sort((a, b) => sbCompare(dirValue(a), dirValue(b), sort.asc));
  files.sort((a, b) => sbCompare(fileValue(a), fileValue(b), sort.asc));
  return { dirs: dirsSorted, files };
}

/** The folder one level up from `dir`; '' at the root. */
function sbParentDir(dir) {
  return dir.replace(/[^/]+\/$/, '');
}

function resolvePaths(entries) {
  const seen = new Set();
  return entries.map((e) => {
    let path = e.filename;
    let suffix = 1;
    while (seen.has(path)) {
      const dot = e.filename.lastIndexOf('.');
      path = dot > 0
        ? e.filename.slice(0, dot) + `-${suffix}` + e.filename.slice(dot)
        : `${e.filename}-${suffix}`;
      suffix++;
    }
    seen.add(path);
    return { entry: e, path };
  });
}

export function initUploadSiteUI() {
  const dropzone  = document.getElementById('us-dropzone');
  const dirInput  = document.getElementById('us-dir');
  const sbCrumbs  = document.getElementById('sb-crumbs');

  // Which folder of the draft is on screen, '' for the root, otherwise a path
  // with a trailing slash ('MSFC/2021/'). Held here rather than in the draft
  // itself: it is where the reader is looking, not part of the site.
  let sbDir = '';
  let sbSort = { key: 'name', asc: true };

  const filesInput = document.getElementById('us-files');
  const pickFolderBtn = document.getElementById('us-pick-folder');
  const pickFilesBtn  = document.getElementById('us-pick-files');
  const card      = document.getElementById('us-info-card');
  const cardRoot  = document.getElementById('us-card-root');
  const cardSum   = document.getElementById('us-card-summary');
  const cardCur   = document.getElementById('us-card-current');
  const cardDone  = document.getElementById('us-card-files-done');
  const cardElap  = document.getElementById('us-card-elapsed');
  const progress  = document.getElementById('us-progress');
  const cancelBtn = document.getElementById('us-cancel');

  const sbCount      = document.getElementById('sb-count');
  const sbEmpty      = document.getElementById('sb-empty');
  const sbListWrap   = document.getElementById('sb-list-wrap');
  const sbList       = document.getElementById('sb-list');
  const sbActions    = document.getElementById('sb-actions');
  const sbClearBtn   = document.getElementById('sb-clear');
  const sbPending    = document.getElementById('sb-pending-note');
  const sbVideoWarn  = document.getElementById('sb-video-warn');

  const publishBtn   = document.getElementById('us-publish-btn');
  const siteNameEl   = document.getElementById('us-site-name');
  const sbDupWarn    = document.getElementById('sb-dup-warn');
  const publishProg  = document.getElementById('us-publish-progress');
  const publishRes   = document.getElementById('us-publish-result');
  const resultId     = document.getElementById('us-result-id');
  const resultUrl    = document.getElementById('us-result-url');
  const openBtn      = document.getElementById('us-open-btn');
  const copyBtn      = document.getElementById('us-copy-btn');
  const resultLink   = document.getElementById('us-result-link');
  const copyLinkBtn  = document.getElementById('us-copy-link-btn');
  const validityNum  = document.getElementById('us-validity-num');
  const validityUnit = document.getElementById('us-validity-unit');

  const shareBtn        = document.getElementById('us-share-btn');
  const shareProg       = document.getElementById('us-share-progress');
  const shareRes        = document.getElementById('us-share-result');
  const shareKeyEl      = document.getElementById('us-share-key');
  const shareUrlEl      = document.getElementById('us-share-url');
  const shareCopyBtn    = document.getElementById('us-share-copy-btn');
  const shareOpenBtn    = document.getElementById('us-share-open-btn');
  const shareValNum     = document.getElementById('us-share-validity-num');
  const shareValUnit    = document.getElementById('us-share-validity-unit');

  /** Folder name of the most recent drop, shown on the progress card. */
  let rootLabel = 'site';
  /** AbortController for the in-flight upload, if any. */
  let currentAbort = null;
  /** Guard so Publish and Share cannot run concurrently on one draft. */
  let busy = false;
  /** Set by renderSiteBuilder; blocks both actions while true. */
  let hasDuplicatePaths = false;

  // --- Step 1: reading a folder into the draft ---

  /**
   * Turn a FileList into [{ relPath, file }], skipping dotfiles and macOS
   * metadata junk.
   *
   * Directory picks populate `file.webkitRelativePath` as "root/sub/file.txt";
   * loose files have no relative path at all, so their own name is used. The
   * wrapping root segment is stripped only when every path carries the same
   * one, which is exactly the "user picked a single folder" case the
   * stripping exists for. Taking the first path's first segment
   * unconditionally would mis-handle the other cases: a set of loose files
   * would adopt the first file's own name as the site root, and a drop
   * mixing a folder with a loose file would strip nothing at all.
   */
  function collectFiles(fileList) {
    const collected = [];
    for (const file of fileList) {
      const rel = file.webkitRelativePath || file.name;
      // Skip hidden files/folders anywhere in the path.
      if (rel.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX')) continue;
      if (!rel) continue;
      collected.push({ relPath: rel, file });
    }

    const first = collected.length ? collected[0].relPath.split('/')[0] : '';
    const shared = collected.length > 0 && collected.every(
      (c) => c.relPath.includes('/') && c.relPath.split('/')[0] === first,
    );
    if (!shared) return { files: collected, rootPrefix: '' };

    for (const c of collected) c.relPath = c.relPath.slice(first.length + 1);
    // A path that was nothing but the root segment cannot happen here (every
    // path contains a slash), but an empty remainder would be unusable.
    return { files: collected.filter((c) => c.relPath), rootPrefix: first };
  }

  function addFiles(fileList) {
    const { files, rootPrefix } = collectFiles(fileList);
    if (files.length === 0) {
      panelStatus().innerHTML = '<span class="fail">No uploadable files in that folder.</span>';
      return;
    }
    rootLabel = rootPrefix || 'site';
    clearResults();
    addFilesToDraft(files);
    const total = files.reduce((s, f) => s + f.file.size, 0);
    panelStatus().innerHTML =
      `<span class="pass">Added ${files.length} file${files.length === 1 ? '' : 's'} ` +
      `(${formatSize(total)}) to the site builder.</span>`;
    scanVideosForCompat();
  }

  // Bumped on every new drop so a scan still walking an earlier batch stops
  // rather than writing results for a draft the user has already replaced.
  let videoScanSeq = 0;

  /**
   * Check pending videos for browser playability, one at a time.
   *
   * Sequential deliberately. Each check decodes a moment of the file to see
   * what the browser actually produces, and a dropped season of episodes would
   * otherwise start dozens of decoders at once. Results appear as they land, so
   * the first file is flagged while the rest are still queued.
   *
   * Never throws and never blocks the upload: a file that cannot be played is
   * still a file the user may well want stored.
   */
  async function scanVideosForCompat() {
    const seq = ++videoScanSeq;
    for (const entry of getDraft()) {
      if (seq !== videoScanSeq) return;
      if (entry.kind !== KIND_FILE || !entry.file) continue;
      if (videoCompatById.has(entry.id)) continue;
      if (!isVideoFile(entry.file)) continue;
      let result = null;
      try {
        result = await checkVideoCompat(entry.file);
      } catch (_) {
        result = null;   // an inconclusive check must not produce a warning
      }
      if (seq !== videoScanSeq) return;
      videoCompatById.set(entry.id, result);
      if (result && !result.ok) renderSiteBuilder();
    }
  }

  /**
   * Wipe result blocks and their progress lines.
   *
   * A published URL or sharing key belongs to the exact set of files it was
   * made from, so the moment the draft changes the one on screen describes a
   * different site than the one being assembled, and leaving it visible invites
   * copying the wrong link. That is what `kind` omitted means: the draft moved,
   * so nothing on screen is true any more.
   *
   * Naming a `kind` clears only that block, for the case where the draft has
   * not moved. Publishing and sharing are two ways to hand out the *same* site
   * and users reasonably do both, so one starting must not erase the other's
   * result — only its own previous one.
   */
  function clearResults(kind) {
    const blocks = kind === 'publish' ? [[publishRes, publishProg], [resultId, resultUrl, resultLink]]
      : kind === 'share' ? [[shareRes, shareProg], [shareKeyEl, shareUrlEl]]
      : [[publishRes, shareRes, publishProg, shareProg],
         [resultId, resultUrl, resultLink, shareKeyEl, shareUrlEl]];
    for (const el of blocks[0]) {
      if (el) el.style.display = 'none';
    }
    for (const el of blocks[1]) {
      if (el) el.textContent = '';
    }
  }

  // --- Step 2: the draft table ---

  function statusFor(entry) {
    return statusById.get(entry.id)
      || (entry.kind === KIND_FILE ? 'pending' : 'stored');
  }

  function renderSiteBuilder() {
    const entries = getDraft();
    const pending = entries.filter((e) => e.kind === KIND_FILE);
    sbCount.textContent = `${entries.length} file${entries.length === 1 ? '' : 's'}`;

    // Local Files cannot be serialised, so a reload loses anything not yet
    // uploaded. Say so plainly rather than letting the draft look durable.
    if (pending.length > 0) {
      const n = pending.length;
      const bytes = pending.reduce((s, e) => s + (e.size || 0), 0);
      sbPending.innerHTML =
        `${n} file${n === 1 ? '' : 's'} (${formatSize(bytes)}) not uploaded yet. ` +
        `They upload when you publish or share, and are <strong>lost if you reload ` +
        `this page</strong> before then.`;
      sbPending.style.display = '';
    } else {
      sbPending.style.display = 'none';
    }

    // Videos the browser will not play properly once they are in the site.
    // Grouped here rather than left to the per-row marker because the fix is a
    // command that has to be read and copied, which a table cell cannot hold.
    const badVideos = [];
    for (const e of entries) {
      const r = videoCompatById.get(e.id);
      if (r && !r.ok) badVideos.push({ entry: e, result: r });
    }
    if (badVideos.length > 0) {
      const n = badVideos.length;
      const items = badVideos.map(({ entry, result }) => {
        const problems = result.problems.map((p) => `<li>${_esc(p)}</li>`).join('');
        return `<div style="margin-top:0.6rem;">`
          + `<div><strong>${_esc(entry.filename)}</strong></div>`
          + `<ul style="margin:0.2rem 0 0.35rem 1.1rem; padding:0;">${problems}</ul>`
          + `<code class="us-ffmpeg">${_esc(suggestFfmpegFix(entry.filename, result))}</code>`
          + `<div class="us-ffmpeg-note">${_esc(describeFfmpegFix(result))}</div>`
          + `</div>`;
      }).join('');
      sbVideoWarn.innerHTML =
        `<div>&#9888; <strong>${n} video${n === 1 ? '' : 's'} may not play in a browser.</strong> `
        + `${n === 1 ? 'It' : 'They'} will still upload, but anyone opening the site sees the `
        + `same problem you would. Re-encode, then remove the original from the draft and add `
        + `the new file:</div>${items}`;
      sbVideoWarn.style.display = '';
    } else {
      sbVideoWarn.style.display = 'none';
    }

    if (entries.length === 0) {
      sbEmpty.style.display = '';
      sbListWrap.style.display = 'none';
      sbCrumbs.style.display = 'none';
      sbDir = '';
      sbActions.style.display = 'none';
      publishBtn.disabled = true;
      shareBtn.disabled = true;
      return;
    }
    sbEmpty.style.display = 'none';
    sbListWrap.style.display = '';
    sbActions.style.display = 'flex';
    // Duplicate paths block both actions. Suffixing them silently, which
    // `resolvePaths` still does as a last resort, hands back a site whose
    // `index.html` has quietly become `index-1.html`: the entry point is gone
    // and the only clue is a number in a filename.
    const clashes = duplicatePaths(entries);
    hasDuplicatePaths = clashes.size > 0;
    if (hasDuplicatePaths) {
      const rows = [...clashes.entries()].map(([path, list]) =>
        `<li><code>${_esc(path)}</code> &mdash; claimed by ${list.length} entries</li>`).join('');
      sbDupWarn.innerHTML =
        `<strong>${clashes.size} duplicate path${clashes.size === 1 ? '' : 's'}.</strong> `
        + 'A site maps each path to one file, so these would shadow each other. '
        + 'Rename one of each before publishing or sharing.'
        + `<ul style="margin:0.5rem 0 0 1.1rem;">${rows}</ul>`;
      sbDupWarn.style.display = '';
    } else {
      sbDupWarn.style.display = 'none';
    }
    publishBtn.disabled = busy || hasDuplicatePaths;
    shareBtn.disabled = busy || hasDuplicatePaths;

    const resolved = resolvePaths(entries);
    // A rename or a removal can empty the folder being viewed. Climbing back
    // to the root beats leaving the reader inside a folder that no longer has
    // anything in it, with no indication of why it is blank.
    if (sbDir && !resolved.some((r) => r.path.startsWith(sbDir))) sbDir = '';
    const { dirs, files } = sbTree(resolved);
    renderCrumbs(dirs.length + files.length);
    sbList.innerHTML = sbTableHtml(dirs, files);
  }

  function sbTree(resolved) {
    return sbSplitFolder(resolved, sbDir, sbSort, statusFor);
  }


  /** The path segments of `sbDir`, as clickable steps back up. */
  function renderCrumbs(shown) {
    if (!sbDir) {
      sbCrumbs.style.display = 'none';
      sbCrumbs.innerHTML = '';
      return;
    }
    const parts = sbDir.replace(/\/$/, '').split('/');
    let acc = '';
    const steps = [`<button type="button" class="sb-crumb" data-dir="">All files</button>`];
    parts.forEach((part, i) => {
      acc += part + '/';
      const last = i === parts.length - 1;
      steps.push('<span class="sb-crumb-sep">/</span>');
      steps.push(last
        ? `<button type="button" class="sb-crumb" disabled>${_esc(part)}</button>`
        : `<button type="button" class="sb-crumb" data-dir="${_esc(acc)}">${_esc(part)}</button>`);
    });
    steps.push(`<span class="sb-crumb-count">${shown} here</span>`);
    sbCrumbs.innerHTML = steps.join('');
    sbCrumbs.style.display = 'flex';
  }

  function sbTableHtml(dirs, files) {
    const arrow = (key) => (sbSort.key === key ? (sbSort.asc ? ' \u25b2' : ' \u25bc') : '');
    let html = '<thead><tr>';
    for (const c of SB_COLUMNS) {
      html += `<th class="${c.cls}" data-sb-sort="${c.key}"`
        + ` title="Sort by ${c.label.toLowerCase()}">${c.label}${arrow(c.key)}</th>`;
    }
    html += '<th class="sb-th-act">Actions</th></tr></thead><tbody>';

    // The same `..` the site's auto-index offers, for the same reason: the
    // breadcrumb is above the list and the list is what the reader is in.
    if (sbDir) {
      const parent = sbParentDir(sbDir);
      html += `<tr class="sb-up-row" data-sb-dir="${_esc(parent)}">`
        + '<td colspan="5">..</td></tr>';
    }

    for (const d of dirs) {
      const state = d.pending === 0
        ? `<span style="color:${STATUS_STYLES.stored.color};">${STATUS_STYLES.stored.label}</span>`
        : `<span style="color:${STATUS_STYLES.pending.color};">${d.pending} not uploaded</span>`;
      html += `<tr class="sb-dir-row" data-sb-dir="${_esc(sbDir + d.name)}">
        <td class="sb-dir-name">&#128193; ${_esc(d.name)}</td>
        <td class="sb-dir-meta">${d.count} file${d.count === 1 ? '' : 's'}</td>
        <td class="sb-size">${d.bytes ? formatSize(d.bytes) : ''}</td>
        <td class="sb-status">${state}</td>
        <td class="sb-act"></td>
      </tr>`;
    }

    for (const f of files) {
      const { entry, path, name } = f;
      const s = STATUS_STYLES[statusFor(entry)] || STATUS_STYLES.pending;
      const idLabel = entry.kind === KIND_FILE
        ? '<span class="sb-local">local file</span>'
        : `<span title="${_esc(entry.id)}">${_esc(entry.id.slice(0, 4))}…${_esc(entry.id.slice(-4))}</span>`;
      // A path differing from the filename means resolvePaths de-duplicated
      // a collision, not that the user renamed anything.
      const renamed = path !== entry.filename
        ? ` <span class="sb-note">(duplicate of ${_esc(entry.filename)})</span>`
        : '';
      // Points at the file the warning above is describing; a long draft can
      // otherwise leave the reader hunting for it.
      const compat = videoCompatById.get(entry.id);
      const vwarn = compat && !compat.ok
        ? ' <span class="sb-vwarn" title="May not play back in a browser">&#9888;</span>'
        : '';
      // Only the part of the path below the current folder. The full path is
      // the cell's title, since that is what actually lands in the site.
      html += `<tr>
        <td class="sb-path" title="${_esc(path)}">${_esc(name)}${renamed}${vwarn}</td>
        <td class="sb-id">${idLabel}</td>
        <td class="sb-size">${entry.size ? formatSize(entry.size) : 'N/A'}</td>
        <td class="sb-status" style="color:${s.color};">${s.label}</td>
        <td class="sb-act">
          <button data-id="${_esc(entry.id)}" class="sb-rename">Rename</button>
          <button data-id="${_esc(entry.id)}" class="sb-remove">Remove</button>
        </td>
      </tr>`;
    }
    return html + '</tbody>';
  }

  /**
   * Record a status and, if that row is on screen, update its cell in place.
   * The map is the source of truth: a re-render reads back from it, so a
   * status set while the row is absent is not lost.
   */
  function setEntryStatus(id, state) {
    statusById.set(id, state);
    const btn = sbList.querySelector(`button.sb-rename[data-id="${CSS.escape(id)}"]`);
    const cell = btn && btn.closest('tr') && btn.closest('tr').querySelector('td.sb-status');
    if (!cell) return;
    const s = STATUS_STYLES[state] || STATUS_STYLES.pending;
    cell.style.color = s.color;
    cell.textContent = s.label;
  }

  /** Flip every row currently in `fromState` to `toState`. */
  function bulkSetStatus(fromState, toState) {
    for (const [id, state] of statusById) {
      if (state === fromState) setEntryStatus(id, toState);
    }
  }

  // --- Step 3: uploading the pending files, once, on demand ---

  /**
   * Bring `el` into view inside the panel's scroller.
   *
   * The page is tall: the progress card sits in the Site Builder step and the
   * results sit inside the action cards, both far from whatever the user just
   * clicked. Without this the work happens off-screen and the page reads as
   * frozen. `block: 'center'` rather than 'start' keeps the surrounding
   * context — the file list above the card, the buttons above a result —
   * visible alongside it.
   */
  function scrollIntoViewSafe(el) {
    if (!el) return;
    const reduced = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    } catch (_) {
      // Older engines reject the options object; the jump is still worth it.
      el.scrollIntoView();
    }
  }

  /**
   * Upload every pending local file and rewrite its draft entry to the real
   * object. A no-op when the draft is already all objects, which is what
   * makes publish-then-share (or share-then-publish) free the second time.
   *
   * Freshly pinned objects get `<uploadId>/<path>` filename metadata, where
   * `path` is the de-duplicated site path rather than the raw filename — two
   * pending files can share a name, and a shared site reads each path from
   * metadata, so pinning both under one name would lose a file. The UUID
   * prefix groups a folder's files together in My Objects, which sorts by
   * name, and every site loader strips it back off.
   */
  async function uploadPending(sdk, setStep, plannedPaths) {
    const pending = pendingFiles();
    if (pending.length === 0) return;

    const abortCtrl = new AbortController();
    currentAbort = abortCtrl;
    const untrack = trackAbort(getActiveTab(), abortCtrl);

    const started = performance.now();
    const elapsedTimer = setInterval(() => {
      cardElap.textContent = formatElapsed((performance.now() - started) / 1000);
    }, 500);

    cardRoot.textContent = rootLabel;
    cardSum.textContent =
      `${pending.length} file${pending.length === 1 ? '' : 's'} · ` +
      formatSize(pending.reduce((s, e) => s + (e.size || 0), 0));
    cardDone.textContent = '0 / ' + pending.length;
    cardElap.textContent = '0s';
    progress.max = pending.length;
    progress.value = 0;
    card.style.display = '';
    cancelBtn.style.display = '';
    // The progress card lives in the Site Builder step, well above the
    // Publish and Share buttons that start an upload, so without this the
    // work the button just kicked off happens off-screen and the page looks
    // frozen. Only reached when there is something to upload, so it never
    // yanks the page around for a no-op.
    scrollIntoViewSafe(card);

    let packed = null;
    try {
      const uploadId = crypto.randomUUID();
      const small = pending.filter((e) => (e.size || 0) < PACK_MAX_BYTES);
      const large = pending.filter((e) => (e.size || 0) >= PACK_MAX_BYTES);
      let done = 0;

      // Large files go up on their own, streaming, and first: that is the
      // slowest work, so starting it immediately means the counters move
      // while it runs instead of after it.
      for (const entry of large) {
        if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const path = plannedPaths.get(entry.id) || entry.filename;
        setEntryStatus(entry.id, 'uploading');
        const pinned = new PinnedObject();
        pinned.updateMetadata(encodeMetadata({ filename: `${uploadId}/${path}` }));

        // Show how far through the file we are, rather than a static line for
        // however many minutes it takes. The bar switches to bytes for the
        // duration, since "0 of 7 files" cannot move until this one finishes.
        const total = entry.size || 0;
        const startedAt = performance.now();
        progress.max = total || 1;
        progress.value = 0;
        const report = (n, finished) => {
          progress.value = Math.min(n, progress.max);
          const pct = total ? Math.floor((n / total) * 100) : 0;
          cardCur.textContent = finished
            ? `Finishing ${path} — ${formatSize(total)} read, waiting on hosts…`
            : `Uploading ${path} on its own (too large to pack) — ${formatSize(n)}`
              + ` of ${formatSize(total)} read, ${pct}%`
              + progressDetail(n, total, startedAt);
          setStep(cardCur.textContent);
        };
        report(0, false);
        const obj = await Promise.race([
          sdk.upload(pinned, countingStream(entry.file, report)),
          abortPromise(abortCtrl.signal),
        ]);
        // Back to counting files for the packed phase that follows.
        progress.max = pending.length;
        setEntryStatus(entry.id, 'pinning');
        await sdk.pinObject(obj);
        const realId = obj.id();
        statusById.delete(entry.id);
        statusById.set(realId, 'done');
        materializeEntry(entry.id, { id: realId, size: entry.size });
        done += 1;
        cardDone.textContent = done + ' / ' + pending.length;
        progress.value = done;
      }

      if (small.length === 0) {
        cardCur.textContent = 'Upload complete';
        return;
      }

      setStep('Packing files into shared slabs…');
      packed = sdk.uploadPacked(uploadOptions(getMaxUploads()));

      // packed.add() only buffers bytes into slabs — the network upload
      // happens in finalize(), so the files-done counter does not advance
      // here. finalize() returns PinnedObjects in add() order, so the
      // `small` array indexes the results.
      for (let i = 0; i < small.length; i++) {
        if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const entry = small[i];
        // Name the phase as well as the file: while this is slow, the phase
        // is the part that explains why nothing is moving yet.
        setEntryStatus(entry.id, 'packing');
        const packStart = performance.now();
        const packTotal = entry.size || 0;
        const packReport = (n) => {
          cardCur.textContent =
            `Packing files into shared slabs — ${entry.filename}`
            + ` (${formatSize(n)} of ${formatSize(packTotal)} read)`
            + ` — ${i + 1} / ${small.length}`
            + progressDetail(n, packTotal, packStart);
        };
        packReport(0);
        await Promise.race([
          packed.add(countingStream(entry.file, packReport)),
          abortPromise(abortCtrl.signal),
        ]);
      }

      if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');

      // finalize() actually uploads the slabs to hosts — the slow part.
      // There are no per-byte callbacks, so the bar goes indeterminate,
      // and every packed row flips to "uploading" at once because the
      // unit of work is a slab, not a file.
      const slabCount = typeof packed.slabs === 'function' ? packed.slabs() : packed.slabs;
      cardCur.textContent = `Uploading ${slabCount} slab${slabCount === 1 ? '' : 's'} to hosts…`;
      setStep(`Uploading ${slabCount} slab${slabCount === 1 ? '' : 's'} to hosts…`);
      progress.removeAttribute('value');
      bulkSetStatus('packing', 'uploading');
      const objects = await Promise.race([
        packed.finalize(),
        abortPromise(abortCtrl.signal),
      ]);
      packed = null;
      progress.value = 0;

      if (objects.length !== small.length) {
        throw new Error(
          `packed upload returned ${objects.length} objects, expected ${small.length}`,
        );
      }

      // Pin each object so it survives the indexer's GC. `updateMetadata`
      // is a local mutation on the handle; `pinObject` then seals object
      // and slabs together in one commit. There is deliberately no
      // `updateObjectMetadata` call here — that endpoint needs an
      // already-pinned object and fails with "object contains unpinned
      // slab" on a first pin.
      for (let i = 0; i < objects.length; i++) {
        if (abortCtrl.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const entry = small[i];
        const path = plannedPaths.get(entry.id) || entry.filename;
        cardCur.textContent = `Pinning ${path}`;
        setStep(`Pinning ${i + 1} / ${objects.length}…`);
        setEntryStatus(entry.id, 'pinning');
        objects[i].updateMetadata(
          encodeMetadata({ filename: `${uploadId}/${path}` }),
        );
        await sdk.pinObject(objects[i]);
        const realId = objects[i].id();
        // Carry the status across to the new ID before the draft change
        // re-renders the table under us.
        statusById.delete(entry.id);
        statusById.set(realId, 'done');
        materializeEntry(entry.id, { id: realId, size: entry.size });
        done += 1;
        cardDone.textContent = done + ' / ' + pending.length;
        progress.value = done;
      }
      cardCur.textContent = 'Upload complete';
    } catch (e) {
      // Anything still in flight is broken; rows already done stay done.
      bulkSetStatus('packing', 'failed');
      bulkSetStatus('uploading', 'failed');
      bulkSetStatus('pinning', 'failed');
      if (packed) {
        try { packed.cancel(); } catch (_) {}
      }
      cardCur.textContent = abortCtrl.signal.aborted ? 'Cancelled' : 'Failed';
      throw e;
    } finally {
      clearInterval(elapsedTimer);
      cancelBtn.style.display = 'none';
      untrack();
      if (currentAbort === abortCtrl) currentAbort = null;
    }
  }

  /**
   * Make `obj`'s filename metadata match the path it should have in a
   * shared site, and report whether a write was needed.
   *
   * Only sharing needs this. A published site carries its paths in the
   * manifest, but a shared site has no manifest — the loader reads each
   * path from the object's own metadata — so a rename in the builder has to
   * reach the object or it would be served under its old name. The write is
   * skipped when the name already agrees, which is the common case, since
   * My Objects seeds a draft entry's name from that same metadata.
   */
  async function applyPath(sdk, obj, path) {
    const full = filenameForDisplay(obj.metadata());
    if (stripUploadUuid(full) === path) return false;
    // Keep any existing upload-UUID grouping prefix so the object does not
    // jump around in My Objects just because it was renamed.
    const uuid = extractUploadUuid(full);
    // Carry the site name through. `encodeMetadata` writes exactly the fields
    // it is handed, so renaming with filename alone dropped it — the same way
    // My Objects' own Rename used to.
    const existingSiteName = siteNameForDisplay(obj.metadata());
    obj.updateMetadata(encodeMetadata({
      filename: uuid ? `${uuid}/${path}` : path,
      siteName: existingSiteName,
    }));
    await sdk.updateObjectMetadata(obj);
    return true;
  }

  /** Runs one action end to end, with shared progress/lock/error handling. */
  /** The site's name as typed, trimmed. Empty means unnamed. */
  function siteName() {
    return (siteNameEl && siteNameEl.value.trim()) || '';
  }

  /** The action running now, and one the user asked for while it was. */
  let activeKind = null;
  let queuedAction = null;

  async function runAction(kind, progressEl, body) {
    if (busy) {
      // The two actions cannot overlap: both upload the draft's pending files
      // and rewrite those entries in place as they become real objects, and
      // sharing additionally renames files on Sia. Running them at once would
      // upload the same bytes twice and interleave those rewrites.
      //
      // But the click is intent, not a mistake, and users reasonably want both
      // a link and a key. So it is remembered rather than dropped — the second
      // run is cheap, because the first has already uploaded everything.
      if (kind !== activeKind) {
        queuedAction = { kind, progressEl, body };
        progressEl.style.display = '';
        progressEl.innerHTML = `<span class="muted">Queued — starts when ${
          activeKind === 'publish' ? 'publishing' : 'sharing'} finishes.</span>`;
      }
      return;
    }
    const entries = getDraft();
    if (entries.length === 0) {
      progressEl.style.display = '';
      progressEl.innerHTML = '<span class="fail">Add files to the site builder first.</span>';
      return;
    }
    // Re-checked here, not just on the button: the draft can change from
    // elsewhere — My Objects' "Add to site" — between a render and a click.
    const clashing = duplicatePaths(entries);
    if (clashing.size > 0) {
      const first = [...clashing.keys()].slice(0, 3).join(', ');
      progressEl.style.display = '';
      progressEl.innerHTML = `<span class="fail">Two or more files claim the same path (${
        _esc(first)}${clashing.size > 3 ? ', &hellip;' : ''}). Rename one of each before continuing.</span>`;
      return;
    }
    busy = true;
    activeKind = kind;
    clearResults(kind);
    publishBtn.disabled = true;
    shareBtn.disabled = true;
    const btn = kind === 'publish' ? publishBtn : shareBtn;
    const label = btn.textContent;
    btn.textContent = kind === 'publish' ? 'Publishing…' : 'Sharing…';

    const started = performance.now();
    let note = 'Connecting to indexer…';
    const tick = setInterval(() => {
      progressEl.textContent = `${note} · ${Math.round((performance.now() - started) / 1000)}s`;
    }, 500);
    const setStep = (text) => {
      note = text;
      panelStatus().textContent = text;
      progressEl.textContent = `${text} · ${Math.round((performance.now() - started) / 1000)}s`;
    };

    progressEl.style.display = '';
    setStep('Connecting to indexer…');
    await withKeepAlive(async () => {
      try {
        const sdk = await connectSdk(panelStatus());
        if (!sdk) {
          // Re-gate so the page explains the problem and offers the fix,
          // instead of leaving a bare failure line under the button.
          refreshGate();
          const problem = configProblem();
          throw new Error(
            (problem && problem.reason)
            || getLastConnectError()
            || 'Could not connect to the indexer.',
          );
        }
        // Resolve paths before uploading so the metadata written at pin time
        // matches the path the manifest will use. Materialising entries does
        // not reorder the draft, so re-resolving afterwards agrees.
        const planned = new Map(
          resolvePaths(getDraft()).map(({ entry, path }) => [entry.id, path]),
        );
        // Also scan now, while the local File handles are still around —
        // uploading replaces them with object IDs.
        const embeddedIds = await collectEmbeddedIds(getDraft());
        await uploadPending(sdk, setStep, planned);
        // Re-read: uploadPending rewrote pending entries to real objects.
        const done = await body(sdk, resolvePaths(getDraft()), setStep, embeddedIds);
        const secs = Math.round((performance.now() - started) / 1000);
        progressEl.innerHTML = `<span class="pass">✓ ${_esc(done)} in ${secs}s</span>`;
        // The result card was hidden until now, so it could not have been
        // scrolled to earlier; and an upload will have moved the view up to
        // the progress card, leaving the link the user came for off-screen.
        scrollIntoViewSafe(kind === 'publish' ? publishRes : shareRes);
        panelStatus().innerHTML = `<span class="pass">${_esc(done)} in ${secs}s</span>`;
      } catch (e) {
        const cancelled = e && e.name === 'AbortError';
        const msg = cancelled ? 'Cancelled' : (e.message || String(e));
        progressEl.innerHTML = `<span class="fail">✗ ${_esc(msg)}</span>`;
        panelStatus().innerHTML = `<span class="fail">${_esc(msg)}</span>`;
      } finally {
        clearInterval(tick);
        busy = false;
        activeKind = null;
        btn.textContent = label;
        renderSiteBuilder();
      }
    });

    // Dispatched out here rather than from the `finally` so the queued run does
    // not nest inside this one's keep-alive scope.
    const next = queuedAction;
    queuedAction = null;
    if (next) await runAction(next.kind, next.progressEl, next.body);
  }

  // --- Publish ---

  function publishValidUntil() {
    const durMs = parseFloat(validityNum.value) * parseInt(validityUnit.value, 10);
    if (!isFinite(durMs) || durMs <= 0) throw new Error('Invalid publish validity.');
    return new Date(Date.now() + durMs);
  }

  publishBtn.addEventListener('click', () => {
    let validUntil;
    try {
      validUntil = publishValidUntil();
    } catch (e) {
      publishProg.style.display = '';
      publishProg.innerHTML = `<span class="fail">${_esc(e.message)}</span>`;
      return;
    }
    runAction('publish', publishProg, async (sdk, resolved, setStep) => {
      // Manifest values are signed `sia://` URLs rather than bare object
      // IDs, so the site resolves from any account and not just this one.
      const manifest = {};
      for (let i = 0; i < resolved.length; i++) {
        const { entry, path } = resolved[i];
        setStep(`Signing ${path} (${i + 1}/${resolved.length})…`);
        const obj = await sdk.object(entry.id);
        manifest[path] = sdk.objectShareUrl(obj, validUntil);
      }

      // The manifest cannot go through the packed handle above because its
      // bytes depend on the object IDs we just learned. It is tiny, so a
      // one-off upload is fine.
      setStep('Uploading manifest…');
      const uploadId = crypto.randomUUID();
      const manifestJson = JSON.stringify(buildSiaSiteManifest(manifest, siteName()), null, 2);
      const manifestBlob = new Blob([new TextEncoder().encode(manifestJson)]);
      const manifestPinned = new PinnedObject();
      // The filename convention stays exactly as it was, because that is what
      // marks an object as a site manifest everywhere else. The name rides
      // alongside it so My Objects can label the row without fetching and
      // parsing the manifest for every entry.
      manifestPinned.updateMetadata(
        encodeMetadata({ filename: `${uploadId}/manifest.json`, siteName: siteName() }),
      );
      const manifestObj = await sdk.upload(manifestPinned, manifestBlob.stream());
      setStep('Pinning manifest…');
      await sdk.pinObject(manifestObj);

      const siaPublishUrl = sdk.objectShareUrl(manifestObj, validUntil);
      const siteAddress = 'sialo://' + siaPublishUrl.replace(/^sia:\/\//, '');
      resultId.textContent = manifestObj.id();
      resultUrl.textContent = siteAddress;
      // The same address wrapped as an app link, so it can be handed out and
      // opened rather than pasted into the address bar.
      resultLink.textContent = publishedSiteLink(siteAddress);
      publishRes.style.display = '';
      return 'Site published';
    });
  });

  makeOpenable(resultUrl);

  openBtn.addEventListener('click', () => openUrlInNewTab(resultUrl.textContent));

  copyBtn.addEventListener('click', async () => {
    const url = resultUrl.textContent.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1200);
    } catch (_) {}
  });

  copyLinkBtn.addEventListener('click', async () => {
    const link = resultLink.textContent.trim();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => { copyLinkBtn.textContent = 'Copy link'; }, 1200);
    } catch (_) {}
  });

  // --- Share ---

  /** The sharing key's expiry, or null for a key that never expires. */
  function shareExpiresAt() {
    const unitMs = parseInt(shareValUnit.value, 10);
    if (!unitMs) return null; // "never"
    const durMs = parseFloat(shareValNum.value) * unitMs;
    if (!isFinite(durMs) || durMs <= 0) throw new Error('Invalid share expiry.');
    return new Date(Date.now() + durMs);
  }

  shareBtn.addEventListener('click', () => {
    let expiresAt;
    try {
      expiresAt = shareExpiresAt();
    } catch (e) {
      shareProg.style.display = '';
      shareProg.innerHTML = `<span class="fail">${_esc(e.message)}</span>`;
      return;
    }
    runAction('share', shareProg, async (sdk, resolved, setStep, embeddedIds) => {
      // The site name is the key's label. Asking for a separate description
      // was asking the same question twice: both name the same set of files,
      // and a key called something other than the site it grants access to is
      // harder to recognise on the Sharing Keys page, not easier.
      //
      // sanitizeDisplayFilename is the repo's text sanitizer: it strips
      // invisible and control characters and caps length, which is what
      // free text heading for a key label needs too.
      // Capped the same as the manifest's own `name`, so the key label and the
      // site title cannot diverge for a long name.
      const named = sanitizeDisplayFilename(siteName()).trim().slice(0, MANIFEST_NAME_MAX);
      const description = named || siteDescription(resolved.length);
      setStep('Creating sharing key…');
      const key = await sdk.createSharingKey(description, expiresAt);

      let renamed = 0;
      for (let i = 0; i < resolved.length; i++) {
        const { entry, path } = resolved[i];
        setStep(`Attaching ${path} (${i + 1}/${resolved.length})…`);
        const obj = await sdk.object(entry.id);
        if (await applyPath(sdk, obj, path)) renamed++;
        await sdk.shareObject(key, obj);
      }

      // Attach anything the site's HTML embeds by published URL. Without this
      // the page loads for a recipient with no account but its media does not,
      // because a published URL needs the viewer's own account to resolve.
      // Skip objects already attached above as site files.
      let extra = 0;
      let shadowed = 0;
      const own = new Set(resolved.map(({ entry }) => String(entry.id).toLowerCase()));
      // The site's own paths, to compare an embedded object's name against.
      // These attachments are the one place a path is not chosen by the
      // builder: the object keeps whatever name it already had, and the loader
      // keys on that same stripped name. An embedded object called
      // `index.html` would shadow the site's own, in an order nothing
      // guarantees.
      const sitePaths = new Set(resolved.map(({ path }) => path));
      for (const id of (embeddedIds || [])) {
        if (own.has(id)) continue;
        setStep(`Attaching embedded object ${id.slice(0, 12)}…`);
        try {
          const obj = await sdk.object(id);
          const embeddedPath = stripUploadUuid(filenameForDisplay(obj.metadata()) || '')
            .replace(/^\/+/, '');
          if (embeddedPath && sitePaths.has(embeddedPath)) {
            // Left unattached rather than renamed: this object belongs to
            // other arrangements too, and renaming it to make room here would
            // move it in those as well.
            shadowed += 1;
            panelStatus().textContent =
              `Skipped embedded object ${id.slice(0, 12)}…: its name "${embeddedPath}" `
              + 'is already a file in this site.';
            continue;
          }
          await sdk.shareObject(key, obj);
          extra += 1;
        } catch (err) {
          // Most likely not this account's object (someone else's published
          // URL), which cannot be attached and will need the viewer's own
          // account. Not fatal: the rest of the site still works.
          panelStatus().textContent =
            `Could not attach embedded object ${id.slice(0, 12)}…: ${err.message || err}`;
        }
      }

      shareKeyEl.textContent = key.publicKey;
      shareUrlEl.textContent = siteLink(key.seed());
      shareRes.style.display = '';
      const notes = [];
      if (renamed > 0) notes.push(`${renamed} file${renamed === 1 ? '' : 's'} renamed on Sia`);
      if (extra > 0) notes.push(`${extra} embedded object${extra === 1 ? '' : 's'} attached`);
      if (shadowed > 0) {
        notes.push(`${shadowed} embedded object${shadowed === 1 ? '' : 's'} skipped, name already taken`);
      }
      return notes.length ? `Site shared (${notes.join(', ')})` : 'Site shared';
    });
  });

  shareCopyBtn.addEventListener('click', async () => {
    const url = shareUrlEl.textContent.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      shareCopyBtn.textContent = 'Copied!';
      setTimeout(() => { shareCopyBtn.textContent = 'Copy share link'; }, 1200);
    } catch (_) {}
  });

  shareOpenBtn.addEventListener('click', () => {
    const url = shareUrlEl.textContent.trim();
    if (!url) return;
    // An app URL with a fragment: let the browser follow it the way a
    // recipient would rather than shortcutting to the loader.
    location.href = url;
  });

  // --- Wiring ---

  // The zone deliberately has no click handler of its own. It offers two
  // different pickers, so a click on empty zone area has no single right
  // answer, and silently choosing the folder one is a trap: the OS then greys
  // out every individual file, which reads as the app being broken. Dropping
  // still works anywhere on the zone; clicking is the buttons' job.

  /** Reset first, so picking the same folder or file twice still fires `change`. */
  function openPicker(input) {
    input.value = '';
    input.click();
  }
  pickFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker(dirInput);
  });
  pickFilesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker(filesInput);
  });
  dirInput.addEventListener('change', () => {
    if (dirInput.files && dirInput.files.length) addFiles(dirInput.files);
  });
  filesInput.addEventListener('change', () => {
    if (filesInput.files && filesInput.files.length) addFiles(filesInput.files);
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;
    // Recursively walk each dropped entry to collect File objects.
    const collected = [];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        await new Promise((resolve) => {
          entry.file((f) => {
            // Synthesise webkitRelativePath so the rest of the code is
            // consistent between drag-drop and file-picker inputs.
            Object.defineProperty(f, 'webkitRelativePath', { value: prefix + entry.name });
            collected.push(f);
            resolve();
          });
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const kids = await new Promise((resolve) => reader.readEntries(resolve));
        for (const k of kids) await walk(k, prefix + entry.name + '/');
      }
    }
    for (const it of items) {
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry) await walk(entry, '');
    }
    if (collected.length === 0) {
      panelStatus().innerHTML = '<span class="fail">Nothing usable in that drop.</span>';
      return;
    }
    addFiles(collected);
  });

  cancelBtn.addEventListener('click', () => {
    if (currentAbort) currentAbort.abort();
  });

  // Rename (draft-only for a published site; written through to the
  // object's metadata when the site is shared) and remove, delegated on
  // the table so nothing needs rebinding on re-render.
  sbList.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;

    const th = t.closest('th[data-sb-sort]');
    if (th) {
      const key = th.dataset.sbSort;
      if (sbSort.key === key) sbSort.asc = !sbSort.asc;
      else sbSort = { key, asc: true };
      renderSiteBuilder();
      return;
    }

    // Whole-row targets, so navigating does not depend on hitting the name.
    const nav = t.closest('[data-sb-dir]');
    if (nav) {
      sbDir = nav.dataset.sbDir;
      renderSiteBuilder();
      return;
    }

    const id = t.dataset.id;
    if (!id) return;
    if (t.classList.contains('sb-rename')) {
      const entry = getDraft().find((e) => e.id === id);
      if (!entry) return;
      const raw = prompt('Path in this site:', entry.filename);
      if (raw === null) return;
      // A site path keeps its slashes: `sanitizeFilename` would flatten
      // `assets/app.js` to `assets_app.js` and silently break the site's
      // structure. Leading slashes go, so paths stay site-relative.
      const clean = sanitizeDisplayFilename(raw).trim().replace(/^\/+/, '');
      if (!clean) {
        panelStatus().innerHTML = '<span class="fail">Path is empty or invalid.</span>';
        return;
      }
      updateDraftFilename(id, clean);
    } else if (t.classList.contains('sb-remove')) {
      statusById.delete(id);
      videoCompatById.delete(id);
      removeFromDraft(id);
    }
  });

  sbCrumbs.addEventListener('click', (ev) => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest('.sb-crumb') : null;
    if (!btn || btn.disabled) return;
    sbDir = btn.dataset.dir || '';
    renderSiteBuilder();
  });

  sbClearBtn.addEventListener('click', () => {
    const pending = pendingFiles().length;
    const warn = pending > 0
      ? `Clear the draft? ${pending} file${pending === 1 ? '' : 's'} have not been uploaded and will be lost.`
      : 'Clear all entries from the site builder draft?';
    if (!confirm(warn)) return;
    statusById.clear();
    videoCompatById.clear();
    card.style.display = 'none';
    clearResults();
    clearDraft();
  });

  // A draft with pending files must not be silently dropped on navigation.
  window.addEventListener('beforeunload', (e) => {
    if (pendingFiles().length === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // --- Connection gate ---
  //
  // Every outcome on this page ends in an upload, so the page is unusable
  // without a working indexer connection. Gating up front beats letting
  // someone stage a whole site and only discover the problem when they hit
  // publish — by which point a dropped folder's Files are the only copy of
  // the arrangement they just made.

  const gate = document.getElementById('us-gate');
  const gateReason = document.getElementById('us-gate-reason');
  const gateSettings = document.getElementById('us-gate-settings');
  const gateRetry = document.getElementById('us-gate-retry');
  const gateRegister = document.getElementById('us-gate-register');
  const updateSection = document.getElementById('us-section-update');
  const steps = () => document.querySelectorAll('#panel-upload-site .us-step');

  function setGated(on, reason, canRegister) {
    gate.style.display = on ? '' : 'none';
    if (on) gateReason.textContent = reason || 'Not connected to an indexer.';
    // Registering is the fix for having no app key, and it is a different
    // action from correcting a URL, so it is only offered when it is
    // actually the answer.
    gateRegister.style.display = on && canRegister ? '' : 'none';
    for (const el of steps()) el.style.display = on ? 'none' : '';
    if (updateSection) updateSection.style.display = on ? 'none' : '';
  }

  /**
   * Why the indexer cannot be used, decided from configuration alone, or null
   * when there is nothing obviously wrong and it is worth dialling.
   *
   * Having no app key is not a connection failure — there is nothing to
   * connect with — so it must not be reported as one. The fix is to register,
   * which is a different action from correcting a bad URL.
   */
  function configProblem() {
    const url = getUrl();
    const key = getKeyHex();
    if (!key) {
      return {
        reason: url
          ? 'You do not have an app key yet. Register or log in with this indexer to get one.'
          : 'This browser has no indexer account yet. Register or log in to get started.',
        register: true,
      };
    }
    if (!url) return { reason: 'No indexer URL is configured.', register: false };
    return null;
  }

  /**
   * Re-evaluate the gate. Configuration is checked first because it is
   * synchronous and is the common case for a new account; only a configured
   * indexer is actually dialled, and that call caches its SDK, so repeat
   * checks after a success are free.
   */
  let checking = false;
  async function refreshGate() {
    if (checking) return;
    const problem = configProblem();
    if (problem) {
      setGated(true, problem.reason, problem.register);
      return;
    }
    checking = true;
    gateRetry.disabled = true;
    const previously = gate.style.display !== 'none';
    if (previously) gateReason.textContent = 'Checking connection…';
    try {
      // A throwaway status sink: connectSdk writes progress into whatever it
      // is handed, and the gate must not scribble over the tab's status bar.
      const sink = document.createElement('div');
      const sdk = await connectSdk(sink);
      if (sdk) {
        setGated(false);
      } else {
        // The indexer answered but rejected the key ("App key not recognized
        // by this indexer. Register first."), which registering also fixes.
        const err = getLastConnectError() || 'Could not reach the indexer.';
        setGated(true, err, /register/i.test(err));
      }
    } catch (e) {
      // connectSdk reports its own known failures through getLastConnectError,
      // and those read as instructions. Anything thrown past it is internal
      // (a WASM binding, a coding error) and its message means nothing to the
      // reader, so it goes to the console rather than into the page.
      console.error('[upload-site] connection check failed:', e);
      setGated(true, 'Could not reach the indexer.', false);
    } finally {
      checking = false;
      gateRetry.disabled = false;
    }
  }

  gateRetry.addEventListener('click', refreshGate);
  gateRegister.addEventListener('click', () => openOrActivateInternalTab('register'));
  gateSettings.addEventListener('click', () => openOrActivateInternalTab('setup'));

  // Re-check whenever this panel comes into view: the user may have gone to
  // settings and fixed the connection in between.
  window.addEventListener('panel-activated', (e) => {
    if (e.detail && e.detail.panel === 'upload-site') refreshGate();
  });

  renderSiteBuilder();
  onDraftChange(() => {
    // Not while an action is running: sharing renames files on Sia, which
    // mutates the draft, and clearing here would erase the result the action is
    // about to display.
    if (!busy) clearResults();
    renderSiteBuilder();
  });
  refreshGate();
}

// Rejects when the signal aborts — lets us Promise.race against
// sdk.upload() / packed.add() / packed.finalize() to break out of a
// hanging call immediately.
function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new DOMException('cancelled', 'AbortError')); return; }
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  });
}
