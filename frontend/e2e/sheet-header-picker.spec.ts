// VERIFICATION_REPORT §8.15 — Sheet/header row picker
import { test, expect } from "@playwright/test";

import { en, fixture, setLanguage } from "./helpers";

test("upload a multi-sheet xlsx, switch sheet, click a row to set the header", async ({ page }) => {
  await setLanguage(page, "en");
  await page.goto("/configs/new");

  // A pristine ConfigBuilder shows the onboarding card instead of the
  // sources/joins/mappings panes (frontend/src/pages/ConfigBuilder.tsx
  // `showOnboarding && isPristineState(state) ...`); dismiss it first.
  await page.getByRole("button", { name: en.config.onboarding.cta }).click();

  // Target section: single-sheet file, header defaults to row 1 (no picker
  // interaction needed there — the interesting case is the multi-sheet
  // source below).
  const targetSection = page.locator("section").filter({ hasText: en.config.targetTemplate });
  await targetSection.locator('input[type="file"]').setInputFiles(fixture("target.xlsx"));

  // Default primary source ("primary") is present from mount; upload the
  // multi-sheet fixture (訂單 sheet has a 2-row banner before the real
  // header on row 3; 備註 is a second sheet).
  const sourceRow = page.locator("details").first();
  await sourceRow.locator('input[type="file"]').setInputFiles(fixture("orders_header_row3.xlsx"));

  // Sheet select is only rendered when there's more than one sheet. The
  // source row also has a role select (primary/lookup) earlier in the DOM,
  // so pick the last <select> to get the SheetHeaderPicker's one.
  const sheetSelect = sourceRow.locator("select").last();
  await expect(sheetSelect).toHaveValue("訂單");
  await expect(sheetSelect.locator("option")).toHaveCount(2);

  // Before any row click, header_row defaults to 1 (row 1 is the banner text).
  await expect(sourceRow.getByText(en.config.headerRowConfirmed.replace("{{row}}", "1"))).toBeVisible();

  // Click row 3 ("單號 / 客戶代號 / 金額") to set it as the header row.
  await sourceRow.getByRole("cell", { name: "單號", exact: true }).click();
  await expect(sourceRow.getByText(en.config.headerRowConfirmed.replace("{{row}}", "3"))).toBeVisible();
  await expect(sourceRow.getByText(`${en.config.columnsPrefix}單號, 客戶代號, 金額`)).toBeVisible();

  // Switching sheet resets header_row to 1 and re-derives columns from the
  // new sheet's first row.
  await sheetSelect.selectOption("備註");
  await expect(sourceRow.getByText(en.config.headerRowConfirmed.replace("{{row}}", "1"))).toBeVisible();
  await expect(sourceRow.getByText(`${en.config.columnsPrefix}說明`)).toBeVisible();
});
