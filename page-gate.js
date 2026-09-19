// Gates the built-in pages that cannot work without an indexer account, and
// points the reader at registration instead of letting them find out by
// clicking things that silently fail.
//
// This matters most for someone who arrived on a sharing link. That link needs
// no account, so they land on real content and reasonably assume the rest of
// the app works the same way. It does not: everything that reads or writes
// *their own* objects needs an account they do not have. Without a gate the
// first thing they try just does nothing.
//
// Deliberately NOT gated:
//   setup     — the page where you fix this
//   register  — the fix itself
//   shared    — recipient side; a sharing key is all it needs
//   history   — local, read from localStorage
//   explorer  — reads consensus through chain.js, not the indexer
//   wallet    — same
//
// upload-site is absent because it gates itself, with copy specific to
// uploading. The two use the same `.page-gate` styles so they look identical.
//
// Applied by hiding the panel's `.internal-page-content` and showing a gate
// element beside it, so no per-page UI module needs to know about any of this.

import { getUrl, getKeyHex } from './config.js';
import { openOrActivateInternalTab } from './tabs.js';

/**
 * Panels that need an indexer account, and why — phrased for someone who does
 * not yet know they need one. Derived from which modules call `connectSdk`,
 * not from guesswork.
 */
const NEEDS_ACCOUNT = {
  'dashboard': 'The dashboard reports your account\'s storage, spending, and host balances.',
  'upload-file': 'Uploading stores files under your account and is billed to it.',
  'upload-text': 'Uploading stores content under your account and is billed to it.',
  'download': 'Fetching an object by ID looks it up through your indexer account.',
  'objects': 'My Objects lists the objects your account has stored.',
  'manifest': 'Manifests are read and written through your account.',
  'sharing': 'Sharing keys are issued by your account, and downloads through them are billed to it.',
  'syncer-config': 'Syncer settings apply to your own indexer connection.',
};

/** One gate element per panel, created on first need. */
const gates = new Map();

function buildGate(panel) {
  const el = document.createElement('div');
  el.className = 'page-gate';
  el.id = 'gate-' + panel;
  el.innerHTML = `
    <div class="page-gate-title">An indexer account is needed for this page</div>
    <p class="page-gate-reason"></p>
    <p class="page-gate-hint">
      It takes a moment and gives this browser its own account on an indexer. If you
      already have a recovery phrase, use it there to log back in instead.
      Content someone shared with you keeps working either way &mdash; a sharing link
      carries everything it needs.
    </p>
    <div class="row" style="gap:0.5rem;">
      <button class="page-gate-register btn-share">Register / Log In</button>
      <button class="page-gate-settings btn-open">I already have a key</button>
    </div>`;
  el.querySelector('.page-gate-register')
    .addEventListener('click', () => openOrActivateInternalTab('register'));
  el.querySelector('.page-gate-settings')
    .addEventListener('click', () => openOrActivateInternalTab('setup'));
  return el;
}

/** Whether this browser has enough configuration to reach an indexer at all. */
function configured() {
  try {
    return !!(getUrl() && getKeyHex());
  } catch (_) {
    // The config inputs live in the setup panel; if they are somehow absent
    // there is nothing to read, so treat it as unconfigured rather than
    // throwing out of an event handler.
    return false;
  }
}

/** Show or hide the gate for one panel. */
export function applyGate(panel) {
  const reason = NEEDS_ACCOUNT[panel];
  if (!reason) return;
  const host = document.getElementById('panel-' + panel);
  if (!host) return;

  let gate = gates.get(panel);
  if (!gate) {
    gate = buildGate(panel);
    gates.set(panel, gate);
    host.appendChild(gate);
  }

  const blocked = !configured();
  gate.querySelector('.page-gate-reason').textContent = reason;
  gate.style.display = blocked ? '' : 'none';
  // Hide the page itself rather than disabling its controls one by one: the
  // controls are defined across a dozen modules, and a half-live page invites
  // exactly the silent failures this exists to prevent.
  for (const content of host.querySelectorAll(':scope > .internal-page-content')) {
    content.style.display = blocked ? 'none' : '';
  }
}

/** Re-evaluate every gated panel. Cheap: it only touches ones already built. */
export function refreshAllGates() {
  for (const panel of gates.keys()) applyGate(panel);
}

/**
 * Wait until a freshly registered account can actually fetch anything.
 *
 * Registering does not make an account usable. The indexer funds host accounts
 * on its own schedule and only counts the account ready once enough of them
 * are funded, so for the first few minutes a new account exists but every
 * download fails. Someone who arrived by following a published link is exactly
 * the person who meets this: they register *because* the link needed an
 * account, and the first thing they do is go back to content that cannot load
 * yet.
 *
 * Reported rather than enforced. `onTick` is called with the current state
 * after every check, so a caller can say what is happening and leave the
 * reader free to go and look around. Resolves true once ready, false if the
 * wait is given up on.
 */
export async function awaitAccountReady(sdk, onTick, { timeoutMs = 300000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ready = false;
    try {
      ready = !!(await sdk.account()).ready;
    } catch (_) {
      // A failed check is not a verdict: the account may be fine and the
      // request merely unlucky. Keep waiting until the deadline.
    }
    if (ready) {
      if (onTick) onTick({ ready: true, waiting: false });
      return true;
    }
    if (Date.now() >= deadline) {
      if (onTick) onTick({ ready: false, waiting: false, timedOut: true });
      return false;
    }
    if (onTick) onTick({ ready: false, waiting: true });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Whether a failure is really "you have no indexer account".
 *
 * Several layers produce their own wording for the same underlying cause —
 * connectSdk's "Set Indexer URL and App Key…", the site loader's "needs your
 * own indexer account", an unattached embed — so the check is a flag first
 * and known phrasing second. Anything reaching this without a flag is matched
 * on text, which is brittle; the flag is what new call sites should set.
 */
export function isAccountError(err) {
  if (!err) return false;
  // An explicit denial outranks everything below, including the catch-all. A
  // truthiness test alone does not do this: `needsAccount: false` is falsy, so
  // it fell through to that catch-all and was reported as an account problem
  // anyway, which is the opposite of what setting it means.
  if (err.needsAccount === false) return false;
  if (err.needsAccount) return true;
  const msg = String(err.message || err);
  if (/Set Indexer URL and App Key|App key not recognized|SDK not connected/i.test(msg)) {
    return true;
  }
  // Definitely not about the account: the content was reached and answered.
  // Matched on wording because the flag above does not survive the trip — a
  // site-path failure crosses a postMessage boundary as a bare string and is
  // rebuilt on the far side. Checked before the catch-all, which would
  // otherwise offer registration for a file that is simply not in the site,
  // sending the reader off to fix something that was never wrong.
  if (/not in this site/i.test(msg)) return false;
  // Anything at all, if this browser simply has no account to try with.
  return !configured();
}

/**
 * Cover the viewport with the registration prompt. `reason` is shown verbatim,
 * so it must already be human-readable — it is what the reader sees first.
 */
export function showAccountPrompt(reason) {
  const el = document.getElementById('account-prompt');
  if (!el) return;
  const r = document.getElementById('account-prompt-reason');
  if (r) r.textContent = reason || 'This content could not be loaded without an account.';
  el.style.display = '';
}

export function hideAccountPrompt() {
  const el = document.getElementById('account-prompt');
  if (el) el.style.display = 'none';
}

export function initPageGate() {
  // Action buttons embedded in status-bar messages. Delegated, because status
  // text is rewritten wholesale on every update and any listener bound to a
  // button inside it would be discarded with the old markup.
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof HTMLElement
      ? e.target.closest('[data-sialo-action]') : null;
    if (!btn) return;
    const action = btn.getAttribute('data-sialo-action');
    if (action === 'register') openOrActivateInternalTab('register');
    else if (action === 'settings') openOrActivateInternalTab('setup');
  });

  const dismiss = document.getElementById('account-prompt-dismiss');
  if (dismiss) dismiss.addEventListener('click', hideAccountPrompt);
  // Any navigation or tab switch clears it: it describes one failed load, not
  // a persistent state, and leaving it up would cover whatever comes next.
  window.addEventListener('address-changed', hideAccountPrompt);

  window.addEventListener('panel-activated', (e) => {
    if (e && e.detail && e.detail.panel) applyGate(e.detail.panel);
    hideAccountPrompt();
  });
  // Registration and the settings inputs both announce themselves this way, so
  // a gate drops as soon as the account exists without needing a reload.
  window.addEventListener('profile-updated', refreshAllGates);
  const cfgUrl = document.getElementById('cfg-url');
  const cfgKey = document.getElementById('cfg-key');
  for (const el of [cfgUrl, cfgKey]) {
    if (el) el.addEventListener('input', refreshAllGates);
  }
}
