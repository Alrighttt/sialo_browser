import { _dbg, _esc, formatSize } from './utils.js';
import { connectSdk, getUrl, getKeyHex } from './config.js';

export function initAccountUI() {
  // -- Account Dashboard --
  async function loadAccountDashboard() {
    const status = document.getElementById('account-status');
    const dashboard = document.getElementById('account-dashboard');

    try {
      status.textContent = 'Loading account data...';

      const sdk = await connectSdk(status);
      if (!sdk) {
        return;
      }

      // Fetch account data
      const accountData = await sdk.account();
      _dbg('Account data:', accountData);

      // Fetch object count
      const objectsJson = await sdk.listObjects(null); // Get all objects
      const objects = JSON.parse(objectsJson);
      const objectCount = objects.filter(o => !o.deleted).length;

      // Calculate storage metrics (accountData is a Map)
      const usedBytes = accountData.get('pinnedData');
      const maxBytes = accountData.get('maxPinnedData');
      const freeBytes = maxBytes - usedBytes;
      const usedPercent = maxBytes > 0 ? (usedBytes / maxBytes * 100) : 0;

      // Update storage bar
      document.getElementById('account-storage-bar').style.width = `${usedPercent}%`;
      document.getElementById('account-storage-text').textContent =
        `${formatSize(usedBytes)} / ${formatSize(maxBytes)} (${usedPercent.toFixed(1)}%)`;
      document.getElementById('account-used-label').textContent = `Used: ${formatSize(usedBytes)}`;
      document.getElementById('account-free-label').textContent = `Free: ${formatSize(freeBytes)}`;

      // Change bar color based on usage
      const bar = document.getElementById('account-storage-bar');
      if (usedPercent >= 90) {
        bar.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)'; // Red
      } else if (usedPercent >= 75) {
        bar.style.background = 'linear-gradient(90deg, #f59e0b, #d97706)'; // Orange
      } else {
        bar.style.background = 'linear-gradient(90deg, #10b981, #059669)'; // Green
      }

      // Update quick stats
      document.getElementById('account-objects-count').textContent = objectCount.toLocaleString();
      document.getElementById('account-pinned-data').textContent = formatSize(usedBytes);
      document.getElementById('account-capacity-percent').textContent = `${usedPercent.toFixed(1)}%`;

      // Update account details (app is also a Map)
      const app = accountData.get('app');
      document.getElementById('account-app-name').textContent = app.get('description') || 'Unknown';

      const accountKey = accountData.get('accountKey');
      const shortKey = accountKey.substring(0, 24) + '...';
      const keyEl = document.getElementById('account-key');
      keyEl.textContent = shortKey;
      keyEl.title = accountKey; // Full key in tooltip

      // Format last used time
      const lastUsed = new Date(accountData.get('lastUsed'));
      const now = new Date();
      const diffMs = now - lastUsed;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let lastUsedText;
      if (diffMins < 1) lastUsedText = 'Just now';
      else if (diffMins < 60) lastUsedText = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
      else if (diffHours < 24) lastUsedText = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
      else lastUsedText = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

      document.getElementById('account-last-used').textContent = lastUsedText;
      document.getElementById('account-max-storage').textContent = formatSize(maxBytes);

      // Clear status
      status.innerHTML = '<span class="pass">✓ Account data loaded</span>';

      // Show warning if storage is almost full
      if (usedPercent >= 80) {
        status.innerHTML = '<span style="color:#f59e0b;">⚠️ Storage is ' + usedPercent.toFixed(1) + '% full. Consider deleting unused objects or pruning slabs.</span>';
      }
    } catch (e) {
      console.error('Failed to load account:', e);
      status.innerHTML = `<span class="fail">Failed to load account: ${_esc(e.message)}</span>`;
    }
  }

  document.getElementById('btn-refresh-account').addEventListener('click', loadAccountDashboard);

  // -- Host Balances --
  const SC_HASTINGS = 1000000000000000000000000n; // 10^24

  function hastingsToSC(hastingsStr) {
    if (!hastingsStr) return '0';
    const h = BigInt(hastingsStr);
    const whole = h / SC_HASTINGS;
    const frac = h % SC_HASTINGS;
    if (frac === 0n) return whole.toString();
    // Show 4 decimal places
    const fracStr = (frac * 10000n / SC_HASTINGS).toString().padStart(4, '0');
    return `${whole}.${fracStr}`;
  }

  function bandwidthRemaining(balanceStr, pricePerByteStr) {
    if (!balanceStr || !pricePerByteStr) return null;
    const balance = BigInt(balanceStr);
    const price = BigInt(pricePerByteStr);
    if (price === 0n) return null; // free / unknown
    return Number(balance / price);
  }

  document.getElementById('btn-check-balances').addEventListener('click', async () => {
    const btn = document.getElementById('btn-check-balances');
    const statusEl = document.getElementById('host-balance-status');
    const summaryEl = document.getElementById('host-balance-summary');
    const tableEl = document.getElementById('host-balance-table');
    const tbody = document.getElementById('host-balance-rows');

    btn.disabled = true;
    btn.textContent = 'Checking...';
    statusEl.textContent = 'Connecting...';
    summaryEl.style.display = 'none';
    tableEl.style.display = 'none';
    tbody.innerHTML = '';

    try {
      const sdk = await connectSdk(statusEl);
      if (!sdk) { btn.disabled = false; btn.textContent = 'Check Balances'; return; }

      const hostKeys = Array.from(sdk.knownHosts());
      const total = hostKeys.length;
      let completed = 0, funded = 0, unfunded = 0, errored = 0;
      let totalDownloadBytes = 0;

      // Create placeholder rows for every host
      const rowMap = new Map(); // hostKey -> <tr>
      for (const hk of hostKeys) {
        const shortKey = hk.substring(0, 16) + '...';
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #1a1a1a';
        tr.innerHTML = `
          <td style="padding:0.5rem 0.75rem; font-family:monospace; color:#555;" title="${hk}">${shortKey}</td>
          <td colspan="3" style="padding:0.5rem 0.75rem; color:#555; text-align:right;">querying...</td>`;
        tbody.appendChild(tr);
        rowMap.set(hk, tr);
      }
      tableEl.style.display = 'block';
      summaryEl.style.display = 'block';
      document.getElementById('hosts-funded-count').textContent = '0';
      document.getElementById('hosts-unfunded-count').textContent = '0';
      document.getElementById('hosts-error-count').textContent = '0';
      document.getElementById('hosts-total-download').textContent = '-';
      statusEl.textContent = `Querying 0 / ${total} hosts...`;

      // Update a single row with results and re-sort the table
      function applyResult(h) {
        completed++;
        const tr = rowMap.get(h.hostKey);
        const shortKey = h.hostKey.substring(0, 16) + '...';
        if (h.balanceError) {
          errored++;
          tr.dataset.sort = '2'; // errors last
          tr.dataset.bal = '0';
          tr.innerHTML = `
            <td style="padding:0.5rem 0.75rem; font-family:monospace; color:#888;" title="${h.hostKey}">${shortKey}</td>
            <td colspan="3" style="padding:0.5rem 0.75rem; color:#ef4444; text-align:right;">${h.balanceError}</td>`;
        } else {
          const bal = BigInt(h.balance);
          if (bal === 0n) { unfunded++; tr.dataset.sort = '1'; } else { funded++; tr.dataset.sort = '0'; }
          tr.dataset.bal = h.balance;
          const sc = hastingsToSC(h.balance);
          const dl = bandwidthRemaining(h.balance, h.egressPrice);
          const ul = bandwidthRemaining(h.balance, h.ingressPrice);
          if (dl !== null) totalDownloadBytes += dl;
          const balColor = bal > 0n ? '#e0e0e0' : '#666';
          tr.innerHTML = `
            <td style="padding:0.5rem 0.75rem; font-family:monospace; color:#888;" title="${h.hostKey}">${shortKey}</td>
            <td style="padding:0.5rem 0.75rem; text-align:right; color:${balColor}; font-family:monospace;">${sc} SC</td>
            <td style="padding:0.5rem 0.75rem; text-align:right; color:#38bdf8; font-family:monospace;">${dl !== null ? formatSize(dl) : '-'}</td>
            <td style="padding:0.5rem 0.75rem; text-align:right; color:#a78bfa; font-family:monospace;">${ul !== null ? formatSize(ul) : '-'}</td>`;
        }
        // Update summary
        document.getElementById('hosts-funded-count').textContent = funded;
        document.getElementById('hosts-unfunded-count').textContent = unfunded;
        document.getElementById('hosts-error-count').textContent = errored;
        document.getElementById('hosts-total-download').textContent = totalDownloadBytes > 0 ? formatSize(totalDownloadBytes) : '-';
        statusEl.textContent = `Queried ${completed} / ${total} hosts...`;

        // Re-sort: completed rows on top (funded > unfunded > error by balance desc), pending at bottom
        const rows = Array.from(tbody.children);
        rows.sort((a, b) => {
          const sa = a.dataset.sort ?? '3'; // pending = 3
          const sb = b.dataset.sort ?? '3';
          if (sa !== sb) return sa.localeCompare(sb);
          const ba = BigInt(a.dataset.bal || '0');
          const bb = BigInt(b.dataset.bal || '0');
          return ba > bb ? -1 : ba < bb ? 1 : 0;
        });
        for (const r of rows) tbody.appendChild(r);
      }

      // Query hosts with concurrency limit of 8
      const CONCURRENCY = 8;
      let idx = 0;
      async function next() {
        while (idx < hostKeys.length) {
          const hk = hostKeys[idx++];
          try {
            const h = await sdk.hostAccountInfo(hk);
            applyResult(h);
          } catch (e) {
            applyResult({ hostKey: hk, balanceError: e.message || String(e) });
          }
        }
      }
      const workers = [];
      for (let i = 0; i < Math.min(CONCURRENCY, hostKeys.length); i++) {
        workers.push(next());
      }
      await Promise.all(workers);

      statusEl.innerHTML = `<span class="pass">Queried ${total} hosts</span>`;
    } catch (e) {
      console.error('Failed to check balances:', e);
      statusEl.innerHTML = `<span class="fail">Failed: ${_esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check Balances';
    }
  });

  // -- Prune Slabs --
  document.getElementById('btn-prune-slabs').addEventListener('click', async () => {
    const button = document.getElementById('btn-prune-slabs');
    const status = document.getElementById('account-status');
    const originalText = button.textContent;

    // Confirmation dialog
    if (!confirm('🧹 Prune Unused Slabs?\n\nThis will remove slabs that are not referenced by any pinned objects.\n\nThis operation cannot be undone. Continue?')) {
      return;
    }

    try {
      // Show loading state
      button.textContent = '⏳ Pruning...';
      button.disabled = true;
      status.textContent = 'Pruning unused slabs...';

      const sdk = await connectSdk(status);
      if (!sdk) {
        button.textContent = originalText;
        button.disabled = false;
        return;
      }

      // Call prune slabs
      await sdk.pruneSlabs();

      // Success!
      status.innerHTML = '<span class="pass">✓ Slabs pruned successfully! Refreshing account data...</span>';

      // Restore button
      button.textContent = originalText;
      button.disabled = false;

      // Refresh account data to show updated storage
      setTimeout(() => {
        loadAccountDashboard();
      }, 1000);
    } catch (e) {
      console.error('Failed to prune slabs:', e);
      status.innerHTML = `<span class="fail">Failed to prune slabs: ${_esc(e.message)}</span>`;
      button.textContent = originalText;
      button.disabled = false;
    }
  });

  // Auto-load account dashboard when SDK is configured
  window.addEventListener('load', async () => {
    // Wait a bit for user to configure SDK
    setTimeout(async () => {
      const url = getUrl();
      const keyHex = getKeyHex();
      if (url && keyHex) {
        await loadAccountDashboard();
      }
    }, 1000);
  });
}
