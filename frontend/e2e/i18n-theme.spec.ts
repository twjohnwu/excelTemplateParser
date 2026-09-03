// VERIFICATION_REPORT §8.8 — Frontend i18n + dark mode persistence
import { test, expect } from "@playwright/test";

import { en, setLanguage, zhTW } from "./helpers";

test("language and dark-mode toggles persist across a reload", async ({ page }) => {
  // Fresh, isolated browser context (Playwright default) — localStorage
  // starts empty, no explicit reset needed.
  await setLanguage(page, "en");
  await page.goto("/configs");

  await expect(page.getByRole("link", { name: en.app.batchRunner })).toBeVisible();

  // Toggle language via the header button (aria-label = t("app.language")).
  await page.getByRole("button", { name: en.app.language }).click();
  await expect(page.getByRole("link", { name: zhTW.app.batchRunner })).toBeVisible();

  // No stored theme preference yet + headless Chromium defaults to light.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.evaluate(() => window.localStorage.getItem("etp.theme"))).resolves.toBe("dark");

  // Persisted: a hard reload keeps both the switched-to language and theme.
  await page.reload();
  await expect(page.getByRole("link", { name: zhTW.app.batchRunner })).toBeVisible();
  await expect(page.evaluate(() => window.localStorage.getItem("etp.lang"))).resolves.toBe("zh-TW");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
