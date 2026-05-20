# Design: Excel Template Parser

## Context

詳見 `proposal.md`。本設計遵守 SOLID + DRY + KISS：每一層職責單一、依賴方向統一、不過度抽象。

## Architecture

```
┌────────────────────────────────────────────────────┐
│ React SPA (Vite)                                   │
│  TopMenuBar: [Create] [Batch] 🔵Active(N) zh/en ☀  │
│   ├─ ConfigBuilder                                 │
│   ├─ BatchRunner                                   │
│   └─ JobDetail /jobs/:id (snapshot + SSE)         │
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
       │  recovery_service (啟動掃 state.json) │
       │  cleanup_service  (下載觸發 + cron)   │
       └─────────┬─────────────────────────────┘
                 │
       ┌─────────▼─────────────────────────────┐
       │ /data/  (DATA_DIR env)                │
       │  redis/, configs/{name}.json,         │
       │  jobs/{id}/{state.json,uploads/,      │
       │              out/, result.zip}        │
       │  下載成功 → 整個 job 目錄刪除         │
       └───────────────────────────────────────┘
```

## Layering（依 SOLID）

依賴方向統一為 `api → services → core`。Core 純函式，不依賴 FastAPI 或 Redis。

| 層 | 模組 | 單一職責 |
|---|---|---|
| api | `api/templates.py` | HTTP：範本上傳與標頭解析 |
| api | `api/configs.py` | HTTP：config CRUD |
| api | `api/jobs.py` | HTTP：建 job、SSE、ZIP 下載、snapshot 查詢 |
| services | `services/config_service.py` | Redis 上 config 存取 + 雙寫 `/data/configs/{name}.json` |
| services | `services/job_service.py` | Redis + `state.json` 雙寫 job 狀態 + pub/sub |
| services | `services/recovery_service.py` | 啟動時掃 `/data/jobs/*/state.json` 還原未完成 jobs |
| services | `services/cleanup_service.py` | 下載成功觸發刪除 + 每日 cron 清掃 24h 前的 job 目錄 |
| core | `core/exceptions.py` | 自訂例外類別（CoreError 及子類） |
| core | `core/parser.py` | xlsx → DataFrame + headers |
| core | `core/joiner.py` | 多 DataFrame join 引擎 |
| core | `core/mapper.py` | 套用 mapping + 條件 + 預設值 |
| core | `core/writer.py` | 套到目標範本、保留樣式 |
| core | `core/zipper.py` | 多 xlsx → ZIP |
| workers | `workers/tasks.py` | **唯一**組裝點：把 core 5 個元件串成 pipeline |

## Data Model（Redis + 檔案雙寫）

**Redis = 執行期快取；`/data/` = 真相來源。** 兩者皆寫，啟動時以 `/data/` 為準。

### Redis Keys

| Key 樣式 | 型別 | 用途 |
|---|---|---|
| `config:{name}` | String (JSON) | Config 內容（與 `/data/configs/{name}.json` 同步） |
| `configs:index` | Set | 所有 config name |
| `job:{id}` | Hash | `status, total, done, failed, created_at, error?` |
| `job:{id}:done` | Set | 已完成的 subtask（source file 名） |
| `job:{id}:events` | Pub/Sub channel | SSE 即時進度 |
| `rq:queue:default` | RQ 內部 | 任務佇列 |

### 檔案系統（DATA_DIR，預設 `./data/`）

```
/data/
├── redis/                  # Redis AOF 持久化（docker volume）
│   └── appendonly.aof
├── configs/                # config 雙寫
│   └── {name}.json
└── jobs/
    └── {job_id}/
        ├── state.json      # 進度真相：{status, subtasks: {file: pending|done|error}, errors: {...}}
        ├── uploads/        # target.xlsx + source_*.xlsx（持久化）
        ├── out/            # source_*.out.xlsx（每完成一份即落地，idempotent）
        └── result.zip      # 全部完成後打包
```

AOF `everysec` + 檔案雙寫：Redis 損毀也能從 `state.json` 完整重建。

## Sheet & Header Row Selection

`/api/templates/parse` 同步解析上傳的 xlsx，回傳：

```json
{
  "sheets": [
    { "name": "訂單明細", "preview_rows": [["..."], ["..."], ...] }
  ]
}
```

`preview_rows` 預設前 30 列；超過時前端可以再請求「續傳 30 列」延伸載入（避免 ERP 報表 title/metadata 區塊較長、實際 header 在 1x、2x 列的情境）。

UI（`components/SheetHeaderPicker.tsx`）：

1. 多 sheet 時以下拉讓使用者選；單 sheet 自動帶入
2. 顯示可捲動表格（30 列），左側標註列號
3. 使用者點任一列 → 設為 `header_row` → 該列高亮 `bg-blue-50`，下方即時顯示該列作為標頭時各欄的字串

Config 仍只存 `sheet` 名與 `header_row` 列號，不存 preview 內容。

## Preflight Validation

`POST /api/jobs` 在落地檔案 + enqueue 前同步驗證每份上傳檔：

1. 用 `openpyxl.load_workbook(read_only=True)` 開檔（每份 < 100ms）
2. 檢查 config 指定的 sheet 名存在
3. 檢查該 sheet 的 header_row 列標頭包含所有 `config.mappings[*].source` 與 `config.joins[*].left|right` 所需欄位
4. 任一不符 → 422，訊息含「哪份檔、哪個 sheet、缺哪個欄位」
5. 通過才落地到 `/data/jobs/{id}/uploads/`、寫 `state.json`、enqueue subtask

50 份檔約 5s preflight，可接受；換來壞檔早期攔截、避免 worker 跑到一半才丟 JoinKeyMissing。

## Job Cancellation Flow

`POST /api/jobs/{id}/cancel`：

1. 設 Redis `job:{id}.cancel_requested = 1`
2. 用 `rq.command.cancel_job` 移除所有未開始的 subtask
3. 已在跑的 subtask：worker 每處理完一份 source file 後檢查 `cancel_requested`，若為真則停止後續、不再 pop queue
4. 不強制 kill 已在跑的 subtask（避免半成品 xlsx）
5. 全部停止後：`cleanup_service.delete_job(id)` 刪整個 `/data/jobs/{id}/` + Redis key
6. 更新 `state.json` status = `cancelled`、SSE 推 cancellation event

UI：JobDetail 頁面 status ∈ {pending, running} 時顯示「取消」按鈕；按下後 confirm dialog。

## Download Grace Period

不在 stream 完成立即刪檔。改為：

- `download_started_at` 起算 **1 小時 grace period**
- 1 小時內：使用者可重試下載（API 檢查時間戳，若仍在 grace 內回 200 + file）
- 1 小時後：cleanup_service 移除整個 `/data/jobs/{id}/` + Redis key
- 支援 HTTP `Range` header（FastAPI `FileResponse` 預設）—大檔斷線可 resume
- UI：完成 200 響應後顯示「已下載」+ 剩餘有效時間（「可重新下載：剩 47 分鐘」）

Trade-off：考量大檔案 + 不穩網路情境，1 小時比 5 分鐘合理；磁碟成本可控（cleanup_service 每小時掃一次）。

## Cleanup Scheduling

使用 `APScheduler`（in-process）綁在 FastAPI lifespan：

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler = AsyncIOScheduler()
    scheduler.add_job(cleanup_service.purge_old_jobs, "interval", hours=1, kwargs={"older_than_hours": 24})
    scheduler.start()
    cleanup_service.purge_old_jobs(older_than_hours=24)  # 啟動時補掃
    recovery_service.scan_and_resume()
    yield
    scheduler.shutdown()
```

不依賴外部 cron daemon。服務重啟時 startup 立即跑一次 purge（補掃停機期間過期項目）。

## Persistence & Resume

**寫入順序**（每處理完一份 source file）：
1. 寫 `out/{source}.out.xlsx`
2. 更新 `state.json` 把該 subtask 標 `done`
3. SADD Redis `job:{id}:done`
4. Pub/Sub 推 SSE 事件

失敗時：只更新 `state.json` 該 subtask 為 `error`，不寫 `done`。

**Worker 啟動還原**（`recovery_service.scan_and_resume()`）：
1. 掃 `/data/jobs/*/state.json`
2. 對每個 status != `done` 的 job：
   - 從 `state.json` 重建 Redis `job:{id}` Hash 與 `job:{id}:done` Set
   - 對 status == `pending` 的 subtask re-enqueue 到 RQ
3. Worker 處理時若 `out/{source}.out.xlsx` 已存在 → 跳過（idempotent）

**清理**：
- 使用者成功下載 ZIP → `BackgroundTask` 刪除整個 `/data/jobs/{job_id}/` + Redis `job:{id}*`
- 未下載者：每日 cron 清掃 24h 前的 job 目錄

## Config JSON Schema

```jsonc
{
  "version": "1.0",
  "name": "string",
  "target_template": {
    "sheet": "string",
    "header_row": 1,
    "preserve_styles": true,
    "columns": ["string"]
  },
  "sources": [
    { "alias": "string", "role": "primary|lookup", "sheet": "string", "header_row": 1 }
  ],
  "joins": [
    { "left": "alias.column", "right": "alias.column", "type": "left|inner" }
  ],
  "mappings": [
    {
      "target": "string",
      "source": "alias.column",
      "conditions": [
        { "field": "alias.column", "op": ">=|<=|==|!=|contains|regex|in", "value": "any" }
      ],
      "default": "any"
    }
  ]
}
```

Pydantic 驗證；不通過回 422 + 友善訊息。

## Batch Upload Semantics（多 source 批次語意）

當 config 含多個 sources 時，「批次」的拆分單位是 **primary**，lookup 在 job 內**共用**：

| Role | 一個 job 內 | 角色 | 範例 |
|---|---|---|---|
| `primary` | 多檔（每檔 1 subtask） | 被批次處理的交易資料 | orders（每月一份） |
| `lookup` | 單檔（所有 subtask 共用） | Master data，被 join 引用 | customers、sales |

**`POST /api/jobs` multipart 結構**：

```
target_template:           file       ← 1 份
config_name | config_json: text/file
sources[<primary_alias>]:  file...    ← ≥ 1 份
sources[<lookup_alias>]:   file       ← 恰好 1 份
sources[<lookup_alias>]:   file
```

**驗證規則**：

- Primary slot 至少 1 檔；缺則 422
- 每個 lookup slot 恰好 1 檔（不可 0 或 ≥ 2）；違反則 422
- Schema 須包含 ≥ 1 個 primary（ConfigBuilder 已保證）

**Subtask 拆分**：N 個 primary → N 個 subtask。每個 subtask 用該份 primary + 共用的所有 lookups（從 `uploads/<lookup_alias>.xlsx` 取）。Lookups 在 job 內**只讀**，不會被任何 subtask 修改。

**檔案落地**：

```
/data/jobs/{id}/uploads/
├── target.xlsx
├── primary/
│   ├── 2025_05_orders.xlsx
│   ├── 2025_06_orders.xlsx
│   └── 2025_07_orders.xlsx
└── lookup/
    ├── customers.xlsx
    └── sales.xlsx
```

**`state.json` 的 subtask key**：仍用 primary 檔名（不變）。Lookups 不出現在 subtask 列表（它們不是被拆的單位）。

## Pipeline（worker）

**Subtask 級**：批次中每一份 **primary** file = 一個 RQ subtask；lookups 共用、不拆。全部完成才打包 ZIP。

```python
def run_subtask(job_id: str, source_file: str) -> None:
    """處理單一 source file。Idempotent：out 已存在則跳過。"""
    log = structlog.get_logger(job_id=job_id, source=source_file)
    job_dir = data_dir / "jobs" / job_id
    out_path = job_dir / "out" / f"{source_file}.out.xlsx"

    if out_path.exists():
        log.info("subtask.skip", reason="already_done")
        job_service.mark_done(job_id, source_file)
        return

    log.info("subtask.start")
    try:
        config = job_service.get_config(job_id)
        sources = parser.parse_all(job_dir / "uploads", config["sources"])
        joined = joiner.join(sources, config["joins"])
        mapped = mapper.apply(joined, config["mappings"], config["target_template"]["columns"])
        writer.write(job_dir / "uploads" / "target.xlsx", mapped, out_path)
        job_service.mark_done(job_id, source_file)
        log.info("subtask.done")
    except CoreError as e:
        job_service.mark_failed(job_id, source_file, e.user_message, e.tech_detail)
        log.error("subtask.failed", **e.context, exc_info=True)
        raise
    except Exception:
        job_service.mark_failed(job_id, source_file, "未預期錯誤，請聯絡管理員", "")
        log.exception("subtask.unexpected")
        raise

def finalize_job(job_id: str) -> None:
    """所有 subtask done 後觸發：打包 ZIP。"""
    job_dir = data_dir / "jobs" / job_id
    zipper.pack(job_dir / "out", job_dir / "result.zip")
    job_service.mark_complete(job_id)
```

## Progress Visibility

任何時候、任何來源（重啟、斷線、關頁、新分頁）都能找回進度。

### 機制

1. **穩定 SPA route** `/jobs/{id}`：可分享、可重訪
2. **localStorage `recentJobs`**：BatchRunner 起 job 時寫入 ID，開站時批次查
3. **TopMenuBar 進行中徽章**：顯示 active job 數，下拉清單可跳轉
4. **SSE 重連 snapshot**：`EventSource` 自動 retry（指數退避 3s 起），server 收到新連線立即送一個 snapshot 事件再開始增量推送

### 新增 API

- `GET /api/jobs/{id}` → `{status, total, done, failed, error?, created_at}`
- `GET /api/jobs?ids=a,b,c` → 批次查詢（避免 N 個請求）
- SSE channel：第一筆訊息固定為 `{type: "snapshot", ...}`，後續為 `{type: "subtask.done", source: "..."}` 等

## Error Handling（邊界式）

**原則**：core 只 raise；worker / API 兩個邊界處理。不在每步加 try/catch。

### 三層職責

| 層 | 行為 |
|---|---|
| Core (`parser/joiner/mapper/writer`) | 只 raise；只在能加上下文時才 catch + re-raise 為自訂例外 |
| Worker 邊界 (`run_subtask`) | 抓所有例外 → 寫 `state.json` + Redis 失敗狀態 + 結構化 log → re-raise |
| API 邊界 (FastAPI handler) | 自訂例外 → 4xx + 結構化 JSON；未預期例外 → 500 + request_id（細節進 log） |

### 自訂例外（`core/exceptions.py`）

```python
class CoreError(Exception):
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

- `structlog` JSON 輸出，一行一事件
- API 中介層注入 `request_id` (uuid4)
- Worker subtask 自動帶 `job_id` + `source_file`
- 前端錯誤訊息附 `request_id`，使用者回報 bug 時 `docker compose logs api | grep <id>` 秒查
- `state.json` 同時保留 `user_message`（前端顯示）與 `tech_detail`（除錯）

### 使用者錯誤呈現

| 情境 | HTTP / Job 狀態 | 訊息 |
|---|---|---|
| 上傳壞 xlsx | 422 | 「範本檔損毀或非 xlsx 格式」 |
| Config schema 不合 | 422 | 「欄位 `mappings[2].op` 必須為 `>=, <=, ...` 之一」 |
| 重名 config | 409 | 「專案『月報』已存在，是否覆蓋？」 |
| Subtask join key 缺欄 | Job error | 「來源檔 `orders.xlsx` 缺少欄位『客戶代號』」 |
| 未預期 bug | 500 / Job error | 「系統錯誤 (id: abc-123)，請聯絡管理員」 |

## Style Preservation

- `openpyxl.load_workbook(target.xlsx)` 載入目標範本
- 不重建 sheet，從 `header_row + 1` 開始**填值到既有 cell**
- 欄寬、字型、儲存格格式、合併儲存格、公式皆保留
- 公式不重算（openpyxl 預設行為）

## Concurrency & Memory

- 單檔上限 50MB（`MAX_UPLOAD_MB`）
- Worker 併發 4（`RQ_WORKERS`）
- 大檔 `openpyxl.load_workbook(read_only=True)` 串流讀
- 單 job 逾時 10 分鐘

## ZIP Lifecycle

- 完成後檔存於 `/data/jobs/{job_id}/result.zip`
- 使用者點下載 → FastAPI `StreamingResponse` → 完成後 `BackgroundTask` **刪除整個 `/data/jobs/{job_id}/` 目錄 + Redis `job:{id}*`**
- 未下載者：每日 cron 清掃 24h 前的 job 目錄

## Frontend

### User Profile

主要使用者：業務、顧問。客戶來源固定（ERP/SAP），**設定一次重複使用**。「專案設定」=偶爾、需謹慎；「批次轉換」=高頻、需順手。

### Visual Style

`shadcn/ui` + Tailwind 為底（灰階留白、細邊框），加上柔性互動回饋：軟陰影、選中態 `bg-blue-50` 高亮、上傳區 dashed border + 柔色 hover。自訂 `theme/tokens.css` 用 CSS 變數做 light/dark 切換。

### Page Layouts

**ConfigBuilder — 三欄式工作台**
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

**BatchRunner — 左右分欄**
```
┌─────────────────────────┬──────────────────────────────┐
│ 新批次                  │ 我的作業（即時 SSE）          │
│ Config: ACME ▾          │ ⏳ 月報轉換 7/10 [查看]      │
│ ⬆ 目標範本              │ ✅ 上週報表 10/10 [下載 ZIP] │
│ ⬆ 來源檔（多份）        │ ❌ 客戶 A 失敗 [重試]        │
│ [開始轉換]              │                              │
└─────────────────────────┴──────────────────────────────┘
```

**JobDetail (`/jobs/:id`)** — 穩定 URL、subtask 列表、SSE 斷線「連線中..」橫幅不歸零。

### Field Mapping + Condition Builder（Inline 展開）

每個目標欄位一行；點擊展開顯示：來源欄位下拉、條件 chip 串、預設值。

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

## Trade-offs

| 選項 | 取捨 |
|---|---|
| Redis-only vs Postgres | 選 Redis：少一個服務、AOF 夠用、KV 模型契合 config json |
| openpyxl vs xlsxwriter | 選 openpyxl 作主軸：能讀取既有樣式；輸出時保留原 workbook |
| RQ vs Celery | 選 RQ：輕量、與 Redis 同一服務、設定極簡 |
| SSE vs WebSocket | 選 SSE：單向進度推送，瀏覽器原生支援 |

## Security

- 內網單機，不開外網
- 上傳檔案以 mime + magic bytes 雙重驗證 xlsx
- ZIP 檔以 job_id (uuid4) 命名，避免目錄遍歷
- `regex` 條件以 `re2` 防 ReDoS（若 Python 標準 `re` 無法限時則 fallback 5 秒超時）
