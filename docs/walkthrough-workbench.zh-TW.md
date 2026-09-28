# 操作流程 — 三欄式工作台

[English](walkthrough-workbench.md)

這是 Setup Wizard 的替代方案，適合想在單一畫面完成所有設定的使用者。

端到端流程六步驟：

### 1. 建立 config

![專案設定 — 三欄式工作台](ss/excelTemplateParser-projectSettings.png)

三欄式工作台：左欄為資料來源樹（目標範本 + 每個 source 的 sheet 與 header 選擇器），中欄為 join 規則，右欄為映射列表（含 inline 條件 chip 與 來源欄位／固定儲存格／固定值 三選一）。儲存 → 下載 `{name}.json`。

### 2. 還原未存檔草稿

![專案設定 — 草稿還原 banner](ss/excelTemplateParser-projectSettingsRestore.png)

再次進入頁面時，若上次的草稿仍在，會跳出非侵入式 banner 詢問「還原 / 捨棄」。banner 只能由明示操作清除；autosave 不會對空白表單寫入，所以全新使用者不會看到。

### 3. 批次轉換 — 上傳 JSON 設定

![批次轉換 — 上傳 JSON config](ss/excelTemplateParser-uploadConfigFile.png)

若 config 不在伺服器上已儲存清單裡，直接上傳 `{name}.json` 檔。表單解析 JSON 後依 source alias 動態展開 upload slot，並在每個 slot 下方顯示上次上傳的檔名提示。

### 4. 選既有設定 + 即時進度

![批次轉換 — 選既有設定 + SSE 進度](ss/excelTemplateParser-loadFromRedisAndCheckNotify.png)

對已儲存到伺服器的 config（從「專案設定 → 儲存」），下拉選單列出名稱（從 Redis / `/data/configs/` 載入）。subtask 級進度透過 SSE 即時推送；上方徽章記錄進行中任務、跨重整不丟；右欄從 localStorage 取近期任務，任何過往任務都能回去看。

### 5. 任務詳情頁

![任務詳情 — 各 subtask 狀態 + 下載](ss/excelTemplateParser-downloadDetails.png)

穩定 URL `/jobs/:id` 可分享。顯示每個 subtask 狀態、失敗訊息附 `request_id`（直接 grep server log 找 traceback）、進行中任務的 Cancel 按鈕、以及串流回傳 ZIP 的 Download 按鈕（支援 HTTP Range / resume）。

### 6. 結果 ZIP

![結果 ZIP — output xlsx + _summary.txt](ss/excelTemplateParser-downloadedZIPFile.png)

ZIP 內每個 primary 輸入對應一份 xlsx（`{原始檔名}.out.xlsx`，樣式從目標範本保留），另含 `_summary.txt`——任務清單檔，逐項列出每個 subtask 的狀態、耗時與錯誤訊息。批次跑幾十個檔案時、這份 summary 就是稽核軌跡。
