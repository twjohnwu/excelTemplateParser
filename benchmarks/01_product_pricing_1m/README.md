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
