# phase-03-videos — Progress

**Status:** completed
**SIs:** 16/16 completed

**Definition of Done:** `npm test -- --runInBand` 265/265 · `npm run test:e2e` 86/86 · `npx tsc --noEmit` exit 0 · `npm run lint` exit 0, all from a freshly reset schema.

_Live-stack verification (2026-09-20):_ the whole pipeline was exercised against the running containers, not only through the test suite — register → upload init (pre-registered as `draft`) → parts uploaded straight to MinIO through the presigned URLs → complete → the `video-worker` container picked up the job and finished in **1.0s**, writing `duration=4.000s 640x360 codec=h264 bitrate=57048` and a 44,651-byte JPEG thumbnail. Then `GET /videos/:slug` (200), `/thumbnail` (200 image/jpeg), `/stream` with `Range: bytes=0-1023` (**206**, `content-range: bytes 0-1023/28524`), `/stream` with no range (200, full 28,524 bytes), an out-of-bounds range (**416**, `content-range: bytes */28524`), `/download` (200, `attachment; filename="Smoke-Test-Clip.mp4"`, byte-identical to the source) and `/videos/me` (200).

_Execution note:_ SI-03.15 was pulled forward, out of the linearized order in the plan. Its only dependency is SI-03.5 (the videos migration must exist), and once that migration landed the migrations spec went red — the `implement` rule is to move on only with the SI's suite green, so it was fixed immediately instead of at the end.

### SI-03.1 — Dependencies, Configuration Namespaces, and Compose Infrastructure
- **Status:** completed
- **Tests:** no tests — verified through the acceptance criteria (all six services healthy, `ffmpeg`/`ffprobe` 5.1.9 present in `video-worker` and absent from `nestjs-api`)
- **Observations:** `docker.io/minio/minio` is no longer publicly pullable ("pull access denied … repository does not exist"), so the compose file uses MinIO's own registry, `quay.io/minio/minio`. The documented `mc ready local` healthcheck was replaced with `curl -f http://localhost:9000/minio/health/live`, which does not depend on an `mc` alias being configured. Redis publishes no host port on purpose — nothing on the host consumes the queue, and the developer machine already had 6379 taken. Also fixed `.env.example`: `MAIL_FROM` was written as `"StreamTube" <noreply@streamtube.com>`, and the unquoted angle brackets make Docker Compose fail to parse the file ("unexpected character '<' in variable name"), so `cp .env.example .env && docker compose up` was broken on a fresh clone.

### SI-03.2 — Storage Module: S3/MinIO Adapter
- **Status:** completed
- **Tests:** 11/11 passing (storage.service.integration-spec.ts: 10 integration against the real MinIO container, storage.module.spec.ts: 1 module)
- **Observations:** Key layout deliberately left out of `StorageService` — it is a generic object-storage port and the `videos/`/`thumbnails/` prefixes belong to the videos module. `totalLength` is parsed out of `ContentRange` rather than taken from `ContentLength`, because on a ranged read `ContentLength` is only the slice size and a `206` needs the full object size. Jest has no ESM support here, so `await import(...)` inside a spec throws "A dynamic import callback was invoked without --experimental-vm-modules" — node builtins must be imported statically.

### SI-03.3 — Unique Video Slug Generator
- **Status:** completed
- **Tests:** 5/5 passing (video-slug.util.spec.ts)
- **Observations:** The alphabet has exactly 64 symbols so `byte & 63` samples it uniformly — 256 is a multiple of 64, which removes modulo bias without a rejection loop. A test asserts that property directly, plus one that the whole alphabet is actually reachable (a wrong mask such as `& 15` would still produce valid-looking slugs while silently destroying entropy).

### SI-03.4 — Channel Lookup by User (resolves DG-1)
- **Status:** completed
- **Tests:** 47/47 passing across channels/users (channels.service.spec: +2 unit, channels.service.integration-spec: +2 integration, 0 regressions)
- **Observations:** `ChannelsService` now takes `(channelRepository, dataSource)`. The constructor widening is a compile error at every existing call site, so the Phase 02 specs that did `new ChannelsService(dataSource)` were updated — `channels.service.spec.ts` (6 sites), `channels.service.integration-spec.ts` and `users.service.integration-spec.ts` (2 sites).

### SI-03.5 — Video Entity and Migration
- **Status:** completed
- **Tests:** 181/181 passing suite-wide (video.entity.integration-spec.ts: 9 integration, videos.module.spec.ts: 1 module, env.validation.integration-spec.ts: +7 integration)
- **Observations:** Adding `@OneToMany(() => Video)` to `Channel` broke every spec that builds a DataSource containing `Channel` without `Video` — TypeORM fails with "Entity metadata for Channel#videos was not found". `Video` had to be registered in all 10 `ALL_ENTITIES` arrays. That constant is duplicated across 10 spec files; centralizing it in `src/test/create-test-data-source.ts` would be the right cleanup but belongs to its own task, not to a feature phase (`CLAUDE.md` § Scope Limits). `cleanAllTables` also needed `DELETE FROM "videos"` first, since videos reference channels. Postgres returns `bigint`/`numeric` as strings, so `size_bytes` and `duration_seconds` carry a transformer — a spec asserts `typeof === 'number'` for a 10GiB value rather than trusting it. The new required env vars (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`) broke `env.validation.integration-spec.ts`, which was extended to cover them plus the storage/queue/video defaults.

### SI-03.6 — Upload Initiation: Draft Pre-registration and Presigned Multipart
- **Status:** completed
- **Tests:** 40/40 across the videos module (videos.service.spec: 13 unit, videos.service.integration-spec: 5 integration against real DB + MinIO, videos.module.spec: 1 module) and 8/8 e2e
- **Observations:** The unique-violation guard that `ChannelsService` had inlined with an `as any` was extracted to `src/common/database/pg-error.util.ts` with a typed driver-error shape, so the videos slug retry reuses it instead of duplicating the cast (SI-03.14 then switches channels over to it). The `videos.module.spec` needs `ConfigModule.forRoot({ load: [videoConfig, storageConfig] })` — without it DI fails on the config tokens, which a compile-only module test would not have caught.

### SI-03.7 — Upload Completion and Processing Job Enqueue
- **Status:** completed
- **Tests:** 44/44 across the videos module (videos.service.spec: +8 unit, videos.service.integration-spec: +4 integration against real DB + MinIO + Redis) and 16/16 e2e
- **Observations:** Two dependency problems, both invisible from `peerDependencies` alone. (1) `@nestjs/bullmq@12` is published as `"type": "module"` and its `exports.require` still resolves to the ESM bundle; ts-jest compiles specs to CommonJS, so every suite importing the queue died with `SyntaxError: Unexpected token 'export'`. Downgraded to `@nestjs/bullmq@11.0.5`, which is CommonJS and whose peer range already covers `@nestjs/core ^11` and `bullmq ^6` — nothing lost. (2) `bullmq@6` demoted `ioredis` to an **optional** peer, so `new Queue(...)` threw `BullMQ could not load the optional 'ioredis' package` until it was installed explicitly. `library-refs.md` was corrected on both counts. Test isolation: the `video-worker` container shares the same Redis, so both the integration and e2e suites `queue.pause()` in `beforeAll` — otherwise the live worker consumes the enqueued jobs and flips rows underneath the assertions. The root BullMQ configuration lives in `src/queue/bull-root.options.ts` so the API and the worker can never drift on connection or retry policy. Adding a second database-touching e2e suite also exposed a latent bug: `nestjs-project/CLAUDE.md` states e2e runs with `--runInBand` and that it is "already configured", but `test:e2e` is plain `jest --config ./test/jest-e2e.json` and the config set no worker limit. With only `auth.e2e-spec.ts` touching the database the parallelism was harmless; with `videos.e2e-spec.ts` alongside it, the two suites truncated each other's tables mid-flow and 13 tests failed with spurious 401s. Fixed by setting `maxWorkers: 1` in `test/jest-e2e.json`, which makes the config match what the documentation already promised.

### SI-03.8 — Media Module: FFmpeg Metadata and Thumbnail Adapter
- **Status:** completed
- **Tests:** 10/10 passing (ffmpeg.service.integration-spec.ts: 9 integration against the real binaries, media.module.spec.ts: 1 module)
- **Observations:** Deviated from the plan's acceptance criterion that these specs run only in `video-worker`. `nestjs-project/CLAUDE.md` makes `nestjs-api` the container where every npm command runs, and the Definition of Done is `docker compose exec nestjs-api npm test` — specs that need a binary only the worker image carries would have failed there. `ffmpeg` was therefore added to `Dockerfile.dev` as well, with a comment stating it is for the test suite: the architectural boundary is enforced by module wiring (only `MediaModule` spawns a subprocess, and only the worker's module graph imports it), not by which dev image happens to have the binary. Fixtures are synthesized with `ffmpeg -f lavfi -i testsrc` at setup, so no binary asset is committed. The `-y` flag is covered by its own test: without it ffmpeg blocks on an interactive overwrite prompt and the call hangs until the timeout.

### SI-03.9 — Video Worker Bootstrap
- **Status:** completed
- **Tests:** 3/3 passing (worker.module.spec.ts: 2 unit, video-processing.module.spec.ts: 1 module)
- **Observations:** `WorkerModule` had to import `UsersModule`: `autoLoadEntities` only discovers entities registered through a `forFeature`, and although the worker only needs `Video`, `Video` → `Channel` → `User` means TypeORM refused to build metadata with `Entity metadata for Channel#user was not found` and the worker crash-looped on startup. One of the module tests asserts the inverse property directly — resolving `VideoProcessingProcessor` from `AppModule` must throw, which is what keeps the API from silently becoming a second consumer.

### SI-03.10 — Processing Job: Metadata, Thumbnail and Status Transitions
- **Status:** completed
- **Tests:** 17/17 passing (video-processing.processor.spec.ts: 12 unit, video-processing.integration-spec.ts: 5 integration against real MinIO + DB + FFmpeg)
- **Observations:** `@Processor`'s worker options are read at class-definition time and cannot be injected, so the `queueConfig` factory is called as a plain function — the same dual-purpose pattern `data-source.ts` uses for the TypeORM CLI (`phase-01-configuracao-base/TD-04`). That makes the `import 'dotenv/config'` at the top of `worker.main.ts` load-bearing: without it `.env` is not loaded when the decorator evaluates and the options silently fall back to defaults. The `failed` event guard has its own tests at `attemptsMade` 1, 2 and 3, because the event fires on every attempt and writing the terminal state unguarded would make the status column claim a permanent failure while BullMQ is still retrying. The integration spec calls `process()` directly instead of enqueueing, so it does not race the worker container listening on the same Redis.

### SI-03.11 — Public Video Metadata and Thumbnail Endpoints
- **Status:** completed
- **Tests:** 87/87 across the videos module (videos.service.spec: +7 unit) and 34/34 e2e
- **Observations:** `findReadyBySlug` raises the same `VideoNotFoundException` for an unknown slug and for a video that exists but is not `ready`, and there is a parameterised test over `draft`/`processing`/`failed` asserting exactly that — a distinct error would let anyone probe for unpublished videos. `thumbnail_url` points at the API route, never at MinIO; an e2e assertion greps the serialized payload for `minio` to keep it that way.

### SI-03.12 — Streaming with HTTP Range and Download
- **Status:** completed
- **Tests:** 15 unit (http-range.util.spec.ts) + 8 e2e covering 206/200/416, byte-exact ranges and the throttle exemption
- **Observations:** Range parsing was pulled into a pure `http-range.util.ts` rather than delegated to S3, so the endpoint's behaviour is deterministic and unit-testable: RFC 9110 lets a server ignore a `Range` it cannot parse, so malformed and multi-range headers fall back to 200 instead of erroring, while a syntactically valid but out-of-bounds range is the one case that answers 416. The `Content-Range: bytes */<total>` header for that 416 is set in the controller before the exception is thrown — headers set on the response survive into what `DomainExceptionFilter` writes. `@SkipThrottle()` on the byte-serving routes is not cosmetic: the inherited `ThrottlerGuard` is a global `APP_GUARD` at 10 req/min and a single playback issues far more range requests than that; an e2e test fires 15 consecutive range requests and expects all of them to answer 206. The storage stream is destroyed on the response's `close` event — an unconsumed S3 body holds its socket open, and a handful of abandoned seeks would exhaust the pool.

### SI-03.13 — Owner Video Listing (status observability)
- **Status:** completed
- **Tests:** 2 unit + 4 e2e
- **Observations:** `@Get('me')` is declared before `@Get(':slug')` because Express matches in declaration order and would otherwise read `me` as a slug; an e2e test asserts the route resolves to the listing and not to a 404 from the slug route. Kept deliberately minimal — id, slug, title, status, duration and `processing_error`. The richer management panel (thumbnails, view counts, likes, publication time) is a Fase 04 capability.

### SI-03.14 — Lint Gate Repair
- **Status:** completed
- **Tests:** no tests of its own — `npm run lint` exits 0, and the full suite (265 unit+integration, 86 e2e) plus `npx tsc --noEmit` stay green
- **Observations:** The inherited branch reported 190 problems / 150 errors; by the time this SI ran the phase's own specs had pushed it to 425 problems / 362 errors. All of the production-code errors were fixed for real, not suppressed: `channels.service.ts` now uses the shared typed guard in `common/database/pg-error.util.ts` instead of its inline `as any`; `create-test-data-source.ts` replaces the bare `Function` with a spelled-out `EntityDefinition` union; an unused import in `ffmpeg.service.ts` and two genuine unused variables in Phase 02 specs were removed; and a `let range` in the streaming handler that was implicitly `any` got its real `ByteRange | null` type. Only then was the scoped override added, covering `**/*.spec.ts`, `**/*.integration-spec.ts` and `**/*.e2e-spec.ts` and downgrading exactly five mock-driven rules to `warn`. Result: `npm run lint` exits 0 with 0 errors and 410 warnings, all inside test files; `src/**` non-spec code keeps every `no-unsafe-*` rule at `error`, and `no-unused-vars` and `prettier/prettier` stay errors everywhere. `npx tsc --noEmit` also turned up four real type errors the suite had been tolerating at runtime — `'paused'` is not a `JobType` in bullmq 6 (a paused queue keeps its jobs in `wait`), and `fetch`'s `BodyInit` wants a `BufferSource` backed by an `ArrayBuffer` while `readFile` returns `Buffer<ArrayBufferLike>`.

### SI-03.15 — Migration Integration Spec: Hermetic Cleanup and Third Migration
- **Status:** completed (executed early — see the execution note at the top)
- **Tests:** 2/2 passing, verified green on three consecutive runs against the same database
- **Observations:** The inherited spec was not hermetic and had never been run twice against one database: `beforeAll` dropped the managed tables but not the enum types, which are schema objects of their own and survive `DROP TABLE ... CASCADE`. On a second run `CreateAuthTokens.up()` failed with `type "verification_tokens_type_enum" already exists`. Worse, the failure left the DataSource open, so Jest reported "did not exit one second after the test run" and hung instead of surfacing the error — which is how the problem stayed invisible. Fixed by dropping the enum types alongside the tables and by destroying the DataSource when setup throws. Table and migration lists are now derived from single constants so the next migration only needs one line.

### SI-03.16 — Documentation: CLAUDE.md Video Section and OpenAPI Export
- **Status:** completed
- **Tests:** no tests of its own — `openapi.json` regenerated and verified to contain all seven video paths; every backticked file path in the CLAUDE.md files and the phase artifacts was checked to resolve to a real file
- **Observations:** `nestjs-project/CLAUDE.md` gained a `## Video Pipeline` section (upload handshake, worker, delivery, endpoint table, object layout, configuration), the new Compose services and their readiness probes, the two entrypoints, the new module table, the worker npm scripts, the e2e serialization note and the queue-pausing rule for specs. Two inherited statements were corrected rather than left stale: the root `CLAUDE.md` still described `next-frontend/` as "not yet initialized" when it is a real Next.js app, and it described the frontend as streaming from object storage, which the delivery decision reverses. `openapi.json` now documents `POST /videos/uploads`, `POST /videos/{id}/uploads/complete`, `GET /videos/me`, `GET /videos/{slug}`, `/thumbnail`, `/stream` and `/download`.
