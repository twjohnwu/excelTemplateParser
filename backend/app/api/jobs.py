"""Job endpoints: create, snapshot, batch snapshot, SSE, download, cancel.

Multipart upload structure (POST /api/jobs):
    target_template:           single file
    config_name | config_json: text or json file
    sources[<alias>]:          one or many files (validated per role)
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

import structlog
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse
from rq import Queue
from sse_starlette.sse import EventSourceResponse
from starlette.datastructures import UploadFile as StarletteUploadFile

from ..core import preflight
from ..core.exceptions import CoreError, TemplateInvalid
from ..dependencies import (
    get_cleanup_service,
    get_config_service,
    get_job_service,
    get_queue,
    get_request_id,
)
from ..schemas import ConfigSchema
from ..services.cleanup_service import CleanupService
from ..services.config_service import ConfigNotFound, ConfigService
from ..services.job_service import JobNotFound, JobService
from ..settings import get_settings
from ..workers.queue import enqueue_finalize, enqueue_subtask

router = APIRouter(prefix="/api/jobs", tags=["jobs"])
log = structlog.get_logger(__name__)


# ---- Create ----

@router.post("")
async def create_job(
    request: Request,
    background: BackgroundTasks,
    target_template: UploadFile = File(...),
    config_name: str | None = Form(default=None),
    config_json: UploadFile | None = File(default=None),
    config_svc: ConfigService = Depends(get_config_service),
    job_svc: JobService = Depends(get_job_service),
    queue: Queue = Depends(get_queue),
    request_id: str = Depends(get_request_id),
):
    """Multipart job creation.

    Resolves the config from `config_name` (existing) or `config_json` (inline),
    lays out uploads under `/data/jobs/{id}/uploads/`, runs preflight,
    initialises state.json with one subtask per primary, and enqueues each
    subtask plus a finalize step.
    """
    config = await _resolve_config(config_name, config_json, config_svc)

    # Group uploaded files by alias from the raw multipart form.
    form = await request.form()
    grouped: dict[str, list[UploadFile]] = defaultdict(list)
    for key, value in form.multi_items():
        if key.startswith("sources[") and key.endswith("]") and isinstance(value, StarletteUploadFile):
            alias = key[len("sources["):-1]
            grouped[alias].append(value)

    _validate_role_counts(config, grouped)
    _validate_no_duplicate_primary(config, grouped)

    job_id = uuid.uuid4().hex
    settings = get_settings()
    job_dir = settings.jobs_dir / job_id
    primary_alias = config.primary_alias

    (job_dir / "uploads" / "primary").mkdir(parents=True, exist_ok=True)
    (job_dir / "uploads" / "lookup").mkdir(parents=True, exist_ok=True)
    (job_dir / "out").mkdir(parents=True, exist_ok=True)

    # Land target template.
    target_path = job_dir / "uploads" / "target.xlsx"
    target_path.write_bytes(await target_template.read())
    _check_xlsx_magic(target_path)

    # Land sources by role.
    primary_names: list[str] = []
    for upload in grouped[primary_alias]:
        name = Path(upload.filename or "").name
        path = job_dir / "uploads" / "primary" / name
        path.write_bytes(await upload.read())
        _check_xlsx_magic(path)
        primary_names.append(name)

    for alias in config.lookup_aliases:
        upload = grouped[alias][0]
        path = job_dir / "uploads" / "lookup" / f"{alias}.xlsx"
        path.write_bytes(await upload.read())
        _check_xlsx_magic(path)

    # Preflight every uploaded file against the config.
    _run_preflight(job_dir, config, primary_names)

    # Initialise state + enqueue subtasks.
    job_svc.create(job_id, config, primary_names)
    for name in primary_names:
        enqueue_subtask(queue, job_id, name)
    enqueue_finalize(queue, job_id)

    log.info("job.created", job_id=job_id, primary_count=len(primary_names))
    return {"job_id": job_id, "request_id": request_id}


# ---- Read ----

@router.get("")
def list_jobs_by_ids(
    ids: str = Query(default=""),
    job_svc: JobService = Depends(get_job_service),
) -> dict:
    """Batch snapshot query: `GET /api/jobs?ids=a,b,c`."""
    out = []
    for jid in [x.strip() for x in ids.split(",") if x.strip()]:
        try:
            out.append(job_svc.get_snapshot(jid).model_dump())
        except JobNotFound:
            out.append({"job_id": jid, "status": "missing"})
    return {"snapshots": out}


@router.get("/{job_id}")
def get_job(job_id: str, job_svc: JobService = Depends(get_job_service)):
    try:
        return job_svc.get_snapshot(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail=f"找不到作業『{job_id}』")


@router.get("/{job_id}/state")
def get_job_state(job_id: str, job_svc: JobService = Depends(get_job_service)):
    """Verbose state (subtask list, durations, errors). Used by JobDetail page."""
    try:
        return job_svc.get_state(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail=f"找不到作業『{job_id}』")


# ---- SSE ----

@router.get("/{job_id}/events")
async def stream_events(
    job_id: str,
    request: Request,
    job_svc: JobService = Depends(get_job_service),
):
    """SSE channel. First event is always a snapshot; subsequent events are
    pub/sub messages published by JobService.
    """
    try:
        snapshot = job_svc.get_snapshot(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail=f"找不到作業『{job_id}』")

    pubsub = job_svc.redis.pubsub()
    pubsub.subscribe(f"job:{job_id}:events")

    async def _gen():
        try:
            yield {"event": "snapshot", "data": snapshot.model_dump_json()}
            while True:
                if await request.is_disconnected():
                    break
                msg = pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg and msg.get("type") == "message":
                    yield {"event": "update", "data": msg["data"].decode("utf-8")}
                await asyncio.sleep(0)
        finally:
            pubsub.unsubscribe(f"job:{job_id}:events")
            pubsub.close()

    return EventSourceResponse(_gen())


# ---- Download ----

@router.get("/{job_id}/zip")
def download_zip(
    job_id: str,
    job_svc: JobService = Depends(get_job_service),
    cleanup: CleanupService = Depends(get_cleanup_service),
):
    """Stream the result zip with HTTP Range support.

    Does NOT delete the artifact on completion. We keep it for
    `download_grace_minutes` so retries (network blips) are cheap; the
    scheduler eventually calls `purge_grace_expired`.
    """
    settings = get_settings()
    try:
        state = job_svc.get_state(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail=f"找不到作業『{job_id}』")

    zip_path = settings.jobs_dir / job_id / "result.zip"

    # Grace gone? state.json should already be absent (cleanup ran),
    # but be defensive — 410 makes the UI's "expired" state explicit.
    if state.download_started_at:
        started = datetime.fromisoformat(state.download_started_at)
        if datetime.now(UTC) - started > timedelta(minutes=settings.download_grace_minutes):
            cleanup.delete_job(job_id)
            raise HTTPException(status_code=410, detail="下載時效已過")

    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="尚未產生 ZIP")

    job_svc.mark_download_started(job_id)
    filename = f"{state.config_name or 'result'}_{job_id[:8]}.zip"
    return FileResponse(
        path=zip_path,
        media_type="application/zip",
        filename=filename,
    )


# ---- Cancel ----

@router.post("/{job_id}/cancel")
def cancel_job(
    job_id: str,
    job_svc: JobService = Depends(get_job_service),
    cleanup: CleanupService = Depends(get_cleanup_service),
    queue: Queue = Depends(get_queue),
) -> dict:
    """Drop all queued subtasks, flag worker to stop, then cleanup.

    Already-running subtasks finish their current xlsx (avoids corruption);
    subsequent subtasks see the flag in `run_subtask` and skip.
    """
    try:
        state = job_svc.get_state(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail=f"找不到作業『{job_id}』")

    if state.status in ("done", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail="作業已結束，無法取消")

    job_svc.mark_cancelled(job_id)
    # Drop queued (not-yet-started) jobs.
    for rq_job in queue.get_jobs():
        kwargs = rq_job.kwargs or {}
        if kwargs.get("job_id") == job_id:
            rq_job.cancel()
            rq_job.delete()

    # Sweep artifacts immediately. Running subtasks fail safely on next mark_*.
    cleanup.delete_job(job_id)
    return {"job_id": job_id, "status": "cancelled"}


# ---- Helpers ----

async def _resolve_config(
    config_name: str | None,
    config_json: UploadFile | None,
    svc: ConfigService,
) -> ConfigSchema:
    if config_name:
        try:
            return svc.get(config_name)
        except ConfigNotFound:
            raise HTTPException(status_code=404, detail=f"找不到專案『{config_name}』")
    if config_json:
        try:
            raw = (await config_json.read()).decode("utf-8")
            return ConfigSchema.model_validate_json(raw)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"config_json 解析失敗：{exc}")
    raise HTTPException(status_code=422, detail="需指定 config_name 或 config_json")


def _validate_role_counts(
    config: ConfigSchema, grouped: dict[str, list[UploadFile]]
) -> None:
    primary_alias = config.primary_alias
    primaries = grouped.get(primary_alias, [])
    if len(primaries) < 1:
        raise HTTPException(
            status_code=422,
            detail=f"primary 來源『{primary_alias}』至少需要 1 份檔案",
        )
    for alias in config.lookup_aliases:
        files = grouped.get(alias, [])
        if len(files) != 1:
            raise HTTPException(
                status_code=422,
                detail=f"lookup 來源『{alias}』需恰好 1 份檔案（收到 {len(files)} 份）",
            )


def _validate_no_duplicate_primary(
    config: ConfigSchema, grouped: dict[str, list[UploadFile]]
) -> None:
    primaries = grouped.get(config.primary_alias, [])
    names = [Path(u.filename or "").name for u in primaries]
    seen: dict[str, int] = defaultdict(int)
    for n in names:
        seen[n] += 1
    duplicates = [n for n, c in seen.items() if c > 1]
    if duplicates:
        raise HTTPException(
            status_code=422,
            detail=f"primary 含同名檔案：{', '.join(duplicates)}，請重新命名",
        )


def _collect_required_columns(config: ConfigSchema) -> dict[str, set[str]]:
    """Return {alias: {required_columns}} from mappings/conditions/joins.

    Skips mappings without `source` (literal / source_cell modes don't reference
    a header column).
    """
    required_by_alias: dict[str, set[str]] = defaultdict(set)
    for m in config.mappings:
        if m.source is not None:
            alias, _, col = m.source.partition(".")
            required_by_alias[alias].add(col)
        for c in m.conditions:
            a, _, cl = c.field.partition(".")
            required_by_alias[a].add(cl)
    for j in config.joins:
        for side in (j.left, j.right):
            alias, _, col = side.partition(".")
            required_by_alias[alias].add(col)
    return required_by_alias


def _run_preflight(job_dir: Path, config: ConfigSchema, primary_names: list[str]) -> None:
    """Open every uploaded file (read_only) and verify sheet + required columns.

    `source_cell`-only aliases are skipped: their values are read via openpyxl
    absolute addressing at run time, so header_row checks would be misleading.
    `_resolve_source_cells` in the worker still reports clear errors for
    missing sheets / bad cells.
    """
    from ..workers.tasks import df_needed_aliases

    required_by_alias = _collect_required_columns(config)
    df_needed = df_needed_aliases(config)

    for spec in config.sources:
        if spec.alias not in df_needed:
            continue
        if spec.role == "primary":
            paths = [job_dir / "uploads" / "primary" / n for n in primary_names]
        else:
            paths = [job_dir / "uploads" / "lookup" / f"{spec.alias}.xlsx"]
        for path in paths:
            try:
                preflight.preflight_check(
                    path, spec.sheet, spec.header_row,
                    required_columns=sorted(required_by_alias.get(spec.alias, set())),
                )
            except CoreError as exc:
                # Convert to 422 at the API boundary.
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
