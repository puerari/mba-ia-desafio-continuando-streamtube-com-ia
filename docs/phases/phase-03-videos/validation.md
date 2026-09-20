---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-20T16:39:48-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T16:38:32-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-07 routes streaming through the API; arch diagram has frontend streaming from storage"
    resolved_by: docs/diagrams/software-arch.mermaid
  - id: IC-2
    status: resolved
    summary: "TD-01 decided the queue but arch diagram and root CLAUDE.md still declare it TBD"
    resolved_by: docs/diagrams/software-arch.mermaid
  - id: AMB-1
    status: resolved
    summary: "Minimum payload of the draft pre-registration is unspecified (is title required at init?)"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "Access level of stream/download endpoints unspecified for a phase with no visibility model"
    resolved_by: phase-03-videos/TD-07
  - id: DG-1
    status: resolved
    summary: "Video needs its owning channel but ChannelsService exposes no lookup by user id"
    resolved_by: SI-03.4
advisories: []
---

# phase-03-videos — Validation

_Revision 2 — after `/plan-resolve`. Revision 1 closed `dirty` with 5 open issues; all five are resolved below._

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ Each of the nine capability bullets in `## Capability Coverage` is covered by at least one decided TD, and the HTTP error response format is inherited from `phase-02-auth/TD-07`.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._ The ten current-phase TDs were re-checked against `## Inherited Conventions`: the worker bootstrap (`TD-04`) keeps the `registerAs` config convention from Phase 01, the storage and queue adapters keep the "services throw domain exceptions" rule from Phase 02, and the integration-test strategy (`TD-09`) extends — rather than contradicts — the Phase 02 precedent of exercising real Compose services.

### Unresolved Open Questions

_None._ All ten TDs in `## Decisions Index` are `decided`.

### UI Coverage Gaps

_None._ Phase 03 has no UI capability; `## UI Inventory` is not emitted.

## Resolved Issues

- **IC-1** _(resolved_by `docs/diagrams/software-arch.mermaid`)_ — `TD-07` routes playback through the API while the diagram drew `Rel(frontend, storage, "Streams", "HTTPS")`. The diagram now reads `Rel(frontend, storage, "Uploads parts (presigned)", "HTTPS")` and `Rel(api, storage, "Presigns, reads and streams")`, which matches both decided flows: the client talks to storage directly **for upload only**, and playback bytes go through the API. The root `CLAUDE.md` § Architecture bullets were updated to the same wording.
- **IC-2** _(resolved_by `docs/diagrams/software-arch.mermaid`)_ — the queue's `TBD` placeholder was replaced with the decided technology in both places it appeared: `ContainerQueue(queue, "Message Queue", "Redis + BullMQ", ...)` in the diagram and `**Message Queue** (Redis + BullMQ)` in the root `CLAUDE.md`.
- **AMB-1** _(resolved_by `phase-03-videos/TD-08`)_ — a `**Revisions:**` entry on TD-08 pins the pre-registration payload: upload init requires `title` (1–200 chars) plus the client-declared `filename`, `size_bytes` and `content_type`, with no filename-derived default. Rationale recorded in the TD: Fase 04 owns title editing, so Phase 03 persists a titled draft instead of inventing a title rule that Fase 04 would undo.
- **AMB-2** _(resolved_by `phase-03-videos/TD-07`)_ — a `**Revisions:**` entry on TD-07 pins the Phase 03 access level: the read endpoints (`GET /videos/:slug`, `/stream`, `/download`) are `@Public()` and serve only `ready` videos, while the upload handshake and the owner's listing require authentication. Fase 04's visibility column will tighten the same endpoints without changing their shape.
- **DG-1** _(resolved_by `SI-03.4`)_ — the channel lookup missing from `ChannelsService` is planned as an explicit step of this phase rather than worked around. `SI-03.4` adds `findByUserId(userId)` to `ChannelsService` and exports it, so `VideosService` resolves the owning channel through the channels module's public API and never queries `Repository<Channel>` directly — honoring the inherited single-responsibility convention.
