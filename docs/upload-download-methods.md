# Upload & Download Methods

The Sia Browser demo offers multiple upload and download strategies, each with different tradeoffs between speed, UI responsiveness, and resource usage.

## Upload Methods

### Single-threaded

All work happens on the main thread in a single SDK instance: reading the file, erasure coding, encryption, and uploading shards to hosts.

**Pros**
- Fastest overall throughput for most file sizes — one connection pool with no contention, no data transfer overhead between threads
- Simplest architecture — one SDK, one connection pool, one set of host connections
- Connection reuse across slabs — WebTransport connections to hosts persist and are shared across all shard uploads

**Cons**
- Blocks the main thread — UI becomes unresponsive during uploads, Chrome may show "page unresponsive" warnings on large files
- No parallelism for CPU-bound work (erasure coding, encryption)

**Best for:** Small to medium files where upload speed matters more than UI responsiveness.

### Web Workers

Multiple web workers (configurable, default 8) each initialize their own SDK instance and upload slabs independently in parallel.

**Pros**
- UI stays responsive — all work happens off the main thread
- True parallelism — multiple slabs encode and upload simultaneously across workers

**Cons**
- Each worker creates its own SDK with its own connection pool, leading to redundant WebTransport connections to the same hosts
- Chrome limits concurrent WebTransport sessions to 64 — with 8 workers each connecting to ~30 hosts, this limit is frequently hit, causing connection failures and retries
- Slower overall throughput than single-threaded for small/medium files due to worker initialization overhead and session contention
- Higher memory usage — 8 copies of the WASM module loaded in memory

**Best for:** Large files (1 GB+) where the parallelism benefits outweigh the connection overhead, and UI responsiveness is important.

### Encode Workers

A hybrid approach: workers handle the CPU-bound compute (erasure coding + encryption), while a single SDK on the main thread handles all network I/O.

**Pros**
- One connection pool — no WebTransport session contention, connections reused across all shard uploads
- Erasure coding and encryption parallelized across workers
- Workers don't need to initialize the full SDK or create network connections

**Cons**
- Encrypted shard data must be transferred from workers back to the main thread via `postMessage` (~120 MB per slab), adding overhead
- Network I/O on the main thread can cause brief UI pauses during shard uploads
- Slower than single-threaded for most file sizes because the data transfer overhead exceeds the compute parallelism benefit

**Best for:** Very large files on machines with slow CPUs where erasure coding is the bottleneck, not the network.

## Download Methods

### Web Workers

Multiple web workers (configurable, default 8) each initialize their own SDK instance and download slabs independently in parallel.

**Pros**
- Fastest download speed — multiple slabs download simultaneously, each worker can start decoding as soon as its 10-of-30 sectors arrive
- UI stays fully responsive
- Early termination per slab — only needs 10 of 30 sectors, so slow hosts don't block progress as badly as in uploads

**Cons**
- Same WebTransport session contention as upload web workers (multiple connection pools competing for 64 sessions)
- Higher memory usage from multiple SDK instances

**Best for:** All file sizes. This is the recommended download method.

### Single Worker

One dedicated web worker runs a single SDK instance and downloads all slabs sequentially.

**Pros**
- UI stays responsive (network I/O off the main thread)
- One connection pool — no session contention, clean connection reuse
- Lower memory usage than 8 workers

**Cons**
- Significantly slower than web workers (~3x slower in testing) because slabs download sequentially instead of in parallel
- Only one slab downloads at a time

**Best for:** Debugging, benchmarking, or environments where WebTransport session limits are a concern.

## Benchmark Results (114.5 MB file)

| Method | Time | File Speed | Wire Speed (3x redundancy) |
|--------|------|-----------|---------------------------|
| Upload: Single-threaded | 94.9s | 1.21 MB/s | 3.62 MB/s |
| Upload: Web Workers (8) | 320.5s | 0.36 MB/s | 1.07 MB/s |
| Upload: Encode Workers (8) | 240.0s | 0.48 MB/s | 1.43 MB/s |

## Benchmark Results (1.89 GB file)

| Method | Time | File Speed | Wire Speed (3x redundancy) |
|--------|------|-----------|---------------------------|
| Upload: Single-threaded | 722.9s | 2.68 MB/s | 7.84 MB/s |
| Upload: Encode Workers (8) | 1327.6s | 1.46 MB/s | 4.37 MB/s |
| Download: Web Workers (8) | 78.9s | 24.5 MB/s | — |
| Download: Single Worker | 231.7s | 8.16 MB/s | — |

## Configuration

- **Max Uploads / Max Downloads**: Controls the `max_inflight` semaphore — how many shards upload or download concurrently within a single SDK instance. Higher values use more connections but improve throughput. Default: 8.
- **Upload Workers / Download Workers**: Number of web workers to spawn for the web workers method. More workers = more parallelism but more connection contention. Default: 8.

## Key Insight

Upload and download have opposite optimal strategies:
- **Uploads** are faster single-threaded because connection pool sharing and avoiding session contention outweighs the lack of compute parallelism.
- **Downloads** are faster with web workers because slab-level parallelism dramatically reduces total time, and the per-slab network cost is lower (only 10 sectors needed vs 30 for uploads).
