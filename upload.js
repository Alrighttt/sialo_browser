// Upload helper — the SDK's Upload handle does erasure coding,
// encryption, and parallel shard uploads internally, so this is just
// a thin wrapper that reports timing.

import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { connectSdk, getMaxUploads } from './config.js';
import { encodeMetadata } from './object-metadata.js';

async function parallelUpload(file, status, progress, _numWorkers) {
  const sdk = await connectSdk(status);
  if (!sdk) throw new Error('Failed to connect');

  const uploadStart = performance.now();

  if (status) status.textContent = 'Uploading...';
  const pinned = new PinnedObject();
  if (file && typeof file.name === 'string' && file.name.length > 0) {
    pinned.updateMetadata(encodeMetadata({ filename: file.name }));
  }
  const obj = await sdk.upload(pinned, file.stream(), { maxInflight: getMaxUploads() });
  await sdk.pinObject(obj);

  const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
  return { obj, elapsed, size: obj.size(), objectId: obj.id() };
}

export { parallelUpload };
