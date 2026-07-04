import { describe, expect, it } from "vitest";
import { z } from "zod";

import { bucketIssues, humanizeIssue } from "./issueHelpers";

// ── helpers ────────────────────────────────────────────────────────────────

function makeIssue(path: (string | number)[], message: string, params?: Record<string, unknown>): z.ZodIssue {
  return {
    code: z.ZodIssueCode.custom,
    path,
    message,
    ...(params ? { params } : {}),
  } as z.ZodIssue;
}

// ── bucketIssues ───────────────────────────────────────────────────────────

describe("bucketIssues", () => {
  it("routes name issues to name bucket", () => {
    const issue = makeIssue(["name"], "err.invalidName");
    const b = bucketIssues([issue]);
    expect(b.name).toHaveLength(1);
    expect(b.sources).toHaveLength(0);
    expect(b.mappingsByIndex.size).toBe(0);
  });

  it("routes sources-level issues (no index) to sources bucket", () => {
    const issue = makeIssue(["sources"], "err.duplicateAlias");
    const b = bucketIssues([issue]);
    expect(b.sources).toHaveLength(1);
    expect(b.sourcesByIndex.size).toBe(0);
  });

  it("routes sources.N issues to sourcesByIndex", () => {
    const issue = makeIssue(["sources", 2, "alias"], "err.qualified");
    const b = bucketIssues([issue]);
    expect(b.sourcesByIndex.get(2)).toHaveLength(1);
  });

  it("routes joins.N issues to joinsByIndex", () => {
    const issue = makeIssue(["joins", 0], "err.joinUnknownAlias", { alias: "ghost" });
    const b = bucketIssues([issue]);
    expect(b.joinsByIndex.get(0)).toHaveLength(1);
  });

  it("routes mappings.N.* absolute paths to mappingsByIndex", () => {
    const issue1 = makeIssue(["mappings", 3, "source"], "err.requireOneMode");
    const issue2 = makeIssue(["mappings", 3, "source_cell", "address"], "err.cellAddress");
    const b = bucketIssues([issue1, issue2]);
    expect(b.mappingsByIndex.get(3)).toHaveLength(2);
    expect(b.mappingsByIndex.size).toBe(1);
  });

  it("accumulates multiple issues per index", () => {
    const issues = [
      makeIssue(["mappings", 1, "source"], "err.requireOneMode"),
      makeIssue(["mappings", 1, "source"], "err.qualified"),
      makeIssue(["mappings", 5, "source"], "err.requireOneMode"),
    ];
    const b = bucketIssues(issues);
    expect(b.mappingsByIndex.get(1)).toHaveLength(2);
    expect(b.mappingsByIndex.get(5)).toHaveLength(1);
  });

  it("returns empty buckets for no issues", () => {
    const b = bucketIssues([]);
    expect(b.name).toHaveLength(0);
    expect(b.sources).toHaveLength(0);
    expect(b.sourcesByIndex.size).toBe(0);
    expect(b.joinsByIndex.size).toBe(0);
    expect(b.mappingsByIndex.size).toBe(0);
  });
});

// ── humanizeIssue ──────────────────────────────────────────────────────────

describe("humanizeIssue", () => {
  const mappings = [
    { target: "金額" },
    { target: "" },        // empty target → fallback to row number
    { target: "  " },      // whitespace-only → also fallback
    { target: "客戶名稱" },
  ];

  it("uses target name as label for mappings.N with non-empty target", () => {
    const issue = makeIssue(["mappings", 0, "source"], "err.requireOneMode");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.mappingRow");
    expect(h.labelParams).toEqual({ target: "金額" });
    expect(h.messageKey).toBe("err.requireOneMode");
  });

  it("uses 1-based row number for mappings.N with empty target", () => {
    const issue = makeIssue(["mappings", 1, "source"], "err.requireOneMode");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.mappingRowN");
    expect(h.labelParams).toEqual({ n: 2 }); // 0-based 1 → 1-based 2
  });

  it("uses 1-based row number for mappings.N with whitespace target", () => {
    const issue = makeIssue(["mappings", 2, "source"], "err.requireOneMode");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.mappingRowN");
    expect(h.labelParams).toEqual({ n: 3 }); // 0-based 2 → 1-based 3
  });

  it("uses 1-based index for join label", () => {
    const issue = makeIssue(["joins", 0], "err.joinUnknownAlias", { alias: "ghost" });
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.join");
    expect(h.labelParams).toEqual({ n: 1 });
    expect(h.messageParams).toEqual({ alias: "ghost" });
  });

  it("uses sources label for sources-level issues", () => {
    const issue = makeIssue(["sources"], "err.duplicateAlias");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.sources");
    expect(h.messageKey).toBe("err.duplicateAlias");
  });

  it("uses name label for name issues", () => {
    const issue = makeIssue(["name"], "err.invalidName");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.name");
  });

  it("handles mappings.N.source_cell.address (deep path, same index bucket)", () => {
    const issue = makeIssue(["mappings", 3, "source_cell", "address"], "err.cellAddress");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("issue.label.mappingRow");
    expect(h.labelParams).toEqual({ target: "客戶名稱" });
  });

  it("returns empty labelKey for unknown paths", () => {
    const issue = makeIssue(["unknown_field"], "err.qualified");
    const h = humanizeIssue(issue, mappings);
    expect(h.labelKey).toBe("");
  });

  it("handles mapping index out of bounds gracefully (fallback to row number)", () => {
    const issue = makeIssue(["mappings", 99, "source"], "err.requireOneMode");
    const h = humanizeIssue(issue, mappings); // mappings array only has 4 items
    expect(h.labelKey).toBe("issue.label.mappingRowN");
    expect(h.labelParams).toEqual({ n: 100 }); // 99 + 1 = 100
  });
});
