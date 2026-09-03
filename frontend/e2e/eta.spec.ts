// VERIFICATION_REPORT §8.19 — ETA after >=5 subtasks done
import { test, expect } from "@playwright/test";

import { batchTestConfig, createConfig, en, fixture, setLanguage } from "./helpers";

// backend/app/services/job_service.py:36 ETA_MIN_SAMPLES = 5. The job needs
// more than 5 primaries so eta_seconds can be observed while status is still
// "running" (not yet "done") right after the 5th subtask completes; a wider
// margin than the strict minimum leaves room for the SSE listener below to
// attach before the (4 concurrent RQ workers) job finishes.
const PRIMARY_COUNT = 12;

test("ETA becomes available once >=5 of 12 subtasks are done", async ({ page, request }) => {
  const configName = `e2e_eta_${Date.now()}`;
  await createConfig(request, configName, batchTestConfig(configName));

  await setLanguage(page, "en");
  await page.goto("/batch");

  const configSelect = page.getByText(en.batch.selectConfig, { exact: true }).locator("xpath=..").locator("select");
  await configSelect.selectOption(configName);

  const targetSlot = page.getByText(en.batch.targetTemplate).locator("xpath=..");
  await targetSlot.locator('input[type="file"]').setInputFiles(fixture("target.xlsx"));

  const orderSlot = page.locator("label", { hasText: "orders" }).locator("xpath=..");
  await orderSlot
    .locator('input[type="file"]')
    .setInputFiles(Array.from({ length: PRIMARY_COUNT }, (_, i) => fixture(`primary_${i + 1}.xlsx`)));

  const [createResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/jobs") && r.request().method() === "POST"),
    page.getByRole("button", { name: en.batch.start }).click(),
  ]);
  const { job_id: jobId } = await createResp.json();
  expect(jobId).toBeTruthy();

  // Subscribe to the same SSE channel the UI uses (useJobSnapshot) and
  // re-fetch the full snapshot on every event, exactly like the app's
  // `onUpdate` handler does (frontend/src/hooks/useJobSnapshot.ts). This is
  // event-driven rather than timer-polled, so it can't miss the moment
  // done+failed crosses ETA_MIN_SAMPLES no matter how fast the 4 RQ workers
  // race through these tiny files. Started immediately off the create
  // response — no intermediate navigation — so it can't lose the race to a
  // job that finishes before we'd otherwise get around to opening it.
  const snapshots = await page.evaluate(async (id) => {
    return new Promise<any[]>((resolve) => {
      const seen: any[] = [];
      const es = new EventSource(`/api/jobs/${id}/events`);
      const fetchSnapshot = () =>
        fetch(`/api/jobs/${id}`)
          .then((r) => r.json())
          .then((snap) => {
            seen.push(snap);
            if (snap.status === "done" || snap.status === "failed") {
              es.close();
              resolve(seen);
            }
          });
      es.addEventListener("snapshot", fetchSnapshot);
      es.addEventListener("update", fetchSnapshot);
      setTimeout(() => {
        es.close();
        resolve(seen);
      }, 30_000);
    });
  }, jobId);

  expect(snapshots.at(-1)?.status).toBe("done");
  const sawEtaWhileRunning = snapshots.some(
    (snap) => snap.status !== "done" && snap.done + snap.failed >= 5 && snap.eta_seconds != null
  );
  expect(sawEtaWhileRunning).toBe(true);
});
