import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";

// frontend/package.json has "type": "module", so this file runs as ESM —
// no __dirname. Playwright's ESM loader also needs an import attribute for
// `.json` imports that the rest of this project doesn't use, so read +
// parse instead of importing the JSON directly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(__dirname, "..", "src", "i18n");
export const en = JSON.parse(fs.readFileSync(path.join(I18N_DIR, "en.json"), "utf-8"));
export const zhTW = JSON.parse(fs.readFileSync(path.join(I18N_DIR, "zh-TW.json"), "utf-8"));

export const FIXTURES = path.join(__dirname, "fixtures");

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

/** Force a deterministic UI language before the app's i18next instance
 * initialises, so tests can match strings from `src/i18n/en.json` reliably.
 *
 * Deliberately NOT `page.addInitScript` for the write: an init script runs
 * on every subsequent navigation in the page's lifetime, which would also
 * re-fire on a later `page.reload()` and stomp over a value the UI itself
 * persisted in the meantime (e.g. the language/theme-persistence specs
 * reload *after* toggling via the UI and need that toggle to stick). Setting
 * it once via `evaluate` + a single explicit reload has no such side effect. */
export async function setLanguage(page: Page, lang: "en" | "zh-TW"): Promise<void> {
  await page.goto("/");
  await page.evaluate((value) => window.localStorage.setItem("etp.lang", value), lang);
  await page.reload();
}

/** Config matching the primary_N.xlsx / target.xlsx fixtures: one primary
 * source "orders" (訂單 sheet, header row 1: 單號/客戶代號/金額), mapped
 * straight through onto a 3-column target. Reused by specs that only need a
 * working batch-runner config (§8.19 ETA, §8.20 partial failure) without
 * building one through the ConfigBuilder UI. */
export function batchTestConfig(name: string) {
  return {
    version: "1.0",
    name,
    target_template: {
      sheet: "Sheet1",
      header_row: 1,
      preserve_styles: true,
      columns: ["訂單編號", "客戶名稱", "金額"],
    },
    sources: [
      { alias: "orders", role: "primary", sheet: "訂單", header_row: 1 },
    ],
    joins: [],
    mappings: [
      { target: "訂單編號", source: "orders.單號", conditions: [], default: "" },
      { target: "客戶名稱", literal: "N/A", conditions: [], default: "" },
      {
        target: "金額",
        source: "orders.金額",
        conditions: [{ field: "orders.金額", op: ">=", value: 0 }],
        default: "",
      },
    ],
  };
}

/** Create (or overwrite) a config directly via the API — used by specs that
 * exercise the batch-runner/job flow and don't need to test config *building*
 * itself. Returns the config name. */
export async function createConfig(
  request: APIRequestContext,
  name: string,
  config: Record<string, unknown> = batchTestConfig(name)
): Promise<string> {
  const res = await request.post("/api/configs?overwrite=true", { data: config });
  if (!res.ok()) {
    throw new Error(`createConfig(${name}) failed: ${res.status()} ${await res.text()}`);
  }
  return name;
}
