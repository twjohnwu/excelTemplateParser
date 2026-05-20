import zipfile

from app.core import zipper


def test_pack_creates_zip_with_files(tmp_path):
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "a.xlsx").write_bytes(b"x")
    (out_dir / "b.xlsx").write_bytes(b"y")

    zip_path = tmp_path / "result.zip"
    zipper.pack(out_dir, zip_path)

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    assert "a.xlsx" in names
    assert "b.xlsx" in names


def test_pack_includes_summary(tmp_path):
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "a.xlsx").write_bytes(b"x")

    zip_path = tmp_path / "result.zip"
    zipper.pack(out_dir, zip_path, summary="4 done / 1 failed")

    with zipfile.ZipFile(zip_path) as zf:
        assert "_summary.txt" in zf.namelist()
        assert zf.read("_summary.txt") == b"4 done / 1 failed"


def test_pack_empty_dir_creates_empty_zip(tmp_path):
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    zip_path = tmp_path / "result.zip"
    zipper.pack(out_dir, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.namelist() == []


def test_pack_creates_parent_dirs(tmp_path):
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "a.xlsx").write_bytes(b"x")
    zip_path = tmp_path / "deep" / "nested" / "result.zip"
    zipper.pack(out_dir, zip_path)
    assert zip_path.exists()
