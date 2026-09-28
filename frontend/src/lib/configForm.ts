/** Pure module extracted from ConfigBuilder.tsx (REQ-11, STDD/create-project-wizard).
 *
 * Behaviour-preserving extraction: `emptyState`/`toPersistable`/
 * `isPristineState`/`toConfig` are moved verbatim from
 * `ConfigBuilder.tsx:70-137` (locked by
 * `ConfigBuilder.characterization.test.ts`, written before this extraction).
 * `readDraft`/`writeDraft`/`draftWriterLabel` are the shared draft-storage
 * contract (REQ-08) that both the wizard and the existing three-pane
 * workbench read/write through — see `design-fe.md`'s
 * "pure module frontend/src/lib/configForm.ts (REQ-11)" section for the exact
 * behaviour rules (S-13 through S-17, S-20).
 *
 * This module is intentionally React/DOM-free (only `localStorage`), so it
 * can be shared by both entry points without pulling either UI in.
 */

import type { SourceEntry } from "@/features/config-builder/SourcesTree";
import { configSchema, type Config, type JoinRule, type Mapping } from "@/lib/schemas";
import type { z } from "zod";

// ---- Types ----

export type FormState = {
  name: string;
  target: {
    file: File | null;
    sheet: string;
    header_row: number;
    columns: string[];
    sample_filename?: string;
  };
  sources: SourceEntry[];
  joins: JoinRule[];
  mappings: Mapping[];
};

export type PersistableFormState = Omit<FormState, "target" | "sources"> & {
  target: Omit<FormState["target"], "file"> & { file: undefined };
  sources: (Omit<SourceEntry, "file"> & { file: undefined })[];
};

export type ToConfigResult =
  | { ok: true; config: Config }
  | { ok: false; issues: z.ZodIssue[] };

export type DraftWriter = "wizard" | "workbench";

export type DraftMeta = { version: number; writer: DraftWriter };

export type DraftReadResult =
  | { ok: true; state: FormState; meta: DraftMeta | null }
  | { ok: false; raw: string };

// ---- Constants ----

export const DRAFT_KEY = "etp.configDraft.v1";
export const DRAFT_META_VERSION = 1;
// PLACEHOLDER value — design-fe.md line 109 specifies a hardcoded CJK
// default-message literal here, but that conflicts with this repo's
// whole-tree i18n guard (src/lib/i18nGuard.test.ts), which forbids CJK
// literals outside src/i18n/*.json; ConfigBuilder.tsx itself has none (it
// uses t() throughout), so design-fe.md's "existing precedent" claim does
// not hold against the actual codebase. Left as an i18n key — callers must
// translate it (see the ConfigBuilder.tsx handleSave catch branch).
export const DEFAULT_SAVE_ERROR_KEY = "errors.generic";

// ---- Functions ----

// Moved verbatim from ConfigBuilder.tsx:70-78.
export function emptyState(): FormState {
  return {
    name: "",
    target: { file: null, sheet: "", header_row: 1, columns: [] },
    sources: [
      { alias: "primary", role: "primary", file: null, sheet: "", header_row: 1, columns: [] },
    ],
    joins: [],
    mappings: [],
  };
}

// File objects can't be JSON-serialized; strip them via undefined (which
// JSON.stringify omits) for both autosave and the empty-state comparison.
// Moved verbatim from ConfigBuilder.tsx:87-93.
export function toPersistable(s: FormState): PersistableFormState {
  return {
    ...s,
    target: { ...s.target, file: undefined },
    sources: s.sources.map((src) => ({ ...src, file: undefined })),
  };
}

// Pre-computed "this state matches emptyState" sentinel — writeDraft compares
// against this to avoid persisting a draft when the form was never touched
// (emptyState contains a default primary source, so a naive non-empty check
// gives false positives). Moved verbatim from ConfigBuilder.tsx:99.
export const EMPTY_PERSISTABLE_JSON = JSON.stringify(toPersistable(emptyState()));

/** Returns true when the form has never been touched: no name, no file,
 * no non-default columns, no joins, no mappings content. Reuses the same
 * EMPTY_PERSISTABLE_JSON sentinel so the definition stays in one place.
 * Moved verbatim from ConfigBuilder.tsx:104-106. */
export function isPristineState(s: FormState): boolean {
  return JSON.stringify(toPersistable(s)) === EMPTY_PERSISTABLE_JSON;
}

// Moved verbatim from ConfigBuilder.tsx:113-143.
export function toConfig(state: FormState): ToConfigResult {
  // target_template.columns is the writer's column order. Drive it from
  // mappings so user-added rows (targets not present in the template xlsx)
  // become real output columns instead of being silently dropped.
  const mappingTargets = state.mappings.map((m) => m.target).filter(Boolean);
  const templateCols = state.target.columns.filter(Boolean);
  const orphanTemplateCols = templateCols.filter((c) => !mappingTargets.includes(c));
  const columns = [...mappingTargets, ...orphanTemplateCols];

  const result = configSchema.safeParse({
    name: state.name,
    target_template: {
      sheet: state.target.sheet,
      header_row: state.target.header_row,
      preserve_styles: true,
      columns,
      sample_filename: state.target.file?.name ?? state.target.sample_filename,
    },
    sources: state.sources.map((s) => ({
      alias: s.alias,
      role: s.role,
      sheet: s.sheet,
      header_row: s.header_row,
      sample_filename: s.file?.name ?? s.sample_filename,
    })),
    joins: state.joins,
    mappings: state.mappings,
  });
  if (result.success) return { ok: true, config: result.data };
  return { ok: false, issues: result.error.issues };
}

/** REQ-07 / S-12: normalizes a raw save-failure message to a non-empty
 * string. The caller MUST translate the result when it === DEFAULT_SAVE_ERROR_KEY
 * (an i18n key, not human-readable text) — see ConfigBuilder.tsx's
 * handleSave catch branch. */
export function formatSaveError(rawMessage: string): string {
  return rawMessage.trim().length > 0 ? rawMessage : DEFAULT_SAVE_ERROR_KEY;
}

/** Reads the shared draft from localStorage.
 * - No stored value: returns null (no draft — not a failure).
 * - Stored value that fails JSON.parse, or parses to something that isn't a
 *   usable draft object (not a plain object, or a shape-dependent field has
 *   the wrong type, e.g. `sources` not an array): returns { ok: false, raw }
 *   — never throws, never clears the stored draft (S-15).
 * - Stored value that parses to a usable draft object: rebuilds a FormState
 *   using the same field defaulting rules as the pre-extraction
 *   restoreDraft() (target.file and sources[].file are always null; other
 *   fields fall back with `??`), and returns { ok: true, state, meta }, where
 *   meta is the sibling `_draftMeta` key if present and well-formed, else
 *   null (backward compatible with drafts written before meta existed). */
export function readDraft(): DraftReadResult | null {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (raw === null) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, raw };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, raw };
  }

  const rawTarget = parsed.target;
  if (rawTarget !== undefined && (typeof rawTarget !== "object" || rawTarget === null)) {
    return { ok: false, raw };
  }
  // target.columns feeds toConfig()'s `.filter(Boolean)` (configForm.ts:113)
  // and deriveStepStates()'s `.filter(Boolean)` (previewHelpers.ts:73)
  // unconditionally — a non-array value throws during render, not just a
  // failed zod parse.
  if (rawTarget?.columns !== undefined && !Array.isArray(rawTarget.columns)) {
    return { ok: false, raw };
  }

  // `name` is dereferenced with `.trim()` unconditionally on every render
  // (previewHelpers.ts's deriveStepStates `input.name.trim()`) — a
  // non-string value throws during render, not just a failed zod parse.
  if (parsed.name !== undefined && typeof parsed.name !== "string") {
    return { ok: false, raw };
  }

  const rawSources = parsed.sources;
  if (rawSources !== undefined && !Array.isArray(rawSources)) {
    return { ok: false, raw };
  }
  // Each source's `alias` is dereferenced with `.trim()` in
  // deriveStepStates() (previewHelpers.ts:76) with no guard of its own — a
  // missing or wrong-typed alias throws during render.
  if (
    rawSources !== undefined &&
    rawSources.some(
      (s: any) => typeof s !== "object" || s === null || typeof s.alias !== "string"
    )
  ) {
    return { ok: false, raw };
  }

  const rawJoins = parsed.joins;
  if (rawJoins !== undefined && !Array.isArray(rawJoins)) {
    return { ok: false, raw };
  }
  // Each join's `left`/`right` are dereferenced with `.includes`/
  // `.startsWith`/`.endsWith` via deriveStepStates()'s `qualified()` helper
  // (previewHelpers.ts:36-37, 78) — non-string values throw during render.
  if (
    rawJoins !== undefined &&
    rawJoins.some(
      (j: any) =>
        typeof j !== "object" ||
        j === null ||
        typeof j.left !== "string" ||
        typeof j.right !== "string"
    )
  ) {
    return { ok: false, raw };
  }

  const rawMappings = parsed.mappings;
  if (rawMappings !== undefined && !Array.isArray(rawMappings)) {
    return { ok: false, raw };
  }
  // Each mapping element is dereferenced directly (`m.source`, `m.literal`,
  // `m.source_cell` in previewHelpers.ts's hasExactlyOneMode, and `m.target`
  // in toConfig() at configForm.ts:112) — a null element throws.
  if (
    rawMappings !== undefined &&
    rawMappings.some((m: any) => typeof m !== "object" || m === null)
  ) {
    return { ok: false, raw };
  }
  // Each mapping element's `target` is dereferenced with `?.trim()` in
  // issueHelpers.ts's humanizeIssue — optional chaining guards
  // null/undefined, not a wrong-typed value like a number.
  if (
    rawMappings !== undefined &&
    rawMappings.some((m: any) => m.target !== undefined && typeof m.target !== "string")
  ) {
    return { ok: false, raw };
  }

  const rawMeta = parsed._draftMeta;
  // A version mismatch means the stored draft was written by a different
  // shape of this module (e.g. a later release changed target.columns to a
  // keyed object) — the field-level checks above only catch shapes that
  // happen to look wrong; a shape that happens to still type-check (e.g.
  // columns still an array, just with different semantics) would sail
  // through. Treat any explicit mismatch as unusable, same as any other
  // malformed draft: return { ok: false, raw } so the stored text survives
  // for the user to discard, without ever silently rebuilding a stale-shape
  // FormState.
  if (
    rawMeta &&
    typeof rawMeta === "object" &&
    typeof rawMeta.version === "number" &&
    rawMeta.version !== DRAFT_META_VERSION
  ) {
    return { ok: false, raw };
  }

  const state: FormState = {
    name: parsed.name ?? "",
    target: {
      file: null,
      sheet: rawTarget?.sheet ?? "",
      header_row: rawTarget?.header_row ?? 1,
      columns: rawTarget?.columns ?? [],
      sample_filename: rawTarget?.sample_filename,
    },
    sources: (rawSources ?? []).map((s: any) => ({ ...s, file: null })),
    joins: rawJoins ?? [],
    mappings: rawMappings ?? [],
  };

  const meta: DraftMeta | null =
    rawMeta &&
    typeof rawMeta.version === "number" &&
    (rawMeta.writer === "wizard" || rawMeta.writer === "workbench")
      ? { version: rawMeta.version, writer: rawMeta.writer }
      : null;

  return { ok: true, state, meta };
}

/** Writes the shared draft to localStorage (REQ-08 anti-clobber invariant,
 * S-14/S-16/S-20). Pristine-state write attempts are skipped entirely — they
 * neither write nor clear the existing stored draft — carrying forward the
 * guard that lived at ConfigBuilder.tsx:303
 * (`if (json === EMPTY_PERSISTABLE_JSON) return;`). Only a genuine (non-
 * pristine) write attaches the `_draftMeta` version/writer marker as a
 * sibling key of the persisted payload. */
export function writeDraft(state: FormState, writer: DraftWriter): void {
  const payload = toPersistable(state);
  const json = JSON.stringify(payload);
  // Pristine skip-write guard (REQ-08 anti-clobber invariant, S-20) — do NOT
  // remove: a fresh mount / wizard start must not clobber an existing draft.
  if (json === EMPTY_PERSISTABLE_JSON) return;
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ ...payload, _draftMeta: { version: DRAFT_META_VERSION, writer } })
    );
  } catch {
    /* quota */
  }
}

/** Returns the i18n KEY for a DraftWriter marker (S-14). The caller must
 * pass the result through `t()` to render display text — this module stays
 * i18n-key-only and must contain no CJK literals, in any form including
 * Unicode escape sequences, per frontend/src/lib/i18nGuard.test.ts. */
export function draftWriterLabel(writer: DraftWriter): string {
  return writer === "wizard"
    ? "wizard.draftRestore.writerWizard"
    : "wizard.draftRestore.writerWorkbench";
}

export type DraftSummary = {
  name: string;
  targetFilename: string | null;
  sourceFilenames: (string | null)[];
  joinCount: number;
  mappingCount: number;
};

/** Reduces a restored `FormState` to the fields the restore banner and the
 * post-restore re-upload hints need (S-21): the project name, every
 * `sample_filename` (target + sources, `null` when never recorded), and the
 * joins/mappings counts. Pure and React/DOM-free like the rest of this
 * module — callers translate `null` filenames to a human-readable fallback
 * via `t("config.draftUnrecorded")`. */
export function summarizeDraft(state: FormState): DraftSummary {
  return {
    name: state.name,
    targetFilename: state.target.sample_filename ?? null,
    sourceFilenames: state.sources.map((s) => s.sample_filename ?? null),
    joinCount: state.joins.length,
    mappingCount: state.mappings.length,
  };
}
