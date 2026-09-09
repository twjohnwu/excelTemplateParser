---
source: extracted from the excelTemplateParser frontend during the create-project-wizard STDD uiux phase
date: 2026-09-09
tags: [frontend, design-system, shadcn, tailwind, i18n]
---

# Frontend UI Conventions — excelTemplateParser

本文件從現行 `frontend/` 程式碼與 `STDD/create-project-wizard/design-ux.md`
（吸收其中可跨畫面重用的一般性原則）萃取而成，不是新設計。任何未來功能的
uiux 階段應先引用本文件，再視需要補新規則——不得重新推導已存在的慣例。

## 1. 設計 token

顏色 token 定義於 `frontend/src/index.css:6-45`（light 區塊第 6-25 行、dark 區塊
`[data-theme="dark"]` 第 27-45 行），透過 `tailwind.config.js:7-37` 對應為
Tailwind color class：

| Token | 用途 |
|---|---|
| `--background` / `--foreground` | 頁面底色與本文文字色（`index.css:7-8`） |
| `--card` / `--card-foreground` | 卡片容器底色與文字色（`index.css:9-10`） |
| `--primary` / `--primary-foreground` | 主要操作（如主按鈕）底色與文字色（`index.css:11-12`） |
| `--secondary` / `--secondary-foreground` | 次要操作底色與文字色（`index.css:13-14`） |
| `--muted` / `--muted-foreground` | 次要/弱化資訊底色與文字色（`index.css:15-16`） |
| `--accent` / `--accent-foreground` | hover 態強調底色與文字色（`index.css:17-18`） |
| `--destructive` / `--destructive-foreground` | 錯誤/危險狀態底色與文字色（`index.css:19-20`） |
| `--border` / `--input` | 邊框與表單控件邊框（`index.css:21-22`） |
| `--ring` | focus-visible 外框色（`index.css:23`） |
| `--radius` | 圓角推導基準，`0.5rem`（`index.css:24`） |

圓角推導：`tailwind.config.js:38-41` 從 `--radius` 推導三階——
`lg: var(--radius)`、`md: calc(var(--radius) - 2px)`、
`sm: calc(var(--radius) - 4px)`。新元件的圓角一律用這三階，不直接寫像素值。

間距規則：一律使用 Tailwind 預設 spacing scale（`gap-*`／`space-y-*`／`p-*`／
`px-*`／`py-*` 等步階類別），不使用任意像素值。實例：
`ConfigBuilder.tsx:416` 的 `flex flex-col gap-3`（區塊間標準垂直間距）、
`ConfigBuilder.tsx:537` 的 `rounded-xl border bg-card p-8 shadow-sm text-center
max-w-md w-full space-y-6`（卡片外距 `p-8` + 卡片內垂直節奏 `space-y-6`）。

## 2. 字級層級

實際在用的字級層級（皆為既有 Tailwind utility class，未新增字級）：

| 層級 | 類別 | file:line |
|---|---|---|
| 標題（如 onboarding 卡片標題） | `text-xl font-semibold` | `ConfigBuilder.tsx:538` |
| 說明段落／helper 文字 | `text-sm text-muted-foreground` | `ConfigBuilder.tsx:539` |
| 欄位標籤 | `text-sm font-medium leading-none` | `label.tsx:8` |
| 區塊級錯誤文字 | `text-sm text-destructive` | `ConfigBuilder.tsx:528` |
| 逐欄錯誤文字 | `mt-0.5 text-xs text-destructive` | `ConfigBuilder.tsx:482` |
| 步驟導覽項目文字 | `text-xs` | `ChecklistRail.tsx:30` |

## 3. 互動狀態

每個可互動元素必須定義四態：hover / focus-visible / active / disabled。

focus-visible 一律沿用 `--ring` token 的樣式組合（`index.css:23` 定義色值，
`button.tsx:8` 定義套用方式）：
`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
focus-visible:ring-offset-2`。

其餘三態的既有先例：
- hover：依元素語意變化，如 `hover:bg-primary/90`（`button.tsx:12`）、
  `hover:bg-accent`（`ChecklistRail.tsx:30`）。
- active：目前程式碼沒有自訂 `:active` 樣式的先例，沿用瀏覽器原生 `:active`
  ——**尚無先例**（未見自訂 active 樣式，故不捏造）。
- disabled：`disabled:pointer-events-none disabled:opacity-50`
  （`button.tsx:8`）。

**disabled 的用途界定**：`disabled` 只用於標記「操作正在進行中」（例如送出中
避免重複點擊），不得用來封鎖導覽或封鎖尚未完成的前置步驟。本專案的既有裁決是
「不封鎖」——步驟導覽項目「不設 disabled（不封鎖，任一項永遠可點擊）」
（`STDD/create-project-wizard/design-ux.md:377`）。任何新畫面若想用 disabled
擋住使用者前進，先確認是不是在做「阻擋」而非「進行中」，前者違反本專案慣例。

## 4. 點擊區大小

本產品桌面限定，不採用行動裝置 44px 觸控下限。`App.tsx:18` 於
`window.innerWidth < 640` 時整頁改顯示過窄提示，不支援窄螢幕/觸控裝置
（此規則的強制點即在 `App.tsx:18` 的 `onResize` 判斷式）。

以既有 shadcn `Button` 尺寸作為滑鼠操作下限（`button.tsx:20-23`）：

| 用途 | 類別 | 高度 |
|---|---|---|
| 一般操作 | `default`（`button.tsx:20`） | `h-9` = 36px |
| 次要/密集操作 | `sm`（`button.tsx:21`） | `h-8` = 32px |
| 重點終點操作 | `lg`（`button.tsx:22`） | `h-10` = 40px |
| 純圖示按鈕 | `icon`（`button.tsx:23`） | `h-9 w-9` = 36×36px |

行內連結型操作（例如摘要頁的「修改」連結）不可只做行內底線文字——點擊區域
過窄，至少提供與 `sm` 按鈕相同的最小可點擊高度 32px（`button.tsx:21`）。

## 5. 對比度

本專案不對既有配對聲稱已驗證通過任何 WCAG 等級，只誠實揭露現況：

- 本文（`--foreground` on `--background`，`index.css:8` on `index.css:7`）
  明度差大，對比度足夠。
- 次要文字（`--muted-foreground` on `--background`，`index.css:16` on
  `index.css:7`）是目前已出貨配對中對比度最弱的一組（灰階中明度對純白），
  實例見 `ChecklistRail.tsx:41` 的 pending 態文字、`ConfigBuilder.tsx:539`
  的說明文字。本文件無法在紙面上實測精確比值，只陳述事實：這是既有元件庫
  的既定組合，未經量測聲稱通過 AA。
- 行內錯誤文字（`--destructive` on `--background`，`index.css:19` on
  `App.tsx:36` 的 `bg-background`，實例 `ConfigBuilder.tsx:528-529`）淺色
  主題下約 3.9:1，是承載有意義文字中對比度最弱的配對。

**規則**：未來設計若使用既有 token 配對，不必重新量測；若引入新配對，必須
揭露「未量測」或提供實測比值，不得直接聲稱「符合 WCAG AA」而未經驗證。

## 6. 語意色

狀態語意色定義於 `ChecklistRail.tsx`：

| 狀態 | 視覺 | file:line |
|---|---|---|
| 完成（done） | `text-emerald-600 dark:text-emerald-400` 打勾圖示 | `ChecklistRail.tsx:33` |
| 有問題（attention） | `bg-destructive` 實心徽章 + `text-destructive-foreground` 文字 | `ChecklistRail.tsx:35` |
| 待處理（pending，隱含第三態） | `text-muted-foreground` | `ChecklistRail.tsx:41` |

新畫面若需要呈現「完成/待處理/有問題」三態，直接沿用這組語意色，不重新定義。

## 7. 文案與 i18n

所有使用者可見文案一律是 i18n key，兩個語言檔並存且行數一致：
`frontend/src/i18n/zh-TW.json`（192 行）與 `frontend/src/i18n/en.json`
（192 行）。

命名慣例：以功能區塊為第一層 namespace，第二層為欄位/動作名，例如
`app.*`（`zh-TW.json:1-6`，全域殼層文案）、`jobs.*`（工作/批次相關）、
`config.*`（設定編輯器相關）、`mapping.*`（欄位對應相關）、`batch.*`
（批次執行相關）。新功能比照此模式開新的第一層 key，不得把不同功能的文案
塞進既有 namespace。

**定義自身名詞的規則**：文案不得假設使用者已具備背景知識，凡文案中用到
受控名詞（例如「工作表」「alias」「join」等領域詞），第一次出現時必須在
文案本身內附一句白話定義，不得用彈窗或 tooltip 藏起來
（`STDD/create-project-wizard/design-ux.md:112` 的 glossary 機制）。這條
規則適用於任何未來畫面的文案設計，不限於精靈功能。

## 8. 既有元件清單

`frontend/src/components/ui/` 現有原件，新功能應優先重用而非另建：

- `button.tsx` — 按鈕（`default`/`destructive`/`outline`/`secondary`/
  `ghost`/`link` 五種 variant，四種 size）
- `dialog.tsx` — 對話框
- `dropdown-menu.tsx` — 下拉選單
- `input.tsx` — 文字輸入框
- `label.tsx` — 表單標籤
- `select.tsx` — 選擇器
- `tabs.tsx` — 分頁切換

## 9. 空狀態

空狀態必須說明「接下來該做什麼」，並提供具體的下一步入口（連結或 CTA），
不得只是一段靜態文字。既有先例：
`config.onboarding` 卡片（`ConfigBuilder.tsx:537-538`）在沒有草稿/沒有設定
名稱時顯示三步驟引導卡，取代空白畫面。

**空狀態不是阻擋的替代品，也不是本專案的封鎖模式**：本專案的既有裁決是「不
允許用阻擋擋住使用者」（`STDD/create-project-wizard/design-ux.md:62-64`：
前置條件未完成時顯示資訊性空狀態並提供快速跳回連結，「絕不出現『請先完成
上一步』式的阻擋或禁用按鈕」）。任何新畫面遇到前置資料未就緒的情境，正確
做法是顯示空狀態 + 導覽連結，而不是停用操作或跳出阻擋訊息。
