import { describe, expect, it } from "vitest";

import {
  fmtTime,
  inferColumnsFromConfig,
  mergeMappingsWithColumns,
} from "./configHelpers";
import type { Config, Mapping } from "./schemas";

const baseCfg: Config = {
  version: "1.0",
  name: "demo",
  target_template: {
    sheet: "S",
    header_row: 1,
    preserve_styles: true,
    columns: ["a"],
  },
  sources: [
    { alias: "primary", role: "primary", sheet: "S", header_row: 1 },
    { alias: "lookup1", role: "lookup", sheet: "S", header_row: 1 },
  ],
  joins: [{ left: "primary.x", right: "lookup1.y", type: "left" }],
  mappings: [
    {
      target: "a",
      source: "primary.col1",
      conditions: [{ field: "lookup1.z", op: "==", value: "v" }],
      default: "",
    },
  ],
};

describe("mergeMappingsWithColumns", () => {
  it("creates one mapping row per column when existing is empty", () => {
    const out = mergeMappingsWithColumns([], ["a", "b", "c"]);
    expect(out.map((m) => m.target)).toEqual(["a", "b", "c"]);
    expect(out[0].source).toBe("");
  });

  it("preserves existing mapping when target matches a column", () => {
    const existing: Mapping[] = [
      { target: "a", source: "primary.x", conditions: [], default: "" },
    ];
    const out = mergeMappingsWithColumns(existing, ["a", "b"]);
    expect(out[0].source).toBe("primary.x");
    expect(out[1].source).toBe("");
  });

  it("keeps orphan mappings at the tail", () => {
    const existing: Mapping[] = [
      { target: "a", source: "primary.x", conditions: [], default: "" },
      { target: "custom", source: "primary.y", conditions: [], default: "" },
    ];
    const out = mergeMappingsWithColumns(existing, ["a", "b"]);
    expect(out.map((m) => m.target)).toEqual(["a", "b", "custom"]);
  });

  it("ignores empty column names", () => {
    const out = mergeMappingsWithColumns([], ["a", "", "b"]);
    expect(out.map((m) => m.target)).toEqual(["a", "b"]);
  });
});

describe("inferColumnsFromConfig", () => {
  it("collects alias.col references from joins and mappings", () => {
    const inferred = inferColumnsFromConfig(baseCfg);
    expect(inferred.primary).toEqual(expect.arrayContaining(["x", "col1"]));
    expect(inferred.lookup1).toEqual(expect.arrayContaining(["y", "z"]));
  });

  it("returns empty object for empty config", () => {
    const cfg: Config = { ...baseCfg, joins: [], mappings: [
      { target: "a", source: "primary.x", conditions: [], default: "" },
    ] };
    const inferred = inferColumnsFromConfig(cfg);
    expect(inferred).toEqual({ primary: ["x"] });
  });

  it("skips malformed references without a dot", () => {
    const cfg: Config = {
      ...baseCfg,
      joins: [],
      mappings: [{ target: "a", source: "primary.x", conditions: [], default: "" }],
    };
    expect(() => inferColumnsFromConfig(cfg)).not.toThrow();
  });

  it("deduplicates columns referenced multiple times", () => {
    const cfg: Config = {
      ...baseCfg,
      mappings: [
        { target: "a", source: "primary.x", conditions: [], default: "" },
        { target: "b", source: "primary.x", conditions: [], default: "" },
      ],
    };
    const inferred = inferColumnsFromConfig(cfg);
    expect(inferred.primary).toEqual(["x"]);
  });

  it("literal-only mappings don't pollute inferred columns", () => {
    const cfg: Config = {
      ...baseCfg,
      joins: [],
      mappings: [
        { target: "a", source: "primary.x", conditions: [], default: "" },
        { target: "stamp", literal: "fixed", conditions: [], default: "" },
      ],
    };
    const inferred = inferColumnsFromConfig(cfg);
    expect(inferred).toEqual({ primary: ["x"] });
  });
});

describe("fmtTime", () => {
  it("formats valid ISO into locale string", () => {
    const out = fmtTime("2026-05-18T10:30:00Z");
    expect(out).toMatch(/\d{2}\/\d{2}/);
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it("returns empty string for invalid input", () => {
    expect(fmtTime("not-a-date")).toBe("");
    expect(fmtTime("")).toBe("");
  });
});
