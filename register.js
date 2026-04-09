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

export function initRegistrationWizard(helpers) {
  const {
    SdkBuilder,
    generate_recovery_phrase,
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
    const url = document.getElementById('wiz-url').value.trim();
    if (!url) {
      alert('Please enter an indexer URL.');
      return;
    }
    // Save URL to config + localStorage + profile system
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

      regBuilder = new SdkBuilder(
        url,
        'c0000000000000000000000000000000000000000000000000000000000000de',
        'Sialo',
        'Sialo - a decentralized browser and CLI tool for the Sia network',
        'https://sialo.io',
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
    document.getElementById('wiz-mnemonic').value = generate_recovery_phrase();
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

      // Save to config fields + localStorage + profile system
      document.getElementById('cfg-key').value = seed;
      localStorage.setItem('app-key', seed);
      // Notify the profile system to update the active profile
      window.dispatchEvent(new CustomEvent('profile-updated'));

      regBuilder = null;
      showStep(5);

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
      btn.textContent = 'Register';
      setStatus(status, 'Error: ' + (e.message || String(e)), 'fail');
    }
  });

  // --- Step 5: Start Browsing ---

  document.getElementById('wiz-btn-start').addEventListener('click', () => {
    // Clear sensitive data from the DOM before navigating away
    document.getElementById('wiz-key-display').textContent = '';
    document.getElementById('wiz-mnemonic').value = '';

    // Find the register tab and close it
    const registerTab = tabs.find(t => t.type === 'internal' && t.panelName === 'register');
    // Find the Homepage browser tab
    const homepageTab = tabs.find(t => t.type === 'browser' && t.label === 'Homepage');

    if (homepageTab) {
      activateTab(homepageTab.id);
    }
    if (registerTab) {
      closeTab(registerTab.id);
    }
  });
}
