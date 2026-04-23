import { _dbg, _esc, formatSize } from './utils.js';
import { connectSdk, getUrl, getKeyHex } from './config.js';
import { getActiveTab, tabStatusProxy } from './tabs.js';

// Bottom-right status bar proxy for the currently-active tab.
function panelStatus() {
  return tabStatusProxy(getActiveTab()).status;
}

export function initAccountUI() {
  // -- Account Dashboard --
  async function loadAccountDashboard() {
    const status = panelStatus();
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

      // Count non-deleted objects. The indexer caps `objectEvents` at 500
      // per page, so page with a cursor until we see a short page.
      const PAGE_SIZE = 500;
      let objectCount = 0;
      let cursor = null;
      for (;;) {
        const page = await sdk.objectEvents(cursor, PAGE_SIZE);
        for (const ev of page) if (!ev.deleted) objectCount++;
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1];
        cursor = { id: last.id, after: last.updatedAt };
      }

      // Calculate storage metrics
      const usedBytes = accountData.pinnedData;
      const maxBytes = accountData.maxPinnedData;
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

      // Update account details
      document.getElementById('account-app-name').textContent = accountData.app?.name || 'Unknown';

      const accountKey = accountData.accountKey;
      const shortKey = accountKey.substring(0, 24) + '...';
      const keyEl = document.getElementById('account-key');
      keyEl.textContent = shortKey;
      keyEl.title = accountKey; // Full key in tooltip

      // Format last used time
      const lastUsed = accountData.lastUsed instanceof Date ? accountData.lastUsed : new Date(accountData.lastUsed);
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

  // Auto-load once, then refresh every 30s while the dashboard is
  // visible. The indexer call is cheap; we still skip it when the
  // panel is hidden to avoid work nobody sees.
  const panel = document.getElementById('panel-dashboard');
  const isVisible = () =>
    panel && panel.style.display !== 'none' && document.visibilityState !== 'hidden';

  let loadInFlight = false;
  async function refreshIfVisible() {
    if (!isVisible() || loadInFlight) return;
    loadInFlight = true;
    try { await loadAccountDashboard(); } finally { loadInFlight = false; }
  }

  refreshIfVisible();
  setInterval(refreshIfVisible, 30_000);
  // Catch panel becoming visible after a tab switch or tab-return from
  // background — load immediately instead of waiting for the next tick.
  document.addEventListener('visibilitychange', refreshIfVisible);
  new MutationObserver(refreshIfVisible).observe(panel, { attributes: true, attributeFilter: ['style'] });

  // -- Prune Slabs --
  document.getElementById('btn-prune-slabs').addEventListener('click', async () => {
    const button = document.getElementById('btn-prune-slabs');
    const status = panelStatus();
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
