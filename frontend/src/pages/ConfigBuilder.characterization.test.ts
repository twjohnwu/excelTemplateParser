// Characterization test for ConfigBuilder.tsx, written BEFORE the
// configForm.ts extraction (STDD/create-project-wizard/tasks.md, `[INFRA]`
// "ConfigBuilder 抽取前特徵化測試"). It locks the CURRENT exact output of
// toConfig / toPersistable / restoreDraft (via readDraft())
// and the pristine autosave anti-clobber guard, so the next task — moving
// these into `@/lib/configForm` — can't silently reorder fields, drop a
// mapping xor branch, or weaken the guard without a test turning red.
//
// Every expected value below was read from real `toConfig`/`toPersistable`/
// `readDraft()` output during authoring, not invented from
// the task text.
//
// File stays `.ts` (not `.tsx`) per the task's own acceptance command; the
// one case that mounts the real component (autosaveSkipsWriting...) uses
// React.createElement instead of JSX for that reason.

import React from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Initializes the i18next singleton (side effect) so useTranslation() inside
// the mounted ConfigBuilder has resources instead of throwing.
import "@/i18n";

import { ConfigBuilder } from "./ConfigBuilder";
import {
  emptyState,
  readDraft,
  toConfig,
  toPersistable,
} from "@/lib/configForm";
import type { FormState } from "@/lib/configForm";

// ConfigBuilder's useConfigList() fetches on mount; stub the transport so
// the seventh case doesn't depend on a real backend being reachable.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn().mockResolvedValue({ configs: [] }) },
  };
});

const DRAFT_KEY = "etp.configDraft.v1";
const DEBOUNCE_MS = 1000;

function minimalValidState(): FormState {
  return {
    name: "demo",
    target: { file: null, sheet: "Sheet1", header_row: 1, columns: ["colA"] },
    sources: [
      { alias: "primary", role: "primary", file: null, sheet: "Data", header_row: 1, columns: [] },
    ],
    joins: [],
    mappings: [{ target: "colA", source: "primary.colA", conditions: [], default: "" }],
  };
}

describe("ConfigBuilder characterization (pre-extraction)", () => {
  it("toConfigOnEmptyStateReturnsExactIssuesSnapshot", () => {
    const result = toConfig(emptyState());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok: false");
    const simplified = result.issues.map((i) => ({ code: i.code, path: i.path, message: i.message }));
    expect(simplified).toEqual([
      { code: "custom", path: ["name"], message: "err.invalidName" },
      {
        code: "too_small",
        path: ["target_template", "sheet"],
        message: "String must contain at least 1 character(s)",
      },
      {
        code: "too_small",
        path: ["target_template", "columns"],
        message: "Array must contain at least 1 element(s)",
      },
      {
        code: "too_small",
        path: ["sources", 0, "sheet"],
        message: "String must contain at least 1 character(s)",
      },
      { code: "too_small", path: ["mappings"], message: "Array must contain at least 1 element(s)" },
    ]);
  });

  it("toConfigOnMinimalValidStateReturnsExactConfigShape", () => {
    const result = toConfig(minimalValidState());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok: true");
    expect(result.config).toEqual({
      version: "1.0",
      name: "demo",
      target_template: {
        sheet: "Sheet1",
        header_row: 1,
        preserve_styles: true,
        columns: ["colA"],
      },
      sources: [{ alias: "primary", role: "primary", sheet: "Data", header_row: 1 }],
      joins: [],
      mappings: [{ target: "colA", source: "primary.colA", conditions: [], default: "" }],
    });
  });

  it("toConfigOrdersOrphanTemplateColumnAfterMappingTargets", () => {
    const state = minimalValidState();
    // colA is the mapping target; colB and colC are orphan template columns
    // not referenced by any mapping.
    state.target.columns = ["colB", "colA", "colC"];
    const result = toConfig(state);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok: true");
    expect(result.config.target_template.columns).toEqual(["colA", "colB", "colC"]);
  });

  it("toConfigHandlesEachOfTheThreeMappingFillModes", () => {
    const state = minimalValidState();
    state.target.columns = ["colA", "colB", "colC"];
    state.mappings = [
      { target: "colA", source: "primary.colA", conditions: [], default: "" },
      { target: "colB", literal: "fixed", conditions: [], default: "" },
      { target: "colC", source_cell: { alias: "primary", address: "B2" }, conditions: [], default: "" },
    ];
    const result = toConfig(state);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok: true");
    expect(result.config.mappings).toEqual([
      { target: "colA", source: "primary.colA", conditions: [], default: "" },
      { target: "colB", literal: "fixed", conditions: [], default: "" },
      { target: "colC", source_cell: { alias: "primary", address: "B2" }, conditions: [], default: "" },
    ]);
  });

  it("toPersistableStripsFileFieldsToUndefinedInSerializedJson", () => {
    const targetFile = new File(["target-bytes"], "target.xlsx");
    const sourceFile = new File(["source-bytes"], "source.xlsx");
    const state = minimalValidState();
    state.target.file = targetFile;
    state.sources[0].file = sourceFile;

    const json = JSON.stringify(toPersistable(state));
    expect(json).not.toContain("target-bytes");
    expect(json).not.toContain("source-bytes");
    expect(json).not.toContain("target.xlsx");
    expect(json).not.toContain("source.xlsx");

    const parsed = JSON.parse(json);
    expect(parsed.target).not.toHaveProperty("file");
    expect(parsed.sources[0]).not.toHaveProperty("file");
  });

  it("restoreDraftMergesPresentFieldsDefaultsMissingKeysAndNullsFileFields", () => {
    // Deliberately missing `sources` and `target.header_row`.
    const raw = JSON.stringify({
      name: "abc",
      target: { sheet: "S1", columns: ["x"] },
      mappings: [],
    });
    localStorage.setItem(DRAFT_KEY, raw);

    const result = readDraft();

    expect(result?.ok).toBe(true);
    if (!result || !result.ok) throw new Error("expected ok: true");
    expect(result.state).toEqual({
      name: "abc",
      target: { file: null, sheet: "S1", header_row: 1, columns: ["x"] },
      sources: [],
      joins: [],
      mappings: [],
    });
  });

  it("autosaveSkipsWritingPristineStateOverExistingStoredDraft", () => {
    vi.useFakeTimers();
    try {
      const seeded = JSON.stringify({
        name: "seeded-draft",
        target: { sheet: "S1" },
        mappings: [],
      });
      localStorage.setItem(DRAFT_KEY, seeded);

      const qc = new QueryClient();
      render(
        React.createElement(
          QueryClientProvider,
          { client: qc },
          React.createElement(MemoryRouter, null, React.createElement(ConfigBuilder))
        )
      );

      vi.advanceTimersByTime(DEBOUNCE_MS + 500);

      // ConfigBuilder mounts in its pristine (emptyState) form here — no
      // ?config=, no user edits — so the debounced autosave effect must skip
      // writing (ConfigBuilder.tsx's `if (json === EMPTY_PERSISTABLE_JSON)
      // return;` guard) rather than clobbering the pre-existing draft.
      expect(localStorage.getItem(DRAFT_KEY)).toBe(seeded);
    } finally {
      vi.useRealTimers();
      localStorage.removeItem(DRAFT_KEY);
    }
  });
});
