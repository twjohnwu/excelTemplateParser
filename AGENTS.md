# excelTemplateParser — Agent Guide

ERP Excel batch conversion tool. Single-machine intranet deployment via `docker compose up`.

## Architecture

- **Backend** (`backend/`): Python 3.12 + FastAPI + openpyxl + pandas + RQ
- **Frontend** (`frontend/`): React 18 + Vite + TypeScript + shadcn/ui + zod + TanStack Query
- **Storage**: Redis (AOF persistence) + filesystem (`/data/` as source of truth)
- **Worker**: RQ background worker; one subtask per primary source file

See `docs/spec/` for full design docs (proposal / design / tasks / spec). For known pitfalls discovered post-launch (schema null serialization, broadcast semantics, source_cell pipeline forking, draft autosave races) and the 2026-07 UX overhaul decisions (wizard rejection, stateless preview, layout-height lessons), scan `docs/decisions_log.md` Parts 2–3 before adding similar features.

## Layout

```
backend/
  app/
    api/         # FastAPI routers (templates / configs / jobs)
    services/    # config_service, job_service, recovery_service, cleanup_service + scheduler.py
    core/        # Pure functions: parser / joiner / mapper / writer / zipper / preflight / preview / atomic_io / exceptions
    middleware/  # request_id.py, upload_limit.py
    workers/     # tasks.py (RQ subtask + finalize), queue.py, run.py
    main.py      # FastAPI entry + lifespan (recovery + scheduler)
    settings.py
    schemas.py   # Pydantic ConfigSchema (mirror of frontend zod schema)
  tests/         # pytest unit tests (19 files: core / services / api / workers)
  pyproject.toml
  Dockerfile
frontend/
  src/
    pages/             # ConfigBuilder, BatchRunner, JobDetail
    features/          # config-builder/{SourcesTree,JoinsEditor,MappingsList,MappingRow,ChecklistRail,PreviewDialog}, batch-runner/{NewBatchForm,JobsList}
    components/        # TopMenuBar, JobsPanel, FileDropzone, SheetHeaderPicker, ConditionChip, ui/*
    hooks/             # useConfigs, useJobSnapshot, useDebounce, usePreviewConfig
    lib/               # schemas.ts (zod ConfigSchema — mirror of backend), api.ts, recentJobs.ts, configHelpers/previewHelpers/issueHelpers.ts, i18nGuard.test.ts
    i18n/              # zh-TW.json, en.json, index.ts
    theme/             # ThemeProvider.tsx, ThemeProvider.test.tsx
  Dockerfile
  nginx.conf
  e2e/                 # Playwright specs (one per VERIFICATION_REPORT §8 row) + fixtures/
docs/
  spec/                # proposal / design / tasks / spec (design-phase snapshot; code is authoritative)
  decisions_log.md     # 22 design decisions + 9 post-launch iterations + 6 UX-overhaul entries + 1 crash-safety entry
  case_study.md, learnings.md, plan.md
  setup.md, setup.zh-TW.md  # install / dev / env / CI
  ss/                  # Screenshots for README walkthrough
scripts/               # up.sh, smoke_test.py, resume_test.py, VERIFICATION_REPORT.md
data/                  # Default DATA_DIR mount point (redis/, configs/, jobs/) — gitignored
docker-compose.yml
.github/workflows/ci.yml  # backend, frontend, docker-smoke (+ Playwright)
```

## Local Development

### With Docker (recommended)

```bash
bash scripts/up.sh        # builds frontend bundle locally, then `docker compose up -d`
# UI:   http://localhost:5173
# API:  http://localhost:8000
```

The frontend image is a slim `nginx:alpine` that serves a pre-built `frontend/dist/`. `scripts/up.sh` rebuilds `dist/` whenever `src/` is newer (or `dist/` is missing), then brings up all four services.

### Restart matrix

```
backend change   → docker compose restart api worker     # bind-mounted, no rebuild needed
frontend change  → cd frontend && npm run build && docker compose up -d --force-recreate frontend
schema change    → restart both (backend rebuild caches, frontend rebuild bundle)
```

### Without Docker (for tests)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest                              # unit tests

cd ../frontend
npm install
npm test -- --run                   # vitest unit tests
npm run typecheck                   # tsc --noEmit
npm run e2e   # Playwright, needs the docker stack up
```

## Key Conventions

- **Error boundaries**: `core/` only raises `CoreError` subclasses with `user_message` + `tech_detail`; worker and FastAPI handlers catch at edges and never re-raise after logging. Mid-core `try/except` for "just logging" is forbidden — it swallows stack traces.
- **State**: every job lives at `/data/jobs/{id}/` with `state.json` as the persistent source of truth; Redis caches the same. Read-modify-write of `state.json` is wrapped by `JobService._locked_state` (`fcntl.flock`).
- **Crash safety / idempotency**: every persistent write (`state.json`, `out/*.out.xlsx`, the ZIP) goes through `core/atomic_io.py` (same-dir temp file + fsync + `os.replace`), so "final path exists" means "complete" — recovery and `run_subtask` skip on existence alone, and `scan_and_resume` sweeps `.tmp-*` older than `JOB_TIMEOUT_MIN + 60 s` (younger ones may be in flight). Status changes go through the transition tables in `job_service.py` (`SUBTASK_TRANSITIONS` / `JOB_TRANSITIONS`, illegal → `IllegalTransition`); `mark_done`/`mark_failed` on an already-terminal subtask are no-ops returning `is_last=False`. `finalize_job` returns early if the ZIP exists and packs under `JobService.finalize_lock`. RQ ids are deterministic (`{job}__sub__{sha1(name)[:16]}`, `{job}__finalize`); `enqueue_*` skip when that id is queued, or started with a heartbeat younger than 90 s, and reclaim stale started jobs otherwise; the API also re-runs `scan_and_resume` every `RESUME_SCAN_SECONDS` (default 120) as a backstop, so API and worker may both scan.
- **Logging**: `structlog` JSON output. Every log line carries `request_id` (API) or `job_id` + `source_file` (worker).
- **Schema dual-maintenance**: `backend/app/schemas.py` (pydantic) and `frontend/src/lib/schemas.ts` (zod) are two language versions of the same `ConfigSchema`. Any field add / remove / xor change MUST touch both files and align cross-field validation.
- **Mapping has three modes**: `source` (`alias.col`), `source_cell` (`{alias, address}` for absolute xlsx cell read), and `literal`. The three are mutually exclusive (validated in both pydantic and zod). Mapper branches on them; worker's `_resolve_source_cells` pre-resolves cell mode via openpyxl before the joiner stage. Adding a fourth mode touches schemas (both ends) + mapper + worker pre-resolver + `MappingRow.tsx` toggle.
- **df_needed_aliases**: not every source enters the parser/joiner/mapper pipeline. `source_cell`-only aliases bypass `parser.parse()` (handled separately by `resolve_source_cells`). These shared helpers now live in `backend/app/core/preview.py`; workers AND the preview endpoint import the same functions — never fork pipeline logic between them. When adding a new mapping mode or worker stage, re-evaluate `df_needed_aliases` and the matching guard in `_run_preflight`.
- **Preview is stateless by design**: `POST /api/configs/preview` stages uploads in a tempdir and deletes them in `finally` — it must never write under `/data` or create a job/Redis state. Recovery and cleanup scan `/data/jobs` as truth; a "preview job" would poison both (decisions_log Part 3 #3).
- **i18n**: every user-facing string goes through i18n keys present in BOTH `zh-TW.json` and `en.json` (keep key sets symmetric). `lib/i18nGuard.test.ts` fails the suite on any CJK literal outside `i18n/`. Zod messages are `err.*` keys translated only at the display boundary; `schemas.ts` never imports i18next.
- **localStorage is user-owned**: ConfigBuilder autosave only writes when `JSON.stringify(toPersistable(state)) !== EMPTY_PERSISTABLE_JSON`; `localStorage.removeItem(DRAFT_KEY)` is restricted to explicit user actions (`discardDraft` and `handleSave` on success). Never let autosave mutate or purge localStorage on its own — empty state must be a no-op.
- **Dark mode color pairing**: Tailwind hardcoded color (`bg-blue-50`, `bg-amber-50`, …) MUST be paired with explicit `text-*` AND `dark:bg-*-900/40 dark:text-*-100`; otherwise dark mode produces white-on-white. Canonical pattern lives in `MappingRow.tsx`.
- **Optional field guards**: every `m.foo.bar()` on a pydantic Optional field needs `if m.foo is not None`; mypy is not strict, so this is a hand-rule. On the frontend, the backend serializes `null` for unset optional fields, and zod's bare `.optional()` rejects null — every optional string field in `schemas.ts` must be wrapped with `nullishToUndef` (see existing usages) or loading saved configs breaks (decisions_log Part 3 #5).

## When modifying

| Change | Don't forget |
|---|---|
| Add a mapping field | Both `backend/app/schemas.py` and `frontend/src/lib/schemas.ts` (xor + cross-field check); mapper if it changes pipeline shape; UI in `MappingRow.tsx` (mode toggle + collapsed-row rendering) |
| Add a config field | Schema both ends; ConfigBuilder `toConfig` / `restoreDraft` / `EMPTY_PERSISTABLE_JSON`; preflight required-column collection in `api/jobs.py::_collect_required_columns` if relevant |
| Add a worker stage | Re-evaluate `df_needed_aliases` — a new stage may need its own "needed-by-stage" alias set; mirror the filter in `_run_preflight` |
| Add an autosave / autoload | Define behavior at three boundaries: empty input / mount tick / storage cleanup. Never let an auto behavior mutate user data without explicit consent |
| Add hardcoded UI color | Pair with explicit `text-*` + `dark:*` variants; cross-check `MappingRow.tsx` for the canonical pattern |
| Touch error path | Preserve `user_message` + `tech_detail` split; ensure `request_id` flows through to the response; never `try/except` mid-core just to log |
| Change config JSON shape | Bump or sanity-check the `version` field; check `inferColumnsFromConfig` and `mergeMappingsWithColumns` still work on old shapes; wrap new optional strings with `nullishToUndef`; regression-test LOADING previously saved configs, not just creating new ones |
| Add a user-facing string | i18n keys in both locales (never a literal — `i18nGuard.test.ts` will fail); validation messages as `err.*` keys resolved at display boundary |
| Touch job/subtask status | Go through `_transition` + the tables; never assign `.status` directly. Add the edge to both tables and a test in `test_job_service.py` |
| Add a file the worker persists | Write it via `core/atomic_io.py`; recovery treats existence as completion |

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection |
| `DATA_DIR` | `./data` | Filesystem root for configs and jobs |
| `MAX_UPLOAD_MB` | `50` | Per-file upload limit |
| `RQ_WORKERS` | `4` | Worker concurrency |
| `JOB_TIMEOUT_MIN` | `10` | Per-subtask timeout |
| `DOWNLOAD_GRACE_MINUTES` | `60` | ZIP re-download grace window |
| `JOB_RETENTION_HOURS` | `24` | Sweep undownloaded jobs after N hours |
| `LOG_LEVEL` | `INFO` | structlog level |
