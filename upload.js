// Upload helpers — simplified for sia_storage_wasm.
// The old parallel worker architecture (slab-encode-worker + slab-upload-worker)
// is replaced by the SDK's built-in Upload handle which handles erasure coding,
// encryption, and parallel shard uploads internally.

import { PinnedObject } from './pkg/sia_storage_wasm.js';
import { connectSdk, getMaxUploads } from './config.js';

async function parallelUpload(file, status, progress, _numWorkers) {
  const sdk = await connectSdk(status);
  if (!sdk) throw new Error('Failed to connect');

  const uploadStart = performance.now();

  if (status) status.textContent = 'Uploading...';
  const obj = await sdk.upload(new PinnedObject(), file.stream(), { maxInflight: getMaxUploads() });
  await sdk.pinObject(obj);

  const elapsed = ((performance.now() - uploadStart) / 1000).toFixed(1);
  return { obj, elapsed, size: obj.size(), objectId: obj.id() };
}

// parallelEncodeUpload is now identical to parallelUpload since the SDK
// handles encoding internally.
const parallelEncodeUpload = parallelUpload;

async function encodeOnlyBenchmark(_file, _numWorkers) {
  throw new Error('encodeOnlyBenchmark is not supported with sia_storage_wasm — encoding is handled internally by the SDK');
}

export { parallelUpload, parallelEncodeUpload, encodeOnlyBenchmark };
