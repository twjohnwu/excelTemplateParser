"""Run the conversion pipeline in-process (no RQ/Redis/HTTP) against a
benchmark folder, for baseline timing.

Usage:
  backend/.venv/bin/python benchmarks/01_product_pricing_1m/run_local.py \
      [--preserve-styles true|false] [--chunk 10000] [--dir <benchmark_dir>]

Builds a scratch job_dir layout (uploads/primary, uploads/lookup,
uploads/target.xlsx) from <dir>/sources/*.xlsx + <dir>/template.xlsx per
config.json's sample_filename fields, then calls
app.workers.tasks._execute(...) directly — the same function run_subtask
calls, minus the Redis/JobService/RQ wiring.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

BENCH_DEFAULT = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DEFAULT.parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas import ConfigSchema  # noqa: E402
from app.workers.tasks import _execute  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preserve-styles", choices=["true", "false"], default=None)
    ap.add_argument("--chunk", type=int, default=10000)
    ap.add_argument("--dir", type=Path, default=BENCH_DEFAULT)
    args = ap.parse_args()

    bench_dir = args.dir.resolve()
    # Output always lands in this script's own benchmark folder (allowed-paths
    # constraint), never under --dir, so pointing --dir at examples/ for a
    # smoke test doesn't write outside benchmarks/01_product_pricing_1m/.
    out_dir = BENCH_DEFAULT / "out"
    label = "" if bench_dir == BENCH_DEFAULT else f"{bench_dir.name}_"
    config_data = json.loads((bench_dir / "config.json").read_text(encoding="utf-8"))
    if args.preserve_styles is not None:
        config_data["target_template"]["preserve_styles"] = args.preserve_styles == "true"
    config = ConfigSchema.model_validate(config_data)

    mode = "styled" if config.target_template.preserve_styles else "write_only"

    job_dir = out_dir / f".jobdir_{label}{mode}"
    if job_dir.exists():
        shutil.rmtree(job_dir)
    (job_dir / "uploads" / "primary").mkdir(parents=True, exist_ok=True)
    (job_dir / "uploads" / "lookup").mkdir(parents=True, exist_ok=True)

    shutil.copy(bench_dir / config.target_template.sample_filename, job_dir / "uploads" / "target.xlsx")

    primary_spec = next(s for s in config.sources if s.role == "primary")
    primary_file = primary_spec.sample_filename
    shutil.copy(
        bench_dir / "sources" / primary_file, job_dir / "uploads" / "primary" / primary_file
    )
    for spec in config.sources:
        if spec.role != "primary":
            shutil.copy(
                bench_dir / "sources" / spec.sample_filename,
                job_dir / "uploads" / "lookup" / f"{spec.alias}.xlsx",
            )

    out_path = out_dir / f"{label}{mode}.xlsx"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Running mode={mode} chunk={args.chunk} dir={bench_dir}")
    started = time.monotonic()
    _execute(job_dir, primary_file, config, out_path, chunk_size=args.chunk)
    elapsed = time.monotonic() - started
    print(f"Wall time: {elapsed:.2f}s")
    print(f"Output: {out_path}")

    shutil.rmtree(job_dir)


if __name__ == "__main__":
    main()
