# Contributing

Thanks for considering a contribution! This guide covers what you need to
know to land a change.

## Setup

```bash
git clone <repo>
cd excelTemplateParser

# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate    # Python 3.12+
pip install -e ".[dev]"
pytest                                                # 118+ unit tests

# Frontend
cd ../frontend
npm install
npm run test                                          # 29 unit tests
npm run typecheck
npm run build

# Full stack
cd ..
bash scripts/up.sh                                    # → http://localhost:5173
```

## Layout

See [`README.md`](README.md#repository-layout) for the file tree, and
[`docs/case_study.md`](docs/case_study.md) for the design narrative.

Roughly:

- `backend/app/core/` — pure functions (parser / joiner / mapper / writer)
- `backend/app/services/` — Redis + filesystem persistence (`config_service`, `job_service`, `recovery_service`, `cleanup_service`)
- `backend/app/api/` — FastAPI routers
- `backend/app/workers/` — RQ task pipeline
- `frontend/src/pages/` — top-level routes
- `frontend/src/features/` — page-specific composite components
- `frontend/src/lib/` — pure helpers (testable in isolation)

## Style

- **Backend**: Python 3.12+, type hints required on public functions, follow existing
  module structure. We don't enforce a formatter yet (the codebase reads
  consistently). Prefer `from __future__ import annotations` at the top of new files.
- **Frontend**: TypeScript strict mode, functional React, Tailwind utility classes.
  shadcn-style component primitives live under `src/components/ui/`.
- **Logging**: structured (`structlog` on backend; never `print`). Every
  request gets a `request_id` via middleware — propagate it in error responses.
- **No emojis in code or commit messages** unless the user explicitly asks.

## Error handling

Read [`docs/decisions_log.md`](docs/decisions_log.md) #6 first.

- **Core** layer (`backend/app/core/*`) only `raise`s. Use the typed
  exceptions in `core/exceptions.py` (`JoinKeyMissing`, `MappingError`, …)
  with `user_message` for end-user display and `tech_detail` for engineers.
- **Worker** (`app/workers/tasks.py`) catches at the subtask boundary,
  persists failure to `state.json`, and re-raises so RQ records it.
- **API** (`app/errors.py`) translates `CoreError` to HTTP 422 with a
  structured JSON payload including `request_id`.
- Don't add `try/except` inside `core/*`. Don't suppress exceptions to fall
  through to a default — let them bubble.

## Concurrency

Read [`docs/decisions_log.md`](docs/decisions_log.md) #17.

- Anything that reads-modifies-writes `state.json` MUST go through
  `JobService._locked_state()` (fcntl flock).
- Worker tasks must be idempotent: skip when `out/{primary}.out.xlsx` exists.
- RQ worker process names include a PID + uuid suffix to avoid stale-name
  collisions after restarts. Don't hard-code names.

## Tests

- Backend: `pytest` (118+ tests). New features need at least one unit test.
- Frontend: `npm test` (vitest, 29+ tests). Pure helpers (`lib/`) get
  isolated tests; React components are tested via `@testing-library/react`.
- End-to-end: `scripts/smoke_test.py` (14 scenarios) and
  `scripts/resume_test.py` (worker restart resume). Run after material
  changes to API or worker.

## Commit messages

Conventional-ish style is fine:

```
fix(mapper): include mapping targets outside target_columns

The mapper previously dropped any mapping whose target wasn't in the
config's target_template.columns. Now we union the two lists.

Adds tests/test_mapper.py::test_apply_includes_mappings_not_in_target_columns.
```

Reference decision-log entries when relevant (`per docs/decisions_log.md #19`).

## Pull requests

1. Branch from `main`.
2. Run `pytest`, `npm test`, `npm run typecheck`, `npm run build` locally.
3. Run `bash scripts/up.sh && python scripts/smoke_test.py` if you touched
   API, worker, or service code.
4. Update relevant docs (`docs/*.md`, `README.md`, this file).
5. Open the PR with a short description that links to any related
   decision-log entry or known issue.

## Out of scope

Things we don't take PRs for (see `docs/plan.md`'s "Out of Scope"):

- User accounts, multi-tenancy, permissions
- Excel formula re-evaluation
- Cloud deployment, CI/CD pipelines
- Template version control

If you think we should reconsider one of these, open an issue first to
discuss the scope change before writing code.
