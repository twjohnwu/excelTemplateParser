# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-18

Initial public release. Single-machine Docker deployment, no login required.

### Added

- **Project Settings** workbench (three-pane: sources tree / joins editor /
  mappings list) for authoring conversion configs as portable JSON.
  - Sheet picker + 30-row preview for choosing the header row on uploaded xlsx.
  - Inline-expandable mapping rows with three-color condition chips
    (field / operator / value) and per-mapping default values.
  - Seven condition operators: `>=, <=, ==, !=, contains, regex, in` (regex
    has a 5-second per-cell timeout to prevent ReDoS).
  - Auto-seeded mappings list when a target template is uploaded.
  - Draft autosave to `localStorage` every second; restore prompt on reload.
  - Load any saved config via `?config=<name>`; dropdowns populate from the
    config's existing references even without re-uploading xlsx files.
  - "Save & download" plus standalone "Download current config" buttons.
  - Optional `sample_filename` field per source/target captured at save time
    and surfaced as a "Last used: …" hint on the Batch Convert page.
- **Batch Convert** (left form + right job list):
  - Multi-source upload via dynamic slots derived from the config schema:
    primary slot accepts many files (one subtask per file); each lookup
    slot accepts exactly one shared file.
  - Synchronous preflight validation (sheet existence, required columns)
    before subtasks are queued — failures return HTTP 422 with a precise
    detail message.
  - Live SSE progress with subtask-level breakdown; ETA shown after 5
    completed subtasks.
  - Cancel an in-flight job; output artefacts are removed and Redis keys
    purged immediately.
  - Output ZIP contains one xlsx per primary plus a `_summary.txt` listing
    each subtask's outcome. Partial-failure jobs still ship the successes.
  - Download grace period of one hour with HTTP `Range` support for
    resuming interrupted transfers.
- **TopMenuBar** with active-jobs badge, recent-jobs dropdown panel,
  light/dark theme toggle (honours `prefers-color-scheme` on first visit),
  and zh-TW / en language switch.
- **Job Detail** route (`/jobs/{id}`) showing per-subtask status, retry of
  failed subtasks, cancel, and ZIP download with grace-period countdown.

### Architecture

- FastAPI + RQ workers backed by Redis (AOF) plus filesystem dual-write at
  `${DATA_DIR}`. The filesystem is the source of truth; Redis is a cache.
  Loss of the Redis volume rebuilds state from `${DATA_DIR}/jobs/*/state.json`.
- Subtask-level resume: worker startup re-enqueues unfinished subtasks;
  existing `out/{primary}.out.xlsx` outputs are skipped (idempotent).
- Boundary error handling: `core/*` raises typed exceptions; worker and
  FastAPI translate them at their edges. Every error response carries a
  `request_id` for correlation with `structlog` JSON logs.
- APScheduler (in-process) runs grace-expiry sweeps every 10 minutes and
  retention sweeps hourly.

### Operations

- One-command launch via `bash scripts/up.sh` (builds frontend bundle
  locally, then `docker compose up -d` for redis / api / worker / frontend).
- End-to-end verification scripts: `scripts/smoke_test.py` (14 scenarios)
  and `scripts/resume_test.py` (mid-batch worker restart).
- Environment overrides via `.env` (`MAX_UPLOAD_MB`, `RQ_WORKERS`,
  `DOWNLOAD_GRACE_MINUTES`, `JOB_RETENTION_HOURS`, etc.).

### Tests

- Backend: 118 unit tests (`pytest`).
- Frontend: 29 unit tests (`vitest` + `@testing-library/react`).

### Design docs

- 22-entry decision log, 6 cross-decision learnings, 7-round design
  case study, plus the full OpenSpec proposal / design / tasks / spec
  under `docs/`.

[Unreleased]: https://github.com/twjohnwu/excelTemplateParser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/twjohnwu/excelTemplateParser/releases/tag/v0.1.0
