# Proposal: Excel Template Parser

## Why

ERP 報表轉換是高頻、低變動性的工作：欄位對應規則一旦定下來，每月、每週都要重複執行一次。目前流程仰賴手工複製貼上、套公式、跨表查表，既耗時又容易出錯。需要一個工具：

- **一次設定、無限重用**：使用者定義一次「目標欄位 ← 來源欄位」的映射，存成 json，下次只要選擇即可批次轉換。
- **零程式碼門檻**：非工程師也能透過拖拉式介面完成設定。
- **輕量單機**：內網使用，不需登入、不需外部資料庫。

## What Changes

新增專案 `excelTemplateParser/`，提供 Docker 一鍵啟動的全端網站：

1. **建立專案設定** 分頁
   - 命名專案
   - 上傳目標範本（保留樣式）
   - 上傳多份來源範本（標記 primary + lookup）
   - 顯式設定多階層 join 規則
   - 設定欄位映射 + 條件（`>=, <=, ==, !=, contains, regex, in`）+ 預設值
   - 輸出 `{name}.json` 供下載，同時存入 Redis

2. **批次轉換** 分頁
   - 下拉選擇既有專案 或 上傳 json 設定檔
   - 上傳目標範本 + 多份來源檔
   - 伺服端 job queue（RQ）處理，併發 4
   - SSE 推送進度
   - ZIP 打包輸出，下載後立即刪除

3. **基礎建設**
   - FastAPI + openpyxl + pandas（後端）
   - React + Vite + TypeScript（前端）
   - Redis（儲存 + 任務佇列，AOF 持久化）
   - docker-compose 一鍵啟動

## Impact

- **新增**：`excelTemplateParser/` 整個目錄（前後端 + docker-compose）
- **新增規格**：`openspec/specs/excel-template-parser/` 描述系統能力
- **不影響**現有專案（devUtils、mrinspect、releaseGuard 等）
- **依賴**：Docker、Redis（隨 compose 啟動，不重用 localhost:5432）

## Non-Goals

- 使用者帳號 / 多租戶 / 權限管控
- Excel 公式重算（保留原樣即可，由 Excel 開檔時計算）
- 雲端部署、CI/CD
- 範本版本控制（覆蓋同名專案即直接覆蓋，UI 上二次確認）
