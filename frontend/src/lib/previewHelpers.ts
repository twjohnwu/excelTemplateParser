/** Pure helpers for the preview gate and checklist rail, extracted from
 * ConfigBuilder for unit testing. No i18n / React imports on purpose.
 */

import type { CellValue } from "./schemas";

/** Response shape of POST /api/configs/preview. */
export type PreviewResult = {
  columns: string[];
  rows: CellValue[][];
  truncated: boolean;
};

// ---------- Checklist rail ----------

export type StepId = "target" | "sources" | "joins" | "mappings" | "save";
export type StepStatus = "done" | "attention" | "pending";

export const STEP_IDS: StepId[] = ["target", "sources", "joins", "mappings", "save"];

/** Plain-data view of the builder's FormState — structural, so ConfigBuilder
 * can build it without previewHelpers importing page-level types. */
export type StepInput = {
  name: string;
  target: { hasFile: boolean; columns: string[] };
  sources: { alias: string; hasFile: boolean }[];
  joins: { left: string; right: string }[];
  mappings: {
    target: string;
    source?: string;
    literal?: CellValue;
    source_cell?: unknown;
  }[];
};

const qualified = (v: string) =>
  v.includes(".") && !v.startsWith(".") && !v.endsWith(".");

/** Bucket Zod issues into rail steps by the first path segment.
 * `name` and config-level issues (empty path) count against the save step. */
export function countIssuesByStep(
  issues: { path: (string | number)[] }[]
): Record<StepId, number> {
  const counts: Record<StepId, number> = { target: 0, sources: 0, joins: 0, mappings: 0, save: 0 };
  for (const issue of issues) {
    const head = issue.path[0];
    if (head === "target_template") counts.target += 1;
    else if (head === "sources") counts.sources += 1;
    else if (head === "joins") counts.joins += 1;
    else if (head === "mappings") counts.mappings += 1;
    else counts.save += 1;
  }
  return counts;
}

/** Mirror of the mapping XOR rule in schemas.ts (source / literal / source_cell). */
export function hasExactlyOneMode(m: StepInput["mappings"][number]): boolean {
  const hasSource = m.source !== undefined && m.source !== "";
  const hasLiteral = m.literal !== undefined && m.literal !== null && m.literal !== "";
  const hasCell = m.source_cell !== undefined && m.source_cell !== null;
  return [hasSource, hasLiteral, hasCell].filter(Boolean).length === 1;
}

/** Derive the rail step states. Attention (issue count > 0) wins over done;
 * an unmet completion condition without issues is pending. Guidance only —
 * never used to block editing. */
export function deriveStepStates(
  input: StepInput,
  issueCounts: Record<StepId, number>
): Record<StepId, StepStatus> {
  const noIssues = STEP_IDS.every((id) => issueCounts[id] === 0);
  const done: Record<StepId, boolean> = {
    target: input.target.hasFile && input.target.columns.filter(Boolean).length > 0,
    sources:
      input.sources.length > 0 &&
      input.sources.every((s) => s.hasFile && s.alias.trim() !== ""),
    // No joins is a legitimate config → the step is skippable/done.
    joins: input.joins.every((j) => qualified(j.left) && qualified(j.right)),
    mappings: input.mappings.length > 0 && input.mappings.every(hasExactlyOneMode),
    save: input.name.trim() !== "" && noIssues,
  };
  const out = {} as Record<StepId, StepStatus>;
  for (const id of STEP_IDS) {
    out[id] = issueCounts[id] > 0 ? "attention" : done[id] ? "done" : "pending";
  }
  return out;
}

// ---------- Preview gate ----------

export type PreviewGateInput = {
  /** state.target.file is an actual File object (loaded configs have null). */
  targetHasFile: boolean;
  /** Number of sources holding an actual File object. */
  sourceFileCount: number;
  /** configSchema.safeParse of the derived config succeeded. */
  schemaOk: boolean;
};

/** The preview button is enabled only when real uploads exist AND the current
 * state passes the schema — loaded configs without re-uploaded files stay off. */
export function canPreview(gate: PreviewGateInput): boolean {
  return gate.targetHasFile && gate.sourceFileCount > 0 && gate.schemaOk;
}
