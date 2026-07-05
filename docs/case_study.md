# Case Study：excelTemplateParser 從設計到上線後的對話實況

本文**不是規格**。這是把 `excelTemplateParser` 的設計與迭代過程當作案例研究——前段是設計階段七輪 plan mode 對話（一句話需求收斂為可實作 spec），後段是上線後一輪使用者實測（六條 corner case 一條條浮現修法）。

兩段以分隔線區隔。Part 1 維持原本的「七輪對話 → 五項可驗證主張 → 四段提煉 → 限制與接下來」結構；Part 2 新加「第八輪：上線後使用者實測」八小節敘事，加上 2 條迭代階段的可觀察主張、1 條提煉。最後用「全文回望」把兩段對話模式對比起來。

關鍵主張：**好的設計不是寫出來的，是談出來的**——而且這段「談」不止於設計階段，會一路延伸到上線後使用者用真實資料推到 corner case 的每一次反問。每一次反問都讓系統收斂一個自己原先沒看見的盲點。

---

## 起點

使用者貼出的初始需求（節錄）：

> ERP Excel 自動轉換系統設計
> 將同樣格式的 Excel 批次轉換為另一種格式
>
> Sidebar:
> 1. 建立專案設定
> 2. 批次轉換
>
> 建立專案設定：
> 1. 上傳目標範本
> 2. 上傳來源範本（可多選配對資料表關聯
> 3. 自動帶入各表格標頭於畫面上，讓使用者設定目標欄位的資料來源
> 4. 配對結束，輸出 json 設定檔下載
>
> ...
>
> - 做前後端合一可用 docker 啟動的網站，或是單一 script 哪個較適合？
> - 設定目標資料來源時，是否能加入簡單判斷？（大於等於小於、關鍵字吻合
> - 若是多選配對資料表關聯，要如何處理來源的關聯表可能會有多階層關聯的問題？
> - 輸出檔案時，若是單一 script 可以選擇輸出資料夾；但若是網站，是否能一個個多執行緒分散式下載？是否需要額外設定記憶體上限？

需求看起來「明確」，但每一項都藏著未決定的取捨。使用者已經先列出他自己的開放問題——這是一個成熟的起點，但也意味著**單純照需求清單實作會錯**。

---

## 第一輪：架構選型（取捨在權衡而非偏好）

第一輪的四個 AskUserQuestion 直接對應使用者開放問題：

| 問題 | 選項 | 結果 |
|---|---|---|
| 架構形式 | Docker 全端 / CLI script / 桌面 Electron | **Docker 全端** |
| 轉換邏輯 | 直接映射 + 條件 / 純映射 / 加表達式 | **直接映射 + 條件** |
| 多表關聯 | 顯式 join / 單階關聯 / 自動推斷 | **顯式 join** |
| 輸出策略 | 伺服端佇列 + ZIP / 串流分散 / 合併單檔 | **伺服端佇列 + ZIP** |

第一輪結束時，技術棧已定（FastAPI + React + Redis + RQ），核心資料模型有了雛形（config json schema）。

**第一輪的關鍵收穫**不是任何單一決策，而是**強制把使用者的選項擺出來給他自己挑**——這比工程師憑直覺自選好得多。使用者選了「直接映射 + 條件」表示他要的不是 spreadsheet 替代品（不需要公式），但需要比純查表更聰明（要條件過濾）。這個取捨直接決定 mapper 的複雜度上限。

第一輪結束後使用者補了一句：

> sidebar -> TopMenuBar

短短七個字。系統剛通過 plan，使用者就改了主導航。**這預示了 plan mode 不是「定案」，而是「進入下一輪修正的起點」**——這個觀察貫穿後續所有 plan 通過後又被修正的事件。

---

## 第二輪：「Redis 掛了怎麼辦？」

第二輪的起點是使用者的兩個提問：

> 用 redis 取代 postgres db 在效能上是否會有問題？
> 在批次處理大量來源 excel 時，若碰到設備故障導致中斷，有續傳機制嗎？還是只能從頭來？

效能那題答起來簡單（不會，Redis 對此用例毫無瓶頸）；續傳那題答起來有後果。我給出三選一：

- A：以 source file 為單位的續傳
- B：以 row 為單位的續傳
- C：不加，保持 KISS

使用者的回答是：

> 若故障導致 docker down, redis 內的資料也會隨之消失吧？這樣 job 也會清空不是？哪來的 job 驗證現有資料夾進度？亦或是加入「啟動時需選擇本地掛載資料夾」設定？

這句話直接點出我**前一輪的盲點**：Redis 是 in-memory 資料庫，但我只說「AOF 持久化」沒講清楚 docker volume 怎麼掛載、資料怎麼真正落到主機。從使用者視角，「Redis-only」聽起來像「都靠記憶體」。

回答這個問題的過程，把整個 persistence 設計推到下一個層級：

```
/data/                              # 使用者可自訂掛載點（env: DATA_DIR）
├── redis/                          # AOF 持久化（docker volume）
├── configs/                        # 補強：config 雙寫成 JSON 檔
│   └── {name}.json
└── jobs/
    └── {job_id}/
        ├── state.json              # 進度真相：{subtasks: {file: status}}
        ├── uploads/
        ├── out/
        └── result.zip
```

**Redis 變成快取、檔案變成真相來源**。Worker 啟動時優先掃 `state.json` 還原狀態。即使 Redis volume 損毀，只要 `/data/jobs/` 還在就能續傳。

第二輪結束時，「壞了再開」這件事有了四層防護：

1. AOF + Docker volume 處理一般重啟
2. 檔案雙寫處理 Redis volume 損壞
3. Subtask idempotent（檢查 `out/` 是否存在）處理重複處理
4. 上傳檔持久化處理 worker 崩潰

使用者最後補了一句：

> 用檔案雙寫，但如此一來在用戶端 zip 下載成功後，除了 zip 原檔，也要將 upload\, out\ 目錄內原始檔刪除，否則長久下來會佔用空間

這個提醒讓「下載成功後 BackgroundTask」從刪 zip 升級為刪整個 `/data/jobs/{id}/`。又一個 plan 通過後的修正。

---

## 第三輪：「每步加 try/catch 嗎？」與被反向回答

第三輪起點：

> 設計越來越完善也更複雜了，是否要在每個步驟加入 try/catch 以便回傳錯誤訊息，更好的除錯訊息

使用者的直覺合理——複雜系統需要保險。但**這是個 trap question**。我沒順著答，反而給出反例：

```python
# 反例 — 看起來保險，實際是地雷
def process():
    try:
        data = parser.parse(path)
    except Exception as e:
        logger.error(f"parse failed: {e}")
        return None      # ← 呼叫者不知道為何拿到 None
    try:
        joined = joiner.join(data, ...)
    except Exception as e:
        logger.error(f"join failed: {e}")
        return None      # ← 又一次靜默失敗
```

問題：吞 stack trace、誘發靜默失敗、無法區分「預期錯誤」與「未預期 bug」。

替代方案是「邊界式錯誤處理」：

| 層 | 行為 |
|---|---|
| Core | 只 raise；用自訂例外類別表達預期錯誤 |
| Worker 邊界 | 抓所有例外 → 寫 `state.json` + 結構化 log → re-raise |
| API 邊界 | 自訂例外 → 4xx + 結構化 JSON；未預期 → 500 + request_id |

加上 `structlog` JSON log 與 request_id 中介層，使用者回報 bug 時可以這樣查：

```bash
docker compose logs api | grep <request_id>
```

使用者選了這個方案。**這一輪的價值不是技術選型，而是接受「使用者的直覺解可能是錯的」這件事**——並把為什麼錯說清楚到使用者願意改變立場。

第三輪結束時使用者又補了一句：

> 開發時，於此目錄開發： `sideProjects/excelTemplateParser/`

這次 plan 通過後的「補一句」變成了 critical files 段落的明確開發路徑。又一次提醒：plan 通過 ≠ 終點。

---

## 第四輪：前端視覺與 Visual Companion

第四輪是純前端設計。我問使用者要不要開瀏覽器同步看 mockup，他說 "let's try"。從這裡開始討論顆粒度發生變化。

### 第一個視覺問題：風格方向

我推三張卡片到瀏覽器：A 灰階留白（shadcn 風）、B 深色密度（Ant Design 風）、C 圓角柔色（Mantine 風）。使用者的回應：

> A 的灰階留白可以凸顯重要區塊；C 親和的操作介面且選擇後的項目有底色提示，使用者友善

這不是「我選 A」也不是「我選 C」，而是**精準指出 A 的哪一點、C 的哪一點是他要的**。文字描述很難得到這種精度。並排視覺讓使用者能比較「重要區塊凸顯」與「選擇後底色提示」這種微妙差異。

結論：shadcn 為底 + Mantine 風互動回饋。

### 第二個視覺問題：ConfigBuilder 佈局

A 單頁長捲動、B 步驟式精靈、C 三欄式工作台。我推薦 C 但提醒使用者：「精靈對偶爾使用者比較安全」。使用者第一次的回答（節錄重述、已脫敏）：

> 主要場景是低頻使用——客戶的來源檔通常是從 ERP / SAP 等系統固定輸出的格式，「建立設定」一個專案只需做一次，之後重複套用，不需要經常進入此功能。

聽起來指向 B（精靈，新手友善）。我也準備往 B 走了。但使用者接著補了一句：

> 上一題我漏講了，我覺得 C 的設計很好，一目瞭然

**這是整個第四輪最關鍵的修正**。一個偶爾使用的功能，標準工程直覺是「強引導 wizard」，但使用者要的是「一目瞭然」。差別在哪？

精靈強迫使用者按順序走 5 步、回頭改 join 要按 N 次返回。三欄工作台讓使用者隨時看到全貌，即使一年沒用，也能 5 秒搞清楚自己現在在哪一步。

**「偶爾使用」的設計直覺應該反過來**——越偶爾用越要一目瞭然，越頻繁用越可以接受被切割的 wizard（因為使用者已經熟）。

### 第三個視覺問題：批次轉換流程

A 單頁式（表單 + 歷史同畫面）、B 左右分欄（新批次 + 即時進度）、C 每 job 獨立頁。使用者選 B。

但這三個不互斥。最終設計是 **B + C 並存**：日常用 B 不離首頁，徽章下拉與分享連結走 C。

### 第四個視覺問題：條件構建器

A inline 展開（推薦）、B 列表 + 側邊細節欄、C 主表 + 彈窗。使用者選 A。

關鍵理由：A 的密度最高、選中態有底色（呼應第一個視覺問題的偏好）、不破壞三欄工作台的版面平衡。

---

## 第五輪：「批次上傳的單位是什麼？」

四輪 plan 都通過之後，使用者問了一個簡單但 critical 的問題：

> 在「批次轉換」的步驟，若是該專案設定模板包含多個 join table, 當要上傳批次檔時，要如何判斷、設定哪些是關聯用檔案？哪些是須處理的資料來源？

這個提問暴露了前面四輪都沒講清楚的盲點。前面的設計只說「上傳多份來源檔」——但當 config 有 1 個 primary + N 個 lookup 時，這「多份」到底是什麼意思？

三種可能：

- **A**：每組都重新上傳 N+1 份（M 組 = M×(N+1) 份檔案，上傳體驗差）
- **B**：primary 多份 × lookup 共用（M+N 份檔案，貼合「客戶不變、每月不同月份」的場景）
- **C**：lookup 嵌入 config json（資料量大時不可行）

使用者選 B。後端 multipart 結構改為按 alias 分組接收：

```
target_template:           file
sources[<primary_alias>]:  file...    ← ≥ 1 份
sources[<lookup_alias>]:   file       ← 恰好 1 份
sources[<lookup_alias>]:   file
```

驗證：primary ≥ 1（否則 422）、每個 lookup = 1（否則 422）。

UI 變體也提了兩個——「動態 slot」（按 alias 展開專屬上傳區）vs「拖一堆 + 自動比對」（fuzzy match 檔名）。使用者選動態 slot：

```
新批次（config: ACME 月報）
┌─────────────────────────────────────────────┐
│ 🎯 目標範本                  ⬆ target.xlsx │
│                                                       │
│ 📥 orders.xlsx (primary)  ← 可多檔，每檔一個輸出      │
│   ⬆ [拖拉 N 份來源檔]                                │
│                                                       │
│ 📎 customers.xlsx (lookup) ← 單檔，所有 primary 共用  │
│   ⬆ customers_2025.xlsx ✓                             │
│                                                       │
│      [開始轉換 → 將產出 N 份輸出]                    │
└─────────────────────────────────────────────┘
```

**這一輪的關鍵收穫**：當 config schema 有 `role` 欄位時，UI 應該**消費**這個欄位來展開不同的上傳行為——前四輪只把 role 當「join 識別用」，沒意識到它也直接影響 BatchRunner 的上傳邏輯。Schema 與 UI 是雙向綁定，不是單向。

## 第六輪：端到端盲點掃描

五輪後，使用者問了一個刻意「不指定問題」的問題：

> 在詳細檢查從開始建立到設定到批次轉換到輸出下載，這整個流程是否還有盲點？

這次不是針對某個功能的反問，是要求系統性盤點。掃完整個流程找出 15 個盲點，按階段分類：

**階段 1：上傳範本**
- Sheet 選擇：xlsx 多 sheet 時沒有 UI 選哪個
- Header row 自訂：ERP 報表 title 區常拉到 1x、2x 列；預設 `header_row=1` 會錯
- 預覽：使用者沒看到內容就盲設

**階段 2：建立 config**
- name 驗證 pattern + 下載檔名 slug
- 編輯既有 config：UI 沒設計如何「載入修改」
- Draft 草稿：填到一半關掉就丟
- 儲存失敗 fallback

**階段 3：批次上傳**
- Preflight 驗證：壞檔等到 worker 才發現浪費資源
- 同名 primary 衝突
- 取消執行中的 job：沒有取消按鈕

**階段 4：進度與輸出**
- ETA 預估：50 份檔沒時間感
- 部分失敗：5 中失敗 1，要不要拿到成功 4
- ZIP 內檔名規則沒明寫
- 大 ZIP 下載中斷：BackgroundTask 立即刪檔，重試取不到

**階段 5：系統面**
- Cron 清掃機制：沒明確是 docker cron / RQ scheduler / 內建

每個盲點都收斂出決策，重要的有三個：

**Sheet/Header 預覽**：上傳後 `/api/templates/parse` 回傳 30 列預覽，使用者點任一列設為 header_row。一開始想用「前 5 列」，使用者立刻指出「ERP 常拉到 1x、2x 列」——又一次預設值不貼地的盲點。

**Preflight 驗證**：在 enqueue 前同步開檔驗證 sheet 名 + header 欄位齊全，任一不符 422 with 具體訊息。50 份檔 × 100ms = 5s preflight，換來壞檔早期攔截。這是「早幾秒 vs 跑半小時才崩」的權衡，無腦選前者。

**下載 grace period**：使用者明確要求大檔案延長到 1 小時。BackgroundTask 不立即刪，`download_started_at` 起算 1 小時內可重下載 + 支援 HTTP Range。1 小時後 cleanup_service 移除。

還有一個延伸決策：「建立設定」分頁名稱改為「**專案設定**」——因為這個分頁現在同時支援「建立新專案」與「編輯既有專案」兩個動作，「建立」字樣會誤導。命名跟著功能走，這是常被忽略的小事。

**這一輪的關鍵收穫**：**不要等到使用者反問才掃盲點**。五輪都已通過、文件已成體系，但仍有 15 個盲點。如果這份系統不是「四輪後使用者主動要求盤點」，這些盲點會留到實作階段才浮現。最便宜的盲點掃描是「假設使用者不問，自己主動跑一遍流程」。

## 第七輪：實作中的修正——unit test 全綠也救不了的 race

六輪設計完、實作完成、後端 117 個 unit test 全綠。準備跑 §8 端到端 smoke test 做最後驗證——馬上抓到三個併發 bug，每一個都是 unit test 摸不到、設計階段沒預想到的。

**Bug A · `finalize_job` race**：job 建立時把 N 個 subtask + 一個 `finalize_job` 都 enqueue 進 RQ。意圖是 RQ 依序執行；但實際多 worker 並行 pop，`finalize_job` 在 subtasks 還沒跑完前就被執行了——它看 `terminal=0/N` 就 `finalize.early` 跳過，再無人觸發。結果：每個 subtask 都成功寫出 `out/xxx.out.xlsx`，但永遠沒打包 ZIP。

**Bug B · `state.json` 並行寫競爭**：4 個 worker 處理兄弟 subtask 時各自 read-modify-write 同一個 JSON 檔，最後寫贏的覆蓋了其他更新。`snapshot.done=2/3` 但實際 `out/` 目錄裡有 3 份 xlsx。

**Bug C · RQ worker name collision**：`docker compose restart worker` 後新 process 起不來：「ValueError: There exists an active worker named 'worker-0' already」。Redis 還記得舊的、新的同名 worker 被拒絕註冊。

修法都不長：

```python
# Bug A: 最後完成的 subtask 自己再 enqueue finalize
is_last = job_svc.mark_done(job_id, source_file, duration_ms)
if is_last:
    enqueue_finalize(make_queue(redis), job_id)

# Bug B: read-modify-write 包進 fcntl.flock
@contextlib.contextmanager
def _locked_state(self, job_id):
    with open(lock_path, "w") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX)
        yield self._read_state(job_id)

# Bug C: worker name 唯一化
name = f"worker-{worker_id}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
```

修完跑 smoke test → 全綠 / 跑 unit test → 117 仍綠。

**這一輪的關鍵收穫**：**unit test 不是「驗證」，是「固化」**。它確保 core 純函式對不對；它無法告訴你三個併發 worker 寫同一檔案會壞。`docker compose up + smoke test` 才能。設計階段就該識別「unit test 摸不到的點」（檔案併發、queue 排序、process 命名衝突）並寫對應 integration smoke，而不是等實作完才補。

除了 race 之外，實作 + 手動測試還抓到 4 個小型 UI / 行為偏差（詳見 `decisions_log.md` #18–#21）：
- 錯誤訊息把所有 zod issue 都歸咎 name → 改顯示真實 path
- 上傳目標範本後右欄 mapping 沒自動帶 → `mergeMappingsWithColumns`
- 右欄手動加新欄位輸出沒這欄 → mapper / writer / toConfig 三處都修
- 載入既有 config 後下拉空白 → 從 joins/mappings 推回 sources.columns

這些都是「unit test 全程沒事、人類一用就翻車」的問題。把它們一起列在這裡，不是為了懺悔，是為了下次設計時提早識別「unit 摸不到的劇本」。

## 可觀察的「設計主張」

從這四輪對話，可導出十二個 verification 場景。每個場景對應一個明確的設計主張，下面挑五個展示「主張 → 可驗證」這條鏈：

### 主張 1：Redis 是快取，檔案是真相

**驗證**：刪除 Redis volume（保留 `/data/jobs/`）後啟動 → worker 從 `state.json` 重建狀態並完成剩餘 subtask。

**設計依據**：[`decisions_log.md`](decisions_log.md) 第 3 條（Redis-only → Redis AOF + 檔案雙寫）。如果 Redis 是真相，這個測試會失敗（重建不出來）。如果只是備援，這個測試會通過。

### 主張 2：Subtask 級續傳，不重做完成的工作

**驗證**：跑 10 份來源批次，第 5 份處理中 `docker compose restart worker` → 重啟後從第 5 份繼續，前 4 份不重做。

**設計依據**：[`decisions_log.md`](decisions_log.md) 第 4 條。Subtask idempotent 的關鍵是 worker 啟動時先檢查 `out/{source}.out.xlsx` 是否存在，存在則跳過。

### 主張 3：進度在斷線/關頁/重啟後仍可找回

**驗證**：啟動批次後關閉分頁 → 重開站 → TopMenuBar 徽章顯示進行中數。

**設計依據**：[`decisions_log.md`](decisions_log.md) 第 5 條。三個機制疊加：穩定 URL（/jobs/:id）、localStorage（recent jobs）、SSE 重連 snapshot。

### 主張 4：錯誤訊息可被使用者與工程師同時利用

**驗證**：上傳壞 xlsx → 422 含 `request_id` → `docker compose logs api | grep <request_id>` 找回完整 traceback。

**設計依據**：[`decisions_log.md`](decisions_log.md) 第 6 條。使用者拿到的是友善訊息與 ID；工程師拿到的是 ID 找回的完整 traceback。兩端不混在一個欄位。

### 主張 5：下載成功 = 完整清理

**驗證**：完成 ZIP 下載後檢查 `/data/jobs/{id}/` 已被完整刪除（含 uploads、out、state.json、result.zip）。

**設計依據**：使用者在第二輪結尾的補充。沒有這個清理，長久下來資料夾會無限膨脹。

---

## 這個設計過程證明了什麼

本設計還沒程式碼，能證明的只有過程：

### 1. Plan mode 通過 ≠ 設計定案

四輪 plan 全部「通過」過，但每一次通過後使用者都補了東西或改了決定：

- 第一輪通過 → 「sidebar 改 TopMenuBar」
- 第二輪通過 → 「下載成功後要刪 uploads/ 與 out/」
- 第三輪通過 → 「開發路徑指定 sideProjects/excelTemplateParser/」
- 第四輪通過 → 「decisions_log.md 不要提及使用者類型」

如果把 plan 通過當終點，這些修正都會落到實作階段才補（成本高得多）。

### 2. 反問是設計工具，不是 challenge

使用者的反問每次都暴露盲點：

- 「Redis 掛了會不會掉？」→ 暴露 docker volume 沒講清楚
- 「服務重啟使用者怎麼看進度？」→ 暴露只有 SSE 不夠
- 「每步加 try/catch 嗎？」→ 暴露我沒主動講邊界式設計

工程師應該主動把這些反問先問自己。

### 3. 視覺溝通的乘數效應

第四輪用 Visual Companion 後，討論顆粒度發生質變。使用者能在 30 秒內看完三個風格做選擇，且能精準指出「A 的哪一點 + C 的哪一點」這種混搭意向。文字描述「灰階留白突出重點」要解釋三段才能達到同樣的精度。

### 4. 「輕量」是一連串有意識的選擇

整個設計反覆做出「不裝什麼」的決定：

- 不用 Postgres（Redis-only）
- 不用 Celery（RQ 就夠）
- 不用 Mantine / AntD（shadcn copy-paste）
- 不引入工作流引擎（state.json + RQ 自己組）

每一個「不」都減少了一個依賴、一份學習成本、一條失敗路徑。輕量不是預設值，是設計成本。

---

## 限制與未走完的路

這份設計**還沒實作**，因此無法回答以下問題：

- **openpyxl 樣式保留的邊界在哪？**樣式包含合併儲存格、條件式格式、樞紐分析表時，能 100% 保留嗎？未實際試過。
- **30MB xlsx 跑 worker pipeline 真的 < 500MB RSS？**現在的估算基於 `read_only=True` 流式讀取，但 pandas DataFrame 全部進記憶體那段沒測過。
- **使用者真的會用三欄式工作台嗎？**Mockup 是好看的；實際操作時可能發現左欄拖拉到右欄太遠、middle pane 太擠。需要 user test。
- **Subtask 級續傳的 race condition** 沒驗證：當 worker 寫完 `out/` 但還沒更新 state.json 時崩潰，再啟動會偵測 `out/` 存在跳過——但 state.json 仍是 `pending`，會否被誤判？需要實作時驗。

這些都是「規格層解了、實作層待驗證」的項目。實作階段會回頭修這份 case_study。

---

## 接下來（Part 1 結尾）

四份文件（`plan.md` / `case_study.md` / `decisions_log.md` / `learnings.md`）寫完後，下一輪 plan mode 應該決定**實作順序**：

1. 後端骨架（FastAPI + Redis + Worker）
2. Core 五件（parser / joiner / mapper / writer / zipper）
3. 前端骨架（shadcn + 路由 + i18n + theme）
4. ConfigBuilder 三欄
5. BatchRunner 左右 + JobDetail
6. 持久化 + 續傳 + 進度可見性整合測試
7. Dark Mode + i18n 補完
8. 跑十二個 verification 場景

不在這份 plan 範圍內：實作 ticket 拆解。那是 `tasks.md` 的工作。

Part 1 在這裡結束。實作完成、跑通 smoke test 後，使用者開始用真實 config 跑批次——那段對話見 Part 2。

---

## 第八輪：上線後使用者實測——六條 corner case 的對話線

設計階段七輪結束於系統能一鍵啟動、smoke test 全綠。但「能跑」與「真實使用者用真實資料能用」之間還有一段距離。使用者匯出真實的 ERP 範本 + 來源檔開始操作——六條 corner case 一條條浮現，每一條都是「實作期假設的典型用法被推到邊界」。

每一條的對話模式跟設計階段的反問同形態：使用者提原始症狀（「右欄[固定值]變成預設了」這類沒包裝過的觀察），工程師讀程式 / log / trace pipeline 找根因、攤開選項、確認修法。差別在於設計階段反問的是「規格寫清楚了沒」，迭代階段反問的是「真實資料推到 corner case 時系統怎麼回應」。

六條的觸發共同點：其中四條（#1、#4、#5、#6）都是「source_cell 這個新 mapping 類型」的延伸效應，把 schema、序列化、preflight、worker 四個獨立層的同步成本攤開。Part 2 同時也展示了「broadcast 規則」這條設計上的演進——第 2 條 broaden、第 6 條 narrow，邊界跟著理解 sharpen。

### 1. 「右欄[固定值]變成預設了」

使用者打開 ConfigBuilder 載入既有 config，每筆 mapping 的右欄都顯示「固定值」按鈕為選中、原本應該是預設的「來源欄位」沒選中。原話就一句、沒包裝。

診斷：trace 序列化往返。後端 pydantic `Mapping.literal: Any = None` 透過 `model_dump_json(indent=2)`（沒 `exclude_none`）寫到 JSON 變 `"literal": null`；前端 zod parse 後 literal 是 null；`MappingRow.tsx:modeOf` 只判 `!== undefined`，null 通過 → 進 literal 模式。

修法：modeOf 同時排除 `undefined` 與 `null`，但保留空字串 `""` 為 literal 模式（剛 toggle 的暫態）。細節見 `decisions_log.md` Part 2 #1。

對話模式觀察：這跟設計第二輪「Redis 掛了會不會掉」性質相同——使用者觀察到了一個「技術正確但體感不對」的點。Redis 那次是因為「我沒講清楚持久化」，這次是因為「pydantic Optional → JSON null → zod optional」的三段轉換沒人主動橋接。**前後端整合處的 null 默契是常見破口**。

### 2. 「轉換失敗：映射來源欄位『primary_sheet4.20260517』不存在」

使用者用「+ 同檔另一 sheet」加了 `primary_sheet4` 取 sheet 2 的單列 metadata（批次日期 20260517），mapping 引用 `primary_sheet4.20260517`，沒寫 join 規則就跑批次。

診斷：讀 `joiner.py`，發現「只有 join 規則裡的 alias 才會被合進結果」——沒連通的 alias 即使被 mapping 引用也會被靜默丟棄。使用者明確點出設計意圖：「那欄不用 join，是固定單欄來源」。

修法：joiner 對未連通 source 走 broadcast——1 列 → 廣播為常數欄；0 / 多列 → 明確錯訊。細節見 `decisions_log.md` Part 2 #2。

對話模式觀察：這次反問跟設計第三輪「每步加 try/catch 嗎」相反——那次是使用者直覺要保險、實際是反模式；這次是系統直覺要報錯、實際是設計意圖。**「未連通的 source」這個狀態既可能是 user error 也可能是合法設計意圖，不該假設成單一解**。

### 3. 「欄位不存在」訊息的精度提升

接續 #2，在 broadcast 修好之前那條錯訊「映射來源欄位『primary_sheet4.20260517』不存在」其實技術上正確——但對使用者完全是誤導：真正缺的是 join 規則，不是欄位。

診斷：`mapper.py:_apply_one` 對 `source not in df.columns` 一律報「欄位不存在」，沒區分「欄位真的拼錯」與「整個 alias 都沒進來」。

修法：報錯前先檢查「該 alias 是否存在於 merged df 的任何欄位」——完全不存在 → 報「來源 X 的欄位未進入合併結果」；alias 在但 col 不在 → 維持原訊息。細節見 `decisions_log.md` Part 2 #3。

對話模式觀察：這是設計階段 Decision #6「邊界式錯誤處理」的延伸——當時定下了「user_message + tech_detail」的格式，但沒講「user_message 怎麼寫才有用」。**錯訊的精確度不在「描述出了什麼」，而在「指出該怎麼修」**。

### 4. 「但這個 cell 不一定有 header，怎麼選？」

使用者要把 sheet 上某個絕對位置的 cell（如 A3）的值整個 output 欄都填這格，但 cell 所在的列可能在 header_row 之上、甚至 sheet 沒有 header——`alias.col` 抽象抓不到。我曾提案「source + 第 N 列」走 df 行索引，使用者立刻點破：「該固定列不一定會有 header」。

診斷：原本兩種 mode（來源欄位 / 固定值）都建立在 parser/header 抽象上，無法處理「跳過 header、直接讀絕對 cell」。

修法：新增 `source_cell { alias, address }` 第三種 mode，用 Excel 絕對位址（A3）跳過 header 抽象。worker 加 `_resolve_source_cells()` 用 `openpyxl.load_workbook(data_only=True, read_only=True)` 開檔（同檔 cache）、讀絕對位址、結果傳給 mapper。mapper 拆三條分支。前端 3-way toggle（藍 / 紫 / 琥珀）。細節見 `decisions_log.md` Part 2 #4。

對話模式觀察：這是 #2 之後使用者把 broadcast 設計推到下一個邊界——「broadcast 只在 1 列時可用，多列怎麼挑特定一格？」這條反問跟設計第六輪「端到端盲點掃描」性質相同——使用者用真實資料推到既有抽象的邊界。**「再加一種 mode」這種 feature 有時其實是揭露「舊抽象覆蓋不全」**。

### 5. 「按下開始轉換 → Internal error」

使用者完成 source_cell mapping 設定、按「開始轉換」。API 直接回 500：`{"error":"Internal error","request_id":"..."}`。

診斷：`docker compose logs api | grep <request_id>`（這次設計第三輪建的「邊界式錯誤處理」立刻派上用場）→ `AttributeError: 'NoneType' object has no attribute 'partition'` at `jobs.py:339`。preflight 預先掃 mappings 收集每個 alias 需要的欄位，假設 `m.source` 一定是字串——literal mapping 其實一直以來都會在這條路徑中招，新加的 source_cell 把這顆雷暴露出來。

修法：抽出 `_collect_required_columns(config)` 純函式，對 `m.source is not None` 才收 column；literal 與 source_cell 都跳過。加單元測試三條。細節見 `decisions_log.md` Part 2 #5。

對話模式觀察：這次的 debug 路徑（user message + request_id → grep log → 看 traceback → 找 bug）完全照設計第三輪定下的邊界式錯誤處理走。**設計階段定的錯誤模型，在上線後第一次被 100% 利用**——當時的設計判斷立刻換成現實價值。

### 6. 「修好了還是失敗：來源『primary_sheet4』沒有資料列」

使用者修好 #5 重跑，又炸了——但這次錯訊看起來明確（「沒有資料列」），實際上仍是誤導：使用者只用 source_cell mode 讀 A3，根本沒指望 df 有資料列。

診斷：worker `_execute` 對 `config.sources` 全部跑 `parser.parse` 進 `sources_dfs`，再丟 joiner。joiner 看 `primary_sheet4` 不在 join 連通圖 → 走 #2 加的 broadcast 分支 → header_row=3 把 sheet 唯一一列吃掉了 → df 0 列 → 報「沒有資料列」。但這個 source 只被 source_cell 引用，根本不該進 df pipeline。

修法：抽 `df_needed_aliases(config)`——source_cell-only alias 跳過 parser.parse；preflight 也用同 helper 跳過。細節見 `decisions_log.md` Part 2 #6。

對話模式觀察：這跟設計第七輪「unit test 全綠也救不了的 race」性質相同——加 feature（source_cell）的 mental model 是「source_cell 走另一條 pipeline」，實作只在 mapper 那條岔開、worker 還是把所有 source 推進 parser 與 joiner。**partial fork 留下的結構性問題，要等真實使用觸發才會浮現**。

### 7. 「點 header_row 那列幾乎看不見」（黑暗模式）

使用者切到黑暗模式上傳 xlsx，SheetHeaderPicker 顯示預覽列表讓他點哪列當 header。點下後該列幾乎不可見、只有 hover 短暫看得到。

診斷：grep 該檔的 `bg-blue-50` className——確認 hardcoded 淺藍背景沒有 dark variant；文字色靠繼承 → dark mode 下變淺色 → 白底白字疊合。專案內 MappingRow 早建立「淺色 + 暗色 + 明文字色」三件套慣例，本檔漏配。

修法：`SheetHeaderPicker.tsx:138` 加 `text-blue-900 dark:bg-blue-900/40 dark:text-blue-100`，淺色背景升一階到 `bg-blue-100`。細節見 `decisions_log.md` Part 2 #7。

對話模式觀察：跟設計 Decision #9「shadcn 為底 + Mantine 風互動回饋、不全套用 UI library」呼應——當時定下了「自訂 theme」的設計方向，本條暴露的是「hardcoded color 滲漏在外」這個執行細節遺漏。**整合處的隱性默契（Tailwind hardcoded color vs theme dark adapt）跟 #1 的 null/undefined 序列化往返是同類問題**。

### 8. 「還原沒效果 / 切走切回又跳 / 載入後 banner 自己消失」——草稿系統的四連環

這一條是同一個會話裡 4 個 sub-bug 接連浮現的完整故事。每修一個、使用者下一個操作模式就揭露下一個。

**8a：「按還原沒效果」**

使用者描述：填部分表單 → reload → banner 出現 → 點還原 → 表單仍是空的。

診斷：trace `restoreDraft` 從哪裡讀。它 `localStorage.getItem(DRAFT_KEY)` 即時撈——但 autosave effect 在 mount tick 也跑、1 秒後把 emptyState 寫回 localStorage。使用者讀完 banner 點下去通常超過 1 秒，撈到的是空草稿。

修法：mount 時把 localStorage 字串快照到 `draftSnapshotRef`；restoreDraft 從 ref 讀。

**8b：「全新使用者也跳出還原提示」**

使用者繼續測：清空 localStorage → reload → 居然又跳出 banner。從沒填過任何東西也跳。

診斷：autosave 沒對「空 state」做判斷，每次 state 變動（含 mount tick）都寫 localStorage → 累積出「空草稿」→ 下次 mount 偵測到 → banner 莫名亮起。

修法 v1：autosave 加 `hasContent` guard——name / target.sheet / sources.length / joins.length / mappings.length 任一非空才視為有內容。

**8c：「捨棄後切走切回又出現，按還原沒效果」**

使用者實測：「按了『捨棄』，切換到『批次轉換』再切回來，來回不到幾次又會出現，按『還原』沒效果，按『捨棄』會清除一下，重複第一步又會回來」。

診斷：8b 的 hasContent 寫錯了——讀 `emptyState()` 才發現它預設帶一個 `primary` source。`state.sources.length > 0` 永遠 true、guard 永遠不觸發；autosave 永遠把「空 state 的 JSON（E）」寫進 localStorage。完整循環：每次 fresh mount 從 ref 撈到 E → 還原把 E 寫進 state → 表單仍空 → 「沒效果」。捨棄清 localStorage，但 1 秒後 autosave 又把 E 寫回去。

修法 v2：改用 JSON 字串比對。`EMPTY_PERSISTABLE_JSON = JSON.stringify(toPersistable(emptyState()))`，autosave 比對當下 state 的 persistable JSON——相等就 removeItem + return。

**8d：「載入設定後 banner 不該自動消失」**

使用者再測：「載入設定、切走切回、跳出 banner、不選擇就再切走切回、依然跳出 banner，直到使用者選擇『捨棄』。主要是需要判斷當頁面沒有載入設定、沒有上傳任何檔案時，就不該觸發 autosave 用空白設定蓋掉正常設定」。

診斷：8c 的 JSON 比對 guard 在「state == empty」時不只跳過寫入、還主動 removeItem。fresh mount 一律從 emptyState 開始，autosave 1 秒後看到 state 是空就把 localStorage 裡的合法 draft 清掉了——使用者的 banner 因此「自己消失」。

修法 v3（正解）：把 removeItem 拿掉，empty state 的 autosave 變純 no-op。`removeItem` 只剩兩個明示路徑（discardDraft / handleSave 成功）。

對話模式觀察（合 8a–d）：這是 Decision #17「unit test 全綠救不了的 race」的完美前端重現——unit 跑 jsdom 同步環境，摸不到「mount tick × state-dep effect × localStorage」這三維交集；只有真實使用者「reload、切走、dwell 5 秒再切回」才會打出來。**且這次需要 4 輪 plan-fix-test 才走到正解**，每輪都是看著當下症狀做合理修法、然後使用者下一個操作模式揭露下一層 bug。修法最穩的是 8d——把「localStorage 變動只跟明示動作有關」立成 invariant，比靠 guard 安全得多。

### 第八輪的關鍵收穫

八條反問依然在驅動設計，但這次驅動的不是 plan、不是 spec、是已上線的程式碼。**設計判斷力（拆鏈條、優先指出怎麼修、不吞錯訊）是同一套，舞台從 plan mode 移到 production**。設計階段練的東西在這裡每一條都用到——只是節奏從「下一輪 plan 該長什麼樣」變成「下一個 patch 該怎麼補既有抽象」。

#8 完整展示「partial fix 揭露下一層」這條設計階段 #17 學過、但前端版本需要 4 輪 plan-fix-test 才走到正解的形態。下次設計階段該主動列「mount-tick × state-dep effect × storage」這類三維交集為高風險區，預先寫 integration smoke。

---

## 迭代階段的可觀察設計主張（補主張 6–7）

Part 1 的五項主張都來自設計階段；迭代階段補兩項：

### 主張 6：新 mapping mode 不破壞既有單元測試

**驗證**：純 source / literal config 跑 backend 100+ 個 unit test（schemas / mapper / joiner / preflight / worker_pipeline）全綠；同一份既有 config 跑批次 → 結果與 source_cell feature 加入前完全一致。

**設計依據**：`decisions_log.md` Part 2 #4。新 mode 是「擴展」而非「重寫」既有抽象——schema 用 Optional 加欄位、mapper 拆出新分支但保留 source/literal 路徑不動。如果這項主張失敗（既有 config 行為變了），表示新 mode 的加法侵蝕了既有抽象——是個強訊號要重新審視。

### 主張 7：source_cell-only source 跳過 df pipeline

**驗證**：設一個 source 的 `header_row=99`（超出 sheet 範圍）但只被 source_cell mapping 引用 → 跑批次成功、output 整欄填正確 cell 值。

**設計依據**：`decisions_log.md` Part 2 #6。`df_needed_aliases(config)` 是這條主張的具體實現——它定義了「哪些 source 真的需要進 df pipeline」，preflight 與 worker 共用同一 helper。如果這項主張失敗（preflight 或 worker 仍對 source_cell-only source 走 parser），表示 fork 不夠徹底——是 #6 修法的回歸測試。

---

## 這個設計過程證明了什麼（補第 5、6 條）

Part 1 的四條提煉都來自設計階段。迭代階段補兩條：

### 5. 上線後是設計的延長線

設計階段定的「source 抽象」在 #4（source_cell）擴張了一次、在 #6（df-needed filtering）才完整。整個過程沒有「設計做完」這個瞬間——抽象隨著使用情境的多樣化持續 sharpen。

這跟 Part 1 「Plan mode 通過 ≠ 設計定案」是同條判斷力的延伸：plan 通過後 plan mode 不結束、上線後設計也不結束。每一次「使用者把真實資料推到 corner case」都會啟動一輪小型的 plan-review-fix。差別在於這時候的 plan 寫在 `~/.claude/plans/` 不寫在 `docs/spec/`，但決策節奏完全相同。

### 6. 「partial fix 揭露下一層」是迭代的常態，不是失敗訊號

#8 連修四次才到位。每一次都是看著當下症狀做合理修法、然後使用者下一個操作模式揭露下一層 bug。這跟設計 Decision #17（race 三連發）同形態——但這次以前端的「mount tick × state-dep effect × localStorage」三維交集形式重現，比後端的「多 worker × 真檔案 × queue 排序」更難在 unit test 環境抓到。

學到的：下次設計階段該主動列「mount-tick × state-dep effect × storage」這類三維交集為高風險區，預先寫 integration smoke。也接受「partial fix 揭露下一層」是迭代常態——不要為了「一次到位」而過早收斂修法；用 invariant（如 8d 的「localStorage 變動只跟明示動作有關」）取代多重 guard，比較能擋住未來的下一層。

---

## 全文回望：兩段對話的模式對比

七輪設計 + 一輪上線後實測（共八輪、第八輪八小節）展示了**反問做為設計工具的兩種形態**：

| 維度 | 設計階段（七輪） | 迭代階段（第八輪八小節） |
|---|---|---|
| 反問來源 | 規格寫清楚了沒 | 真實資料推到 corner case |
| 反問形式 | 「Redis 掛了會不會掉？」「每步加 try/catch 嗎？」 | 「右欄[固定值]變成預設了」「捨棄後切走切回又出現」 |
| 暴露的盲點 | 工程師「沒主動講清楚」 | 工程師「沒主動測 corner case」 |
| 修正成本 | 改 plan / spec（幾分鐘） | 改 schema + 多層程式 + 測試（幾小時，前端 race 可能單條走 4 輪 plan-fix） |
| 對下次的影響 | 下次設計要主動把假設攤開 | 下次設計要列「Integration Test 觸發條件矩陣」、預期 partial fix 揭露下一層 |

但兩階段的底層**判斷力相同**——拆鏈條、優先指出怎麼修、不吞訊號、保留 user_message 與 tech_detail 分流。設計階段練到的功，到迭代階段每一條都用上：

- 設計 Decision #6「邊界式錯誤處理」→ 迭代 #5 用 request_id 在 log grep 找 bug
- 設計 Decision #9「shadcn 為底自訂 theme」→ 迭代 #7 暴露 hardcoded color 沒走 theme 的執行細節遺漏
- 設計 Decision #15「Preflight 早期攔截」→ 迭代 #5 #6 都在 preflight 那層處理 corner case
- 設計 Decision #17「Integration smoke 才現形」→ 迭代 #1 #6 #8 都是「unit test 全綠但 user 一用翻車」的延伸案例；#8 完整重現於前端，且需要 4 輪才到位
- 設計 Learnings #2「使用者反問是設計工具」→ 迭代 #1–#8 每條都驗證了同條原則

也有迭代階段才浮現的判斷力——「broaden 與 narrow 並進」（broadcast 規則的演進、#8 autosave 行為的四輪修正）與「partial fork 留下結構性問題」（source_cell pipeline 切不乾淨、#8 的 localStorage 變動路徑沒收斂）。這兩條設計階段不容易預想，但下次設計新 mode / 新自動行為時可以直接套用。

**好的設計不是寫出來的，是談出來的——而且這段「談」沒有終點。** 設計階段七輪結束於 plan 通過、實作完成、smoke test 全綠。Part 2 的八條補丁顯示：完成的不是設計，是當下這個版本的設計。每一個下一個使用者的 corner case，都是下一輪「談」的起點。
