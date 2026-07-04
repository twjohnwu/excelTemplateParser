import { describe, expect, it } from "vitest";

import {
  canPreview,
  countIssuesByStep,
  deriveStepStates,
  hasExactlyOneMode,
  STEP_IDS,
  type StepInput,
} from "./previewHelpers";

const zeroCounts = { target: 0, sources: 0, joins: 0, mappings: 0, save: 0 };

const completeInput: StepInput = {
  name: "demo",
  target: { hasFile: true, columns: ["a", "b"] },
  sources: [
    { alias: "primary", hasFile: true },
    { alias: "lookup1", hasFile: true },
  ],
  joins: [{ left: "primary.id", right: "lookup1.id" }],
  mappings: [
    { target: "a", source: "primary.x" },
    { target: "b", literal: "fixed" },
  ],
};

describe("canPreview", () => {
  it("enables only when target file, ≥1 source file, and schema all pass", () => {
    expect(canPreview({ targetHasFile: true, sourceFileCount: 1, schemaOk: true })).toBe(true);
  });

  it("stays disabled without a real target File (loaded config case)", () => {
    expect(canPreview({ targetHasFile: false, sourceFileCount: 2, schemaOk: true })).toBe(false);
  });

  it("stays disabled with zero uploaded source files", () => {
    expect(canPreview({ targetHasFile: true, sourceFileCount: 0, schemaOk: true })).toBe(false);
  });

  it("stays disabled when the schema fails", () => {
    expect(canPreview({ targetHasFile: true, sourceFileCount: 1, schemaOk: false })).toBe(false);
  });
});

describe("countIssuesByStep", () => {
  it("buckets issues by first path segment", () => {
    const counts = countIssuesByStep([
      { path: ["target_template", "sheet"] },
      { path: ["sources", 0, "alias"] },
      { path: ["sources"] },
      { path: ["joins", 1] },
      { path: ["mappings", 2, "source"] },
      { path: ["name"] },
      { path: [] },
    ]);
    expect(counts).toEqual({ target: 1, sources: 2, joins: 1, mappings: 1, save: 2 });
  });

  it("returns all zeros for no issues", () => {
    expect(countIssuesByStep([])).toEqual(zeroCounts);
  });
});

describe("hasExactlyOneMode", () => {
  it("accepts exactly one of source / literal / source_cell", () => {
    expect(hasExactlyOneMode({ target: "a", source: "primary.x" })).toBe(true);
    expect(hasExactlyOneMode({ target: "a", literal: "v" })).toBe(true);
    expect(hasExactlyOneMode({ target: "a", source_cell: { alias: "p", address: "A1" } })).toBe(true);
  });

  it("rejects zero modes (empty strings and nulls don't count)", () => {
    expect(hasExactlyOneMode({ target: "a" })).toBe(false);
    expect(hasExactlyOneMode({ target: "a", source: "", literal: "", source_cell: null })).toBe(false);
  });

  it("rejects more than one mode", () => {
    expect(hasExactlyOneMode({ target: "a", source: "primary.x", literal: "v" })).toBe(false);
  });
});

describe("deriveStepStates", () => {
  it("marks every step done for a complete, issue-free state", () => {
    const states = deriveStepStates(completeInput, zeroCounts);
    for (const id of STEP_IDS) expect(states[id]).toBe("done");
  });

  it("marks everything pending on the initial empty state", () => {
    const input: StepInput = {
      name: "",
      target: { hasFile: false, columns: [] },
      sources: [{ alias: "primary", hasFile: false }],
      joins: [],
      mappings: [],
    };
    const states = deriveStepStates(input, zeroCounts);
    expect(states.target).toBe("pending");
    expect(states.sources).toBe("pending");
    expect(states.mappings).toBe("pending");
    expect(states.save).toBe("pending");
    // No joins is a valid config → the step counts as done (skippable).
    expect(states.joins).toBe("done");
  });

  it("attention (issue count) wins over the done condition", () => {
    const states = deriveStepStates(completeInput, { ...zeroCounts, mappings: 3 });
    expect(states.mappings).toBe("attention");
  });

  it("target needs both a File and loaded columns", () => {
    const noCols = { ...completeInput, target: { hasFile: true, columns: [] } };
    expect(deriveStepStates(noCols, zeroCounts).target).toBe("pending");
    const noFile = { ...completeInput, target: { hasFile: false, columns: ["a"] } };
    expect(deriveStepStates(noFile, zeroCounts).target).toBe("pending");
  });

  it("sources need a file and a non-empty alias on every entry", () => {
    const blankAlias = {
      ...completeInput,
      sources: [{ alias: "  ", hasFile: true }],
    };
    expect(deriveStepStates(blankAlias, zeroCounts).sources).toBe("pending");
    const missingFile = {
      ...completeInput,
      sources: [{ alias: "primary", hasFile: false }],
    };
    expect(deriveStepStates(missingFile, zeroCounts).sources).toBe("pending");
  });

  it("joins present must all be qualified alias.column refs", () => {
    const badJoin = { ...completeInput, joins: [{ left: "primary.id", right: "noDot" }] };
    expect(deriveStepStates(badJoin, zeroCounts).joins).toBe("pending");
  });

  it("mappings step requires every row to have exactly one mode", () => {
    const badMapping = {
      ...completeInput,
      mappings: [{ target: "a", source: "primary.x", literal: "clash" }],
    };
    expect(deriveStepStates(badMapping, zeroCounts).mappings).toBe("pending");
  });

  it("save stays pending while other steps still have issues", () => {
    const states = deriveStepStates(completeInput, { ...zeroCounts, joins: 1 });
    expect(states.save).toBe("pending");
  });

  it("save needs a non-empty name", () => {
    const noName = { ...completeInput, name: "  " };
    expect(deriveStepStates(noName, zeroCounts).save).toBe("pending");
  });
});
