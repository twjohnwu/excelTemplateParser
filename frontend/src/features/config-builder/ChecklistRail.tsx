/** Slim vertical guidance rail: per-step done / attention / pending markers.
 * Purely advisory — clicking scrolls to the step's pane, nothing is blocked. */

import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { STEP_IDS, type StepId, type StepStatus } from "@/lib/previewHelpers";

type Props = {
  states: Record<StepId, StepStatus>;
  errorCounts: Record<StepId, number>;
  onStepClick: (id: StepId) => void;
};

export function ChecklistRail({ states, errorCounts, onStepClick }: Props) {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t("config.rail.label")}
      className="flex w-28 shrink-0 flex-col gap-1 self-start rounded-lg border p-2"
    >
      {STEP_IDS.map((id) => {
        const status = states[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onStepClick(id)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            {status === "done" ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : status === "attention" ? (
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                {errorCounts[id]}
              </span>
            ) : (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-muted-foreground/50" />
            )}
            <span className={status === "pending" ? "text-muted-foreground" : undefined}>
              {t(`config.rail.${id}`)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
