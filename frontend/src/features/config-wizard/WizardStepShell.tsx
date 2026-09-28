/** Presentation shell for a single wizard step: renders the step's
 * permanent description/example sentences and inline term definitions
 * (REQ-03, REQ-04), then the step's own content as children.
 *
 * Presentation only — no step-specific form logic, no data fetching, no
 * draft handling. `description`/`example`/`terms` come from
 * `wizardCopy.ts`; the step list comes from `previewHelpers.ts`
 * (`STEP_IDS`/`StepId`), never a second enumeration here.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { StepId } from "@/lib/previewHelpers";
import type { TermDefinition } from "./wizardCopy";

type Props = {
  stepId: StepId;
  description: string;
  example: string;
  terms: TermDefinition[];
  children: ReactNode;
};

export function WizardStepShell({ stepId, description, example, terms, children }: Props) {
  const { t } = useTranslation();

  return (
    <div data-step={stepId}>
      {/* REQ-03: permanently visible — plain <p>, never <details>/Popover/Tooltip */}
      <p>{description}</p>
      <p>{example}</p>
      {terms.length > 0 && (
        // REQ-04 (design-ux.md:120-122): the definition must be readable
        // without hovering, so it is rendered as visible text here — the
        // `title` attribute is kept only as a secondary affordance.
        <p>
          {terms.map(({ termKey, definitionKey }, index) => {
            const definition = t(definitionKey);
            return (
              <span key={termKey}>
                {index > 0 && " "}
                <dfn title={definition} className="underline decoration-dotted">
                  {t(termKey)}
                </dfn>
                {t("wizard.step.common.termDefinitionOpen")}
                <span>{definition}</span>
                {t("wizard.step.common.termDefinitionClose")}
              </span>
            );
          })}
        </p>
      )}
      {children}
    </div>
  );
}
