---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T16:13:24-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T16:38:32-03:00"
  docs/phases/phase-03-videos/context.md: "2026-09-20T16:39:48-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-20T16:39:34-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-20T16:13:24-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video pipeline end to end: a presigned multipart handshake that carries files up to 10GB straight to object storage without passing through the API, a draft pre-registration created at upload start, a dedicated FFmpeg worker that extracts metadata and generates a thumbnail from a background queue, a short unique URL per video, and range-based streaming plus download — establishing the storage, queue and worker infrastructure that Fases 04–07 build on.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Compose Infrastructure

**Description:** Install the phase's production dependencies, create the `storage`, `queue` and `video` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema and `.env.example`, and add the MinIO, Redis and video-worker services to Docker Compose together with the worker image.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.8`, `@aws-sdk/client-s3@^3.1136.0`, `@aws-sdk/s3-request-presigner@^3.1136.0` (versions and compatibility fixed in `library-refs.md`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'http://minio:9000'`), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube'`), `STORAGE_FORCE_PATH_STYLE` (boolean, default `true`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `VIDEO_QUEUE_ATTEMPTS` (number, default `3`), `VIDEO_QUEUE_BACKOFF_MS` (number, default `5000`), `VIDEO_QUEUE_LOCK_DURATION_MS` (number, default `600000`), `VIDEO_QUEUE_CONCURRENCY` (number, default `1`)
- Create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_SIZE_BYTES` (number, default `10737418240` = 10GiB), `VIDEO_UPLOAD_PART_SIZE_BYTES` (number, default `67108864` = 64MiB), `VIDEO_UPLOAD_URL_TTL_SECONDS` (number, default `3600`), `VIDEO_THUMBNAIL_POSITION_RATIO` (number, default `0.1`), `VIDEO_THUMBNAIL_WIDTH` (number, default `1280`) — values per `phase-03-videos/TD-02` and `phase-03-videos/TD-05`
- Update `src/config/env.validation.ts` with every new variable (secrets required, the rest with defaults) and register the three namespaces in `AppModule`'s `ConfigModule.forRoot({ load: [...] })`. Mirror all of them in `.env.example`
- Add to `nestjs-project/compose.yaml`: a `minio` service (`minio/minio`, `command: server /data --console-address ":9001"`, root user/password `streamtube`, named volume `minio-data:/data`, healthcheck `curl -f http://localhost:9000/minio/health/live`, ports `9000:9000` and `9001:9001` for the console) and a `redis` service (`redis:8-alpine`, `command: redis-server --appendonly yes` so queued jobs survive a restart per `phase-03-videos/TD-01`, named volume `redis-data:/data`, healthcheck `redis-cli ping`). **Redis publishes no host port** — nothing on the host consumes it and leaving it unpublished avoids colliding with a developer's existing Redis
- Add the `video-worker` service to `compose.yaml` — built from a new `Dockerfile.worker` (`FROM node:25.6.0-slim`, `apt-get install -y ffmpeg procps`, same `WORKDIR`/`USER node` as `Dockerfile.dev`), bind-mounting the project like `nestjs-api`, `depends_on` `db`/`redis`/`minio` with `condition: service_healthy`, and `command: npm run start:worker:dev`
- Extend `nestjs-api`'s `depends_on` with `redis` and `minio` (both `service_healthy`)
- Add npm scripts: `start:worker` (`node dist/worker.main`) and `start:worker:dev` (`nest start --watch --entryFile worker.main`)

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `nestjs-api`, `db`, `mailpit`, `minio`, `redis` and `video-worker`; `docker compose ps` shows every service running and the three with healthchecks reporting healthy
- `docker compose exec minio curl -f http://localhost:9000/minio/health/live` succeeds and the MinIO console answers on `http://localhost:9001`
- `docker compose exec redis redis-cli ping` returns `PONG`
- `docker compose exec video-worker ffmpeg -version` and `ffprobe -version` both succeed — the worker image carries the binaries the API image does not
- Starting the API without `STORAGE_ACCESS_KEY` fails at bootstrap with a Joi validation error — the app does not start
- The existing suite still passes: no Phase 01/02 behaviour changes

---

### SI-03.2 — Storage Module: S3/MinIO Adapter

**Description:** Create a `StorageModule` exposing a `StorageService` that wraps the S3 client for every operation the phase needs — bucket bootstrap, presigned multipart handshake, ranged reads, object writes and deletes. This is the single seam between the domain and object storage, so both the API and the worker depend on it rather than on the SDK.

**Technical actions:**

- Create `src/storage/storage.constants.ts` — export `S3_CLIENT` injection token and the key builders `videoSourceKey(videoId, extension)` → `videos/{videoId}/source{ext}` and `videoThumbnailKey(videoId)` → `thumbnails/{videoId}/default.jpg`, per `phase-03-videos/TD-03`
- Create `src/storage/storage.module.ts` — provides `S3_CLIENT` via a factory injecting `storageConfig.KEY` that builds `new S3Client({ region, endpoint, forcePathStyle, credentials })`; provides and exports `StorageService`
- Create `src/storage/storage.service.ts` — `StorageService` injecting `S3_CLIENT` and `storageConfig`. Implement:
  - `ensureBucket(): Promise<void>` — `HeadBucketCommand`, and on failure `CreateBucketCommand`; called from `onModuleInit` so a fresh stack needs no manual MinIO step
  - `createMultipartUpload(key, contentType): Promise<string>` — returns `UploadId`
  - `getPresignedPartUrls(key, uploadId, partCount, expiresIn): Promise<{ partNumber: number; url: string }[]>` — one `getSignedUrl(UploadPartCommand)` per part, `PartNumber` 1-based
  - `completeMultipartUpload(key, uploadId, parts): Promise<void>` — parts sorted by `partNumber`, mapped to `{ PartNumber, ETag }`
  - `abortMultipartUpload(key, uploadId): Promise<void>`
  - `getObjectStream(key, range?): Promise<{ stream: Readable; contentLength: number; contentRange?: string; totalLength: number; contentType?: string }>` — `GetObjectCommand` with the caller's `Range` string forwarded verbatim; derives `totalLength` from `ContentRange` (`bytes a-b/total`) when ranged, otherwise from `ContentLength`
  - `putObject(key, body, contentType): Promise<void>` and `deleteObject(key): Promise<void>` and `objectExists(key): Promise<boolean>`
  - `downloadToFile(key, destPath): Promise<void>` — pipes the object body to a local file, used by the worker per `phase-03-videos/TD-05`
- Errors propagate — no catch-and-return-null, per `.claude/rules/nestjs-services.md`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against the real MinIO container: `ensureBucket` is idempotent; a multipart upload of 2 parts (5MiB + remainder) initialises, presigns, uploads via the presigned URLs and completes into a readable object; `getObjectStream` with `Range: bytes=0-9` returns 10 bytes and a `contentRange` of `bytes 0-9/<total>`; `getObjectStream` without a range returns the whole object; `deleteObject` followed by `objectExists` returns false |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with the `S3_CLIENT` factory and `StorageService` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `ensureBucket()` creates the bucket on a fresh MinIO volume and is a no-op on the second call
- A file larger than the 5MiB minimum part size uploads successfully through `createMultipartUpload` → presigned `UploadPart` → `completeMultipartUpload`, and the resulting object's byte length equals the source
- `getObjectStream(key, 'bytes=0-9')` returns exactly 10 bytes, `contentLength` 10, and a `contentRange` whose total matches the full object size
- `getObjectStream(key)` with no range returns the full object and reports the full `contentLength`
- All storage operations use the Compose service name (`minio`) as host — no `localhost` in config or code

---

### SI-03.3 — Unique Video Slug Generator

**Description:** Implement the URL-safe public identifier generator decided in `phase-03-videos/TD-06` — an 11-character slug drawn uniformly from a 64-symbol alphabet using `node:crypto`, with no external dependency.

**Technical actions:**

- Create `src/videos/video-slug.util.ts` — export `VIDEO_SLUG_ALPHABET` (64 URL-safe symbols: `A-Za-z0-9_-`), `VIDEO_SLUG_LENGTH = 11`, and `generateVideoSlug(): string`. Draw bytes with `crypto.randomBytes` and map each byte with `byte & 63`; because the alphabet is exactly 64 symbols and 256 is a multiple of 64, the masking is uniform with no modulo bias and no rejection loop
- Export `MAX_SLUG_ATTEMPTS = 5` for the persistence-level collision retry implemented in SI-03.6

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-slug.util.spec.ts` | Unit | Slug length is exactly 11; every character belongs to the declared alphabet; 10,000 generated slugs contain no duplicate; the distribution of first characters covers a wide portion of the alphabet (guards against a masking bug collapsing the range) |

**Dependencies:** None

**Acceptance criteria:**

- `generateVideoSlug()` returns an 11-character string composed only of `[A-Za-z0-9_-]`
- 10,000 consecutive calls produce 10,000 distinct values
- The generator uses `crypto.randomBytes` — no `Math.random`, no external package

---

### SI-03.4 — Channel Lookup by User (resolves DG-1)

**Description:** Add a channel lookup to `ChannelsService` so the videos module can resolve the authenticated user's channel through the channels module's public API instead of querying `Repository<Channel>` directly. This closes `DG-1` from `validation.md`.

**Technical actions:**

- Inject `@InjectRepository(Channel) private readonly channelRepository: Repository<Channel>` into `ChannelsService` alongside the existing `DataSource` (the repository is already available — `ChannelsModule` registers `TypeOrmModule.forFeature([Channel])`)
- Implement `findByUserId(userId: string): Promise<Channel | null>` — `this.channelRepository.findOne({ where: { user_id: userId } })`. Returning `null` for "no channel" is a valid domain result, not a swallowed error; the caller decides whether absence is exceptional
- `ChannelsModule` already exports `ChannelsService` — no module change required

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` | Unit | `findByUserId` delegates to the repository with `{ where: { user_id } }` and returns `null` when nothing matches (extends the existing spec; constructor now receives `(channelRepository, dataSource)`) |
| `src/channels/channels.service.integration-spec.ts` | Integration | Against the real DB: `findByUserId` returns the channel created for a user and `null` for an unknown user id |

**Dependencies:** None

**Acceptance criteria:**

- `ChannelsService.findByUserId(userId)` returns the user's channel, or `null` when the user has none
- `VideosService` never imports `Channel`'s repository — the only path from videos to channels is `ChannelsService`
- Existing `ChannelsService` tests still pass with the widened constructor

---

### SI-03.5 — Video Entity and Migration

**Description:** Create the `Video` entity owned by `ChannelsModule`'s `Channel` (many-to-one), covering identification, ownership, title, status lifecycle, storage keys, extracted metadata and the multipart upload handle. Generate the migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns listed in `## Technical Specifications` → `### Data Model`. `status` is a PostgreSQL enum column (`videos_status_enum`) backed by `export enum VideoStatus { Draft = 'draft', Processing = 'processing', Ready = 'ready', Failed = 'failed' }`; `size_bytes` is `bigint` with a transformer mapping to `number` on read (10GiB fits comfortably inside `Number.MAX_SAFE_INTEGER`, but TypeORM returns `bigint` as `string` without one); `duration_seconds` is `numeric(10,3)` with the same numeric transformer. Declare `@ManyToOne(() => Channel, (channel) => channel.videos)` with `@JoinColumn({ name: 'channel_id' })`
- Update `src/channels/entities/channel.entity.ts` — add the inverse side `@OneToMany(() => Video, (video) => video.channel)`, per `.claude/rules/nestjs-entities.md` ("always define both sides of a relationship")
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` in imports, exporting `TypeOrmModule` so the processing module can inject the repository
- Register `VideosModule` in `AppModule`
- Generate the migration with `npm run migration:generate -- src/database/migrations/CreateVideos` and review the emitted SQL for the enum type, the unique index on `slug`, the FK to `channels` and the supporting indexes

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `slug` constraint rejects a duplicate; `status` defaults to `draft`; the enum rejects an unknown value; `size_bytes` round-trips a 10GiB value as a `number`; `duration_seconds` round-trips a fractional value; nullable metadata columns accept `null`; the `channel_id` FK rejects an unknown channel; timestamps auto-populate |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with every column, the `videos_status_enum` type, the unique index on `slug` and the FK to `channels(id)`
- Inserting two videos with the same `slug` fails with a unique constraint violation
- A newly inserted video has `status = 'draft'`
- `size_bytes` written as `10737418240` reads back as the number `10737418240`, not a string
- `channel.videos` loads the channel's videos and `video.channel` loads the owning channel

---

### SI-03.6 — Upload Initiation: Draft Pre-registration and Presigned Multipart

**Description:** Implement the first leg of the upload handshake — validate the declared file, resolve the authenticated user's channel, persist the video as a `draft` with a freshly generated unique slug, open the multipart upload in storage, and return one presigned URL per part. This is the "pré-cadastro automático do vídeo como rascunho ao iniciar o upload" capability.

**Technical actions:**

- Create `src/videos/dto/init-upload.dto.ts` — `InitUploadDto` with `@IsString() @IsNotEmpty() @MaxLength(200)` `title`, `@IsString() @IsNotEmpty() @MaxLength(255)` `filename`, `@IsString() @IsNotEmpty()` `content_type`, and `@IsInt() @Min(1)` `size_bytes`. Payload fixed by `phase-03-videos/TD-08`'s Revisions entry
- Create `src/videos/videos.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_PROCESSING_JOB = 'process-video'`, and `ALLOWED_VIDEO_CONTENT_TYPES` (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`)
- Create the domain exceptions in `src/videos/exceptions/` extending `DomainException` from `src/common/exceptions/`: `VideoTooLargeException` (413 `VIDEO_TOO_LARGE`), `UnsupportedVideoTypeException` (415 `UNSUPPORTED_VIDEO_TYPE`), `ChannelNotFoundException` (404 `CHANNEL_NOT_FOUND`), `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `VideoNotOwnedException` (403 `VIDEO_NOT_OWNED`), `InvalidVideoStateException` (409 `INVALID_VIDEO_STATE`), `SlugGenerationFailedException` (500 `SLUG_GENERATION_FAILED`), `RangeNotSatisfiableException` (416 `RANGE_NOT_SATISFIABLE`)
- Create `src/videos/videos.service.ts` — `VideosService` injecting `@InjectRepository(Video)`, `ChannelsService`, `StorageService`, `videoConfig` and the queue (added in SI-03.7). Implement `initUpload(userId, dto)`:
  1. Reject `size_bytes > videoConfig.maxSizeBytes` with `VideoTooLargeException`, and a `content_type` outside the allowlist with `UnsupportedVideoTypeException`
  2. `channelsService.findByUserId(userId)`; `null` → `ChannelNotFoundException`
  3. Generate a slug and persist the draft, retrying on PostgreSQL `23505` against the `slug` column up to `MAX_SLUG_ATTEMPTS`, then `SlugGenerationFailedException` — the same pre-check-free retry shape `ChannelsService` uses for nicknames, per `phase-02-auth/TD-10`
  4. Derive `storage_key` from the persisted `id` and the extension parsed from `filename` (lowercased, allowlisted), then `storageService.createMultipartUpload(...)` and persist the returned `upload_id` on the row
  5. Compute `partCount = Math.ceil(size_bytes / partSizeBytes)` and return `{ video_id, slug, upload_id, storage_key, part_size, part_count, expires_in, parts: [{ part_number, url }] }`
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos')` with `@Post('uploads')` returning 201, documented with `@ApiBearerAuth('access-token')` and `@ApiResponse` entries referencing `ApiErrorEnvelope` via `getSchemaPath`, following the `AuthController` convention. No `@Public()` — the global `JwtAuthGuard` protects it

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initUpload`: rejects oversize and unsupported content type; throws when the user has no channel; persists a draft with a generated slug; retries the slug on a `23505` unique violation and throws after the retry budget; computes `partCount` from the configured part size |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against the real DB and MinIO: `initUpload` persists a `draft` row with `upload_id` set, and the returned presigned URLs accept a real part upload |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` returns 201 with the handshake payload for an authenticated user; 401 without a token; 400 on an invalid body (`ValidationPipe` wiring); 413 `VIDEO_TOO_LARGE`; 415 `UNSUPPORTED_VIDEO_TYPE` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos/uploads` with a valid body returns 201 and a payload containing `video_id`, a unique `slug`, `upload_id`, `part_size`, `part_count` and exactly `part_count` presigned URLs
- A video row exists immediately after init with `status = 'draft'` and the channel of the authenticated user — the pre-registration happens at upload *start*, not at completion
- `size_bytes` above the configured 10GiB maximum returns 413 `VIDEO_TOO_LARGE`; a `content_type` outside the allowlist returns 415 `UNSUPPORTED_VIDEO_TYPE`
- The request never carries file bytes — the API's role is to hand out URLs, and the file goes from the client straight to storage
- A slug collision is resolved transparently by regeneration; the endpoint never returns a duplicate slug
- Without an `Authorization` header the endpoint returns 401

---

### SI-03.7 — Upload Completion and Processing Job Enqueue

**Description:** Implement the closing leg of the handshake — verify ownership and state, complete the multipart upload in storage, flip the video to `processing`, and enqueue the processing job. The enqueue happens after the database write commits, per `phase-03-videos/TD-01`.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `@IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => UploadedPartDto)` `parts`, where `UploadedPartDto` has `@IsInt() @Min(1)` `part_number` and `@IsString() @IsNotEmpty()` `etag`
- Register the queue in `VideosModule` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; configure the root connection with `BullModule.forRootAsync` in `AppModule` (and later in `WorkerModule`), injecting `queueConfig` and setting `defaultJobOptions` to `{ attempts, backoff: { type: 'exponential', delay }, removeOnComplete: true, removeOnFail: false }` per `library-refs.md`
- Implement `completeUpload(userId, videoId, dto)` in `VideosService`:
  1. Load the video with its channel; missing → `VideoNotFoundException`
  2. `video.channel.user_id !== userId` → `VideoNotOwnedException`
  3. `video.status !== VideoStatus.Draft` or `upload_id` absent → `InvalidVideoStateException` (makes a duplicate `complete` call safe)
  4. `storageService.completeMultipartUpload(storage_key, upload_id, parts)`
  5. Persist `status = 'processing'` and `upload_id = null`
  6. **After** the save resolves, `queue.add(VIDEO_PROCESSING_JOB, { videoId })` — never inside a transaction, because Redis does not participate in it
  7. Return `{ id, slug, status }`
- Add `@Post(':id/uploads/complete')` to `VideosController` — `@HttpCode(HttpStatus.OK)`, authenticated, `@Param('id', ParseUUIDPipe)`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload`: throws on unknown video, on a non-owner, and on a video already out of `draft`; calls storage completion before saving; enqueues exactly one job carrying only `{ videoId }`; does not enqueue when the save throws |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against real DB, MinIO and Redis: a two-part upload completes, the row becomes `processing` with `upload_id` cleared, the object is readable at `storage_key`, and one job is waiting on the `video-processing` queue |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/uploads/complete` returns 200 with `status: 'processing'`; 403 for another user's video; 409 when called twice; 404 for an unknown id; 400 on a malformed `parts` array |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Completing a real multipart upload assembles the object in storage and the video row flips from `draft` to `processing`
- Exactly one job is enqueued per successful completion, and its payload is `{ videoId }` and nothing else
- Calling complete a second time returns 409 `INVALID_VIDEO_STATE` and enqueues no additional job
- Completing another user's video returns 403 `VIDEO_NOT_OWNED`
- The job is added only after the status write commits — an enqueue failure never leaves a `draft` row believed to be `processing`

---

### SI-03.8 — Media Module: FFmpeg Metadata and Thumbnail Adapter

**Description:** Create a `MediaModule` exposing an `FfmpegService` that shells out to `ffprobe` and `ffmpeg`, per `phase-03-videos/TD-05`. This is the only place in the codebase that spawns a subprocess.

**Technical actions:**

- Create `src/media/ffmpeg.service.ts` — `FfmpegService` with:
  - A private `run(bin, args, timeoutMs)` helper using `child_process.spawn` with the arguments **as an array** (never a shell string), collecting `stdout`/`stderr`, rejecting on a non-zero exit code with the captured `stderr`, and killing the process on timeout
  - `probe(filePath): Promise<VideoMetadata>` — runs `ffprobe -v error -print_format json -show_format -show_streams <file>`, parses the JSON, selects the first stream with `codec_type === 'video'`, and returns `{ durationSeconds, width, height, videoCodec, bitrate }`. Throws when no video stream is present
  - `extractThumbnail(filePath, outputPath, atSeconds, width): Promise<void>` — runs `ffmpeg -ss <atSeconds> -i <file> -frames:v 1 -vf scale=<width>:-2 -q:v 2 -y <out>`; `-ss` precedes `-i` for fast input seeking and `-2` keeps the derived height even, per `library-refs.md`
- Create `src/media/media.module.ts` — provides and exports `FfmpegService`
- Create `src/media/media.types.ts` — the `VideoMetadata` interface and the `ffprobe` JSON shape, typed rather than `any`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/media/ffmpeg.service.integration-spec.ts` | Integration | Against real binaries, with a fixture clip synthesized at setup via `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p`: `probe` reports a duration close to 2s, 320×240 and a video codec; `extractThumbnail` writes a non-empty JPEG whose probed width matches the requested one; `probe` on a non-video file rejects with the captured `stderr` |
| `src/media/media.module.spec.ts` | Unit | Module compiles and exports `FfmpegService` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `probe()` on a 2-second fixture returns a duration within ±0.2s of 2, the correct dimensions and a non-empty codec name
- `extractThumbnail()` produces a readable JPEG at the requested width with an even height
- A failing FFmpeg invocation rejects with an error carrying the process `stderr` — failures are never silently swallowed
- Arguments are passed to `spawn` as an array; no command string is ever concatenated
- These specs run inside the `video-worker` container, the only image carrying the binaries

---

### SI-03.9 — Video Worker Bootstrap

**Description:** Create the worker entrypoint and its root module — a Nest application context (no HTTP server) wired with config, TypeORM and BullMQ, loading only what processing needs, per `phase-03-videos/TD-04`.

**Technical actions:**

- Create `src/videos/processing/video-processing.module.ts` — imports `VideosModule` (for `VideosService` and the `Video` repository), `StorageModule`, `MediaModule` and `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; provides `VideoProcessingProcessor` (SI-03.10)
- Create `src/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot` with the same `load` array and Joi schema as `AppModule`, `TypeOrmModule.forRootAsync` with identical options, `BullModule.forRootAsync`, and `VideoProcessingModule`. It deliberately does **not** import `AuthModule`, `MailModule` or the global guards — the worker serves no HTTP
- Create `src/worker.main.ts` — `NestFactory.createApplicationContext(WorkerModule)`, then `app.enableShutdownHooks()` so BullMQ closes its Redis connection and finishes the in-flight job on `SIGTERM`, and a startup log line naming the queue
- The API (`AppModule`) must **not** import `VideoProcessingModule` — otherwise the API would also consume jobs, defeating the container split

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.module.spec.ts` | Unit | Module compiles with `VideosModule`, `StorageModule`, `MediaModule` and the registered queue |
| `src/worker.module.spec.ts` | Unit | `WorkerModule` compiles against the test environment and resolves `VideoProcessingProcessor`; asserts the context exposes no HTTP adapter |

**Dependencies:** SI-03.1, SI-03.7, SI-03.8

**Acceptance criteria:**

- `docker compose logs video-worker` shows the worker booting and reporting the queue it listens on
- The worker container runs without an HTTP port — `createApplicationContext` starts no server
- `AppModule` does not import `VideoProcessingModule`; grepping the API module graph finds no `@Processor`
- Stopping the worker with `docker compose stop video-worker` shuts it down gracefully rather than being killed after the timeout

---

### SI-03.10 — Processing Job: Metadata, Thumbnail and Status Transitions

**Description:** Implement the queue consumer that turns an uploaded object into a playable video — download to a temp file, probe, extract the thumbnail, upload it, persist metadata, and mark the video `ready`. On terminal failure, mark it `failed` with the reason, per `phase-03-videos/TD-08`.

**Technical actions:**

- Add to `VideosService` the transitions the worker needs: `findByIdOrFail(videoId)`, `markReady(videoId, metadata, thumbnailKey)` and `markFailed(videoId, reason)` (writes `processing_error`). Keeping them on `VideosService` preserves single ownership of the `Video` entity
- Create `src/videos/processing/video-processing.types.ts` — `interface VideoProcessingJobData { videoId: string }`
- Create `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency, lockDuration })` (both from `queueConfig`) extending `WorkerHost`. `process(job)`:
  1. Re-read the video by `job.data.videoId`; if it is already `ready`, return without work — the handler is idempotent because BullMQ delivers at-least-once
  2. Create a temp directory with `fs.mkdtemp(path.join(os.tmpdir(), 'video-'))` and `storageService.downloadToFile(storage_key, sourcePath)`
  3. `ffmpegService.probe(sourcePath)`
  4. `ffmpegService.extractThumbnail(sourcePath, thumbPath, durationSeconds * thumbnailPositionRatio, thumbnailWidth)`
  5. `storageService.putObject(videoThumbnailKey(videoId), thumbBuffer, 'image/jpeg')`
  6. `videosService.markReady(videoId, metadata, thumbnailKey)`
  7. Remove the temp directory in a `finally` block — always, including on failure
- Add `@OnWorkerEvent('failed')` — guard on `job.attemptsMade < (job.opts.attempts ?? 1)` and return early while retries remain; only on the final attempt call `videosService.markFailed(videoId, error.message)`. This is the guard `library-refs.md` flags: `failed` fires on every attempt, so without it the row would report a terminal failure while BullMQ is still retrying
- Log at each transition with Nest's `Logger`; per `.claude/rules/nestjs-services.md`, background handlers are the one place where catch-and-log without rethrow is acceptable — but here the error is rethrown so BullMQ can retry, and the terminal state is written from the `failed` event

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.processor.spec.ts` | Unit | With storage, FFmpeg and `VideosService` mocked: the happy path calls probe → thumbnail → putObject → `markReady` in order; an already-`ready` video short-circuits with no FFmpeg call; the temp directory is removed even when probe throws; `onFailed` does nothing while `attemptsMade` is below the limit and calls `markFailed` on the final attempt |
| `src/videos/processing/video-processing.integration-spec.ts` | Integration | Against real MinIO, DB and FFmpeg: a synthesized clip uploaded to storage and run through `process()` leaves the row `ready` with a duration close to the fixture's, non-null dimensions, and a thumbnail object readable at `thumbnails/{id}/default.jpg`; a row whose `storage_key` points at a missing object ends `failed` with a non-empty `processing_error` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- After a successful upload completion, the video reaches `status = 'ready'` automatically with `duration_seconds`, `width`, `height`, `video_codec` and `bitrate` populated — no manual step
- A thumbnail object exists at `thumbnails/{videoId}/default.jpg` and is a valid JPEG extracted from a frame at 10% of the duration
- A video whose source object is missing or unreadable ends at `status = 'failed'` with `processing_error` populated, and only after the configured retries are exhausted
- While retries remain, the row stays `processing` — a transient failure never surfaces as a terminal state
- Temporary files are removed on both the success and the failure path
- Re-delivering the same job for an already-`ready` video is a no-op

---

### SI-03.11 — Public Video Metadata and Thumbnail Endpoints

**Description:** Expose the public read surface for a processed video — its metadata by slug and its generated thumbnail. Only `ready` videos are visible, per `phase-03-videos/TD-07`'s Revisions entry.

**Technical actions:**

- Implement `findReadyBySlug(slug)` in `VideosService` — loads the video with its channel, and throws `VideoNotFoundException` when it is missing **or not `ready`**, so a draft's existence is never revealed through a public endpoint
- Create `src/videos/dto/video-response.dto.ts` — the public projection (`id`, `slug`, `title`, `status`, `duration_seconds`, `width`, `height`, `thumbnail_url`, `channel: { id, nickname, name }`, `created_at`). `thumbnail_url` is the API's own thumbnail route, never a storage URL — the bucket stays private
- Add to `VideosController`, both `@Public()`:
  - `@Get(':slug')` returning the projection
  - `@Get(':slug/thumbnail')` — `@SkipThrottle()`, streams the thumbnail object with `Content-Type: image/jpeg` and a long `Cache-Control`
- Register the new route order carefully: `@Get('me')` (SI-03.13) must be declared **before** `@Get(':slug')`, or Express matches `me` as a slug

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `findReadyBySlug` returns the video when `ready` and throws `VideoNotFoundException` for both a missing slug and a non-`ready` video |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:slug` returns 200 with the public projection for an anonymous caller; 404 for an unknown slug; 404 for a `draft`/`processing` video; `GET /videos/:slug/thumbnail` returns 200 with `Content-Type: image/jpeg` and a non-empty body |

**Dependencies:** SI-03.5, SI-03.2

**Acceptance criteria:**

- `GET /videos/:slug` works without authentication and returns the video's metadata including its channel
- A video that is not `ready` returns 404 — identical to an unknown slug, so status is not leaked
- `GET /videos/:slug/thumbnail` returns the generated JPEG through the API; the storage bucket is never exposed to the client
- `thumbnail_url` in the metadata payload points at the API route, not at MinIO

---

### SI-03.12 — Streaming with HTTP Range and Download

**Description:** Implement the delivery endpoints decided in `phase-03-videos/TD-07` — a streaming route honouring HTTP `Range` with `206 Partial Content` so playback starts without downloading the whole file, and a download route serving the same object as an attachment.

**Technical actions:**

- Add `@Public() @SkipThrottle() @Get(':slug/stream')` to `VideosController`. The handler:
  1. `findReadyBySlug(slug)`
  2. Reads the `Range` request header and forwards it verbatim to `storageService.getObjectStream(key, range)`
  3. With a range: responds `206` with `Content-Range` (from the storage response), `Accept-Ranges: bytes`, `Content-Length` (the slice length) and `Content-Type`
  4. Without a range: responds `200` with `Accept-Ranges: bytes`, the full `Content-Length` and `Content-Type`
  5. An unsatisfiable range (start beyond the object size) responds `416` with `Content-Range: bytes */<total>` — mapped from `RangeNotSatisfiableException`
  6. `stream.pipe(res)` — the body is never buffered; and on the response's `close` event the storage stream is destroyed, because an unconsumed S3 body holds its socket open and a few dozen abandoned seeks would exhaust the pool (see `library-refs.md` → streaming gotcha)
- Add `@Public() @SkipThrottle() @Get(':slug/download')` — same source object, `Content-Disposition: attachment; filename="<sanitized title>.<ext>"`, `Content-Length` set to the full object size, and the same stream-destroy wiring
- Both handlers use `@Res({ passthrough: false })` since they write the response directly; they contain no business rules — the lookup and the range arithmetic live in `VideosService`/`StorageService`, per `.claude/rules/nestjs-layer-separation.md`
- `@SkipThrottle()` on both is required: the inherited `ThrottlerGuard` is registered as a global `APP_GUARD` in `AuthModule` with a 10-requests-per-minute budget, and a single video playback issues far more range requests than that

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | The range parser: a valid `bytes=start-end`, an open-ended `bytes=start-`, a suffix range, a malformed header and a start beyond the object size (throws `RangeNotSatisfiableException`) |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:slug/stream` with `Range: bytes=0-99` returns 206, `Content-Range: bytes 0-99/<total>`, `Content-Length: 100` and exactly 100 bytes; without a range returns 200 with the full length and `Accept-Ranges: bytes`; with an out-of-bounds range returns 416; for a non-`ready` video returns 404. `GET /videos/:slug/download` returns 200 with `Content-Disposition: attachment` and a body whose length equals the stored object |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- A `Range` request returns `206 Partial Content` with a correct `Content-Range` and exactly the requested bytes — playback can start without fetching the whole file
- A request with no `Range` returns `200` with the complete object and advertises `Accept-Ranges: bytes`
- An unsatisfiable range returns `416` with `Content-Range: bytes */<total>`
- The API never buffers the file: memory stays flat while a large object is streamed, and an aborted client request destroys the upstream storage stream
- `GET /videos/:slug/download` serves the file with `Content-Disposition: attachment` and a filename derived from the title
- Both endpoints work anonymously and neither is rate-limited

---

### SI-03.13 — Owner Video Listing (status observability)

**Description:** Expose the authenticated channel's own videos so the status lifecycle written by the worker is observable through the API — the read counterpart of `phase-03-videos/TD-08`. Deliberately minimal: Fase 04 owns the management panel with thumbnails, view counts, likes and publication time.

**Technical actions:**

- Implement `findByChannelUser(userId)` in `VideosService` — resolves the channel through `ChannelsService.findByUserId`, throws `ChannelNotFoundException` when absent, and returns the channel's videos ordered by `created_at DESC` with every status included
- Add `@Get('me')` to `VideosController`, authenticated, **declared before `@Get(':slug')`** so Express does not match `me` as a slug. Returns `{ id, slug, title, status, duration_seconds, processing_error, created_at }[]` — `processing_error` is included precisely so the owner can see why a video failed

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `findByChannelUser` throws when the user has no channel and returns the channel's videos ordered by creation date |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/me` returns 200 with the caller's videos including non-`ready` ones; 401 without a token; a second user's videos are absent from the payload; `GET /videos/me` resolves to the listing route and not to the slug route |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `GET /videos/me` returns the authenticated user's videos in every status, newest first
- A failed video exposes its `processing_error` to its owner
- The route never collides with `GET /videos/:slug`
- A user never sees another channel's videos

---

### SI-03.14 — Lint Gate Repair

**Description:** Restore `npm run lint` to a passing state, which the inherited `dev` branch does not satisfy (190 problems / 150 errors). Implements `phase-03-videos/TD-10` Decision A: the non-test errors are fixed with real types, and the mock-driven rules are downgraded to warnings for test files only.

**Technical actions:**

- Fix `src/channels/channels.service.ts` — replace `const e = err as any` in `isPgUniqueViolationOnColumn` with a narrow typed shape (`interface PgDriverError { code?: string; detail?: string }`) and property checks, removing all six `no-unsafe-*` errors without weakening the guard
- Fix `src/test/create-test-data-source.ts` — replace the bare `Function` in the `entities` parameter type with TypeORM's own `MixedList<EntityTarget<ObjectLiteral>>`-compatible shape, removing the `no-unsafe-function-type` error
- Fix the two genuine `no-unused-vars` errors in the existing specs (an unused destructured `userId` and one other) — these stay errors and are not covered by the override
- Add a scoped block to `nestjs-project/eslint.config.mjs` matching `['**/*.spec.ts', '**/*.integration-spec.ts', '**/*.e2e-spec.ts']` that sets `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-return`, `no-unsafe-call` and `unbound-method` to `warn`, with a comment explaining that `unbound-method` is a known false positive on `jest.fn()` mocks and that `any`-typed mocks are intrinsic to `overrideProvider` testing. Every other rule, including `no-unused-vars` and `prettier/prettier`, keeps its severity
- The block sits after the existing project-wide `rules` block so it wins for the matched files only

**Dependencies:** None

**Acceptance criteria:**

- `npm run lint` exits with code 0
- No `eslint-disable` comment is introduced anywhere in the codebase — the change is configuration plus real type fixes
- Production sources keep every `no-unsafe-*` rule at `error`: introducing an `any` leak in `src/**` that is not a test file still fails the lint gate
- The two type fixes preserve behaviour — the existing `ChannelsService` and DataSource tests still pass

---

### SI-03.15 — Migration Integration Spec: Hermetic Cleanup and Third Migration

**Description:** Fix `src/database/migrations.integration-spec.ts`, which is not hermetic: its `beforeAll` drops the managed tables but not the PostgreSQL enum type created by `CreateAuthTokens`, so a second run fails with `type "verification_tokens_type_enum" already exists` — and the failed suite leaves its DataSource open, hanging Jest. The spec also hardcodes a migration count that this phase's new migration invalidates.

**Technical actions:**

- Extend the `beforeAll` cleanup with the enum types alongside the tables: `DROP TYPE IF EXISTS "public"."verification_tokens_type_enum" CASCADE` and `DROP TYPE IF EXISTS "public"."videos_status_enum" CASCADE`, executed after the `DROP TABLE` statements. Without this the suite passes only on a database that has never been migrated
- Add `videos` to `MANAGED_TABLES` and register `CreateVideos` in the spec's `migrations` array and the `Video` entity in its entity list, so TypeORM can resolve the FK metadata
- Update the count assertion from `toHaveLength(2)` to `toHaveLength(3)` and extend the expected table list with `videos`
- Extend the revert assertion: `undoLastMigration()` now removes the `videos` table, so the second test asserts against `videos` rather than the token tables, and the existing `afterAll` re-migration keeps the shared database whole for the suites that follow
- Wrap the `beforeAll` body so the DataSource is destroyed if setup throws, preventing the open-handle hang that masked the original failure

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations` applies all three migrations and creates all five tables; `undoLastMigration` removes `videos`; the suite passes twice in a row against the same database (hermeticity) |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- The migrations spec passes on a freshly migrated database **and** on a second consecutive run — the enum type no longer survives the cleanup
- `runMigrations()` returns exactly three migration records and `users`, `channels`, `refresh_tokens`, `verification_tokens` and `videos` all exist
- `npm test -- --runInBand` exits instead of hanging; no open-handle warning
- After the suite, the database is left fully migrated for the E2E run

---

### SI-03.16 — Documentation: CLAUDE.md Video Section and OpenAPI Export

**Description:** Bring the AI-facing documentation in line with the delivered code — the new module, endpoints, queue, worker and storage — and regenerate the OpenAPI artifact so the exported contract matches the new routes.

**Technical actions:**

- Update `nestjs-project/CLAUDE.md`: add the new Compose services to the Services list (`minio`, `redis`, `video-worker`) and their readiness probes to the § Environment Startup Verification checklist; document that worker-image commands (`ffmpeg`, `ffprobe`, and the specs that use them) run inside `video-worker` while every other `npm` command still runs inside `nestjs-api`; add a `## Video Pipeline` section describing the upload handshake, the queue and job name, the worker entrypoint (`src/worker.main.ts`) and the status lifecycle; extend § Architecture with the `videos/`, `storage/` and `media/` modules
- Update the root `CLAUDE.md` § Repository Structure to mention the video worker entrypoint alongside the API
- Regenerate `nestjs-project/openapi.json` via `npm run openapi:export` so the video endpoints appear in the exported spec
- Verify every path and command named in the documentation exists — documentation citing a non-existent file is a graded failure

**Dependencies:** SI-03.1, SI-03.7, SI-03.10, SI-03.12, SI-03.13

**Acceptance criteria:**

- `nestjs-project/CLAUDE.md` describes the video module, its endpoints, the queue and worker, and the storage service, and every file path it names exists on disk
- The root `CLAUDE.md` architecture bullets match the delivered containers, with no `TBD` left
- `openapi.json` contains the video endpoints with their documented responses and error envelopes
- `npm run openapi:export` runs clean

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| slug | varchar(16) | unique, not null | Public URL identifier, 11 chars from `[A-Za-z0-9_-]` (per TD-06) |
| channel_id | uuid | FK → channels.id, not null | Owning channel |
| title | varchar(200) | not null | Supplied at upload init (per TD-08 Revisions) |
| status | enum `videos_status_enum` | not null, default `'draft'` | `draft` \| `processing` \| `ready` \| `failed` (per TD-08) |
| storage_key | varchar(512) | not null | `videos/{id}/source{ext}` (per TD-03) |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}/default.jpg`; set by the worker |
| original_filename | varchar(255) | not null | As declared by the client at init |
| content_type | varchar(128) | not null | Validated against the allowlist at init |
| size_bytes | bigint | not null | Client-declared; max 10GiB (per TD-02). Numeric transformer on read |
| duration_seconds | numeric(10,3) | nullable | From `ffprobe`; null until `ready` |
| width | integer | nullable | From `ffprobe` |
| height | integer | nullable | From `ffprobe` |
| video_codec | varchar(64) | nullable | From `ffprobe` |
| bitrate | integer | nullable | From `ffprobe` |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; cleared on completion |
| processing_error | text | nullable | Written only on terminal failure (per TD-08) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many, inverse side added to the existing entity)
**Indexes:** `(slug)` — unique; `(channel_id)` — FK lookups for the owner listing; `(status)` — for future status filtering

---

### API Contracts

#### POST /videos/uploads (SI-03.6)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- title: string, required — 1..200 characters
- filename: string, required — 1..255 characters
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- size_bytes: integer, required — ≥ 1 and ≤ 10737418240 (10GiB)

**Response 201:**
- video_id: string (uuid)
- slug: string — 11-character public identifier
- upload_id: string — S3 multipart upload handle
- storage_key: string
- part_size: integer — bytes per part (64MiB)
- part_count: integer — `ceil(size_bytes / part_size)`
- expires_in: integer — presigned URL TTL in seconds
- parts: array of `{ part_number: integer, url: string }` — one presigned `UploadPart` URL per part, in ascending order

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 401: when the access token is missing or invalid
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel
- 413 VIDEO_TOO_LARGE: when `size_bytes` exceeds the configured maximum
- 415 UNSUPPORTED_VIDEO_TYPE: when `content_type` is outside the allowlist

---

#### POST /videos/:id/uploads/complete (SI-03.7)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request path parameters:**
- id: string (uuid), required — the `video_id` returned by the init call

**Request body:**
- parts: array, required, min 1 — `{ part_number: integer ≥ 1, etag: string }` as returned by storage for each uploaded part

**Response 200:**
- id: string (uuid)
- slug: string
- status: string — always `processing`

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 401: when the access token is missing or invalid
- 403 VIDEO_NOT_OWNED: when the video belongs to another channel
- 404 VIDEO_NOT_FOUND: when no video matches the id
- 409 INVALID_VIDEO_STATE: when the video is not in `draft` (covers a duplicate completion)

---

#### GET /videos/me (SI-03.13)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:** array of
- id: string (uuid)
- slug: string
- title: string
- status: string — `draft` | `processing` | `ready` | `failed`
- duration_seconds: number | null
- processing_error: string | null
- created_at: string (ISO-8601)

Ordered by `created_at` descending. Includes videos in every status.

**Error responses:**
- 401: when the access token is missing or invalid
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel

---

#### GET /videos/:slug (SI-03.11)

**Request path parameters:**
- slug: string, required — the 11-character public identifier

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: string — always `ready` on this endpoint
- duration_seconds: number
- width: integer
- height: integer
- thumbnail_url: string — the API's own thumbnail route
- channel: `{ id: string (uuid), nickname: string, name: string }`
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown **or** the video is not `ready` (same response for both — status is not leaked)

---

#### GET /videos/:slug/thumbnail (SI-03.11)

**Response 200:** the generated JPEG.
- Content-Type: image/jpeg
- Cache-Control: public, max-age=86400

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown, the video is not `ready`, or no thumbnail exists

---

#### GET /videos/:slug/stream (SI-03.12)

**Request headers:**
- Range: bytes=`<start>`-`<end>` — optional

**Response 206** (with a `Range` header):
- Content-Range: bytes `<start>`-`<end>`/`<total>`
- Content-Length: length of the returned slice
- Accept-Ranges: bytes
- Content-Type: the stored content type
- Body: the requested byte range

**Response 200** (without a `Range` header):
- Content-Length: the full object size
- Accept-Ranges: bytes
- Content-Type: the stored content type
- Body: the full object

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video is not `ready`
- 416 RANGE_NOT_SATISFIABLE: when the requested start is beyond the object size — includes `Content-Range: bytes */<total>`

---

#### GET /videos/:slug/download (SI-03.12)

**Response 200:**
- Content-Disposition: attachment; filename="`<sanitized title>`.`<ext>`"
- Content-Length: the full object size
- Content-Type: the stored content type
- Body: the full object

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video is not `ready`

---

#### Validation Rules — Upload Handshake

| Field | Rule | Error |
|-------|------|-------|
| title | Required, 1..200 characters | 400 validation error |
| filename | Required, 1..255 characters | 400 validation error |
| content_type | Required, member of the allowlist | 415 UNSUPPORTED_VIDEO_TYPE |
| size_bytes | Required integer ≥ 1 | 400 validation error |
| size_bytes | ≤ 10737418240 (10GiB) | 413 VIDEO_TOO_LARGE |
| parts | Required array, min 1 item | 400 validation error |
| parts[].part_number | Required integer ≥ 1 | 400 validation error |
| parts[].etag | Required non-empty string | 400 validation error |

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos/uploads | ✗ | ✓ | — | Creates in the caller's own channel |
| POST /videos/:id/uploads/complete | ✗ | ✗ | ✓ | 403 VIDEO_NOT_OWNED for a non-owner |
| GET /videos/me | ✗ | ✓ | — | Scoped to the caller's channel |
| GET /videos/:slug | ✓ | ✓ | ✓ | `@Public()`; `ready` videos only (per TD-07 Revisions) |
| GET /videos/:slug/thumbnail | ✓ | ✓ | ✓ | `@Public()` + `@SkipThrottle()` |
| GET /videos/:slug/stream | ✓ | ✓ | ✓ | `@Public()` + `@SkipThrottle()` |
| GET /videos/:slug/download | ✓ | ✓ | ✓ | `@Public()` + `@SkipThrottle()` |

Authentication is enforced by the inherited global `JwtAuthGuard` (`phase-02-auth/SI-02.9`); public routes opt out with `@Public()`. The inherited `ThrottlerGuard` is also a global `APP_GUARD` with a 10-request-per-minute budget, so the byte-serving routes carry `@SkipThrottle()` — a single playback issues far more range requests than that budget allows. Fase 04's visibility capability (`público`/`unlisted`) will narrow the public rows without changing their shape.

---

### Error Catalog

**Error response format:** inherited from `phase-02-auth/TD-07` — `{ statusCode: number, error: string, message: string }`, where `error` carries the domain code below. Validation failures use `error: "VALIDATION_ERROR"` with an array `message`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | Upload init or owner listing when the user has no channel |
| VIDEO_TOO_LARGE | 413 | Video exceeds the maximum allowed size | `POST /videos/uploads` with `size_bytes` above the configured maximum |
| UNSUPPORTED_VIDEO_TYPE | 415 | Unsupported video content type | `POST /videos/uploads` with a `content_type` outside the allowlist |
| VIDEO_NOT_FOUND | 404 | Video not found | Any lookup by id or slug that misses, and any public read of a video that is not `ready` |
| VIDEO_NOT_OWNED | 403 | Video belongs to another channel | `POST /videos/:id/uploads/complete` by a non-owner |
| INVALID_VIDEO_STATE | 409 | Video is not in a state that allows this operation | Completing an upload for a video that is not `draft`, including a duplicate completion |
| RANGE_NOT_SATISFIABLE | 416 | Requested range is not satisfiable | `GET /videos/:slug/stream` with a start beyond the object size |
| SLUG_GENERATION_FAILED | 500 | Could not generate a unique video slug | Slug collision persisted past the retry budget |

---

### Events/Messages

#### process-video

**Queue:** `video-processing` (Redis + BullMQ, per `phase-03-videos/TD-01`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`) — enqueued only after the status write to PostgreSQL commits, because Redis does not participate in the database transaction.

**Consumer:** `VideoProcessingProcessor` in the `video-worker` container (per `phase-03-videos/TD-04`).

**Trigger:** the client finishes uploading every part and calls `POST /videos/:id/uploads/complete` successfully.

**Delivery semantics:** at-least-once. The payload deliberately carries only the identifier; the handler re-reads the row and returns early when the video is already `ready`, which makes redelivery a no-op.

**Retry policy:** `attempts: 3` with `backoff: { type: 'exponential', delay: 5000 }` (per `phase-03-videos/TD-08`). `removeOnComplete: true`, `removeOnFail: false` so a terminal failure stays inspectable in Redis.

**Worker options:** `concurrency: 1` and `lockDuration: 600000` — a multi-gigabyte download plus probe plus thumbnail can take minutes, and a lock shorter than the job causes BullMQ to redeliver work that is still running.

**Terminal-failure signal:** the `failed` worker event fires on every attempt; the handler writes `processing_error` and flips the row to `failed` only when `attemptsMade >= attempts`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.5
└── SI-03.8

SI-03.3 (no deps)
SI-03.4 (no deps)
SI-03.14 (no deps — lint gate, independent of the feature chain)

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6
    └── SI-03.7
        └── SI-03.9 (also needs SI-03.1, SI-03.8)
            └── SI-03.10

SI-03.2 + SI-03.5
└── SI-03.11
    └── SI-03.12

SI-03.5
├── SI-03.13
└── SI-03.15

SI-03.1 + SI-03.7 + SI-03.10 + SI-03.12 + SI-03.13
└── SI-03.16
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16

SI-03.14 (lint) and SI-03.15 (migration spec hermeticity) are independent of the feature chain; SI-03.15 only needs the videos migration to exist. Both are placed late so the Definition of Done closes on a codebase that already carries every new file.

## Deliverables

- [ ] Upload of files up to 10GB without the bytes passing through the API — presigned S3 multipart handshake (init → direct part uploads → complete)
- [ ] Automatic draft pre-registration at upload start, with the video attached to the authenticated user's channel
- [ ] Automatic processing after upload: duration, dimensions, codec and bitrate extracted with `ffprobe`
- [ ] Automatic thumbnail generated from a frame at 10% of the duration and stored in object storage
- [ ] Unique 11-character URL slug per video, guaranteed by a unique index plus collision retry
- [ ] Streaming with HTTP `Range` → `206 Partial Content`, so playback starts without a full download
- [ ] Download endpoint serving the stored file as an attachment
- [ ] Video status lifecycle `draft → processing → ready | failed` persisted in the database, with the failure reason recorded only after retries are exhausted
- [ ] Object storage (MinIO), queue (Redis) and video worker (FFmpeg) all running via `docker compose` alongside the backend
- [ ] Migration creating the `videos` table with the status enum, the unique slug index and the FK to `channels`
- [ ] `StorageModule`, `MediaModule` and `VideosModule` following the project's layer separation and repository conventions
- [ ] Channel lookup added to `ChannelsService` so videos never query the channels table directly
- [ ] Integration tests exercising the real MinIO, Redis and FFmpeg from Compose — no mocks where the real service is available
- [ ] Migration integration spec made hermetic (enum cleanup) and extended to the third migration
- [ ] `npm run lint` restored to a passing state without disabling rules on production code
- [ ] `CLAUDE.md` (root and backend) updated to match the delivered code, with no `TBD` left in the architecture
- [ ] `openapi.json` regenerated with the video endpoints
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
