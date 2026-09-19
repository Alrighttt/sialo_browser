// Sharing keys: revocable, multi-object credentials the owner pays for.
//
// This is the newer of the app's two sharing mechanisms and is not the same
// thing as a published URL. A published URL (see `shareObjectById` in objects-ui.js)
// is a signed link carrying the object's encryption key in its fragment; it
// covers one object, expires when its signature does, cannot be withdrawn,
// and the recipient downloads on their own account. A sharing key is a
// credential held by the recipient: it covers as many objects as you attach
// to it, it can be revoked at any time, and its downloads are billed to you.
//
// The credential is the key's 32 byte seed, which the SDK derives
// deterministically from the account's app key. That means a key's seed can
// be re-derived from a listing at any time, so a recipient link is never
// show-once and this module can always rebuild one.

import { _esc, formatSize } from './utils.js';
import { connectSdk, listOwnedSharedObjects} from './config.js';
import { SharingKey } from './pkg/sia_storage_wasm.js';
import { filenameForDisplay } from './object-metadata.js';
import { siteUrl } from './sia-site.js';
import { tabStatusProxy, getActiveTab } from './tabs.js';

// The fragment a recipient link carries. The indexer URL is deliberately not
// part of it: a link is an untrusted string, and letting it name the server
// would let a hostile one repoint the reader's SDK. Both readers (the Shared
// panel and share.html) supply their own indexer.
export const SHARE_PARAM = 'sharing_key';
export const OBJECT_PARAM = 'object';
// Marks a link as a site rather than a file listing, with an optional path
// inside it. A site needs the app's sandboxed iframe to render, so these
// links point at the app, not at the standalone share page.
export const SITE_PARAM = 'site';
export const PATH_PARAM = 'path';

/** Builds the fragment for a recipient link, without the leading `#`. */
export function shareFragment(seedHex, objectId) {
  const parts = [`${SHARE_PARAM}=${seedHex}`];
  if (objectId) parts.push(`${OBJECT_PARAM}=${objectId}`);
  return parts.join('&');
}

/**
 * Parses a recipient fragment. Accepts it with or without the leading `#`, so
 * `location.hash` can be passed straight in. Returns null when the fragment
 * does not carry a sharing key, which is the common case on a normal page load.
 */
export function parseShareFragment(fragment) {
  if (!fragment) return null;
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const seed = (params.get(SHARE_PARAM) || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(seed)) return null;
  const objectId = (params.get(OBJECT_PARAM) || '').trim();
  // A path is site-relative and arrives percent-decoded by URLSearchParams.
  // Leading slashes are stripped so it always reads as relative to the root.
  const path = (params.get(PATH_PARAM) || '').replace(/^\/+/, '');
  return {
    seed,
    objectId: /^[0-9a-f]{64}$/i.test(objectId) ? objectId : null,
    site: params.get(SITE_PARAM) === '1',
    path: path || null,
  };
}

/** The fragment for a site link, without the leading `#`. */
export function siteFragment(seedHex, path) {
  const parts = [`${SHARE_PARAM}=${seedHex}`, `${SITE_PARAM}=1`];
  const rest = (path || '').replace(/^\/+/, '');
  if (rest) parts.push(`${PATH_PARAM}=${encodeURIComponent(rest)}`);
  return parts.join('&');
}

/**
 * A link that loads a key-backed site directly. It points at the app rather
 * than share.html, because rendering a site needs the sandboxed iframe and
 * service worker that only the app sets up. Defaults to the directory this
 * page is served from, so the result is the shortest URL that still works.
 */
export function siteLink(seedHex, path, base) {
  const page = (base || new URL('.', location.href).href).replace(/#.*$/, '');
  return `${page}#${siteFragment(seedHex, path)}`;
}

/**
 * The recipient link for a key. It points at share.html rather than the app
 * itself: a recipient has no account and no configured indexer, and that page
 * asks for only what it needs instead of booting the whole browser. The app
 * still understands the same fragment, so an owner can paste a link into their
 * own tab to test one. Callers can pass their own base to host the page
 * elsewhere; the fragment does not change.
 */
export function shareLink(seedHex, objectId, base) {
  // The app, not share.html. The in-app Shared panel is a tab: it can render
  // what it lists — a video plays, an HTML file renders — and it sits inside
  // the app that can offer an account. share.html stays for links already
  // handed out, but is no longer what gets generated.
  const page = (base || new URL('.', location.href).href).replace(/#.*$/, '');
  return `${page}#${shareFragment(seedHex, objectId)}`;
}

function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

// `KeyStats` counts arrive as BigInt from serde even though the generated
// typings call them numbers, and BigInt throws when mixed with numbers in
// arithmetic or passed to formatSize.
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v || 0));

function formatDate(d) {
  if (!d) return null;
  try { return d.toLocaleString(); } catch (_) { return String(d); }
}

/**
 * Reads every sharing key on the account, following the pager rather than
 * assuming one page covers it. Each record's `key` getter allocates a fresh
 * wasm handle, so it is read once here and carried on the returned row.
 */
export async function listSharingKeys(sdk) {
  const PAGE = 100;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sdk.sharingKeys(offset, PAGE);
    for (const record of page) {
      const key = record.key;
      const stats = record.stats;
      rows.push({
        key,
        publicKey: key.publicKey,
        seed: key.seed(),
        description: record.description,
        // The snapshot from the indexer, replaced below by a real count.
        objectCount: num(stats.objectCount),
        objectSize: num(stats.objectSize),
        expiresAt: stats.expiresAt || null,
        createdAt: stats.createdAt || null,
      });
    }
    if (page.length < PAGE) break;
  }

  // `KeyStats` is documented as "a snapshot, not a live view", and in practice
  // it is taken when the key is created — which is *before* anything is
  // attached, because every flow here mints the key first and then attaches.
  // So the snapshot reads 0 for a key that is actually full, which is worse
  // than showing nothing. Count what the key really holds.
  //
  // One walk per key. Failures leave the snapshot in place rather than
  // blanking the row: a wrong number is still better than an empty one.
  await Promise.all(rows.map(async (row) => {
    try {
      let count = 0;
      let size = 0;
      for (let offset = 0; ; offset += PAGE) {
        const page = await sdk.sharedObjects(row.key, offset, PAGE);
        for (const obj of page) {
          count += 1;
          size += num(obj.size());
        }
        if (page.length < PAGE) break;
      }
      row.objectCount = count;
      row.objectSize = size;
    } catch (_) { /* keep the snapshot */ }
  }));

  return rows;
}

/** Shortens a key's `ed25519:…` public half for display. */
function shortKey(publicKey) {
  const body = publicKey.replace(/^ed25519:/, '');
  return body.length > 16 ? `${body.slice(0, 8)}…${body.slice(-8)}` : body;
}

function copyToClipboard(text, button) {
  const original = button.textContent;
  navigator.clipboard.writeText(text).then(() => {
    button.textContent = '✓ Copied';
    setTimeout(() => { button.textContent = original; }, 1500);
  }).catch(() => {
    button.textContent = 'Copy failed';
    setTimeout(() => { button.textContent = original; }, 1500);
  });
}

/**
 * Modal listing the account's keys so an object can be attached to one, with
 * an inline path for creating a key when none fits. Resolves to the row the
 * object was attached to, or null if the user backed out.
 */
export async function pickSharingKey(sdk, subject) {
  const rows = await listSharingKeys(sdk);
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000;';
    modal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:560px; width:90%; max-height:85vh; overflow:auto; border:1px solid #333;">
        <h3 style="margin:0 0 0.25rem 0; color:#059669;">Attach to a sharing key</h3>
        <p style="color:#888; margin:0 0 1.25rem 0; font-size:0.9rem;">${_esc(subject || '')}</p>
        <div id="pk-list" style="margin-bottom:1.25rem;"></div>
        <div style="border-top:1px solid #333; padding-top:1rem;">
          <div style="color:#e0e0e0; margin-bottom:0.5rem; font-weight:500;">Or create a new key</div>
          <div style="display:flex; gap:0.5rem;">
            <input id="pk-desc" type="text" placeholder="Description, e.g. holiday photos"
                   style="flex:1; min-width:0; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px;" />
            <button id="pk-create" style="padding:0.5rem 0.9rem; background:#059669; color:white; border:none; border-radius:4px; cursor:pointer;">Create &amp; attach</button>
          </div>
          <div style="color:#666; font-size:0.8rem; margin-top:0.4rem;">The new key never expires. Set an expiry from the Sharing Keys page.</div>
        </div>
        <button id="pk-cancel" style="width:100%; margin-top:1.25rem; padding:0.6rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
      </div>
    `;
    document.body.appendChild(modal);

    const done = (value) => { modal.remove(); resolve(value); };
    modal.addEventListener('click', (e) => { if (e.target === modal) done(null); });
    modal.querySelector('#pk-cancel').addEventListener('click', () => done(null));

    const list = modal.querySelector('#pk-list');
    if (!rows.length) {
      list.innerHTML = '<div style="color:#888; font-size:0.9rem;">No sharing keys yet.</div>';
    }
    for (const row of rows) {
      const item = document.createElement('button');
      item.style.cssText = 'display:block; width:100%; text-align:left; padding:0.6rem 0.75rem; margin-bottom:0.4rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; cursor:pointer;';
      item.innerHTML = `
        <div style="font-weight:500;">${_esc(row.description || '(no description)')}</div>
        <div style="font-size:0.8rem; color:#666;">
          ${row.objectCount} object(s) · ${_esc(shortKey(row.publicKey))}${row.expiresAt ? ' · expires ' + _esc(formatDate(row.expiresAt)) : ''}
        </div>
      `;
      item.addEventListener('click', () => done(row));
      list.appendChild(item);
    }

    modal.querySelector('#pk-create').addEventListener('click', async () => {
      const button = modal.querySelector('#pk-create');
      const description = modal.querySelector('#pk-desc').value.trim();
      button.disabled = true;
      button.textContent = 'Creating…';
      try {
        const key = await sdk.createSharingKey(description, undefined);
        done({
          key,
          publicKey: key.publicKey,
          seed: key.seed(),
          description,
          objectCount: 0,
          objectSize: 0,
          expiresAt: null,
          createdAt: new Date(),
        });
      } catch (e) {
        button.disabled = false;
        button.textContent = 'Create & attach';
        alert(`Could not create sharing key: ${e.message || e}`);
      }
    });
  });
}

/** Shows a finished recipient link with a copy button. */
export function showShareLinkModal(row, objectId, heading) {
  const link = shareLink(row.seed, objectId);
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; z-index:1000;';
  modal.innerHTML = `
    <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:640px; width:90%; border:1px solid #333;">
      <h3 style="margin:0 0 1rem 0; color:#059669;">${_esc(heading || 'Recipient link')}</h3>
      <div style="background:#0a0a0a; border:1px solid #059669; border-radius:6px; padding:1rem; margin-bottom:1rem;">
        <div style="word-break:break-all; font-family:monospace; font-size:0.85rem; color:#e0e0e0;">${_esc(link)}</div>
      </div>
      <p style="color:#888; font-size:0.85rem; margin:0 0 1rem 0;">
        Anyone holding this link can read every object attached to
        <strong style="color:#e0e0e0;">${_esc(row.description || 'this key')}</strong>, and the downloads
        are billed to your account. Revoking the key from the Sharing Keys page cuts off access.
      </p>
      <div style="display:flex; gap:0.5rem;">
        <button id="sl-copy" style="flex:1; padding:0.75rem; background:#059669; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:500;">Copy link</button>
        <button id="sl-copy-seed" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer;">Copy seed only</button>
        <button id="sl-close" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer;">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector('#sl-close').addEventListener('click', () => modal.remove());
  modal.querySelector('#sl-copy').addEventListener('click', (e) => copyToClipboard(link, e.target));
  modal.querySelector('#sl-copy-seed').addEventListener('click', (e) => copyToClipboard(row.seed, e.target));
}

/**
 * Attaches one object to a key the user picks, then offers the link. Shared
 * with My Objects so both entry points behave the same.
 */
export async function shareObjectToKey(sdk, obj, subject) {
  const row = await pickSharingKey(sdk, subject);
  if (!row) return null;
  await sdk.shareObject(row.key, obj);
  showShareLinkModal(row, obj.id(), 'Object attached');
  return row;
}

export function initSharingKeysUI() {
  const listEl = () => document.getElementById('sk-list');
  const createBtn = () => document.getElementById('sk-create');

  async function refresh() {
    const status = panelStatus();
    const el = listEl();
    el.innerHTML = '<div style="padding:1rem; color:#888;">Loading…</div>';
    const sdk = await connectSdk(status);
    if (!sdk) { el.innerHTML = '<div style="padding:1rem; color:#f87171;">Not connected.</div>'; return; }
    let rows;
    try {
      rows = await listSharingKeys(sdk);
    } catch (e) {
      el.innerHTML = `<div style="padding:1rem; color:#f87171;">Could not list sharing keys: ${_esc(e.message || e)}</div>`;
      return;
    }
    if (!rows.length) {
      el.innerHTML = '<div style="padding:1rem; color:#888;">No sharing keys yet. Create one above, then attach objects from My Objects.</div>';
      status.innerHTML = '<span style="color:#888;">No sharing keys</span>';
      return;
    }
    el.innerHTML = '';
    for (const row of rows) el.appendChild(renderRow(sdk, row, refresh));
    status.innerHTML = `<span class="pass">✓ ${rows.length} sharing key${rows.length !== 1 ? 's' : ''}</span>`;
  }

  function renderRow(sdk, row, onChange) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'border-bottom:1px solid #222; padding:0.75rem 1rem;';
    const expiry = row.expiresAt ? `expires ${formatDate(row.expiresAt)}` : 'never expires';
    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; flex-wrap:wrap;">
        <div style="min-width:0; flex:1;">
          <div style="color:#e0e0e0; font-weight:500;">${_esc(row.description || '(no description)')}</div>
          <div style="font-size:0.8rem; color:#666; font-family:monospace;">${_esc(shortKey(row.publicKey))}</div>
          <div style="font-size:0.8rem; color:#888; margin-top:0.2rem;">
            ${row.objectCount} object(s) · ${_esc(formatSize(row.objectSize))} · ${_esc(expiry)}
          </div>
        </div>
        <div style="display:flex; gap:0.25rem; flex-wrap:wrap;">
          <button data-act="site"    style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#3b82f6; color:white;" title="Open this key's files as a site: its index.html if it has one, otherwise a generated index">Open Site</button>
          <button data-act="link"    style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#059669; color:white;">Copy link</button>
          <button data-act="objects" style="padding:0.25rem 0.5rem; font-size:0.85rem;">Objects</button>
          <button data-act="attach"  style="padding:0.25rem 0.5rem; font-size:0.85rem;">Attach…</button>
          <button data-act="revoke"  style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#dc2626; color:white;">Revoke</button>
        </div>
      </div>
      <div data-role="objects" style="display:none; margin-top:0.75rem; padding-left:0.5rem; border-left:2px solid #222;"></div>
    `;

    const objectsEl = wrap.querySelector('[data-role="objects"]');

    // Any key can be opened as a site: with an index.html it serves that
    // and resolves the rest by relative path, and without one it gets a
    // generated listing of its files.
    wrap.querySelector('[data-act="site"]').addEventListener('click', () => {
      window.viewObjectById(siteUrl(row.seed));
    });

    wrap.querySelector('[data-act="link"]').addEventListener('click', () => {
      showShareLinkModal(row, null, 'Recipient link');
    });

    wrap.querySelector('[data-act="objects"]').addEventListener('click', async (e) => {
      if (objectsEl.style.display !== 'none') { objectsEl.style.display = 'none'; return; }
      objectsEl.style.display = '';
      objectsEl.innerHTML = '<div style="color:#888; font-size:0.85rem;">Loading…</div>';
      try {
        await renderAttachedObjects(sdk, row, objectsEl, onChange);
      } catch (err) {
        objectsEl.innerHTML = `<div style="color:#f87171; font-size:0.85rem;">${_esc(err.message || err)}</div>`;
      }
      e.target.blur();
    });

    wrap.querySelector('[data-act="attach"]').addEventListener('click', () => {
      attachByIdPrompt(sdk, row, onChange);
    });

    wrap.querySelector('[data-act="revoke"]').addEventListener('click', async () => {
      const label = row.description || shortKey(row.publicKey);
      if (!confirm(`Revoke "${label}"?\n\nEvery link to it stops working. A download already in flight can keep reading for up to five more minutes, because account tokens stay valid until they expire.`)) return;
      try {
        await sdk.revokeSharingKey(row.key);
        await onChange();
      } catch (e) {
        alert(`Revoke failed: ${e.message || e}`);
      }
    });

    return wrap;
  }

  async function renderAttachedObjects(sdk, row, container, onChange) {
    const objects = await listOwnedSharedObjects(sdk, row.key);
    if (!objects.length) {
      container.innerHTML = '<div style="color:#888; font-size:0.85rem;">Nothing attached yet.</div>';
      return;
    }
    container.innerHTML = '';
    for (const obj of objects) {
      const id = obj.id();
      const name = filenameForDisplay(obj.metadata()) || '(no filename)';
      const line = document.createElement('div');
      line.style.cssText = 'display:flex; justify-content:space-between; gap:0.75rem; align-items:center; padding:0.3rem 0; font-size:0.85rem;';
      line.innerHTML = `
        <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          <span style="color:#e0e0e0;">${_esc(name)}</span>
          <span style="color:#666;"> · ${_esc(formatSize(obj.size()))}</span>
        </div>
        <div style="display:flex; gap:0.25rem; flex-shrink:0;">
          <button data-act="obj-link" style="padding:0.15rem 0.4rem; font-size:0.8rem; background:#059669; color:white;">Link</button>
          <button data-act="detach"   style="padding:0.15rem 0.4rem; font-size:0.8rem; background:#dc2626; color:white;">Detach</button>
        </div>
      `;
      line.querySelector('[data-act="obj-link"]').addEventListener('click', () => {
        showShareLinkModal(row, id, 'Link to this object');
      });
      line.querySelector('[data-act="detach"]').addEventListener('click', async () => {
        if (!confirm(`Detach "${name}" from this key?\n\nThe key and its other objects stay in place.`)) return;
        try {
          await sdk.unshareObject(row.key, id);
          await onChange();
        } catch (e) {
          alert(`Detach failed: ${e.message || e}`);
        }
      });
      container.appendChild(line);
    }
  }

  // Attaching from here takes object IDs rather than duplicating the object
  // browser; the per-object button in My Objects is the path for picking one
  // out of a list.
  async function attachByIdPrompt(sdk, row, onChange) {
    const raw = prompt('Object IDs to attach, one per line or comma separated:');
    if (!raw) return;
    const ids = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !/^[0-9a-f]{64}$/i.test(id));
    if (bad.length) { alert(`Not an object ID: ${bad[0]}`); return; }
    const status = panelStatus();
    const failures = [];
    for (let i = 0; i < ids.length; i++) {
      status.textContent = `Attaching ${i + 1}/${ids.length}…`;
      try {
        const obj = await sdk.object(ids[i]);
        await sdk.shareObject(row.key, obj);
      } catch (e) {
        failures.push(`${ids[i].slice(0, 8)}…: ${e.message || e}`);
      }
    }
    await onChange();
    if (failures.length) alert(`Attached ${ids.length - failures.length}/${ids.length}.\n\nFailed:\n${failures.join('\n')}`);
  }

  createBtn().addEventListener('click', async () => {
    const button = createBtn();
    const description = document.getElementById('sk-description').value.trim();
    const unit = parseInt(document.getElementById('sk-unit').value, 10);
    const duration = parseFloat(document.getElementById('sk-duration').value);
    // Unit 0 is the "never" option; the binding takes undefined for no expiry.
    const expiresAt = unit ? new Date(Date.now() + duration * unit) : undefined;
    if (unit && (!duration || duration <= 0)) { alert('Enter how long the key should last.'); return; }

    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Creating…';
    const status = panelStatus();
    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;
      const key = await sdk.createSharingKey(description, expiresAt);
      document.getElementById('sk-description').value = '';
      await refresh();
      showShareLinkModal({ seed: key.seed(), description }, null, 'Sharing key created');
    } catch (e) {
      alert(`Could not create sharing key: ${e.message || e}`);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });

  document.getElementById('sk-refresh').addEventListener('click', refresh);

  // Load without being asked, and reload on every return to the tab.
  //
  // Keys change from elsewhere in the app — Upload Site's Share mints one, My
  // Objects attaches an object to one — so a list rendered once goes stale
  // silently, and a page whose first state is an empty table with a Refresh
  // button reads as broken rather than as waiting. Guarded so overlapping
  // activations cannot stack requests.
  let refreshing = false;
  async function refreshOnce() {
    if (refreshing) return;
    refreshing = true;
    try {
      await refresh();
    } finally {
      refreshing = false;
    }
  }
  window.addEventListener('panel-activated', (e) => {
    if (e && e.detail && e.detail.panel === 'sharing') refreshOnce();
  });
  // If the panel is already the visible one at startup (a restored tab), the
  // activation event has come and gone before this listener existed.
  const panel = document.getElementById('panel-sharing');
  if (panel && panel.style.display && panel.style.display !== 'none') refreshOnce();

  // Importing a seed lets the owner rebuild a link for a key created
  // elsewhere, such as one made with the sialo CLI on another machine.
  document.getElementById('sk-import').addEventListener('click', () => {
    const seed = (prompt('Sharing key seed (64 hex characters):') || '').trim();
    if (!seed) return;
    if (!/^[0-9a-f]{64}$/i.test(seed)) { alert('A seed is 64 hex characters.'); return; }
    try {
      const key = SharingKey.fromSeed(seed);
      showShareLinkModal({ seed: key.seed(), description: shortKey(key.publicKey) }, null, 'Recipient link');
    } catch (e) {
      alert(`Not a valid seed: ${e.message || e}`);
    }
  });

  return { refresh };
}
