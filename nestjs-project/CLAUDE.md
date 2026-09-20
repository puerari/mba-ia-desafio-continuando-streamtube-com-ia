# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio curl -f http://localhost:9000/minio/health/live` — expect exit 0
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

`minio` and `redis` declare healthchecks, so `docker compose ps` reporting `healthy` is already a readiness signal for both.

The **`video-worker`** service is not an infrastructure service and not the application server either: it is a long-running consumer that starts with the stack and is expected to stay up. Confirm it came up with:

```bash
docker compose logs video-worker | tail -1
# expect: [VideoWorker] Video worker started — consuming queue "video-processing"
```

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# The worker started before node_modules existed — restart it once
docker compose restart video-worker

# Apply migrations
docker compose exec nestjs-api npm run migration:run

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

On a **fresh clone** the install step and the worker compete for the same bind-mounted `node_modules`: `video-worker` starts with the stack and immediately runs `nest start --watch`, which fails (and can make `npm install` error out) until dependencies exist. Run the install first, then restart the worker. This only affects the very first run.

The object storage bucket needs no manual step — `StorageService.onModuleInit` creates it if missing.

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video processing consumer (Node + FFmpeg), no exposed port
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP on `1025`, web UI on `8025`
- `minio` — S3-compatible object storage, API on `9000`, console on `9001`, user/password `streamtube`
- `redis` — BullMQ backend. **No published host port** on purpose: only containers consume the queue, and publishing `6379` collides with a Redis a developer may already be running

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify object storage and the queue
docker compose exec minio curl -f http://localhost:9000/minio/health/live
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Tear down the entire environment
docker compose down
```

### Container images

There are two dev images. `Dockerfile.dev` builds `nestjs-api`; `Dockerfile.worker` builds `video-worker` and additionally installs `ffmpeg` (which ships `ffprobe`), the binaries `FfmpegService` spawns.

`ffmpeg` is installed in **both** images, but for different reasons. The worker needs it at runtime; the API image carries it only so the test suite can run — this file makes `nestjs-api` the container where every npm command runs, and the media specs shell out to the real binaries. The architectural boundary is enforced by module wiring, not by the image: only `MediaModule` spawns a subprocess, and only the worker's module graph imports it. `src/worker.module.spec.ts` asserts that resolving `VideoProcessingProcessor` from `AppModule` throws.

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker with hot-reload (what video-worker runs)
npm run start:worker                     # Run the compiled worker (dist/worker.main)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec minio curl -f http://localhost:9000/minio/health/live
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # maxWorkers: 1 in test/jest-e2e.json
```

E2E serialization is enforced by `maxWorkers: 1` in `test/jest-e2e.json`, not by a CLI flag — before that was set, `auth.e2e-spec.ts` and `videos.e2e-spec.ts` truncated each other's tables mid-request and produced spurious 401s.

**Suites that touch the queue must pause it.** `video-worker` listens on the same Redis as the test process, so a spec that enqueues a job races the live worker for it. `videos.service.integration-spec.ts` and `videos.e2e-spec.ts` call `queue.pause()` in `beforeAll`, `queue.drain(true)` in `beforeEach`, and `obliterate` + `resume` in `afterAll`. `video-processing.integration-spec.ts` sidesteps the problem differently: it calls `process()` directly instead of going through the queue.

Some integration specs exercise real object storage. They write under a `test/<uuid>/…` prefix in the same bucket the application uses and delete their objects in `afterAll`.

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

There are **two entrypoints**:

- `src/main.ts` → `AppModule` — the HTTP API (`nestjs-api`)
- `src/worker.main.ts` → `WorkerModule` — the video worker (`video-worker`), a `NestFactory.createApplicationContext` with no HTTP server

`WorkerModule` is deliberately narrower than `AppModule`: config, TypeORM, BullMQ and `VideoProcessingModule`, with no auth, mail or global guards. `AppModule` must never import `VideoProcessingModule` — that is what keeps the API from becoming a second queue consumer.

Modules beyond the Phase 01/02 set:

| Module | Path | Responsibility |
|--------|------|----------------|
| `VideosModule` | `src/videos/` | Video entity, upload handshake, public reads, streaming and download |
| `VideoProcessingModule` | `src/videos/processing/` | The BullMQ `@Processor`. Imported only by `WorkerModule` |
| `StorageModule` | `src/storage/` | Generic S3-compatible object storage port. Knows nothing about videos |
| `MediaModule` | `src/media/` | `FfmpegService` — the only place that spawns a subprocess |

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings. Test files (`*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`) additionally downgrade `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-return`, `no-unsafe-call`, `unbound-method` and `require-await` to warnings, because Jest mocks are untyped by construction. Everything outside a spec keeps them at `error`
- **CommonJS matters when picking a dependency.** The project compiles to CommonJS and ts-jest transpiles specs the same way, so an ESM-only package fails at `require` time even when its peer range fits. Check `"type"` and `main`/`exports` in the candidate's `package.json`, not just `peerDependencies` — this is what excluded `@nestjs/bullmq@12` and `nanoid@6`

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Video Pipeline

Decisions behind this design live in `docs/decisions/technical-decisions-phase-03-videos.md`; the executable plan is `docs/phases/phase-03-videos/phase-03-videos.md`.

### Upload — the file never passes through the API

A 10GB upload cannot tie up an API connection, and a single S3 `PutObject` is capped at 5GB anyway. The client therefore uploads directly to object storage using presigned multipart URLs, in a three-step handshake:

1. **`POST /videos/uploads`** (authenticated) — validates the declared size and content type, resolves the caller's channel, persists the video as a **`draft`** with a generated unique slug, opens the multipart upload in storage and returns one presigned `UploadPart` URL per part. Part size is 64MiB, so a 10GiB upload is 160 parts — inside S3's 10,000-part cap and above its 5MiB per-part floor.
2. **The client `PUT`s each part straight to storage** and keeps the returned `ETag`.
3. **`POST /videos/:id/uploads/complete`** (owner only) — assembles the object, flips the video to **`processing`** and enqueues the job.

The job is added **after** the status write commits. Redis is not part of the PostgreSQL transaction, so enqueueing first could hand the worker a video the database still calls a draft.

### Processing — the worker

`VideoProcessingProcessor` consumes the `video-processing` queue in the `video-worker` container. Per job it downloads the source to a temp file (ffprobe needs random access, so the object is staged rather than streamed), probes duration/dimensions/codec/bitrate, extracts a JPEG frame at 10% of the duration, uploads it as the thumbnail, and marks the video **`ready`**. The temp directory is removed in a `finally`, on both paths.

The job payload is `{ videoId }` and nothing else: BullMQ delivers at-least-once, so the handler re-reads the row and returns early when the video is already `ready`.

Retries are 3 attempts with exponential backoff from 5s. **The `failed` worker event fires on every attempt**, so `onFailed` writes the terminal state only once `attemptsMade` reaches the limit — otherwise the status column would report a permanent failure while the queue is still retrying.

Status lifecycle: `draft → processing → ready | failed`. `processing_error` is written only on terminal failure.

### Delivery — streaming through the API

The bucket is private; nothing is served from a storage URL. `GET /videos/:slug/stream` reads the `Range` header, forwards the range to `GetObject` and pipes the body back as `206 Partial Content`, so playback starts without downloading the whole file. This keeps authorization in the API, which is what Fase 04's `público`/`unlisted` visibility will need.

- Malformed or multi-range headers fall back to `200` with the full body (RFC 9110 allows a server to ignore a `Range` it cannot parse). A syntactically valid but out-of-bounds range is the one case that answers `416`, with `Content-Range: bytes */<total>`.
- The storage stream is destroyed on the response's `close` event. An unconsumed `GetObject` body holds its socket open, and a handful of abandoned seeks would exhaust the connection pool.
- `stream`, `download` and `thumbnail` carry `@SkipThrottle()`: the inherited `ThrottlerGuard` is a global `APP_GUARD` at 10 requests/minute, and a single playback issues far more range requests than that.

### Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/videos/uploads` | authenticated | Pre-registers the draft, returns the presigned handshake |
| POST | `/videos/:id/uploads/complete` | owner | Assembles the object, enqueues processing |
| GET | `/videos/me` | authenticated | Caller's own videos in every status, newest first |
| GET | `/videos/:slug` | public | Public metadata; a non-`ready` video answers 404 like an unknown slug |
| GET | `/videos/:slug/thumbnail` | public | Generated JPEG, served through the API |
| GET | `/videos/:slug/stream` | public | `Range` → 206; no range → 200; bad range → 416 |
| GET | `/videos/:slug/download` | public | Same object with `Content-Disposition: attachment` |

`GET /videos/me` **must stay declared before `GET /videos/:slug`** in the controller — Express matches in declaration order and would otherwise read `me` as a slug.

### Object layout

One bucket (`STORAGE_BUCKET`, default `streamtube`), two prefixes:

- `videos/{videoId}/source{ext}` — the uploaded file
- `thumbnails/{videoId}/default.jpg` — the generated frame

Key builders live in `src/videos/video-storage-keys.ts`. `StorageService` never sees them: it is a generic object-storage port, and the layout belongs to the domain that stores the objects.

### Configuration

`storage.config.ts`, `queue.config.ts` and `video.config.ts` follow the `registerAs` convention. All their variables are in `.env.example` and validated by the Joi schema in `src/config/env.validation.ts`. `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` are required — the app refuses to boot without them.

`STORAGE_FORCE_PATH_STYLE` must stay `true` for MinIO: the SDK otherwise builds virtual-hosted URLs (`<bucket>.<endpoint>`) that do not resolve against a Compose service name.
