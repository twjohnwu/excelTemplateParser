# excelTemplateParser

**English** · [繁體中文](README.zh-TW.md)

Batch-convert many Excel files of the same format into another format. Author the mapping once, reuse forever. Single-machine Docker deployment, no login required. UI supports zh-TW / English and light / dark mode, both persisted locally.

---

## Features

- **Subtask-level resume** — each primary file = one task; if a worker crashes mid-batch, completed `out/*.xlsx` files are skipped on restart (idempotent recovery via `recovery_service.scan_and_resume()`).
- **Live progress that survives reloads** — SSE per-subtask updates; the top-bar badge + localStorage track running jobs across page reloads, so you can close the tab and come back.
- **Reliable downloads** — HTTP Range / partial content on the result ZIP; one-hour grace window for re-download after the first stream.
- **Disaster recovery** — Redis is a cache; `/data/` on disk is the source of truth. Wiping the Redis volume rehydrates jobs from `state.json` on next startup.
- **Preflight validation** — bad xlsx / missing sheet / missing columns rejected at the API boundary (~5 s for 50 files) instead of crashing mid-batch in the worker.
- **Boundary-only error handling** — every error response carries a `request_id`; `docker compose logs api | grep <id>` finds the full traceback. User-facing messages and engineer-facing tracebacks never mix.
- **i18n + dark mode** — zh-TW / English, light / dark theme; both persisted in localStorage with no flash on reload.
- **Autosave + draft restore** — ConfigBuilder autosaves to localStorage and offers an explicit Restore / Discard prompt on revisit; the storage is only mutated by explicit user actions, never auto-purged.

---

## One-command launch

```bash
bash scripts/up.sh
# → http://localhost:5173
```

`scripts/up.sh` rebuilds `frontend/dist/` locally only if it's missing or stale, then runs `docker compose up -d` to start four services (redis / api / worker / frontend).

To refresh a specific service after changes:

```bash
docker compose restart worker            # backend code is bind-mounted from ./backend
cd frontend && npm run build && docker compose up -d --force-recreate frontend
```

---

## How it works

Two tabs, two user modes:

| Tab | Purpose | Frequency |
|---|---|---|
| **Project Settings** | Author column mappings, join rules, conditions once → download `{name}.json` | Rare, deliberate |
| **Batch Convert** | Upload config + target template + source files → server packages a ZIP | Frequent, frictionless |

A configuration has three parts:

- **target_template** — the output workbook (its styling is preserved)
- **sources** — one `primary` (the per-row transactional file, batched) plus N `lookup` files (master data, shared across the whole batch)
- **joins / mappings** — multi-hop joins plus per-target-column mappings with three value modes:
  - **column reference** (`alias.col`) — pulled per row from the joined DataFrame
  - **absolute cell reference** (`alias!A3`) — fixed value read straight from the source xlsx via openpyxl, bypassing the header abstraction
  - **literal** — a constant string
  - All three modes support conditions (`>=, <=, ==, !=, contains, regex, in`) and default values.

Each primary file = one subtask = one output xlsx. Lookups are shared across all subtasks. When every subtask finishes, the outputs are packed into a single ZIP, which also contains a `_summary.txt` manifest listing each subtask's status, duration, and any errors.

---

## Walkthrough

End-to-end flow in six steps:

### 1. Author the config

![Project Settings — three-pane workbench](docs/ss/excelTemplateParser-projectSettings.png)

Three-pane workbench: left = sources tree (target template + each source's xlsx with sheet & header-row picker). Middle = join rules. Right = mappings with inline condition chips and the source / source_cell / literal toggle. Save → download `{name}.json`.

### 2. Restore unsaved draft

![Project Settings — restore banner](docs/ss/excelTemplateParser-projectSettingsRestore.png)

On revisit, if a previous-session draft exists, a non-intrusive banner offers Restore / Discard. The banner only goes away on explicit choice; autosave never touches an empty form, so first-time visitors don't see it.

### 3. Batch convert — upload inline config

![Batch Runner — upload config JSON](docs/ss/excelTemplateParser-uploadConfigFile.png)

If the config isn't saved on the server, upload `{name}.json` directly. The form parses the JSON, dynamically expands upload slots by source alias, and shows the last-used sample filename as a hint per slot.

### 4. Pick saved config + live progress

![Batch Runner — saved config dropdown + SSE progress](docs/ss/excelTemplateParser-loadFromRedisAndCheckNotify.png)

For configs already saved on the server (from Project Settings → Save), the dropdown lists them by name (loaded from Redis / `/data/configs/`). Subtask-level progress streams via SSE; the top-bar badge tracks running jobs across page reloads, and the right-rail pulls recent jobs from localStorage so you can revisit any past job.

### 5. Job detail

![Job detail — per-subtask status + download](docs/ss/excelTemplateParser-downloadDetails.png)

Stable URL `/jobs/:id` for sharing. Shows per-subtask status, errors with `request_id` for grep-from-logs, a Cancel button for in-flight jobs, and a Download button that streams the result ZIP (supports HTTP Range / resume).

### 6. Result ZIP

![Result ZIP — output xlsx files + _summary.txt](docs/ss/excelTemplateParser-downloadedZIPFile.png)

The ZIP contains one xlsx per primary input (`{source_filename}.out.xlsx`, style preserved from the target template) plus `_summary.txt` — a per-job manifest listing each subtask's status, duration, and any errors. The manifest doubles as a quick audit trail when batching dozens of files.

---

## Architecture

```
┌──────────────┐    REST + SSE    ┌──────────────┐
│ React SPA    │ ───────────────▶ │ FastAPI      │
│ (Vite + TS)  │                  │ + APScheduler│
│ shadcn/ui    │ ◀─────────────── │ (lifespan:   │
└──────────────┘   /api/* proxy   │  recovery +  │
       │                          │   cleanup)   │
       │ nginx serve              └──────┬───────┘
       │                                 │
       │                       ┌─────────┴────────────┐
       │                       │                      │
       ▼                       ▼                      ▼
   localhost:5173        Redis (AOF)            RQ Worker × N
                              │                       │
                              └──────────┬────────────┘
                                         │
                            ┌────────────▼─────────────┐
                            │ /data/  (DATA_DIR)        │
                            │  redis/, configs/,        │
                            │  jobs/{id}/{state.json,   │
                            │            uploads/, out/,│
                            │            result.zip}    │
                            └───────────────────────────┘
```

**Storage strategy** — Redis is a cache; `/data/` on disk is the source of truth. Every mutation writes both. If the Redis volume is lost, workers rebuild from `state.json` on startup.

**Failure recovery** — Subtask-level resume. When workers crash or restart, `recovery_service.scan_and_resume()` re-enqueues unfinished subtasks; outputs that already exist at `out/{primary}.out.xlsx` are skipped (idempotent).

**Error handling** — Boundary-only. Core functions only `raise`; the worker and FastAPI layers catch at their respective edges, persist to `state.json` and emit structured `structlog` JSON. Every error response carries a `request_id` so `docker compose logs api | grep <id>` finds the full traceback.

---

## Repository layout

```
excelTemplateParser/
├── docker-compose.yml
├── README.md            ← this file
├── README.zh-TW.md      ← 繁體中文版
├── AGENTS.md            ← english reference for collaborating agents
├── scripts/
│   ├── up.sh            ← one-command launcher
│   ├── smoke_test.py    ← §8 automated end-to-end (14 scenarios)
│   ├── resume_test.py   ← §8.9 mid-batch worker restart
│   └── VERIFICATION_REPORT.md
├── backend/
│   ├── pyproject.toml   ← Python 3.12+, FastAPI, RQ, openpyxl, structlog, APScheduler
│   ├── Dockerfile
│   └── app/
│       ├── main.py              ← FastAPI entry + lifespan
│       ├── settings.py          ← env config
│       ├── schemas.py           ← Pydantic ConfigSchema
│       ├── logging_config.py    ← structlog JSON
│       ├── api/{templates,configs,jobs}.py
│       ├── services/{config,job,recovery,cleanup}_service.py + scheduler.py
│       ├── core/{parser,joiner,mapper,writer,zipper,preflight,exceptions}.py
│       ├── middleware/{request_id,upload_limit}.py
│       └── workers/{queue,tasks,run}.py
├── frontend/
│   ├── package.json     ← React 18 + Vite + TS + shadcn/ui + zod + TanStack Query
│   ├── Dockerfile       ← single-stage nginx:alpine (serves dist/)
│   ├── nginx.conf       ← static + /api/ proxy to api:8000
│   └── src/
│       ├── pages/{ConfigBuilder,BatchRunner,JobDetail}.tsx
│       ├── features/config-builder/{SourcesTree,JoinsEditor,MappingsList,MappingRow}.tsx
│       ├── features/batch-runner/{NewBatchForm,JobsList}.tsx
│       ├── components/{TopMenuBar,JobsPanel,FileDropzone,SheetHeaderPicker,ConditionChip,ui/*}.tsx
│       ├── hooks/{useJobSnapshot,useConfigs}.ts
│       ├── lib/{api,recentJobs,schemas,utils}.ts
│       ├── i18n/{index.ts, zh-TW.json, en.json}
│       └── theme/ThemeProvider.tsx
└── data/                ← Runtime artefacts (git-ignored)
```

---

## Development & testing

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate    # Python 3.12+ required
pip install -e ".[dev]"
pytest                    # unit tests (core / services / api / workers)
```

Key unit test files:

| File | Covers |
|---|---|
| `tests/test_parser.py` | xlsx → DataFrame, header_row handling, corrupt file detection |
| `tests/test_joiner.py` | Multi-hop joins, missing key errors |
| `tests/test_mapper.py` | All 7 operators, conditions, defaults, auto-union of mapping targets |
| `tests/test_writer.py` | Style preservation, appending unknown columns |
| `tests/test_*_service.py` | Redis + file dual-write, ETA, cancel, grace expire, recovery |
| `tests/test_api_*.py` | FastAPI endpoints, 422 / 409, SSE, multipart shape |
| `tests/test_worker_pipeline.py` | End-to-end pipeline (idempotent skip, cancel flag, partial failure) |

### Frontend

```bash
cd frontend
npm install
npm run typecheck         # tsc --noEmit
npm run build             # produces dist/
npm run dev               # Vite dev server with HMR
```

### End-to-end

```bash
bash scripts/up.sh                                  # bring the stack up
backend/.venv/bin/python scripts/smoke_test.py      # automated end-to-end scenarios
backend/.venv/bin/python scripts/resume_test.py     # restart-mid-batch resume
```

Full §8 coverage (22 items, §8.2–8.23) is documented in [`scripts/VERIFICATION_REPORT.md`](scripts/VERIFICATION_REPORT.md).

---

## Environment variables

Set in `.env` or `docker-compose.yml`.

| Var | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection |
| `DATA_DIR` | `./data` | Filesystem root for configs / jobs / redis AOF; can point at NAS or external drive |
| `MAX_UPLOAD_MB` | `50` | Per-file upload ceiling |
| `RQ_WORKERS` | `4` | Worker concurrency |
| `JOB_TIMEOUT_MIN` | `10` | Per-subtask timeout |
| `DOWNLOAD_GRACE_MINUTES` | `60` | ZIP re-download grace window |
| `JOB_RETENTION_HOURS` | `24` | Sweep undownloaded jobs after N hours |
| `LOG_LEVEL` | `INFO` | structlog level |

---

## Design docs

Full design narrative and decision log:

- [`docs/plan.md`](docs/plan.md) — final plan (architecture, flows, schema)
- [`docs/case_study.md`](docs/case_study.md) — seven-round design dialogue + a post-launch round of eight user-reported iterations
- [`docs/decisions_log.md`](docs/decisions_log.md) — 30 entries spanning the full arc: 22 design-phase turning points + 8 post-launch iterations, separated by a divider
- [`docs/learnings.md`](docs/learnings.md) — ten cross-decision distillations (six design + four iteration)

OpenSpec spec layer (mirrored from the parent monorepo):

- [`docs/spec/proposal.md`](docs/spec/proposal.md)
- [`docs/spec/design.md`](docs/spec/design.md)
- [`docs/spec/tasks.md`](docs/spec/tasks.md)
- [`docs/spec/spec.md`](docs/spec/spec.md)

---

## Out of scope

- User accounts, multi-tenancy, permissions
- Excel formula re-evaluation (formulas are preserved as-is; Excel recomputes on open)
- Cloud deployment, CI/CD
- Template version control (saving with the same name overwrites; UI prompts for confirmation)

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, style, error-handling
conventions, and the PR checklist.

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) tracks user-facing changes following
[Keep a Changelog](https://keepachangelog.com/).

## License

[MIT](LICENSE) © 2026 twjohnwu
