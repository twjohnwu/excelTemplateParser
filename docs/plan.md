# excelTemplateParser — ERP Excel 批次轉換系統

## Context

需要一個可重複使用的工具，把同一格式的多份來源 Excel 批次轉換為另一種目標格式。痛點是 ERP 報表常需要手動複製貼上、套公式、跨表查表，週期性工作量大。目標是：

- **設定一次、批次重用**：使用者命名專案、一次性設定欄位對應，下載 json 設定檔，下次直接選用。
- **零程式碼操作**：UI 上拖拉式設定欄位來源、條件、關聯。
- **輕量單機**：預設單機內網使用，不需登入、不需外部 DB。

## Decisions

| 主題 | 決策 |
|---|---|
| 架構 | Docker 全端網站（FastAPI + React/Vite + Redis + worker） |
| 後端 | Python 3.12 + FastAPI + openpyxl + pandas |
| 前端 | React 18 + Vite + TypeScript + TanStack Query + shadcn/ui |
| 導航 | TopMenuBar（兩個分頁：`建立專案設定` / `批次轉換`） |
| 儲存層 | Redis AOF + 檔案雙寫：Redis 是快取，`/data/` 是真相來源；不用 Postgres |
| 故障復原 | Subtask 級續傳：以 source file 為單位；worker 啟動時掃 `state.json` 還原未完成 jobs |
| 資料目錄 | env `DATA_DIR`（預設 `./data`），可改指向 NAS / 外接硬碟 |
| 任務佇列 | RQ（Redis Queue，與儲存共用同一 Redis 實例） |
| Config 管理 | 使用者輸入專案名稱 → 後端存 `config:{name}` → 同時回傳供下載 `{name}.json` |
| 欄位映射 | 直接映射 + 條件（`>=, <=, ==, !=, contains, regex, in`）+ 預設值 |
| 多表關聯 | 顯式 join：使用者指定主表 + N 個 join 表，每段 join 設定 `主表.欄X = 副表.欄Y`，可串多階層 |
| 輸出策略 | 伺服端 job queue + ZIP 打包，限制併發數（4）；**下載成功後即刪整個 job 目錄** |
| 樣式處理 | 保留目標範本的樣式（字型、欄寬、格式），公式照原樣寫入但不重算 |
| 帳號 | 單機不登入，無多租戶 |
| 設計原則 | SOLID + DRY + KISS，依層隔離；不過度抽象 |
| 前端 i18n | 中英雙語，`react-i18next`，預設依瀏覽器語言、頂列可切換 |
| 主題 | 支援 Dark Mode，CSS 變數 + `prefers-color-scheme`，頂列可切換並記到 localStorage |
| 錯誤處理 | 邊界式：core 只 raise；worker / API 兩個邊界處理；`structlog` JSON log + request_id/job_id 追蹤 |

## Architecture

```
┌────────────────────────────────────────────────────┐
│ React SPA (Vite)                                   │
│  TopMenuBar: [Create] [Batch] 🔵Active(N) zh/en ☀  │
│   ├─ ConfigBuilder（三欄式工作台）                  │
│   ├─ BatchRunner（左右分欄）                        │
│   └─ JobDetail /jobs/:id（snapshot + SSE）         │
└──────────────┬─────────────────────────────────────┘
               │ REST + SSE (auto-reconnect)
┌──────────────▼─────────────────────────────────────┐
│ FastAPI (api + middleware: request_id)             │
│  /api/templates    parse headers                   │
│  /api/configs      list / get / save               │
│  /api/jobs         create / list / snapshot / sse  │
│  /api/jobs/:id/zip download → BackgroundTask 清 dir│
└──────┬──────────────────────────┬──────────────────┘
       │                          │
┌──────▼──────────────────┐  ┌────▼────────────────┐
│ Redis (AOF everysec)    │  │ RQ Worker (×4)      │
│  config:{name}          │  │ run_subtask:        │
│  configs:index          │  │   skip if out exists│
│  job:{id} Hash          │  │   parse→join→map    │
│  job:{id}:done Set      │  │   →write (per src)  │
│  job:{id}:events PubSub │  │ finalize_job: zip   │
└─────────────────────────┘  └─────────────────────┘
       │                          │
       └─────────┬────────────────┘
                 │
       ┌─────────▼─────────────────────────────┐
       │ services:                              │
       │  recovery_service（啟動掃 state.json） │
       │  cleanup_service （下載觸發 + cron）   │
       └─────────┬─────────────────────────────┘
                 │
       ┌─────────▼─────────────────────────────┐
       │ /data/  (DATA_DIR env)                │
       │  redis/, configs/{name}.json,         │
       │  jobs/{id}/{state.json, uploads/,     │
       │              out/, result.zip}        │
       │  下載成功 → 整個 job 目錄刪除         │
       └───────────────────────────────────────┘
```

## Persistence Model（檔案雙寫 + 續傳）

```
/data/                              # DATA_DIR，可掛載 NAS
├── redis/                          # Redis AOF（everysec fsync）
│   └── appendonly.aof
├── configs/                        # config 雙寫 JSON（真相）
│   └── {name}.json
└── jobs/
    └── {job_id}/
        ├── state.json              # 進度真相：subtask 狀態
        ├── uploads/                # 上傳檔（持久化，非 /tmp）
        │   ├── target.xlsx
        │   └── source_*.xlsx
        ├── out/                    # 每份輸出獨立檔（idempotent）
        │   └── source_*.out.xlsx
        └── result.zip              # 最終打包
```

**寫入順序**（避免狀態不一致）：

1. 處理一份 source file → 寫 `out/{source}.out.xlsx`
2. 更新 `state.json` 把該 subtask 標 `done`
3. 同步寫 Redis `job:{id}:done` SADD
4. 失敗則只更新 `state.json` 為 `error`，不寫 done

**Worker 啟動還原**：

1. 掃 `/data/jobs/*/state.json`
2. 對 status != `done` 的 job，把未完成 subtask re-enqueue 到 RQ
3. Worker 處理時跳過已存在的 `out/{source}.out.xlsx`（idempotent）

**清理時機**：

- 使用者成功下載 ZIP → `BackgroundTask` 刪除整個 `/data/jobs/{job_id}/`（含 uploads/out/state/zip）
- 同步刪 Redis `job:{id}` 與 `job:{id}:done`
- 未下載者：每日 cron 清掃 24h 前的 job 目錄

## Error Handling 設計

**原則**：邊界式錯誤處理，不在每步加 try/catch（會吞 stack trace、誘發靜默失敗）。

| 層 | 行為 |
|---|---|
| Core (`parser/joiner/mapper/writer`) | 只 `raise`；遇到能加上下文的點才 catch + re-raise 為自訂例外 |
| Worker 邊界 (`run_subtask`) | 抓所有例外 → 寫 `state.json` + Redis 失敗狀態 + 結構化 log → re-raise 讓 RQ 知道 |
| API 邊界 (FastAPI handler) | 自訂例外 → 4xx + 結構化 JSON；未預期例外 → 500 + request_id（細節進 log） |

### 自訂例外（`core/exceptions.py`）

```python
class CoreError(Exception):
    """所有 core 錯誤的 base"""
    def __init__(self, user_message: str, tech_detail: str = "", **context):
        super().__init__(user_message)
        self.user_message = user_message
        self.tech_detail = tech_detail
        self.context = context

class ConfigError(CoreError): ...        # schema 不合
class JoinKeyMissing(CoreError): ...     # join 鍵不存在
class MappingError(CoreError): ...       # 欄位映射失敗
class RegexTimeout(CoreError): ...       # regex 條件逾時
class WriterError(CoreError): ...        # 寫入 xlsx 失敗
class TemplateInvalid(CoreError): ...    # 範本檔損毀
```

### 結構化 log

- 使用 `structlog`，輸出 JSON 一行一事件
- 每個 request 中介層注入 `request_id` (uuid4)
- 每個 worker subtask 自動帶 `job_id` + `source_file`
- 前端錯誤訊息附 request_id，`docker compose logs api | grep <request_id>` 秒查
- `state.json` 同時保留 `user_message`（前端顯示）與 `tech_detail`（除錯）

### 對使用者的錯誤呈現

| 情境 | HTTP / Job 狀態 | 使用者看到 |
|---|---|---|
| 上傳壞 xlsx | 422 | 「範本檔損毀或非 xlsx 格式」 |
| Config schema 不合 | 422 | 「欄位 `mappings[2].op` 必須為 `>=, <=, ...` 之一」 |
| 重名 config | 409 | 「專案『月報』已存在，是否覆蓋？」 |
| Subtask 中 join key 缺欄 | Job error | 「來源檔 `orders.xlsx` 缺少欄位『客戶代號』」 |
| 未預期 bug | 500 / Job error | 「系統錯誤 (id: abc-123)，請聯絡管理員」 |

## SOLID/DRY 分層

每一層只做一件事、可獨立單元測試。依賴方向統一為 `api → services → core`；core 不依賴 FastAPI / Redis。

- `core/parser.py`：Excel → DataFrame + 標頭資訊
- `core/joiner.py`：依 join 規則合併多個 source DataFrame
- `core/mapper.py`：套用 mapping 規則 + 條件 + 預設值
- `core/writer.py`：套到目標範本、保留樣式輸出 xlsx
- `core/zipper.py`：多 xlsx → ZIP
- `services/config_service.py`：Redis CRUD + 雙寫 `/data/configs/{name}.json`
- `services/job_service.py`：Redis + `state.json` 雙寫 job 狀態、SSE 推送
- `services/recovery_service.py`：啟動時掃 `/data/jobs/` 還原未完成 jobs
- `services/cleanup_service.py`：下載成功觸發 + 每日 cron 清掃
- `workers/tasks.py`：subtask 級 pipeline，**唯一一處組裝邏輯**，idempotent

## JSON 設定檔 Schema

```jsonc
{
  "version": "1.0",
  "name": "業務月報",                          // Redis key 與下載檔名
  "target_template": {
    "sheet": "Sheet1",
    "header_row": 1,
    "preserve_styles": true,
    "columns": ["訂單編號", "客戶名稱", "業務員", "金額"]
  },
  "sources": [
    { "alias": "orders",    "role": "primary", "sheet": "訂單",  "header_row": 1 },
    { "alias": "customers", "role": "lookup",  "sheet": "客戶",  "header_row": 1 },
    { "alias": "sales",     "role": "lookup",  "sheet": "業務員","header_row": 1 }
  ],
  "joins": [
    { "left": "orders.客戶代號",      "right": "customers.代號", "type": "left" },
    { "left": "customers.業務員代號", "right": "sales.代號",     "type": "left" }
  ],
  "mappings": [
    { "target": "訂單編號", "source": "orders.單號" },
    {
      "target": "客戶名稱",
      "source": "customers.名稱",
      "conditions": [{ "field": "orders.狀態", "op": "!=", "value": "取消" }],
      "default": ""
    },
    { "target": "業務員", "source": "sales.姓名" },
    {
      "target": "金額",
      "source": "orders.總額",
      "conditions": [{ "field": "orders.總額", "op": ">=", "value": 0 }]
    }
  ]
}
```

## 關鍵流程

### 流程 A：建立 / 編輯專案設定

1. `專案設定` 分頁：可選「建立新專案」或從下拉「載入既有專案」（或直接 URL `?config=<name>`）
2. 輸入或修改專案名稱（pattern `^[\p{L}\p{N}_\- ]{1,80}$`）
3. 上傳目標範本 + 多份來源範本（標記 primary）；每份檔上傳後 `POST /api/templates/parse` 回傳 sheets + 30 列預覽：
   - 多 sheet 時下拉選擇
   - 點任一列設為 `header_row`，標頭即時更新
   - 30 列仍不夠時「載入更多 30 列」延伸載入
4. UI 設定 join 規則與欄位映射、條件
5. 兩個下載按鈕：
   - **儲存並下載**：`POST /api/configs` 驗證 + 存 `config:{name}` + 雙寫 `/data/configs/{name}.json` + 觸發 json 下載
   - **下載當前設定檔**：純下載目前表單內容，不存後端（含載入既有後不做修改的情境）
6. 表單變動 debounce 1s 自動寫 `localStorage.configDraft_*`；下次開啟若有 draft 提示還原
7. 同名儲存 → 409 + 二次確認覆蓋；改名儲存 = 另存新檔

### 流程 B：批次轉換（含續傳）

1. `批次轉換` 分頁有兩種來源擇一：
   - 下拉選擇既有專案（從 Redis 讀，fallback 讀 `/data/configs/{name}.json`）
   - 上傳 json 設定檔
2. UI 依 config schema 動態展開上傳 slot：
   - 1 個目標範本 slot
   - 每個 `role: primary` source alias 一個 slot（**可多檔**，每檔產一份輸出）
   - 每個 `role: lookup` source alias 一個 slot（**單檔**，所有 primary 共用）
3. 上傳完成後 `POST /api/jobs` multipart：
   - 後端驗證 primary ≥ 1、每個 lookup 恰好 1（否則 422）
   - 拒絕同名 primary（422 + 衝突檔名）
   - **Preflight**：對每份檔同步開啟（read_only）驗證 sheet 名 + header_row 標頭含必要欄位；任一不符 → 422 + 具體訊息
   - 通過才落地到 `/data/jobs/{id}/uploads/{target.xlsx, primary/*, lookup/*}`
   - 寫初始 `state.json`，subtask 列表以 primary 檔名為單位（lookups 不算 subtask）
4. 每份 primary 進 RQ queue → worker 處理時：
   - 跳過 `out/{primary}.out.xlsx` 已存在的（idempotent）
   - 讀該份 primary + 共用 lookups → joiner → mapper → writer
   - 寫 `out/`、更新 `state.json` 與 Redis
5. 全部 subtask done → 打包 `result.zip`（N 個 primary → N 個 xlsx + `_summary.txt` 在 ZIP 內）
   - ZIP 名稱：`{config_name}_{YYYYMMDD_HHMMSS}.zip`
   - 部分失敗：成功的仍打包，`_summary.txt` 列出每份結果（含失敗訊息）；UI 標註「4 成功 / 1 失敗」
   - 全部失敗則不打包，UI 顯示錯誤訊息
6. SSE 即時推送 subtask 級進度 + ETA（≥ 5 個完成後計算 `avg(durations) × remaining`）
7. 使用者下載 ZIP：
   - 後端寫 `download_started_at` + 回 `FileResponse`（支援 `Range` 可 resume）
   - **不立即刪檔**，保留 1 小時 grace；期間可重複下載、UI 顯示倒數
8. 取消：JobDetail 頁面 status ∈ {pending, running} 顯示「取消」按鈕；觸發後 RQ 撤未開始的 subtask、正在跑的 subtask 跑完後停、整個 job 目錄刪除
9. APScheduler 每 1 小時掃 `purge_old_jobs(24h)`、每 10 分鐘掃 `purge_grace_expired`

**批次語意總覽**：

| Role | 一個 job 內 | 角色 | 是否拆 subtask |
|---|---|---|---|
| `primary` | 多檔 | 被批次處理的交易資料 | 是（每檔一個） |
| `lookup` | 單檔 | Master data，被 join 引用 | 否（共用） |

### 進度可見性（重啟/斷線/關頁也能看）

四層機制：

1. **穩定 URL**：每個 job 有 SPA route `/jobs/{id}`，打開時先 `GET /api/jobs/{id}` 拿快照再訂閱 SSE
2. **localStorage 持有 recent jobs**：BatchRunner 起 job 時寫入；開站時批次查 `GET /api/jobs?ids=...`
3. **TopMenuBar 進行中面板**：徽章 + 下拉清單，點擊跳 `/jobs/{id}`
4. **SSE 重連 snapshot**：`EventSource` 自動 retry（指數退避 3s 起）；server 收到重連後第一個事件 = 完整快照

**新增 API**：

- `GET /api/jobs/{id}` → `{status, done, total, failed, error?}`
- `GET /api/jobs?ids=a,b,c` → 批次查詢
- SSE channel 首次訊息固定為 snapshot 事件

### 故障復原情境

- **Worker 崩潰 / OOM kill**：RQ 自動 retry 該 subtask；其他不受影響
- **整個 docker 重啟**：Redis 從 AOF 還原；Worker 啟動時掃 `state.json` re-enqueue 未完成 subtask
- **Redis volume 損壞但 `/data/jobs/` 完好**：Worker 啟動時從 `state.json` 完整重建 Redis 狀態
- **主機完全壞**：超出本系統保證範圍（需主機級備份）

## Frontend Design

### 視覺風格：shadcn 為底 + Mantine 風互動回饋

`shadcn/ui` + Tailwind 灰階留白底，加上柔性互動：軟陰影、選中態 `bg-blue-50` 高亮、上傳區 dashed border + 柔色 hover。`theme/tokens.css` 用 CSS 變數做 light/dark 切換。

### ConfigBuilder — 三欄式工作台

```
┌──────────────┬──────────────────┬─────────────────────────┐
│ 📁 來源樹     │ 🔗 Join 卡片      │ 🎯 映射列（Inline 展開）│
│              │                  │                         │
│ ▾target.xlsx │ orders.客戶代號  │ 訂單編號 ← orders.單號  │
│  ・訂單編號  │  = customers.代號│ ▾ 客戶名稱 ← customers.名稱│
│ ▾orders.xlsx │ customers.業務員 │   條件: orders.狀態!=取消│
│ ▾customers   │  = sales.代號    │   預設: ""              │
│ ▾sales       │ [+ Join]         │ ...                     │
│              │                  │ [+ 映射]  [儲存並下載]   │
└──────────────┴──────────────────┴─────────────────────────┘
```

### BatchRunner — 左右分欄

```
┌─────────────────────────┬──────────────────────────────┐
│ 新批次                  │ 我的作業（即時 SSE）          │
│ Config: ACME ▾          │ ⏳ 月報轉換 7/10 [查看]      │
│ ⬆ 目標範本              │ ✅ 上週報表 10/10 [下載 ZIP] │
│ ⬆ 來源檔（多份）        │ ❌ 客戶 A 失敗 [重試]        │
│ [開始轉換]              │                              │
└─────────────────────────┴──────────────────────────────┘
```

### JobDetail（`/jobs/:id`）

穩定 URL、subtask 列表、SSE 斷線時顯示「連線中..」橫幅不歸零。失敗的 subtask 可單獨重試（其他不重做，idempotent 保證）。

### Field Mapping + Condition Builder（Inline 展開）

每個目標欄位一行，點擊展開顯示來源欄位下拉、條件 chip 串、預設值。

**Chip 配色**：欄位 `bg-yellow-100` / 運算子 `bg-gray-200` / 值 `bg-blue-100`
**運算子**：`>=, <=, ==, !=, contains, regex, in`

### TopMenuBar

```
[ExcelParser] [專案設定] [批次轉換]    🔵 N ▾  🌐 EN  ☀ Dark
                                       └─ JobsPanel：進行中 / 已完成可下載
```

進行中徽章顯示 active job 數；下拉 `JobsPanel` 分組顯示。語言切換 zh-TW/en、主題切換 light/dark 寫 localStorage。

### UI Library 與依賴

- `shadcn/ui`（Radix + Tailwind）— copy-paste，不裝 Mantine/AntD
- `@tanstack/react-query` — server state
- `react-router-dom` v6 — `/jobs/:id` 路由
- `react-i18next` — i18n
- `lucide-react` — icon
- `react-dropzone` — 上傳區
- `zod` — schema 驗證（與後端 Pydantic 對應）

### 響應式與無障礙

桌機優先（≥1280px），平板降兩欄，手機顯示「請使用桌機」。鍵盤可全操作（Tab/Esc/Enter）；對比度 AA 級（light/dark 皆驗證）。

## Scaling Triggers

Redis-only 適用本用例的前提。若未來出現以下任一情況，再考慮 Postgres：

- Config 數量 > 10,000
- 需要跨 config 查詢（如「找出所有引用某來源欄位的 config」）
- 加入多租戶、權限、稽核 log
- 需要 SQL 報表（轉換歷史統計）

## 樣式保留實作

- 用 openpyxl 直接「載入目標範本檔」(`load_workbook(target.xlsx)`)
- 不重建 sheet，從 `header_row + 1` 開始填值到既有 cell
- 欄寬、字型、儲存格格式、合併儲存格、公式皆保留
- 公式不重算（openpyxl 預設行為）

## 記憶體與併發

- 單檔上限 50MB（env `MAX_UPLOAD_MB`）
- Worker 併發 4（env `RQ_WORKERS`）
- 大檔以 `read_only=True` 串流讀
- 單 subtask 逾時 10 分鐘

## Critical Files

開發路徑：`sideProjects/excelTemplateParser/`（目前空目錄，待實作）。

```
excelTemplateParser/
├── docker-compose.yml              # api, worker, redis, frontend
├── AGENTS.md                       # 英文，給機器讀
├── backend/
│   ├── pyproject.toml
│   ├── Dockerfile
│   └── app/
│       ├── main.py                 # FastAPI entry + lifespan recovery
│       ├── api/
│       │   ├── templates.py
│       │   ├── configs.py
│       │   └── jobs.py
│       ├── services/
│       │   ├── config_service.py
│       │   ├── job_service.py
│       │   ├── recovery_service.py
│       │   └── cleanup_service.py
│       ├── core/
│       │   ├── exceptions.py
│       │   ├── parser.py
│       │   ├── joiner.py
│       │   ├── mapper.py
│       │   ├── writer.py
│       │   └── zipper.py
│       ├── logging_config.py
│       ├── middleware/request_id.py
│       ├── workers/tasks.py
│       ├── schemas.py
│       └── settings.py
│   └── tests/...
├── frontend/
│   ├── package.json
│   ├── Dockerfile
│   └── src/
│       ├── App.tsx
│       ├── components/
│       │   ├── TopMenuBar.tsx
│       │   ├── JobsPanel.tsx
│       │   ├── FileDropzone.tsx
│       │   ├── ConditionChip.tsx
│       │   └── ui/                 # shadcn copy-paste
│       ├── pages/
│       │   ├── ConfigBuilder.tsx
│       │   ├── BatchRunner.tsx
│       │   └── JobDetail.tsx
│       ├── features/
│       │   ├── config-builder/
│       │   │   ├── SourcesTree.tsx
│       │   │   ├── JoinsEditor.tsx
│       │   │   ├── MappingsList.tsx
│       │   │   └── MappingRow.tsx
│       │   └── batch-runner/
│       │       ├── NewBatchForm.tsx
│       │       └── JobsList.tsx
│       ├── hooks/
│       │   ├── useJobSnapshot.ts
│       │   ├── useConfigs.ts
│       │   └── useTheme.ts
│       ├── lib/
│       │   ├── api.ts
│       │   ├── recentJobs.ts
│       │   └── schemas.ts
│       ├── i18n/
│       └── theme/
└── data/                           # DATA_DIR 預設掛載點
```

## Verification

1. `pytest backend/tests/` — parser/joiner/mapper/writer 各層獨立測試
2. `docker compose up` 後：
   - 流程 A：取名 `test_demo` → 上傳範本 → 下載 `test_demo.json` → `redis-cli GET config:test_demo` 存在
   - 流程 B：選 `test_demo` + 上傳 3 份來源 → SSE 進度 0→3/3 → 下載 ZIP → `/data/jobs/{id}/` 已刪
3. 樣式：輸出 xlsx 在 Excel 打開，字型/欄寬/格式與目標範本一致
4. 記憶體：30MB 來源檔，`docker stats` worker RSS < 500MB
5. 錯誤路徑：壞 xlsx → 422 + request_id；重名 → 409 + 二次確認
6. 前端 UX：中/英切換、Dark Mode 切換 + 重整後設定保留
7. **續傳**：跑 10 份來源，第 5 份處理中 `docker compose restart worker` → 從第 5 份繼續，前 4 份不重做
8. **持久化**：建立 config 後 `docker compose down && up` → config 仍存在
9. **災難**：刪除 Redis volume（保留 `/data/jobs/`）→ worker 從 `state.json` 重建並完成剩餘 subtask
10. **下載清理**：完成下載後 `/data/jobs/{id}/` 完整刪除
11. **錯誤處理**：壞 xlsx → 422 含 request_id；`docker compose logs api | grep <request_id>` 找回完整 traceback
12. **進度可見性**：關分頁重開 → TopMenuBar 徽章顯示進行中數；`docker compose restart` 期間 SSE 自動重連、進度不歸零

## Out of Scope

- 使用者帳號 / 多租戶 / 權限
- Excel 公式重算
- 雲端部署、CI/CD
- 範本版本控制（覆蓋同名專案即直接覆蓋，UI 上會二次確認）
