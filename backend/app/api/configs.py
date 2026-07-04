"""Config CRUD: list / get / save / delete, plus a stateless dry-run preview."""

from __future__ import annotations

import tempfile
from collections import defaultdict
from pathlib import Path

import structlog
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from starlette.datastructures import UploadFile as StarletteUploadFile

from ..core import preflight, preview
from ..core.exceptions import CoreError
from ..dependencies import get_config_service, get_request_id
from ..schemas import ConfigSchema
from ..services.config_service import ConfigExists, ConfigNotFound, ConfigService

router = APIRouter(prefix="/api/configs", tags=["configs"])
log = structlog.get_logger(__name__)

# Hard cap on preview rows regardless of the client-supplied `n`.
PREVIEW_MAX_ROWS = 100


@router.get("")
def list_configs(svc: ConfigService = Depends(get_config_service)) -> dict:
    return {"configs": svc.list()}


@router.get("/{name}")
def get_config(name: str, svc: ConfigService = Depends(get_config_service)) -> ConfigSchema:
    try:
        return svc.get(name)
    except ConfigNotFound:
        raise HTTPException(status_code=404, detail=f"找不到專案『{name}』")


@router.post("")
def save_config(
    config: ConfigSchema,
    overwrite: bool = Query(default=False),
    svc: ConfigService = Depends(get_config_service),
    request_id: str = Depends(get_request_id),
) -> dict:
    try:
        svc.save(config, overwrite=overwrite)
    except ConfigExists:
        raise HTTPException(
            status_code=409,
            detail={
                "error": f"專案『{config.name}』已存在，是否覆蓋？",
                "code": "ConfigExists",
                "name": config.name,
                "request_id": request_id,
            },
        )
    return {"name": config.name, "request_id": request_id}


@router.delete("/{name}", status_code=204)
def delete_config(name: str, svc: ConfigService = Depends(get_config_service)) -> Response:
    svc.delete(name)
    return Response(status_code=204)


# ---- Preview (stateless dry-run) ----

@router.post("/preview")
async def preview_config(
    request: Request,
    config_json: str = Form(...),
    target_template: UploadFile = File(...),
    n: int = Form(default=20),
):
    """Dry-run the parse → join → map pipeline on the first `n` primary rows.

    Fully stateless: uploads are staged in a private tempdir and deleted in a
    `finally` block. Nothing is written under /data, no job is created, Redis is
    never touched. Runs the same preflight the real job path runs, then calls
    `core.preview.preview_map` (which shares the worker's pipeline functions).

    Returns 200 `{columns, rows, truncated}` or a 422 CoreError shape
    (`{error, code, request_id}`) on validation / preflight failure.
    """
    n = max(1, min(n, PREVIEW_MAX_ROWS))

    # Parse the draft config with the existing pydantic model (no schema changes).
    try:
        config = ConfigSchema.model_validate_json(config_json)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"config_json 解析失敗：{exc}")

    # Group uploaded source files by alias from the raw multipart form
    # (same `sources[<alias>]` key pattern as POST /api/jobs).
    form = await request.form()
    grouped: dict[str, list[UploadFile]] = defaultdict(list)
    for key, value in form.multi_items():
        if key.startswith("sources[") and key.endswith("]") and isinstance(value, StarletteUploadFile):
            alias = key[len("sources["):-1]
            grouped[alias].append(value)

    _validate_preview_sources(config, grouped)

    # Stage every upload in a throwaway tempdir; delete it all in `finally`.
    tmp_dir = Path(tempfile.mkdtemp(prefix="preview_"))
    try:
        source_files: dict[str, Path] = {}
        source_sheets: dict[str, str] = {}
        for spec in config.sources:
            upload = grouped[spec.alias][0]
            path = tmp_dir / f"src_{spec.alias}.xlsx"
            path.write_bytes(await upload.read())
            _check_xlsx_magic(path)
            source_files[spec.alias] = path
            source_sheets[spec.alias] = spec.sheet

        target_path = tmp_dir / "target.xlsx"
        target_path.write_bytes(await target_template.read())
        _check_xlsx_magic(target_path)

        # Preflight uploaded source files against the config (same rules as jobs).
        _preview_preflight(config, source_files)

        # CoreError from the pipeline (e.g. bad source_cell) surfaces via the
        # global handler as the 422 CoreError shape.
        columns, rows, truncated = preview.preview_map(
            config, source_files, source_sheets, n
        )
        return {"columns": columns, "rows": rows, "truncated": truncated}
    finally:
        for child in tmp_dir.iterdir():
            child.unlink(missing_ok=True)
        tmp_dir.rmdir()


def _validate_preview_sources(
    config: ConfigSchema, grouped: dict[str, list[UploadFile]]
) -> None:
    """Every declared source alias needs exactly one uploaded file for preview.

    Unlike the batch job (many primaries), preview takes a single sample file
    per source — including the primary.
    """
    for spec in config.sources:
        files = grouped.get(spec.alias, [])
        if len(files) != 1:
            raise HTTPException(
                status_code=422,
                detail=f"來源『{spec.alias}』需恰好 1 份檔案（收到 {len(files)} 份）",
            )


def _preview_preflight(config: ConfigSchema, source_files: dict[str, Path]) -> None:
    """Verify sheet + required columns on each df-needed source, mirroring
    `api/jobs.py::_run_preflight`. `source_cell`-only aliases are skipped (their
    values are read via absolute addressing at map time).
    """
    from .jobs import _collect_required_columns

    required_by_alias = _collect_required_columns(config)
    df_needed = preview.df_needed_aliases(config)

    for spec in config.sources:
        if spec.alias not in df_needed:
            continue
        try:
            preflight.preflight_check(
                source_files[spec.alias],
                spec.sheet,
                spec.header_row,
                required_columns=sorted(required_by_alias.get(spec.alias, set())),
            )
        except CoreError as exc:
            raise HTTPException(
                status_code=422,
                detail={"error": exc.user_message, "code": type(exc).__name__, **exc.context},
            )


def _check_xlsx_magic(path: Path) -> None:
    """xlsx files are zip archives — they start with 'PK\\x03\\x04'."""
    with path.open("rb") as f:
        head = f.read(4)
    if head[:2] != b"PK":
        raise HTTPException(
            status_code=422,
            detail={
                "error": f"檔案『{path.name}』非 xlsx 格式",
                "code": "TemplateInvalid",
                "file": str(path.name),
            },
        )
