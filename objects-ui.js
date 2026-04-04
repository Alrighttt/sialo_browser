import { _esc, formatSize } from './utils.js';
import { connectSdk } from './config.js';
import { loadContentWithAutoDetect } from './browser.js';
import {
  openOrActivateInternalTab, getOrCreateActiveBrowserTab,
  setLastBrowserUrl, renderTabBar,
} from './tabs.js';

export function initObjectsUI() {
  // -- List Objects --
  document.getElementById('btn-list-objects').addEventListener('click', async () => {
    const status = document.getElementById('list-status');
    const objectsList = document.getElementById('objects-list');
    const limit = parseInt(document.getElementById('list-limit', 10).value, 10) || 50;

    status.textContent = 'Loading...';
    objectsList.innerHTML = '';

    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;

      status.textContent = 'Fetching objects...';
      const objectsJson = await sdk.listObjects(limit);
      const objects = JSON.parse(objectsJson);

      if (objects.length === 0) {
        objectsList.innerHTML = '<div style="padding:1rem; color:#888; text-align:center;">No objects found. Upload something first!</div>';
        status.innerHTML = '<span style="color:#888;">No objects found</span>';
        return;
      }

      // Display objects in a table
      let html = `
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
          <thead>
            <tr style="border-bottom:2px solid #333; text-align:left;">
              <th style="padding:0.5rem;">Object ID</th>
              <th style="padding:0.5rem;">Size</th>
              <th style="padding:0.5rem;">Updated</th>
              <th style="padding:0.5rem;">Status</th>
              <th style="padding:0.5rem;">Actions</th>
            </tr>
          </thead>
          <tbody>
      `;

      for (const obj of objects) {
        const shortId = obj.id.substring(0, 8) + '...' + obj.id.substring(obj.id.length - 8);
        const size = obj.size ? formatSize(obj.size) : 'N/A';
        const date = new Date(obj.updated_at).toLocaleString();
        const status = obj.deleted ? '<span class="fail">Deleted</span>' : '<span class="pass">Active</span>';

        html += `
          <tr style="border-bottom:1px solid #222;">
            <td style="padding:0.5rem; font-family:monospace; font-size:0.85rem;" title="${obj.id}">${shortId}</td>
            <td style="padding:0.5rem;">${size}</td>
            <td style="padding:0.5rem;">${date}</td>
            <td style="padding:0.5rem;">${status}</td>
            <td style="padding:0.5rem;">
              ${!obj.deleted ? `
                <button onclick="viewObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#3b82f6; color:white;" title="Open in browser viewer">View</button>
                <button onclick="shareObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#10b981; color:white; margin-left:0.25rem;" title="Generate share URL">Share</button>
                <button onclick="showObjectInfo('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; background:#8b5cf6; color:white; margin-left:0.25rem;" title="Show details">Info</button>
                <button onclick="downloadObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;">Download</button>
                <button onclick="copyToClipboard('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem;">Copy ID</button>
                <button onclick="deleteObjectById('${obj.id}')" style="padding:0.25rem 0.5rem; font-size:0.85rem; margin-left:0.25rem; background:#dc2626; color:white;">Delete</button>
              ` : ''}
            </td>
          </tr>
        `;
      }

      html += `
          </tbody>
        </table>
      `;

      objectsList.innerHTML = html;
      status.innerHTML = `<span class="pass">✓ Found ${objects.length} object${objects.length !== 1 ? 's' : ''}</span>`;
    } catch (e) {
      status.innerHTML = `<span class="fail">Error: ${_esc(e.message)}</span>`;
      objectsList.innerHTML = '';
    }
  });

  // Helper function to download an object by ID
  window.downloadObjectById = async (objectId) => {
    const dlUrl = document.getElementById('dl-url');
    const dlFilename = document.getElementById('dl-filename');

    dlUrl.value = objectId;
    dlFilename.value = 'download_' + objectId.substring(0, 8);

    // Switch to download tab and trigger download
    openOrActivateInternalTab('download');
    setTimeout(() => {
      document.getElementById('btn-download').click();
    }, 100);
  };

  // Helper function to copy to clipboard
  window.copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      alert('Object ID copied to clipboard!');
    } catch (e) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('Object ID copied to clipboard!');
    }
  };

  // Helper function to delete an object
  window.deleteObjectById = async (objectId) => {
    const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

    if (!confirm(`⚠️ Are you sure you want to delete object ${shortId}?\n\nThis action cannot be undone!`)) {
      return;
    }

    const status = document.getElementById('list-status');
    const originalStatus = status.innerHTML;

    try {
      status.innerHTML = '<span style="color:#f59e0b;">⏳ Deleting...</span>';

      const sdk = await connectSdk(status);
      if (!sdk) return;

      await sdk.deleteObject(objectId);

      status.innerHTML = '<span class="pass">✓ Object deleted successfully!</span>';

      // Refresh the list after a short delay
      setTimeout(() => {
        document.getElementById('btn-list-objects').click();
      }, 500);
    } catch (e) {
      status.innerHTML = `<span class="fail">Delete failed: ${_esc(e.message)}</span>`;

      // Restore original status after showing error for 3 seconds
      setTimeout(() => {
        status.innerHTML = originalStatus;
      }, 3000);
    }
  };

  // Helper function to view an object in the browser
  window.viewObjectById = async (objectId) => {
    const tab = getOrCreateActiveBrowserTab();
    tab.url = objectId;
    tab.label = objectId.length > 30 ? objectId.substring(0, 30) + '...' : objectId;
    setLastBrowserUrl(objectId);
    renderTabBar();

    const addressBar = document.getElementById('chrome-address-bar');
    addressBar.value = objectId;
    loadContentWithAutoDetect();
  };

  // Helper function to share an object (generate share URL)
  window.shareObjectById = async (objectId) => {
    const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

    // Show configuration modal first
    const configModal = document.createElement('div');
    configModal.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8); display: flex; align-items: center;
      justify-content: center; z-index: 1000;
    `;

    configModal.innerHTML = `
      <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:500px; width:90%; border:1px solid #333;">
        <h3 style="margin:0 0 1rem 0; color:#10b981;">🔗 Generate Share URL</h3>
        <p style="color:#888; margin-bottom:1.5rem;">Object: ${shortId}</p>

        <div style="margin-bottom:1.5rem;">
          <div style="color:#e0e0e0; margin-bottom:0.5rem; font-size:0.9rem;">Expires in</div>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input id="share-modal-duration" type="number" value="24" min="1" style="width:5rem; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;" />
            <select id="share-modal-unit" style="flex:1; padding:0.5rem; background:#0a0a0a; color:#e0e0e0; border:1px solid #333; border-radius:4px; font-size:1rem;">
              <option value="3600000">hours</option>
              <option value="86400000" selected>days</option>
              <option value="604800000">weeks</option>
            </select>
          </div>
        </div>

        <div style="display:flex; gap:0.5rem;">
          <button id="btn-generate-share" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem; font-weight:500;">
            Generate Link
          </button>
          <button id="btn-cancel-share" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(configModal);

    // Close on background click
    configModal.addEventListener('click', (e) => {
      if (e.target === configModal) configModal.remove();
    });

    // Cancel button
    configModal.querySelector('#btn-cancel-share').addEventListener('click', () => {
      configModal.remove();
    });

    // Generate button
    configModal.querySelector('#btn-generate-share').addEventListener('click', async () => {
      const generateBtn = configModal.querySelector('#btn-generate-share');
      const originalText = generateBtn.textContent;
      generateBtn.textContent = '⏳ Generating...';
      generateBtn.disabled = true;

      try {
        const duration = parseFloat(configModal.querySelector('#share-modal-duration').value);
        const unit = parseInt(configModal.querySelector('#share-modal-unit', 10).value);

        const status = document.getElementById('list-status');
        const sdk = await connectSdk(status);
        if (!sdk) {
          configModal.remove();
          return;
        }

        // Fetch the object
        const obj = await sdk.object(objectId);

        // Generate share URL with configured duration
        const validUntilMs = Date.now() + (duration * unit);
        const shareUrl = sdk.shareObject(obj, validUntilMs);

        // Calculate human-readable duration
        let durationText = `${duration} ${configModal.querySelector('#share-modal-unit').selectedOptions[0].text}`;

        // Remove config modal
        configModal.remove();

        // Show result modal
        const resultModal = document.createElement('div');
        resultModal.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.8); display: flex; align-items: center;
          justify-content: center; z-index: 1000;
        `;

        resultModal.innerHTML = `
          <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:600px; width:90%; border:1px solid #333;">
            <h3 style="margin:0 0 1rem 0; color:#10b981;">🔗 Share URL Generated</h3>
            <p style="color:#888; margin-bottom:1rem;">Object: ${shortId}</p>
            <div style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem; word-break:break-all; font-family:monospace; font-size:0.9rem;">
              ${shareUrl}
            </div>
            <p style="color:#888; font-size:0.9rem; margin-bottom:1rem;">
              ⏰ Valid for ${durationText}<br>
              🔒 Includes encryption key in URL
            </p>
            <div style="display:flex; gap:0.5rem;">
              <button onclick="navigator.clipboard.writeText('${shareUrl.replace(/'/g, "\\'")}').then(() => alert('Share URL copied!')); this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
                📋 Copy URL
              </button>
              <button onclick="this.parentElement.parentElement.parentElement.remove();" style="flex:1; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
                Close
              </button>
            </div>
          </div>
        `;

        document.body.appendChild(resultModal);

        // Close on background click
        resultModal.addEventListener('click', (e) => {
          if (e.target === resultModal) resultModal.remove();
        });
      } catch (e) {
        configModal.remove();
        alert(`Share failed: ${e.message}`);
      }
    });
  };

  // Helper function to show object info/details
  window.showObjectInfo = async (objectId) => {
    const shortId = objectId.substring(0, 8) + '...' + objectId.substring(objectId.length - 8);

    try {
      // Show loading state
      const button = event.target;
      const originalText = button.textContent;
      button.textContent = '⏳';
      button.disabled = true;

      const status = document.getElementById('list-status');
      const sdk = await connectSdk(status);
      if (!sdk) {
        button.textContent = originalText;
        button.disabled = false;
        return;
      }

      // Fetch the object
      const obj = await sdk.object(objectId);
      const size = obj.size();

      // Calculate number of slabs (each slab holds 10 shards * 4MB = ~40MB of data)
      const SLAB_DATA_SIZE = 10 * 4 * 1024 * 1024; // 40 MB
      const numSlabs = size === 0 ? 0 : Math.ceil(size / SLAB_DATA_SIZE);

      // Show info in a modal
      const modal = document.createElement('div');
      modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.8); display: flex; align-items: center;
        justify-content: center; z-index: 1000;
      `;

      modal.innerHTML = `
        <div style="background:#1a1a1a; padding:2rem; border-radius:8px; max-width:600px; width:90%; border:1px solid #333;">
          <h3 style="margin:0 0 1rem 0; color:#8b5cf6;">ℹ️ Object Details</h3>
          <div style="background:#0a0a0a; padding:1rem; border-radius:4px; margin-bottom:1rem;">
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Object ID:</div>
              <div style="font-family:monospace; font-size:0.9rem; word-break:break-all;">${_esc(objectId)}</div>
            </div>
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Size:</div>
              <div>${formatSize(size)} (${size.toLocaleString()} bytes)</div>
            </div>
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Slabs:</div>
              <div>${numSlabs} slab${numSlabs !== 1 ? 's' : ''} (~${(numSlabs * 40).toFixed(0)} MB encoded)</div>
            </div>
            <div style="margin-bottom:0.75rem;">
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
              <div>10 data shards + 20 parity shards (need any 10 of 30)</div>
            </div>
            <div>
              <div style="color:#888; font-size:0.85rem; margin-bottom:0.25rem;">Redundancy:</div>
              <div>10 data + 20 parity (${formatSize(size)} pinned)</div>
            </div>
          </div>
          <button onclick="this.parentElement.parentElement.remove();" style="width:100%; padding:0.75rem; background:#333; color:white; border:none; border-radius:4px; cursor:pointer; font-size:1rem;">
            Close
          </button>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on background click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });

      // Restore button
      button.textContent = originalText;
      button.disabled = false;
    } catch (e) {
      alert(`Failed to load info: ${e.message}`);
      event.target.textContent = 'Info';
      event.target.disabled = false;
    }
  };

  // -- Share Object --
  document.getElementById('btn-share').addEventListener('click', async () => {
    const status = document.getElementById('share-status');
    const objectId = document.getElementById('share-object-id').value.trim();
    const duration = parseFloat(document.getElementById('share-duration').value);
    const unit = parseInt(document.getElementById('share-unit', 10).value);

    if (!objectId) {
      status.innerHTML = '<span class="fail">Enter an Object ID</span>';
      return;
    }

    try {
      const sdk = await connectSdk(status);
      if (!sdk) return;

      status.textContent = 'Fetching object...';
      const obj = await sdk.object(objectId);

      const validUntilMs = Date.now() + (duration * unit);
      const shareUrl = sdk.shareObject(obj, validUntilMs);

      const expiresAt = new Date(validUntilMs).toLocaleString();
      status.textContent = '';
      const passSpan = document.createElement('span');
      passSpan.className = 'pass';
      passSpan.textContent = 'Share link created!';
      status.appendChild(passSpan);
      status.appendChild(document.createTextNode('\nExpires: ' + expiresAt + '\n\n'));
      const link = document.createElement('a');
      link.href = shareUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = 'color:#60a5fa; word-break:break-all;';
      link.textContent = shareUrl;
      status.appendChild(link);
    } catch (e) {
      const errSpan = document.createElement('span');
      errSpan.className = 'fail';
      errSpan.textContent = 'Error: ' + e.message;
      status.appendChild(document.createTextNode('\n'));
      status.appendChild(errSpan);
    }
  });
}
