# Tasks: Excel Template Parser

## 1. Scaffold & Infrastructure

- [x] 1.1 建立 `excelTemplateParser/` 專案骨架（backend/、frontend/、data/、docker-compose.yml、AGENTS.md）
- [x] 1.2 撰寫 `docker-compose.yml`：services 為 `api`, `worker`, `redis`, `frontend`；`DATA_DIR` env 控制掛載點
- [x] 1.3 Redis service 啟用 AOF `everysec` 持久化、掛 `${DATA_DIR}/redis:/data`
- [x] 1.4 Backend Dockerfile（python:3.12-slim + uv/pip）
- [x] 1.5 Frontend Dockerfile（node:20 + Vite build → nginx serve）
- [x] 1.6 `AGENTS.md`（英文）描述專案結構與本地開發指令
- [x] 1.7 `core/exceptions.py`：CoreError + ConfigError/JoinKeyMissing/MappingError/RegexTimeout/WriterError/TemplateInvalid
- [x] 1.8 `logging_config.py`：structlog JSON 輸出 + 主機/容器 metadata
- [x] 1.9 `middleware/request_id.py`：每個請求注入 uuid4 request_id

## 2. Backend Core（純函式，不依賴框架）

- [x] 2.1 `core/parser.py`：`parse(path, sheet, header_row) -> (DataFrame, headers)`，支援 read_only 串流
  - [x] 2.1.1 失敗時 raise `TemplateInvalid`（不 catch 後吞）
- [x] 2.2 `core/joiner.py`：`join(sources: dict[str, DataFrame], joins: list) -> DataFrame`，支援多階層
  - [x] 2.2.1 join 鍵不存在時 raise `JoinKeyMissing(user_message, join_spec=...)`
- [x] 2.3 `core/mapper.py`：`apply(df, mappings, target_columns) -> DataFrame`
  - [x] 2.3.1 條件運算子實作：`>=, <=, ==, !=, contains, regex, in`
  - [x] 2.3.2 預設值 fallback
  - [x] 2.3.3 regex 加 5 秒逾時保護 → raise `RegexTimeout`
- [x] 2.4 `core/writer.py`：載入目標範本 → 從 header_row+1 填值 → 保留樣式 → 輸出
- [x] 2.5 `core/zipper.py`：多 xlsx → ZIP
- [x] 2.6 `tests/test_parser.py` `test_joiner.py` `test_mapper.py` `test_writer.py` `test_zipper.py`
- [x] 2.7 `tests/test_exceptions.py`：驗證例外類別攜帶 `user_message` / `tech_detail` / `context`
- [x] 2.8 `core/preflight.py`：`preflight_check(file_path, sheet, header_row, required_columns) -> None | raise TemplateInvalid`，用 `read_only=True` 開檔驗證 sheet 名存在 + header 包含必要欄位

## 3. Backend Services

- [x] 3.1 `settings.py`：env 配置（REDIS_URL, **DATA_DIR**, MAX_UPLOAD_MB, RQ_WORKERS, JOB_TIMEOUT_MIN）
- [x] 3.2 `schemas.py`：Pydantic `ConfigSchema` 完整驗證
- [x] 3.3 `services/config_service.py`：CRUD（`save / get / list / delete`），**雙寫 Redis + `/data/configs/{name}.json`**
- [x] 3.4 `services/job_service.py`：
  - [x] 3.4.1 建立 job：寫 Redis `job:{id}` + `/data/jobs/{id}/state.json`（雙寫）+ 將每份 source file 列為 subtask
  - [x] 3.4.2 `mark_done(job_id, source_file)`：SADD `job:{id}:done` + 更新 state.json + pub/sub 推 SSE
  - [x] 3.4.3 `mark_failed(job_id, source_file, user_message, tech_detail)`：更新 state.json + Redis + pub/sub
  - [x] 3.4.4 `get_snapshot(job_id) -> {status, total, done, failed, error?, eta_seconds?}`，ETA 計算：≥ 5 個 subtask done 後 `avg(duration_ms) × remaining`
  - [x] 3.4.5 `mark_cancelled(job_id)`：設 Redis `cancel_requested=1`、撤 RQ queue、更新 state.json + SSE
- [x] 3.5 `services/recovery_service.py`：
  - [x] 3.5.1 啟動時掃 `/data/jobs/*/state.json`
  - [x] 3.5.2 對 status != done 的 job：重建 Redis 狀態、re-enqueue 未完成 subtask
- [x] 3.6 `services/cleanup_service.py`：
  - [x] 3.6.1 `delete_job(job_id)`：刪整個 `/data/jobs/{id}/` + Redis `job:{id}*`（取消、grace 過期、purge 共用）
  - [x] 3.6.2 `purge_old_jobs(older_than_hours=24)`：掃 `/data/jobs/*` 過期項目
  - [x] 3.6.3 `purge_grace_expired()`：掃 `download_started_at` > 1 小時前的 job
- [x] 3.7 APScheduler 設定：`scheduler.add_job(purge_old_jobs, interval, hours=1)` + `purge_grace_expired` 每 10 分鐘

## 4. Backend API

- [x] 4.1 `api/templates.py`：`POST /api/templates/parse` 上傳 xlsx → 回傳 `{ sheets: [{ name, preview_rows: [...30 rows] }] }`；支援 `?from_row=N` 延伸載入 30 列
- [x] 4.2 `api/configs.py`：
  - [x] 4.2.1 `GET /api/configs` 列表
  - [x] 4.2.2 `GET /api/configs/{name}` 取得
  - [x] 4.2.3 `POST /api/configs` 儲存（含 schema 驗證 + 重名 409）
  - [x] 4.2.4 `DELETE /api/configs/{name}`
- [x] 4.3 `api/jobs.py`：
  - [x] 4.3.1 `POST /api/jobs` 建立 job：
    - Multipart 結構：`target_template` + `config_name|config_json` + `sources[<alias>]` 多檔/單檔（按 role）
    - 落地到 `/data/jobs/{id}/uploads/{target.xlsx, primary/, lookup/}`
    - 驗證：primary slot ≥ 1 檔（否則 422）、每個 lookup slot 恰好 1 檔（否則 422）
    - 初始化 state.json 以 primary 檔名為 subtask key；lookups 不進 subtask 列表
    - 每份 primary enqueue 一個 RQ subtask
  - [x] 4.3.2 `GET /api/jobs/{id}` 取快照 → `{status, total, done, failed, error?}`
  - [x] 4.3.3 `GET /api/jobs?ids=a,b,c` 批次查詢快照
  - [x] 4.3.4 `GET /api/jobs/{id}/events` SSE 進度；**第一筆訊息固定為 snapshot 事件**，後續為增量
  - [x] 4.3.5 `GET /api/jobs/{id}/zip` 下載：寫 `download_started_at`、回 `FileResponse` 支援 `Range`；**不立即刪檔**（保留 1 小時 grace）
  - [x] 4.3.6 `POST /api/jobs/{id}/cancel` 取消執行中的 job
  - [x] 4.3.7 同名 primary 衝突：multipart 收到後立即偵測 → 422 with 衝突檔名
  - [x] 4.3.8 Preflight：建立 job 前對每份檔呼叫 `core.preflight.preflight_check`，任一失敗 → 422 + 具體訊息
- [x] 4.4 全域檔案大小限制 middleware（MAX_UPLOAD_MB）→ 超過直接 413
- [x] 4.5 上傳檔 magic bytes 驗證為合法 xlsx
- [x] 4.6 全域 exception handler：`CoreError` → 422 + `{error, code, request_id}`；其他 Exception → 500 + request_id（細節進 log）
- [x] 4.7 lifespan hook：啟動時呼叫 `recovery_service.scan_and_resume()` + `cleanup_service.purge_old_jobs(older_than_hours=24)`；註冊 APScheduler interval jobs（purge_old_jobs 每 1 小時、purge_grace_expired 每 10 分鐘）
- [x] 4.8 Worker pipeline：`run_subtask` 每完成一份檔後檢查 Redis `cancel_requested` flag，若為真則停止 pop queue

## 5. Worker

- [x] 5.1 `workers/tasks.py`：
  - [x] 5.1.1 `run_subtask(job_id, source_file)`：idempotent，`out/{source}.out.xlsx` 已存在則跳過
  - [x] 5.1.2 邊界 try：抓 `CoreError` → `mark_failed` + structlog；抓 `Exception` → 未預期錯誤 + `mark_failed`；皆 re-raise 讓 RQ 知道
  - [x] 5.1.3 `finalize_job(job_id)`：所有 subtask done 後打包 ZIP + `mark_complete`
- [x] 5.2 RQ worker 啟動腳本，併發數從 env 讀
- [x] 5.3 單 subtask 逾時設定（10 分鐘）
- [x] 5.4 Worker 啟動時呼叫 `recovery_service.scan_and_resume()`

## 6. Frontend Foundation

- [x] 6.1 `pnpm create vite` + TS + React 18
- [x] 6.2 安裝：`@tanstack/react-query`, `react-i18next`, `i18next`, `react-router-dom`, `lucide-react`, `react-dropzone`, `zod`
- [x] 6.3 `pnpm dlx shadcn@latest init` + Tailwind 配置；加入 button/input/select/dropdown-menu/dialog/tabs/sheet 元件
- [x] 6.4 `theme/ThemeProvider.tsx` + `theme/tokens.css`（CSS 變數，light/dark）
- [x] 6.5 `i18n/index.ts` + `i18n/zh-TW.json` + `i18n/en.json`
- [x] 6.6 `components/TopMenuBar.tsx`：分頁「專案設定 / 批次轉換」、語言切換、主題切換、進行中作業徽章 + JobsPanel 下拉
- [x] 6.7 `components/JobsPanel.tsx`：顯示 recentJobs，分組「進行中 / 已完成可下載」
- [x] 6.8 `components/FileDropzone.tsx`：共用上傳區（dashed border + 柔色 hover）
- [x] 6.9 `lib/api.ts`：fetch wrapper + SSE helper（自動 retry 指數退避 3s 起）
- [x] 6.10 `lib/recentJobs.ts`：localStorage CRUD
- [x] 6.11 `lib/schemas.ts`：zod schema（對應後端 ConfigSchema）
- [x] 6.12 `hooks/useJobSnapshot.ts`：`GET /api/jobs/{id}` 取快照 + 訂閱 SSE 接續更新；SSE 斷線時保留最後狀態
- [x] 6.13 `hooks/useConfigs.ts`：configs CRUD with TanStack Query
- [x] 6.14 響應式：桌機 ≥1280px 三欄；平板降兩欄；手機顯示「請使用桌機」

## 7. Frontend Pages

- [x] 7.1 `pages/ConfigBuilder.tsx`：三欄式工作台容器（左/中/右）+ 專案名稱欄位（含重名 409 二次確認）+「儲存並下載」與「下載當前設定檔」雙按鈕；支援 `?config=<name>` query param 載入既有 config；頂部下拉「載入既有專案 / 建立新專案」；表單變動 debounce 1s 寫 `localStorage.configDraft_*`，開啟頁面偵測 draft 提示還原；name 驗證 pattern `^[\p{L}\p{N}_\- ]{1,80}$`
  - [x] 7.1.0 `components/SheetHeaderPicker.tsx`：上傳 xlsx 後 → `POST /api/templates/parse` → 顯示 sheet 下拉 + 30 列預覽表（可捲動）+ 點列設 `header_row`；「載入更多 30 列」按鈕
  - [x] 7.1.1 `features/config-builder/SourcesTree.tsx`：左欄；目標範本 + 來源檔的樹狀清單，可展開看欄位；每份檔旁邊內嵌 `SheetHeaderPicker`
  - [x] 7.1.2 `features/config-builder/JoinsEditor.tsx`：中欄；卡片式 join 規則（左欄/右欄欄位下拉）、可串多階層、新增/刪除
  - [x] 7.1.3 `features/config-builder/MappingsList.tsx`：右欄；inline 展開列表
  - [x] 7.1.4 `features/config-builder/MappingRow.tsx`：單列 inline 展開（來源下拉 + 條件 chip 串 + 預設值）
  - [x] 7.1.5 `components/ConditionChip.tsx`：欄位/op/值三色 chip，可編輯、可刪除
  - [x] 7.1.6 客戶端 zod 驗證；「儲存並下載」POST 後觸發瀏覽器下載 `{name}.json`
- [x] 7.2 `pages/BatchRunner.tsx`：左右分欄容器
  - [x] 7.2.1 `features/batch-runner/NewBatchForm.tsx`：左欄
    - 選定 config（下拉 ‖ 上傳 json）後，依 schema 動態渲染**每個 source alias 一個 slot**
    - Primary slot：`FileDropzone` 多檔模式 + 藍色 `📥` 圖示 + 說明「可多檔，每檔產一個輸出」
    - Lookup slot：`FileDropzone` 單檔模式 + 灰色 `📎` 圖示 + 說明「單檔，所有 primary 共用」
    - 目標範本 slot：單獨一區、`🎯` 圖示
    - 底部即時顯示「將產出 N 份輸出」（依當前 primary 檔數）
    - 「開始轉換」按鈕；送出前 zod 驗證 primary ≥ 1、每個 lookup = 1
  - [x] 7.2.2 `features/batch-runner/JobsList.tsx`：右欄；列出 localStorage 中所有 job，使用 `useJobSnapshot` 顯示即時進度、下載、重試、查看詳情按鈕
  - [x] 7.2.3 送出後寫 localStorage recentJobs（不強制跳轉，可選擇看右欄或進 /jobs/:id）
- [x] 7.3 `pages/JobDetail.tsx` (`/jobs/:id`)
  - [x] 7.3.1 使用 `useJobSnapshot(id)` 取快照 + SSE
  - [x] 7.3.2 總進度條 + subtask 列表（檔名、狀態 icon、耗時、失敗訊息）
  - [x] 7.3.3 SSE 斷線時顯示「連線中..」橫幅，不歸零
  - [x] 7.3.4 失敗 subtask 可單獨重試（POST 重新 enqueue）
  - [x] 7.3.5 完成後顯示「下載 ZIP」按鈕；點擊後仍保留 1 小時可重複下載，顯示「剩 N 分鐘」倒數
  - [x] 7.3.6 status ∈ {pending, running} 時顯示「取消」按鈕 → confirm dialog → `POST /api/jobs/{id}/cancel`
  - [x] 7.3.7 ETA 顯示：snapshot 提供 `eta_seconds` 時顯示「預估剩餘約 X 分 Y 秒」；否則顯示「估算中..」
  - [x] 7.3.8 部分失敗時下載按鈕標註「(4 成功 / 1 失敗)」；ZIP 內含 `_summary.txt`

## 8. Verification

- [ ] 8.1 `pytest backend/tests/` 全綠
- [x] 8.2 `docker compose up` 一鍵啟動，瀏覽 `http://localhost:5173` 可進入
- [x] 8.3 端對端走流程 A：取名 `test_demo` → 上傳範本 → 下載 `test_demo.json` → `redis-cli GET config:test_demo` 確認存在 + `/data/configs/test_demo.json` 存在
- [x] 8.4 端對端走流程 B：選 `test_demo` + 上傳 3 份來源 → SSE 進度 0→3/3 → 下載 ZIP → 確認 `/data/jobs/{id}/` 已完整刪除
- [x] 8.5 樣式驗證：在 Excel 打開輸出檔，欄寬/字型/格式與目標範本一致
- [ ] 8.6 記憶體驗證：30MB 來源檔，`docker stats` worker RSS < 500MB
- [x] 8.7 錯誤路徑：壞 xlsx → 422 + request_id；缺欄位 config → 422 with field path；重名 → 409
- [ ] 8.8 UX：切換中/英文整個 UI 文字更新；切換 Dark Mode 並重整後設定保留
- [x] 8.9 **續傳測試**：跑 10 份來源，第 5 份處理中 `docker compose restart worker` → 重啟後從第 5 份繼續，前 4 份 `out/` 不重做
- [x] 8.10 **持久化測試**：建立 config 後 `docker compose down && up` → config 仍存在
- [x] 8.11 **災難測試**：刪除 Redis volume（保留 `/data/jobs/`）→ worker 啟動時從 state.json 重建並完成剩餘 subtask
- [x] 8.12 **進度可見性測試**：
  - 啟動批次 → 關閉分頁 → 重開 → TopMenuBar 徽章顯示進行中數
  - 進行中 `docker compose restart` → SSE 自動重連 → 進度不歸零
  - 直接打開 `/jobs/{id}` URL（從未訪問）→ 顯示完整快照
- [x] 8.13 **錯誤處理測試**：
  - 壞 xlsx → 422 含 request_id；`docker compose logs api | grep <request_id>` 找回完整 traceback
  - join key 不存在 → job error，state.json 含 user_message + tech_detail
- [x] 8.14 **多 source 批次語意測試**：
  - 上傳 3 primary + 1 customers + 1 sales → 1 個 job、3 個 subtask、3 份輸出於 ZIP
  - 上傳 0 primary → 422 with "primary alias requires at least one file"
  - 上傳 2 個 customers（lookup slot）→ 422 with "lookup alias accepts exactly one file"
  - 重啟續傳：5 primary 中 2 個完成後重啟 worker → 只 re-enqueue 剩下 3 個；lookups 不會被重做（檔案不變）
- [ ] 8.15 **Sheet & Header Row 選擇**：上傳多 sheet xlsx → 下拉列出全部 sheet；選定後預覽 30 列；點第 12 列設為 header → 標頭即時更新
- [x] 8.16 **Preflight 驗證**：上傳一份 xlsx 缺 join key 欄位 → API 在 enqueue 前回 422 + 具體欄位名；通過則建立 job
- [x] 8.17 **同名 primary 拒絕**：上傳 2 份都叫 orders.xlsx → 422 with 衝突檔名
- [x] 8.18 **取消 job**：開始 10 份批次 → 進度 3/10 時按取消 → 已完成的不再保留，整個 job 目錄刪除，status='cancelled'
- [ ] 8.19 **ETA**：跑 10 份批次，前 5 個完成後 snapshot 含 `eta_seconds`，UI 顯示「預估剩餘約 N 分鐘」
- [ ] 8.20 **部分失敗 ZIP**：5 份中 1 份故意失敗 → ZIP 內含 4 個成功 + `_summary.txt`；UI 標註「4 成功 / 1 失敗」
- [x] 8.21 **Grace period**：成功下載後 30 分鐘重按下載 → 仍可重下；70 分鐘後 → 410 Gone
- [x] 8.22 **Range 下載**：模擬 `Range: bytes=N-` → 回 206 Partial Content
- [ ] 8.23 **編輯既有 config**：訪問 `/configs/new?config=ACME` → 載入 ACME 設定 → 點「下載當前設定檔」可重新取得 json，未修改也能下載
- [ ] 8.24 **Draft 草稿**：ConfigBuilder 填到一半關分頁 → 重開 → 提示還原
