import { describe, expect, it } from "vitest";

import { cellValueSchema, configSchema, conditionSchema, operatorSchema } from "./schemas";

const minimal = {
  version: "1.0",
  name: "demo",
  target_template: {
    sheet: "Sheet1",
    header_row: 1,
    columns: ["a"],
  },
  sources: [
    { alias: "primary", role: "primary", sheet: "S", header_row: 1 },
  ],
  joins: [],
  mappings: [
    { target: "a", source: "primary.a" },
  ],
};

describe("configSchema", () => {
  it("accepts a minimal valid config", () => {
    const r = configSchema.safeParse(minimal);
    expect(r.success).toBe(true);
  });

  it("rejects invalid name characters", () => {
    const r = configSchema.safeParse({ ...minimal, name: "bad/name" });
    expect(r.success).toBe(false);
  });

  it("trims whitespace around name", () => {
    const r = configSchema.parse({ ...minimal, name: "  demo  " });
    expect(r.name).toBe("demo");
  });

  it("rejects duplicate source aliases", () => {
    const r = configSchema.safeParse({
      ...minimal,
      sources: [
        { alias: "x", role: "primary", sheet: "S", header_row: 1 },
        { alias: "x", role: "lookup", sheet: "S", header_row: 1 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("requires at least one primary source", () => {
    const r = configSchema.safeParse({
      ...minimal,
      sources: [
        { alias: "x", role: "lookup", sheet: "S", header_row: 1 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects join referencing unknown alias", () => {
    const r = configSchema.safeParse({
      ...minimal,
      joins: [{ left: "primary.x", right: "missing.y", type: "left" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects mapping.source with unqualified field", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", source: "noDotJustText" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts optional sample_filename", () => {
    const r = configSchema.safeParse({
      ...minimal,
      target_template: { ...minimal.target_template, sample_filename: "target.xlsx" },
      sources: [
        { alias: "primary", role: "primary", sheet: "S", header_row: 1, sample_filename: "src.xlsx" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("accepts a literal mapping (no source)", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", literal: "fixed" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects mapping with both source and literal", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", source: "primary.a", literal: "x" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects mapping with neither source nor literal", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts a source_cell mapping", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", source_cell: { alias: "primary", address: "A3" } }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects source_cell with bad address", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", source_cell: { alias: "primary", address: "3A" } }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects source_cell.alias not in sources", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", source_cell: { alias: "ghost", address: "A1" } }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects mapping with source and source_cell both set", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [
        {
          target: "a",
          source: "primary.a",
          source_cell: { alias: "primary", address: "A1" },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a literal that is an object (tightened from z.unknown)", () => {
    const r = configSchema.safeParse({
      ...minimal,
      mappings: [{ target: "a", literal: { nested: true } }],
    });
    expect(r.success).toBe(false);
  });
});

describe("operatorSchema", () => {
  it("parses every supported operator", () => {
    for (const op of [">=", "<=", "==", "!=", "contains", "regex", "in"]) {
      expect(operatorSchema.safeParse(op).success).toBe(true);
    }
  });

  it("rejects an unknown operator", () => {
    expect(operatorSchema.safeParse("~=").success).toBe(false);
  });
});

describe("cellValueSchema", () => {
  it("accepts string, number, boolean, null", () => {
    for (const v of ["x", 3, true, null]) {
      expect(cellValueSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects objects and undefined", () => {
    expect(cellValueSchema.safeParse({ a: 1 }).success).toBe(false);
    expect(cellValueSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("conditionSchema.value", () => {
  it("accepts a scalar value", () => {
    const r = conditionSchema.safeParse({ field: "a.b", op: "==", value: 5 });
    expect(r.success).toBe(true);
  });

  it("accepts an array value (for the `in` operator)", () => {
    const r = conditionSchema.safeParse({ field: "a.b", op: "in", value: ["x", "y"] });
    expect(r.success).toBe(true);
  });

  it("rejects an object value", () => {
    const r = conditionSchema.safeParse({ field: "a.b", op: "==", value: { x: 1 } });
    expect(r.success).toBe(false);
  });
});
