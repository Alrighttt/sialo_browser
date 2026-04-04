import { getUrl } from './config.js';
import { randomHex } from './utils.js';

export function initCorsUI() {
  document.getElementById('btn-cors-run-all').addEventListener('click', async () => {
    const btn = document.getElementById('btn-cors-run-all');
    const resultsDiv = document.getElementById('cors-results');
    const url = getUrl();

    if (!url) {
      resultsDiv.innerHTML = '<span class="fail">Configure indexer URL first</span>';
      return;
    }

    const fakeId = randomHex(32);
    const fakeReqId = randomHex(16);

    // All routes from the Go server, with the method that triggers preflight
    const tests = [
      // CORS-enabled routes (should pass)
      { method: 'POST', path: '/auth/connect', expect: true },
      { method: 'GET', path: `/auth/connect/${fakeReqId}/status`, expect: true },
      { method: 'POST', path: `/auth/connect/${fakeReqId}/register`, expect: true },
      { method: 'GET', path: '/auth/check', expect: true },
      { method: 'GET', path: '/hosts', expect: true },
      { method: 'GET', path: '/objects', expect: true },
      { method: 'GET', path: `/objects/${fakeId}`, expect: true },
      { method: 'GET', path: `/objects/${fakeId}/shared`, expect: true },
      { method: 'POST', path: '/objects', expect: true },
      { method: 'DELETE', path: `/objects/${fakeId}`, expect: true },
      { method: 'GET', path: '/slabs', expect: true },
      { method: 'POST', path: '/slabs', expect: true },
      { method: 'POST', path: '/slabs/prune', expect: true },
      { method: 'GET', path: `/slabs/${fakeId}`, expect: true },
      { method: 'DELETE', path: `/slabs/${fakeId}`, expect: true },
      // CORS-disabled routes (should fail)
      { method: 'GET', path: `/auth/connect/${fakeReqId}`, expect: false, note: 'CORS intentionally disabled (UI route)' },
      { method: 'POST', path: `/auth/connect/${fakeReqId}`, expect: false, note: 'CORS intentionally disabled (UI route)' },
    ];

    btn.disabled = true;
    btn.textContent = 'Testing...';
    resultsDiv.innerHTML = '';

    let passed = 0, failed = 0, expectedFails = 0;

    for (const t of tests) {
      const label = `${t.method} ${t.path.replace(fakeId, ':id').replace(fakeReqId, ':reqID')}`;
      const row = document.createElement('div');
      row.style.cssText = 'padding:0.4rem 0.6rem; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center;';
      row.innerHTML = `<span style="font-family:monospace;">${label}</span><span style="color:#888;">testing...</span>`;
      resultsDiv.appendChild(row);

      // Send the actual method with a custom header to force the browser to
      // automatically send an OPTIONS preflight. If preflight fails, fetch throws.
      try {
        const resp = await fetch(`${url}${t.path}`, {
          method: t.method,
          headers: {
            'X-CORS-Test': '1', // non-simple header forces preflight
          },
        });
        // If we got here, preflight succeeded
        if (t.expect) {
          row.lastChild.innerHTML = `<span class="pass">PASS (${resp.status})</span>`;
          passed++;
        } else {
          row.lastChild.innerHTML = `<span style="color:#f59e0b;">UNEXPECTED PASS (${resp.status})</span>`;
          passed++;
        }
      } catch (e) {
        if (!t.expect) {
          row.lastChild.innerHTML = `<span style="color:#888;">BLOCKED (expected) — ${t.note}</span>`;
          expectedFails++;
        } else {
          row.lastChild.innerHTML = '<span class="fail">FAIL — preflight rejected</span>';
          failed++;
        }
      }
    }

    const summary = document.createElement('div');
    summary.style.cssText = 'padding:0.75rem; margin-top:0.5rem; background:#0a0a0a; border-radius:4px; border:1px solid #222;';
    const color = failed === 0 ? '#10b981' : '#ef4444';
    summary.innerHTML = `<span style="color:${color}; font-weight:600;">${passed} passed, ${failed} failed, ${expectedFails} intentionally blocked</span>`;
    resultsDiv.appendChild(summary);

    btn.disabled = false;
    btn.textContent = 'Run All CORS Tests';
  });
}
