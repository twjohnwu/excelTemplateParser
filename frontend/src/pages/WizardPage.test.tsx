/** RED-phase contract tests for `WizardPage` (STDD/create-project-wizard,
 * Task 6: `` `S-01,S-02,S-03,S-08,S-09,S-10,S-11,S-19` ``). `WizardPage.tsx`
 * and `WizardSummary.tsx` are currently minimal stubs — every test below is
 * expected to fail against them. See `STDD/create-project-wizard/spec.md`
 * for each scenario's exact GIVEN/WHEN/THEN.
 *
 * S-01/S-02 are written to catch the spec's named highest-risk regression:
 * an implementation that quietly re-introduces step gating (disabled nav
 * items / blocking dialogs) because "the previous step isn't done" looks
 * like a bug to a developer reading the empty mappings step. Both assert
 * enabled/disabled state directly on every nav control, not on a single
 * button standing in for the rest.
 */

import { render, screen, within, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Initializes the i18next singleton (side effect) so useTranslation() inside
// the mounted WizardPage has resources instead of throwing — same pattern as
// ConfigBuilder.characterization.test.ts.
import i18n from "@/i18n";
import { DRAFT_KEY } from "@/lib/configForm";
import { ApiError } from "@/lib/api";

import { WizardPage } from "./WizardPage";

// WizardPage's useConfigList() (via ChecklistRail's neighbors / future
// load-existing UX) and save flow go through @/lib/api — stub the transport
// so no case depends on a real backend, mirroring
// ConfigBuilder.characterization.test.ts's mocking pattern.
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

function renderWizard() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WizardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rail() {
  return screen.getByRole("navigation", { name: i18n.t("config.rail.label") });
}

function railButton(label: string) {
  const button = within(rail()).getByText(label).closest("button");
  if (!button) throw new Error(`rail button for "${label}" not found`);
  return button as HTMLButtonElement;
}

function goToStep(railLabel: string) {
  fireEvent.click(railButton(railLabel));
}

// Resolved lazily (not at module load) so these track whichever locale
// beforeEach has pinned for the current test — a module-level array
// computed via i18n.t() here would freeze on the locale i18next resolved
// from jsdom's navigator.language at import time, before any test's pin.
function allRailLabels(): string[] {
  return [
    i18n.t("config.rail.target"),
    i18n.t("config.rail.sources"),
    i18n.t("config.rail.joins"),
    i18n.t("config.rail.mappings"),
    i18n.t("config.rail.save"),
  ];
}

function expectNoRailButtonDisabled() {
  for (const label of allRailLabels()) {
    expect(railButton(label), `rail button "${label}" must not be disabled`).not.toBeDisabled();
  }
}

function navButton(label: string) {
  const button = screen.getByText(label).closest("button");
  if (!button) throw new Error(`nav button for "${label}" not found`);
  return button as HTMLButtonElement;
}

function stepEl(container: HTMLElement, stepId: string): HTMLElement {
  const el = container.querySelector(`[data-step="${stepId}"]`);
  if (!el) throw new Error(`[data-step="${stepId}"] not found`);
  return el as HTMLElement;
}

// design-fe.md:336-342 (S-19): visibility is toggled with Tailwind's
// `hidden` / `block` utility classes on the step wrapper — content is never
// unmounted. jsdom does not execute real CSS rules, so jest-dom's
// `toBeVisible()` can't observe a Tailwind `hidden` class (there is no
// stylesheet making it `display: none`); walk the ancestor chain for the
// literal class name instead, per the design's own stated mechanism.
function isStepHidden(container: HTMLElement, stepId: string): boolean {
  let node: HTMLElement | null = stepEl(container, stepId);
  while (node) {
    if (node.classList.contains("hidden")) return true;
    if (node.classList.contains("block")) return false;
    node = node.parentElement;
  }
  return false;
}

function xlsxFile(name: string) {
  return new File(["dummy"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function parseResponseFor(columns: string[]) {
  return { sheets: [{ name: "Sheet1", preview_rows: [columns], preview_starts_at: 1 }] };
}

/** Uploads `file` into the file input found at `selector` (scoped under
 * `container`) and waits for SheetHeaderPicker's mocked parse round-trip to
 * settle (`POST /api/templates/parse` via `api.postForm`). */
async function uploadFile(container: HTMLElement, selector: string, file: File) {
  const before = vi.mocked(api.postForm).mock.calls.length;
  const input = container.querySelector(selector) as HTMLInputElement | null;
  if (!input) throw new Error(`file input not found for selector "${selector}"`);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(vi.mocked(api.postForm).mock.calls.length).toBeGreaterThan(before));
}

/** Drives the wizard to a fully valid, save-ready state: uploads a
 * single-column target template + the default primary source (same column
 * name "colA"), picks that column as the auto-seeded mapping's source, and
 * optionally fills in a valid project name. Shared by every scenario whose
 * GIVEN needs target/sources/mappings already configured (S-02's
 * pending-save half, S-08, S-09, S-10, S-11).
 *
 * Per design-fe.md's component tree (`WizardStepShell -->|stepId=target|
 * FileDropzone` / `SheetHeaderPicker`, separately `-->|stepId=sources|
 * SourcesTree`), the "target" step's file input is the wizard's own
 * dedicated FileDropzone; the "sources" step renders the unmodified
 * `SourcesTree.tsx`, whose per-source rows are the only `<details>`
 * elements in that step (its own embedded target section is not one) — so
 * `details input[type=file]` is how this reaches the *source's* dropzone
 * without also matching SourcesTree's internal (duplicate) target upload.
 */
async function setupValidState(container: HTMLElement, name = "demo-project") {
  vi.mocked(api.postForm).mockImplementation(async () => parseResponseFor(["colA"]));

  await uploadFile(container, '[data-step="target"] input[type="file"]', xlsxFile("template.xlsx"));
  await uploadFile(container, '[data-step="sources"] details input[type="file"]', xlsxFile("source.xlsx"));

  const mappingsStep = stepEl(container, "mappings");
  const sourceSelect = await within(mappingsStep).findByDisplayValue(i18n.t("mapping.selectSource"));
  fireEvent.change(sourceSelect, { target: { value: "primary.colA" } });

  if (name) {
    const saveStep = stepEl(container, "save");
    const nameInput = within(saveStep).getByLabelText(i18n.t("config.name")) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: name } });
  }
}

function saveButtonIn(saveStep: HTMLElement) {
  const button = within(saveStep).getByText(i18n.t("config.saveAndDownload")).closest("button");
  if (!button) throw new Error("save button not found");
  return button as HTMLButtonElement;
}

// jsdom's detected navigator.language is not guaranteed to be zh-TW, and the
// scenarios below assert zh-TW UI copy — pin the shared i18n singleton per
// test and restore it afterward so this file doesn't leak locale state into
// other test files. Same precedent as WizardStepShell.test.tsx:36-38/59.
let previousLanguage: string;

beforeEach(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage("zh-TW");
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe("WizardPage", () => {
  // S-01
  it("skipsToMappingsShowsEmptyStateNotBlocked", () => {
    const { container } = renderWizard();

    // GIVEN target 步驟尚未上傳範本 — WHEN 直接點擊 mappings，跳過 sources/joins
    goToStep(i18n.t("config.rail.mappings"));

    // THEN 顯示資訊性空狀態文案（一字不差，來自 spec.md S-01）
    expect(
      screen.getByText("尚未上傳範本，看不到可對應的欄位，先去 Step 1，或直接手動新增一列"),
    ).toBeVisible();

    // 「+ 新增映射」與所有導覽項目維持可點擊；不出現任何步驟閘門文字。這個
    // 斷言必須以「無 disabled、可操作」為判定依據，不能只看畫面有變化
    // （spec.md S-01：若加入任何步驟閘門，本測試 SHALL 判為失敗）。
    expect(screen.queryByText(/請先完成上一步/)).not.toBeInTheDocument();
    const addButton = screen.getByText(i18n.t("config.addMapping")).closest("button");
    expect(addButton).not.toBeNull();
    expect(addButton).not.toBeDisabled();
    expectNoRailButtonDisabled();

    // 確實切換離開 target，不停留在 target（design-fe.md:336-342 的顯示/隱藏機制）。
    expect(isStepHidden(container, "target")).toBe(true);
    expect(isStepHidden(container, "mappings")).toBe(false);
  });

  // S-02
  it("disabledOnlyDuringPendingSaveNotIncompleteSteps", async () => {
    const { container } = renderWizard();
    await setupValidState(container);
    goToStep(i18n.t("config.rail.save"));
    const saveStep = stepEl(container, "save");
    const saveButton = saveButtonIn(saveStep);

    // BEFORE any save request — nothing SHALL be disabled just because e.g.
    // joins/mappings look incomplete elsewhere in the flow (this check
    // covers only nav + Save, per spec.md S-02 — Preview is out of scope).
    expect(saveButton).not.toBeDisabled();
    expectNoRailButtonDisabled();

    // 「上一步」/「下一步」是導覽控制項，同樣受 S-02 的保證約束：不因步驟
    // 未完成而被 disabled——但陣列邊界本身仍會 disable 對應方向的按鈕，
    // 中段步驟（joins）兩顆都可點擊。
    goToStep(i18n.t("config.rail.joins"));
    expect(navButton(i18n.t("wizard.nav.prev"))).not.toBeDisabled();
    expect(navButton(i18n.t("wizard.nav.next"))).not.toBeDisabled();

    // 邊界情形：導覽到最後一步（save），「下一步」到底、應為 disabled；
    // 「上一步」仍可點擊。
    goToStep(i18n.t("config.rail.save"));
    expect(navButton(i18n.t("wizard.nav.prev"))).not.toBeDisabled();
    expect(navButton(i18n.t("wizard.nav.next"))).toBeDisabled();

    // 邊界情形：導覽回第一步（target），「上一步」到底、應為 disabled；
    // 「下一步」仍可點擊。
    goToStep(i18n.t("config.rail.target"));
    expect(navButton(i18n.t("wizard.nav.prev"))).toBeDisabled();
    expect(navButton(i18n.t("wizard.nav.next"))).not.toBeDisabled();

    // 回到最後一步（save）以繼續後續的儲存流程。
    goToStep(i18n.t("config.rail.save"));

    // Trigger a save that never resolves during this test, isolating the
    // "pending" window.
    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(saveButtonIn(stepEl(container, "save")));

    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).toBeDisabled());
    // Only "儲存並下載" is disabled specifically because of the pending
    // save — step navigation stays fully clickable, except "下一步" here,
    // which is already disabled purely because "save" is the last step
    // (array boundary), independent of the pending state.
    expectNoRailButtonDisabled();
    expect(navButton(i18n.t("wizard.nav.prev"))).not.toBeDisabled();
    expect(navButton(i18n.t("wizard.nav.next"))).toBeDisabled();

    resolveSave({ name: "demo-project" });
  });

  // S-03
  it("treatsEmptyJoinsAsCompleteReachesSave", () => {
    const { container } = renderWizard();

    // GIVEN sources 長度為 1（emptyState 的預設 primary 來源）、joins 為空。
    // deriveStepStates（previewHelpers.ts:67-81）對空 joins 的既有判定是
    // "done" → ChecklistRail 渲染 Check 圖示，不是 attention 的數字徽章、
    // 也不是 pending 的灰點（ChecklistRail.tsx 三種狀態互斥）。
    const joinsButton = railButton(i18n.t("config.rail.joins"));
    expect(joinsButton.querySelector("svg"), "joins rail item should show the done Check icon").not.toBeNull();
    expect(within(joinsButton).queryByText(/^\d+$/)).not.toBeInTheDocument();

    // WHEN 導覽到 save — THEN 確實抵達且可直接操作，不因 joins 為空顯示任何
    // 警示或阻擋（save 步驟真的可見、摘要以明確的「無串接」呈現空狀態，而不
    // 是某種警示/阻擋文案）。
    goToStep(i18n.t("config.rail.save"));
    expect(isStepHidden(container, "save")).toBe(false);
    const saveStep = stepEl(container, "save");
    expect(within(saveStep).getByText(i18n.t("wizard.summary.joins.empty"))).toBeVisible();
    expect(saveButtonIn(saveStep)).not.toBeDisabled();
  });

  // S-08
  it("summaryListsSectionsAndEditLinkPreservesSourceState", async () => {
    const { container } = renderWizard();
    await setupValidState(container, "");
    goToStep(i18n.t("config.rail.save"));
    const saveStep = stepEl(container, "save");

    // 目標範本：檔名、sheet、欄位數
    expect(within(saveStep).getByText("template.xlsx")).toBeVisible();
    expect(within(saveStep).getByText(/Sheet1/)).toBeVisible();
    expect(
      within(saveStep).getByText(i18n.t("wizard.summary.target.columnsCount", { n: 1 })),
    ).toBeVisible();
    // 來源清單：alias/role/檔名
    expect(within(saveStep).getByText(/primary.*primary.*source\.xlsx/)).toBeVisible();
    // 串接：無串接
    expect(within(saveStep).getByText(i18n.t("wizard.summary.joins.empty"))).toBeVisible();
    // 對應：target ← source
    expect(within(saveStep).getByText(/colA.*primary\.colA/)).toBeVisible();

    // 修改連結：四段各一個，第二個對應「來源清單」
    const editLinks = within(saveStep).getAllByText(i18n.t("wizard.summary.edit"));
    expect(editLinks.length).toBeGreaterThanOrEqual(4);
    fireEvent.click(editLinks[1]);

    // 導覽回 sources，且先前輸入的 alias/role/檔名原樣顯示（不被重置）
    expect(isStepHidden(container, "sources")).toBe(false);
    const sourcesStep = stepEl(container, "sources");
    // Scoped to the alias <input> specifically — "primary" is ambiguous here
    // because both the alias input's value and the role <select>'s selected
    // option text read "primary" for the default source
    // (emptyState() at configForm.ts:74-76).
    const aliasInput = within(sourcesStep).getByPlaceholderText("alias") as HTMLInputElement;
    expect(aliasInput).toHaveValue("primary");
    expect(within(sourcesStep).getByText("source.xlsx")).toBeVisible();
  });

  // S-09
  it("savesConfigClearsDraftAndDownloadsFile", async () => {
    const { container } = renderWizard();
    await setupValidState(container, "demo-project");
    goToStep(i18n.t("config.rail.save"));

    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: "stale-draft" }));
    vi.mocked(api.post).mockResolvedValue({ name: "demo-project" });
    // jsdom has no real Blob-URL implementation; stub it so downloadJson()
    // (ConfigBuilder.tsx:530-540 pattern) doesn't throw "not implemented".
    URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    URL.revokeObjectURL = vi.fn();

    const saveStep = stepEl(container, "save");
    fireEvent.click(saveButtonIn(saveStep));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith(
      "/api/configs",
      expect.objectContaining({ name: "demo-project" }),
    );
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toBeNull());
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  });

  // S-10
  it("reshowsOverwriteDialogOn409AndResendsRecomputedConfigWithOverwriteTrue", async () => {
    const { container } = renderWizard();
    await setupValidState(container, "taken-name");
    goToStep(i18n.t("config.rail.save"));

    vi.mocked(api.post)
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockResolvedValueOnce({ name: "renamed-project" });

    const saveStep = stepEl(container, "save");
    fireEvent.click(saveButtonIn(saveStep));

    // THEN 顯示既有覆寫對話框，409 不當一般錯誤顯示
    expect(await screen.findByText(i18n.t("dialog.overwriteConfig.title"))).toBeVisible();

    // 在確認覆寫之前變更狀態 — 重送必須反映這個變更，而不是對話框開啟前
    // 捕獲的那份 config（spec.md S-10：pendingOverwrite 只控制對話框開關，
    // 不是第二次請求的 payload）。
    const nameInput = within(saveStep).getByLabelText(i18n.t("config.name")) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "renamed-project" } });

    fireEvent.click(screen.getByText(i18n.t("dialog.overwriteConfig.confirm")));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/api/configs?overwrite=true",
      expect.objectContaining({ name: "renamed-project" }),
    );
  });

  // S-11
  it("blocksSaveWithInlineErrorOnInvalidName", async () => {
    const { container } = renderWizard();
    await setupValidState(container, "valid-name");
    goToStep(i18n.t("config.rail.save"));

    const saveStep = stepEl(container, "save");
    const nameInput = within(saveStep).getByLabelText(i18n.t("config.name")) as HTMLInputElement;
    // 含 "/"，違反 NAME_PATTERN（schemas.ts:93）
    fireEvent.change(nameInput, { target: { value: "bad/name" } });

    fireEvent.click(saveButtonIn(saveStep));

    expect(await within(saveStep).findByText(i18n.t("err.invalidName"))).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  // REQ-08 / S-13 / S-17
  //
  // Rewritten to never await waitFor()/findBy*() while fake timers are
  // active: @testing-library/react's waitFor (node_modules/@testing-library
  // /react/dist/pure.js:84-97) polls through a real setTimeout(..., 0) that
  // only gets advanced by jest-dom's jestFakeTimersAreEnabled() detecting a
  // real `jest` global (node_modules/@testing-library/dom/dist/helpers.js
  // :14-28) — Vitest never defines one, so under vi.useFakeTimers() that
  // setTimeout never fires and the awaited promise hangs forever, skipping
  // this test's own `finally { vi.useRealTimers() }` and leaking fake timers
  // into whichever test runs next in file order. Same pattern as
  // ConfigBuilder.characterization.test.ts's
  // autosaveSkipsWritingPristineStateOverExistingStoredDraft (lines 176-206):
  // drive the debounce with vi.advanceTimersByTime() and assert synchronously
  // with getBy*/direct localStorage reads instead of waitFor/findBy*. The
  // restore half needs no wait either — WizardPage.tsx's restoreDraft()
  // (WizardPage.tsx:151-157) applies the seeded draft via a synchronous
  // setState inside the click handler, which fireEvent.click already flushes.
  it("autosavesDraftThroughWriteDraftAndRestoresThroughReadDraft", () => {
    // WizardPage must autosave through the shared configForm module
    // (writeDraft, tagged writer: "wizard", debounced ~1s per
    // design-fe.md:372) and restore through the same module (readDraft) on
    // mount via the existing draft-restore banner pattern
    // (design-fe.md:195-199: "改用 readDraft() 的回傳結果判斷是否顯示還原橫幅"),
    // without leaking its own currentStep UI state into the persisted
    // payload (design-fe.md:309/317-320).
    const DEBOUNCE_MS = 1000;
    vi.useFakeTimers();
    try {
      const { unmount } = renderWizard();

      // 1. Autosave goes through writeDraft() with the "wizard" writer marker.
      const nameInput = screen.getByLabelText(i18n.t("config.name")) as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "autosave-project" } });
      vi.advanceTimersByTime(DEBOUNCE_MS + 500);

      const written = localStorage.getItem(DRAFT_KEY);
      expect(written, "autosave must write a draft to localStorage[DRAFT_KEY]").not.toBeNull();
      const parsedWritten = JSON.parse(written as string);
      expect(parsedWritten.name).toBe("autosave-project");
      expect(parsedWritten._draftMeta?.writer).toBe("wizard");

      // 3. currentStep is pure UI state and SHALL NOT leak into the payload.
      expect(parsedWritten).not.toHaveProperty("currentStep");

      unmount();
      localStorage.clear();

      // 2. Restore on mount goes through readDraft(): seed a draft before
      // mounting, then confirm the wizard offers and applies it.
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          name: "restored-project",
          target: { sheet: "", header_row: 1, columns: [] },
          sources: [],
          joins: [],
          mappings: [],
          _draftMeta: { version: 1, writer: "workbench" },
        }),
      );

      renderWizard();
      fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));

      expect(screen.getByLabelText(i18n.t("config.name"))).toHaveValue("restored-project");
    } finally {
      vi.useRealTimers();
    }
  });

  // S-21: the restore banner must show a project-level summary (name,
  // template filename, source filenames, joins/mappings counts) BEFORE
  // restore, and every re-upload target must name its own missing file
  // AFTER restore, so the user doesn't have to guess which file goes where
  // when restoring a draft written by a different project.
  it("draftBannerShowsSummaryAndReuploadHints", async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "test_SKU",
        target: {
          sheet: "Sheet1",
          header_row: 1,
          columns: ["colA"],
          sample_filename: "expected_output.xlsx",
        },
        sources: [
          {
            alias: "primary",
            role: "primary",
            sheet: "",
            header_row: 1,
            columns: [],
            sample_filename: "product_master.xlsx",
          },
          {
            alias: "lookup1",
            role: "lookup",
            sheet: "",
            header_row: 1,
            columns: [],
            sample_filename: "supplier_A_quote.xlsx",
          },
        ],
        joins: [{ left: "primary.colA", right: "lookup1.colA", type: "left" }],
        mappings: [
          { target: "a", source: "", conditions: [], default: "" },
          { target: "b", source: "", conditions: [], default: "" },
          { target: "c", source: "", conditions: [], default: "" },
        ],
        _draftMeta: { version: 1, writer: "wizard" },
      }),
    );

    const { container } = renderWizard();

    // WHEN mounted: the ok:true banner shows the pre-restore summary.
    const banner = screen.getByText(i18n.t("config.draftRestorePrompt")).closest("div") as HTMLElement;
    expect(within(banner).getByText(/test_SKU/)).toBeInTheDocument();
    expect(within(banner).getByText(/expected_output\.xlsx/)).toBeInTheDocument();
    expect(within(banner).getByText(/product_master\.xlsx/)).toBeInTheDocument();
    expect(within(banner).getByText(/supplier_A_quote\.xlsx/)).toBeInTheDocument();
    expect(within(banner).getByText(/1/)).toBeInTheDocument();
    expect(within(banner).getByText(/3/)).toBeInTheDocument();

    // WHEN the user clicks Restore.
    fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));

    // THEN the target step names the exact missing template file.
    goToStep(i18n.t("config.rail.target"));
    expect(
      within(stepEl(container, "target")).getByText(/expected_output\.xlsx/),
    ).toBeInTheDocument();

    // THEN the sources step names each missing source file.
    goToStep(i18n.t("config.rail.sources"));
    const sourcesStep = stepEl(container, "sources");
    expect(within(sourcesStep).getByText(/product_master\.xlsx/)).toBeInTheDocument();
    expect(within(sourcesStep).getByText(/supplier_A_quote\.xlsx/)).toBeInTheDocument();

    // WHEN the user uploads a file for the first source.
    vi.mocked(api.postForm).mockImplementation(async () => parseResponseFor(["colA"]));
    const sourceInputs = sourcesStep.querySelectorAll('details input[type="file"]');
    expect(sourceInputs.length).toBe(2);
    await uploadFile(sourcesStep, 'details:nth-of-type(1) input[type="file"]', xlsxFile("product_master.xlsx"));

    // THEN that source's re-upload hint disappears, the other's remains.
    expect(within(sourcesStep).queryByText(/請重新上傳：product_master\.xlsx|Please re-upload: product_master\.xlsx/)).not.toBeInTheDocument();
    expect(within(sourcesStep).getByText(/supplier_A_quote\.xlsx/)).toBeInTheDocument();
  });

  // Fix (verifier finding): `sourceFilenames.map(...).join(", ")` on an EMPTY
  // sources array joins to "" (not "(not recorded)"), so a draft with no
  // sources yet shows a blank spot in the banner instead of the same
  // unrecorded placeholder used for a missing name/target.
  it("draftBannerShowsUnrecordedForEmptySources", () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "x",
        target: { sheet: "", header_row: 1, columns: [] },
        sources: [],
        joins: [],
        mappings: [{ target: "a", source: "", conditions: [], default: "" }],
        _draftMeta: { version: 1, writer: "wizard" },
      }),
    );

    renderWizard();

    const banner = screen.getByText(i18n.t("config.draftRestorePrompt")).closest("div") as HTMLElement;
    expect(
      within(banner).getByText(i18n.t("config.draftSummary", {
        name: "x",
        target: i18n.t("config.draftUnrecorded"),
        sources: i18n.t("config.draftUnrecorded"),
        joins: 0,
        mappings: 1,
      })),
    ).toBeInTheDocument();
  });

  // Fix 1: a non-name toConfig() failure (e.g. an unknown join alias) must
  // surface on the save step — otherwise the save button is a dead click.
  // Seeds state through the draft-restore path (same mechanism as the S-13
  // test below) rather than driving the joins UI, since restoreDraft applies
  // a FormState synchronously and toConfig() doesn't require a real File
  // object — only the schema fields matter here.
  it("surfacesNonNameSchemaIssuesOnSaveStepInsteadOfDeadClick", () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "demo-project",
        target: { sheet: "S1", header_row: 1, columns: ["colA"] },
        sources: [{ alias: "primary", role: "primary", sheet: "S1", header_row: 1, columns: ["colA"] }],
        // "ghost" is not a known source alias — toConfig() SHALL fail with
        // err.joinUnknownAlias on this entry (schemas.ts's superRefine).
        joins: [{ left: "primary.colA", right: "ghost.colA", type: "left" }],
        mappings: [{ target: "colA", source: "primary.colA" }],
      }),
    );

    const { container } = renderWizard();
    fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));
    goToStep(i18n.t("config.rail.save"));
    const saveStep = stepEl(container, "save");

    fireEvent.click(saveButtonIn(saveStep));

    // THEN the save step shows the join issue instead of doing nothing, and
    // no save request is sent (toConfig() failed, same as S-11's name case).
    // Matched on the full formatted message (not just "ghost", which also
    // appears in WizardSummary's own join-row text above the error area).
    expect(
      within(saveStep).getByText(i18n.t("err.joinUnknownAlias", { alias: "ghost" }), { exact: false }),
    ).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  // Fix 2: a successful save must cancel whatever autosave write is still
  // pending, or the debounce timer scheduled by the state change that made
  // the config save-ready fires AFTER the save and recreates the draft that
  // was just cleared (contradicts S-09/spec.md:268-275). This differs from
  // `savesConfigClearsDraftAndDownloadsFile` precisely in advancing timers
  // PAST the debounce window after the save's promise has resolved.
  it("successfulSaveCancelsPendingAutosaveTimerSoDraftDoesNotResurrect", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          name: "demo-project",
          target: { sheet: "S1", header_row: 1, columns: ["colA"] },
          sources: [{ alias: "primary", role: "primary", sheet: "S1", header_row: 1, columns: ["colA"] }],
          joins: [],
          mappings: [{ target: "colA", source: "primary.colA" }],
        }),
      );

      const { container } = renderWizard();
      // Restoring applies FormState via setState — this is the "state
      // change" that (re)schedules the pending autosave timer the bug
      // depends on, same shape as "user types the name" in the report.
      fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));
      goToStep(i18n.t("config.rail.save"));
      const saveStep = stepEl(container, "save");

      vi.mocked(api.post).mockResolvedValue({ name: "demo-project" });
      URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
      URL.revokeObjectURL = vi.fn();

      fireEvent.click(saveButtonIn(saveStep));
      // Let the mocked mutation's promise chain (react-query's mutateAsync)
      // settle without relying on @testing-library's waitFor, which polls
      // via a real setTimeout that never fires under fake timers (see the
      // S-13 test's comment above for the full explanation).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();

      // THEN advance PAST the debounce window that was pending when save
      // was clicked — the draft must still be gone.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Fix 3 / S-17: after a draft restore, target.file is permanently null
  // (configForm.ts owns that invariant) even though target.columns can be
  // non-empty — the target step must explain why with the spec's exact
  // zh-TW copy (spec.md:478-479), but only once a restore actually
  // happened; a first visit with no draft must stay silent (no noise).
  it("showsReuploadHintInTargetStepOnlyAfterDraftRestoreWithNoFile", () => {
    const fresh = renderWizard();
    expect(
      screen.queryByText(i18n.t("wizard.step.target.restoredEmptyState")),
    ).not.toBeInTheDocument();
    fresh.unmount();

    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        name: "demo-project",
        target: { sheet: "S1", header_row: 1, columns: ["colA"] },
        sources: [{ alias: "primary", role: "primary", sheet: "S1", header_row: 1, columns: ["colA"] }],
        joins: [],
        mappings: [{ target: "colA", source: "primary.colA" }],
      }),
    );

    const { container } = renderWizard();
    fireEvent.click(screen.getByText(i18n.t("config.draftRestore")));

    const targetStep = stepEl(container, "target");
    expect(
      within(targetStep).getByText(
        i18n.t("wizard.step.target.restoredEmptyState", { filename: i18n.t("config.draftUnrecorded") }),
      ),
    ).toBeVisible();
  });

  // S-19
  it("keepsStepContentMountedAcrossNavigationNoDuplicateParseCall", async () => {
    const { container } = renderWizard();
    vi.mocked(api.postForm).mockResolvedValue(parseResponseFor(["colA"]));

    // GIVEN 已在 target 步驟完成初次解析
    await uploadFile(container, '[data-step="target"] input[type="file"]', xlsxFile("template.xlsx"));
    expect(api.postForm).toHaveBeenCalledTimes(1);

    // WHEN 導覽離開 target 再導覽回來
    goToStep(i18n.t("config.rail.mappings"));
    expect(isStepHidden(container, "target")).toBe(true);
    goToStep(i18n.t("config.rail.target"));
    expect(isStepHidden(container, "target")).toBe(false);

    // THEN SheetHeaderPicker 必須維持掛載（同一個 File、`useEffect(...,
    // [file])` 未被重新觸發）——不得對同一個檔案重複呼叫解析 API。
    expect(api.postForm).toHaveBeenCalledTimes(1);
  });

  // Fix 1: an unreadable stored draft (readDraft() -> {ok: false, raw}) must
  // be a recoverable state, not a dead end. The user must see a message
  // specific to this situation (not errors.generic) and a working Discard
  // control that actually clears the stored draft and leaves the page clean.
  it("malformedDraftShowsRecoverableMessageAndDiscardReachesCleanState", () => {
    localStorage.setItem(DRAFT_KEY, "{not json");

    renderWizard();

    expect(screen.getByText(i18n.t("config.draftUnreadable"))).toBeVisible();
    expect(screen.queryByText(i18n.t("errors.generic"))).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t("config.draftDiscard")));

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.queryByText(i18n.t("config.draftUnreadable"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("errors.generic"))).not.toBeInTheDocument();
  });

  // Fix 2: fields must lock while a save is in flight so an edit made in
  // that window can't schedule an autosave the success path then cancels
  // (silently losing the edit). Step navigation is explicitly exempt
  // (S-02/REQ-02) — covered separately by
  // disabledOnlyDuringPendingSaveNotIncompleteSteps above.
  it("locksFormFieldsWhilePendingSaveNotStepNavigation", async () => {
    const { container } = renderWizard();
    await setupValidState(container);
    goToStep(i18n.t("config.rail.save"));

    const saveStep = stepEl(container, "save");
    const nameInput = within(saveStep).getByLabelText(i18n.t("config.name")) as HTMLInputElement;
    expect(nameInput).not.toBeDisabled();

    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(saveButtonIn(saveStep));

    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).toBeDisabled());
    expect(within(stepEl(container, "save")).getByLabelText(i18n.t("config.name"))).toBeDisabled();

    // Step navigation must stay fully usable during the pending save — the
    // rail and "上一步" are unaffected; "下一步" is disabled here purely
    // because "save" is the last step (array boundary), not the pending save.
    expectNoRailButtonDisabled();
    expect(navButton(i18n.t("wizard.nav.prev"))).not.toBeDisabled();
    expect(navButton(i18n.t("wizard.nav.next"))).toBeDisabled();

    resolveSave({ name: "demo-project" });
  });

  // Fix 1: WizardSummary's four 修改 (edit) buttons are step navigation
  // (they call onEdit -> setCurrentStep), not form fields — they must stay
  // enabled during a pending save the same way the rail and prev/next do
  // (S-02/REQ-02). Regression guard: the existing pending-save tests above
  // only check the rail and prev/next, never this control group.
  it("summaryEditButtonsStayEnabledDuringPendingSave", async () => {
    const { container } = renderWizard();
    await setupValidState(container);
    goToStep(i18n.t("config.rail.save"));

    const saveStep = stepEl(container, "save");
    const editButtons = () =>
      within(saveStep)
        .getAllByText(i18n.t("wizard.summary.edit"))
        .map((el) => el.closest("button") as HTMLButtonElement);

    for (const button of editButtons()) {
      expect(button).not.toBeDisabled();
    }

    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(saveButtonIn(saveStep));

    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).toBeDisabled());
    for (const button of editButtons()) {
      expect(button).not.toBeDisabled();
    }

    resolveSave({ name: "demo-project" });
  });

  // SheetHeaderPicker's per-row `<tr onClick>` is plain DOM, not a
  // form-associated element, so the target step's `<fieldset disabled>`
  // (WizardPage.tsx:352) does not reach it. Row clicks during a pending
  // save must not silently re-point the header row / column set.
  it("targetSheetRowClickInertDuringPendingSaveInteractiveOtherwise", async () => {
    const { container } = renderWizard();
    vi.mocked(api.postForm).mockImplementation(async () => ({
      sheets: [{ name: "Sheet1", preview_rows: [["colA"], ["colB"]], preview_starts_at: 1 }],
    }));
    await uploadFile(container, '[data-step="target"] input[type="file"]', xlsxFile("template.xlsx"));
    await uploadFile(container, '[data-step="sources"] details input[type="file"]', xlsxFile("source.xlsx"));

    const mappingsStep = stepEl(container, "mappings");
    const sourceSelect = await within(mappingsStep).findByDisplayValue(i18n.t("mapping.selectSource"));
    fireEvent.change(sourceSelect, { target: { value: "primary.colA" } });

    const saveStep = stepEl(container, "save");
    fireEvent.change(within(saveStep).getByLabelText(i18n.t("config.name")), {
      target: { value: "demo-project" },
    });
    goToStep(i18n.t("config.rail.save"));

    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(saveButtonIn(stepEl(container, "save")));
    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).toBeDisabled());

    const targetStep = stepEl(container, "target");
    const secondRow = targetStep.querySelectorAll("tbody tr")[1];

    // BEFORE resolve: clicking the non-header row during the pending save
    // must not change the confirmed header row (still "colA", row 1).
    fireEvent.click(secondRow);
    expect(within(targetStep).getByText(`${i18n.t("config.headersPrefix")}colA`)).toBeVisible();

    resolveSave({ name: "demo-project" });
    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).not.toBeDisabled());

    // AFTER resolve: the same row click is live again.
    fireEvent.click(targetStep.querySelectorAll("tbody tr")[1]);
    expect(within(targetStep).getByText(`${i18n.t("config.headersPrefix")}colB`)).toBeVisible();
  });

  // SourcesTree's per-source SheetHeaderPicker reaches the wizard's "sources"
  // step only through SourcesTree (WizardPage.tsx:391), which previously had
  // no `disabled` prop of its own to forward — the fieldset around it
  // (WizardPage.tsx:390) can't reach the `<tr onClick>` rows either, same gap
  // as the target step's picker above.
  it("sourcesSheetRowClickInertDuringPendingSaveInteractiveOtherwise", async () => {
    const { container } = renderWizard();
    vi.mocked(api.postForm).mockImplementation(async () => ({
      sheets: [{ name: "Sheet1", preview_rows: [["colA"], ["colB"]], preview_starts_at: 1 }],
    }));
    await uploadFile(container, '[data-step="target"] input[type="file"]', xlsxFile("template.xlsx"));
    await uploadFile(container, '[data-step="sources"] details input[type="file"]', xlsxFile("source.xlsx"));

    const mappingsStep = stepEl(container, "mappings");
    const sourceSelect = await within(mappingsStep).findByDisplayValue(i18n.t("mapping.selectSource"));
    fireEvent.change(sourceSelect, { target: { value: "primary.colA" } });

    const saveStep = stepEl(container, "save");
    fireEvent.change(within(saveStep).getByLabelText(i18n.t("config.name")), {
      target: { value: "demo-project" },
    });
    goToStep(i18n.t("config.rail.save"));

    let resolveSave: (v: unknown) => void = () => {};
    vi.mocked(api.post).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    fireEvent.click(saveButtonIn(stepEl(container, "save")));
    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).toBeDisabled());

    const sourcesStep = stepEl(container, "sources");
    const secondRow = sourcesStep.querySelectorAll("details tbody tr")[1];

    // BEFORE resolve: clicking the non-header row during the pending save
    // must not change the confirmed header row (still "colA", row 1).
    fireEvent.click(secondRow);
    expect(within(sourcesStep).getByText(`${i18n.t("config.columnsPrefix")}colA`)).toBeVisible();

    resolveSave({ name: "demo-project" });
    await waitFor(() => expect(saveButtonIn(stepEl(container, "save"))).not.toBeDisabled());

    // AFTER resolve: the same row click is live again.
    fireEvent.click(sourcesStep.querySelectorAll("details tbody tr")[1]);
    expect(within(sourcesStep).getByText(`${i18n.t("config.columnsPrefix")}colB`)).toBeVisible();
  });

  // Fix 3: an uploaded target file's original name must survive into the
  // persisted draft as `target.sample_filename`, so a restored draft can
  // still show which file was last uploaded even though `target.file` is
  // always null after a restore (S-17, configForm.ts's readDraft).
  it("uploadStoresSampleFilename", async () => {
    const { container } = renderWizard();
    vi.mocked(api.postForm).mockImplementation(async () => parseResponseFor(["colA"]));

    await uploadFile(container, '[data-step="target"] input[type="file"]', xlsxFile("t.xlsx"));

    // Autosave debounce (WizardPage.tsx's DEBOUNCE_MS = 1000) — real timers
    // here, not vi.useFakeTimers(), because uploadFile's waitFor above can't
    // coexist with fake timers (see the S-13 test's comment further up).
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const written = localStorage.getItem(DRAFT_KEY);
    expect(written, "autosave must write a draft to localStorage[DRAFT_KEY]").not.toBeNull();
    const parsed = JSON.parse(written as string);
    expect(parsed.target.sample_filename).toBe("t.xlsx");
  });
});
