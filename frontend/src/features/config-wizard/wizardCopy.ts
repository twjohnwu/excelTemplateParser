/** Pure data module: per-step i18n keys for WizardStepShell (REQ-03, REQ-04).
 *
 * Every field here is an i18n key path, never resolved text — resolution
 * happens in the caller (WizardStepShell), which has React context via
 * `useTranslation()` and therefore tracks the ACTIVE locale, not a locale
 * fixed at module load. No CJK literal appears in this file.
 */

import type { StepId } from "@/lib/previewHelpers";

export type TermDefinition = { termKey: string; definitionKey: string };

export type WizardStepCopy = {
  descriptionKey: string;
  exampleKey: string;
  terms: TermDefinition[];
};

const TERM_KEYS: Record<StepId, TermDefinition[]> = {
  target: [
    {
      termKey: "wizard.step.target.terms.targetTemplate.term",
      definitionKey: "wizard.step.target.terms.targetTemplate.definition",
    },
    {
      termKey: "wizard.step.target.terms.sheet.term",
      definitionKey: "wizard.step.target.terms.sheet.definition",
    },
    {
      termKey: "wizard.step.target.terms.headerRow.term",
      definitionKey: "wizard.step.target.terms.headerRow.definition",
    },
  ],
  sources: [
    {
      termKey: "wizard.step.sources.terms.sourceFile.term",
      definitionKey: "wizard.step.sources.terms.sourceFile.definition",
    },
    {
      termKey: "wizard.step.sources.terms.alias.term",
      definitionKey: "wizard.step.sources.terms.alias.definition",
    },
    {
      termKey: "wizard.step.sources.terms.primary.term",
      definitionKey: "wizard.step.sources.terms.primary.definition",
    },
    {
      termKey: "wizard.step.sources.terms.role.term",
      definitionKey: "wizard.step.sources.terms.role.definition",
    },
  ],
  joins: [
    {
      termKey: "wizard.step.joins.terms.join.term",
      definitionKey: "wizard.step.joins.terms.join.definition",
    },
  ],
  mappings: [
    {
      termKey: "wizard.step.mappings.terms.mapping.term",
      definitionKey: "wizard.step.mappings.terms.mapping.definition",
    },
    {
      termKey: "wizard.step.mappings.terms.sourceField.term",
      definitionKey: "wizard.step.mappings.terms.sourceField.definition",
    },
    {
      termKey: "wizard.step.mappings.terms.literal.term",
      definitionKey: "wizard.step.mappings.terms.literal.definition",
    },
    {
      termKey: "wizard.step.mappings.terms.sourceCell.term",
      definitionKey: "wizard.step.mappings.terms.sourceCell.definition",
    },
    {
      termKey: "wizard.step.mappings.terms.outputColumn.term",
      definitionKey: "wizard.step.mappings.terms.outputColumn.definition",
    },
  ],
  save: [],
};

export const WIZARD_COPY: Record<StepId, WizardStepCopy> = Object.fromEntries(
  (Object.keys(TERM_KEYS) as StepId[]).map((stepId) => [
    stepId,
    {
      descriptionKey: `wizard.step.${stepId}.description`,
      exampleKey: `wizard.step.${stepId}.example`,
      terms: TERM_KEYS[stepId],
    },
  ]),
) as Record<StepId, WizardStepCopy>;
