"""Job state management: Redis (cache) + state.json (source of truth).

Every mutation writes state.json first, then Redis, then publishes an SSE
event. Snapshots are computed on read so they always reflect both stores.

Concurrency: state.json is read-modify-written under a per-file fcntl flock
so simultaneous worker updates don't lose increments.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import mean
from typing import Iterator

import structlog
from redis import Redis

from ..core.atomic_io import atomic_write_text
from ..core.exceptions import IllegalTransition
from ..schemas import (
    ConfigSchema,
    JobSnapshot,
    JobState,
    SubtaskState,
)
from ..settings import get_settings

JOB_KEY = "job:{id}"
JOB_DONE_SET = "job:{id}:done"
JOB_EVENTS_CHANNEL = "job:{id}:events"
JOB_CANCEL_FLAG = "job:{id}:cancel"
ETA_MIN_SAMPLES = 5

# State machines for subtask/job status. Values are the set of statuses a
# transition may legally land on; a status absent from the table (or mapped
# to an empty set) is terminal.
SUBTASK_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"running", "done", "failed"},
    "running": {"done", "failed"},
    "done": set(),
    "failed": set(),
}

JOB_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"running", "done", "failed", "cancelled"},
    "running": {"done", "failed", "cancelled"},
    "done": set(),
    "failed": set(),
    "cancelled": set(),
}

log = structlog.get_logger(__name__)


def _transition(current: str, target: str, table: dict[str, set[str]]) -> bool:
    """Validate a state machine transition.

    Returns True if `current -> target` is legal and should be applied,
    False if it's a same-state re-entry (caller should skip the write —
    e.g. a duplicate mark_running for an already-running subtask). Raises
    IllegalTransition for anything else (e.g. done -> running).
    """
    if current == target:
        return False
    allowed = table.get(current, set())
    if target not in allowed:
        raise IllegalTransition(
            f"非法狀態轉換：{current} → {target}",
            tech_detail=f"allowed from {current!r}: {sorted(allowed)}",
            current=current,
            target=target,
        )
    return True


class JobNotFound(Exception):
    pass


class JobService:
    def __init__(self, redis: Redis, jobs_dir: Path) -> None:
        self.redis = redis
        self.dir = jobs_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    # ---- create ----

    def create(self, job_id: str, config: ConfigSchema, primary_files: list[str]) -> JobState:
        """Create a job with one subtask per primary file."""
        state = JobState(
            job_id=job_id,
            config_name=config.name,
            status="pending",
            created_at=datetime.now(UTC).isoformat(),
            subtasks={
                name: SubtaskState(source_file=name, status="pending")
                for name in primary_files
            },
        )
        self._job_dir(job_id).mkdir(parents=True, exist_ok=True)
        self._write_state(state)
        self.redis.set(JOB_KEY.format(id=job_id), state.model_dump_json())
        self._publish(job_id, {"type": "snapshot", **self.get_snapshot(job_id).model_dump()})
        return state

    # ---- mutate ----

    def mark_running(self, job_id: str, source_file: str) -> None:
        with self._locked_state(job_id) as state:
            if source_file not in state.subtasks:
                return
            sub = state.subtasks[source_file]
            # Same-state (already running) or illegal (already done/failed) —
            # both are a retried/duplicate message, crash-safe re-entry no-op.
            if not self._apply_transition(job_id, sub, "running", SUBTASK_TRANSITIONS, source_file=source_file):
                return
            self._apply_transition(job_id, state, "running", JOB_TRANSITIONS)
            self._persist_locked(state)
        self._publish(job_id, {"type": "subtask.running", "source": source_file})

    def mark_done(self, job_id: str, source_file: str, duration_ms: int) -> bool:
        """Returns True if this call completed the LAST pending subtask.

        Callers use that flag to enqueue finalize_job exactly once.
        """
        last = False
        with self._locked_state(job_id) as state:
            if source_file not in state.subtasks:
                return False
            sub = state.subtasks[source_file]
            # Already terminal (same-state, or illegal e.g. failed -> done) —
            # a retried/duplicate mark_done must not re-trigger finalize.
            if not self._apply_transition(job_id, sub, "done", SUBTASK_TRANSITIONS, source_file=source_file):
                return False
            sub.duration_ms = duration_ms
            if state.done + state.failed == state.total:
                target = "failed" if state.failed > 0 else "done"
                self._apply_transition(job_id, state, target, JOB_TRANSITIONS)
                last = True
            self._persist_locked(state)
        self.redis.sadd(JOB_DONE_SET.format(id=job_id), source_file)
        self._publish(job_id, {
            "type": "subtask.done",
            "source": source_file,
            "duration_ms": duration_ms,
        })
        return last

    def mark_failed(
        self,
        job_id: str,
        source_file: str,
        user_message: str,
        tech_detail: str = "",
    ) -> bool:
        last = False
        with self._locked_state(job_id) as state:
            if source_file not in state.subtasks:
                return False
            sub = state.subtasks[source_file]
            # Already terminal (same-state, or illegal e.g. done -> failed) —
            # a retried/duplicate mark_failed must not re-trigger finalize.
            if not self._apply_transition(job_id, sub, "failed", SUBTASK_TRANSITIONS, source_file=source_file):
                return False
            sub.user_message = user_message
            sub.tech_detail = tech_detail
            if state.done + state.failed == state.total:
                self._apply_transition(job_id, state, "failed", JOB_TRANSITIONS)
                last = True
            self._persist_locked(state)
        self._publish(job_id, {
            "type": "subtask.failed",
            "source": source_file,
            "user_message": user_message,
        })
        return last

    def mark_cancelled(self, job_id: str) -> None:
        with self._locked_state(job_id) as state:
            self._apply_transition(job_id, state, "cancelled", JOB_TRANSITIONS)
            state.cancel_requested = True
            self._persist_locked(state)
        self.redis.set(JOB_CANCEL_FLAG.format(id=job_id), "1")
        self._publish(job_id, {"type": "cancelled"})

    def mark_complete(self, job_id: str) -> None:
        """Called by finalize_job after the result.zip is packed."""
        self._publish(job_id, {"type": "finalized"})

    def is_cancel_requested(self, job_id: str) -> bool:
        return bool(self.redis.exists(JOB_CANCEL_FLAG.format(id=job_id)))

    def mark_download_started(self, job_id: str) -> None:
        with self._locked_state(job_id) as state:
            if state.download_started_at is None:
                state.download_started_at = datetime.now(UTC).isoformat()
                self._persist_locked(state)

    # ---- read ----

    def get_state(self, job_id: str) -> JobState:
        return self._read_state(job_id)

    def get_snapshot(self, job_id: str) -> JobSnapshot:
        state = self._read_state(job_id)
        download_expires_at: str | None = None
        if state.download_started_at is not None and self._job_dir(job_id).exists():
            grace = get_settings().download_grace_minutes
            started = datetime.fromisoformat(state.download_started_at)
            download_expires_at = (started + timedelta(minutes=grace)).isoformat()
        return JobSnapshot(
            job_id=job_id,
            status=state.status,
            total=state.total,
            done=state.done,
            failed=state.failed,
            eta_seconds=self._eta_seconds(state),
            config_name=state.config_name,
            download_expires_at=download_expires_at,
        )

    def list_active_ids(self) -> list[str]:
        """All job_ids whose status is not done/failed/cancelled (used by recovery)."""
        ids: list[str] = []
        if not self.dir.exists():
            return ids
        for child in self.dir.iterdir():
            state_file = child / "state.json"
            if state_file.exists():
                state = JobState.model_validate_json(state_file.read_text("utf-8"))
                if state.status in ("pending", "running"):
                    ids.append(state.job_id)
        return ids

    # ---- internals ----

    def _apply_transition(
        self,
        job_id: str,
        obj: JobState | SubtaskState,
        target: str,
        table: dict[str, set[str]],
        *,
        source_file: str | None = None,
    ) -> bool:
        """Apply `obj.status -> target` if legal; log and ignore otherwise.

        Shared by both job-level transitions (`obj` is the `JobState`,
        `table=JOB_TRANSITIONS`) and subtask-level ones (`obj` is a
        `SubtaskState`, `table=SUBTASK_TRANSITIONS`, `source_file` set for
        the log line). Returns True iff the assignment happened; a
        same-state call returns False silently (a legitimate no-op — retried
        messages hit this constantly). An illegal transition (e.g. two
        subtasks finishing back-to-back both computing "last" and both
        trying to move the job to its terminal status, or a duplicate
        mark_running for an already-terminal subtask) is a benign race —
        logged instead of silently swallowed so a genuinely unexpected
        transition is still visible — and also returns False.
        """
        try:
            if _transition(obj.status, target, table):
                obj.status = target
                return True
            return False
        except IllegalTransition:
            log.warning(
                "illegal_transition_ignored",
                job_id=job_id,
                source_file=source_file,
                current=obj.status,
                target=target,
            )
            return False

    def _job_dir(self, job_id: str) -> Path:
        return self.dir / job_id

    def _state_path(self, job_id: str) -> Path:
        return self._job_dir(job_id) / "state.json"

    def _read_state(self, job_id: str) -> JobState:
        path = self._state_path(job_id)
        if not path.exists():
            raise JobNotFound(job_id)
        return JobState.model_validate_json(path.read_text("utf-8"))

    def _write_state(self, state: JobState) -> None:
        path = self._state_path(state.job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, state.model_dump_json(indent=2))

    def _persist(self, state: JobState) -> None:
        """File first, redis second — order matters for crash safety."""
        self._write_state(state)
        self.redis.set(JOB_KEY.format(id=state.job_id), state.model_dump_json())

    def _persist_locked(self, state: JobState) -> None:
        """Variant used inside `_locked_state` — the flock is already held."""
        self._persist(state)

    @contextlib.contextmanager
    def _locked_state(self, job_id: str) -> Iterator[JobState]:
        """Exclusive flock around read+modify+write on state.json.

        Multiple workers updating the same job concurrently would otherwise
        race on the file rewrite (last writer wins, losing increments).
        """
        path = self._state_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Touch a sibling lock file (avoids interfering with reads of state.json).
        lock_path = path.with_suffix(".lock")
        with open(lock_path, "w") as lock_fh:
            fcntl.flock(lock_fh, fcntl.LOCK_EX)
            try:
                state = self._read_state(job_id)
                yield state
            finally:
                fcntl.flock(lock_fh, fcntl.LOCK_UN)

    @contextlib.contextmanager
    def finalize_lock(self, job_id: str) -> Iterator[None]:
        """Exclusive flock guarding the pack step in `finalize_job`.

        Prevents two concurrently-scheduled finalize_job runs (RQ can
        schedule both the job-creation safety net and the last-subtask
        enqueue close together) from packing result.zip twice.
        """
        lock_path = self._job_dir(job_id) / "finalize.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "w") as lock_fh:
            fcntl.flock(lock_fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_fh, fcntl.LOCK_UN)

    def _publish(self, job_id: str, payload: dict) -> None:
        self.redis.publish(JOB_EVENTS_CHANNEL.format(id=job_id), json.dumps(payload))

    def _eta_seconds(self, state: JobState) -> int | None:
        durations = [
            s.duration_ms for s in state.subtasks.values()
            if s.status == "done" and s.duration_ms is not None
        ]
        remaining = state.total - state.done - state.failed
        if len(durations) < ETA_MIN_SAMPLES or remaining <= 0:
            return None
        return int((mean(durations) / 1000.0) * remaining)
