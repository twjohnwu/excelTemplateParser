"""Generate a large (default 1,000,000-row) benchmark dataset modelled on
examples/01_product_pricing, for measuring the openpyxl/pandas worker
pipeline before deciding on a Rust rewrite.

Coverage rule (deterministic on the row index i, 0-based):
    supplier_A covers rows where  i % 10 < 6          (60% of SKUs)
    supplier_B covers rows where  i % 10 >= 3          (70% of SKUs)
    supplier_C covers rows where  2 <= i % 10 <= 8      (70% of SKUs)

All three files, and the primary product_master file, share the same
sheet names / column names as examples/01_product_pricing so the same
config.json mapping applies unchanged. Streaming write-only workbooks are
used throughout so memory stays flat regardless of --rows.

Run:
    ../../backend/.venv/bin/python generate.py --rows 1000000 --seed 42 --out sources/
"""
from __future__ import annotations

import argparse
import random
import time
from pathlib import Path

from openpyxl import Workbook

HERE = Path(__file__).resolve().parent

CATEGORIES = ["集線器", "輸入設備", "影音設備", "儲存裝置", "線材"]

NAME_VOCAB = [
    "USB Type-A 集線器",
    "無線滑鼠",
    "機械鍵盤",
    "HD 視訊鏡頭",
    "隨身碟",
    "行動硬碟",
    "HDMI 線",
    "抗噪耳機罩",
    "SSD 外接盒",
    "桌面集線管理盒",
]

PROGRESS_EVERY = 100_000


def _sku(i: int) -> str:
    return f"SKU{i + 1:07d}"


def _name(i: int) -> str:
    return f"{NAME_VOCAB[i % len(NAME_VOCAB)]} #{i + 1:07d}"


def _category(i: int) -> str:
    return CATEGORIES[i % len(CATEGORIES)]


def write_product_master(path: Path, rows: int, rng: random.Random) -> None:
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("商品主檔")
    ws.append(["SKU", "商品名稱", "分類", "建議售價"])
    for i in range(rows):
        price = rng.randint(100, 9999)
        ws.append([_sku(i), _name(i), _category(i), price])
        if (i + 1) % PROGRESS_EVERY == 0:
            print(f"  product_master: {i + 1:,} / {rows:,}")
    wb.save(path)


def write_supplier(
    path: Path,
    sheet_name: str,
    headers: list[str],
    rows: int,
    factor_lo: float,
    factor_hi: float,
    covers,
    rng: random.Random,
    prices: list[int],
) -> int:
    wb = Workbook(write_only=True)
    ws = wb.create_sheet(sheet_name)
    ws.append(headers)
    count = 0
    for i in range(rows):
        if not covers(i):
            continue
        factor = rng.uniform(factor_lo, factor_hi)
        price = int(round(prices[i] * factor))
        stock = rng.randint(0, 500)
        ws.append([_sku(i), _name(i), price, stock])
        count += 1
        if count % PROGRESS_EVERY == 0:
            print(f"  {path.name}: {count:,} rows written (source index {i + 1:,} / {rows:,})")
    wb.save(path)
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=1_000_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=HERE / "sources")
    args = parser.parse_args()

    if args.rows > 1_048_000:
        raise SystemExit(
            "xlsx sheets cap at 1,048,576 rows (incl. header); "
            f"--rows {args.rows} is too close to that limit for this generator."
        )

    args.out.mkdir(parents=True, exist_ok=True)

    # One RNG per file, all seeded from --seed but offset so files don't
    # produce identical sequences; deterministic given --seed regardless
    # of --rows.
    master_rng = random.Random(args.seed)
    a_rng = random.Random(args.seed + 1)
    b_rng = random.Random(args.seed + 2)
    c_rng = random.Random(args.seed + 3)

    t0 = time.time()
    print(f"Generating {args.rows:,} rows into {args.out} (seed={args.seed})")

    print("product_master.xlsx ...")
    write_product_master(args.out / "product_master.xlsx", args.rows, master_rng)

    # Suggested prices must match product_master's for supplier factor math;
    # re-derive with a fresh RNG seeded identically to master_rng's start.
    price_rng = random.Random(args.seed)
    prices = [price_rng.randint(100, 9999) for _ in range(args.rows)]

    print("supplier_A_quote.xlsx ...")
    count_a = write_supplier(
        args.out / "supplier_A_quote.xlsx",
        "月報價",
        ["貨號", "品名", "單價", "庫存"],
        args.rows,
        0.60,
        0.95,
        lambda i: i % 10 < 6,
        a_rng,
        prices,
    )

    print("supplier_B_quote.xlsx ...")
    count_b = write_supplier(
        args.out / "supplier_B_quote.xlsx",
        "Monthly Quote",
        ["SKU", "Product Name", "Price", "Stock"],
        args.rows,
        0.60,
        0.95,
        lambda i: i % 10 >= 3,
        b_rng,
        prices,
    )

    print("supplier_C_quote.xlsx ...")
    count_c = write_supplier(
        args.out / "supplier_C_quote.xlsx",
        "報價單",
        ["商品編號", "商品名", "Unit Price", "可用庫存"],
        args.rows,
        0.60,
        0.95,
        lambda i: 2 <= i % 10 <= 8,
        c_rng,
        prices,
    )

    elapsed = time.time() - t0
    print(
        f"Done in {elapsed:.1f}s. product_master={args.rows:,} rows, "
        f"supplier_A={count_a:,}, supplier_B={count_b:,}, supplier_C={count_c:,}"
    )


if __name__ == "__main__":
    main()
