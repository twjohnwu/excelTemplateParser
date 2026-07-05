# excelTemplateParser 設計與迭代總紀錄

這份檔案橫跨三條時間線：

- **設計階段（22 條）**：系統還沒實作前，四輪 plan mode brainstorming 中的轉折——每一輪 plan 都「通過後又被修正」，這些修正是這部分的主要素材。
- **迭代階段（9 條）**：系統上線後，使用者實際用真實 config 跑批次與 UI 操作揭露的盲點——每一條都是「實作期未預想的 corner case」被推到生產才暴露。
- **UX 改版階段（6 條，2026-07-04〜05）**：以「非技術者能自己建 config」為目標的三期改版（三角色審議定案）＋上線後四輪快速修正——設計判斷與迭代踩坑在同一週期內交錯出現。

兩條弧合在一起，才完整呈現一個系統從「一句需求 → 規格 → 上線 → 真實使用」的全程。如果只看設計階段，會誤以為設計判斷的價值止於批准；如果只看迭代階段，會看不到背後的設計累積。把兩份合一是為了讓讀者一次看完整段歷程。

寫這份的動機：規格與 plan 只呈現最終答案，但**設計判斷力的展現**藏在「為什麼這樣設計而不是那樣」——不論是設計階段的轉折，還是上線後的修正。對作品集而言，過程比結論更稀有。

兩部分以分隔線區隔。Part 1 用「最初想法 / 為什麼錯 / 現在做法 / 學到什麼」四段格式；Part 2 改為「使用者觸發 / 症狀 / 根因 / 修法 / 學到什麼」五段，更貼合 post-launch issue 的敘事。

---

## 第一部分：設計階段——22 條 brainstorming 轉折

設計過程跨越四輪 plan mode（brainstorming 模式），每一輪都有「plan 通過後又被修正」的事件——這些修正本身就是這部分的主要素材。後 6 條（#17–22）已經跨進實作觀察，是設計→實作的過渡期記錄。

---

## 1. 主導航：Sidebar → TopMenuBar

**最初想法**：使用者初始需求明寫 Sidebar，兩個分頁「建立專案設定 / 批次轉換」放左側。Sidebar 是 admin/dashboard 類產品的標準佈局，看起來無腦選。

**為什麼錯**：Sidebar 對 3+ 分頁才有意義。本系統只有兩個主分頁，左側欄會佔掉 200–240px 寬度卻只放兩個 icon，純粹的視覺浪費。更糟的是，當主功能是「三欄式工作台 ConfigBuilder」時，再被 Sidebar 吃掉一欄，水平空間根本不夠用。

**現在做法**：TopMenuBar，水平排列兩個分頁，把 1280px 寬度全留給內容。徽章（進行中作業數）、語言切換、主題切換放右側。Sidebar 模式留給未來分頁 ≥ 4 時再考慮。

**學到什麼**：**佈局決策應該配合內容密度，不是套產品類型的模板**。「admin dashboard 用 Sidebar」這種類型化的直覺會在內容窄的場景下浪費空間。這條決策發生在第一輪 plan 通過後使用者補的一句話「sidebar -> TopMenuBar」——七個字推翻一個經過完整 brainstorming 的決策，提醒「plan 通過 ≠ 終點」。

---

## 2. 儲存層：Postgres → Redis-only

**最初想法**：先 Postgres 作為主要儲存（config metadata + job 狀態），Redis 只跑 RQ。理由是「以後可能要加多租戶/權限/稽核」，先把基礎打對。重用既有 local-postgres 容器，省一個服務。

**為什麼錯**：「以後可能要」是常見的過度設計藉口。當下用例的資料量極小（每個 config json 5–20KB、job metadata 約 1KB），查詢模式單純（全是 by-key），完全是 KV 的甜蜜點。Postgres 帶來 SQL schema migration、ORM 配置、連線池調校、JSON 欄位 vs jsonb vs separate column 的選擇成本。每一項都是「以後可能用到」的設計成本，當下都不需要。

**現在做法**：Redis-only，同時跑 RQ + config/job 儲存。AOF `everysec` 持久化、Docker volume 掛載，足夠應付主要場景。Postgres 留作 scaling trigger（config > 10,000 / 需要跨 config 查詢 / 多租戶等）才升級。

**學到什麼**：**「以後可能要」是一張無上限的支票，要謹慎簽**。當下沒場景就不要先付成本。把「以後需要時的遷移路徑」寫在規格的 Scaling Triggers 段落，比現在多裝 Postgres 更便宜。也學到一個反直覺的點：**反覆問「不用 X 會怎樣」比問「用 X 有什麼好處」更能找到當下的甜蜜點**。

---

## 3. Redis-only 補強：AOF 之外加檔案雙寫

**最初想法**：Redis AOF + Docker volume 就夠了。AOF `everysec` 最多丟 1 秒資料，足以應付任何「使用者剛存 config 還沒下載」的 corner case。

**為什麼錯**：技術上正確不代表使用者能安心。使用者實際問：「若故障導致 docker down, redis 內的資料也會隨之消失吧？這樣 job 也會清空不是？哪來的 job 驗證現有資料夾進度？」這句反問暴露了我前一輪沒把「Redis 是 in-memory 但持久化到 docker volume」這個概念講清楚。從使用者視角，「Redis-only」聽起來像「都靠記憶體」，要承擔「服務一掛就掉」的恐懼。

**現在做法**：Redis 變成快取，`/data/` 變成真相來源。config 雙寫到 `/data/configs/{name}.json`；job 狀態雙寫到 `/data/jobs/{id}/state.json`。Worker 啟動時優先掃 `state.json` 還原狀態，即使 Redis volume 整個損壞，只要 `/data/jobs/` 還在就能續傳。新增 `DATA_DIR` 環境變數允許使用者掛到 NAS / 外接硬碟。

**學到什麼**：**「技術上夠」與「使用者敢用」是兩件事**。第二層持久化的工程成本不高（雙寫 + 一個 recovery_service），但帶來的信心感差很多。也學到：**使用者的反問是設計工具**——它指出工程師假設了使用者懂、但其實沒講清楚的部分。

---

## 4. 故障策略：「中斷只能從頭」→ Subtask 級續傳

**最初想法**：Job 是不可分割單位，失敗就 RQ retry 整個 job。簡單、KISS、不破壞流程線性。

**為什麼錯**：當批次包含 N 份來源檔（典型情境 5–50 份）時，retry 整個 job 等於前面成功的 K 份白做。Worker 在處理第 8/10 份崩潰，重啟後從第 1 份重來——前 7 份已寫的 `out/xxx.xlsx` 被覆蓋，等於浪費了 7 倍的計算成本。對「跑大量批次」的核心場景而言，這是不可接受的退化。

**現在做法**：以 source file 為單位拆 subtask。每份 source 一個 RQ task，完成後寫 `out/{source}.out.xlsx`、更新 `state.json` 標記 `done`、SADD 到 Redis。Worker 處理時若 `out/{source}.out.xlsx` 已存在則跳過（idempotent）。所有 subtask 完成才打包 ZIP。

**學到什麼**：**批次任務的單位拆解是設計問題不是實作問題**。如果單位是 job，續傳語意是「重來」；如果單位是 subtask，續傳語意是「跳過」。後者保留了已完成的工作。也學到 KISS 不等於「不拆」——拆到正確的粒度才是 KISS，硬撐單位反而是另一種過度簡化。

---

## 5. 進度可見性：SSE → 穩定 URL + localStorage + SSE 重連 snapshot

**最初想法**：批次轉換的進度用 SSE 推送，前端訂閱即可。SSE 是單向 server push，瀏覽器原生支援，比 WebSocket 簡單。

**為什麼錯**：SSE 解決了「使用者在頁面上時的進度更新」，但完全沒解決：
- 使用者關閉分頁後再開站——SSE 重新訂閱只看到未來事件，看不到已發生的進度
- 服務重啟導致 SSE 斷線——前端會看到 connection error，進度條歸零
- 使用者想直接打開某個 job 的 URL（從同事傳的連結）——SSE 沒有 "current state" 的概念

使用者實際問：「當服務重啟，job 續傳檔案時，使用者要如何知道目前進度？」這句話直指 SSE 模型的缺陷——它是 push 不是 query，但使用者需要的是「任何時候都能查」。

**現在做法**：四層機制疊加：
1. 穩定 SPA route `/jobs/{id}`，打開時先 `GET /api/jobs/{id}` 拿完整快照，再訂閱 SSE 接續增量
2. localStorage 保存 recentJobs，開站時批次查 `GET /api/jobs?ids=...`
3. TopMenuBar 進行中徽章 + 下拉清單，點擊跳 `/jobs/{id}`
4. SSE 重連時 server 第一個事件 = 完整 snapshot（不只是增量）

**學到什麼**：**Push-only 通訊模型對「不在線」的使用者無解**。任何需要使用者重訪的資訊都要有一個「query 當前狀態」的 endpoint，SSE/WebSocket 只是錦上添花。也學到：**穩定 URL 是 dashboard 類產品的基本功**——可分享、可書籤、可重訪。SPA route + snapshot endpoint 是極低成本的 baseline。

---

## 6. 錯誤處理：「每步加 try/catch」反模式 → 邊界式錯誤處理

**最初想法**：使用者直覺地問：「設計越來越完善也更複雜了，是否要在每個步驟加入 try/catch 以便回傳錯誤訊息，更好的除錯訊息」。從表面看合理——複雜系統需要保險。

**為什麼錯**：每步 try/catch 是看起來保險、實際是地雷的反模式。問題有四：
- 吞 stack trace：原本 traceback 直指 mapper 第 47 行某個 KeyError，被 catch + log 後只剩一行訊息
- 誘發靜默失敗：函式回傳 None / 空 DataFrame 讓下游錯誤被推遲、最終以更詭異形式爆出
- 無法區分「預期錯誤」與「未預期 bug」：所有 Exception 一視同仁，bug 被當成資料問題吞掉
- 與 KISS 衝突：每個函式變成 50% 是 error handling、50% 是邏輯，可讀性砍半

**現在做法**：邊界式錯誤處理。Core 層只 raise（用自訂例外類別表達預期錯誤：`ConfigError, JoinKeyMissing, MappingError, RegexTimeout, WriterError, TemplateInvalid`，都帶 `user_message` + `tech_detail`）。Worker 邊界一個 try/except 抓所有例外 → 寫 `state.json` + 結構化 log → re-raise 讓 RQ 知道失敗。API 邊界用 FastAPI exception handler：自訂例外 → 4xx + 結構化 JSON；未預期例外 → 500 + request_id（細節進 log）。配合 `structlog` JSON 一行一事件、request_id 中介層，使用者回報 bug 時可 `docker compose logs api | grep <request_id>` 秒查。

**學到什麼**：**保險動作未必保險**。Try/catch 在錯誤的層級會吞訊號。正確的做法是讓例外往上拋到「有上下文可處理」的邊界（worker subtask、API request），在那裡集中處理。也學到：**使用者的直覺要被認真對待，但不一定要被執行**——直接照他的直覺做反而會把系統做壞。應該說清楚為什麼錯，提供更好的解法，讓使用者改變立場。

---

## 7. ConfigBuilder 佈局：步驟式精靈 → 三欄式工作台

**最初想法**：建立設定是低頻、需謹慎的操作（一個專案只設一次，之後重複使用 json）。低頻場景的工程直覺是「強引導 wizard」——5 個步驟線性走（命名 → 上傳目標 → 上傳來源 → Join → 映射），不會漏填、不會搞錯順序。

**為什麼錯**：低頻操作配 wizard 的直覺是錯的，且錯得反直覺。使用者明確指出：「我覺得 C（三欄式工作台）的設計很好，一目瞭然」。差別在哪？wizard 強迫線性走、回頭改 join 要按 N 次返回；三欄工作台讓使用者隨時看到全貌。對「一年才用一次」的場景，**一目瞭然遠比強引導重要**——使用者不會記得每一步在哪、什麼順序，但能 5 秒看懂三欄的版面，立刻找到自己要修哪裡。

精靈的「不會漏填」價值，對「沒幾次經驗的人」是價值；對「偶爾用一次但已用過幾次的人」是阻礙。

**現在做法**：三欄式工作台。左欄：來源檔樹（含目標範本），可展開看欄位、可拖拉到右欄。中欄：Join 規則卡片，可串多階層。右欄：映射列表（inline 展開條件 + 預設值）。所有資訊同畫面、所見即所得。配合 shadcn 灰階留白風格，三欄都看得清楚不擁擠。

**學到什麼**：**低頻 ≠ 需要強引導**。低頻意味著使用者不熟、需要 UI 自己解釋自己，而不是被切割成步驟一片片餵。**「一目瞭然」是低頻使用者真正的需求**，而工程師很容易把「低頻」翻譯成「新手」進而推導出 wizard，這條翻譯鏈是錯的。也學到：**讓使用者直接看 mockup 比抽象描述快 10 倍**——第一次他選 wizard，看到三欄圖後立刻改主意，這種翻轉用文字描述很難達到。

---

## 8. BatchRunner 佈局：左右分欄（新批次表單 + 即時進度）

**最初想法**：批次轉換是高頻操作，最簡的方法是單頁式：上方表單、下方歷史。一個畫面解決，操作最少。

**為什麼錯**：單頁式在「使用者剛送出新批次、想立刻看進度」的場景下要求滑動或切換 tab。當使用者連續送 3 個批次（典型情境），他要在「填表單 → 滾下去看進度 → 滾回去填下一個 → 滾下去看進度」之間來回，每次滾動都是視覺中斷。

**現在做法**：左右分欄。左欄：新批次表單（config 下拉、上傳區、開始按鈕），送出後表單清空可立刻填下一個。右欄：所有作業即時狀態（subtask 級進度條），SSE 自動更新。完成的可直接點下載；失敗的可重試或進詳情頁。同時保留 `/jobs/:id` 作為可分享 URL，從 TopMenuBar 徽章下拉跳轉。

**學到什麼**：**高頻操作的設計重點是「不中斷」**。每一個視覺切換、頁面捲動都是中斷。左右分欄讓「填表單」與「看進度」共存，使用者不必選一個犧牲另一個。也學到：**多種佈局可以並存**——B（左右分欄）是首頁，C（每 job 獨立頁 `/jobs/:id`）是分享連結與深度檢視。不是非此即彼。

---

## 9. UI Library：Mantine / AntD → shadcn 為底 + Mantine 風互動回饋

**最初想法**：找一個 UI library 全套用。Mantine（友善、圓角、卡片陰影）或 Ant Design（密度高、ERP 後台熟悉感）都是合理選擇，套件成熟、社群大。

**為什麼錯**：套件成熟意味著它有自己的設計系統與審美。Mantine 的圓角柔色適合 SaaS dashboard，但與「shadcn 風灰階留白突出重要區塊」的偏好衝突。Ant Design 的深色 header 與密度感太「企業後台」，與輕量工具的氣質不符。直接全套用任一個，等於把自己的設計品味交出去。

使用者實際的偏好混搭：「A（shadcn）的灰階留白可以凸顯重要區塊；C（Mantine）親和的操作介面且選擇後的項目有底色提示」。要的是兩者的優點，不是任一者全部。

**現在做法**：shadcn/ui 為底（copy-paste 元件、Radix primitives、Tailwind 客製）。在這個底上加 Mantine 風互動回饋：軟陰影（`shadow-sm`）、選中態 `bg-blue-50` 高亮、上傳區 dashed border + 柔色 hover。自訂 `theme/tokens.css` 用 CSS 變數做 light/dark 切換。

**學到什麼**：**全套 UI library 是設計品味的外包**。當系統有明確視覺主張時，應該選一個低層級基礎（shadcn 或自製）並客製，而不是套一個既有審美。也學到：**選 shadcn 的真正理由不是「現代」，是「能控制」**——它是 copy-paste 不是 npm package，要改哪個元件直接改，不被框架限制。

---

## 10. 條件構建器：彈窗編輯 → Inline 展開 + 三色 chip

**最初想法**：欄位映射的條件設定用彈窗（modal）。主表只顯示「目標 ← 來源」摘要，點 ⚙ 開彈窗編輯條件與預設值。modal 給編輯區足夠大、視覺最乾淨。

**為什麼錯**：modal 的代價是「每次編輯都要中斷視覺」。對 5–10 個目標欄位、每個都要設條件的場景，使用者要連續開關 modal 10 次。每次 modal 開啟，背景被遮蓋、上下文消失。最差的是無法在編輯欄位 A 時看到欄位 B 的設定作參考——而這恰恰是設定條件時很需要的（「我這個欄位是不是跟前面那個一樣的邏輯？」）。

**現在做法**：Inline 展開。每個目標欄位一行；點擊某行展開「條件 chip 串 + 預設值編輯」，其他行保持收合但仍可見。條件用三色 chip 表達：欄位 `bg-yellow-100` / 運算子 `bg-gray-200` / 值 `bg-blue-100`。點 chip 直接編輯（欄位/運算子下拉、值用 input）。「+ 條件」按鈕在 chip 串尾端。

**學到什麼**：**Modal 是「重編輯」的解，inline 是「輕修改」的解**。當主要動作是反覆微調而不是一次性大量輸入時，inline 永遠贏。也學到：**色彩編碼可以替代結構分隔**——三個 chip 不需要 label「欄位/運算子/值」，顏色一看就懂，視覺密度遠勝於 form layout。

---

## 11. Wizard 的錯誤理由 vs 正確理由

**最初想法**：當得知主要使用情境是低頻、固定客戶來源（ERP/SAP 等格式）、設定一次重複使用——直覺鏈條：「低頻 → 新手 → wizard 安全」。這條鏈條看似合理。

**為什麼錯**：低頻 ≠ 新手。低頻使用者可能是已經用過幾次但隔了三個月才再用一次的人——他們不是「不知道怎麼做」的新手，是「忘記了流程在哪一步」的回鍋使用者。對這種人，wizard 把流程切成 5 步、隱藏其他步驟，反而讓「我記得 join 設定在哪？喔要按下一步下一步」變成額外阻礙。

正確的設計判斷應該是：使用者**會不會記得「整個流程的形狀」**？如果不會，UI 要把形狀整個攤開（三欄工作台）；如果會，可以切割（wizard）。低頻+回鍋使用者屬於前者。

**現在做法**：明確採用三欄式工作台，並在 plan 與 spec 中註記：「設計依據是『一目瞭然優於強引導』」。不允許實作時退回 wizard 形式，即使覺得「對新手會比較友善」——本系統的主要場景不是新手。

**學到什麼**：**直覺鏈條（低頻 → 新手 → wizard）要被拆開檢驗每一段**。每一段都有可能是錯的。在這個案例，第一段（低頻 = 新手）就錯了。設計判斷的成熟度展現在「能拆開檢驗自己的直覺」，不是「直覺準」。也學到：**plan 通過的設計也要被質疑**——這條決定是 plan 通過後使用者主動修正才出現的（先選 B 後改 C），如果工程師當下「使用者已批准 B」就停止思考，這個正確答案就不會出現。

---

## 12. Out of Scope 的紀律：明確排除使用者帳號 / 公式重算 / 雲端部署

**最初想法**：設計階段「先寫 in scope，out of scope 之後想」。先把要做的列清楚，不要做的事還早。

**為什麼錯**：「之後想」實際上等於「永遠不寫」，然後實作時模糊地帶被偷偷實作。當「帳號系統」沒明寫排除，未來某個 PR 加入「先做個簡單登入」很容易過——理由是「反正設計沒說不能加」。當「公式重算」沒明寫排除，實作時看到 openpyxl 預設不重算可能會被覺得「是 bug」加上 workaround。Out of Scope 是設計階段就該寫的紀律，不是事後補充。

**現在做法**：plan / proposal / spec 三份都明寫 Out of Scope：
- 使用者帳號 / 多租戶 / 權限
- Excel 公式重算
- 雲端部署 / CI/CD
- 範本版本控制（覆蓋同名專案即直接覆蓋，UI 上會二次確認）

未來任何加入這四項任一的 PR，要先說明為何要打破 scope。

**學到什麼**：**Scope 邊界寫進規格比寫進腦袋可靠**。腦袋會被「這個小功能順手加一下」打敗，規格不會（除非顯式修改）。更進一步的紀律是把規則寫進機械化機制（如 lint test）比寫進文件可靠——本系統還沒有 CI 機制可以鎖 scope，至少先寫在三份文件裡形成多重備份。

---

## 13. 批次上傳的單位：primary 多檔 × lookup 共用

**最初想法**：BatchRunner 的描述是「上傳目標範本 + 多份來源檔」。前四輪 plan 都這樣寫，看起來夠用。

**為什麼錯**：當 config 含多個 sources（1 primary + N lookup），這個描述完全沒講清楚實際上傳的單位。使用者反問：「若是該專案設定模板包含多個 join table, 當要上傳批次檔時，要如何判斷、設定哪些是關聯用檔案？哪些是須處理的資料來源？」三種可能解：(A) 每組都重新上傳 N+1 份；(B) primary 多份 × lookup 共用；(C) lookup 嵌入 config json。前四輪 plan 對哪一個是真正語意完全沒交代。

更深的問題：config schema 早有 `role: primary | lookup` 欄位，但前面只把它當「join 識別用」。沒意識到這個欄位**也直接影響 BatchRunner 的上傳邏輯**——primary 是要被批次處理的單位、lookup 是 master data。

**現在做法**：採用方案 B。
- API：`POST /api/jobs` multipart 改用 `sources[<alias>]` 分組接收，primary 多檔、lookup 單檔
- 驗證：primary ≥ 1（否則 422）、每個 lookup 恰好 1（否則 422）
- 落地：`/data/jobs/{id}/uploads/{target.xlsx, primary/*, lookup/*}`
- Subtask 拆分以 primary 檔名為單位；lookups 在 job 內**只讀共用**
- UI：BatchRunner 依 schema 動態展開 slot（每個 alias 一個專屬上傳區）。Primary slot 可多檔、lookup slot 單檔，視覺上區隔。

**學到什麼**：**Schema 欄位的責任要全面盤點**。同一個 `role` 欄位影響 (1) ConfigBuilder 的 join 設定 (2) BatchRunner 的上傳行為 (3) Worker 的 subtask 拆分 (4) Recovery 時的 lookup 共用語意——四個地方都要消費它。前四輪只看到 (1)，剩下三個被忽略。設計檢視時應該對每個 schema 欄位問：「這個欄位會被哪些地方消費？哪些行為依賴它？」如果只想到一處，通常代表還沒想完。

也學到：**「多份來源檔」是個含糊的詞**。當資料模型有角色區分（primary vs lookup），UI 語言也應該帶角色。把所有 source 都叫「來源檔」會讓使用者必須猜哪份是哪份。動態 slot 把 schema 翻譯成 UI 上的明確區隔，是這個盲點的對症解法。

---

## 14. 上傳預覽：sheet 選擇 + header 點選

**最初想法**：上傳 xlsx 後直接依預設（第一個 sheet、`header_row=1`）解析標頭。簡單。

**為什麼錯**：ERP 報表幾乎都有「title rows」——前 1–3 列是公司 logo、報表日期、查詢條件等 metadata；真正標頭可能在第 4、6、甚至 1x、2x 列。`header_row=1` 直接抓到「報表日期：2025/05」當欄位名。多 sheet 工作簿也常見（如「訂單」「明細」「彙總」三個 sheet），無 UI 選 → 預設第一個 sheet 不一定對。

第一次提預覽方案時想「前 5 列」，使用者立刻指出「header 可能在第 1x、2x 列」——這也是個預設值不貼地的盲點。

**現在做法**：上傳後 `/api/templates/parse` 回傳每個 sheet 的前 30 列預覽。UI 顯示可捲動表格，左側標註列號；使用者點任一列 → 設為 `header_row`，標頭即時更新。多 sheet 時用下拉先選 sheet。30 列仍不夠時提供「載入更多 30 列」延伸載入。

**學到什麼**：**預設值要貼合領域真實情境，不能套通用模板**。「第一列是標頭」對乾淨 CSV 成立、對 ERP 報表常常不成立。設計帶有 UI 互動的預設行為時，應該先想「最差案例長怎樣」、確保預設能涵蓋。也學到：**讓使用者用「指認」代替「輸入」**——「點哪列當 header」遠比「請輸入 header_row 列號」直觀，前者連目盲打字的人都能做對。

---

## 15. Preflight 驗證 vs 等到 worker 才發現

**最初想法**：API `POST /api/jobs` 只做檔案大小 + magic bytes 檢查，深度驗證（sheet 存在、欄位齊全）留給 worker。理由是「KISS、不要在 API 層做太多」。

**為什麼錯**：worker 才發現的代價：
- 使用者送出後等 30 秒，前 3 個 subtask 都跑了，第 4 個發現缺欄位 → `JoinKeyMissing`
- UI 上看到 3 成功 1 失敗，但使用者不知道是「自己上傳錯」還是「程式 bug」
- 已寫的 3 個 `out/*.xlsx` 加上失敗 metadata 全在磁碟上
- 使用者修檔後要重來，前 3 份還在原 job，可重試或棄置——多一個決策點

「API 層不該做太多」是對的原則，但「fail-fast 驗證」屬於**邊界職責**，不是 worker 的工作。

**現在做法**：API 在 enqueue 前同步對每份檔開 `read_only=True` 驗證：(1) sheet 名存在 (2) header_row 列含所有 config 引用的欄位。任一不符 → 422 + 「哪份檔、哪個 sheet、缺哪個欄位」。50 份檔約 5s preflight。通過才落地 + enqueue。

**學到什麼**：**「KISS」不等於「越少做越好」**。把可預期的失敗從 worker（不可預期錯誤的處理場）移到 API（同步驗證的處理場），讓兩邊職責更清楚：API 處理「使用者輸入錯誤」、worker 處理「執行期意外」。這是更清晰的 KISS，不是更簡單的 KISS。也學到：**5 秒 preflight 比 5 分鐘 worker crash 划算 60 倍**——直觀但常被忽略。

---

## 16. Stream 下載：grace period 不是立即刪

**最初想法**：使用者下載 ZIP 成功（200 OK 完成）→ `BackgroundTask` 立即刪整個 job 目錄。乾淨、磁碟立刻釋放。

**為什麼錯**：「200 OK 完成」不等於「使用者真的下載完成」。網路在最後幾 KB 斷掉、瀏覽器顯示「下載失敗」、使用者按重試 → 後端已經刪檔，回 404。對 100MB+ 的大 ZIP 在不穩網路下，這個劇本是常態不是例外。

更糟的是「使用者下載完但想重新下載一次」（如貼錯路徑、檔案損毀想重來）也只能再跑一次批次。

**現在做法**：`download_started_at` 起算 1 小時 grace period。期間：
- 重複下載合法（按下載按鈕即可，後端檢查時間戳）
- 支援 HTTP `Range` header（FastAPI `FileResponse` 原生支援）→ 大檔斷線可 resume
- UI 完成 200 後顯示「已下載」+「剩 X 分鐘可重下載」倒數

1 小時後 `cleanup_service.purge_grace_expired` 移除整個 `/data/jobs/{id}/`。

5 分鐘 → 1 小時的決策是使用者明確要求：「考量到大檔案 zip 下載，延長時間至 1 小時」。100MB ZIP 在 1 MB/s 速度下要 100 秒，加上重試容錯 1 小時合理。

**學到什麼**：**「成功」的定義要從使用者視角寫**。HTTP 200 是 server 視角的成功；使用者視角的成功是「檔案在他電腦上能打開」。兩者之間有網路、瀏覽器、磁碟空間等斷層。設計「資源回收時機」時必須選**使用者視角的成功**作為觸發點——具體做法就是 grace period。也學到：**默認值的調整應該便宜**——5 分鐘 → 1 小時只是改一個常數，不涉及架構重寫，所以這類值要寫成 env 或 config，方便調。

---

## 17. 三個並行 race condition：integration test 才現形

**最初想法**：core / services / workers 各自單元測試齊全（117 通過），等同於「跑得起來」。`finalize_job` 在 job create 時 enqueue、`state.json` 雙寫、worker 用固定名字 `worker-0/1/2/3` 都看似合理。

**為什麼錯**：跑 `docker compose up + smoke test`，3 個 primary 全部處理完 — snapshot 卻顯示 2/3 done、ZIP 也沒打包。三個獨立 race condition 同時撞上：
1. **`finalize_job` 賽跑領先 subtasks**：enqueue 在 subtasks 之後但被 worker 先 pop 出來、看到 `terminal=0/3` 就 `finalize.early` 跳過。之後沒人重新觸發，ZIP 永遠不生。
2. **`state.json` 並行寫競爭**：4 個 worker 各自 read-modify-write 同一個 JSON 檔，最後寫贏的覆蓋了其他三個的更新 → 3/3 變 2/3。
3. **RQ worker name 衝突**：`docker compose restart worker` 後新 process 起不來，因為 Redis 還記得舊的 `worker-0` 名字，「ValueError: There exists an active worker named 'worker-0' already」。

這三個都是 unit test 摸不到的併發問題；只有 integration smoke 才出現。

**現在做法**：
- `JobService._locked_state()` 用 `fcntl.flock` 包 read-modify-write
- `mark_done/mark_failed` 回傳 `is_last`，最後完成的那個 subtask 從 worker 內自己 re-enqueue `finalize_job`（保留 job 建立時的 finalize 預先 enqueue 作為 safety net）
- Worker 名字加 `{PID}-{uuid6}` 後綴，每個 process 都唯一

**學到什麼**：**unit test 全綠 ≠ 系統能跑**。併發問題只在多 process / 真檔案系統下才暴露。case_study.md 第七輪詳述。在規格階段就應該識別「unit test 摸不到的點」（檔案併發、佇列順序、進程命名衝突），把對應的 integration smoke 放進驗證清單前段而非末端。

---

## 18. UI 錯誤訊息：顯示真實 zod issues、不要統一報「name 不合」

**最初想法**：ConfigBuilder 的 `toConfig()` 用 try/catch 包 zod parse，失敗就回傳 `null`、UI 顯示通用「name 不合」訊息。簡單。

**為什麼錯**：手動測試輸入完全合法的 `test` / `123` / `測試` 都失敗、紅字「專案名稱僅可含中英文、數字...」。實際失敗原因是 `target_template.columns: Array must contain at least 1 element` 或 `mappings: Array must contain at least 1 element` 等與 name 無關的問題，被誤導去檢查 name。錯誤訊息把所有問題都歸咎於最顯眼的 name 欄位 → 使用者繞圈。

**現在做法**：`toConfig()` 改用 `safeParse` 回傳判別式 union `{ ok: true, config } | { ok: false, issues }`；`formatIssues(issues)` 把 zod issues 串成 `path: message；path: message` 形式直接顯示。

**學到什麼**：**把錯誤吞掉再給通用訊息是反模式**。zod 已經提供精確的 issue path，UI 應該直接呈現而非自作主張統一翻譯。同類錯誤（catch + 通用訊息）在前後端都該避免。也學到：**testing happy path 不夠**，必須測「未完成表單」這類中間狀態才能抓到這類訊息錯位。

---

## 19. Mapping ↔ target columns 雙向同步 + writer append 未知欄位

**最初想法**：設計時把 `target_template.columns` 當主導，mapper 只輸出列在 columns 中的欄位、writer 只填範本既有 header 位置。乾淨的單向資料流。

**為什麼錯**：使用者三條路徑都會撞到「漏欄」：
1. **上傳目標範本但右欄沒自動帶**：右欄 MappingsList 是空的、要逐個「+ 新增映射」+ 手動敲欄位名。
2. **右欄手動加新欄位但輸出沒有**：mapper 看 `target_columns` 沒這欄就跳過、writer 連看都看不到。
3. **編輯既有 config 加新欄位**：同上，且 `target_template.columns` 是修前下載的舊版、新 mapping target 不在裡面，整條規則被靜默丟棄。

單向資料流變成「使用者改了沒用、且沒提示」。

**現在做法**：三層各補一刀，把 columns 與 mappings 變成雙向：
- **ConfigBuilder.onTargetMeta**：上傳目標範本後，依範本 columns 自動 `mergeMappingsWithColumns(existing, columns)` 灌 mapping 列；既有 mapping 若 target 對得上保留、孤兒在尾端
- **`toConfig()`**：`target_template.columns = union(mapping targets, template columns)`，順序按 mapping，孤兒範本欄附尾
- **`backend/app/core/mapper.py`**：`apply()` 自動把 mapping target 不在 `target_columns` 的補進 `effective` 並依序輸出
- **`backend/app/core/writer.py`**：找不到對應 header 的欄位 append 為新欄、header 寫在 `header_row`、資料寫下方

**學到什麼**：**「乾淨單向資料流」如果跟使用者操作模式不符就是反設計**。使用者腦中：「我在這個列加東西、它就該出現」。系統的內部 invariant（columns 是 SoT）不該洩漏到行為。也學到：**robust 系統三處都要修**——前端產生階段同步、API/mapper schema 寬容、writer 兜底——任何一處嚴格都會讓使用者踩雷。

---

## 20. 載入既有 config 時推回 sources.columns

**最初想法**：載入既有 config 時 `state.sources[].columns = []`，等使用者重新上傳 xlsx 後由 `SheetHeaderPicker` 填回。

**為什麼錯**：使用者載入既有 config 只是要「微調 mapping」，不會重新上傳。但 columns 空了之後：
- MappingRow 的 source 下拉空白、看不到既有 `primary.#`
- JoinsEditor 兩邊下拉空白
- ConditionChip 欄位下拉空白

→ 整個工作台變成只能看不能改，使用者必須先重新上傳所有 source 檔才能編輯。對「已有的設定檔小幅修改」場景是非常 hostile 的 UX。

**現在做法**：`inferColumnsFromConfig(cfg)` 掃 `joins.left/right`、`mappings.source`、`mappings.conditions.field` 中所有 `alias.col`、依 alias 分組回傳；載入時 `sources[].columns` 改用 inferred 值。後續若使用者上傳實際 xlsx，SheetHeaderPicker 會用完整 header 覆蓋（inferred 必為其子集，不會丟失既有引用）。

**學到什麼**：**「真實資料」與「使用者意圖」可以分離**。columns 的「真實值」是 xlsx 標頭、但 config 本身已隱含了「至少這些欄位被引用」這個事實。利用既有 config 的引用作為 fallback 是低成本、高 UX 報酬的兜底策略。也學到：**寫單元測試的時候要把「初次打開 vs 載入既有」當不同 path 測**，這個 path 之前沒被驗證、所以漏了。

---

## 21. Schema 擴展：optional `sample_filename` 給 BatchRunner 當提示

**最初想法**：config 記 alias / role / sheet / header_row 就夠了，使用者上傳時自己會記得該傳哪個檔。

**為什麼錯**：跑批次時 BatchRunner 只顯示 alias（如 `primary`、`source_2`），同名 alias 在不同 config 都叫一樣，使用者完全不知道「primary 對應哪個檔」。每次都要回頭翻原始 ERP 輸出目錄找名字。

**現在做法**：`TargetTemplate` 與 `SourceSpec` 都加 optional `sample_filename: str | None`；ConfigBuilder 儲存時把當下上傳檔的 `file.name` 寫入；BatchRunner 在每個 upload slot 下方顯示「上次：source.xlsx」。Pure UI hint，writer 不讀。

**學到什麼**：**config 不只是「機器能跑的最小集合」、也要承擔「使用者記憶輔助」的功能**。把上次上傳檔名記下來成本極低（一個 optional 欄位 + UI 一行 hint），但去掉每次跑批次都要回憶/翻找的摩擦。Schema 設計時除了想「資料完整性」也要想「人類記憶補強」。

---

## 22. Docker Hub 連線抖動 → 前端改本機 build + 單階段 nginx serve

**最初想法**：標準多階段 Dockerfile —— `FROM node:20-alpine AS build` 跑 `npm install` 與 `npm run build`，再 `FROM nginx:alpine` COPY dist。產出的 image self-contained、CI/CD 友善。

**為什麼錯**：本機 Docker 環境在拉 `node:20-alpine` 時反覆 TLS handshake timeout（Docker Hub 從台灣連的網路常抖動）。`docker compose up -d frontend` 直接卡在 metadata pull，整個一鍵啟動鏈斷掉。同樣的問題之前已撞過一次（前端容器化），當時暫解是「跑 `npm run dev` 本機開發」，但那不解決「一鍵起 4 服務」這個需求。

**現在做法**：把 build 與 ship 分離：
- `frontend/Dockerfile` 改回單階段：`FROM nginx:alpine` + `COPY dist /usr/share/nginx/html` + `COPY nginx.conf …`
- 本機 `npm run build` 產 `frontend/dist/`，Docker 只負責 serve
- `scripts/up.sh` 包覆「偵測 dist 過期或缺失 → 本機 npm build → docker compose up -d」
- `frontend/.dockerignore` 把 `src/`、`node_modules/`、config 都排除，image 內只剩 `dist/` 與 `nginx.conf`

成果：剩下只需要 cache 住 `nginx:alpine` 一個 base image（比 node + nginx 兩個少踩一次坑），且只有 frontend service build 需要它（backend 用 `python:3.12-slim`，本機 build cache 還在）。

**學到什麼**：**「CI/CD friendly」不等於「dev-machine friendly」**。Multi-stage Dockerfile 在 build server 上很合理（網路穩、有 mirror）；在開發機上多了一個 base image pull 反而是阻力。把「build artefact」與「ship 容器」分離（本機 / CI 出產物、container 只 serve）對單機部署最穩。也學到：**遇到「Docker Hub 連不上」這類環境問題不要硬撞**，改設計繞過比設 mirror 或無限重試實際得多。一鍵啟動需要的是「依賴最少的可靠路徑」，不是「最漂亮的容器組合」。

---

## 跨決策的觀察

回頭看這 22 個決策，可歸納幾個**反覆出現的設計判斷模式**：

### 模式 A：plan 通過 ≠ 設計定案

- Decision #1（plan 通過後使用者補「sidebar -> TopMenuBar」）
- Decision #3（plan 通過後使用者補「下載成功後要刪 uploads/ 與 out/」）
- Decision #7（plan 通過後使用者修正 wizard → 三欄）

每一輪 plan「通過」都帶著一個「但是」。下次起設計流程應該預期「通過後會有修正」，並把這個修正當作流程的一部分而非例外。

### 模式 B：使用者反問暴露盲點

- Decision #3（「Redis 掛了會不會掉？」暴露 docker volume 沒講清）
- Decision #5（「服務重啟使用者怎麼看進度？」暴露 push-only 模型缺陷）
- Decision #6（「每步加 try/catch 嗎？」暴露我沒主動講邊界式設計）

使用者的反問是設計工具。工程師應該主動把這些問題先問自己。

### 模式 C：「以後可能要」是負擔

- Decision #2（Postgres → Redis-only：「以後可能要多租戶」不該影響當下選型）
- Decision #9（Mantine/AntD → shadcn：「全套設計系統」不該綁住當下品味）

「以後可能要」要被翻譯成「Scaling Trigger」寫進規格，而不是當下實作。

### 模式 D：低頻 ≠ 新手

- Decision #7、#11（wizard 對「偶爾使用者」不是正確答案）

直覺鏈條要被拆開檢驗每一段。

### 模式 E：保險動作未必保險

- Decision #6（每步 try/catch 反而吞訊號）
- Decision #10（Modal 編輯反而中斷視覺）

「看起來保險」的直覺常需要被反向檢驗。

---

## 反思：哪些決策應該更早做？

- **Decision #1 TopMenuBar**：應該在第一輪 brainstorming 時就主動問「兩個分頁的場景，Sidebar 還是 TopMenuBar？」——直接照使用者寫的 Sidebar 走，是工程師的偷懶。
- **Decision #3 檔案雙寫**：應該在 Decision #2 選 Redis-only 的同時就講清楚「Redis 是 in-memory 但有 AOF + docker volume 持久化」。使用者反問才講等於設計工程不夠主動。
- **Decision #5 進度可見性**：SSE 一開始就該配合 snapshot endpoint 一起設計，而不是只靠 push。Push-only 是設計初期的偷懶。
- **Decision #11 Wizard 判斷錯誤**：第一次看到「低頻場景」就跳到 wizard，是 senior 級判斷力應該避免的。應該先問「使用者會記得流程的形狀嗎？」這個更根本的問題。

## 反思：哪些決策做對了？

- **Decision #2 Postgres → Redis-only**：及早砍掉「以後可能要」的負擔，避免了在不需要的地方加複雜度。
- **Decision #4 Subtask 級續傳**：使用者問「有續傳嗎？」時主動把選項擺出來（A/B/C），讓使用者參與決策層級，而不是工程師單方面決定。
- **Decision #6 邊界式錯誤處理**：使用者直覺要 try/catch，沒順著答而是說清楚為什麼錯。這需要勇氣（推翻使用者的提議），但長遠對系統好。
- **Decision #12 明寫 Out of Scope**：把「不做」與「做」同等對待，避免實作階段被偷偷擴張。

---

## 第二部分：迭代階段——9 條上線後修正

設計階段 22 條結束於系統可以一鍵啟動、跑通 smoke test。但「能跑」與「真實使用者用真實資料能用」之間還有一段距離。上線後使用者開始把實作期假設的「典型用法」推到 corner case——例如「source 的某個 sheet 沒有 header」、「mapping 不指 source 而是固定值」、「同一個 xlsx 被多個 source 共用」。設計階段預先看見其中一兩個是合理的，全部都預先看見不切實際。剩下的就是這 6 條一條條補完。

六條的觸發共同點：4 條（#1、#4、#5、#6）都是 source_cell（第 4 條這個新 mapping 類型）的延伸效應——既有 schema、序列化、preflight、worker 四個獨立層都要對應更新。Part 2 同時也展示了「broadcast 規則」這條設計上的演進（第 2 條 broaden、第 6 條 narrow）。

格式從 Part 1 的四段改為五段（使用者觸發 / 症狀 / 根因 / 修法 / 學到什麼），更貼合「issue → fix」的敘事節奏。

---

## 1. modeOf 把 null 當作 literal，載入既有 config 後預設變固定值

**使用者觸發**：開啟 ConfigBuilder 載入既有 config，每筆 mapping 的右欄都顯示「固定值」按鈕為選中、原本應該是預設的「來源欄位」反而沒選中。

**症狀**：所有 mapping 都被誤判為 literal 模式，source dropdown 看起來像被清空。

**根因**：`backend/app/schemas.py` 的 `Mapping.literal: Any = None`，`config_service.py` 用 `model_dump_json(indent=2)`（沒 `exclude_none`）序列化，所以存到 disk 的 JSON 每筆 mapping 都有 `"literal": null`。前端 `useConfig` parse 後 literal 是 null，而 `MappingRow.tsx` 的 `modeOf` 只判 `!== undefined`，null 通過 → 進 literal 模式。

這條的修正其實連跳兩次：

- 第一次：原本 `literal !== undefined && literal !== null && literal !== ""` → 第一輪修成 `!== undefined`，是為了讓「剛點 toggle 切到 literal、literal=""」也保持 literal 模式（不要 bounce 回 source）
- 第二次：把 null 也排除回去，最終定案 `m.literal !== undefined && m.literal !== null ? "literal" : "source"`

**修法**：`frontend/src/features/config-builder/MappingRow.tsx:28-29` 的 `modeOf` 同時排除 `undefined` 與 `null`，但保留空字串 `""` 為 literal 模式（剛 toggle 的暫態）。

**學到什麼**：「序列化往返保不保 null」是前後端整合處最常被忽略的細節。後端用 pydantic Optional 預設轉 null、前端用 zod optional 不轉 undefined——這個 mismatch 必須在 UI 內部 mode 判斷處主動橋接，不能假設「兩邊都是 optional 就一致」。空字串 vs null vs undefined 的三態語意，在 toggle UX 上各有合法用途，必須一個一個釐清。

---

## 2. 未 join 的 source 應該被當「固定單欄來源」廣播

**使用者觸發**：使用者用「+ 同檔另一 sheet」加了 `primary_sheet4` 取 sheet 2 的單列 metadata（如批次日期 20260517），mapping 引用 `primary_sheet4.20260517`，但沒寫 join 規則。

**症狀**：轉換失敗，錯訊「映射來源欄位『primary_sheet4.20260517』不存在」——技術上正確，但對使用者完全是誤導：真正缺的是 join 規則，不是欄位。

**根因**：`backend/app/core/joiner.py` 只把出現在 `joins.left/right` 的 alias 合進結果。`primary_sheet4` 即使在 `sources` dict、即使被 mapping 引用，沒有任何 join 規則連到它就會被靜默丟棄。

使用者明確點出設計意圖：「那欄不用 join，是固定單欄來源」——意思是 sheet 4 是常數來源（單列 metadata），應該被廣播到每筆 primary row，不該強制 join。

**修法**：`joiner.py` 在套完所有 join 規則後，掃 `sources` dict 對未連通的 alias：

- 0 列 → `JoinKeyMissing` 報「沒有資料列，無法作為固定單欄來源」
- 1 列 → broadcast：把該列的每個欄位以常數複製到 merged 每一列
- 多列 → 報「有 N 列，無法當固定單欄來源廣播；若需逐列對應請新增 join 規則」

**學到什麼**：「未連通的 source」這個系統狀態既可能是 user error（忘記寫 join），也可能是合法設計意圖（單列 metadata）。原本一律報錯是把「狀態語意」假設成單一解；正確做法是讓資料形狀（row count）決定要不要走 broadcast 路徑，並對其他形狀提供明確錯訊。錯訊的「明確」必須對應到使用者腦中的概念，而非系統內部的概念。

---

## 3. mapper 對 alias-not-in-merged 的清楚訊息

**使用者觸發**：在第 2 條修法前，使用者看到「映射來源欄位『primary_sheet4.20260517』不存在」。

**症狀**：錯訊指向「欄位」這個概念，但真正缺的是整個 alias（source）沒被合進結果。

**根因**：`backend/app/core/mapper.py:_apply_one` 對 `source not in df.columns` 一律報「欄位不存在」，沒區分「欄位真的拼錯」與「整個 alias 都沒進來」這兩種狀態。

**修法**：`mapper.py` 在報錯前先檢查「該 alias 是否存在於 merged df 的任何欄位」：

- 完全不存在 → 報「來源 X 的欄位未進入合併結果——它沒被任何 join 規則連到主來源，且不符合單列固定來源的條件」
- alias 在但這個 col 不在 → 維持原本「映射來源欄位『X.col』不存在」

**學到什麼**：錯訊的精確度不在「描述出了什麼狀況」，而在「指出該怎麼修」。「欄位不存在」讓使用者去檢查欄名拼字、檢查 source 是否有那個 column；「alias 未進入合併結果」讓使用者去檢查 join 規則。兩個訊息字面長度差不多，導向的偵錯路徑完全不同。深度防禦（即使第 2 條修了 broadcast 之後這條訊息也很少出現）仍然有價值——任何「欄位找不到」的剩餘情況都會落到這條，所以精細化值得做。

---

## 4. 新增第三種 mapping 類型「固定儲存格」(source_cell)

**使用者觸發**：使用者要把 sheet 上某個絕對位置的 cell（如 A3）的值，整個 output 欄都填這格。但這個 cell 所在的列可能在 header_row 之上、甚至 sheet 沒有 header——alias.col 抽象抓不到。

**症狀**：第 2 條的 broadcast 設計只在「source df 剛好只有 1 列」時可用；當 source 有多列、但要從中挑一格時，前兩種 mode 都做不到。

**根因**：原本兩種 mode（來源欄位、固定值）都建立在 parser/header 抽象上，無法處理「跳過 header、直接讀絕對 cell」的需求。

**修法**：新增 `source_cell { alias, address }` 第三種 mode：

- `backend/app/schemas.py` 加 `SourceCell` 模型、`Mapping.source_cell` 欄位、三選一 validator、`ConfigSchema._validate_relationships` 加 source_cell.alias 跨表檢查
- `backend/app/workers/tasks.py` 加 `_resolve_source_cells()`：用 `openpyxl.load_workbook(data_only=True, read_only=True)` 開檔（同檔 cache）、讀絕對位址、結果傳給 mapper
- `backend/app/core/mapper.py` `apply()` 多收 `pinned_cells: dict[int, Any]`，`_apply_one` 拆三條分支（literal / source_cell / source），抽 `_broadcast_with_conditions` 共用
- `frontend/src/lib/schemas.ts` 加 `sourceCellSchema` + `cellAddressPattern` + 三選一 superRefine + 跨表 alias 驗證
- `frontend/src/features/config-builder/MappingRow.tsx` 改 3-way toggle（藍 / 紫 / 琥珀），source_cell mode 同時顯示 alias dropdown + `!` + 紫色背景的位址 input（pattern 不合則紅框 + tooltip）

mapper 自己不開檔、不依賴 alias→path 對應；只把 worker 傳進來的值複製到每一筆 output。這個分工讓 mapper 維持「pure function over DataFrame」的性質。

**學到什麼**：「再加一種 mode」這種 feature 看起來像對既有抽象的擴展，但有時其實是揭露「舊抽象覆蓋不全」。原本 source/literal 兩種 mode 都假設「資料以 header 為基準的 dataframe」是唯一來源形式；source_cell 是第一個跳出這個假設的需求，需要 worker 多加一個「pre-resolution」階段。一旦 worker 有了這個階段，後面第 6 條的「source_cell-only source 不該進 df pipeline」才有清晰的解。

---

## 5. preflight 對 literal / source_cell mapping 直接 500

**使用者觸發**：使用者完成 source_cell mapping 設定、按「開始轉換」。

**症狀**：API 回 `{"error":"Internal error","request_id":"..."}`。server log: `AttributeError: 'NoneType' object has no attribute 'partition'` at `backend/app/api/jobs.py:339`。

**根因**：preflight 預先掃 mappings 收集每個 alias 需要的欄位：

```python
for m in config.mappings:
    alias, _, col = m.source.partition(".")  # m.source 在 literal/source_cell 是 None
```

literal mapping 其實一直以來都會在這條路徑中招（雖然使用者沒踩過），新加的 source_cell 把這顆雷暴露出來。

**修法**：

- 抽出 `_collect_required_columns(config)` 純函式（`backend/app/api/jobs.py`），對 `m.source is not None` 才收 column；literal 與 source_cell 都跳過
- 加單元測試三條：literal-only、source_cell-only、混合三 mode

**學到什麼**：「以為一直存在的欄位」是 internal API 最容易潛伏的雷。schema 把它定義成 `Optional`，但呼叫端用 `.partition()` 卻沒護欄——這是型別系統不強或無 `mypy` strict 時典型的破口。新加 mode 是好的觸發契機讓這條 bug 浮現；如果單純用 mypy 全跑一輪也能事先抓到。本案沒走 mypy，學到「Optional 欄位的每個 access 都該有護欄」這條 hand rule 比較實在。

---

## 6. source_cell-only source 不該進 joiner / broadcast 流程

**使用者觸發**：使用者修好第 5 條後重跑 `test.json`。

**症狀**：轉換失敗，錯訊「來源『primary_sheet4』沒有資料列，無法作為固定單欄來源」——但使用者明明只用 source_cell mode 讀 A3，根本沒指望 df 有資料列。

**根因**：`backend/app/workers/tasks.py:_execute` 對 `config.sources` 全部跑 `parser.parse` 進 `sources_dfs`，再丟 joiner。joiner 看 `primary_sheet4` 不在 join 連通圖 → 走第 2 條加的廣播分支 → header_row=3 把 sheet 唯一一列吃掉了 → df 0 列 → 報「沒有資料列」。

但這個 source 唯一被 source_cell 引用，根本不該進 df pipeline——openpyxl 在 `_resolve_source_cells` 直接讀絕對位址，不需要 parser 也不需要 joiner。

**修法**：`backend/app/workers/tasks.py` 抽 `df_needed_aliases(config) -> set[str]`：

```python
def df_needed_aliases(config: ConfigSchema) -> set[str]:
    needed = {config.primary_alias}
    for j in config.joins:
        needed.add(j.left.split(".", 1)[0])
        needed.add(j.right.split(".", 1)[0])
    for m in config.mappings:
        if m.source:
            needed.add(m.source.split(".", 1)[0])
        for c in m.conditions:
            needed.add(c.field.split(".", 1)[0])
    return needed
```

`_execute` 用它過濾 `sources_dfs`（source_cell-only alias 跳過 parser.parse），但 `source_files` / `source_sheets` 仍要包含全部（給 `_resolve_source_cells` 用）。

`backend/app/api/jobs.py:_run_preflight` 也用同個 helper 跳過 source_cell-only alias 的 preflight——避免使用者 source_cell 用途設了奇怪 header_row 被誤殺。source_cell-only source 的檔案 / sheet / cell 存在性由 worker 的 `_resolve_source_cells` 在執行時驗證，錯訊已經明確。

**學到什麼**：第 4 條（source_cell feature）的 mental model 是「source_cell 走另一條 pipeline」，但實作只在 mapper 那條岔開、worker 還是把所有 source 推進 parser 與 joiner——這個 partial fork 留了個結構性問題，第 6 條才把它徹底切乾淨。早一點意識到「source 有兩種用途（df-needed / cell-needed）」，第 4 條就會直接用 `df_needed_aliases` 的概念，省下第 6 條這次補丁。

教訓比這個更廣：**新加的執行階段（如 `_resolve_source_cells`）應該配套重新評估其他階段對「source」的定義範圍**。一個新階段意味著舊階段的迴圈條件可能要對應收縮。

---

## 7. SheetHeaderPicker 黑暗模式選中列「白底白字」

**使用者觸發**：黑暗模式上傳 xlsx → SheetHeaderPicker 顯示前 30 列預覽供使用者點哪列當 header → 點下後該列幾乎不可見，只有 hover 短暫看得到。

**症狀**：選中列 = 白底白字。

**根因**：`frontend/src/components/SheetHeaderPicker.tsx:138` 用 `bg-blue-50 font-semibold` hardcoded 淺藍背景，dark mode 沒對應 variant；文字色繼承 body 在 dark 變淺色 → 白白疊合。

**修法**：改為 `bg-blue-100 font-semibold text-blue-900 dark:bg-blue-900/40 dark:text-blue-100`。明文字色 + dark variant + 淺色背景升一階（picker 的選擇態應比一般 row 突出）。

**學到什麼**：Tailwind hardcoded color（bg-blue-50, bg-amber-50…）必須**同時**配 dark variant 與**明 text color**。靠 body 繼承文字色等於把控制權交給 dark mode 反轉系統——對 hardcoded 背景剛好失靈。專案內 MappingRow 早已建立此慣例（`bg-blue-50/40 dark:bg-blue-950/20`），此檔漏配是個遺漏。模式跟 #1（null vs undefined 序列化往返）同類：**前後端／theme 整合處的隱性默契沒主動橋接就是潛伏雷**。

---

## 8. ConfigBuilder 草稿系統的四連環修正

本條是同一輪 plan-fix-test 循環裡浮現的 4 個 sub-bug——每修一個就揭露下一個。完整呈現「partial fix 揭露下一層」這條設計階段 #17 學過的形態，這次以前端 race 形式重現。

### 8a：「還原」按鈕沒效果

**使用者觸發**：填部分專案設定 → reload 頁面 → banner 出現「您有未完成的設定，是否還原？」→ 點還原 → 表單仍是空的。

**根因**：`frontend/src/pages/ConfigBuilder.tsx` 的 race：(1) mount 時 `useState(emptyState)` (2) `[state]` dep 的 debounced autosave effect 也在 mount tick 跑、1 秒後把空 state 寫回 localStorage (3) `restoreDraft` 卻是「按下時才從 localStorage 撈」。使用者讀完 banner 點下去通常超過 1 秒，撈到的是已被覆寫的空草稿。

**修法**：mount 時把 localStorage 字串快照到 `draftSnapshotRef: useRef<string | null>`；`restoreDraft` 從 ref 讀、不再回頭查 localStorage。順便補回原本被漏掉的 `target.sample_filename`。

### 8b：全新訪客也跳出「是否還原？」

**使用者觸發**：完全沒填過任何內容、第一次打開 /configs 就出現 banner。

**根因**：autosave 沒對「空 state」做判斷，每次 state 變動（含 mount tick）都寫 localStorage → 累積出「空草稿」→ 下次 mount 偵測到 → banner 莫名亮起。

**修法（v1，後來證明寫錯）**：autosave effect 加 hasContent guard——name / target.sheet / sources.length / joins.length / mappings.length 任一非空就視為有內容；空就 removeItem。

### 8c：捨棄後切回又出現的循環、還原沒效果

**使用者觸發**：banner 出現 → 捨棄 → 切到 /batch → 切回 /configs → 來回幾次後 banner 又跳；這次按還原沒效果，捨棄能暫時清掉、1 秒後又回。

**根因**：8b 的 hasContent 寫錯了——`emptyState()` 預設帶一個 `primary` source，所以 `state.sources.length > 0` 永遠為 true、guard 永遠不觸發；autosave 永遠寫「空 state 的 JSON（E）」進 localStorage。每次 fresh mount 都從 ref 撈到 E，「還原」把 E 寫進 state → 表單仍空 → 「沒效果」。捨棄當下清 localStorage，但 1 秒後 autosave 又把 E 寫回去 → 循環。

**修法**：改用 JSON 字串比對。模組層級加 `toPersistable(s)` helper 與 `EMPTY_PERSISTABLE_JSON = JSON.stringify(toPersistable(emptyState()))`，autosave 比對當下 state 的 persistable JSON——相等就 removeItem + return。

### 8d：載入設定後 banner 不該自動消失

**使用者觸發**：載入既有設定 → 切走 → 切回 → banner 出現 → 不選擇再切走切回 → 1 秒後 banner 自己消失（autosave 主動把 localStorage 裡的合法 draft 清掉了）。使用者明確指出：「當頁面沒有載入設定、沒有上傳任何檔案時，autosave 不該觸發、用空白設定蓋掉正常設定」。

**根因**：8c 的 JSON 比對 guard 在「state == empty」時不只跳過寫入、還主動 removeItem。fresh mount 的 state 一律從 emptyState 開始（loaded config 還沒被重新抓），autosave 1 秒後 fire 看到 state 是空就把 localStorage 裡的合法 draft 也清掉了。

**修法**：拿掉那個 removeItem，empty state 的 autosave 變純 no-op：

```ts
if (json === EMPTY_PERSISTABLE_JSON) return;  // 不寫也不刪
```

`removeItem` 只剩兩個明示路徑（`discardDraft` / `handleSave` 成功）。語意分工乾淨：autosave 只負責「state 有內容才寫」；localStorage 移除只跟使用者明示動作有關。

### 8a–d 合起來學到什麼

草稿系統有四個獨立路徑（mount-tick state init / state-dep autosave / 使用者點還原 / 使用者點捨棄）+ 兩個儲存層（component state / localStorage），每對交叉的時序與責任都要釐清，少一條就有 race 或意料外行為。每次「以為修好了」其實只蓋住一個 layer，下一個操作模式就把下一個 layer 暴露出來。

修法到 8d 才把「localStorage 變動只跟明示動作有關」這條 invariant 立穩——這比補一堆 guard 更穩，因為它砍掉了一整類「autosave 自作主張改 localStorage」的可能性。

跟 Decision #17（三個 race 一起在 smoke test 浮現）同形態：unit test 摸不到的 race，只有真實使用者操作（含 dwell time、tab 切換、reload）才會暴露。當時學到的「規格階段就要列 integration test 觸發條件矩陣」這條本應涵蓋前端的「mount tick × state-dep effect × localStorage」三維交集。

---

## 9. JoinType 從 left/inner 擴展到 outer/right

**Demo case 觸發**：寫 `examples/01_product_pricing/`（主商品表 + 多家供應商月報價）時，自然要展示「主商品表中沒有任何供應商報價的商品」——這是業務上有意義的洞察（哪些商品被冷落了）。但設定下去發現 schema 只支援 `left` / `inner`，做不到「primary 跟 lookup 雙邊都保留」。

**症狀**：`JoinType = Literal["left", "inner"]` 不允許 outer，schema 驗證會擋下；即使硬塞 `"outer"`，pydantic 也會報 invalid literal。

**根因**：MVP 階段視 outer / right 為 YAGNI——「主檔 + 補欄位」場景用 left 就夠，inner 處理「只要兩邊都有的」。當時的 use case 集合裡沒有「diff / 補集 / 雙邊保留」這類需求。

**修法**：`backend/app/schemas.py:16` 把 `JoinType = Literal["left", "inner"]` 擴展為 `Literal["left", "inner", "outer", "right"]`。core/joiner.py 第 78 行 `merged.merge(right_df, how=how, ...)` 已經把 `how` 透傳給 pandas merge，原生支援 outer / right，零演算法改動。補 4 個 unit test（outer 雙邊保留、right join 從 lookup 驅動、outer 串連兩個 lookup、outer 跟 NaN 行為）。`core/mapper.py` 的 `_numeric` 已涵蓋 NaN→default，不需改 mapper。

**學到什麼**：**純枚舉擴展通常不到 ADR 等級**——加幾個 literal 值、走原生函式、零演算法改動，傳統上不值得單獨記。但「**為什麼當初判斷不需要、現在判斷需要**」這條軸線才是判斷力的活體紀錄。第一次決定 left + inner 夠用，是用「我能想到的 use case 都是 enrichment」這個前提；錯不在判斷，錯在沒列出「diff / 補集 / 雙邊保留」這類隱形需求。寫 examples 是反向發現這類盲點的好工具——它強迫你把工具放回實際情境，比想像力可靠。

對應跨決策模式：跟 Part 1 #12「Out of Scope 的紀律」是同一條軸線的不同段——當初寫 Out of Scope 是「現在不做」，現在這條 ADR 是「為什麼補做」。兩端串起來才是完整的 scope evolution 紀錄。

---

## 迭代階段的四條模式

**4 條源自同一條 feature**：1、4、5、6 都是 source_cell 流程的延伸——「加 feature 觸發既有護欄不適用」這條傳統 software bug 模式，在這個系統具體呈現為 schema、序列化、preflight、worker 四個獨立層的同步成本。Part 2 後加的 #7（hardcoded color 漏 dark variant）與 #8（autosave 多重 race）展示同一模式的前端版本：theme 整合處 + state/storage 多路徑的「隱性默契」沒主動橋接。**整合介面是 bug 最高發地帶**這條觀察跨前後端、跨設計階段與迭代階段。

**broadcast 規則的演進**：原本「未連通 source 應該報錯」（implicit assumption）→ 第 2 條改成「1 列自動廣播」（broadens 容忍度）→ 第 6 條加上「source_cell-only 應該完全跳過 broadcast 檢查」（narrows 容忍度回去，但 narrow 在另一條軸）。一個規則在三條迭代裡 broaden 又 narrow，本身就是健康的——好的設計不是一次到位，是邊界隨著理解而 sharpen。同樣模式在 #8 的 autosave 行為演進更明顯（write → write+remove → write-only-on-content → write-only-without-touching-storage-elsewhere），4 次微調才到位。

**parser/joiner/mapper 這條 dataframe pipeline 與「絕對位址 cell 讀取」是兩條獨立的 source 用途**。新加 source_cell 時應該一開始就把它從 df-needed 抽出來，而不是事後補 6 條才到位。下次擴展 mapping mode 前先問：「這個新 mode 是擴 dataframe pipeline，還是開新 pipeline？」開新 pipeline 就要連 worker 層級的 source 分類一起重設。

**partial fix 揭露下一層是迭代的常態**：#8 連修四次才到位。這跟設計 Decision #17（race 三連發）同形態，但這次以前端的「mount tick × state-dep effect × localStorage」三維交集形式出現——比後端的「多 worker × 真檔案 × queue 排序」更難在 unit test 環境中重現。下次規格階段應主動列「前端 race 觸發條件矩陣」：mount tick 是否與 state-changing effect 共存？storage 變動是否有多個觸發路徑？

---

## 全文回望：從構想到迭代的合一觀察

設計階段（Part 1，22 條）與迭代階段（Part 2，9 條）在觸發、節奏、產出物上呈現對比：

| 維度 | 設計階段 | 迭代階段 |
|---|---|---|
| 觸發 | 下一輪 plan 該長什麼樣 | 真實使用者輸入打到 corner case |
| 節奏 | 每輪 brainstorm 5–8 條轉折 | 每次使用者測試 1–2 條，前端 race 可能單條走 4 輪 |
| 產出 | 規格 / plan / mockup | 程式碼 patch + 測試 |
| 修正成本 | 改文件（幾分鐘） | 改 schema + 多層程式（幾小時，前端 race 比後端更難在 unit test 撈到） |

但兩階段共享一個底層模式：**「假設過度收斂」的瞬間**——設計階段是 plan 通過誤以為定案（模式 A），迭代階段是 feature 上線誤以為穩定（Part 2 最初的 6 條皆符合）。「能跑通 smoke test」與「能跑通真實使用者的真實資料」之間的鴻溝，幾乎注定要靠迭代填——這不是設計失敗，這是設計與真實使用之間必然的距離。

也可以回頭問：**最初 6 條迭代裡，哪些其實能在設計階段預先看到？**

- 預先能看到的：迭代 #1（null vs undefined 的序列化往返）——這是前後端整合的常識，設計階段沒主動排查屬於遺漏，與設計 #3「Redis 持久化沒講清楚」性質一樣（**設計工程不夠主動**）
- 預先看不到的：迭代 #4（source_cell 這個 mapping 類型）——使用者真的拿 ERP metadata sheet 來用才提出，設計階段沒這個情境，純屬「新需求」而非「設計遺漏」

這個分類本身就是有用的——它指出「設計階段該更主動的地方」（介面整合的標準排查）vs「上線後注定要遇到的地方」（領域新需求）。前者下次可以做得更好，後者要接受迭代是流程的一部分。

37 條（22 + 9 + 6）合起來示範一條經驗法則：**好的系統不是設計階段把答案寫對，而是「設計階段定夠好的起點 + 上線後維持可改的彈性」**。Part 1 的設計判斷讓系統有個能演化的骨架；Part 2 的 9 條補丁讓骨架能應對真實場景。兩者缺一不可——也只有看完兩者，才看得到完整的「從構想到迭代」這條弧。

---

## 第三部分：UX 改版階段——6 條（2026-07-04〜05）

改版動機：owner 把產品目標明確定為「**非技術者要能自己建 config**」，並排出三大痛點（介面語言夾雜／Builder 易出錯／送出後回饋不足）。流程上採三角色審議（資深 UIUX 設計師、資深軟體架構師各自獨立提案，資深 PM 仲裁定案），砍掉一個大項、排定三期，總量約 11–14 dev-days 的範圍在兩天內完成並上線。上線當天使用者實測又觸發四輪快速修正——設計判斷（#1–3）與迭代踩坑（#4–6）在同一週期交錯，所以這部分兩種格式並用。

---

## 1. Full wizard 被砍：引導感不等於步驟閘門

**最初想法**：目標是非技術者自助，直覺解是把三欄工作台改成 step-by-step wizard——上一步沒完成不能進下一步，每步只露必要欄位。

**為什麼錯**：UIUX 與架構兩位審議者不約而同反對硬性 gating：(1) 編輯 config 是迭代行為，回頭改任何一欄都要重走流程；(2) 三個 pane 之間有資料依賴但沒有嚴格時序（可以邊 mapping 邊補 source）；(3) 丟棄三欄「同時可見」的既有投資。PM 裁決：wizard 提供的「引導信心」可以由三個更便宜的機制組合出來——checklist rail（導引不封鎖）＋debounced 即時驗證（錯誤就地顯示）＋dry-run 預覽（送出前看結果），成本約 wizard 的 1/3。

**現在做法**：三欄保留，左側加 checklist rail（範本→來源→Joins→對應→儲存，狀態由 FormState 派生），任何步驟隨時可編輯。

**學到什麼**：**「引導」是體驗目標，「wizard」只是其中一種實作**——把目標直接翻譯成最貴的實作是常見捷徑錯誤。對迭代型工具（設定會反覆回頭改），漸進揭露＋即時回饋幾乎總是優於流程閘門。

---

## 2. 範本庫否決：optional-DB 是兩頭不討好的擴充設計

**最初想法**：target 範本每個 job 都要重傳很煩，做個 server 端範本庫；後來 owner 進一步問「若有設定 DB 連線就存 DB、沒有就存本地」的漸進式設計是否更好。

**為什麼錯**：本系統零 SQL 依賴（Redis 快取＋檔案系統真相源）。optional-DB 帶進來的不是一個功能而是一條供應鏈：連線設定、schema migration、備份策略、「有 DB／無 DB」雙路徑測試矩陣、recovery 語意重新定義——直接打破「輕量」定位。而它解決的問題檔案系統就能解：範本 xlsx 存 `/data/templates/`＋Redis 索引，與 config 儲存完全同構。單機、少人、無 auth 的場景下，DB 沒有任何檔案做不到的事。

**現在做法**：維持每 job 上傳（owner 裁決）。未來若重啟需求，走 /data 檔案模式，明確不引入 DB。

**學到什麼**：**「optional 依賴」是最差的擴充形狀**——所有成本照付（雙路徑都要寫、測、維護），但任一使用者只享受到一半的好處。擴充設計先問「現有儲存模式能不能同構地長出來」，答案是能的話就不要引入新基礎設施。

---

## 3. Preview 端點三選一：stateless 重傳勝出，因為不變量比延遲貴

**最初想法**：dry-run 預覽需要伺服器拿到樣本檔。三個候選：(a) 每次 preview 重傳 multipart；(b) session 級樣本暫存；(c) 重用 job 機制開「preview job」類型。(b)(c) 看起來比較「聰明」——避免重複上傳。

**為什麼錯**：(b)(c) 都引入持久狀態，直接撞上系統最核心的不變量：`/data/jobs` 是真相源，recovery 開機掃它重排、cleanup 定時掃它清理。preview job 要嘛汙染這兩個掃描，要嘛到處挖 carve-out——淨增不變量表面積。而 (a) 的「浪費」實測極小：內網重傳幾 MB 樣本，preflight 只跑上傳子集 <1s，12 萬列大檔預覽 3.56s。

**現在做法**：`POST /api/configs/preview` stateless multipart，tempdir＋finally 清理，不碰 /data 不碰 Redis；pipeline 邏輯抽到 `core/preview.py` 供 worker 與 preview 共用（Part 2 #4 的 fork 教訓直接複用）。

**學到什麼**：**評估架構選項時，「增加多少不變量表面積」應該與延遲、記憶體同列一級指標**。省一次上傳的最佳化，代價是每個未來維護者都要多記一條「preview 目錄不算 job」的例外——這種帳幾乎永遠不划算。

---

## 4. 工作台高度三改：固定 viewport 假設被真實使用推翻兩次

**使用者觸發**：三連發——(1)「為何 -220px？那塊沒東西啊」；(2)（改成 flex 填滿視窗後）「新增來源高度不會跟著長，下面的項目要捲才看得到」；(3)（提供固定高＋改善捲動、整頁增高兩案，使用者選了前者後一天）「拿掉固定高度，動作鈕跟在最後項目底部」。

**症狀**：magic number 220px 平時多扣 ~47px 留白、橫幅出現時又不夠而溢出；改成 flex 填滿後欄內捲動的「內容被藏起來」感始終沒有消失。

**根因**：「工作台固定佔滿 viewport、各欄內捲」是 IDE／dashboard 的類型化模板。但這個產品的三欄是「內容會隨操作增長的表單」不是「固定面板」，使用者的心智模型是文件流（往下長、整頁捲），不是視窗分割。

**修法**：最終版拿掉所有固定高度，三欄自然增高、整頁捲動，動作鈕跟在內容流末端，checklist rail 改 sticky 保持導引可見。中間那版（釘 footer＋常駐捲軸＋scrollIntoView）的 scrollIntoView 保留了下來。

**學到什麼**：兩層。(1) **佈局假設要拿「內容會長到多大」來驗證，不是拿產品類型套模板**——與 Part 1 #1（Sidebar→TopMenuBar）同族但更貴，因為這次連使用者自己選定的方案都在實際使用一天後推翻。(2) **使用者在選項題裡的選擇是假設不是承諾**——選了「固定高度＋改善捲動」不代表用起來會滿意；佈局決策要做成廉價可逆（這次三改每次都在一小時內完成，正因為高度邏輯集中在少數 class）。

---

## 5. 潛伏的 null 誤報被「更早跑的驗證」曝光

**使用者觸發**：載入既有 config，「固定儲存格／固定值」的 mapping 列全部亮紅框報 `Expected string, received null`——值明明有帶入；重新填一次錯誤就消失。

**症狀**：只有 source_cell／literal 模式的列出錯，訊息是原始英文（沒走 i18n），重新輸入即恢復。

**根因**：Part 2 #1 的 null vs undefined 家族再現。後端 pydantic 對未使用的模式欄位序列化 `"source": null`，前端 Zod `z.string().optional()` 只接受 `undefined` 不接受 `null`。這個 mismatch 一直存在，但過去驗證只在存檔時跑（存檔前使用者必然動過欄位、null 已被改寫）；改版加入 debounced 即時驗證後，「載入即驗證」讓歷史存檔的 null 全面現形。

**修法**：schema 邊界加 `nullishToUndef`（`z.preprocess(v => v ?? undefined, ...)`）套用到 `mapping.source` 與兩處 `sample_filename`；輸出型別不變、後端不動；同一 schema 也治好 Batch 頁 JSON 上傳路徑。

**學到什麼**：**新增「更早、更頻繁跑的驗證」等於把整個歷史資料面重新掃一遍**——驗證邏輯本身沒錯，是它的觸發時機第一次覆蓋到「剛載入、未經使用者觸碰」的資料形狀。往後任何「把驗證提前」的改動，上線前要拿真實存檔資料做載入回歸，不能只測新建流程。同時這條也印證 Part 2 #1 的結語：null/undefined/空字串三態要在 schema 邊界一次橋接，散在 UI 判斷式裡就會一再復發。

---

## 6. 錯誤訊息兩層人性化＋i18n 掃三波才乾淨的守門結論

**使用者觸發**：兩次回報——「錯誤只有 pane 上一個紅色的 2，hover 沒提示，找不到哪列錯」；「`mappings.6.source_cell.address: 需為 Excel 位址` 看不懂，編號還從 0 開始」。

**症狀**：即時驗證只把 issue 數量給了徽章，Zod issue 的 path 資訊在 `countIssuesByStep` 被丟棄；存檔錯誤直接 `path.join(".")` 拼給使用者。

**根因**：驗證管線是「為機器設計的資料」直通「給人看的介面」——中間缺一層翻譯。技術上正確（path 唯一定位了錯誤），對非技術者是密文。

**修法**：`issueHelpers.ts` 兩個純函式：`bucketIssues` 依 path 逐列分桶派發到 MappingRow／JoinsEditor（紅框＋就地訊息，collapsed 也顯示）；`humanizeIssue` 把 `mappings.6` 翻成「欄位「金額」」（用該列 target 欄名，退回「第 7 列」、1-based）。錯誤文案全面白話化（「請選擇填值方式：來源欄位、固定儲存格或固定值」）。

另一條收尾：i18n 硬編碼字串掃了**三波**才乾淨——第一波掃中文 regex、漏掉英文表頭；第二波補英文、又漏 "Headers:"／"+ Source"；第三波才清完。根因是「掃描 regex 只定義了一種違規形狀」。最終以 vitest 守門測試（`i18nGuard.test.ts`，掃 src 內 CJK 字面量、列出檔案行號）把這類回歸永久擋在 CI。

**學到什麼**：(1) **驗證資料要在 display boundary 翻譯成使用者的概念系統**（欄名、1-based），這與 Part 2 #2「錯訊要對應使用者腦中的概念」同一條原則，只是這次錯在「根本沒翻譯」而非「翻譯錯概念」。(2) **同類清掃任務漏兩次，就該把人工掃描升級成自動守門**——規則寫在驗收條款裡會被遺忘，寫成測試才會永遠執行。

---

## 第三部分小結

6 條再次呈現「設計判斷＋迭代踩坑」的交錯：#1–3 是審議桌上避開的錯（wizard、optional-DB、preview 狀態化——都在寫程式前被殺掉，成本是幾段討論）；#4–6 是只有真實使用才會暴露的錯（高度模型、歷史資料的 null、錯誤訊息的受眾），單條修正都在一天內完成。與 Part 1/2 的回望結論一致，且多驗證了一件事：**審議能攔下「結構性的錯」，攔不下「體感性的錯」**——前者靠多角色對抗（wizard 兩位專家同時反對），後者只能靠縮短「上線→回饋→修正」的迴圈（本階段四輪修正平均當天完成）。
