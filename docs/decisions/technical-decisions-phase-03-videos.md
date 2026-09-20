---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-20
scope_description: "Backend foundation for video upload and processing: message queue technology, 10GB upload protocol, object storage access and key layout, video worker topology, FFmpeg metadata/thumbnail extraction, unique video URL identifier, streaming/download delivery, status lifecycle and failure policy, and the integration-test strategy for the new infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video module (upload handshake, persistence, streaming, download), the new object-storage and queue integrations, and the video worker that consumes the processing queue.
- `next-frontend/` — Frontend deferred: Phase 03 has no UI capability in `docs/project-plan.md`; the video player and upload screens belong to Fase 04/05. No open decision in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` declares a `Message Queue` container with technology `TBD` — this is the only container in the target architecture whose stack was never chosen. The queue carries video-processing jobs from the API to the Video Worker, so it must survive API restarts, support retries with backoff, and allow the worker to scale independently. This is the phase's primary stack decision and it constrains TD-04 (worker topology) and TD-08 (failure policy).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue with a first-party NestJS integration (`@nestjs/bullmq` 12.x, peer `bullmq ^6`). Producers inject a `Queue`; consumers are `@Processor()` classes extending `WorkerHost`. Adds one Redis container to Compose.
- **Pros:** Official NestJS module — DI, lifecycle and graceful shutdown handled by the framework. Built-in `attempts` + exponential `backoff`, per-job progress, concurrency and `lockDuration` for long jobs, and stalled-job recovery. Job state is isolated from the transactional database, so a long FFmpeg run never competes with API queries.
- **Cons:** Introduces Redis as a new infrastructure dependency and a second durability model to reason about. Job payloads are not transactional with the PostgreSQL write that creates the video row (needs an explicit ordering rule). Redis persistence must be configured deliberately (AOF) to avoid losing queued jobs on restart.

### Option B: pg-boss (PostgreSQL-backed queue)
- Job queue implemented on top of the existing PostgreSQL 17 instance using `SKIP LOCKED` row locking. Requires no new container; pg-boss creates and owns its own schema (`job`, `queue`, `schedule`, `subscription`, `version` tables).
- **Pros:** Zero new infrastructure — reuses the database already in Compose. Jobs can be enqueued inside the same transaction that persists the video row, giving exactly-once semantics without an outbox. Retries, exponential backoff and dead-letter queues are built in.
- **Cons:** Polling workers add sustained query load to the same database that serves API reads. pg-boss owns migrations for its own schema, which sits outside the project's TypeORM migration discipline (two migration systems in one database). No first-party NestJS module — worker wiring is hand-rolled.

### Option C: RabbitMQ (`@nestjs/microservices`)
- Dedicated AMQP broker container. NestJS consumes it through the microservices transport, with the worker as a separate Nest microservice application.
- **Pros:** Purpose-built broker with mature routing, acknowledgements, prefetch control and per-queue dead-lettering. Natural fit if the platform later needs fan-out to several consumers.
- **Cons:** Heaviest operational surface of the three for a single job type. Retry/backoff is not built in — it must be assembled from dead-letter exchanges and TTL queues. No native job-progress or job-state inspection, which the upload UX will want in Fase 04.

**Recommendation:** **Option A (BullMQ + Redis)** — the phase needs exactly what BullMQ gives out of the box (retry with exponential backoff, long `lockDuration` for multi-minute FFmpeg runs, stalled-job recovery, per-job state), and `@nestjs/bullmq` keeps the worker inside the project's DI and graceful-shutdown conventions instead of hand-rolling them. The cost is one Redis container; the benefit is that video processing load never touches the transactional database, which matters because the same PostgreSQL instance serves every API read. The lost property versus pg-boss — enqueue inside the DB transaction — is recovered cheaply by enqueueing only after the transaction commits and by making the job handler re-read the video row (see TD-08).

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: Large-File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must not occupy an API worker, must not be buffered in API memory or disk, and should tolerate a dropped connection. The protocol chosen here is the contract between the future upload UI and the backend, so it is decided once for both sides. A hard constraint settles most of the field: S3 (and MinIO, which implements the same API) caps a **single `PutObject` at 5GB**, while **multipart upload** supports objects up to 5TB across at most 10,000 parts of 5MB–5GB each.

**Options:**

### Option A: Stream the file through the API to storage
- The client POSTs `multipart/form-data` to the API, which pipes the request stream straight into an S3 upload without buffering the whole body.
- **Pros:** Single endpoint, no client-side orchestration, and the API keeps full control over authorization and byte accounting.
- **Cons:** Ties up an API connection and event-loop for the entire transfer (potentially hours at 10GB), doubling egress and making API deploys disruptive. A dropped connection restarts the whole upload. This is the failure mode the phase brief explicitly calls out.

### Option B: Single presigned `PutObject` URL
- The API returns one presigned `PUT` URL; the client uploads the file directly to storage in one request.
- **Pros:** Trivial to implement on both sides. The file never passes through the API.
- **Cons:** **Structurally cannot satisfy the requirement** — a single `PUT` is capped at 5GB, half the required ceiling. No resumability: any interruption discards the entire transfer.

### Option C: Presigned S3 multipart upload orchestrated by the API
- The API creates the multipart upload (`CreateMultipartUpload`), returns a presigned `UploadPart` URL per part, the client uploads parts directly to storage (in parallel, retrying individual parts), then calls the API to `CompleteMultipartUpload` with the collected `ETag`s.
- **Pros:** Supports the full 10GB (and beyond) with parts uploaded directly to storage — no API bandwidth. Per-part retry gives practical resumability. Uses only `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, no extra protocol server. The `complete` call is a natural, authenticated hook to enqueue the processing job.
- **Cons:** Three-step handshake that the client must implement correctly (init → parts → complete). Abandoned uploads leave orphan parts in the bucket until a lifecycle rule or a cleanup routine reaps them.

### Option D: `tus` resumable upload protocol
- Run a tus server (e.g. `@tus/server` with an S3 store) alongside the API; clients use a tus client that resumes byte-exactly after interruption.
- **Pros:** Best-in-class resumability, including across browser sessions. Open protocol with mature client libraries.
- **Cons:** Adds a second HTTP server and its own auth integration to the stack — infrastructure the phase does not otherwise need. Its S3 store internally performs the same multipart upload, so the resilience gain over Option C is incremental while the operational cost is not.

**Recommendation:** **Option C (presigned S3 multipart)** — it is the only option that satisfies the 10GB ceiling without adding a protocol server, and it removes the API from the data path entirely, which is the actual performance requirement. Option B is disqualified by the 5GB single-`PUT` limit and Option A by the "must not tie up the API" constraint; Option D solves a resumability problem the project does not yet have at the cost of a new server. Parameters: part size **64MiB** (160 parts for 10GB, comfortably under the 10,000-part cap and large enough to keep the presigned URL list small), presigned URL TTL **1 hour**, declared `fileSize` validated against a **10GiB** maximum at init time.

**Decision:** C (Presigned S3 multipart orchestrated by the API)

---

## TD-03: Object Storage Client and Bucket/Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage engine is not open — `docs/project-plan.md` and the architecture diagram fix it to S3-compatible storage, realized locally as MinIO in Docker and swappable for AWS S3 in production. What remains open is which client library the backend uses and how objects are organized, since both the API (presigning, streaming) and the Video Worker (reading the source, writing the thumbnail) depend on the same key convention.

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, one bucket with prefixes
- Official AWS SDK v3 pointed at MinIO via `endpoint` + `forcePathStyle: true`. A single bucket (`streamtube`) holds `videos/{videoId}/source{ext}` and `thumbnails/{videoId}/default.jpg`.
- **Pros:** Canonical S3 client — the same code runs against MinIO and AWS with only env changes, which is exactly the stated production path. Modular packages, first-class TypeScript types, and `s3-request-presigner` is required by TD-02 regardless. One bucket means one bootstrap step and one policy to reason about.
- **Cons:** Bundle is heavier than a MinIO-specific client. Mixing videos and thumbnails in one bucket means lifecycle/retention rules must be written against prefixes rather than buckets.

### Option B: `minio` JavaScript client, one bucket with prefixes
- MinIO's own SDK, which also speaks S3 and offers presigned URL helpers.
- **Pros:** Smaller and slightly more ergonomic API for plain operations. Naturally matches the local MinIO container.
- **Cons:** Moving to AWS S3 later means either trusting its S3 compatibility surface or rewriting the storage layer — it works against the project's explicit "swap MinIO for S3 in production" intent. Its multipart presigning support is less aligned with the `CreateMultipartUpload`/`UploadPart`/`Complete` flow TD-02 needs.

### Option C: `@aws-sdk/client-s3` with two buckets (`streamtube-videos`, `streamtube-thumbnails`)
- Same client as Option A, but source media and derived thumbnails live in separate buckets.
- **Pros:** Clean separation of retention, quota and future public/private policy — thumbnails are cheap and cacheable, sources are large and private. Bucket-level lifecycle rules need no prefix conditions.
- **Cons:** Two buckets to create and keep in sync across environments, two config keys, and two code paths in the worker. The separation buys nothing in Phase 03, where both are private and served through the API.

**Recommendation:** **Option A (AWS SDK v3, single bucket with prefixes)** — the SDK choice follows directly from the documented production path (MinIO now, S3 later) and from TD-02, which already requires `s3-request-presigner`. A single bucket keeps bootstrap to one `CreateBucket` call; the `videos/` and `thumbnails/` prefixes preserve the separation that Option C buys with a bucket, and splitting them later is a configuration change, not a redesign. Both prefixes stay private in this phase — delivery goes through the API (TD-07).

**Decision:** A (AWS SDK v3, single bucket with `videos/` and `thumbnails/` prefixes)

---

## TD-04: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The architecture diagram models the Video Worker as a container distinct from the API, reading from the queue and writing to storage and the database. FFmpeg is a heavy native dependency that the API does not need, and video processing is CPU-bound work that must not degrade API latency. How the worker is packaged determines the Compose topology, the Docker image, and how much of the existing NestJS code it can reuse.

**Options:**

### Option A: Separate Compose service, same NestJS codebase, dedicated bootstrap
- A `video-worker` service built from a worker Dockerfile (Node + FFmpeg) that runs a second entrypoint (`worker.main.ts`) booting a trimmed Nest application context containing only the modules the worker needs.
- **Pros:** Matches the target architecture — the worker is its own container and scales independently. Reuses entities, config namespaces, storage service and DI without duplication. FFmpeg is installed only in the worker image, keeping the API image lean. A crash or OOM in processing cannot take down the API.
- **Cons:** Two images and two bootstraps to maintain. Module wiring must be explicit about what the worker loads, or it silently drags in HTTP concerns.

### Option B: Processor registered inside the API application
- The `@Processor()` class lives in the API process; `docker compose up` runs one Node container that both serves HTTP and consumes jobs.
- **Pros:** Simplest possible setup — one image, one bootstrap, no extra service.
- **Cons:** Contradicts the architecture diagram's separate worker container. FFmpeg processes compete with HTTP request handling for CPU in the same container, which is precisely the "processing must not block the user" concern in `docs/project-plan.md` § Pontos de Atenção. Scaling the worker means scaling the API.

### Option C: Standalone worker project outside `nestjs-project/`
- A separate Node/TypeScript package with its own `package.json`, consuming the same queue and database.
- **Pros:** Hardest boundary between API and worker; each can adopt dependencies independently.
- **Cons:** Entities, migrations and config would be duplicated or require a shared package — monorepo tooling the repository does not have. Highest cost for a worker that shares the whole domain model with the API.

**Recommendation:** **Option A (separate service, shared codebase, dedicated bootstrap)** — it is the only option that satisfies the architecture diagram's container boundary while keeping a single source of truth for entities, migrations and config. `NestFactory.createApplicationContext()` gives a DI container without an HTTP server, so the worker reuses `VideosModule`'s storage and repository providers directly. Option B is rejected on the phase's own non-functional requirement; Option C pays monorepo-tooling cost for isolation the project does not need.

**Decision:** A (Separate Compose service, shared codebase, dedicated bootstrap)

---

## TD-05: FFmpeg Integration for Metadata and Thumbnail Extraction

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration, resolution, codec and bitrate from an uploaded file and produce a JPEG thumbnail from a representative frame. The source object lives in S3/MinIO, not on a local disk, so the integration choice also determines whether the worker streams from storage or stages the file locally.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` directly via `child_process`
- The worker image installs the `ffmpeg` package (which ships `ffprobe`). Metadata comes from `ffprobe -v error -print_format json -show_format -show_streams`; the thumbnail from `ffmpeg -ss <t> -i <src> -frames:v 1 -vf scale=... -y out.jpg`.
- **Pros:** No third-party wrapper to go stale — the contract is FFmpeg's own CLI, which is stable and exhaustively documented. `ffprobe`'s JSON output parses directly into a typed result. Full control over arguments, stdio and process timeouts, and arguments are passed as an array so no shell interpolation is involved.
- **Cons:** The project owns the argument construction and stderr/exit-code handling itself. Requires a small, tested wrapper module rather than an off-the-shelf API.

### Option B: `fluent-ffmpeg` wrapper
- Long-standing fluent JavaScript API over the FFmpeg CLI (`ffmpeg(input).screenshots({...})`, `ffmpeg.ffprobe(...)`).
- **Pros:** Ergonomic, widely used API with helpers such as `screenshots()` that cover thumbnail generation in a few lines.
- **Cons:** **Unmaintained** — npm serves `fluent-ffmpeg@2.1.3` with a "Package no longer supported" notice and there have been no releases in over a year as of 2026-09. Adopting a deprecated package for a brand-new phase creates immediate technical debt. Its callback-based API also needs promisification throughout.

### Option C: `ffmpeg.wasm`
- WebAssembly build of FFmpeg running inside the Node process, no native binary required.
- **Pros:** No system dependency in the image; identical behaviour across platforms.
- **Cons:** Substantially slower than native FFmpeg and memory-bound — unworkable for multi-gigabyte inputs. Designed for browser use cases, not server-side batch processing.

**Recommendation:** **Option A (direct `child_process` spawn)** — Option B is disqualified by its deprecation and Option C by the file sizes involved, which leaves the CLI contract as both the most robust and the lowest-dependency choice. The worker downloads the source object to a temporary file before probing (rather than streaming), because `ffprobe` needs random access to read container metadata reliably and seeking to a frame with `-ss` over a network stream is unreliable; the temp file is removed in a `finally` block. Thumbnail policy: frame at **10%** of duration (avoiding black lead-in frames), scaled to **1280×720** preserving aspect ratio, encoded as JPEG quality 2.

**Decision:** A (Direct `child_process` spawn of `ffprobe`/`ffmpeg`)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, URL-safe public identifier that never collides — `docs/project-plan.md` § Pontos de Atenção calls for "uma URL curta e única que nunca conflite com outro vídeo". The identifier appears in the watch URL, the streaming endpoint and the download endpoint, so it is the public key of the resource and is decided before any endpoint is written. The internal primary key stays a UUID, consistent with every other entity in the project.

**Options:**

### Option A: Expose the entity's UUID
- The `id` UUID already generated by `@PrimaryGeneratedColumn('uuid')` doubles as the public identifier.
- **Pros:** Zero extra column, zero extra code, collision probability already negligible. No second lookup path to maintain.
- **Cons:** 36 characters in every URL — the opposite of "curta". Exposes the internal primary key in public URLs, coupling the public contract to the storage key.

### Option B: `nanoid`
- Generate an 11-character URL-safe id stored in a dedicated unique column.
- **Pros:** Purpose-built, well-audited generator with a favourable collision profile at this length. Short, opaque, YouTube-like URLs.
- **Cons:** **Incompatible with the project's build** — `nanoid@6` is published as `"type": "module"` (ESM-only) while `nestjs-project` compiles to CommonJS, so a plain `import` fails at runtime and would require a dynamic-import workaround or pinning the abandoned v3 line. Adds a dependency for roughly ten lines of code.

### Option C: Custom slug from `crypto.randomBytes` with a unique column and retry
- An 11-character identifier drawn from a 64-symbol URL-safe alphabet using Node's `crypto.randomBytes`, persisted in a unique `slug` column; a unique-violation (`23505`) triggers regeneration, bounded by a retry limit.
- **Pros:** Same shape and entropy as Option B (64¹¹ ≈ 7.4 × 10¹⁹ values) with no dependency and no ESM problem. The database unique constraint — not probability — is what actually guarantees "sem conflito", and the retry makes that guarantee explicit and testable. Mirrors the nickname-collision pattern already established by `phase-02-auth/TD-10`.
- **Cons:** A small amount of project-owned code to write and unit-test. Uniform sampling over a 64-symbol alphabet must be done correctly (mask-and-reject or a byte count that divides evenly) rather than with a naive modulo.

**Recommendation:** **Option C (custom `crypto.randomBytes` slug)** — Option B's ESM-only packaging is a hard blocker for a CommonJS NestJS build, and Option A fails the "short URL" requirement outright. Option C delivers Option B's ergonomics for about ten lines of dependency-free code, and it reuses the collision-retry pattern the codebase already established for channel nicknames in Phase 02, so the approach is consistent rather than novel. The database unique index is the authoritative guarantee.

**Decision:** C (Custom `crypto.randomBytes` slug + unique column with collision retry)

---

## TD-07: Video Delivery — Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and the same stored object must also be downloadable. This is one delivery contract with two presentations, and it is cross-layer because the player's seeking behaviour and the download trigger both depend on the response shape the backend commits to. Fase 04 adds `public`/`unlisted` visibility on top of these endpoints, so where authorization can be enforced is part of the decision.

**Options:**

### Option A: API endpoints that forward HTTP `Range` to storage and pipe the response
- `GET /videos/:slug/stream` reads the `Range` header, issues `GetObject` with the same range, and replies `206 Partial Content` with `Content-Range`/`Accept-Ranges`, piping the storage body to the client. `GET /videos/:slug/download` is the same path with `Content-Disposition: attachment` and no range requirement.
- **Pros:** Authorization stays in the API, which is where visibility rules land in Fase 04 — the storage bucket never has to be public. The API streams rather than buffers: it forwards the range and pipes, so memory stays bounded regardless of file size. Native `<video>` seeking works because ranges are honoured end to end. Directly matches the `206 Partial Content` approach the phase brief points at.
- **Cons:** Video bytes traverse the API, consuming its bandwidth and one connection per viewer — the component the architecture otherwise keeps out of the data path. A CDN cannot cache responses without extra work.

### Option B: Redirect to a presigned `GetObject` URL
- The endpoint answers `302` with a short-lived presigned URL; the browser performs its range requests straight against storage.
- **Pros:** Zero bandwidth through the API and it matches the diagram's `Frontend → Object Storage: Streams` edge. Range support comes free from S3/MinIO. Natural fit for a CDN in front of the bucket.
- **Cons:** Authorization is enforced only at redirect time — once issued, the URL is bearer-capable until it expires, which is a weak fit for the `unlisted` semantics arriving in Fase 04. Download naming requires threading `response-content-disposition` through the signature. Two origins complicate CORS for the player.

### Option C: HLS packaging (segment + playlist) in the worker
- The worker transcodes each upload into HLS segments and a manifest; the player fetches the playlist and segments.
- **Pros:** Industry standard for adaptive delivery; segments cache well and start-up latency is excellent.
- **Cons:** Far beyond the phase's scope — `docs/project-plan.md` asks for duration/metadata extraction and a thumbnail, not transcoding. Multiplies processing time and storage per video and would make the worker the critical path for every upload.

**Recommendation:** **Option A (API `Range` proxy)** — it is the only option that keeps authorization in the API, which is decisive because Fase 04 introduces per-video visibility that a long-lived presigned URL cannot express. The bandwidth objection is real but acceptable at this stage and does not compromise correctness: the API forwards the range and pipes the body, so it never holds a large file in memory. Option C is out of scope for this phase. Option B remains the natural production evolution once a CDN sits in front of storage, and switching to it later changes only the controller, not the data model. Parameters: `Accept-Ranges: bytes` advertised on both endpoints; a request without a `Range` header returns `200` with the full body; an unsatisfiable range returns `416`; only videos in `ready` status are served.

**Decision:** A (API `Range` proxy returning 206 Partial Content)

**Revisions:**
- 2026-09-20 — Phase 03 access level pinned: `GET /videos/:slug`, `GET /videos/:slug/stream` and `GET /videos/:slug/download` are `@Public()` and serve only videos in `ready` status; the upload handshake and the owner's listing stay authenticated. Rationale: resolves `AMB-2` from `validation.md`. `docs/project-plan.md` § Visão Geral grants anonymous playback, and Phase 03 has no visibility column to authorize against — per-video `público`/`unlisted` narrowing arrives with Fase 04's visibility capability, which will tighten these same endpoints without changing their shape.

---

## TD-08: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video row is created before its bytes exist (the pre-registration at upload start) and becomes playable only after the worker succeeds. The set of states, who may write each transition, and what happens when FFmpeg fails are a cross-component contract between the API, the worker and the future UI — they cannot be re-derived at implementation time. The phase brief fixes the broad shape as `rascunho → processando → pronto/erro`.

**Options:**

### Option A: Four states — `draft → processing → ready | failed` — with retries and a terminal failure
- `draft` on upload init; `processing` when the client completes the upload and the job is enqueued; `ready` on success; `failed` after BullMQ exhausts its attempts, with the reason stored on the row.
- **Pros:** Maps one-to-one onto the states the brief names, so the UI can label them directly. Distinguishes "never finished uploading" (`draft`) from "upload done, processing" (`processing`) — the two need different UI and different cleanup. Retries stay invisible to the model: only terminal failure is persisted, so the status column never lies about a transient error.
- **Cons:** A video abandoned mid-upload stays `draft` forever until a cleanup routine reaps it. Does not distinguish "upload in progress" from "created but never started".

### Option B: Two states — `pending → ready` — with errors only in logs
- The row is `pending` until the worker marks it `ready`; failures are observable only through logs and queue inspection.
- **Pros:** Minimal schema and no failure semantics to design.
- **Cons:** The owner cannot see that their upload failed, which contradicts the brief's explicit `pronto/erro` requirement. Indistinguishable from a slow job, so no UI can ever offer a retry.

### Option C: Six states — `draft → uploading → uploaded → processing → ready | failed`
- Adds explicit `uploading` and `uploaded` states around the transfer.
- **Pros:** Finest-grained progress reporting; makes stalled-upload detection trivial.
- **Cons:** `uploading` cannot be maintained truthfully — parts go straight from the client to storage, so the API only learns about progress at `complete`. Encodes states the system cannot actually observe, which is worse than not modelling them.

**Recommendation:** **Option A (four states)** — it matches the brief exactly and each state corresponds to something the backend can actually observe, which Option C's `uploading` does not. Option B is ruled out by the explicit `pronto/erro` requirement. Failure policy: **3 attempts** with exponential backoff starting at 5s; the failure reason is persisted to `processing_error` only when attempts are exhausted (via BullMQ's `failed` event guarded on `attemptsMade >= attempts`), so a transient error never surfaces as a terminal state. The job carries only the `videoId` and the handler re-reads the row, which keeps the handler idempotent and immune to the commit-then-enqueue ordering noted in TD-01.

**Decision:** A (`draft → processing → ready | failed`, 3 attempts with exponential backoff)

**Revisions:**
- 2026-09-20 — Pre-registration payload pinned: upload init requires `title` (1–200 chars) plus the client-declared `filename`, `size_bytes` and `content_type`; no filename-derived default is generated. Rationale: resolves `AMB-1` from `validation.md`. Fase 04 owns "Edição das informações do vídeo", so Phase 03 persists a titled draft rather than inventing a title-generation rule that Fase 04 would immediately have to undo.

---

## TD-09: Integration Test Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Phase 03 adds three runtime dependencies the existing suite has never exercised: an object store, a queue and a subprocess that shells out to FFmpeg. The project's testing convention (`nestjs-project/CLAUDE.md`, `.claude/rules/nestjs-testing.md`) already separates unit specs from integration specs that hit real services, and Phase 02 set the precedent by testing against the real PostgreSQL and the real Mailpit container. How far that precedent extends to the new services determines what the integration suite can actually prove.

**Options:**

### Option A: Exercise the real Compose services from integration specs
- `*.integration-spec.ts` runs against the MinIO and Redis containers already in Compose, exactly as Phase 02's specs run against `db` and `mailpit`. FFmpeg is invoked for real against a tiny fixture clip generated at test time.
- **Pros:** Consistent with the established convention and with the brief's "não simule o que dá para testar de verdade com a infra do Compose". Catches the failures that actually happen — presigned URL signature mismatches, path-style addressing, range semantics, FFmpeg argument errors — none of which a mock can reproduce. A generated fixture keeps the repository free of binary test assets.
- **Cons:** Integration specs need the full stack running, and the suite must clean buckets and queues between runs to stay repeatable.

### Option B: Mock the S3 client and the queue at the module boundary
- Storage and queue are replaced by in-memory fakes via `overrideProvider` in every spec.
- **Pros:** Fast and hermetic; no infrastructure needed to run the suite.
- **Cons:** Tests the fake, not the integration — precisely the class of bug this phase is most exposed to. Explicitly discouraged by the phase brief and inconsistent with how Phase 02 tests email.

### Option C: Testcontainers — spin up MinIO and Redis per test run
- Each run programmatically starts throwaway containers.
- **Pros:** Perfect isolation and no dependency on a developer's running stack.
- **Cons:** Introduces a container-management dependency and requires Docker socket access from inside the API container (Docker-in-Docker), which the current Compose setup does not grant. It would also diverge from the already-working pattern for `db` and `mailpit`.

**Recommendation:** **Option A (real Compose services)** — it extends the pattern Phase 02 already proved with PostgreSQL and Mailpit, and it is what the phase brief requires. Option C's isolation is genuinely better in the abstract but needs Docker-in-Docker, which the current topology does not provide. Unit specs keep mocking the storage and queue ports to test branching logic in isolation; integration specs use the real services; a fixture clip is synthesized with FFmpeg's `testsrc` source at setup time so no binary blob enters the repository.

**Decision:** A (Real MinIO / Redis / FFmpeg from Compose)

---

## TD-10: Lint Gate Repair for Mock-Heavy Test Files

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)" — the phase cannot be declared done without a passing lint gate, and every SI that ships a spec file inherits this configuration.

**Context:** The project's Definition of Done requires `npm run lint` to exit 0, but it does not on the inherited `dev` branch: ESLint reports **190 problems (150 errors)**. The breakdown matters — 143 of the errors are in `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts` files and come from four rules that fire on ordinary Jest patterns (`no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-return`, `unbound-method`); only 7 are in non-test sources. Phase 03 adds a substantial number of new spec files, so whatever is decided here applies to every test written from now on. `eslint.config.mjs` already establishes the precedent of tuning severities deliberately — it downgrades `no-unsafe-argument` to `warn` project-wide.

**Options:**

### Option A: Fix the 7 source errors properly; scope a test-file override for the mock-driven rules
- Narrow the `any` in `channels.service.ts` and `create-test-data-source.ts` with real type guards and precise signatures. Add one `eslint.config.mjs` block matching test files that downgrades `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-return`, `no-unsafe-call` and `unbound-method` to `warn`, leaving every other rule — including `no-unused-vars` — at full strength.
- **Pros:** Production code keeps full type-safety enforcement, which is where these rules earn their keep. Recognizes that `unbound-method` is a documented false positive on `jest.fn()` mocks and that `any`-typed mocks are intrinsic to `overrideProvider` testing. One reviewable config change plus two small, genuine type fixes.
- **Cons:** Test files lose a class of type checking, so a real `any` leak in a spec now surfaces as a warning rather than an error.

### Option B: Rewrite all 143 test-file violations to satisfy the rules as configured
- Introduce typed mock helpers (`jest.Mocked<T>`) and explicit casts throughout the Phase 01/02 suites.
- **Pros:** Keeps a single strict configuration for the whole repository with no per-path exceptions.
- **Cons:** A very large mechanical change across Phase 02 test files — well outside this phase's scope and directly against the `CLAUDE.md` § Scope Limits rule against mixing scopes. High regression risk in a suite that is currently green, for no behavioural gain.

### Option C: Exclude test files from linting entirely
- Add the spec globs to ESLint's `ignores`.
- **Pros:** Makes the gate pass immediately with a one-line change.
- **Cons:** Abandons Prettier formatting, `no-unused-vars` and every other genuinely useful check on a large and growing share of the codebase. Trades a real quality signal for convenience.

**Recommendation:** **Option A (fix sources, scope a test-file override)** — it restores the DoD gate that the phase is graded on while keeping strict enforcement exactly where it matters. Option B is the "purest" answer but is a large refactor of Phase 02 code that `CLAUDE.md` § Scope Limits explicitly forbids mixing into a feature phase; Option C gives up too much. The 7 non-test errors are fixed rather than suppressed, so no production-code strictness is traded away.

**Decision:** A (Fix the 7 source errors, scope a test-file override)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A (BullMQ + Redis via `@nestjs/bullmq`) | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-02 | Cross-layer | Large-File Upload Protocol (up to 10GB) | C (Presigned S3 multipart orchestrated by the API) | C (Presigned S3 multipart orchestrated by the API) |
| TD-03 | Backend | Object Storage Client and Bucket/Key Layout | A (AWS SDK v3, single bucket with prefixes) | A (AWS SDK v3, single bucket with `videos/` and `thumbnails/` prefixes) |
| TD-04 | Backend | Video Worker Runtime Topology | A (Separate Compose service, shared codebase, dedicated bootstrap) | A (Separate Compose service, shared codebase, dedicated bootstrap) |
| TD-05 | Backend | FFmpeg Integration for Metadata and Thumbnail | A (Direct `child_process` spawn of `ffprobe`/`ffmpeg`) | A (Direct `child_process` spawn of `ffprobe`/`ffmpeg`) |
| TD-06 | Backend | Unique Video URL Identifier | C (Custom `crypto.randomBytes` slug + unique column) | C (Custom `crypto.randomBytes` slug + unique column with collision retry) |
| TD-07 | Cross-layer | Video Delivery — Streaming and Download | A (API `Range` proxy returning 206 Partial Content) | A (API `Range` proxy returning 206 Partial Content) |
| TD-08 | Backend | Video Status Lifecycle and Failure Policy | A (`draft → processing → ready \| failed`, 3 attempts) | A (`draft → processing → ready | failed`, 3 attempts with exponential backoff) |
| TD-09 | Backend | Integration Test Strategy for New Infrastructure | A (Real MinIO/Redis/FFmpeg from Compose) | A (Real MinIO / Redis / FFmpeg from Compose) |
| TD-10 | Repo-wide | Lint Gate Repair for Mock-Heavy Test Files | A (Fix source errors, scope a test-file override) | A (Fix the 7 source errors, scope a test-file override) |
