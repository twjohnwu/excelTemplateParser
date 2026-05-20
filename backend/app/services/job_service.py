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
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Iterator

from redis import Redis

from ..schemas import (
    ConfigSchema,
    JobSnapshot,
    JobState,
    SubtaskState,
)

JOB_KEY = "job:{id}"
JOB_DONE_SET = "job:{id}:done"
JOB_EVENTS_CHANNEL = "job:{id}:events"
JOB_CANCEL_FLAG = "job:{id}:cancel"
ETA_MIN_SAMPLES = 5


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
            state.subtasks[source_file].status = "running"
            state.status = "running"
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
            sub.status = "done"
            sub.duration_ms = duration_ms
            if state.done + state.failed == state.total:
                state.status = "failed" if state.failed > 0 else "done"
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
            sub.status = "failed"
            sub.user_message = user_message
            sub.tech_detail = tech_detail
            if state.done + state.failed == state.total:
                state.status = "failed"
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
            state.cancel_requested = True
            state.status = "cancelled"
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
        return JobSnapshot(
            job_id=job_id,
            status=state.status,
            total=state.total,
            done=state.done,
            failed=state.failed,
            eta_seconds=self._eta_seconds(state),
            config_name=state.config_name,
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
        path.write_text(state.model_dump_json(indent=2), encoding="utf-8")

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
