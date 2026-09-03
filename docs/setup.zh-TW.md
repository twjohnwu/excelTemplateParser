# 安裝與開發

## 一鍵啟動

```bash
bash scripts/up.sh
# → http://localhost:5173
```

`scripts/up.sh` 偵測 `frontend/dist/` 是否過期，需要才本機跑 `npm run build`，然後 `docker compose up -d` 起 4 個服務（redis / api / worker / frontend）。

要重新整理特定服務：

```bash
docker compose restart worker            # 套用 backend 程式變更（volume 掛 ./backend）
cd frontend && npm run build && docker compose up -d --force-recreate frontend
```

---

## 專案結構

```
excelTemplateParser/
├── docker-compose.yml
├── README.md            ← 本檔
├── AGENTS.md            ← 給協作 agent 讀的英文版說明
├── scripts/
│   ├── up.sh            ← 一鍵啟動腳本
│   ├── smoke_test.py    ← §8 自動驗證端到端場景
│   ├── resume_test.py   ← §8.9 重啟續傳驗證
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
│   ├── Dockerfile       ← 單階段 nginx:alpine（serve dist/）
│   ├── nginx.conf       ← / static + /api/ proxy to api:8000
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

## 開發 / 測試

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate    # 需要 Python 3.12+
pip install -e ".[dev]"
pytest                    # 單元測試（core / services / api / workers）
```

關鍵單元測試：

| 檔案 | 涵蓋 |
|---|---|
| `tests/test_parser.py` | xlsx → DataFrame、header_row、壞檔偵測 |
| `tests/test_joiner.py` | 多階層 join、missing key |
| `tests/test_mapper.py` | 7 個運算子、條件、預設值、自動 union mapping targets |
| `tests/test_writer.py` | 樣式保留、未知欄位 append |
| `tests/test_*_service.py` | Redis + 檔案雙寫、ETA、cancel、grace expire、recovery |
| `tests/test_api_*.py` | FastAPI 端點、422 / 409、SSE、multipart 結構 |
| `tests/test_worker_pipeline.py` | end-to-end pipeline（含 idempotent skip、cancel flag、partial failure） |

### Frontend

```bash
cd frontend
npm install
npm run typecheck         # tsc --noEmit
npm run build             # 產 dist/
npm run dev               # Vite dev server，HMR
```

### 端到端

```bash
bash scripts/up.sh                                  # 起服務
backend/.venv/bin/python scripts/smoke_test.py      # 端到端自動場景
backend/.venv/bin/python scripts/resume_test.py     # 重啟續傳場景
```

共 24 個項目（§8.1–§8.24），詳見 [`scripts/VERIFICATION_REPORT.md`](../scripts/VERIFICATION_REPORT.md)：13 項透過 `smoke_test.py`、1 項透過 `resume_test.py`、6 項透過 Playwright spec、1 項為 `pytest` 單元測試、2 項為 inline 驗證、1 項為手動效能檢查（§8.6，worker RSS）。

---

## 環境變數

掛 `.env` 或 `docker-compose.yml` 都可。

| Var | Default | 用途 |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/0` | Redis 連線 |
| `DATA_DIR` | `./data` | 檔案系統根（configs / jobs / redis AOF）；可指 NAS / 外接硬碟 |
| `MAX_UPLOAD_MB` | `50` | 單檔上傳上限 |
| `RQ_WORKERS` | `4` | Worker 並行數 |
| `JOB_TIMEOUT_MIN` | `10` | 單 subtask 逾時 |
| `DOWNLOAD_GRACE_MINUTES` | `60` | ZIP 下載 grace period |
| `JOB_RETENTION_HOURS` | `24` | 未下載 job 保留時間 |
| `RESUME_SCAN_SECONDS` | `120` | scan_and_resume 定期掃描間隔（API process）；worker crash 後回收卡住的工作 |
| `LOG_LEVEL` | `INFO` | structlog level |

---

## 持續整合（CI）

`.github/workflows/ci.yml` 在 `push` 與 `pull_request` 時跑三個 job：`backend`（pytest）、`frontend`（typecheck、vitest、build）、`docker-smoke`（compose up + healthcheck，接著跑 `scripts/smoke_test.py`、`scripts/resume_test.py`，最後跑 Playwright e2e）。

---

## 端到端 UI 測試（Playwright）

```bash
bash scripts/up.sh
cd frontend
npm ci
npx playwright install chromium
npm run e2e
```

需先跑起整套服務（`bash scripts/up.sh`）。測試檔放在 `frontend/e2e/`，每個檔案對應 `VERIFICATION_REPORT.md` §8 的一列；測試用的 fixture 由 `frontend/e2e/fixtures/generate.py` 重新產生。

`@playwright/test` 固定在 1.40，因為更新版本內建的 Chromium build 在 macOS 13 上會失敗。
