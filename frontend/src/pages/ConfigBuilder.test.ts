import React from "react";
import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Initializes the i18next singleton (side effect) so useTranslation() inside
// the mounted ConfigBuilder has resources instead of throwing — same pattern
// as ConfigBuilder.characterization.test.ts.
import i18n from "@/i18n";
import { isPristineState, DRAFT_KEY, draftWriterLabel } from "@/lib/configForm";
import type { JoinRule, Mapping } from "@/lib/schemas";

// Same transport stub as ConfigBuilder.characterization.test.ts so mounting
// ConfigBuilder doesn't depend on a reachable backend.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockResolvedValue({ configs: [] }),
      post: vi.fn(),
      postForm: vi.fn(),
    },
  };
});

import { api } from "@/lib/api";
import { ConfigBuilder } from "./ConfigBuilder";

function renderConfigBuilder() {
  const qc = new QueryClient();
  return render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(MemoryRouter, null, React.createElement(ConfigBuilder))
    )
  );
}

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

// Fix 1: the restore banner must show which surface wrote the stored draft
// (draftWriterLabel), so a workbench user who sees the wizard's draft
// silently take over their draft key gets a hint on the next visit —
// otherwise the compensating control for S-14's last-writer-wins is
// specified but never wired to any UI.
describe("ConfigBuilder draft-restore banner writer label (Fix 1)", () => {
  it("showsTheWizardWriterLabelWhenTheStoredDraftWasWrittenByTheWizard", () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "wizard-draft",
        target: { sheet: "S1", header_row: 1, columns: ["colA"] },
        sources: [],
        joins: [],
        mappings: [],
        _draftMeta: { version: 1, writer: "wizard" },
      })
    );

    renderConfigBuilder();

    expect(
      screen.getByText(i18n.t("config.draftRestoreWriter", { writer: i18n.t(draftWriterLabel("wizard")) }))
    ).toBeVisible();

    localStorage.removeItem(DRAFT_KEY);
  });

  it("showsAnUnknownWriterFallbackWhenTheStoredDraftHasNoMeta", () => {
    // Pre-feature / older-build draft: no `_draftMeta` sibling key at all.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "legacy-draft",
        target: { sheet: "S1", header_row: 1, columns: ["colA"] },
        sources: [],
        joins: [],
        mappings: [],
      })
    );

    renderConfigBuilder();

    expect(
      screen.getByText(
        i18n.t("config.draftRestoreWriter", { writer: i18n.t("wizard.draftRestore.writerUnknown") })
      )
    ).toBeVisible();

    localStorage.removeItem(DRAFT_KEY);
  });
});

// Fix 2: same autosave race as WizardPage.tsx's fixed bug — a successful
// save must cancel whatever debounced autosave write is still pending, or
// the timer fires after the save and resurrects the draft that was just
// cleared.
describe("ConfigBuilder successful save cancels pending autosave (Fix 2)", () => {
  it("successfulSaveCancelsPendingAutosaveTimerSoDraftDoesNotResurrect", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          name: "demo-project",
          target: { sheet: "S1", header_row: 1, columns: ["colA"] },
          sources: [{ alias: "primary", role: "primary", sheet: "S1", header_row: 1, columns: [] }],
          joins: [],
          mappings: [{ target: "colA", source: "primary.colA" }],
        })
      );

      renderConfigBuilder();

      // Restoring applies FormState via setState — this is the "state
      // change" that (re)schedules the pending autosave timer the bug
      // depends on.
      fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));

      vi.mocked(api.post).mockResolvedValue({ name: "demo-project" });
      URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
      URL.revokeObjectURL = vi.fn();

      fireEvent.click(screen.getByText(i18n.t("config.saveAndDownload")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();

      // THEN advance PAST the debounce window that was pending when save was
      // clicked — the draft must still be gone.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
      localStorage.removeItem(DRAFT_KEY);
    }
  });
});

// Malformed-draft recovery: readDraft() -> {ok: false, raw} must be a
// recoverable state, not a dead end (same fix as WizardPage.tsx's
// malformedDraftShowsRecoverableMessageAndDiscardReachesCleanState).
describe("ConfigBuilder malformed draft recovery (Fix 1b)", () => {
  it("malformedDraftShowsRecoverableMessageAndDiscardReachesCleanState", () => {
    localStorage.setItem(DRAFT_KEY, "{not json");

    renderConfigBuilder();

    expect(screen.getByText(i18n.t("config.draftUnreadable"))).toBeVisible();
    expect(screen.queryByText(i18n.t("errors.generic"))).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t("config.draftDiscard")));

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.queryByText(i18n.t("config.draftUnreadable"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("errors.generic"))).not.toBeInTheDocument();
  });
});

// Field-locking during an in-flight save (Fix 2). Navigation (rail/preview/
// download-current/delete) is out of this criterion's scope — only the
// editable config fields (name input here; SourcesTree/JoinsEditor/
// MappingsList are exercised in the wizard's equivalent test since they are
// the same components).
describe("ConfigBuilder locks form fields during pending save (Fix 2b)", () => {
  it("locksNameInputWhilePendingSave", async () => {
    // Seed a save-ready draft (same shape as the Fix 2 autosave test above)
    // and restore it, since a save-ready config is required for the save
    // request to actually fire (toConfig() gates handleSave otherwise).
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "demo-project",
        target: { sheet: "S1", header_row: 1, columns: ["colA"] },
        sources: [{ alias: "primary", role: "primary", sheet: "S1", header_row: 1, columns: [] }],
        joins: [],
        mappings: [{ target: "colA", source: "primary.colA" }],
      })
    );

    renderConfigBuilder();
    fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));

    const nameInput = screen.getByLabelText(i18n.t("config.name")) as HTMLInputElement;
    expect(nameInput).not.toBeDisabled();

    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(screen.getByText(i18n.t("config.saveAndDownload")));

    await waitFor(() => expect(screen.getByText(i18n.t("config.saveAndDownload")).closest("button")).toBeDisabled());
    expect(screen.getByLabelText(i18n.t("config.name"))).toBeDisabled();

    resolveSave({ name: "demo-project" });
    localStorage.removeItem(DRAFT_KEY);
  });

  // Every FileDropzone/SheetHeaderPicker the workbench renders comes through
  // SourcesTree (ConfigBuilder.tsx:539), which previously had no `disabled`
  // prop of its own to forward — the fieldset around it (ConfigBuilder.tsx:
  // 535) can't reach `<tr onClick>` rows either, same gap as the wizard's
  // target step (WizardPage.test.tsx's targetSheetRowClickInertDuringPendingSaveInteractiveOtherwise).
  it("sourcesSheetRowClickInertDuringPendingSaveInteractiveOtherwise", async () => {
    vi.mocked(api.postForm).mockImplementation(async () =>
      ({ sheets: [{ name: "Sheet1", preview_rows: [["colA"], ["colB"]], preview_starts_at: 1 }] }) as never,
    );

    const { container } = renderConfigBuilder();

    // Dismiss the onboarding overlay (shown by default on the pristine
    // state) so the SourcesTree pane actually mounts.
    fireEvent.click(screen.getByText(i18n.t("config.onboarding.stayHere")));

    // Upload the target template so a target column set exists (drives
    // handleSave's toConfig gate).
    const targetInput = container.querySelector(
      '#pane-sources input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(targetInput, { target: { files: [new File(["t"], "target.xlsx")] } });
    await waitFor(() => expect(vi.mocked(api.postForm).mock.calls.length).toBeGreaterThan(0));

    // Upload the default primary source's file — this is the SheetHeaderPicker
    // under test.
    const sourceInput = container.querySelector(
      '#pane-sources details input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(sourceInput, { target: { files: [new File(["s"], "source.xlsx")] } });
    await waitFor(() => expect(vi.mocked(api.postForm).mock.calls.length).toBeGreaterThan(1));

    // Map the auto-seeded target column to the source so toConfig succeeds.
    const sourceSelect = await screen.findByDisplayValue(i18n.t("mapping.selectSource"));
    fireEvent.change(sourceSelect, { target: { value: "primary.colA" } });

    fireEvent.change(screen.getByLabelText(i18n.t("config.name")), {
      target: { value: "demo-project" },
    });

    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(screen.getByText(i18n.t("config.saveAndDownload")));
    await waitFor(() =>
      expect(screen.getByText(i18n.t("config.saveAndDownload")).closest("button")).toBeDisabled(),
    );

    const sourcesPane = container.querySelector("#pane-sources") as HTMLElement;
    const secondRow = sourcesPane.querySelectorAll("details tbody tr")[1];

    // BEFORE resolve: clicking the non-header row during the pending save
    // must not change the confirmed header row (still "colA", row 1).
    fireEvent.click(secondRow);
    expect(within(sourcesPane).getByText(`${i18n.t("config.columnsPrefix")}colA`)).toBeVisible();

    resolveSave({ name: "demo-project" });
    await waitFor(() =>
      expect(screen.getByText(i18n.t("config.saveAndDownload")).closest("button")).not.toBeDisabled(),
    );

    // AFTER resolve: the same row click is live again.
    fireEvent.click(sourcesPane.querySelectorAll("details tbody tr")[1]);
    expect(within(sourcesPane).getByText(`${i18n.t("config.columnsPrefix")}colB`)).toBeVisible();
  });
});
