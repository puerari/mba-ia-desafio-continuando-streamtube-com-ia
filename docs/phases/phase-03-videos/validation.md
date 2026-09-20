---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 5
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-20T16:33:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T16:30:54-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-07 routes streaming through the API; arch diagram has frontend streaming from storage"
  - id: IC-2
    status: open
    summary: "TD-01 decided the queue but arch diagram and root CLAUDE.md still declare it TBD"
  - id: AMB-1
    status: open
    summary: "Minimum payload of the draft pre-registration is unspecified (is title required at init?)"
  - id: AMB-2
    status: open
    summary: "Access level of stream/download endpoints unspecified for a phase with no visibility model"
  - id: DG-1
    status: open
    summary: "Video needs its owning channel but ChannelsService exposes no lookup by user id"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-07` decides "API `Range` proxy returning 206 Partial Content", so playback bytes traverse the API. The inherited architecture artifact states the opposite: `docs/diagrams/software-arch.mermaid:21` declares `Rel(frontend, storage, "Streams", "HTTPS")` — the frontend streaming directly from object storage. Both cannot be true of the delivered system. Explicit choice: (a) update `software-arch.mermaid` so the streaming edge goes `frontend → api → storage`, recording that direct-from-storage delivery is the deferred production evolution described in TD-07; (b) reopen TD-07 and switch to Option B (presigned redirect) to match the diagram as drawn.
- **IC-2** — `phase-03-videos/TD-01` decides BullMQ + Redis, but two inherited documents still describe the queue as undecided: `docs/diagrams/software-arch.mermaid:13` (`ContainerQueue(queue, "Message Queue", "TBD", ...)`) and `CLAUDE.md:26` (`**Message Queue** (TBD) → video processing job queue`). Leaving `TBD` in place after the decision makes the architecture documentation contradict the decisions record. Explicit choice: update both references to the decided technology as part of this phase.

### Ambiguities

- **AMB-1** — The capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" does not say what the pre-registration carries. Two readings produce different DTOs and different API contracts: (a) the client supplies `title` at upload init and it is persisted with the draft; (b) the draft is created from the file name alone and titling belongs to Fase 04's "Edição das informações do vídeo". `phase-03-videos/TD-08` fixes the *states* but not the *payload*. Explicit choice: decide which fields the init request requires and record them in the Data Model + API Contracts of the plan.
- **AMB-2** — The capabilities "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" do not state who may call them. `docs/project-plan.md` § Visão Geral says anonymous users watch freely, but per-video visibility (`público`/`unlisted`) is a Fase 04 capability, so Phase 03 has no visibility column to authorize against. The endpoints must be either `@Public()` or owner-only, and the choice changes the Authorization Matrix and the E2E suite. Explicit choice: decide the Phase 03 access level for stream and download and state how Fase 04 will tighten it.

### Missing Decisions

_None._

### Dependency Gaps

- **DG-1** — Every capability of this phase attaches a video to a channel ("Os vídeos da Fase 03 pertencem a um canal"), so the API must resolve the authenticated user's channel from the JWT `sub`. The inherited convention "Each domain owns its module, entity and service; cross-domain work goes through the other module's exported service" forbids `VideosService` from querying `Repository<Channel>` directly — but `ChannelsService` currently exposes only `createChannel(userId, email)` (`nestjs-project/src/channels/channels.service.ts:24`). There is no prior-phase deliverable providing the lookup. Explicit choice: add a channel lookup by user id to `ChannelsService` as an explicit SI of this phase, rather than letting `VideosService` reach into the channels table.

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._ All ten TDs in `## Decisions Index` are `decided`.

### UI Coverage Gaps

_None._ Phase 03 has no UI capability; `## UI Inventory` is not emitted.

## Resolved Issues

_No issues resolved yet._
