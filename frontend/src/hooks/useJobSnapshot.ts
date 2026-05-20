/** useJobSnapshot: fetch snapshot once + subscribe to SSE for incremental updates.
 * Survives SSE disconnects (keeps last-known snapshot, exposes `connected` flag).
 */

import { useEffect, useState } from "react";

import { api, subscribeJobEvents } from "@/lib/api";
import type { JobSnapshot } from "@/lib/schemas";

export type UseJobSnapshotResult = {
  snapshot: JobSnapshot | null;
  loading: boolean;
  connected: boolean;
  error: string | null;
};

export function useJobSnapshot(jobId: string | undefined): UseJobSnapshotResult {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    setLoading(true);
    api
      .get<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}`)
      .then((s) => alive && setSnapshot(s))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));

    const unsub = subscribeJobEvents(jobId, {
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      onSnapshot: (data) => setSnapshot(data as JobSnapshot),
      onUpdate: () => {
        // any update — refetch snapshot to coalesce counts/eta correctly
        api.get<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}`).then(setSnapshot).catch(() => {});
      },
    });

    return () => {
      alive = false;
      unsub();
    };
  }, [jobId]);

  return { snapshot, loading, connected, error };
}
