# 設計與迭代的反思

`decisions_log.md` 紀錄「我們決定了什麼」——Part 1 是設計階段 22 條轉折、Part 2 是上線後 6 條迭代；本文紀錄「從這些決定中我學到什麼」。前者是事實清單，後者是把事實變成下次能用的判斷。

本文分兩部分：

- **Part 1（教訓 #1–6）**：設計階段的反思。前 5 條純設計判斷，第 6 條 integration smoke 是介於設計與實作的觀察。
- **Part 2（教訓 #7–10）**：上線後迭代階段的反思。四條都是真實使用揭露的判斷力面向，設計階段沒練到。

兩部分以分隔線區隔，結尾「全文回望」把十條（5 + 1 + 4）串成一條判斷力的演化線。

---

## 1. Plan 通過 ≠ 設計定案，預期修正是設計流程的一部分

**四輪 plan mode 都「通過」過，但每一輪通過後使用者都補了東西或改了決定**：

- 第一輪通過 → 「sidebar 改 TopMenuBar」
- 第二輪通過 → 「下載成功後要刪 uploads/ 與 out/」
- 第三輪通過 → 「開發路徑指定 sideProjects/excelTemplateParser/」
- 第四輪通過 → 「decisions_log.md 不要提及使用者類型」、「ConfigBuilder 從 B 改 C」

每一個修正都是 plan 顯式通過後才出現的。如果把 plan 通過當終點（「OK 開始實作」），這些修正會落到實作階段才補。把欄寬從 240 改回沒 sidebar 的 1280，或回頭重設 ConfigBuilder 從 wizard 改三欄，成本相差一個量級。

**學到的**：plan mode 的價值不在「拿到批准」，而在「批准後仍能修正」。流程設計上，「plan 通過」應該是「準備好接受修正」的訊號，不是「鎖定」的訊號。工程師若把「使用者已批准」當作免責的根據，會錯過第二次思考的機會——而第二次思考往往是真正的決策。

這條也通到一個更根本的觀察：**「足夠收斂」與「過度收斂」的界線比想像中接近**。看似很細的 plan 仍然會在送出後被修正，這不是 plan 不夠仔細，而是設計問題本身的特性——只有把答案攤開來，使用者才知道自己原本沒想到的事。

## 2. 使用者反問是設計工具，不是 challenge

**三個關鍵設計轉折都來自使用者反問**：

- 「Redis 掛了會不會掉？」→ 暴露 docker volume + AOF 沒講清楚，催生檔案雙寫架構
- 「服務重啟時使用者要如何知道進度？」→ 暴露 push-only SSE 模型不足，催生 snapshot endpoint + localStorage 追蹤
- 「每步加 try/catch 嗎？」→ 暴露我沒主動講邊界式錯誤處理，催生完整的三層職責模型

這些反問不是「使用者沒搞懂」，是**使用者抓到了工程師沒主動講清楚的部分**。工程師假設「Redis-only 我懂、docker volume 持久化我懂、所以使用者也懂」——這個假設在每個反問裡都被推翻一次。

**學到的**：好的工程師應該主動把使用者會反問的東西先問自己。每一個假設「使用者懂」的點都要驗證；每一個「技術正確但使用者不安心」的設計都要補解釋。反問不是 challenge 而是 gift——它告訴你哪裡沒講清楚、哪裡有未察覺的盲點。

也學到一個操作上的提醒：**收到反問時不要急著辯護，先驗證自己原本的設計是否真的回答了使用者擔心的問題**。在「Redis 掛了會不會掉」這題，第一直覺是想說「不會啊，AOF 有開」，但仔細想會發現使用者的擔憂背後是「我看不到 Redis 怎麼持久化、所以沒信心」——光是「會持久化」這個答案不夠，要把整個 docker volume + AOF + recovery 機制攤開來才能讓他放心。

## 3. 故障場景應該被使用者問題逼出來，而不是事後補

**本系統的續傳、進度可見性、災難復原三條設計，全是被使用者反問逼出來的**——而不是工程師主動想到。

這是個值得反省的點。如果使用者沒問，最終實作會是：
- 沒有 subtask 拆分、整個 job 失敗整個 retry
- 沒有 snapshot endpoint、SSE 斷線使用者就看不到進度
- 沒有 `state.json` 雙寫、Redis volume 一壞所有未完成 job 全數遺失

每一條都會在實作完後的某個「我以為這個情境不會發生」的時刻被使用者踩到。修補成本遠高於設計階段加進去。

**學到的**：**故障場景不是 implementation detail，是 design problem**。在規格階段就應該強迫自己列出至少四種失敗劇本：
- 單一 task 失敗
- Worker 重啟
- 整個服務重啟
- 持久化層損壞

對每一種劇本，明確回答「使用者看到什麼、系統做什麼」。這個練習很容易在「規格寫完爽快」的氣氛下被跳過，但跳過的代價會在實作或上線後加倍償還。

本系統的故障場景晚加，是因為初期假設「不會壞或壞了再說」這個 unrealistic 前提——這正是**對極端情境的設計留白等於把問題留給未來的自己**。

## 4. 「輕量」是設計成本，不是預設值

整個設計過程反覆做出「不裝什麼」的決定：

- 不用 Postgres（Redis-only）
- 不用 Celery（RQ 就夠）
- 不用 Mantine / AntD（shadcn copy-paste）
- 不引入工作流引擎（state.json + RQ 自己組）
- 不做使用者帳號、多租戶、雲端部署（明寫 Out of Scope）

每一個「不」都減少了一個依賴、一份學習成本、一條失敗路徑。但每一個「不」都要付設計成本——你要先想清楚「不裝這個會在什麼情況下後悔」，然後寫進 Scaling Triggers 段落作為未來升級路徑。

**學到的**：輕量不是預設值。預設值是「順手加」——加個 Postgres 反正以後可能要、加個 UI library 反正能省時間。要做到輕量，每一個「不加」都是有意識的選擇，需要 justification。

這條也讓我重新評估「複雜度的隱性稅」：

- Postgres 帶來的稅：schema migration、ORM、連線池、JSON 欄位的設計選擇、運維
- Mantine 帶來的稅：套件升級、設計系統綁定、客製成本、bundle 大小
- Celery 帶來的稅：broker 選擇、序列化、worker pool 設定、debug 複雜度

每一個「以後可能要」其實是個複合稅。Decision 越早做、越容易被認為「成本不高」，但複合下來這些稅是當下 90% 設計能量的去向。**輕量等於把這些稅都繳清**。

## 5. Visual Companion 改變了討論顆粒度

第四輪採用 Visual Companion（瀏覽器同步顯示 mockup）後，討論的顆粒度發生質變。

**前三輪純文字討論時**，問題是：「ConfigBuilder 要 wizard 還是 workbench？」我能描述「workbench 是三欄式工作台，左邊來源樹、中間 join、右邊映射」，但這段文字使用者讀完還是模糊——他要在腦中拼湊三欄長什麼樣、密度感如何、字級與留白比例對不對。最後選擇基於「聽起來合理」而非「看起來合理」。

**第四輪用視覺後**，問題變成：「請看這三張 mockup，選一個。」使用者 30 秒內看完，且能精準指出「A 的灰階留白凸顯重點 + C 的選中態底色提示，我兩者都要」這種混搭意向。前者是「合不合理」的概念判斷，後者是「對不對」的視覺判斷——後者快、準、有 actionable detail。

更關鍵的是**翻轉的可能性**。第二個視覺問題（ConfigBuilder 佈局），使用者第一次選 B（wizard），看完 C 的 mockup 後立刻補一句「上一題我漏講了，我覺得 C 的設計很好」。這種翻轉用文字描述很難達到——文字描述下使用者會被自己的第一直覺鎖住，視覺面前他能直接比較。

**學到的**：視覺溝通是設計協作的乘數。對「樣子問題」（佈局、密度、留白、配色），mockup 永遠贏文字描述。對「概念問題」（選 wizard 還是 workbench 的取捨理由），文字仍然必要。**判斷哪個問題是「樣子問題」、哪個是「概念問題」**，決定了該不該開瀏覽器。

這條也牽出一個更廣的觀察：**設計工具的選擇影響設計能達到的精度**。純對話能達到 70% 精度，文字 + ASCII 能達到 80%，並排 mockup 能達到 95%。如果工程師只用對話來設計 UI，先天就限制了能達到的精度上限。

---

## 6. Unit test 全綠 ≠ 系統能跑：integration smoke 是最後一道（也是最關鍵的）

§8 verification 在實作完成後跑 `docker compose` 端到端 smoke test，**立刻抓到三個 unit test 全程沒露面的 race condition**：

- `finalize_job` 在 RQ queue 中排在 subtasks 之後，但實際被 worker 先 pop 出來執行——看到 0/3 terminal 就 early return，再無人觸發；ZIP 永不產生
- 4 個 worker 並行 read-modify-write 同一個 `state.json`，最後寫贏覆蓋其他更新；3 個 subtask 都成功但 snapshot 顯示 `done=2/3`
- `docker compose restart worker` 後 RQ 拒絕新 process 啟動，因為 Redis 還記得舊的 `worker-0` 名字

**這三個都是 unit test 摸不到的問題**。Unit 用 fakeredis + 單線程同步呼叫，沒有 RQ queue 排程、沒有真正的檔案系統並行寫、沒有 process 命名衝突。整個 backend 117 個 unit test 全綠，端到端 smoke 一跑就 `0/3 done`。

修法都很短（`fcntl.flock`、worker name 加 PID + uuid、`mark_done` 回傳 `is_last` 由最後完成者再 enqueue `finalize_job`），但**沒 integration test 就抓不到**。

更深一層：這三個 race 都不是寫程式時想得到的問題。它們只在「多 process、真檔案、queue 排序」的環境組合下才出現。**規格階段就該識別「unit test 摸不到的點」**——本案至少是 (1) 多 worker 並行寫同一檔案、(2) RQ 任務依賴順序、(3) Redis 對 process 名稱的記憶——把對應的 integration smoke 寫進驗證清單**前段**而非當補充。

也學到反面：unit test 不是沒用。它在「core 純函式對不對」這個維度提供 117 個固化保證，讓我修 race 時不擔心倒退（修完後 unit test 仍 117 全綠）。**Unit test 與 integration test 不互相替代，是兩種不同顆粒度的保險**，缺一不可。

如果這個專案還要長下去，下次設計階段我會列一份「Integration Test 觸發條件矩陣」——對每個併發、跨 process、檔案系統互動點，預先列出必須跑的端到端劇本，而不是「等 unit test 通過再說」。

---

## 把六條串起來（Part 1 結語）

Plan 通過後仍需修正（1）告訴我**收斂不是設計的目的**；使用者反問是設計工具（2）告訴我**主動把假設攤開**；故障場景該被逼出來（3）告訴我**極端情境是設計問題不是實作問題**；輕量是設計成本（4）告訴我**每個「不裝」都要有 justification**；Visual Companion 改變顆粒度（5）告訴我**工具選擇限制了精度上限**；Integration smoke（6）告訴我**unit 全綠是必要但遠遠不充分**。

這六條是設計階段（含實作驗證）讓我看清楚的東西。下一次面對類似的「使用者貼出五行需求 + 四個開放問題」的起點，這六條會直接影響我的設計流程：

- 預期至少四輪修正，不要把第一輪 plan 當定案
- 主動把使用者會反問的點先攤開講
- 規格階段強迫列四種失敗劇本
- 每個「加什麼」都要先回答「不加會怎樣」
- 「樣子問題」直接開 mockup，不要硬用文字
- 規格階段就列 Integration Test 觸發條件矩陣，併發/跨 process/檔案系統的劇本不能等實作完才補

Part 1 在這裡結束。系統上線後使用者用真實 config 跑批次，又揭露三條設計階段沒練到的判斷力面向——見 Part 2。

---

## 7. 加 feature 是檢驗既有抽象的試金石

`source_cell` mode（`decisions_log.md` Part 2 #4）暴露了一件事：原本「source 抽象」只覆蓋 dataframe pipeline（parser → joiner → mapper），完全沒覆蓋「絕對位址 cell 讀取」這條獨立路徑。設計階段沒這個情境，所以從沒被質疑；上線後使用者拿真實 ERP metadata sheet（cell 在 header 之上、沒 header 可選）來用，整條舊抽象就遮不住了。

修法不是一次到位，而是分四層拼回：schema 加 `SourceCell` model、worker 加 `_resolve_source_cells()` 預先解析、mapper 拆三條分支、preflight + worker 都用 `df_needed_aliases()` 過濾。其中第四點（`df_needed_aliases`）還是上線後第二輪修正（#6）才浮現的——當時 #4 沒徹底切乾淨 fork。

**學到的**：下次新加任何 mode 前先問——「這個新東西是擴既有抽象、還是開新抽象？」如果是擴：schema 加欄位、callers 加分支就夠。如果是開新抽象：必須連各層的迴圈條件、required column 收集、parser 必要性都重設。`source_cell` 是後者但實作時當前者處理，所以才有 #6 這個延伸補丁。「擴 vs 開」的判斷不能含糊，含糊就會 partial fork。

這條跟教訓 #2「主動把假設攤開」是同一條判斷力的延伸——設計階段是攤開「使用者會反問什麼」，這條是攤開「新 feature 會穿透哪幾層舊抽象」。

## 8. 邊界（broaden）與護欄（narrow）是並進的

broadcast 規則在三條迭代裡反覆變動：

- 原本（設計階段）：「未連通的 source 應該報錯」是 implicit assumption，joiner 直接靜默丟棄
- 上線後 #2：使用者點破「那欄不用 join、是固定單欄來源」→ broaden 容忍度，1 列 source 自動廣播為常數欄
- 上線後 #6：使用者繼續用真實 config 推到 source_cell-only 情境 → narrow 容忍度回去，但 narrow 在另一條軸（「source_cell-only 應該完全跳過 broadcast 檢查」）

同樣模式在錯訊精度（#2 #3）也出現：原本「映射來源欄位不存在」一個訊息覆蓋全部 → 拆出兩個分支對應兩種真實情境（欄位真的拼錯 vs alias 整個沒進來）。

**學到的**：好的設計不是一次到位，是準備好讓邊界跟著使用情境動。「設計反覆」與「邊界 sharpen」表面相似、本質不同——前者是搖擺、後者是收斂。判斷自己屬於哪一種的方法是看：每次調整有沒有對應到新出現的具體情境？如果有，就是 sharpen；如果只是反覆換立場、沒有新情境驅動，那才是設計反覆。

這條也讓我重新評估設計階段教訓 #1「Plan 通過 ≠ 設計定案」——當時的「修正」與這裡的「邊界調整」是同類動作，只是發生在不同階段。**收斂不是設計的目的**，這句話設計階段適用、上線後一樣適用。

## 9. Optional 欄位的每個 access 都該有護欄

`decisions_log.md` Part 2 #5 的 NoneType.partition 崩潰示範了一個典型的潛伏雷：schema 把 `Mapping.source` 定義成 `Optional[str]`，但呼叫端 `m.source.partition(".")` 沒護欄。literal mapping 一直以來都會在這條路徑中招（使用者沒踩過所以沒爆），新加的 source_cell 把它暴露出來。

修法很短（一行 `if m.source is not None`），但教訓不在修法、在預防：

**沒 strict mypy 的專案，這條 hand rule 比較實在**：每次寫 `m.foo.bar()` 之前先想「foo 可能是 None 嗎？」可能有兩種：
- 是 Optional 但邏輯上保證在此處不為 None：寫個 `assert m.foo is not None` 把假設明寫
- 是 Optional 且可能為 None：寫條件分支處理

這跟設計階段教訓 #2「stack trace 不要被 try/catch 吞」是同一條設計判斷力的不同切面——都來自「不假設下游能保證上游的 invariant」。try/catch 是假設「我能處理所有錯誤」、`.partition()` on Optional 是假設「上游給我的不會是 None」。兩種假設都會在 corner case 被打破。

更廣的版本：**型別系統的標記只是宣告意圖，不等於執行保護**。Optional / Union / Generic 都需要呼叫端配合處理。在沒有 strict 型別檢查的環境，這個配合靠人工 review；review 漏掉就會變成這條 #5 這種潛伏雷。下次設計階段該主動列「Optional 欄位清單 + 每個 access 點是否有護欄」作為 review checklist。

## 10. 自動行為對「空輸入」與「初始 mount」這兩個邊界必須明確表態

`decisions_log.md` Part 2 #8 的四連環 bug 展示了一個更廣的設計問題：autosave 這類自動行為，沒對「state 是空」與「mount tick 時 state 還沒同步」這兩個邊界明確表態，每個未表態的角落都會變成 race。每個 sub-bug 是同一原則的不同切面：

- **8a**：mount tick 也觸發 autosave、把暫存 emptyState 寫進 localStorage——「mount 邊界」沒考慮
- **8b**：autosave 沒對「state 真的空」做特殊處理——「空輸入邊界」沒考慮
- **8c**：8b 的「空」判斷誤把 emptyState 預設的 default source 當「有內容」——「空的定義」沒對齊資料結構真實
- **8d**：「空時主動 removeItem」越權——「自動行為的影響範圍邊界」沒收斂

學到的：自動行為（autosave / autoload / autoclean 任何）設計時必須對下列邊界明確表態：

- **空輸入邊界**：state 等同初始值時要做什麼？無動作？清理？寫入空值？
- **初始 mount 邊界**：state 從建構函式拿到的瞬間，是「使用者意圖」還是「框架預設」？autosave 該不該觸發？
- **影響範圍邊界**：自動行為能改動哪些儲存路徑？只寫新值、還是也能刪舊值？

`localStorage.removeItem` 是寫操作的最危險形式——它毀掉資訊。把這個動作收斂到「使用者明示操作」這條 invariant，比靠多重 guard 來避免誤刪安全得多。8d 的正解（autosave 在空 state 時純 no-op、`removeItem` 只剩明示路徑）就是這條 invariant 的具體實現。

跟 #2「使用者反問是設計工具」直接呼應：#8 的四連環就是使用者反覆把實際操作打進來、每次都揭露我修法的一個盲點。如果只用我自己的測試（mount 後立刻點還原），永遠不會踩到 8d；正是使用者「dwell 5 秒再切走」這種真實 timing 才打出來。也跟 #6「unit test 全綠 ≠ 系統能跑」呼應——這次以前端的「mount tick × state-dep effect × localStorage」三維交集形式出現，比後端的多 worker race 更難在 jsdom 環境中重現。

---

## 全文回望：十條的合一

設計階段五條（+ 一條過渡到實作）+ 迭代階段四條，合起來呈現一個系統的判斷力如何在不同階段以不同形式出現：

| 階段 | 教訓編號 | 判斷力核心 |
|---|---|---|
| 設計階段 | 1–5 | 對「假設過度收斂」保持警覺、把直覺鏈條拆開檢驗 |
| 過渡到實作 | 6 | unit test 全綠 ≠ 系統能跑；併發/檔案系統劇本要在規格階段就列 |
| 迭代階段 | 7–10 | 新 feature 是檢驗既有抽象的試金石；邊界 broaden/narrow 並進；Optional 欄位每個 access 都該有護欄；自動行為對「空輸入」與「初始 mount」邊界必須明確表態 |

設計階段的判斷力被**使用者反問**激活；迭代階段的判斷力被**真實資料**激活。兩者共通的底層：對「假設過度收斂」保持警覺，並把每一次反問或失敗當作下次少踩坑的素材。

對比看出來的一件事是——**設計階段的功夫直接決定了迭代階段能多省**。設計時定下的邊界式錯誤處理（Decision #6）讓 #5 的 NoneType bug 五分鐘內就找出根因（grep request_id → 看 traceback → 直接看到行號）。設計時定下的 user_message / tech_detail 分流（Decision #6）讓使用者拿到的訊息可以直接指出怎麼修。如果這些設計階段沒做，迭代階段每條 issue 的成本會翻三倍。

另一條跨階段觀察：**unit test 環境沒有的東西，使用者環境一定會有**——dwell time / mount-tick / 多 tab 切換 / dark mode 切換都屬於這類。設計階段 #6 學的「integration smoke 是最後一道」在 #8 完整重現於前端 race；下次規格階段該主動列「unit test 環境缺什麼」清單作為 integration 測試觸發條件。

下次面對類似專案，要做的不只是 Part 1 的 6 條 checklist：

- 預期至少四輪 plan 修正，不要把第一輪當定案
- 主動把使用者會反問的點先攤開講
- 規格階段強迫列四種失敗劇本
- 每個「加什麼」都要先回答「不加會怎樣」
- 「樣子問題」直接開 mockup，不要硬用文字
- 規格階段就列 Integration Test 觸發條件矩陣

還要預期 Part 2 的 4 條 iteration-phase 動作：

- 加新 mode / feature 前先判斷「是擴既有抽象、還是開新抽象」——後者要連各層迴圈條件、required field 收集、pipeline 必要性都重設
- 邊界規則 broaden / narrow 是健康，但要看是「新情境驅動」還是「立場搖擺」
- 每個 Optional 欄位的 access 都要有護欄，沒 strict mypy 的專案要靠 hand rule
- 自動行為（autosave / autoload）必須對「空輸入」「初始 mount」「影響範圍」三個邊界明確表態；把毀資訊性的動作（removeItem）收斂到使用者明示路徑

這就是這個專案（從設計到上線後迭代）教我的東西。
