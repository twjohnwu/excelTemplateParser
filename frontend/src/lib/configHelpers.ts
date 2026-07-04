/** Pure helpers extracted from ConfigBuilder for unit testing. */

import type { Config, Mapping } from "./schemas";

/** Merge existing mappings with the target template's header columns.
 * - Each column becomes one row; existing mapping for that target is kept verbatim.
 * - Mappings whose target isn't in `columns` are kept at the end (manual rows).
 */
export function mergeMappingsWithColumns(existing: Mapping[], columns: string[]): Mapping[] {
  const byTarget = new Map(existing.map((m) => [m.target, m]));
  const out: Mapping[] = [];
  for (const col of columns) {
    if (!col) continue;
    const found = byTarget.get(col);
    if (found) {
      out.push(found);
      byTarget.delete(col);
    } else {
      out.push({ target: col, source: "", conditions: [], default: "" });
    }
  }
  for (const leftover of byTarget.values()) out.push(leftover);
  return out;
}

/** Pull every `alias.col` reference from an existing config so dropdowns work
 * when the user loads a config without re-uploading the xlsx files.
 */
export function inferColumnsFromConfig(cfg: Config): Record<string, string[]> {
  const byAlias: Record<string, Set<string>> = {};
  const add = (q: string | undefined) => {
    if (!q) return;  // literal mappings have no source — skip
    const dot = q.indexOf(".");
    if (dot <= 0 || dot === q.length - 1) return;
    const alias = q.slice(0, dot);
    const col = q.slice(dot + 1);
    (byAlias[alias] ??= new Set()).add(col);
  };
  cfg.joins.forEach((j) => {
    add(j.left);
    add(j.right);
  });
  cfg.mappings.forEach((m) => {
    add(m.source);
    m.conditions.forEach((c) => add(c.field));
  });
  return Object.fromEntries(
    Object.entries(byAlias).map(([k, v]) => [k, Array.from(v)])
  );
}

/** A minimal source view for column-existence validation. Only sources whose
 * columns were freshly populated from a real upload can be validated — a
 * loaded config's columns are inferred from the config itself and would
 * false-positive against themselves. `hasUpload` is that gate. */
export type ColumnCheckSource = {
  alias: string;
  columns: string[];
  hasUpload: boolean;
};

/** Split a qualified `alias.col` reference into its two parts.
 * Returns null when it isn't a well-formed qualified reference. */
function splitQualified(ref: string | undefined): { alias: string; col: string } | null {
  if (!ref) return null;
  const dot = ref.indexOf(".");
  if (dot <= 0 || dot === ref.length - 1) return null;
  return { alias: ref.slice(0, dot), col: ref.slice(dot + 1) };
}

/** Decide whether a single `alias.col` reference names a column that does NOT
 * exist in its (validatable) source. Returns true only when we are confident:
 * - the ref is well-formed,
 * - its alias matches a source whose columns came from a fresh upload,
 * - and that source's column list does not contain the column.
 * Everything else (unknown alias, inferred-only source, malformed ref) returns
 * false so we never false-positive on loaded configs. Unknown-alias errors are
 * the Zod backstop's job. */
export function columnRefMissing(
  ref: string | undefined,
  sources: ColumnCheckSource[]
): boolean {
  const parsed = splitQualified(ref);
  if (!parsed) return false;
  const src = sources.find((s) => s.alias === parsed.alias);
  if (!src || !src.hasUpload) return false;
  return !src.columns.includes(parsed.col);
}

export type ColumnWarnings = {
  /** join index → sides ("left"/"right") whose column doesn't exist */
  joins: Record<number, ("left" | "right")[]>;
  /** mapping index → true when its `source` references a missing column */
  mappings: Record<number, boolean>;
};

/** Compute per-join and per-mapping column-existence warnings against the set
 * of sources that have freshly-uploaded columns. Used to surface inline
 * warnings in the UI without blocking edits or save. */
export function computeColumnWarnings(
  joins: { left: string; right: string }[],
  mappings: { source?: string }[],
  sources: ColumnCheckSource[]
): ColumnWarnings {
  const out: ColumnWarnings = { joins: {}, mappings: {} };
  joins.forEach((j, i) => {
    const sides: ("left" | "right")[] = [];
    if (columnRefMissing(j.left, sources)) sides.push("left");
    if (columnRefMissing(j.right, sources)) sides.push("right");
    if (sides.length > 0) out.joins[i] = sides;
  });
  mappings.forEach((m, i) => {
    if (columnRefMissing(m.source, sources)) out.mappings[i] = true;
  });
  return out;
}

/** Format an ISO date string as MM/DD HH:mm using the user's locale. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
