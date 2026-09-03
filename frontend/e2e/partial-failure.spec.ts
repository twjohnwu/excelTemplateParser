// VERIFICATION_REPORT §8.20 — Partial failure ZIP packaging
import { test, expect } from "@playwright/test";

import { batchTestConfig, createConfig, en, fixture, setLanguage } from "./helpers";

test("a bad-data primary fails only its own subtask, packing a ZIP with the rest — unlike a structurally-invalid one, which rejects the whole batch", async ({
  page,
  request,
}) => {
  const configName = `e2e_partial_${Date.now()}`;
  await createConfig(request, configName, batchTestConfig(configName));

  await setLanguage(page, "en");
  await page.goto("/batch");

  const configSelect = page.getByText(en.batch.selectConfig, { exact: true }).locator("xpath=..").locator("select");
  const targetSlot = page.getByText(en.batch.targetTemplate).locator("xpath=..");
  const orderSlot = page.locator("label", { hasText: "orders" }).locator("xpath=..");

  // --- Boundary case: a structurally-invalid primary (not even a zip
  // archive) rejects the WHOLE batch up front. api/jobs.py's magic-byte
  // check runs over every primary before any subtask is created, so this
  // can never itself produce a "partial failure" ZIP — that requires data
  // that's valid enough to pass preflight (see below).
  await configSelect.selectOption(configName);
  await targetSlot.locator('input[type="file"]').setInputFiles(fixture("target.xlsx"));
  await orderSlot.locator('input[type="file"]').setInputFiles(fixture("corrupt.xlsx"));
  await page.getByRole("button", { name: en.batch.start }).click();
  await expect(page.getByText(en.batch.createSuccess)).toHaveCount(0);
  await expect(page).toHaveURL(/\/batch$/);

  // Fresh navigation to clear the rejected upload's local state before the
  // real scenario below.
  await page.goto("/batch");
  await configSelect.selectOption(configName);
  await targetSlot.locator('input[type="file"]').setInputFiles(fixture("target.xlsx"));

  // --- Real "partial failure" case: 4 valid primaries (numeric 金額) + 1
  // with text in 金額. That passes preflight (only header *names* are
  // checked, backend/app/core/preflight.py) but fails the ">=" numeric
  // condition at map time for that one file only (backend/app/core/mapper.py
  // `_numeric`) — one failed subtask alongside 4 successful ones.
  await orderSlot.locator('input[type="file"]').setInputFiles([
    fixture("primary_1.xlsx"),
    fixture("primary_2.xlsx"),
    fixture("primary_3.xlsx"),
    fixture("primary_4.xlsx"),
    fixture("primary_bad_amount.xlsx"),
  ]);

  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/jobs") && r.request().method() === "POST"),
    page.getByRole("button", { name: en.batch.start }).click(),
  ]);
  const { job_id: jobId } = await createResp.json();
  expect(jobId).toBeTruthy();

  await page.goto(`/jobs/${jobId}`);

  await expect
    .poll(async () => (await page.request.get(`/api/jobs/${jobId}`).then((r) => r.json())).status, {
      timeout: 30_000,
      intervals: [200, 300, 500],
    })
    .toBe("failed"); // JobService marks the whole job "failed" if any subtask fails.

  const snap = await page.request.get(`/api/jobs/${jobId}`).then((r) => r.json());
  expect(snap.done).toBe(4);
  expect(snap.failed).toBe(1);

  // The UI only shows a download button when status === "done" (JobDetail.tsx),
  // so a partial-failure ZIP is never reachable from the UI even though the
  // backend produces one — exercised directly against the API here.
  const zipResp = await page.request.get(`/api/jobs/${jobId}/zip`);
  expect(zipResp.ok()).toBe(true);
  const buf = await zipResp.body();
  expect(buf.byteLength).toBeGreaterThan(0);
});
