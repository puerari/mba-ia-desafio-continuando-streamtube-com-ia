---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-20T16:40:00-03:00"
  bullmq:
    version: "^6.3.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-20T16:40:00-03:00"
  ioredis:
    version: "^6.0.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-20T17:20:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1136.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-20T16:40:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1136.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-20T16:40:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T16:41:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries fixed by this phase's decisions. Pulled via Context7 against the versions actually installed in `nestjs-project/`. Re-fetch when the underlying TD changes.

Compatibility was verified against the installed stack before pinning:

| Package | Pinned | Why this version |
|---------|--------|------------------|
| `@nestjs/bullmq` | `^11.0.5` | **Not v12.** v12 is published as `"type": "module"` — its `exports.require` still points at the ESM `dist/index.js`. Node 25 can `require()` it, but ts-jest transpiles specs to CommonJS and Jest then fails with `SyntaxError: Unexpected token 'export'`, taking down every suite that touches the queue. v11.0.5 is CommonJS and its peer range already covers `@nestjs/core ^11` **and** `bullmq ^6`, so nothing is given up. |
| `bullmq` | `^6.3.8` | Latest major, inside `@nestjs/bullmq@11.0.5`'s peer range. Dual-published (`main: ./dist/cjs/index.js`), so it loads cleanly under CommonJS. `engines.node: >=14.17.0`; the container runs Node 25. |
| `ioredis` | `^6.0.0` | **Required explicitly.** `bullmq@6` demoted `ioredis` to an optional peer: without it every queue construction throws `BullMQ could not load the optional 'ioredis' package`. It is not pulled in transitively. |
| `@aws-sdk/client-s3` | `^3.1136.0` | Current v3 line. Modular, first-class TypeScript types, works against MinIO via `endpoint` + `forcePathStyle`. |
| `@aws-sdk/s3-request-presigner` | `^3.1136.0` | Must track the `client-s3` version — the presigner reads the client's resolved config. |

> **Lesson recorded during implementation:** peer-dependency ranges are not enough to pick a version in this project. `nestjs-project` compiles to CommonJS (`tsconfig.json` → `module: nodenext`, emitted as CJS) and Jest transpiles specs the same way, so every dependency must also be **CommonJS-loadable**. Check `"type"` and `main`/`exports` in the candidate's `package.json`, not just `peerDependencies`. The same trap already excluded `nanoid@6` in `phase-03-videos/TD-06`.

Two libraries were evaluated and **rejected**; they must not be reintroduced without superseding the TD that excluded them:

- `fluent-ffmpeg` — npm serves `2.1.3` with a "Package no longer supported" notice and no release in over a year (per `phase-03-videos/TD-05`). Use `child_process.spawn` against the `ffmpeg`/`ffprobe` binaries instead.
- `nanoid` — `nanoid@6` is published as `"type": "module"`; `nestjs-project` compiles to CommonJS (`tsconfig.json` → `module: nodenext`, emitted as CJS), so a plain `import` fails at runtime (per `phase-03-videos/TD-06`). Use `node:crypto` instead.

---

## @nestjs/bullmq + bullmq

**Source:** `/nestjs/bull` and `/taskforcesh/bullmq` (Context7) — both High reputation. Maps to `phase-03-videos/TD-01` Decision A and `phase-03-videos/TD-08`'s retry policy.

`ioredis` must be an explicit dependency: `bullmq@6` loads it lazily as an optional peer and throws `BullMQ could not load the optional 'ioredis' package` at the first `new Queue(...)` if it is absent.

### Root registration

`BullModule.forRootAsync` supplies the Redis connection to every queue and worker in the application. The config comes from a `registerAs` namespace, per the Phase 01 convention.

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    defaultJobOptions: {
      attempts: cfg.attempts,                          // 3 — per TD-08
      backoff: { type: 'exponential', delay: cfg.backoffDelay }, // 5000ms — per TD-08
      removeOnComplete: true,
      removeOnFail: false,                             // keep the failure for inspection
    },
  }),
})
```

`connection` is the BullMQ-style key (v6). The `host`/`port` must be the Compose service name (`redis`), never `localhost` — see the root `CLAUDE.md` § Docker Networking.

### Registering a queue and producing jobs

```typescript
// module
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })

// producer
constructor(
  @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
) {}

await this.queue.add('process-video', { videoId });
```

Per `phase-03-videos/TD-08`, the payload carries **only** `videoId`; the handler re-reads the row. This keeps the job idempotent and tolerates the commit-then-enqueue ordering required by `TD-01` (Redis is not part of the PostgreSQL transaction, so the row must be committed before `add()` is called).

### Consuming: `@Processor` + `WorkerHost`

```typescript
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1, lockDuration: 600_000 })
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    // ...
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    // ...
  }
}
```

`lockDuration` is the key knob for this phase: BullMQ renews a job's lock while the handler runs, but a stalled-detection window shorter than an FFmpeg run makes the queue re-deliver a job that is still being processed. A multi-gigabyte download plus probe plus thumbnail can take minutes, so `lockDuration` must be generous (10 min) and `concurrency` low, since the work is CPU- and IO-bound.

### Detecting *terminal* failure

`worker.on('failed')` fires on **every** failed attempt, not only the last one:

```typescript
worker.on('failed', (job: Job | undefined, error: Error, prev: string) => { /* ... */ });
```

`phase-03-videos/TD-08` requires `processing_error` to be written only when retries are exhausted, so the handler must guard on the attempt counter before flipping the row to `failed`:

```typescript
@OnWorkerEvent('failed')
async onFailed(job: Job | undefined, error: Error): Promise<void> {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;   // transient — a retry is still coming
  await this.videosService.markFailed(job.data.videoId, error.message);
}
```

Without this guard the status column reports `failed` while BullMQ is still retrying — exactly the lie TD-08 sets out to avoid.

### Retry configuration reference

```typescript
await queue.add('test-retry', { foo: 'bar' }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

Per-job options override `defaultJobOptions`. This phase relies on the root defaults so the policy lives in one place.

### Worker-side gotcha in tests

`@Processor` classes start consuming as soon as the Nest context boots. In integration specs that enqueue a job and assert on the row, either build a context **without** the processor (assert the job landed in the queue) or build one **with** it and await the worker's `completed` event — never both in the same spec, or the assertion races the consumer.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation. Maps to `phase-03-videos/TD-02` Decision C, `TD-03` Decision A and `TD-07` Decision A.

### Client against MinIO

```typescript
new S3Client({
  region: cfg.region,                    // MinIO ignores it, but the SDK requires one
  endpoint: cfg.endpoint,                // http://minio:9000 — Compose service name
  forcePathStyle: true,                  // MinIO serves <endpoint>/<bucket>/<key>
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

`forcePathStyle: true` is mandatory: the SDK defaults to virtual-hosted-style (`<bucket>.<endpoint>`), which does not resolve against a MinIO container hostname.

### Multipart upload handshake (TD-02)

Three server-side calls bracket the client's direct part uploads:

```typescript
// 1. init — returns UploadId
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
  Bucket, Key, ContentType,
}));

// 2. one presigned URL per part (PartNumber is 1-based, max 10000)
const url = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// 3. complete — parts must be ordered by PartNumber and carry the ETag
//    the client received in each part-upload response
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"..."' }, /* ... */] },
}));
```

Constraints that shape the contract (from the S3 API, which MinIO implements):

- A single `PutObject` is capped at **5GB** — this is why `TD-02` rejects a one-shot presigned PUT.
- Multipart allows at most **10,000 parts**; every part except the last must be at least **5MiB**.
- With the 64MiB part size chosen in `TD-02`, a 10GiB upload is 160 parts — well inside both limits.
- `getSignedUrl` defaults to `expiresIn: 900` (15 min); the phase passes `3600` explicitly so a slow 64MiB part does not expire mid-flight.
- An aborted handshake leaves parts behind until `AbortMultipartUploadCommand` is called or a lifecycle rule reaps them.

### Range streaming (TD-07)

`GetObjectCommand` accepts the HTTP `Range` header verbatim and answers with the range metadata the API needs to build its `206`:

```javascript
const input = { Bucket: "examplebucket", Key: "SampleFile.txt", Range: "bytes=0-9" };
const response = await client.send(new GetObjectCommand(input));
/* response:
   { AcceptRanges: "bytes", ContentLength: 10, ContentRange: "bytes 0-9/43", ... } */
```

`ContentLength` is the length of the **returned slice**, and `ContentRange` carries `bytes <start>-<end>/<total>` — both map directly onto the response headers of the streaming endpoint. A request with no `Range` returns the whole object and the total length.

### Streaming gotcha — socket exhaustion

From the SDK's own effective-practices guide:

> Although the API call is performed, and you have access to response, the connection will remain open until the byte stream, or payload, is read or discarded. Not doing so will leave the connection open, and in Node.js this can lead to a condition we call socket exhaustion. In the worst cases this can cause your application to slow, leak memory, and/or deadlock.

Each `Body` may be consumed exactly once, in exactly one of three ways:

```typescript
// buffer it
const bytes = await response.Body.transformToByteArray();
// or pipe it somewhere
(response.Body as Readable).pipe(res);
// or discard it
await (response.Body as any).destroy?.();
```

This is load-bearing for the streaming endpoint: if the client aborts mid-playback (a seek, a closed tab), the handler must destroy the storage stream instead of leaving it dangling — otherwise a few dozen abandoned seeks exhaust the API's socket pool. Wire the destruction to the response's `close` event.

### Bucket bootstrap

`HeadBucketCommand` throws `NotFound` when the bucket is absent; the storage service creates it on first use so a fresh `docker compose up` needs no manual MinIO step:

```typescript
try {
  await s3.send(new HeadBucketCommand({ Bucket }));
} catch {
  await s3.send(new CreateBucketCommand({ Bucket }));
}
```

---

## FFmpeg / ffprobe (system binaries, no npm package)

Not an npm dependency — `phase-03-videos/TD-05` installs the `ffmpeg` Debian package in the worker image and invokes the binaries with `child_process.spawn`. Arguments are always passed as an **array**, never interpolated into a shell string, so a filename can never be read as a shell token.

### Metadata extraction

```bash
ffprobe -v error -print_format json -show_format -show_streams <file>
```

Returns a JSON document with `format.duration` (seconds, as a string), `format.bit_rate`, `format.size`, and a `streams` array. The video stream is the entry whose `codec_type === 'video'`, carrying `width`, `height`, `codec_name` and `avg_frame_rate`.

### Thumbnail extraction

```bash
ffmpeg -ss <seconds> -i <file> -frames:v 1 -vf scale=1280:-2 -q:v 2 -y <out.jpg>
```

`-ss` **before** `-i` seeks the input (fast, keyframe-accurate) rather than decoding from the start. `scale=1280:-2` fixes the width and derives an even height, preserving aspect ratio — `-2` rather than `-1` because JPEG encoders require even dimensions. `-q:v 2` is high-quality JPEG. `-y` overwrites the temp file without prompting, which matters because a prompt would hang a non-interactive process forever.

### Test fixture generation

`phase-03-videos/TD-09` synthesizes the fixture clip instead of committing a binary:

```bash
ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p -y <out.mp4>
```

`-pix_fmt yuv420p` keeps the output playable by the same decoders a real upload would use.
