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
