// Standalone recipient page for sharing keys.
//
// This is deliberately independent of the main app: it boots the storage WASM
// module, reads a sharing key out of the URL fragment, and downloads through
// `SharedSdk`. It holds no account and stores no credential, so it can be
// served from any static host.
//
// The fragment never reaches that host, which is the point of carrying the key
// there rather than in the path or query. The indexer URL is separate on
// purpose: taking it from the link would let a hostile link aim this page's
// SDK at a server of its choosing, so it comes from a field the reader
// controls, remembered locally between visits.

import init, { SharedSdk } from './pkg/sia_storage_wasm.js';
import {
  filenameForSave, filenameForDisplay, stripUploadUuid,
} from './object-metadata.js';

const DEFAULT_INDEXER = 'https://storage.sia.dev';
const INDEXER_STORAGE_KEY = 'share-indexer-url';
const SHARE_PARAM = 'sharing_key';
const OBJECT_PARAM = 'object';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function extractSeed(input) {
  const raw = String(input || '').trim();
  const fromLink = raw.match(/[#&]sharing_key=([0-9a-f]{64})/i);
  const seed = fromLink ? fromLink[1] : raw;
  return /^[0-9a-f]{64}$/i.test(seed) ? seed.toLowerCase() : null;
}

function readFragment() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const seed = extractSeed(params.get(SHARE_PARAM) || '');
  if (!seed) return null;
  const objectId = (params.get(OBJECT_PARAM) || '').trim();
  return { seed, objectId: /^[0-9a-f]{64}$/i.test(objectId) ? objectId.toLowerCase() : null };
}

function setSub(text, isError) {
  const el = $('sub');
  el.textContent = text;
  el.style.color = isError ? '#f87171' : '#888';
}

function showSetup(seed) {
  $('setup').style.display = '';
  $('indexer').value = localStorage.getItem(INDEXER_STORAGE_KEY) || DEFAULT_INDEXER;
  if (seed) $('seed').value = seed;
}

async function listObjects(sdk) {
  const PAGE = 100;
  const objects = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sdk.objects(offset, PAGE);
    objects.push(...page);
    if (page.length < PAGE) break;
  }
  return objects;
}

async function download(sdk, obj, button) {
  const original = button.textContent;
  const progress = $('progress');
  button.disabled = true;
  button.textContent = 'Downloading...';
  progress.style.display = '';
  progress.max = Number(obj.size()) || 0;
  progress.value = 0;
  try {
    const parts = [];
    const reader = sdk.download(obj).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      progress.value += value.byteLength;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(parts));
    a.download = filenameForSave(obj.metadata()) || obj.id().slice(0, 16);
    a.click();
    URL.revokeObjectURL(a.href);
    button.textContent = 'Saved';
  } catch (e) {
    button.textContent = original;
    alert(`Download failed: ${e.message || e}`);
  } finally {
    button.disabled = false;
    progress.style.display = 'none';
    setTimeout(() => { button.textContent = original; }, 2000);
  }
}

/**
 * The app link that renders this key's files as a site.
 *
 * This page lists files; it has no sandboxed iframe and cannot render a site.
 * The two are different links for the same key — `share.html#sharing_key=…`
 * lists, `../#sharing_key=…&site=1` renders — and handing someone the listing
 * link for something that is actually a website leaves them looking at raw
 * filenames wondering why nothing happened. Built inline rather than imported
 * from sharing-keys.js, which pulls in config.js and its DOM.
 */
function siteViewLink(seed) {
  const app = new URL('.', location.href).href.replace(/#.*$/, '');
  // `from=list` tells the app it was entered from this page, so it can offer a
  // way back. Browser Back is unreliable here: a site's iframe shares joint
  // session history with the parent, so its own page loads occupy the history
  // stack and Back walks through those first, looking like it does nothing.
  return `${app}#sharing_key=${encodeURIComponent(seed)}&site=1&from=list`;
}

function render(sdk, objects, highlightId, seed) {
  const list = $('list');
  list.style.display = '';
  list.innerHTML = '';
  if (!objects.length) {
    list.innerHTML = '<div class="note">This key has no objects attached.</div>';
    return;
  }
  // A key holding an index.html is a website, not a pile of files. Say so, and
  // link to the view that actually renders it.
  const hasIndex = objects.some((o) => {
    const p = stripUploadUuid(filenameForDisplay(o.metadata()) || '');
    return /^index\.x?html?$/i.test(p);
  });
  if (hasIndex && seed) {
    const banner = document.createElement('div');
    banner.className = 'site-banner';
    banner.innerHTML =
      '<div><strong>This share is a website.</strong> This page only lists its files.</div>'
      + `<a class="site-banner-open" href="${esc(siteViewLink(seed))}">Open as a site</a>`;
    list.appendChild(banner);
  }

  for (const obj of objects) {
    const id = obj.id();
    const full = filenameForDisplay(obj.metadata()) || id.slice(0, 16);
    // Drop the per-upload grouping prefix. It exists so a folder's files sort
    // together in the owner's object list and means nothing to a recipient —
    // showing it makes every name look like a hash they must decode.
    const name = stripUploadUuid(full) || full;
    const row = document.createElement('div');
    row.className = 'row';
    if (id === highlightId) row.style.background = '#0d1f17';
    row.innerHTML = `
      <div style="min-width:0;">
        <div class="name" title="${esc(full)}">${esc(name)}</div>
        <div class="meta">${esc(id.slice(0, 8))}...${esc(id.slice(-8))} &middot; ${esc(formatSize(obj.size()))}</div>
      </div>
      <button>Download</button>
    `;
    const button = row.querySelector('button');
    button.addEventListener('click', () => download(sdk, obj, button));
    list.appendChild(row);
  }
}

async function openShare(seed, objectId, indexerUrl) {
  setSub('Connecting...');
  $('list').style.display = 'none';
  localStorage.setItem(INDEXER_STORAGE_KEY, indexerUrl);
  let sdk;
  try {
    sdk = await SharedSdk.connect(indexerUrl, seed);
  } catch (e) {
    setSub(`Could not open this share: ${e.message || e}`, true);
    showSetup(seed);
    return;
  }
  try {
    const stats = await sdk.stats();
    const expires = stats.expiresAt ? stats.expiresAt.toLocaleString() : 'never';
    setSub(`${Number(stats.objectCount)} object(s), ${formatSize(stats.objectSize)}, expires ${expires}`);
  } catch (_) {
    setSub('Connected.');
  }
  try {
    const objects = await listObjects(sdk);
    render(sdk, objects, objectId, seed);
  } catch (e) {
    setSub(`Could not list the shared objects: ${e.message || e}`, true);
  }
}

await init();

const fragment = readFragment();
const storedIndexer = localStorage.getItem(INDEXER_STORAGE_KEY) || DEFAULT_INDEXER;

$('open').addEventListener('click', () => {
  const seed = extractSeed($('seed').value);
  const indexerUrl = $('indexer').value.trim();
  if (!seed) { alert('Paste the sharing link you were sent, or its 64 hex character seed.'); return; }
  if (!indexerUrl) { alert('Enter the indexer URL that hosts this share.'); return; }
  openShare(seed, null, indexerUrl);
});

if (fragment) {
  openShare(fragment.seed, fragment.objectId, storedIndexer);
} else {
  setSub('Paste the sharing link you were sent.');
  showSetup(null);
}
