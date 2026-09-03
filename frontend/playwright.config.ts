import { defineConfig, devices } from "@playwright/test";

/** e2e config: targets the docker-compose stack (nginx :5173 → api :8000),
 * not the Vite dev server. Start the stack with `bash scripts/up.sh` first —
 * no `webServer` is configured here on purpose.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  // The backend behind baseURL is a single docker-compose stack (4 RQ
  // workers total) shared by every test — running batch-job specs (eta,
  // partial-failure) concurrently made them contend for the same worker
  // pool and occasionally exceed the default 30s test timeout. Serial
  // execution trades a bit of wall-clock time for a suite that doesn't flake.
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
