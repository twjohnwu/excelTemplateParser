/** `WizardPage`: the five-step guided wizard for building a config from
 * scratch (STDD/create-project-wizard, REQ-01, REQ-02, REQ-06, REQ-07,
 * REQ-08, REQ-09, REQ-10). Sole owner of the wizard's `FormState` and of
 * `currentStep` (pure UI state — never enters the draft payload, see
 * `configForm.ts`'s `toPersistable`, which has no step field to begin
 * with). Step content is delegated to the existing
 * `SourcesTree`/`JoinsEditor`/`MappingsList`/`WizardSummary` components,
 * wrapped in `WizardStepShell` for the permanent description/example copy
 * (REQ-03/REQ-04).
 *
 * Navigation is ordering, not permission (REQ-02): `ChecklistRail`'s
 * `onStepClick` sets `currentStep` with no precondition, and every step's
 * content stays mounted at all times (S-19) — visibility toggles via
 * Tailwind's `hidden`/`block` utility classes so `SheetHeaderPicker`'s
 * `useEffect(..., [file])` never re-fires for a step the user merely
 * navigated away from and back to.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { FileDropzone } from "@/components/FileDropzone";
import { SheetHeaderPicker } from "@/components/SheetHeaderPicker";
import { SourcesTree } from "@/features/config-builder/SourcesTree";
import { JoinsEditor } from "@/features/config-builder/JoinsEditor";
import { MappingsList } from "@/features/config-builder/MappingsList";
import { ChecklistRail } from "@/features/config-builder/ChecklistRail";
import { WizardStepShell } from "@/features/config-wizard/WizardStepShell";
import { WizardSummary } from "@/features/config-wizard/WizardSummary";
import { WIZARD_COPY } from "@/features/config-wizard/wizardCopy";
import { useSaveConfig } from "@/hooks/useConfigs";
import {
  countIssuesByStep,
  deriveStepStates,
  STEP_IDS,
  type StepId,
} from "@/lib/previewHelpers";
import { bucketIssues, humanizeIssue } from "@/lib/issueHelpers";
import { mergeMappingsWithColumns } from "@/lib/configHelpers";
import type { Config, Mapping } from "@/lib/schemas";
import {
  DRAFT_KEY,
  type FormState,
  type DraftReadResult,
  emptyState,
  toConfig,
  formatSaveError,
  DEFAULT_SAVE_ERROR_KEY,
  readDraft,
  writeDraft,
  draftWriterLabel,
  summarizeDraft,
} from "@/lib/configForm";

// Same debounce window as ConfigBuilder.tsx's autosave effect
// (ConfigBuilder.tsx:56, DEBOUNCE_MS = 1000) — kept identical so the two
// entry points feel consistent even though they don't share this constant.
const DEBOUNCE_MS = 1000;

/** Local copy of ConfigBuilder.tsx's `downloadJson` (private/unexported
 * there, and that file is out of scope for this change) — see
 * ConfigBuilder.tsx:530-540 for the original. Kept intentionally
 * duplicated rather than exporting from a page-level file. */
function downloadJson(cfg: Config) {
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${cfg.name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Local copy of ConfigBuilder.tsx's `formatIssues` (private/unexported
 * there, and that file is out of scope for this change) — see
 * ConfigBuilder.tsx:66-82 for the original. Kept intentionally duplicated
 * rather than exporting from a page-level file, same precedent as
 * `downloadJson` above. Renders non-name schema issues (sources/joins/
 * mappings) the save step has no other surface for. */
function formatIssues(
  issues: z.ZodIssue[],
  t: (key: string, opts?: Record<string, unknown>) => string,
  mappings: Pick<Mapping, "target">[]
): ReactNode {
  if (issues.length === 0) return null;
  return (
    <ul className="list-disc pl-4">
      {issues.map((issue, idx) => {
        const h = humanizeIssue(issue, mappings);
        const label = h.labelKey ? t(h.labelKey, h.labelParams) : "";
        const msg = t(h.messageKey, h.messageParams);
        return (
          <li key={idx}>
            {label ? t("issue.labelWithMessage", { label, message: msg }) : msg}
          </li>
        );
      })}
    </ul>
  );
}

export function WizardPage() {
  const { t } = useTranslation();
  const save = useSaveConfig();

  const [state, setState] = useState<FormState>(emptyState);
  const [currentStep, setCurrentStep] = useState<StepId>("target");
  const [saveError, setSaveError] = useState<ReactNode>(null);
  // Dialog open/close flag only — NOT a snapshot of the config to resend.
  // Confirming always recomputes toConfig(state) from the *current* state
  // (S-10): the user may edit fields (e.g. rename) while the dialog is open.
  const [pendingOverwrite, setPendingOverwrite] = useState(false);
  // Snapshot of readDraft()'s result taken at mount (design-fe.md:274-280);
  // both ok:true and ok:false count as "a draft exists" for the restore
  // banner (design-fe.md:195-199). Cleared once the user restores/discards.
  const [draftSnapshot, setDraftSnapshot] = useState<DraftReadResult | null>(null);
  // S-17: target.file is always null after a restore (configForm.ts owns
  // that invariant) — track that a restore actually applied state so the
  // target step's empty-state copy can tell "never uploaded" apart from
  // "uploaded once, then a draft wiped the File object", without touching
  // deriveStepStates' own pending/done classification (previewHelpers.ts:73).
  const [draftWasRestored, setDraftWasRestored] = useState(false);

  const configResult = useMemo(() => toConfig(state), [state]);
  const issueCounts = useMemo(
    () => countIssuesByStep(configResult.ok ? [] : configResult.issues),
    [configResult]
  );
  const nameIssues = useMemo(
    () => (configResult.ok ? [] : bucketIssues(configResult.issues).name),
    [configResult]
  );
  const stepStates = useMemo(
    () =>
      deriveStepStates(
        {
          name: state.name,
          target: { hasFile: state.target.file instanceof File, columns: state.target.columns },
          sources: state.sources.map((s) => ({ alias: s.alias, hasFile: s.file instanceof File })),
          joins: state.joins,
          mappings: state.mappings,
        },
        issueCounts
      ),
    [state, issueCounts]
  );

  // Draft-detection effect (REQ-08, mount-only): decide the restore banner
  // from readDraft()'s result, per design-fe.md's stated rule that both
  // ok:true and ok:false (malformed) count as "a draft exists" — this is
  // the reader-side complementary protection, not the anti-clobber
  // invariant itself (that lives inside writeDraft(), configForm.ts:206).
  useEffect(() => {
    const result = readDraft();
    if (result) setDraftSnapshot(result);
    // Intentionally run once at mount only, mirroring ConfigBuilder.tsx:154-160.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced draft autosave through the shared module (S-13/S-14). Tagged
  // "wizard" so a later restore can tell which interface last wrote it
  // (draftWriterLabel). writeDraft() itself is a no-op for a pristine state
  // (configForm.ts:206) so a fresh mount can't clobber an existing draft —
  // same shape as ConfigBuilder.tsx:203-208.
  //
  // The handle is also kept in a ref (not just the effect-local `handle`)
  // so a successful save (handleSave, below) can cancel whichever timer is
  // still outstanding — a save changes no `state`, so the effect above
  // won't re-run and its own cleanup won't fire; without this ref the
  // already-scheduled write would fire after the save and resurrect the
  // draft it just cleared (S-09).
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    autosaveTimerRef.current = setTimeout(() => {
      writeDraft(state, "wizard");
    }, DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [state]);

  // S-14: which surface wrote the stored draft, for the restore banner. A
  // draft with no `_draftMeta` (written before this feature existed, or by
  // an older build) has no recoverable writer — show the same
  // "writerUnknown" fallback the malformed-draft case gets, rather than
  // guessing or rendering a raw i18n key.
  const draftWriterKey = () => {
    const result = draftSnapshot;
    if (result?.ok && result.meta) return draftWriterLabel(result.meta.writer);
    return "wizard.draftRestore.writerUnknown";
  };

  // Only reachable for an ok:true snapshot — the malformed-draft banner
  // (below) offers no Restore control, since there is nothing to restore.
  const restoreDraft = () => {
    const result = draftSnapshot;
    if (!result || !result.ok) return;
    setState(result.state);
    setDraftWasRestored(true);
    setDraftSnapshot(null);
  };

  // No shared "clear draft" export exists in configForm.ts (only writeDraft/
  // readDraft) — writing a new one is out of scope for this change, so this
  // discard path talks to localStorage[DRAFT_KEY] directly, same as the
  // existing handleSave cleanup below and ConfigBuilder.tsx's discardDraft.
  const discardDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
    setDraftSnapshot(null);
  };

  const handleSave = async (cfg: Config, overwrite: boolean) => {
    setSaveError(null);
    try {
      await save.mutateAsync({ config: cfg, overwrite });
      // Cancel whichever autosave write is still pending (see the ref's
      // comment above) before clearing the draft, so it can't resurrect it.
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      localStorage.removeItem(DRAFT_KEY);
      downloadJson(cfg);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPendingOverwrite(true);
        return;
      }
      const formatted = formatSaveError(e instanceof Error ? e.message : String(e));
      setSaveError(formatted === DEFAULT_SAVE_ERROR_KEY ? t(DEFAULT_SAVE_ERROR_KEY) : formatted);
    }
  };

  const handleSaveClick = () => {
    setSaveError(null);
    const result = toConfig(state);
    if (!result.ok) {
      // NAME_PATTERN issues render inline under the name field (nameIssues,
      // S-11) — everything else (e.g. an unknown join alias) has no other
      // surface on this step, so without this the click is silently a
      // no-op. Same formatIssues shape as ConfigBuilder.tsx's handleSave.
      const otherIssues = result.issues.filter((issue) => issue.path[0] !== "name");
      if (otherIssues.length > 0) {
        setSaveError(formatIssues(otherIssues, t, state.mappings));
      }
      return;
    }
    void handleSave(result.config, false);
  };

  const handleOverwriteConfirm = () => {
    setPendingOverwrite(false);
    const result = toConfig(state); // recompute from CURRENT state, not the pre-dialog snapshot (S-10)
    if (!result.ok) return;
    void handleSave(result.config, true);
  };

  // Linear prev/next over STEP_IDS (REQ-02): a pure index shift, no
  // completion gating. At the array boundaries there is nowhere left to go,
  // so the corresponding button is disabled (STDD/create-project-wizard/
  // spec.md S-02: disabled is for "the action itself has no input", not for
  // an incomplete step) — this is the only condition that ever disables
  // step navigation; an incomplete step elsewhere never does (see the
  // module doc comment).
  const currentIndex = STEP_IDS.indexOf(currentStep);
  const handlePrevStep = () => {
    if (currentIndex > 0) setCurrentStep(STEP_IDS[currentIndex - 1]);
  };
  const handleNextStep = () => {
    if (currentIndex < STEP_IDS.length - 1) setCurrentStep(STEP_IDS[currentIndex + 1]);
  };

  return (
    <div className="flex flex-col gap-3">
      <Dialog open={pendingOverwrite} onOpenChange={(open) => { if (!open) setPendingOverwrite(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialog.overwriteConfig.title")}</DialogTitle>
            <DialogDescription>{t("dialog.overwriteConfig.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingOverwrite(false)}>
              {t("dialog.overwriteConfig.cancel")}
            </Button>
            <Button onClick={handleOverwriteConfirm}>{t("dialog.overwriteConfig.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {draftSnapshot && draftSnapshot.ok && (
        <div className="rounded-md border bg-yellow-50 px-3 py-2 text-sm dark:bg-yellow-950/40">
          {t("config.draftRestorePrompt")}
          <span className="ml-1 text-muted-foreground">
            {t("config.draftRestoreWriter", { writer: t(draftWriterKey()) })}
          </span>
          <Button size="sm" variant="ghost" className="ml-2" onClick={restoreDraft}>
            {t("config.draftRestore")}
          </Button>
          <Button size="sm" variant="ghost" onClick={discardDraft}>
            {t("config.draftDiscard")}
          </Button>
          {/* S-21: which project/files this draft came from, so restoring a
              draft written by a different project doesn't silently mix its
              settings into the current one. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {t("config.draftSummary", (() => {
              const summary = summarizeDraft(draftSnapshot.state);
              const unrecorded = t("config.draftUnrecorded");
              return {
                name: summary.name || unrecorded,
                target: summary.targetFilename ?? unrecorded,
                sources:
                  summary.sourceFilenames.length > 0
                    ? summary.sourceFilenames.map((f) => f ?? unrecorded).join(", ")
                    : unrecorded,
                joins: summary.joinCount,
                mappings: summary.mappingCount,
              };
            })())}
          </p>
        </div>
      )}
      {draftSnapshot && !draftSnapshot.ok && (
        <div className="rounded-md border bg-yellow-50 px-3 py-2 text-sm dark:bg-yellow-950/40">
          {t("config.draftUnreadable")}
          <Button size="sm" variant="ghost" className="ml-2" onClick={discardDraft}>
            {t("config.draftDiscard")}
          </Button>
        </div>
      )}

      <div className="flex gap-3">
      <ChecklistRail
        states={stepStates}
        errorCounts={issueCounts}
        onStepClick={setCurrentStep}
        activeStep={currentStep}
        className="flex w-28 shrink-0 flex-col gap-1 self-start rounded-lg border p-2 sticky top-[4.5rem]"
      />

      <div className="min-w-0 flex-1 space-y-3">
        {/* Each step's own <fieldset disabled> locks that step's editable
            fields while a save is in flight (Fix 2) so an edit made in that
            window can't schedule an autosave the success path then cancels
            (silently losing the edit) — a native <fieldset disabled>
            propagates to every nested form control without each step's own
            component needing a disabled prop. The fieldset is scoped PER
            STEP (not one fieldset around the whole map) so that WizardSummary
            in the "save" step — step navigation, not a form field — can sit
            outside any fieldset and stay enabled. Step navigation
            (ChecklistRail above, prev/next below, and WizardSummary's edit
            buttons) is never inside a disabled fieldset — REQ-02 permits
            disabling only for the form fields, never for step navigation
            because a step is incomplete (the first-step Back / last-step
            Next no-op disable is the S-02 exception). */}
        {STEP_IDS.map((id) => (
          <div key={id} className={currentStep === id ? "block" : "hidden"}>
            <WizardStepShell
              stepId={id}
              description={t(WIZARD_COPY[id].descriptionKey)}
              example={t(WIZARD_COPY[id].exampleKey)}
              terms={WIZARD_COPY[id].terms}
            >
              {id === "target" && (
                <fieldset disabled={save.isPending} className="space-y-2 border-0 p-0 m-0">
                  <FileDropzone
                    accent="target"
                    files={state.target.file ? [state.target.file] : []}
                    onChange={(f) =>
                      setState({
                        ...state,
                        target: {
                          ...state.target,
                          file: f[0] ?? null,
                          sample_filename: f[0]?.name ?? state.target.sample_filename,
                        },
                      })
                    }
                    hint={t("config.uploadDropHint")}
                    disabled={save.isPending}
                  />
                  {state.target.file && (
                    <SheetHeaderPicker
                      file={state.target.file}
                      value={{ sheet: state.target.sheet, header_row: state.target.header_row }}
                      onChange={(m) =>
                        setState((prev) => ({
                          ...prev,
                          target: { ...prev.target, ...m },
                          mappings: mergeMappingsWithColumns(prev.mappings, m.columns),
                        }))
                      }
                      disabled={save.isPending}
                    />
                  )}
                  {state.target.columns.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("config.headersPrefix")}
                      {state.target.columns.filter(Boolean).join(", ")}
                    </p>
                  )}
                  {!state.target.file && draftWasRestored && (
                    <p className="text-xs text-muted-foreground">
                      {t("wizard.step.target.restoredEmptyState", {
                        filename: state.target.sample_filename ?? t("config.draftUnrecorded"),
                      })}
                    </p>
                  )}
                </fieldset>
              )}
              {id === "sources" && (
                <fieldset disabled={save.isPending} className="border-0 p-0 m-0">
                  <SourcesTree
                    showTarget={false}
                    targetFile={state.target.file}
                    targetSheet={state.target.sheet}
                    targetHeaderRow={state.target.header_row}
                    targetColumns={state.target.columns}
                    onTargetFile={(f) =>
                      setState({
                        ...state,
                        target: { ...state.target, file: f, sample_filename: f?.name ?? state.target.sample_filename },
                      })
                    }
                    onTargetMeta={(m) =>
                      setState((prev) => ({
                        ...prev,
                        target: { ...prev.target, ...m },
                        mappings: mergeMappingsWithColumns(prev.mappings, m.columns),
                      }))
                    }
                    sources={state.sources}
                    onSourcesChange={(sources) => setState({ ...state, sources })}
                    sourcesErrorCount={issueCounts.sources}
                    sourcesSchemaIssues={configResult.ok ? [] : bucketIssues(configResult.issues).sources}
                    disabled={save.isPending}
                    showReuploadHint={draftWasRestored}
                  />
                </fieldset>
              )}
              {id === "joins" && (
                <fieldset disabled={save.isPending} className="border-0 p-0 m-0">
                  <JoinsEditor
                    sources={state.sources}
                    joins={state.joins}
                    onChange={(joins) => setState({ ...state, joins })}
                    errorCount={issueCounts.joins}
                    joinsByIndex={configResult.ok ? undefined : bucketIssues(configResult.issues).joinsByIndex}
                  />
                </fieldset>
              )}
              {id === "mappings" && (
                <fieldset disabled={save.isPending} className="border-0 p-0 m-0">
                  {state.target.columns.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t("wizard.step.mappings.emptyState")}
                    </p>
                  )}
                  <MappingsList
                    mappings={state.mappings}
                    sources={state.sources}
                    targetColumns={state.target.columns}
                    onChange={(mappings) => setState({ ...state, mappings })}
                    errorCount={issueCounts.mappings}
                    mappingsByIndex={configResult.ok ? undefined : bucketIssues(configResult.issues).mappingsByIndex}
                  />
                </fieldset>
              )}
              {id === "save" && (
                <div className="space-y-3">
                  <WizardSummary state={state} onEdit={setCurrentStep} />
                  <fieldset disabled={save.isPending} className="space-y-3 border-0 p-0 m-0">
                    <div>
                      <Label htmlFor="wizard-cfg-name">{t("config.name")}</Label>
                      <Input
                        id="wizard-cfg-name"
                        value={state.name}
                        onChange={(e) => setState({ ...state, name: e.target.value })}
                        placeholder={t("config.namePlaceholder") ?? ""}
                        className={`w-64${nameIssues.length > 0 ? " border-destructive" : ""}`}
                      />
                      {nameIssues.map((issue, i) => (
                        <p key={i} className="mt-0.5 text-xs text-destructive">
                          {t(issue.message)}
                        </p>
                      ))}
                    </div>
                    {saveError && <div className="text-sm text-destructive">{saveError}</div>}
                    <Button onClick={handleSaveClick} disabled={save.isPending}>
                      {t("config.saveAndDownload")}
                    </Button>
                  </fieldset>
                </div>
              )}
            </WizardStepShell>
          </div>
        ))}

        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePrevStep} disabled={currentIndex === 0}>
            {t("wizard.nav.prev")}
          </Button>
          <Button
            variant="outline"
            onClick={handleNextStep}
            disabled={currentIndex === STEP_IDS.length - 1}
          >
            {t("wizard.nav.next")}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
