# excelTemplateParser

[English](README.md) · **繁體中文**

[![CI](https://github.com/twjohnwu/excelTemplateParser/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/twjohnwu/excelTemplateParser/actions/workflows/ci.yml) [![Version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)

把同一格式的多份 Excel 批次轉換為另一種格式。設定一次、重複套用；單機 Docker 部署，不需登入。UI 支援繁中／英文與淺色／黑暗模式，皆會持久化於瀏覽器。

---

## 目錄

- [特色](#特色)
- [一鍵啟動](#一鍵啟動)
- [系統概念](#系統概念)
- [操作流程](#操作流程)
- [Examples（實際案例）](#examples實際案例)
- [架構](#架構)
- [設計文件](#設計文件)
- [Out of Scope](#out-of-scope)
- [貢獻](#貢獻)
- [Changelog](#changelog)
- [License](#license)

---

## 特色

- **Subtask 級續傳**——每份 primary 檔 = 一個 task；worker 中途崩潰，重啟後既存的 `out/*.xlsx` 直接跳過（透過 `recovery_service.scan_and_resume()` idempotent 還原）。
- **跨重整都保留的進度顯示**——SSE 逐 subtask 即時推送；上方徽章 + localStorage 跨 reload 追蹤進行中任務，關掉分頁回來也找得到。
- **可靠下載**——下載 ZIP 支援 HTTP Range / 部分內容；首次下載後 1 小時內可重新下載。
- **災難復原**——Redis 是快取，`/data/` 才是真相。即使 Redis volume 整個損毀，下次啟動會從 `state.json` 重建任務狀態。
- **Preflight 驗證**——壞 xlsx / 缺 sheet / 缺欄位在 API 邊界就攔截（50 份檔 ~5 秒），不會跑到 worker 才崩潰。
- **邊界式錯誤處理**——每個錯誤回應都附 `request_id`；`docker compose logs api | grep <id>` 直接找到完整 traceback。使用者訊息與工程師 traceback 從不混在一起。
- **i18n + 黑暗模式**——繁中／英文、淺色／黑暗，皆持久化於 localStorage、reload 不閃白。
- **Autosave + 草稿還原**——ConfigBuilder 自動存草稿到 localStorage，再次進入時跳出明示的「還原 / 捨棄」選擇；localStorage 只被使用者明示操作改動，autosave 不自作主張清理。

---

## 一鍵啟動

```bash
bash scripts/up.sh
```

- UI: http://localhost:5173
- API: http://localhost:8000

完整安裝、開發流程、環境變數與 CI：[`docs/setup.zh-TW.md`](docs/setup.zh-TW.md)。

---

## 系統概念

兩個分頁、兩種角色：

| 分頁 | 用途 | 頻率 |
|---|---|---|
| **專案設定** | 一次性設定欄位映射、join 規則、條件 → 下載 `{name}.json` | 偶爾、需謹慎 |
| **批次轉換** | 上傳 config + 目標範本 + 多份來源檔 → 後端產 ZIP | 高頻、需順手 |

設定檔含三類組件：

- **target_template**：輸出範本（保留樣式）
- **sources**：1 個 `primary`（被批次處理的交易檔）+ N 個 `lookup`（master data，整個批次共用）
- **joins / mappings**：多階層 join + 欄位映射，映射值有三種模式：
  - **欄位引用**（`alias.col`）——逐列從 join 後的 DataFrame 取值
  - **絕對儲存格引用**（`alias!A3`）——透過 openpyxl 直接讀 source xlsx 的指定位址，跳過 header 抽象
  - **固定值**——常數字串
  - 三種模式都支援條件（`>=, <=, ==, !=, contains, regex, in`）與預設值。

批次轉換：每份 primary 檔 = 一個 subtask = 一份輸出 xlsx；lookup 檔被所有 subtask 共用；全部完成後打包成 ZIP，並附 `_summary.txt`——逐筆列出每個 subtask 的狀態、耗時與錯誤訊息的清單檔。

---

## 操作流程

端到端流程六步驟：

### 1. 建立 config

![專案設定 — 三欄式工作台](docs/ss/excelTemplateParser-projectSettings.png)

三欄式工作台：左欄為資料來源樹（目標範本 + 每個 source 的 sheet 與 header 選擇器），中欄為 join 規則，右欄為映射列表（含 inline 條件 chip 與 來源欄位／固定儲存格／固定值 三選一）。儲存 → 下載 `{name}.json`。

### 2. 還原未存檔草稿

![專案設定 — 草稿還原 banner](docs/ss/excelTemplateParser-projectSettingsRestore.png)

再次進入頁面時，若上次的草稿仍在，會跳出非侵入式 banner 詢問「還原 / 捨棄」。banner 只能由明示操作清除；autosave 不會對空白表單寫入，所以全新使用者不會看到。

### 3. 批次轉換 — 上傳 JSON 設定

![批次轉換 — 上傳 JSON config](docs/ss/excelTemplateParser-uploadConfigFile.png)

若 config 不在伺服器上已儲存清單裡，直接上傳 `{name}.json` 檔。表單解析 JSON 後依 source alias 動態展開 upload slot，並在每個 slot 下方顯示上次上傳的檔名提示。

### 4. 選既有設定 + 即時進度

![批次轉換 — 選既有設定 + SSE 進度](docs/ss/excelTemplateParser-loadFromRedisAndCheckNotify.png)

對已儲存到伺服器的 config（從「專案設定 → 儲存」），下拉選單列出名稱（從 Redis / `/data/configs/` 載入）。subtask 級進度透過 SSE 即時推送；上方徽章記錄進行中任務、跨重整不丟；右欄從 localStorage 取近期任務，任何過往任務都能回去看。

### 5. 任務詳情頁

![任務詳情 — 各 subtask 狀態 + 下載](docs/ss/excelTemplateParser-downloadDetails.png)

穩定 URL `/jobs/:id` 可分享。顯示每個 subtask 狀態、失敗訊息附 `request_id`（直接 grep server log 找 traceback）、進行中任務的 Cancel 按鈕、以及串流回傳 ZIP 的 Download 按鈕（支援 HTTP Range / resume）。

### 6. 結果 ZIP

![結果 ZIP — output xlsx + _summary.txt](docs/ss/excelTemplateParser-downloadedZIPFile.png)

ZIP 內每個 primary 輸入對應一份 xlsx（`{原始檔名}.out.xlsx`，樣式從目標範本保留），另含 `_summary.txt`——任務清單檔，逐項列出每個 subtask 的狀態、耗時與錯誤訊息。批次跑幾十個檔案時、這份 summary 就是稽核軌跡。

---

## Examples（實際案例）

完整端到端案例放在 [`examples/`](./examples)。每個案例附 `config.json`、來源 xlsx、目標範本與預期輸出——拿同樣的輸入丟工具跑，應該得到相同結果。

- [**01_product_pricing**](./examples/01_product_pricing) — 商品主檔 × 三家供應商月報價，每家欄位命名不同（`貨號` / `SKU` / `商品編號`）。展示 **outer join** 如何讓「沒被任何供應商報價的商品」自動浮現。
- [**02_agri_market_report**](./examples/02_agri_market_report) — 農業部開放資料：2025-06-18 全台 1000 筆批發交易，透過市場代碼、TcType 兩個 lookup 拼出「市場日報」。展示**真實開放資料** + 中英欄位混合的整合場景。

---

## 架構

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

**儲存策略**：Redis 是快取、`/data/` 是真相來源。雙寫；Redis volume 損壞時 worker 啟動會從 `state.json` 重建。

**故障復原**：subtask 級續傳。Worker 崩潰 / 重啟後，`recovery_service.scan_and_resume()` re-enqueue 未完成的 subtask；已寫出 `out/{primary}.out.xlsx` 的不重做（idempotent）。

**錯誤處理**：邊界式。Core 純函式只 raise；worker 與 FastAPI 兩個邊界各自 catch、寫 `state.json` 與結構化 log（`structlog` JSON），錯誤回應帶 `request_id` 方便 `docker compose logs api | grep <id>`。

專案結構：見 [docs/setup.zh-TW.md](docs/setup.zh-TW.md#專案結構)。

---

## 設計文件

完整設計脈絡與決策記錄：

- [`docs/plan.md`](docs/plan.md) — 最終 plan（架構、流程、schema）
- [`docs/case_study.md`](docs/case_study.md) — 七輪設計對話實況 + 上線後使用者實測的第八輪（八個 sub-round）
- [`docs/decisions_log.md`](docs/decisions_log.md) — 37 條跨越整段歷程：22 條設計轉折 + 9 條上線後迭代 + 6 條 UX 改版，分三部分
- [`docs/learnings.md`](docs/learnings.md) — 10 條跨 decision 提煉（6 條設計 + 4 條迭代）
- [`docs/setup.zh-TW.md`](docs/setup.zh-TW.md) — 安裝、開發流程、環境變數、CI

OpenSpec 規格層（自上層 monorepo 同步；設計期快照，以程式碼為準）：

- [`docs/spec/proposal.md`](docs/spec/proposal.md)
- [`docs/spec/design.md`](docs/spec/design.md)
- [`docs/spec/tasks.md`](docs/spec/tasks.md)
- [`docs/spec/spec.md`](docs/spec/spec.md)

---

## Out of Scope

- 使用者帳號 / 多租戶 / 權限
- Excel 公式重算（保留原樣由 Excel 開檔時計算）
- 雲端部署／正式環境交付流程（GitHub Actions 只跑測試與 smoke，不做部署）
- 範本版本控制（覆蓋同名專案即取代，UI 二次確認）

---

## 貢獻

[`CONTRIBUTING.md`](CONTRIBUTING.md) 說明開發環境、程式風格、錯誤處理慣例與 PR checklist。

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) 記錄面向使用者的版本變更（Keep a Changelog 格式）。

## License

[MIT](LICENSE) © 2026 twjohnwu
