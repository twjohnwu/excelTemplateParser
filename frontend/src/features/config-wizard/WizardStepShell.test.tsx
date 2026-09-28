import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { STEP_IDS, type StepId } from "@/lib/previewHelpers";

import { WizardStepShell } from "./WizardStepShell";
import { WIZARD_COPY } from "./wizardCopy";

// REQ-03 / REQ-04 / S-04: every wizard step must permanently show a
// description sentence, one "例如："-prefixed example sentence, and inline
// definitions for every domain term the Domain Language table (spec.md)
// assigns to that step's "首次定義步驟" column — a sentence rendered behind
// a <details>/tooltip does not satisfy REQ-03. Crucially, the term labels
// SHALL follow the active i18n locale, not a locale baked in at module load
// — this test asserts the RENDERED DOM (dfn text/title), never a data
// module's raw values, so a fix that merely hardcodes zh-TW cannot pass it.

// Transcribed directly from spec.md's Domain Language table "首次定義步驟"
// column (STDD/create-project-wizard/spec.md:44-58). Per REQ-04 this set is
// NOT derived from wizardCopy.ts or any implementation's copy — the
// obligation is fixed by the table, not by what the copy happens to write.
const REQUIRED_TERMS_BY_STEP: Record<StepId, string[]> = {
  target: ["目標範本", "工作表", "標題列"],
  sources: ["來源檔", "alias", "primary/主檔", "role"],
  joins: ["join/串接"],
  mappings: [
    "對應/mapping",
    "來源欄位",
    "固定值",
    "固定儲存格",
    "輸出欄位",
  ],
  save: [],
};

// Fixed per-step term counts (S-04) — a change here is a mistake, not a fix.
const EXPECTED_TERM_COUNTS: Record<StepId, number> = {
  target: 3,
  sources: 4,
  joins: 1,
  mappings: 5,
  save: 0,
};

// en.json's value for the first term assigned to the "target" step
// (wizard.step.target.terms.targetTemplate.{term,definition}), read directly
// from the resource file — independent of wizardCopy.ts's internal
// resolution mechanism — to prove the rendered label tracks the ACTIVE
// locale rather than a value fixed at module load.
const EN_TARGET_TEMPLATE_TERM = "Target template";
const ZH_TARGET_TEMPLATE_TERM = "目標範本";

describe("WizardStepShell", () => {
  it("rendersDescriptionExampleAndInlineTermDefinitionsPerAssignedTerm", async () => {
    // Deterministic starting locale — jsdom's detected navigator language is
    // not guaranteed to be zh-TW, and REQ-03/REQ-04's obligations here are
    // stated against the zh-TW UI copy.
    await i18n.changeLanguage("zh-TW");

    for (const stepId of STEP_IDS) {
      const copy = WIZARD_COPY[stepId];
      // "The way a real caller would": resolve via the active-locale
      // translator (i18n.t), never a locale pinned with getFixedT.
      const description = i18n.t(copy.descriptionKey);
      const example = i18n.t(copy.exampleKey);

      const { container, unmount } = render(
        <WizardStepShell stepId={stepId} description={description} example={example} terms={copy.terms}>
          <div>step content</div>
        </WizardStepShell>,
      );

      // REQ-03: description + "例如：" example sentence permanently visible —
      // toBeVisible() also fails if either sentence sits inside a hidden /
      // display:none / unopened <details> ancestor.
      expect(example.startsWith("例如："), `step "${stepId}" example must start with "例如："`).toBe(true);
      expect(screen.getByText(description)).toBeVisible();
      expect(screen.getByText(example)).toBeVisible();

      // REQ-04: the RENDERED <dfn> elements for this step must match the
      // Domain Language table's fixed term set — checked against the DOM,
      // never against wizardCopy's raw data.
      const dfns = Array.from(container.querySelectorAll("dfn"));
      expect(dfns, `step "${stepId}" dfn count`).toHaveLength(EXPECTED_TERM_COUNTS[stepId]);
      for (const dfn of dfns) {
        expect(dfn).toBeVisible();
        expect(dfn.textContent?.length ?? 0, `step "${stepId}" dfn must have visible text`).toBeGreaterThan(0);
        expect(dfn.getAttribute("title"), `step "${stepId}" dfn must have a non-empty title`).toBeTruthy();
      }
      const renderedTerms = dfns.map((dfn) => dfn.textContent);
      for (const term of REQUIRED_TERMS_BY_STEP[stepId]) {
        expect(renderedTerms, `step "${stepId}" missing a rendered <dfn> for term "${term}"`).toContain(term);
      }

      // design-ux.md:122 requires the definition to stay readable without
      // hovering and without a popup/tooltip. A `title=` attribute alone is
      // a hover-only tooltip and does not satisfy this — every term's
      // definition must also appear as VISIBLE text in the DOM.
      for (const { definitionKey } of copy.terms) {
        const definitionText = i18n.t(definitionKey);
        expect(
          screen.getByText(definitionText),
          `step "${stepId}" definition "${definitionText}" must be visible without hovering`,
        ).toBeVisible();
      }

      unmount();
    }

    // The locale proof: switch the ACTIVE i18n language to "en" and render
    // the "target" step again. A caller resolving through i18n.t already
    // gets the correct English description/example — that path isn't
    // hardcoded. The term labels, however, come from WIZARD_COPY.target.terms,
    // which wizardCopy.ts currently resolves once at module scope via
    // i18n.getFixedT("zh-TW") — so they stay zh-TW no matter what the active
    // locale is. That is the defect this test exists to catch.
    try {
      await i18n.changeLanguage("en");
      const targetCopy = WIZARD_COPY.target;
      const { container: enContainer, unmount: enUnmount } = render(
        <WizardStepShell
          stepId="target"
          description={i18n.t(targetCopy.descriptionKey)}
          example={i18n.t(targetCopy.exampleKey)}
          terms={targetCopy.terms}
        >
          <div>step content</div>
        </WizardStepShell>,
      );

      const enTermTexts = Array.from(enContainer.querySelectorAll("dfn")).map((dfn) => dfn.textContent);
      expect(
        enTermTexts,
        `under the "en" locale, rendered term labels must be the en.json values (e.g. "${EN_TARGET_TEMPLATE_TERM}"), not zh-TW — got ${JSON.stringify(enTermTexts)}`,
      ).toContain(EN_TARGET_TEMPLATE_TERM);
      expect(
        enTermTexts,
        `under the "en" locale, rendered term labels must NOT be the zh-TW values (e.g. "${ZH_TARGET_TEMPLATE_TERM}") — got ${JSON.stringify(enTermTexts)}`,
      ).not.toContain(ZH_TARGET_TEMPLATE_TERM);

      enUnmount();
    } finally {
      await i18n.changeLanguage("zh-TW");
    }
  });
});
