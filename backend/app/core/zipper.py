"""Pack a directory of xlsx outputs (and a summary text) into a single ZIP."""

from __future__ import annotations

import zipfile
from pathlib import Path


def pack(out_dir: str | Path, zip_path: str | Path, summary: str | None = None) -> Path:
    """Create `zip_path` from all files in `out_dir`. Optionally embed `_summary.txt`.

    Returns the absolute path to the created zip.
    """
    out_dir = Path(out_dir)
    zip_path = Path(zip_path)
    zip_path.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if summary is not None:
            zf.writestr("_summary.txt", summary)
        if out_dir.exists():
            for item in sorted(out_dir.iterdir()):
                if item.is_file():
                    zf.write(item, arcname=item.name)

    return zip_path
