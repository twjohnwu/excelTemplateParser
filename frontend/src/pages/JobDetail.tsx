/** JobDetail (/jobs/:id): live snapshot + subtask list + cancel + download. */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { useJobSnapshot } from "@/hooks/useJobSnapshot";
import { removeRecent } from "@/lib/recentJobs";
import type { JobState } from "@/lib/schemas";

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { snapshot, connected, loading, error } = useJobSnapshot(id);
  const [state, setState] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const tick = () =>
      api
        .get<JobState>(`/api/jobs/${encodeURIComponent(id)}/state`)
        .then((s) => alive && setState(s))
        .catch(() => {});
    tick();
    const handle = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, [id]);

  const onCancel = async () => {
    if (!id) return;
    if (!confirm(t("jobs.cancel") + "?")) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${id}/cancel`);
    } finally {
      setBusy(false);
    }
  };

  const onDownload = async () => {
    if (!id) return;
    try {
      window.location.href = `/api/jobs/${id}/zip`;
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    }
  };

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="text-destructive">{error}</p>;
  if (!snapshot || !id) return <p>Not found</p>;

  const pct = snapshot.total > 0 ? Math.round(((snapshot.done + snapshot.failed) / snapshot.total) * 100) : 0;
  const etaText = snapshot.eta_seconds != null
    ? t("jobs.etaRemaining", {
        minutes: Math.floor(snapshot.eta_seconds / 60),
        seconds: snapshot.eta_seconds % 60,
      })
    : t("jobs.etaEstimating");

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{snapshot.config_name ?? id}</h2>
        <span className="text-xs text-muted-foreground">#{id.slice(0, 8)}</span>
      </div>

      {!connected && snapshot.status !== "done" && snapshot.status !== "failed" && (
        <div className="rounded-md bg-yellow-100 px-3 py-1 text-xs dark:bg-yellow-900/30">
          {t("jobs.reconnecting")}
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between text-sm">
          <span>{snapshot.done + snapshot.failed}/{snapshot.total} · {t(`jobs.status.${snapshot.status}`)}</span>
          {(snapshot.status === "pending" || snapshot.status === "running") && (
            <span className="text-xs text-muted-foreground">{etaText}</span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex gap-2">
        {(snapshot.status === "pending" || snapshot.status === "running") && (
          <Button variant="destructive" onClick={onCancel} disabled={busy}>
            {t("jobs.cancel")}
          </Button>
        )}
        {snapshot.status === "done" && (
          <>
            <Button onClick={onDownload}>
              {t("jobs.download")}
              {snapshot.failed > 0 ? ` (${snapshot.done}✓ / ${snapshot.failed}✗)` : ""}
            </Button>
            <Button variant="ghost" onClick={() => removeRecent(id)}>
              {t("jobs.remove")}
            </Button>
          </>
        )}
      </div>

      {state && (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-1 text-left">File</th>
                <th className="px-3 py-1 text-left">Status</th>
                <th className="px-3 py-1 text-right">Duration</th>
                <th className="px-3 py-1 text-left">Message</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(state.subtasks).map((s) => (
                <tr key={s.source_file} className="border-t">
                  <td className="px-3 py-1 font-mono">{s.source_file}</td>
                  <td className="px-3 py-1">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-3 py-1 text-right text-xs text-muted-foreground">
                    {s.duration_ms != null ? `${s.duration_ms} ms` : "—"}
                  </td>
                  <td className="px-3 py-1 text-xs text-destructive">{s.user_message ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color: Record<string, string> = {
    pending: "bg-gray-200 text-gray-700",
    running: "bg-blue-100 text-blue-700",
    done: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${color[status] ?? "bg-gray-100"}`}>
      {status}
    </span>
  );
}
