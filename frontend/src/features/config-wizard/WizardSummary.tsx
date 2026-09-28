/** `save` step's read-only summary of the whole draft (S-08, REQ-06). Four
 * sections — target template, sources, joins, mappings — each with its own
 * "edit" link that calls `onEdit(stepId)` so `WizardPage` can jump back to
 * that step without losing any state (state lives entirely in `WizardPage`;
 * this component only reads it).
 */

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { modeOf } from "@/features/config-builder/MappingRow";
import type { FormState } from "@/lib/configForm";
import type { StepId } from "@/lib/previewHelpers";

type Props = {
  state: FormState;
  onEdit: (step: StepId) => void;
};

function mappingSourceRepr(m: FormState["mappings"][number]): string {
  const mode = modeOf(m);
  if (mode === "literal") return String(m.literal ?? "");
  if (mode === "source_cell") return `${m.source_cell?.alias ?? ""}!${m.source_cell?.address ?? ""}`;
  return m.source ?? "";
}

export function WizardSummary({ state, onEdit }: Props) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("wizard.summary.target.heading")}</h3>
          <Button variant="link" size="sm" onClick={() => onEdit("target")}>
            {t("wizard.summary.edit")}
          </Button>
        </div>
        <p className="text-sm">
          {state.target.file?.name ?? state.target.sample_filename ?? t("wizard.summary.target.notUploaded")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("wizard.summary.target.sheetHeader", { sheet: state.target.sheet, headerRow: state.target.header_row })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("wizard.summary.target.columnsCount", { n: state.target.columns.filter(Boolean).length })}
        </p>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("wizard.summary.sources.heading")}</h3>
          <Button variant="link" size="sm" onClick={() => onEdit("sources")}>
            {t("wizard.summary.edit")}
          </Button>
        </div>
        <ul className="text-sm">
          {state.sources.map((s, i) => (
            <li key={i}>
              {`${s.alias} / ${s.role} / ${s.file?.name ?? s.sample_filename ?? t("wizard.summary.sources.unknownFilename")}`}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("wizard.summary.joins.heading")}</h3>
          <Button variant="link" size="sm" onClick={() => onEdit("joins")}>
            {t("wizard.summary.edit")}
          </Button>
        </div>
        {state.joins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("wizard.summary.joins.empty")}</p>
        ) : (
          <ul className="text-sm">
            {state.joins.map((j, i) => (
              <li key={i}>{`${j.left} = ${j.right} (${j.type})`}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("wizard.summary.mappings.heading")}</h3>
          <Button variant="link" size="sm" onClick={() => onEdit("mappings")}>
            {t("wizard.summary.edit")}
          </Button>
        </div>
        <ul className="text-sm">
          {state.mappings.map((m, i) => (
            <li key={i}>{`${m.target} ← ${mappingSourceRepr(m)}`}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
