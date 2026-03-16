// Registration wizard for the Sia Browser.
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
    // Save URL to config + localStorage
    document.getElementById('cfg-url').value = url;
    localStorage.setItem('indexer-url', url);
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

      regAppId = 'c0000000000000000000000000000000000000000000000000000000000000de';
      regBuilder = new Builder(url);

      const appMetadata = JSON.stringify({
        appID: regAppId,
        name: 'Sialo',
        description: 'Sialo - a decentralized browser and CLI tool for the Sia network',
        serviceURL: 'https://sialo.io',
      });

      await regBuilder.requestConnection(appMetadata);

      const responseUrl = regBuilder.responseUrl();

      btn.textContent = 'Request Connection';
      btn.disabled = false;
      showStep(3);

      // Set after showStep so the status-clear doesn't wipe it
      document.getElementById('wiz-approval-link').innerHTML =
        `<a href="${responseUrl}" target="_blank" rel="noopener" class="wizard-link">${responseUrl}</a>`;
    } catch (e) {
      status.innerHTML = `<span class="fail">Failed: ${e.message}</span>`;
      btn.textContent = 'Request Connection';
      btn.disabled = false;
    }
  });

  // --- Step 3: Wait for Approval ---

  document.getElementById('wiz-btn-approve').addEventListener('click', async () => {
    const btn = document.getElementById('wiz-btn-approve');
    const status = document.getElementById('wiz-status-approve');

    if (!regBuilder) {
      status.innerHTML = '<span class="fail">Go back and request a connection first.</span>';
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = 'Waiting for approval...';
      status.textContent = 'Polling for approval (this may take a while)...';

      await regBuilder.waitForApproval();

      btn.textContent = 'Approved!';
      status.innerHTML = '<span class="pass">Connection approved!</span>';
      showStep(4);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Check for Approval';
      status.innerHTML = `<span class="fail">Error: ${e.message}</span>`;
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
      status.innerHTML = '<span class="fail">Complete the previous steps first.</span>';
      return;
    }
    if (!mnemonic) {
      status.innerHTML = '<span class="fail">Enter or generate a recovery phrase.</span>';
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

      // Save to config fields + localStorage
      document.getElementById('cfg-key').value = seed;
      localStorage.setItem('app-key', seed);

      regBuilder = null;
      showStep(5);

      // Set after showStep so the status-clear doesn't wipe it
      document.getElementById('wiz-key-display').innerHTML =
        `<strong>Recovery Phrase:</strong>\n${mnemonic}\n\n<strong>App Key Seed:</strong>\n${seed}\n\n<strong>Public Key:</strong>\n${pubkey}`;
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Register';
      status.innerHTML = `<span class="fail">Error: ${e.message}</span>`;
    }
  });

  // --- Step 5: Start Browsing ---

  document.getElementById('wiz-btn-start').addEventListener('click', () => {
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
