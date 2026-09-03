// VERIFICATION_REPORT §8.24 — Draft autosave
import { test, expect, type Page } from "@playwright/test";

import { en, setLanguage } from "./helpers";

// frontend/src/pages/ConfigBuilder.tsx: DRAFT_KEY, DEBOUNCE_MS = 1000.
const DRAFT_KEY = "etp.configDraft.v1";

async function draftName(page: Page): Promise<string | null> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY);
  return raw ? (JSON.parse(raw).name as string) : null;
}

test("draft autosaves while typing, offers restore on reload, and can be discarded", async ({ page }) => {
  await setLanguage(page, "en");
  await page.goto("/configs/new");

  const firstName = `e2e_draft_${Date.now()}`;
  await page.getByLabel(en.config.name).fill(firstName);

  // Debounced autosave writes ~1s after the last edit; poll localStorage
  // instead of a fixed sleep so this isn't tied to the exact debounce value.
  await expect.poll(() => draftName(page)).toBe(firstName);

  await page.reload();
  await expect(page.getByText(en.config.draftRestorePrompt)).toBeVisible();
  await page.getByRole("button", { name: en.config.draftRestore }).click();
  await expect(page.getByLabel(en.config.name)).toHaveValue(firstName);
  // Restoring clears the "draft found" prompt (component sets draftFound=false).
  await expect(page.getByText(en.config.draftRestorePrompt)).toHaveCount(0);

  // Edit again to produce a fresh draft, then discard it this time.
  const secondName = `${firstName}_edited`;
  await page.getByLabel(en.config.name).fill(secondName);
  await expect.poll(() => draftName(page)).toBe(secondName);

  await page.reload();
  await expect(page.getByText(en.config.draftRestorePrompt)).toBeVisible();
  await page.getByRole("button", { name: en.config.draftDiscard }).click();
  await expect(page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).resolves.toBeNull();
});
