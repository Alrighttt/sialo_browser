// Registration wizard for the Sialo Browser.
//
// Walks first-time users through a 5-step process:
//   1. Enter indexer URL
//   2. Provide app identity (name, description, service URL)
//   3. Approve the connection via the indexer's approval link
//   4. Generate or enter a recovery phrase + register
//   5. Success — key saved, ready to browse
//
// Exported function `initRegistrationWizard(helpers)` wires up all button
// handlers. The helpers object provides WASM SDK classes and tab-system
// functions so this module stays decoupled from index.html.

import { openFromLocation } from './shared-ui.js';
import { awaitAccountReady } from './page-gate.js';

export function initRegistrationWizard(helpers) {
  const {
    Builder,
    generateRecoveryPhrase,
    hex,
    fromHex,
    closeTab,
    activateTab,
    tabs,
  } = helpers;

  let regBuilder = null;
  let regAppId = null;

  function setStatus(el, text, cls) {
    el.textContent = '';
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    el.appendChild(span);
  }

  // --- Step navigation ---

  function showStep(n) {
    document.querySelectorAll('#panel-register .wizard-step').forEach(el => {
      el.classList.toggle('active', el.dataset.step === String(n));
    });
    document.querySelectorAll('#panel-register .wizard-dot').forEach(el => {
      const dot = parseInt(el.dataset.dot, 10);
      el.classList.toggle('active', dot === n);
      el.classList.toggle('completed', dot < n);
    });
    // Clear status messages on the step we're navigating to
    const activeStep = document.querySelector(`#panel-register .wizard-step[data-step="${n}"]`);
    if (activeStep) {
      activeStep.querySelectorAll('.wizard-status').forEach(el => { el.innerHTML = ''; });
    }
  }

  // --- Back buttons ---

  document.querySelectorAll('#panel-register .wizard-back').forEach(btn => {
    btn.addEventListener('click', () => {
      showStep(parseInt(btn.dataset.back, 10));
    });
  });

  // --- Step 1: Indexer URL ---

  document.getElementById('wiz-btn-next').addEventListener('click', () => {
    let url = document.getElementById('wiz-url').value.trim();
    if (!url) {
      alert('Please enter an indexer URL.');
      return;
    }
    // Normalize: the SDK's Rust reqwest::Url::parse rejects bare
    // hostnames and surfaces them as "client error: http error:
    // builder error", which is opaque to end users. Default to https
    // when no scheme is present.
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    // Collapse repeated trailing slashes, but keep exactly one: the SDK
    // joins request paths onto this base, and `Url::join` drops the last
    // path segment when the base does not end in a slash. Without it an
    // indexer served under a path, like https://host/api/, would send every
    // request to https://host/<path> instead.
    url = url.replace(/\/*$/, '/');
    document.getElementById('wiz-url').value = url;
    document.getElementById('cfg-url').value = url;
    localStorage.setItem('indexer-url', url);
    window.dispatchEvent(new CustomEvent('profile-updated'));
    showStep(2);
  });

  // --- Step 2: Request Connection ---

  document.getElementById('wiz-btn-request').addEventListener('click', async () => {
    const btn = document.getElementById('wiz-btn-request');
    const status = document.getElementById('wiz-status-request');
    const url = document.getElementById('wiz-url').value.trim();

    try {
      btn.disabled = true;
      btn.textContent = 'Requesting connection...';
      status.textContent = 'Requesting connection from indexer...';

      regBuilder = new Builder(
        url,
        {
          appId: 'c0000000000000000000000000000000000000000000000000000000000000de',
          name: 'Sialo',
          description: 'Sialo - a decentralized browser and CLI tool for the Sia network',
          serviceUrl: 'https://sialo.io',
        },
      );

      await regBuilder.requestConnection();

      const responseUrl = regBuilder.responseUrl();

      btn.textContent = 'Request Connection';
      btn.disabled = false;
      showStep(3);

      // Set after showStep so the status-clear doesn't wipe it
      const linkContainer = document.getElementById('wiz-approval-link');
      linkContainer.textContent = '';
      const a = document.createElement('a');
      a.href = responseUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'wizard-link';
      a.textContent = responseUrl;
      linkContainer.appendChild(a);
    } catch (e) {
      setStatus(status, 'Failed: ' + (e.message || String(e)), 'fail');
      btn.textContent = 'Request Connection';
      btn.disabled = false;
    }
  });

  // --- Step 3: Wait for Approval ---

  document.getElementById('wiz-btn-approve').addEventListener('click', async () => {
    const btn = document.getElementById('wiz-btn-approve');
    const status = document.getElementById('wiz-status-approve');

    if (!regBuilder) {
      setStatus(status, 'Go back and request a connection first.', 'fail');
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Waiting for approval...';
      status.textContent = 'Polling for approval (this may take a while)...';

      await regBuilder.waitForApproval();

      btn.textContent = 'Approved!';
      setStatus(status, 'Connection approved!', 'pass');
      showStep(4);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Check for Approval';
      setStatus(status, 'Error: ' + (e.message || String(e)), 'fail');
    }
  });

  // --- Step 4: Recovery Phrase + Register ---

  document.getElementById('wiz-btn-generate').addEventListener('click', () => {
    document.getElementById('wiz-mnemonic').value = generateRecoveryPhrase();
  });

  document.getElementById('wiz-btn-register').addEventListener('click', async () => {
    const btn = document.getElementById('wiz-btn-register');
    const status = document.getElementById('wiz-status-register');
    const mnemonic = document.getElementById('wiz-mnemonic').value.trim();

    if (!regBuilder) {
      setStatus(status, 'Complete the previous steps first.', 'fail');
      return;
    }
    if (!mnemonic) {
      setStatus(status, 'Enter or generate a recovery phrase.', 'fail');
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Registering...';
      status.textContent = 'Registering with indexer...';

      const sdk = await regBuilder.register(mnemonic);
      const appKey = sdk.appKey();
      const seed = hex(appKey.export());
      const pubkey = appKey.publicKey();

      // A profile of its own, made active, rather than written over whichever
      // profile happened to be selected. An account is its app key, so
      // overwriting one in place is how a reader loses access to everything
      // the previous key held.
      const indexer = document.getElementById('wiz-url').value.trim();
      adoptRegisteredKey(indexer, seed, pubkey);

      regBuilder = null;
      showStep(5);
      reportFunding(sdk);

      // Set after showStep so the status-clear doesn't wipe it
      const keyDisplay = document.getElementById('wiz-key-display');
      keyDisplay.textContent = '';
      for (const [label, value] of [['Recovery Phrase', mnemonic], ['App Key Seed', seed], ['Public Key', pubkey]]) {
        const b = document.createElement('strong');
        b.textContent = label + ':';
        keyDisplay.appendChild(b);
        keyDisplay.appendChild(document.createTextNode('\n' + value + '\n\n'));
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Register / Log In';
      setStatus(status, 'Error: ' + (e.message || String(e)), 'fail');
    }
  });

  /**
   * Say whether the new account can fetch anything yet.
   *
   * An account is registered long before it is funded, and until the indexer
   * has funded enough hosts every download fails. Someone who registered in
   * order to open a published link is about to do exactly that, so the wait is
   * named here rather than left to surface as a download error a minute later.
   *
   * Not a gate. Start Browsing stays live throughout: being held behind a
   * button with nothing to do is worse than arriving early, and whatever they
   * came for may be a site whose pages are already cached.
   */
  function reportFunding(sdk) {
    const el = document.getElementById('wiz-funding');
    if (!el || !sdk) return;
    el.style.display = '';
    el.textContent = 'Checking whether your account is ready\u2026';
    awaitAccountReady(sdk, (state) => {
      if (state.ready) {
        el.innerHTML = '<span class="pass">\u2713 Your account is funded and ready.</span>';
      } else if (state.timedOut) {
        el.innerHTML = '<span style="color:#f59e0b;">Your account is registered but still being funded. '
          + 'Downloads will fail until that finishes. Nothing is wrong and nothing needs doing.</span>';
      } else {
        el.innerHTML = '<span style="color:#f59e0b;">Setting up your account with storage hosts\u2026 '
          + 'This usually takes a few minutes, and downloads will fail until it finishes.</span>';
      }
    }).catch(() => { el.style.display = 'none'; });
  }

  // --- Step 5: Start Browsing ---

  document.getElementById('wiz-btn-start').addEventListener('click', () => {
    // Clear sensitive data from the DOM before navigating away
    document.getElementById('wiz-key-display').textContent = '';
    document.getElementById('wiz-mnemonic').value = '';

    // Find the register tab and close it
    const registerTab = tabs.find(t => t.type === 'internal' && t.panelName === 'register');
    // Find the Homepage browser tab
    const homepageTab = tabs.find(t => t.type === 'browser' && t.label === 'Homepage');

    // Whoever arrived by following a link came here to open that link, not the
    // homepage. The fragment is still in the address, so resolve it again and
    // only fall back to the homepage when there was nothing to return to.
    if (!openFromLocation() && homepageTab) {
      activateTab(homepageTab.id);
    }
    if (registerTab) {
      closeTab(registerTab.id);
    }
  });
}
