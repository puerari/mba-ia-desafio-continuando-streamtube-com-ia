# phase-03-videos — Progress

**Status:** in progress
**SIs:** 6/16 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.7 — Upload Completion and Processing Job Enqueue
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.8 — Media Module: FFmpeg Metadata and Thumbnail Adapter
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.9 — Video Worker Bootstrap
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.10 — Processing Job: Metadata, Thumbnail and Status Transitions
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.11 — Public Video Metadata and Thumbnail Endpoints
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.12 — Streaming with HTTP Range and Download
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.13 — Owner Video Listing (status observability)
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.14 — Lint Gate Repair
- **Status:** pending
- **Tests:** —
- **Observations:** —

### SI-03.15 — Migration Integration Spec: Hermetic Cleanup and Third Migration
- **Status:** completed (executed early — see the execution note at the top)
- **Tests:** 2/2 passing, verified green on three consecutive runs against the same database
- **Observations:** The inherited spec was not hermetic and had never been run twice against one database: `beforeAll` dropped the managed tables but not the enum types, which are schema objects of their own and survive `DROP TABLE ... CASCADE`. On a second run `CreateAuthTokens.up()` failed with `type "verification_tokens_type_enum" already exists`. Worse, the failure left the DataSource open, so Jest reported "did not exit one second after the test run" and hung instead of surfacing the error — which is how the problem stayed invisible. Fixed by dropping the enum types alongside the tables and by destroying the DataSource when setup throws. Table and migration lists are now derived from single constants so the next migration only needs one line.

### SI-03.16 — Documentation: CLAUDE.md Video Section and OpenAPI Export
- **Status:** pending
- **Tests:** —
- **Observations:** —
