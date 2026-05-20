# Verification Report — §8

End-to-end verification of `excelTemplateParser`. Run after
`docker compose up -d redis api worker`.

| # | Scenario | Method | Result |
|---|---|---|---|
| 8.1 | `pytest backend/tests/` all green | unit | ✓ 117 passed |
| 8.2 | docker compose up | smoke_test.py | ✓ `/api/health` returns `{"ok":true}` |
| 8.3 | Flow A: save config | smoke_test.py | ✓ POST/GET/list all 200 |
| 8.4 | Flow B: batch 3 primary + 2 lookup | smoke_test.py | ✓ status=done, ZIP contains 3 outputs + `_summary.txt` |
| 8.5 | Style sanity in output xlsx | smoke_test.py | ✓ header preserved, conditional column behavior correct |
| 8.6 | 30MB source, worker RSS < 500MB | **manual** | not exercised here (covered by openpyxl read_only) |
| 8.7 | Error paths: bad xlsx / dup name / missing column | smoke_test.py | ✓ 409 / 422 with request_id header |
| 8.8 | Frontend i18n + dark mode persistence | **manual** | requires browser session |
| 8.9 | Resume: restart worker mid-batch | resume_test.py | ✓ 10/10 completed after `docker compose restart worker` at 4/10 |
| 8.10 | Persistence: down/up, config survives | inline | ✓ config re-fetchable after stop/start |
| 8.11 | Disaster: wipe Redis volume, keep `/data/` | inline | ✓ config + job snapshot rehydrate from disk |
| 8.12 | Batch snapshot endpoint | smoke_test.py | ✓ returns both real and `missing` entries |
| 8.13 | Errors carry request_id | smoke_test.py | ✓ `x-request-id` header on 422 |
| 8.14 | Multi-source semantics | smoke_test.py | ✓ 0 primary → 422; 3 primary → 3 outputs |
| 8.15 | Sheet/header row picker | **manual** | requires SheetHeaderPicker UI (covered by `/api/templates/parse` shape) |
| 8.16 | Preflight rejects missing column | smoke_test.py | ✓ 422 with column name in detail |
| 8.17 | Duplicate primary filename rejected | smoke_test.py | ✓ 422 |
| 8.18 | Cancel mid-flight job | smoke_test.py | ✓ cancel→200, job purged (404 on snapshot) |
| 8.19 | ETA after ≥5 subtasks done | **manual** | logic verified in unit test `test_eta_computed_after_threshold` |
| 8.20 | Partial failure ZIP packaging | **manual** | covered by unit test `test_finalize_packs_zip` + worker boundary |
| 8.21 | Download grace period (re-download within window) | smoke_test.py | ✓ second GET /zip within grace returns 200 |
| 8.22 | HTTP Range partial content | smoke_test.py | ✓ `Range: bytes=10-100` returns 206 |
| 8.23 | Edit existing config (load + download) | **manual** | UI flow; `?config=<name>` route + `useConfig` hook in place |
| 8.24 | Draft autosave | **manual** | localStorage interaction; debounced writer in ConfigBuilder |

## Bugs caught by §8 (and fixed)

1. **`finalize_job` racing ahead of subtasks** — `finalize_job` was enqueued
   at job creation right after subtasks, but with multiple workers it ran
   first, saw `terminal=0/N`, and exited via `finalize.early`. Then nothing
   re-triggered it → ZIP never produced even though every subtask succeeded.

   **Fix**: each subtask completion checks `mark_done(...) -> is_last`. The
   last completer enqueues `finalize_job` again. The startup enqueue stays
   as a safety net.

2. **Concurrent `state.json` writes losing increments** — 4 RQ workers
   processing sibling subtasks did read-modify-write on the same JSON file;
   without locking the last writer overwrote earlier updates. We saw
   `done=2/3` even though all three subtasks reported success.

   **Fix**: `JobService._locked_state` wraps read+modify+write in an
   `fcntl.flock` on a sibling `.lock` file. All `mark_*` methods now go
   through it.

3. **RQ worker name collision after unclean shutdown** — Worker process
   names like `worker-0` are tracked in Redis; after `docker compose
   restart` the new processes refused to start (`ValueError: There exists
   an active worker named 'worker-0' already`).

   **Fix**: append `{PID}-{uuid_hex}` to worker names so each process is
   unique. Stale entries get cleaned by RQ's own GC on next worker death.

These are exactly the kind of race conditions called out as unverified
in `docs/case_study.md` ("Subtask 級續傳的 race condition... 需要實作時驗"
and disaster persistence). The §8 verification stage caught them, the
fixes shipped, and `pytest` (117 tests) is still green after the changes.

## How to reproduce

```bash
cd excelTemplateParser
docker compose up -d redis api worker

# Auto smoke
backend/.venv/bin/python scripts/smoke_test.py

# Resume test (takes ~30s)
backend/.venv/bin/python scripts/resume_test.py
```

## Manual items not run here

- 8.6 memory ceiling — needs a ~30 MB fixture and `docker stats` while running
- 8.8 / 8.15 / 8.23 / 8.24 — browser UI interactions (frontend builds clean and tsc passes; routes/components wired)
- 8.19 ETA badge — backend logic verified in unit test; UI binding present in `JobDetail.tsx`
- 8.20 partial failure ZIP UI label — unit-tested in worker pipeline
