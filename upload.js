// Upload helpers — simplified for sia_storage_wasm.
// The old parallel worker architecture (slab-encode-worker + slab-upload-worker)
// is replaced by the SDK's built-in Upload handle which handles erasure coding,
// encryption, and parallel shard uploads internally.

import { UploadOptions } from './pkg/sia_storage_wasm.js';
import { connectSdk, getMaxUploads } from './config.js';

const CHUNK_SIZE = 128 * 1024 * 1024; // 128 MiB

async function parallelUpload(file, status, progress, _numWorkers) {
  const sdk = await connectSdk(status);
  if (!sdk) throw new Error('Failed to connect');

  const upload = sdk.upload(new UploadOptions(null, null, getMaxUploads()));
  const uploadStart = performance.now();

  upload.setOnProgress((shards) => {
    if (progress) progress.value = shards;
    if (status) status.textContent = `Uploading... ${shards} shards`;
  });

  const fileSize = file.size;
  for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    const data = new Uint8Array(await chunk.arrayBuffer());
    await upload.pushChunk(data);
  }
  const obj = await upload.finish();
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
