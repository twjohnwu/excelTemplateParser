import { describe, expect, it } from "vitest";

import { isPristineState } from "./ConfigBuilder";
import type { JoinRule, Mapping } from "@/lib/schemas";

// Construct the minimal FormState shape that isPristineState expects.
// File objects can't be JSON-serialized, so the check strips them via
// toPersistable — we pass null for all files, matching the autosave path.
const pristine = () => ({
  name: "",
  target: { file: null as File | null, sheet: "", header_row: 1, columns: [] as string[] },
  sources: [
    { alias: "primary", role: "primary" as const, file: null as File | null, sheet: "", header_row: 1, columns: [] as string[] },
  ],
  joins: [] as JoinRule[],
  mappings: [] as Mapping[],
});

describe("isPristineState", () => {
  it("returns true for the default empty state", () => {
    expect(isPristineState(pristine())).toBe(true);
  });

  it("returns false when name is set", () => {
    expect(isPristineState({ ...pristine(), name: "my-project" })).toBe(false);
  });

  it("returns false when target columns are set", () => {
    const s = pristine();
    s.target = { ...s.target, columns: ["A", "B"] };
    expect(isPristineState(s)).toBe(false);
  });

  it("returns false when a target sheet is set", () => {
    const s = pristine();
    s.target = { ...s.target, sheet: "Sheet1" };
    expect(isPristineState(s)).toBe(false);
  });

  it("returns false when a source has a sheet", () => {
    const s = pristine();
    s.sources = [{ ...s.sources[0], sheet: "Data" }];
    expect(isPristineState(s)).toBe(false);
  });

  it("returns false when mappings are present", () => {
    const s = pristine();
    s.mappings = [{ target: "col", source: "primary.col", conditions: [], default: "" }];
    expect(isPristineState(s)).toBe(false);
  });

  it("returns false when joins are present", () => {
    const s = pristine();
    s.joins = [{ left: "primary.x", right: "lookup.y", type: "left" as const }];
    expect(isPristineState(s)).toBe(false);
  });
});
