# 01_product_pricing_1m — 百萬列效能基準資料集

模仿 `examples/01_product_pricing` 的欄位/工作表配置，但把 20 筆商品放大到
預設 100 萬筆，供量測 openpyxl/pandas worker pipeline 在大檔案下的效能，
作為後續是否改寫成 Rust 的決策依據。

## 產生方式

```sh
cd benchmarks/01_product_pricing_1m
../../backend/.venv/bin/python generate.py --rows 1000000 --seed 42 --out sources/
```

`--rows`、`--seed`、`--out` 皆可調整；預設值即為上例。

## 涵蓋規則（依 0-based row index i）

- supplier_A：`i % 10 < 6`（60%）
- supplier_B：`i % 10 >= 3`（70%）
- supplier_C：`2 <= i % 10 <= 8`（70%）

## 檔案大小（100 萬列，seed=42 實跑結果）

見主 session 報告；`sources/` 下四個檔案，`product_master.xlsx` 最大。

## 注意事項

- `sources/*.xlsx` 已被 `.gitignore` 排除，不進版控。
- xlsx 單一工作表上限為 1,048,576 列（含表頭），因此 `--rows` **不可**設定超過約
  1,048,000，否則本產生器會直接中止並報錯。

## 量測方式

```sh
# 在主機端直接呼叫 worker 的 _execute，繞過 50 MB 上傳上限與 10 分鐘 job timeout
/usr/bin/time -l backend/.venv/bin/python benchmarks/01_product_pricing_1m/run_local.py --preserve-styles false
```

輸出落在 `out/`（已 gitignore）。`--preserve-styles true` 會把整本輸出留在記憶體，
百萬列不建議跑。

## 結果（2026-09-28）

機器：2019 MacBook Pro，Intel Core i9-9980HK 8C/16T 2.4 GHz、32 GB RAM、
macOS 13.7.8；同時有 Docker VM（8 cpu / 7.7 GB）在跑。程序在主機端
`backend/.venv`（Python 3.14）執行，非容器內。這是舊款 Intel 機種，Apple
Silicon 單核通常快 2–3 倍，數字視為保守上限。

| 模式 | 列數 | 耗時 | CPU | 峰值 RSS | 輸出 |
|---|---|---|---|---|---|
| `preserve_styles=false`（write_only） | 1,000,000 × 3 lookups | 7 分 09 秒 | 單核 100% | 1.39 GB | 36 MB，1,000,000 列，A/B/C 填值 600k/700k/700k |

修正前（`_primary_is_join_base` 未排除 outer join，逐 chunk 執行 outer join）跑了
1 小時 46 分仍未完成，且輸出會膨脹到約 1.98 億列——見 `docs/decisions_log.md`
第六部分。修正後走全載路徑，剖析顯示剩餘成本約 55% 在 openpyxl 讀取、
30% 在 writer 的 `iterrows` 逐格取值、15% 在 openpyxl 寫入；pandas merge 本身
不到 1%。
