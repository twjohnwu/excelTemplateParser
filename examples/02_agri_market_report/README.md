# 02 — Agri Market Report: Open Data Mashup

> **Scenario**: Taiwan's Ministry of Agriculture (農業部, MOA) publishes daily wholesale trading data for hundreds of agricultural products across dozens of markets. Each trade row is dense with **codes** — a `MarketCode` like `109`, a `TcType` like `N04` — and almost no human-readable labels. To turn this into a daily market report you'd hand to a non-engineer, you need to join the codes against two small lookup tables and lay the result out in a clean template.

## What this example demonstrates

- **Real open-government data** as the primary source — no mocks, no anonymisation.
- **Cross-language column names** in the same config: the API returns English headers (`TransDate`, `CropName`, `Avg_Price`), the lookups use Chinese headers (`市場代碼`, `所在縣市`, `分類`), and the output template uses Chinese (`交易日`, `所在縣市`, `市場`, …). The tool stitches them together via `alias.column` references — no renaming needed.
- **Two-hop enrichment**:
  - `MarketCode` (e.g. `109`) → `市場名稱`, `所在縣市` (台北一, 台北市)
  - `TcType` (e.g. `N04`) → `分類` (蔬菜)
- **Output**: 1,000 trade rows, each enriched with city and category. The market mix shows 957 台北市 rows and 43 新北市 rows; the category mix is 436 蔬菜 / 361 花卉 / 203 水果.

## Files

```
02_agri_market_report/
├── README.md                # this file
├── fetch.py                 # downloads the trade data and regenerates lookups
├── config.json              # 1 primary + 2 left-join lookups
├── template.xlsx            # 市場日報 template
├── expected_output.xlsx     # 1000 enriched rows
└── sources/
    ├── daily_trades.xlsx    # primary: 1000 rows, ROC 114.06.18 (2025-06-18)
    ├── market_codes.xlsx    # lookup: market code → 市場名稱, 所在縣市
    └── tc_type_codes.xlsx   # lookup: TcType → 分類
```

## Data source & licence

- **Primary data**: [農業部資料服務平台 — 農產品交易行情](https://data.moa.gov.tw/api/v1/AgriProductsTransType/), fetched for ROC 114.06.18 (Gregorian 2025-06-18).
- **Licence**: [政府資料開放授權條款 1.0](https://data.gov.tw/license) — compatible with CC BY 4.0. Free to reuse with attribution.
- **Lookup tables** (`market_codes.xlsx`, `tc_type_codes.xlsx`) are **hand-curated** from publicly available wholesale-market information. They cover only the four markets that appear in the API's first 1000 rows for that date — extend them if you fetch other markets.

## How to run

1. Start the stack: from the repo root, `docker compose -f deploy/compose/docker-compose.yml up`
2. Open `http://localhost:5173`
3. **Project Settings**: choose **Load from JSON**, pick this folder's `config.json`. Verify three sources and two left-joins are listed.
4. **Batch Convert**:
   - **Target template**: `template.xlsx`
   - **trades** (primary): `sources/daily_trades.xlsx`
   - **markets** (lookup): `sources/market_codes.xlsx`
   - **categories** (lookup): `sources/tc_type_codes.xlsx`
5. Run. The output should match `expected_output.xlsx` — 1000 rows of enriched trades.

## Re-running for a different date

Edit `TARGET_DATE` in `fetch.py` (ROC format, e.g. `114.06.25`), then:

```sh
cd examples/02_agri_market_report
../../backend/.venv/bin/python fetch.py
```

The MOA API uses ROC year (Gregorian − 1911). Empty `Data: []` means the market was closed (休市) — try a weekday. The API caps each request at 1000 rows; for higher coverage, filter by `MarketName` and paginate.

## Why left join here (not outer)

This example uses **`left` joins**, not outer. Trades with an unknown `MarketCode` or `TcType` keep their raw codes and the enrichment cells stay empty — which is the right behaviour for a daily report: you don't want phantom rows from the lookup table just because some markets aren't on file. (Example 01 demonstrates outer join, where the inverse is true — you *do* want the empty rows surfaced.)
