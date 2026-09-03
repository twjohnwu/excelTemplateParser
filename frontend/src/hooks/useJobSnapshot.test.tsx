import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, subscribeJobEvents } from "@/lib/api";

import { useJobSnapshot } from "./useJobSnapshot";

// EventSource isn't implemented in jsdom, so we mock the api module's
// subscribeJobEvents directly rather than the transport — same style as
// mocking any other collaborator, and it still exercises the real
// `onUpdate` wiring in useJobSnapshot.ts.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
  subscribeJobEvents: vi.fn(),
}));

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job1",
    status: "running",
    total: 1,
    done: 0,
    failed: 0,
    eta_seconds: null,
    config_name: "demo",
    download_expires_at: null,
    zip_ready: false,
    ...overrides,
  };
}

describe("useJobSnapshot", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue(makeSnapshot());
  });

  it("refetches the snapshot on both `update` and `finalized` SSE messages", async () => {
    let handlers: Parameters<typeof subscribeJobEvents>[1] = {};
    vi.mocked(subscribeJobEvents).mockImplementation((_jobId, h) => {
      handlers = h;
      return () => {};
    });

    renderHook(() => useJobSnapshot("job1"));

    // Initial fetch on mount.
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    // A plain `update` (e.g. subtask.done) refetches.
    handlers.onUpdate?.({ type: "subtask.done" });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    // The `finalized` event rides the same SSE `update` channel
    // (backend/app/api/jobs.py wraps every pub/sub message as `update`) —
    // it must also trigger a refetch so zip_ready flips live.
    handlers.onUpdate?.({ type: "finalized" });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  });
});
