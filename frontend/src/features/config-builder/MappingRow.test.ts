import { describe, expect, it } from "vitest";

import { modeOf } from "./MappingRow";
import type { Mapping } from "@/lib/schemas";

const base: Mapping = { target: "x", conditions: [], default: "" };

describe("modeOf", () => {
  it("returns source when source is set and literal is absent", () => {
    expect(modeOf({ ...base, source: "primary.col" })).toBe("source");
  });

  it("returns literal when literal is a non-empty string", () => {
    expect(modeOf({ ...base, literal: "fixed" })).toBe("literal");
  });

  // The regression: after switchTo("literal") sets literal="" we must already
  // be in literal mode, otherwise the toggle UI bounces back to "source" and
  // the source dropdown looks reset.
  it("returns literal when literal is an empty string (just toggled)", () => {
    expect(modeOf({ ...base, literal: "" })).toBe("literal");
  });

  it("returns literal for falsy non-string literals (0 / false)", () => {
    expect(modeOf({ ...base, literal: 0 })).toBe("literal");
    expect(modeOf({ ...base, literal: false })).toBe("literal");
  });

  it("returns source when neither field is set", () => {
    expect(modeOf(base)).toBe("source");
  });

  // Backend pydantic serializes Mapping.literal=None to JSON `"literal": null`
  // (no exclude_none). Loaded configs must still default to source mode.
  it("returns source when literal is null (loaded from backend)", () => {
    expect(modeOf({ ...base, literal: null, source: "primary.col" })).toBe("source");
  });

  it("returns source_cell when source_cell is set", () => {
    expect(
      modeOf({ ...base, source_cell: { alias: "meta", address: "A3" } }),
    ).toBe("source_cell");
  });

  it("returns source when source_cell is null (backend-serialized)", () => {
    expect(modeOf({ ...base, source_cell: null, source: "primary.col" })).toBe("source");
  });

  it("prefers literal over source_cell when both somehow set", () => {
    expect(
      modeOf({ ...base, literal: "x", source_cell: { alias: "m", address: "A1" } }),
    ).toBe("literal");
  });
});
