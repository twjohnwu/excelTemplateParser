// RED-phase contract for the configForm.ts extraction (REQ-11,
// STDD/create-project-wizard/tasks.md, module-convergence task
// `S-05,S-06,S-07,S-12,S-13,S-14,S-15,S-16,S-17,S-20`). These ten tests are
// the behaviour-preserving contract the extraction of ConfigBuilder.tsx's
// form logic into `configForm.ts` must satisfy; each asserts its scenario's
// externally observable GIVEN/WHEN/THEN, not an internal call. `configForm.ts`
// is currently a stub (every export throws `NotImplemented`) — this file is
// RED against the stub and is expected to turn GREEN only once the real
// logic lands.

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SAVE_ERROR_KEY,
  DRAFT_KEY,
  DRAFT_META_VERSION,
  draftWriterLabel,
  emptyState,
  formatSaveError,
  readDraft,
  summarizeDraft,
  toConfig,
  toPersistable,
  writeDraft,
} from "./configForm";
import type { FormState } from "./configForm";
import { mergeMappingsWithColumns } from "./configHelpers";

beforeEach(() => {
  localStorage.clear();
});

describe("configForm (REQ-11 extraction contract)", () => {
  it("seedsMappingRowsFromTemplateHeaderSelection", () => {
    // REQ-05 / S-05: uploading a template and selecting header_row seeds one
    // mapping row per parsed template column, in template column order, when
    // there were no existing mapping rows (mappings starts as emptyState()'s
    // empty list).
    const state = emptyState();
    const columns = ["客戶名稱", "訂單編號"];

    const merged = mergeMappingsWithColumns(state.mappings, columns);

    expect(merged).toEqual([
      { target: "客戶名稱", source: "", conditions: [], default: "" },
      { target: "訂單編號", source: "", conditions: [], default: "" },
    ]);
  });

  it("mergePreservesExistingRowsAndAppendsLeftoverManualRowsAtEnd", () => {
    // REQ-05 / S-06: re-selecting header_row keeps an existing mapping row
    // verbatim (not reset to blank) and appends a manual row whose target
    // isn't in the new template columns at the end — the result count is 3,
    // not 2 (the template's column count).
    const state = emptyState();
    state.mappings = [
      { target: "客戶名稱", source: "orders.customer_name", conditions: [], default: "" },
      { target: "備註", source: "orders.note", conditions: [], default: "" },
    ];

    const merged = mergeMappingsWithColumns(state.mappings, ["客戶名稱", "訂單編號"]);

    expect(merged).toEqual([
      { target: "客戶名稱", source: "orders.customer_name", conditions: [], default: "" },
      { target: "訂單編號", source: "", conditions: [], default: "" },
      { target: "備註", source: "orders.note", conditions: [], default: "" },
    ]);
  });

  it("addsOrphanMappingTargetAsColumnPrecedingUnreferencedTemplateColumns", () => {
    // REQ-05 / S-07: a manually added mapping row whose target isn't a
    // template column becomes a real output column via toConfig(), ordered
    // before any template column that no mapping references — even though
    // "訂單編號" precedes "備註" in the raw template column order.
    const state = emptyState();
    state.name = "demo";
    state.target = { file: null, sheet: "Sheet1", header_row: 1, columns: ["客戶名稱", "訂單編號"] };
    state.sources = [
      { alias: "primary", role: "primary", file: null, sheet: "Data", header_row: 1, columns: [] },
    ];
    state.mappings = [
      { target: "客戶名稱", source: "primary.customer_name", conditions: [], default: "" },
      { target: "備註", literal: "n/a", conditions: [], default: "" },
    ];

    const result = toConfig(state);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok: true");
    expect(result.config.target_template.columns).toEqual(["客戶名稱", "備註", "訂單編號"]);
  });

  it("formatSaveErrorNeverReturnsEmptyString", () => {
    // REQ-07 / S-12: a non-409 save failure with an empty raw message (e.g.
    // resp.statusText === "") normalizes to the non-empty default message; a
    // non-empty raw message passes through unchanged.
    expect(formatSaveError("")).toBe(DEFAULT_SAVE_ERROR_KEY);
    expect(formatSaveError("Internal Server Error")).toBe("Internal Server Error");
  });

  it("roundTripsDraftFieldsExceptFileObjectsBetweenWizardAndWorkbench", () => {
    // REQ-11 / S-13: writing a draft from one interface and reading it back
    // from the other round-trips every field except File objects, which
    // become null on read (they can't survive localStorage serialization).
    const filled: FormState = {
      name: "demo",
      target: {
        file: new File(["x"], "t.xlsx"),
        sheet: "Sheet1",
        header_row: 2,
        columns: ["colA", "colB"],
        sample_filename: "t.xlsx",
      },
      sources: [
        {
          alias: "primary",
          role: "primary",
          file: new File(["y"], "s.xlsx"),
          sheet: "Data",
          header_row: 1,
          columns: ["colA"],
          sample_filename: "s.xlsx",
        },
      ],
      joins: [{ left: "primary.colA", right: "primary.colB", type: "left" }],
      mappings: [{ target: "colA", source: "primary.colA", conditions: [], default: "" }],
    };

    writeDraft(filled, "wizard");
    const wizardWritten = readDraft();
    expect(wizardWritten?.ok).toBe(true);
    if (!wizardWritten || !wizardWritten.ok) throw new Error("expected ok: true");
    expect(wizardWritten.state).toEqual({
      ...filled,
      target: { ...filled.target, file: null },
      sources: [{ ...filled.sources[0], file: null }],
    });

    // Reverse direction: workbench writes, the same read helper (as the
    // wizard would call it) reads it back.
    writeDraft(filled, "workbench");
    const workbenchWritten = readDraft();
    expect(workbenchWritten?.ok).toBe(true);
    if (!workbenchWritten || !workbenchWritten.ok) throw new Error("expected ok: true");
    expect(workbenchWritten.state).toEqual(wizardWritten.state);
  });

  it("attachesVersionAndWriterMetaOnDraftWrite", () => {
    // REQ-08 / S-14: each write of a non-pristine state attaches a
    // version/writer marker; the later writer (workbench) wins in
    // localStorage (last-writer-wins, unchanged); draftWriterLabel() renders
    // each writer marker as displayable text.
    const wizardState: FormState = {
      ...emptyState(),
      name: "wizard-draft",
      mappings: [{ target: "a", source: "", conditions: [], default: "" }],
    };
    writeDraft(wizardState, "wizard");
    const afterWizard = JSON.parse(localStorage.getItem(DRAFT_KEY) as string);
    expect(afterWizard._draftMeta).toEqual({ version: DRAFT_META_VERSION, writer: "wizard" });

    const workbenchState: FormState = {
      ...emptyState(),
      name: "workbench-draft",
      mappings: [{ target: "b", source: "", conditions: [], default: "" }],
    };
    writeDraft(workbenchState, "workbench");
    const afterWorkbench = JSON.parse(localStorage.getItem(DRAFT_KEY) as string);
    expect(afterWorkbench._draftMeta).toEqual({ version: DRAFT_META_VERSION, writer: "workbench" });
    expect(afterWorkbench.name).toBe("workbench-draft");

    expect(draftWriterLabel("wizard")).toBe("wizard.draftRestore.writerWizard");
    expect(draftWriterLabel("workbench")).toBe("wizard.draftRestore.writerWorkbench");
  });

  it("returnsFailureResultOnMalformedDraftInsteadOfSwallowing", () => {
    // REQ-08 / S-15: a stored draft that fails JSON.parse returns a
    // recognizable failure result instead of throwing or silently vanishing,
    // and reading it does NOT clear it from localStorage.
    const malformed = "{not-json";
    localStorage.setItem(DRAFT_KEY, malformed);

    const result = readDraft();

    expect(result).toEqual({ ok: false, raw: malformed });
    expect(localStorage.getItem(DRAFT_KEY)).toBe(malformed);
  });

  it("returnsFailureResultOnValidJsonThatIsNotAUsableDraft", () => {
    // REQ-08 / S-15 (regression): valid JSON that isn't a usable draft object
    // must also return { ok: false, raw } instead of throwing or being
    // silently accepted — a parse failure is not the only "malformed" shape.
    const cases: Array<[string, string]> = [
      ["null", "null"],
      ["42", "42"],
      ["a string", JSON.stringify("a string")],
      ["object with a wrong-typed sources field", JSON.stringify({ sources: {} })],
    ];

    for (const [, raw] of cases) {
      localStorage.setItem(DRAFT_KEY, raw);

      const result = readDraft();

      expect(result).toEqual({ ok: false, raw });
      expect(localStorage.getItem(DRAFT_KEY)).toBe(raw);
    }
  });

  it("pristineStateSerializesToExactEmptyPersistableJson", () => {
    // REQ-08 / S-16: when a write actually happens (state is non-pristine,
    // same GIVEN reasoning as S-14 — a pristine write never reaches this
    // code path, see S-20), the payload's key set, with `_draftMeta`
    // removed, is EXACTLY toPersistable(state)'s key set and key order — no
    // wizard-only field (e.g. a step index) leaks into the shared payload.
    const state: FormState = {
      ...emptyState(),
      name: "non-pristine",
      mappings: [{ target: "a", source: "", conditions: [], default: "" }],
    };

    writeDraft(state, "wizard");

    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY) as string);
    const { _draftMeta, ...rest } = stored;
    expect(_draftMeta).toBeDefined();
    expect(Object.keys(rest)).toEqual(Object.keys(toPersistable(state) as object));
  });

  it("restoredDraftHasNullFileAndKeepsSampleFilename", () => {
    // REQ-08 / S-17: a draft persisted WITH sample_filename (as autosave
    // writes it once the uploaded file's original name has been captured,
    // since File objects themselves are stripped by toPersistable) restores
    // with target.file === null but keeps target.sample_filename as-is — a
    // dropped filename would leave a restored draft unable to show which
    // file was last uploaded.
    const persisted = {
      name: "demo",
      target: { sheet: "Sheet1", header_row: 1, columns: ["colA"], sample_filename: "expected_output.xlsx" },
      sources: [],
      joins: [],
      mappings: [],
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(persisted));

    const result = readDraft();

    expect(result?.ok).toBe(true);
    if (!result || !result.ok) throw new Error("expected ok: true");
    expect(result.state.target.file).toBeNull();
    expect(result.state.target.sample_filename).toBe("expected_output.xlsx");
  });

  it("returnsFailureResultOnDraftMetaVersionMismatch", () => {
    // Gap 1: DRAFT_META_VERSION is attached on every write (configForm.ts:236)
    // but was never compared back on read — a draft written by a future/past
    // shape of this module must not be silently rebuilt into a FormState.
    const persisted = {
      name: "demo",
      target: { sheet: "Sheet1", header_row: 1, columns: ["colA"] },
      sources: [],
      joins: [],
      mappings: [],
      _draftMeta: { version: DRAFT_META_VERSION + 1, writer: "wizard" },
    };
    const raw = JSON.stringify(persisted);
    localStorage.setItem(DRAFT_KEY, raw);

    const result = readDraft();

    expect(result).toEqual({ ok: false, raw });
    expect(localStorage.getItem(DRAFT_KEY)).toBe(raw);
  });

  it("returnsFailureResultWhenTargetColumnsIsNotAnArray", () => {
    // Gap 2: a shape-dependent field inside `target` (not just `target`
    // itself) must be checked — target.columns feeds
    // toConfig()'s `.filter(Boolean)` (configForm.ts:113) and
    // deriveStepStates()'s `.filter(Boolean)` (previewHelpers.ts:73)
    // unconditionally.
    const persisted = {
      name: "demo",
      target: { sheet: "Sheet1", header_row: 1, columns: { a: "b" } },
    };
    const raw = JSON.stringify(persisted);
    localStorage.setItem(DRAFT_KEY, raw);

    const result = readDraft();

    expect(result).toEqual({ ok: false, raw });
    expect(localStorage.getItem(DRAFT_KEY)).toBe(raw);
  });

  it("readDraftPreventsTheTargetColumnsThrowThatToConfigWouldOtherwiseHit", () => {
    // Demonstrates the failure scenario end-to-end: BEFORE the fix, a
    // restored draft with target.columns as an object makes toConfig() throw
    // during what would be a render call. AFTER the fix, readDraft() itself
    // returns { ok: false }, so toConfig() is never reached with the bad
    // shape at all.
    const badState: FormState = {
      ...emptyState(),
      name: "demo",
      target: { file: null, sheet: "Sheet1", header_row: 1, columns: { a: "b" } as any },
    };

    // toConfig still throws on this shape when handed it directly — proving
    // the throw is real, not merely hypothetical.
    expect(() => toConfig(badState)).toThrow();

    // readDraft() must never hand toConfig() this shape in the first place.
    const persisted = {
      name: "demo",
      target: { sheet: "Sheet1", header_row: 1, columns: { a: "b" } },
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(persisted));

    const result = readDraft();

    expect(result?.ok).toBe(false);
  });

  it("returnsFailureResultWhenASourceElementIsMissingAlias", () => {
    // Gap 2: element-level shapes inside `sources` must be checked too —
    // deriveStepStates() dereferences `s.alias.trim()`
    // (previewHelpers.ts:76) with no guard of its own.
    const persisted = {
      name: "demo",
      target: { sheet: "Sheet1", header_row: 1, columns: ["colA"] },
      sources: [{}],
    };
    const raw = JSON.stringify(persisted);
    localStorage.setItem(DRAFT_KEY, raw);

    const result = readDraft();

    expect(result).toEqual({ ok: false, raw });
    expect(localStorage.getItem(DRAFT_KEY)).toBe(raw);
  });

  it("pristineWriteAttemptDoesNotClobberExistingStoredDraft", () => {
    // REQ-08 / S-20 (write-side anti-clobber invariant, fail-then-pass by
    // design): a pristine-state write attempt SHALL NOT overwrite or clear
    // an existing, non-pristine stored draft. This SHALL be RED against a
    // writeDraft() lacking the pristine skip-write guard (the guard
    // currently living at ConfigBuilder.tsx:303,
    // `if (json === EMPTY_PERSISTABLE_JSON) return;`) and SHALL be GREEN
    // once that guard is carried into writeDraft() — the guard is the
    // reason this scenario exists, not an incidental detail to remove.
    const seeded = JSON.stringify({
      name: "seeded-draft",
      target: { sheet: "S1", header_row: 1, columns: ["x"] },
      mappings: [{ target: "x", source: "", conditions: [], default: "" }],
      _draftMeta: { version: DRAFT_META_VERSION, writer: "workbench" },
    });
    localStorage.setItem(DRAFT_KEY, seeded);

    writeDraft(emptyState(), "wizard");

    expect(localStorage.getItem(DRAFT_KEY)).toBe(seeded);
  });

  it("returnsFailureResultWhenNameIsNotAString", () => {
    // Fix 2: `name` is dereferenced with `.trim()` unconditionally on every
    // render (previewHelpers.ts's deriveStepStates `input.name.trim()`), but
    // readDraft() rebuilt it with a bare `parsed.name ?? ""` — no type check,
    // same class of gap as target.columns/sources[].alias/joins[].left-right
    // above.
    const persisted = {
      name: 42,
      target: { sheet: "S1", header_row: 1, columns: ["colA"] },
      sources: [],
      joins: [],
      mappings: [],
    };
    const raw = JSON.stringify(persisted);
    localStorage.setItem(DRAFT_KEY, raw);

    const result = readDraft();

    expect(result).toEqual({ ok: false, raw });
    expect(localStorage.getItem(DRAFT_KEY)).toBe(raw);
  });

  it("returnsFailureResultWhenAMappingElementTargetIsNotAString", () => {
    // Fix 2: each mapping element's `target` is dereferenced with
    // `?.trim()` in issueHelpers.ts's humanizeIssue — optional chaining
    // guards null/undefined, not a wrong-typed value like a number.
    const persisted = {
      name: "demo",
      target: { sheet: "S1", header_row: 1, columns: ["colA"] },
      sources: [],
      joins: [],
      mappings: [{ target: 7, source: "", conditions: [], default: "" }],
    };
    const raw = JSON.stringify(persisted);
    localStorage.setItem(DRAFT_KEY, raw);

    const result = readDraft();

    expect(result).toEqual({ ok: false, raw });
    expect(localStorage.getItem(DRAFT_KEY)).toBe(raw);
  });

  it("summarizeDraftReturnsFilenamesAndCountsWhenRecorded", () => {
    // S-21: the restore banner needs the project name, every recorded
    // sample_filename (target + sources), and the joins/mappings counts.
    const state: FormState = {
      name: "test_SKU",
      target: { file: null, sheet: "Sheet1", header_row: 1, columns: ["colA"], sample_filename: "expected_output.xlsx" },
      sources: [
        { alias: "primary", role: "primary", file: null, sheet: "", header_row: 1, columns: [], sample_filename: "product_master.xlsx" },
        { alias: "lookup1", role: "lookup", file: null, sheet: "", header_row: 1, columns: [], sample_filename: "supplier_A_quote.xlsx" },
      ],
      joins: [{ left: "primary.colA", right: "lookup1.colA", type: "left" }],
      mappings: [
        { target: "a", source: "", conditions: [], default: "" },
        { target: "b", source: "", conditions: [], default: "" },
        { target: "c", source: "", conditions: [], default: "" },
      ],
    };

    expect(summarizeDraft(state)).toEqual({
      name: "test_SKU",
      targetFilename: "expected_output.xlsx",
      sourceFilenames: ["product_master.xlsx", "supplier_A_quote.xlsx"],
      joinCount: 1,
      mappingCount: 3,
    });
  });

  it("summarizeDraftReturnsNullFilenamesWhenNotRecorded", () => {
    const state: FormState = emptyState();

    expect(summarizeDraft(state)).toEqual({
      name: "",
      targetFilename: null,
      sourceFilenames: [null],
      joinCount: 0,
      mappingCount: 0,
    });
  });
});
