---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T16:13:24-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T16:30:54-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-20T16:13:24-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-20T16:13:24-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-20T16:13:24-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-20T16:13:24-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-20T16:13:24-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, categorias, visibilidade público/unlisted, fluxo de rascunho → publicação e painel do canal (Fase 04); página de visualização, player e contagem de visualizações (Fase 05); interações sociais (Fase 06); home, busca e responsividade (Fase 07). Nenhuma tela é entregue nesta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — Fase 03 não possui capability de interface em `docs/project-plan.md`; as telas que consomem estes endpoints pertencem às Fases 04 e 05.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta. O vídeo pertence a um canal, e o canal é criado no cadastro (Fase 02); o guard JWT global da Fase 02 é o mecanismo de autenticação dos endpoints de upload.

**Neighbors (for boundary detection only):**

- **Fase 02 (prior):** Cadastro, Login e Gerenciamento de Conta — entrega `User`, `Channel`, guard JWT global, filtro de exceções de domínio e `ValidationPipe` global.
- **Fase 04 (next):** Gerenciamento de Vídeos e Canal — consome a entidade de vídeo desta fase e adiciona categoria, visibilidade e edição.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq@^12.x, bullmq@^6.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large-File Upload Protocol (up to 10GB) | decided | C (Presigned S3 multipart orchestrated by the API) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client and Bucket/Key Layout | decided | A (AWS SDK v3, single bucket with `videos/` and `thumbnails/` prefixes) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime Topology | decided | A (Separate Compose service, shared codebase, dedicated bootstrap) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | FFmpeg Integration for Metadata and Thumbnail | decided | A (Direct `child_process` spawn of `ffprobe`/`ffmpeg`) | — _(system `ffmpeg` in the worker image)_ |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | C (Custom `crypto.randomBytes` slug + unique column with collision retry) | — _(`node:crypto`)_ |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Video Delivery — Streaming and Download | decided | A (API `Range` proxy returning 206 Partial Content) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Policy | decided | A (`draft → processing → ready \| failed`, 3 attempts with exponential backoff) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Integration Test Strategy for New Infrastructure | decided | A (Real MinIO / Redis / FFmpeg from Compose) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Repo-wide | Lint Gate Repair for Mock-Heavy Test Files | decided | A (Fix the 7 source errors, scope a test-file override) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-09 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — the phase needs exactly what BullMQ gives out of the box (retry with exponential backoff, long `lockDuration` for multi-minute FFmpeg runs, stalled-job recovery, per-job state), and `@nestjs/bullmq` keeps the worker inside the project's DI and graceful-shutdown conventions instead of hand-rolling them. The cost is one Redis container; the benefit is that video processing load never touches the transactional database, which matters because the same PostgreSQL instance serves every API read. The lost property versus pg-boss — enqueue inside the DB transaction — is recovered cheaply by enqueueing only after the transaction commits and by making the job handler re-read the video row (see TD-08).

**Libraries:** `@nestjs/bullmq@^12.x`, `bullmq@^6.x`

### phase-03-videos/TD-02

**Recommendation:** Presigned S3 multipart — it is the only option that satisfies the 10GB ceiling without adding a protocol server, and it removes the API from the data path entirely, which is the actual performance requirement. Option B is disqualified by the 5GB single-`PUT` limit and Option A by the "must not tie up the API" constraint; Option D solves a resumability problem the project does not yet have at the cost of a new server. Parameters: part size 64MiB (160 parts for 10GB, comfortably under the 10,000-part cap and large enough to keep the presigned URL list small), presigned URL TTL 1 hour, declared `fileSize` validated against a 10GiB maximum at init time.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3, single bucket with prefixes — the SDK choice follows directly from the documented production path (MinIO now, S3 later) and from TD-02, which already requires `s3-request-presigner`. A single bucket keeps bootstrap to one `CreateBucket` call; the `videos/` and `thumbnails/` prefixes preserve the separation that Option C buys with a bucket, and splitting them later is a configuration change, not a redesign. Both prefixes stay private in this phase — delivery goes through the API (TD-07).

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Separate service, shared codebase, dedicated bootstrap — it is the only option that satisfies the architecture diagram's container boundary while keeping a single source of truth for entities, migrations and config. `NestFactory.createApplicationContext()` gives a DI container without an HTTP server, so the worker reuses `VideosModule`'s storage and repository providers directly. Option B is rejected on the phase's own non-functional requirement; Option C pays monorepo-tooling cost for isolation the project does not need.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Direct `child_process` spawn — Option B is disqualified by its deprecation and Option C by the file sizes involved, which leaves the CLI contract as both the most robust and the lowest-dependency choice. The worker downloads the source object to a temporary file before probing (rather than streaming), because `ffprobe` needs random access to read container metadata reliably and seeking to a frame with `-ss` over a network stream is unreliable; the temp file is removed in a `finally` block. Thumbnail policy: frame at 10% of duration (avoiding black lead-in frames), scaled to 1280×720 preserving aspect ratio, encoded as JPEG quality 2.

**Libraries:** — _(system `ffmpeg`/`ffprobe` installed in the worker image)_

### phase-03-videos/TD-06

**Recommendation:** Custom `crypto.randomBytes` slug — Option B's ESM-only packaging is a hard blocker for a CommonJS NestJS build, and Option A fails the "short URL" requirement outright. Option C delivers Option B's ergonomics for about ten lines of dependency-free code, and it reuses the collision-retry pattern the codebase already established for channel nicknames in Phase 02, so the approach is consistent rather than novel. The database unique index is the authoritative guarantee.

**Libraries:** — _(`node:crypto`)_

### phase-03-videos/TD-07

**Recommendation:** API `Range` proxy — it is the only option that keeps authorization in the API, which is decisive because Fase 04 introduces per-video visibility that a long-lived presigned URL cannot express. The bandwidth objection is real but acceptable at this stage and does not compromise correctness: the API forwards the range and pipes the body, so it never holds a large file in memory. Option C is out of scope for this phase. Option B remains the natural production evolution once a CDN sits in front of storage, and switching to it later changes only the controller, not the data model. Parameters: `Accept-Ranges: bytes` advertised on both endpoints; a request without a `Range` header returns 200 with the full body; an unsatisfiable range returns 416; only videos in `ready` status are served.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Four states — it matches the brief exactly and each state corresponds to something the backend can actually observe, which Option C's `uploading` does not. Option B is ruled out by the explicit `pronto/erro` requirement. Failure policy: 3 attempts with exponential backoff starting at 5s; the failure reason is persisted to `processing_error` only when attempts are exhausted (via BullMQ's `failed` event guarded on `attemptsMade >= attempts`), so a transient error never surfaces as a terminal state. The job carries only the `videoId` and the handler re-reads the row, which keeps the handler idempotent and immune to the commit-then-enqueue ordering noted in TD-01.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Real Compose services — it extends the pattern Phase 02 already proved with PostgreSQL and Mailpit, and it is what the phase brief requires. Option C's isolation is genuinely better in the abstract but needs Docker-in-Docker, which the current topology does not provide. Unit specs keep mocking the storage and queue ports to test branching logic in isolation; integration specs use the real services; a fixture clip is synthesized with FFmpeg's `testsrc` source at setup time so no binary blob enters the repository.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Fix sources, scope a test-file override — it restores the DoD gate that the phase is graded on while keeping strict enforcement exactly where it matters. Option B is the "purest" answer but is a large refactor of Phase 02 code that `CLAUDE.md` § Scope Limits explicitly forbids mixing into a feature phase; Option C gives up too much. The 7 non-test errors are fixed rather than suppressed, so no production-code strictness is traded away.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — plugin architecture costs little and future phases may add social login.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The format is `{ statusCode, error, message }` and is inherited by every endpoint from Phase 02 onward.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-10

**Recommendation:** Option A — A strict `[a-z0-9_]` allowlist is the simplest and most portable choice, with a random fallback. Collision is resolved by a pre-check query plus bounded retry on PostgreSQL `23505`.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. Every new variable must land in the schema, in `.env.example` and in `compose.yaml` together. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true` and `synchronize: false`; schema changes only through reviewed migrations generated by the TypeORM CLI. _(from phase 01)_
- Every entity is registered in `TypeOrmModule.forFeature([Entity])` of its owning module — `autoLoadEntities` only discovers entities reachable through a `forFeature`. _(from phase 02)_
- Entities use `@PrimaryGeneratedColumn('uuid')`, snake_case column names, `@CreateDateColumn`/`@UpdateDateColumn`, and `{ select: false }` for sensitive columns. _(from phase 02)_
- Services throw `DomainException` subclasses from `src/common/exceptions/` — never NestJS HTTP exceptions; `DomainExceptionFilter` maps them to `{ statusCode, error, message }` where `error` is the domain code. _(from phase 02)_
- The global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) and both global filters are configured in `main.ts`; E2E specs must re-apply them because `Test.createTestingModule()` does not execute `main.ts`. _(from phase 02)_
- `JwtAuthGuard` is a global `APP_GUARD` registered in `AuthModule` — every endpoint is authenticated by default; public endpoints opt out with `@Public()`, and the authenticated payload is read with `@CurrentUser()`. _(from phase 02)_
- Each domain owns its module, entity and service; cross-domain work goes through the other module's exported service rather than through its repository. _(from phase 02)_
- A collision on a naturally-unique generated column is resolved by pre-check plus bounded retry on PostgreSQL error `23505`, not by savepoints. _(from phase 02)_
- Controllers are documented with `@ApiTags`/`@ApiOperation`/`@ApiResponse`, referencing `ApiErrorEnvelope` via `getSchemaPath` for error shapes; `openapi.json` is regenerated with `npm run openapi:export`. _(from task openapi-docs-nestjs)_
- Non-TypeScript runtime assets must be declared in `nest-cli.json` → `compilerOptions.assets`, otherwise they exist in `src/` but are missing from `dist/`. _(from phase 02)_
- Integration specs build their DataSource with `createTestDataSource()` against the real `db` service; integration and E2E share one database and must run with `--runInBand`. _(from phase 02)_
- Side-effect dependencies are exercised against their real Compose container (Mailpit for email) in integration specs rather than mocked. _(from phase 02)_
- All `npm`, `npx`, `node` and test commands run inside the `nestjs-api` container; host execution diverges on env vars and Node version. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | delivered later | phase-02-auth | Deferred by `phase-02-auth`, then delivered by the `phase-02-auth-frontend` slice. No action required in Phase 03. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Specific layer coverage by SI is recorded in `progress.md`.

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration — constraints, defaults, `select: false`, relations |
| Service with branching + DB | Unit (mocked repository) + Integration (real DB contract) |
| Service with DB only (no branching) | Integration |
| Service with a configured lib (JWT, BullMQ queue) | Unit with a real instance and test config |
| Service with a side-effect dependency (storage, queue, FFmpeg) | Integration against the real Compose service |
| Module with configured imports (`forFeature`, `registerQueue`) | Unit — compilation test |
| Controller (`*.controller.ts`) | E2E only — no unit tests |
| DTO (`*.dto.ts`) | E2E — one validation-wiring test per endpoint |
| Guard (`*.guard.ts`) | E2E, plus Unit when it holds non-trivial internal logic |
| Exception filter (`*.filter.ts`) | Unit + E2E |
| Queue processor / worker handler | Unit (mocked ports) + Integration (real queue, real storage, real FFmpeg) |

_Phase-specific note (per `phase-03-videos/TD-09`):_ the queue processor and the storage adapter are new artifact types for this project. They follow the `Service with a side-effect dependency` row — unit specs mock the storage and queue ports to exercise branching, integration specs run against the real MinIO and Redis containers, and the FFmpeg fixture clip is synthesized at test setup with `testsrc` so no binary asset is committed.

### next-frontend

_Deferred subproject — Phase 03 delivers no UI surface; testing requirements for the video screens will be defined in Fase 04/05._
