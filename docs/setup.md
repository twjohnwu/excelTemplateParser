# Setup & development

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
│       ├── core/{parser,joiner,mapper,writer,zipper,preflight,preview,exceptions}.py
│       ├── middleware/{request_id,upload_limit}.py
│       └── workers/{queue,tasks,run}.py
├── frontend/
│   ├── package.json     ← React 18 + Vite + TS + shadcn/ui + zod + TanStack Query
│   ├── Dockerfile       ← single-stage nginx:alpine (serves dist/)
│   ├── nginx.conf       ← static + /api/ proxy to api:8000
│   └── src/
│       ├── pages/{ConfigBuilder,BatchRunner,JobDetail}.tsx
│       ├── features/config-builder/{SourcesTree,JoinsEditor,MappingsList,MappingRow,ChecklistRail,PreviewDialog}.tsx
│       ├── features/batch-runner/{NewBatchForm,JobsList}.tsx
│       ├── components/{TopMenuBar,JobsPanel,FileDropzone,SheetHeaderPicker,ConditionChip,ui/*}.tsx
│       ├── hooks/{useJobSnapshot,useConfigs,useDebounce,usePreviewConfig}.ts
│       ├── lib/{api,recentJobs,schemas,utils,configHelpers,previewHelpers,issueHelpers}.ts
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

24 items (§8.1–8.24) are documented in [`scripts/VERIFICATION_REPORT.md`](../scripts/VERIFICATION_REPORT.md): 13 via `smoke_test.py`, 1 via `resume_test.py`, 6 via Playwright specs, 1 via the `pytest` unit run, 2 verified inline, 1 manual perf check (§8.6, worker RSS under load).

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
| `RESUME_SCAN_SECONDS` | `120` | Periodic scan_and_resume interval (API process); reclaims stale work after a worker crash |
| `LOG_LEVEL` | `INFO` | structlog level |

---

## Continuous integration

`.github/workflows/ci.yml` runs three jobs on `push` and `pull_request`: `backend` (pytest), `frontend` (typecheck, vitest, build), and `docker-smoke` (compose up with healthchecks, `scripts/smoke_test.py`, `scripts/resume_test.py`, then the Playwright e2e suite).

---

## End-to-end UI tests (Playwright)

```bash
bash scripts/up.sh
cd frontend
npm ci
npx playwright install chromium
npm run e2e
```

Run against a running stack (`bash scripts/up.sh`). Specs live in `frontend/e2e/`, one file per `VERIFICATION_REPORT.md` §8 row. Fixtures are regenerated with `frontend/e2e/fixtures/generate.py`.

`@playwright/test` is pinned to 1.40 because newer versions' bundled Chromium builds fail on macOS 13.
