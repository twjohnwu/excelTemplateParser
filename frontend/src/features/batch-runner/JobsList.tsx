/** Right pane of BatchRunner: list of recent jobs with live snapshot. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fmtTime } from "@/lib/configHelpers";
import { listRecent, removeRecent, type RecentJob } from "@/lib/recentJobs";
import type { JobSnapshot } from "@/lib/schemas";

type Props = { refreshKey: number };

export function JobsList({ refreshKey }: Props) {
  const { t } = useTranslation();
  const [recents, setRecents] = useState<RecentJob[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, JobSnapshot>>({});

  useEffect(() => {
    setRecents(listRecent());
  }, [refreshKey]);

  useEffect(() => {
    if (recents.length === 0) return;
    let alive = true;
    const poll = () => {
      const ids = recents.map((j) => j.id).join(",");
      api
        .get<{ snapshots: any[] }>(`/api/jobs?ids=${ids}`)
        .then((res) => {
          if (!alive) return;
          const map: Record<string, JobSnapshot> = {};
          for (const s of res.snapshots) {
            if (s.status !== "missing") map[s.job_id] = s;
          }
          setSnapshots(map);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [recents]);

  if (recents.length === 0) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        {t("jobs.noJobs")}
      </div>
    );
  }

  return (
    <div className="space-y-2 overflow-auto rounded-lg border p-4">
      <h3 className="text-sm font-semibold">{t("jobs.panelTitle")}</h3>
      {recents.map((j) => {
        const snap = snapshots[j.id];
        const pct = snap && snap.total > 0 ? Math.round(((snap.done + snap.failed) / snap.total) * 100) : 0;
        return (
          <div key={j.id} className="space-y-1 rounded-md border bg-card p-2 text-sm">
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{j.configName ?? j.id.slice(0, 8)}</div>
                <div className="text-xs text-muted-foreground">
                  {snap ? `${snap.done}/${snap.total} · ${t(`jobs.status.${snap.status}`)}` : "—"}
                  {" · "}
                  {fmtTime(j.createdAt)}
                </div>
              </div>
              <div className="flex gap-1">
                <Link to={`/jobs/${j.id}`}>
                  <Button size="sm" variant="ghost">
                    {t("jobs.viewDetail")}
                  </Button>
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    removeRecent(j.id);
                    setRecents(listRecent());
                  }}
                >
                  ✕
                </Button>
              </div>
            </div>
            {snap && snap.total > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
            {snap?.status === "done" && (
              <a
                href={`/api/jobs/${j.id}/zip`}
                className="inline-block text-xs text-blue-600 underline"
              >
                {t("jobs.download")}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

