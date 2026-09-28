# excelTemplateParser

**English** · [繁體中文](README.zh-TW.md)

[![CI](https://github.com/twjohnwu/excelTemplateParser/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/twjohnwu/excelTemplateParser/actions/workflows/ci.yml) [![Version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)

Batch-convert many Excel files of the same format into another format. Author the mapping once, reuse forever. Single-machine Docker deployment, no login required. UI supports zh-TW / English and light / dark mode, both persisted locally.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Walkthrough](#walkthrough)
- [Examples](#examples)
- [Architecture](#architecture)
- [Design docs](#design-docs)
- [Out of scope](#out-of-scope)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

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

## Quick start

Requires only Docker — no Node/npm needed.

```bash
bash scripts/up.sh
```

- UI: http://localhost:5173
- API: http://localhost:8000

The first run builds the frontend image (Docker downloads a Node base image
and runs the production build inside it), so it's slower than later runs.

Full setup, dev workflow, environment variables, and CI: [`docs/setup.md`](docs/setup.md).

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

The Setup Wizard at `/wizard` is the default entry point; the three-pane workbench walkthrough is in [docs/walkthrough-workbench.md](docs/walkthrough-workbench.md).

### 1. Template

![Setup Wizard — step 1: Template](docs/ss/Wizard-Step01.png)

Upload the target template — the Excel format you'll ultimately hand over, whose header row determines the output columns. The wizard reads the sheet, lets you pick the header row, and previews the detected columns below the dropzone.

### 2. Sources

![Setup Wizard — step 2: Sources](docs/ss/Wizard-Step02.png)

Add one `primary` source (the per-row data, batched) plus any number of `lookup` sources, each with its own alias, role, and file upload with header-row detection. Every source's rows preview inline as you add it.

### 3. Joins

![Setup Wizard — step 3: Joins](docs/ss/Wizard-Step03.png)

Only needed with multiple source files: pick which column in each pair of files represents the same key (e.g. `primary.SKU = source_2.貨號`) and the join direction (`left`). Add one join per lookup source that needs matching.

### 4. Mappings

![Setup Wizard — step 4: Mappings](docs/ss/Wizard-Step04.png)

One row per output column: choose whether its value is a source field, a fixed cell, or a literal, with optional conditions and a default. Unfinished or invalid rows are flagged in red until every mapping resolves to a source.

### 5. Save

![Setup Wizard — step 5: Save](docs/ss/Wizard-Step05.png)

The last step summarizes the target template, sources, joins, and mappings so you can catch mistakes before committing (each section has an Edit link back to its step). Enter a project name and Save & Download to persist the config and get the `{name}.json` file.

### 6. Batch convert — upload inline config

![Batch Runner — upload config JSON](docs/ss/excelTemplateParser-uploadConfigFile.png)

If the config isn't saved on the server, upload `{name}.json` directly. The form parses the JSON, dynamically expands upload slots by source alias, and shows the last-used sample filename as a hint per slot.

### 7. Pick saved config + live progress

![Batch Runner — saved config dropdown + SSE progress](docs/ss/excelTemplateParser-loadFromRedisAndCheckNotify.png)

For configs already saved on the server (from Project Settings → Save), the dropdown lists them by name (loaded from Redis / `/data/configs/`). Subtask-level progress streams via SSE; the top-bar badge tracks running jobs across page reloads, and the right-rail pulls recent jobs from localStorage so you can revisit any past job.

Job detail and the result ZIP are the same for both flows — see [docs/walkthrough-workbench.md](docs/walkthrough-workbench.md) §5–6.

---

## Examples

End-to-end scenarios live under [`examples/`](./examples). Each one ships with `config.json`, source xlsx files, a target template, and the expected output — run the tool on the inputs and you should get the same output.

- [**01_product_pricing**](./examples/01_product_pricing) — master catalog × three suppliers' monthly quotes, each using different column names (`貨號` / `SKU` / `商品編號`). Demonstrates **outer join** to surface products nobody quoted.
- [**02_agri_market_report**](./examples/02_agri_market_report) — Taiwan MOA open-government data: 1000 daily wholesale trade rows joined against market-code and TcType lookups. Demonstrates a **real-world data mashup** with cross-language column names.

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

Repository layout: see [docs/setup.md](docs/setup.md#repository-layout).

---

## Design docs

Full design narrative and decision log:

- [`docs/plan.md`](docs/plan.md) — final plan (architecture, flows, schema)
- [`docs/case_study.md`](docs/case_study.md) — seven-round design dialogue + a post-launch round of eight user-reported iterations
- [`docs/decisions_log.md`](docs/decisions_log.md) — 37 entries spanning the full arc: 22 design-phase turning points + 9 post-launch iterations + 6 UX-overhaul entries, in three parts
- [`docs/learnings.md`](docs/learnings.md) — ten cross-decision distillations (six design + four iteration)
- [`docs/setup.md`](docs/setup.md) — setup, dev workflow, environment variables, CI

OpenSpec spec layer (mirrored from the parent monorepo; design-phase snapshot, code is authoritative):

- [`docs/spec/proposal.md`](docs/spec/proposal.md)
- [`docs/spec/design.md`](docs/spec/design.md)
- [`docs/spec/tasks.md`](docs/spec/tasks.md)
- [`docs/spec/spec.md`](docs/spec/spec.md)

---

## Out of scope

- User accounts, multi-tenancy, permissions
- Excel formula re-evaluation (formulas are preserved as-is; Excel recomputes on open)
- Cloud deployment / production delivery pipeline (GitHub Actions runs tests and smoke only; nothing is deployed)
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
