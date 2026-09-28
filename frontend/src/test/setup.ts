import { vi } from "vitest";

import "@testing-library/jest-dom/vitest";

// Compatibility shim: @testing-library's `waitFor`/`findBy*` only detect
// active fake timers by probing a global `jest` object — see
// jestFakeTimersAreEnabled() in
// node_modules/@testing-library/dom/dist/helpers.js:14-28, called from
// node_modules/@testing-library/react/dist/pure.js:84-97. Vitest never
// defines `jest`, so under `vi.useFakeTimers()` the internal
// `setTimeout(..., 0)` that `waitFor` awaits never gets advanced and the
// test hangs (and, worse, leaks fake timers into the next test). Vitest's
// own fake-timer install already sets `setTimeout.clock`, which is the
// other half of that detection, so the only missing piece is `jest` itself.
// Delete this once @testing-library ships native Vitest fake-timer support.
if (typeof (globalThis as { jest?: unknown }).jest === "undefined") {
  (globalThis as { jest?: { advanceTimersByTime: (ms: number) => unknown } }).jest = {
    advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
  };
}
