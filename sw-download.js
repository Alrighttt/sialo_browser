// sw-download.js — Service Worker for streaming downloads
//
// Intercepts synthetic /_download/{uuid} fetches and responds with a
// ReadableStream fed by uuid-tagged postMessage calls from the main
// thread. This gives the browser a normal streaming download (with
// download-bar progress) without needing the File System Access API.
//
// Communication uses plain postMessage (not MessagePort transfer,
// which is unreliable across browsers for SW postMessage).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Map of download UUID → { filename, size, controller }
const downloads = new Map();

self.addEventListener('message', (e) => {
  const { type, uuid } = e.data;

  if (type === 'start-download') {
    // Register a pending download (controller will be set when fetch fires)
    const { filename, size } = e.data;
    downloads.set(uuid, { filename, size, controller: null });
  } else if (type === 'download-chunk') {
    const entry = downloads.get(uuid);
    if (entry && entry.controller) {
      entry.controller.enqueue(new Uint8Array(e.data.data));
    }
  } else if (type === 'download-end') {
    const entry = downloads.get(uuid);
    if (entry && entry.controller) {
      entry.controller.close();
    }
    downloads.delete(uuid);
  } else if (type === 'download-error') {
    const entry = downloads.get(uuid);
    if (entry && entry.controller) {
      entry.controller.error(new Error(e.data.error));
    }
    downloads.delete(uuid);
  }
});

// Intercept /_download/{uuid} fetches
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const match = url.pathname.match(/^\/_download\/(.+)/);
  if (!match) return;

  const uuid = match[1];
  const entry = downloads.get(uuid);
  if (!entry) return;

  const { filename, size } = entry;

  const stream = new ReadableStream({
    start(controller) {
      // Store the controller so incoming messages can enqueue data
      entry.controller = controller;
    },
    cancel() {
      // User cancelled download in browser — notify main thread
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'download-cancelled', uuid }));
      });
      downloads.delete(uuid);
    },
  });

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '\\"')}"`,
  };
  if (size > 0) headers['Content-Length'] = String(size);

  e.respondWith(new Response(stream, { headers }));
});
