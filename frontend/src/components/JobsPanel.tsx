/** Dropdown panel listing recent jobs grouped by status. */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { fmtTime } from "@/lib/configHelpers";
import { removeRecent, type RecentJob } from "@/lib/recentJobs";
import type { JobSnapshot } from "@/lib/schemas";

type Props = {
  recents: RecentJob[];
  snapshots: Record<string, JobSnapshot | undefined>;
  onChange: () => void;
};

export function JobsPanel({ recents, snapshots, onChange }: Props) {
  const { t } = useTranslation();

  const active: RecentJob[] = [];
  const ready: RecentJob[] = [];
  for (const j of recents) {
    const snap = snapshots[j.id];
    if (snap && (snap.status === "done" || snap.status === "failed")) ready.push(j);
    else active.push(j);
  }

  if (recents.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">{t("jobs.noJobs")}</p>;
  }

  return (
    <div className="w-80 space-y-3 p-2">
      {active.length > 0 && (
        <Section title={t("jobs.inProgress")}>
          {active.map((j) => (
            <JobRow key={j.id} job={j} snap={snapshots[j.id]} onRemove={() => { removeRecent(j.id); onChange(); }} />
          ))}
        </Section>
      )}
      {ready.length > 0 && (
        <Section title={t("jobs.completed")}>
          {ready.map((j) => (
            <JobRow key={j.id} job={j} snap={snapshots[j.id]} onRemove={() => { removeRecent(j.id); onChange(); }} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function JobRow({
  job,
  snap,
  onRemove,
}: {
  job: RecentJob;
  snap: JobSnapshot | undefined;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = job.configName ?? job.id.slice(0, 8);
  const progress = snap ? `${snap.done}/${snap.total}` : "…";
  return (
    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
      <Link to={`/jobs/${job.id}`} className="min-w-0 flex-1">
        <div className="truncate font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {progress} · {snap ? t(`jobs.status.${snap.status}`) : "—"} · {fmtTime(job.createdAt)}
        </div>
      </Link>
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label={t("jobs.remove")}>
        ✕
      </Button>
    </div>
  );
}

