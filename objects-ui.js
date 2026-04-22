import { _esc, formatSize } from './utils.js';
import { connectSdk } from './config.js';
import { ZipWriter } from './vendor/zip-stream.js';
import { parallelDownloadToDisk } from './download.js';
import { withKeepAlive } from './keep-alive.js';
import { loadContentWithAutoDetect } from './browser.js';
import {
  openOrActivateInternalTab, getOrCreateActiveBrowserTab,
  setLastBrowserUrl, renderTabBar, getActiveTab, trackAbort,
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
      const objects = await sdk.objectEvents(null, limit || 500);

      if (objects.length === 0) {
        objectsList.innerHTML = '<div style="padding:1rem; color:#888; text-align:center;">No objects found. Upload something first!</div>';
        status.innerHTML = '<span style="color:#888;">No objects found</span>';
        return;
      }

      // Display objects in a table with checkboxes
      const activeObjects = objects.filter(o => !o.deleted);
      let html = `
        <div style="margin-bottom:0.5rem; display:flex; gap:0.5rem; align-items:center;">
          <button id="btn-download-zip" style="padding:0.4rem 0.75rem; font-size:0.85rem; background:#3b82f6; color:white;" disabled>Download Selected as ZIP</button>
          <span id="zip-selected-count" style="font-size:0.8rem; color:#888;">0 selected</span>
          <span id="zip-status" style="font-size:0.8rem; color:#888;"></span>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
          <thead>
            <tr style="border-bottom:2px solid #333; text-align:left;">
              <th style="padding:0.5rem; width:2rem;"><input type="checkbox" id="obj-select-all" title="Select all" /></th>
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
        const sizeBytes = obj.object ? obj.object.size() : 0;
        const size = sizeBytes ? formatSize(sizeBytes) : 'N/A';
        const date = new Date(obj.updatedAt).toLocaleString();
        const objStatus = obj.deleted ? '<span class="fail">Deleted</span>' : '<span class="pass">Active</span>';

        html += `
          <tr style="border-bottom:1px solid #222;">
            <td style="padding:0.5rem;">${!obj.deleted ? `<input type="checkbox" class="obj-select" data-id="${obj.id}" data-size="${sizeBytes}" />` : ''}</td>
            <td style="padding:0.5rem; font-family:monospace; font-size:0.85rem;" title="${obj.id}">${shortId}</td>
            <td style="padding:0.5rem;">${size}</td>
            <td style="padding:0.5rem;">${date}</td>
            <td style="padding:0.5rem;">${objStatus}</td>
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

      // Wire up select-all and selection count
      function updateSelectionCount() {
        const checked = objectsList.querySelectorAll('.obj-select:checked');
        document.getElementById('zip-selected-count').textContent = `${checked.length} selected`;
        document.getElementById('btn-download-zip').disabled = checked.length === 0;
      }

      document.getElementById('obj-select-all').addEventListener('change', (e) => {
        objectsList.querySelectorAll('.obj-select').forEach(cb => { cb.checked = e.target.checked; });
        updateSelectionCount();
      });
      objectsList.querySelectorAll('.obj-select').forEach(cb => {
        cb.addEventListener('change', updateSelectionCount);
      });

      // Open ZIP builder with selected objects
      document.getElementById('btn-download-zip').addEventListener('click', () => {
        const selected = [...objectsList.querySelectorAll('.obj-select:checked')];
        if (selected.length === 0) return;

        const section = document.getElementById('zip-builder-section');
        const tbody = document.getElementById('zip-builder-tbody');
        document.getElementById('zip-builder-status').textContent = '';
        tbody.innerHTML = '';

        for (const cb of selected) {
          const id = cb.dataset.id;
          const sizeBytes = parseInt(cb.dataset.size, 10) || 0;
          const row = cb.closest('tr');
          const sizeCell = row ? row.children[2]?.textContent : 'N/A';
          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid #222';
          tr.dataset.objectId = id;
          tr.dataset.size = sizeBytes;
          tr.innerHTML = `
            <td style="padding:0.5rem;">
              <input type="text" class="zip-filename" value="${id.substring(0, 16)}.sia"
                style="width:100%; font-size:0.85rem; background:#1a1a1a; color:#e0e0e0; border:1px solid #333; border-radius:4px; padding:0.3rem 0.5rem;" />
              <div style="font-size:0.7rem; color:#555; margin-top:0.2rem; font-family:monospace;">${id}</div>
              <div class="zip-row-progress" style="margin-top:0.3rem; display:none;">
                <progress class="zip-row-bar" max="100" value="0" style="width:100%; height:4px;"></progress>
                <span class="zip-row-status" style="font-size:0.7rem; color:#888;"></span>
              </div>
            </td>
            <td style="padding:0.5rem; color:#888; font-size:0.85rem; white-space:nowrap;">${sizeCell}</td>
            <td style="padding:0.5rem;">
              <button onclick="this.closest('tr').remove()" style="padding:0.15rem 0.4rem; font-size:0.8rem; background:#dc2626; color:white; border:none; border-radius:3px; cursor:pointer;" title="Remove from ZIP">✕</button>
            </td>
          `;
          tbody.appendChild(tr);
        }

        if (tbody.children.length === 0) {
          return;
        }

        section.style.display = '';
        section.scrollIntoView({ behavior: 'smooth' });
      });

      // Cancel ZIP builder
      let zipCancelled = false;
      document.getElementById('zip-builder-cancel').addEventListener('click', () => {
        zipCancelled = true;
        document.getElementById('zip-builder-section').style.display = 'none';
        document.getElementById('zip-builder-status').textContent = '';
      });

      // Download ZIP — parallel slab downloads streamed to disk
      document.getElementById('zip-builder-download').addEventListener('click', async () => {
        const tbody = document.getElementById('zip-builder-tbody');
        const rows = [...tbody.querySelectorAll('tr')];
        if (rows.length === 0) return;

        // Close-tab cancel: flips the existing zipCancelled flag so the
        // inter-file loop breaks out the next time it checks.
        const zipAbort = new AbortController();
        const zipUntrack = trackAbort(getActiveTab(), zipAbort);
        zipAbort.signal.addEventListener('abort', () => { zipCancelled = true; });

        await withKeepAlive(async () => {

        const entries = rows.map(tr => ({
          id: tr.dataset.objectId,
          filename: tr.querySelector('.zip-filename').value.trim() || `${tr.dataset.objectId.substring(0, 16)}.sia`,
        }));

        const zipStatus = document.getElementById('zip-builder-status');
        const btn = document.getElementById('zip-builder-download');
        zipCancelled = false;
        btn.disabled = true;

        const totalSize = rows.reduce((sum, tr) => sum + (parseInt(tr.dataset.size, 10) || 0), 0);

        let writable = null;
        let memBuf = null;
        try {
          if (window.showSaveFilePicker) {
            const handle = await window.showSaveFilePicker({
              suggestedName: `sia-objects-${new Date().toISOString().slice(0, 10)}.zip`,
              types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
            });
            writable = await handle.createWritable();
          } else {
            if (totalSize > 500 * 1024 * 1024) {
              const proceed = confirm(
                `Your browser doesn't support streaming to disk.\n\n` +
                `Total size: ${formatSize(totalSize)}\n\n` +
                `The ZIP will be built in memory. Files over ~500 MB total may cause instability.\n\n` +
                `For large ZIPs, use Chrome or Edge.\n\nContinue?`
              );
              if (!proceed) { btn.disabled = false; return; }
            }
            memBuf = [];
          }

          // ZIP writer — writes headers/descriptors to the stream
          const zip = new ZipWriter(async (chunk) => {
            if (writable) {
              await writable.write(chunk);
            } else {
              memBuf.push(new Uint8Array(chunk));
            }
          });

          // Dummy elements for parallelDownloadToDisk
          const dummyProgress = { set max(_) {}, set value(_) {}, style: { display: '' } };

          for (let i = 0; i < entries.length; i++) {
            const { id, filename } = entries[i];
            const row = rows[i];
            const progressDiv = row.querySelector('.zip-row-progress');
            const progressBar = row.querySelector('.zip-row-bar');
            const progressStatus = row.querySelector('.zip-row-status');
            progressDiv.style.display = '';
            progressStatus.textContent = 'Downloading...';
            progressBar.value = 0;

            if (zipCancelled) break;
            if (!zipCancelled) zipStatus.textContent = `${i + 1}/${entries.length}: ${filename}`;

            // Write ZIP local file header
            await zip.startEntry(filename);

            // Create a CRC-tracking writable proxy. Data flows:
            // workers → proxy.write() → CRC update → real writable/memBuf
            const crcProxy = {
              write: async (data) => {
                const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                zip.updateCrc(bytes);
                zip.advanceOffset(bytes.length);
                if (writable) {
                  await writable.write(bytes);
                } else {
                  memBuf.push(new Uint8Array(bytes));
                }
              },
              close: async () => {},
              abort: async () => {},
            };

            // Download all slabs in parallel, streaming each to disk through the proxy
            const result = await parallelDownloadToDisk(
              id, crcProxy, zipStatus, dummyProgress,
              (bytes) => {
                const pct = zip._current.size > 0 ? Math.min(100, Math.round((zip._current.size / (parseInt(row.dataset.size, 10) || 1)) * 100)) : 0;
                progressBar.value = pct;
                progressStatus.textContent = `${formatSize(zip._current.size)}`;
              },
            );

            // Write ZIP data descriptor
            await zip.endEntry();
            progressBar.value = 100;
            progressStatus.innerHTML = '<span class="pass">✓ Done</span>';
          }

          // Write central directory and end record
          if (zipCancelled) {
            if (writable) try { await writable.abort(); } catch (_) {}
            zipStatus.textContent = 'Cancelled.';
            btn.disabled = false;
            return;
          }

          await zip.finish();

          if (writable) {
            await writable.close();
          } else {
            const blob = new Blob(memBuf, { type: 'application/zip' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sia-objects-${new Date().toISOString().slice(0, 10)}.zip`;
            a.click();
            URL.revokeObjectURL(url);
          }

          zipStatus.innerHTML = `<span class="pass">✓ Downloaded ${entries.length} files as ZIP</span>`;
        } catch (e) {
          if (e.name === 'AbortError') {
            zipStatus.textContent = '';
          } else {
            zipStatus.innerHTML = `<span class="fail">ZIP failed: ${_esc(e.message || String(e))}</span>`;
          }
          if (writable) try { await writable.abort(); } catch (_) {}
        }
        }); // withKeepAlive
        zipUntrack();
        btn.disabled = false;
      });
    } catch (e) {
      status.innerHTML = `<span class="fail">Error: ${_esc(e.message || String(e))}</span>`;
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
      status.innerHTML = `<span class="fail">Delete failed: ${_esc(e.message || String(e))}</span>`;

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
        const shareUrl = sdk.shareObject(obj, new Date(validUntilMs));

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
      const shareUrl = sdk.shareObject(obj, new Date(validUntilMs));

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
