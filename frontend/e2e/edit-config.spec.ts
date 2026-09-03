// VERIFICATION_REPORT §8.23 — Edit existing config (load + download)
import { test, expect } from "@playwright/test";

import { batchTestConfig, createConfig, en, setLanguage } from "./helpers";

test("loading ?config=<name> populates the form; editing and downloading reflects the edit", async ({
  page,
  request,
}) => {
  const configName = `e2e_edit_${Date.now()}`;
  const config = batchTestConfig(configName);
  await createConfig(request, configName, config);

  await setLanguage(page, "en");
  await page.goto(`/configs?config=${configName}`);

  // Loaded via useConfig()/?config= (frontend/src/pages/ConfigBuilder.tsx):
  // name input and the target template's column list should reflect the
  // saved config without any manual re-upload.
  const nameInput = page.getByLabel(en.config.name);
  await expect(nameInput).toHaveValue(configName);
  await expect(page.getByText(`${en.config.headersPrefix}訂單編號, 客戶名稱, 金額`)).toBeVisible();

  // Edit: rename the project, then download the *current* (edited) config.
  const editedName = `${configName}_edited`;
  await nameInput.fill(editedName);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: en.config.downloadCurrent }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${editedName}.json`);

  const downloadPath = await download.path();
  const { readFileSync } = await import("node:fs");
  const downloaded = JSON.parse(readFileSync(downloadPath!, "utf-8"));
  expect(downloaded.name).toBe(editedName);
  expect(downloaded.sources[0].alias).toBe("orders");
});
