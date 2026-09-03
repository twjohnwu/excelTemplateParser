# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-04

Crash-safety and operability release. Every persistent write is now atomic, recovery reconciles
state with what is on disk, cancellation is cooperative, and the test/CI surface was widened.

### Added

- GitHub Actions CI: `backend` (pytest), `frontend` (typecheck, vitest, build), `docker-smoke`
  (compose with healthchecks, smoke + resume tests, Playwright e2e).
- Six Playwright e2e specs replacing the formerly manual UI verification items
  (§8.8, 8.15, 8.19, 8.20, 8.23, 8.24 of `scripts/VERIFICATION_REPORT.md`).
- Job snapshot field `zip_ready`; a partial-failure job's ZIP is downloadable from the UI with a hint.
- Periodic recovery scan (`RESUME_SCAN_SECONDS`, default 120) as a backstop after worker crashes.
- Subtask status `cancelled` and job field `cancelled_at`.
- `docs/setup.md` / `docs/setup.zh-TW.md` (install, development, environment, CI, e2e).

### Changed

- `state.json`, output xlsx and the result ZIP are written via temp file + fsync + `os.replace`;
  "final path exists" now means "complete".
- Job and subtask status changes go through explicit transition tables; repeated `mark_done` is a no-op.
- RQ job ids are deterministic (`{job}__sub__{sha1(name)}`, `{job}__finalize`) with duplicate suppression
  and reclaim of stale `started` jobs.
- Cancel is a tombstone: state and job directory are kept, queued work is dropped, running workers stop
  cooperatively, and cleanup removes the directory once nothing is running (or after `JOB_TIMEOUT_MIN + 1` min).
- README trimmed; setup, development, environment variables and repository layout moved to `docs/setup*.md`.

### Fixed

- A worker killed mid-write could leave a truncated `state.json`, xlsx or ZIP.
- Repeated `mark_done` on the same subtask could enqueue finalize twice; finalize had no lock or ZIP guard.
- API and worker both running `scan_and_resume` could enqueue the same subtask twice.
- After SIGKILL, RQ jobs left `started` blocked re-enqueue indefinitely.
- Chinese source filenames collided into one RQ job id, silently dropping subtasks.
- An output written before the crash but never marked done left the job stuck in `pending`.
- Finalize did not publish an SSE event after packing, so the download button needed a reload.
- Cancelling deleted the job directory immediately, so running workers hit `JobNotFound`.

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
