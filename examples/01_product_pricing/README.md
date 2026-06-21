# 01 — Product Pricing: Master Catalog × Supplier Quotes

> **Scenario**: You maintain a 20-SKU product catalog (computer peripherals). Three suppliers send monthly quotes — each in **a different column-naming convention**, and each quote covers only **part** of your catalog. You need a single comparison sheet that lines up every product against every supplier, **including products nobody quoted this month** (so you know what's missing).

## What this example demonstrates

- **One primary, three lookups with mismatched field names** — `貨號` vs `SKU` vs `商品編號`; `單價` vs `Price` vs `Unit Price`. Define the mapping once in `config.json`, reuse forever.
- **Outer join** (introduced in v0.2.0) keeps every row from the master, even when a supplier has no matching quote. The cells just stay empty — you can scan the output and immediately spot which products are uncovered.
- **Per-supplier coverage is intentionally uneven**:

  | SKU range | A | B | C | # products |
  |-----------|---|---|---|------------|
  | SKU001–002 | ✓ |   |   | 2 (A only) |
  | SKU003–005 | ✓ |   | ✓ | 3 (A+C)    |
  | SKU006–012 | ✓ | ✓ | ✓ | 7 (all three) |
  | SKU013–015 |   | ✓ | ✓ | 3 (B+C)    |
  | SKU016–018 |   | ✓ |   | 3 (B only) |
  | SKU019–020 |   |   |   | **2 — no quotes at all** |

  After the run, `expected_output.xlsx` shows 20 rows. SKU019 and SKU020 keep `A報價 / B報價 / C報價` empty — that's the outer-join's value.

## Files

```
01_product_pricing/
├── README.md            # this file
├── generate.py          # regenerates the mock xlsx files (deterministic)
├── config.json          # mapping definition
├── template.xlsx        # target template (7 columns, header on row 1)
├── expected_output.xlsx # what the tool produces for these inputs
└── sources/
    ├── product_master.xlsx     # primary: 20 SKUs (商品主檔)
    ├── supplier_A_quote.xlsx   # 12 SKUs, columns: 貨號 / 品名 / 單價 / 庫存
    ├── supplier_B_quote.xlsx   # 13 SKUs, columns: SKU / Product Name / Price / Stock
    └── supplier_C_quote.xlsx   # 13 SKUs, columns: 商品編號 / 商品名 / Unit Price / 可用庫存
```

## How to run

1. Start the stack: from the repo root, `docker compose -f deploy/compose/docker-compose.yml up`
2. Open `http://localhost:5173`
3. **Project Settings**: choose **Load from JSON**, pick this folder's `config.json`. Verify the four sources and three outer-joins are listed.
4. **Batch Convert**:
   - **Target template**: `template.xlsx`
   - **master** (primary): `sources/product_master.xlsx`
   - **supplier_a** (lookup): `sources/supplier_A_quote.xlsx`
   - **supplier_b** (lookup): `sources/supplier_B_quote.xlsx`
   - **supplier_c** (lookup): `sources/supplier_C_quote.xlsx`
5. Run. Download the ZIP — the output sheet should match `expected_output.xlsx`.

## Re-running each month

This config is **time-independent**. Next month, replace the three supplier xlsx files with whatever they send (same field names, just new prices) and re-run. The mapping stays the same.

## Regenerating the mock data

The xlsx files are committed for convenience. To regenerate them deterministically:

```sh
cd examples/01_product_pricing
../../backend/.venv/bin/python generate.py
```
