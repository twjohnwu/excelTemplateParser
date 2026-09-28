/** ConfigBuilder page: three-pane workbench (sources / joins / mappings).
 * Supports loading an existing config via ?config=<name>, draft autosave,
 * "Save & Download" and "Download current config" buttons.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SourcesTree } from "@/features/config-builder/SourcesTree";
import { JoinsEditor } from "@/features/config-builder/JoinsEditor";
import { MappingsList } from "@/features/config-builder/MappingsList";
import { ChecklistRail } from "@/features/config-builder/ChecklistRail";
import { PreviewDialog } from "@/features/config-builder/PreviewDialog";
import { useConfig, useConfigList, useSaveConfig, useDeleteConfig } from "@/hooks/useConfigs";
import { usePreviewConfig } from "@/hooks/usePreviewConfig";
import { useDebounce } from "@/hooks/useDebounce";
import {
  canPreview,
  countIssuesByStep,
  deriveStepStates,
  type StepId,
} from "@/lib/previewHelpers";
import { bucketIssues, humanizeIssue } from "@/lib/issueHelpers";
import type { Config, Mapping } from "@/lib/schemas";
import { z } from "zod";
import {
  DRAFT_KEY,
  type FormState,
  emptyState,
  toPersistable,
  isPristineState,
  toConfig,
  formatSaveError,
  readDraft,
  writeDraft,
  draftWriterLabel,
  DEFAULT_SAVE_ERROR_KEY,
} from "@/lib/configForm";
import type { DraftReadResult } from "@/lib/configForm";

const DEBOUNCE_MS = 1000;
const VALIDATE_DEBOUNCE_MS = 500;

/** Rail step → DOM id to scroll to. Target & sources share the left pane. */
const STEP_SCROLL_TARGETS: Record<StepId, string> = {
  target: "pane-sources",
  sources: "pane-sources",
  joins: "pane-joins",
  mappings: "pane-mappings",
  save: "cfg-toolbar",
};

function formatIssues(
  issues: z.ZodIssue[],
  t: (key: string, opts?: Record<string, unknown>) => string,
  mappings: Pick<Mapping, "target">[]
): React.ReactNode {
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

import { inferColumnsFromConfig, mergeMappingsWithColumns } from "@/lib/configHelpers";

export function ConfigBuilder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const loadName = params.get("config") ?? undefined;

  const { data: existing } = useConfig(loadName);
  const { data: list } = useConfigList();
  const save = useSaveConfig();
  const deleteConfig = useDeleteConfig();

  const [state, setState] = useState<FormState>(emptyState);
  const [saveError, setSaveError] = useState<React.ReactNode>(null);
  const [draftFound, setDraftFound] = useState(false);
  const [pendingOverwrite, setPendingOverwrite] = useState<Config | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Onboarding card: visible once per session when the state is pristine on
  // first render (no ?config=, no draft). Any user interaction dismisses it.
  const [showOnboarding, setShowOnboarding] = useState(false);

  const preview = usePreviewConfig();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewError, setPreviewError] = useState<React.ReactNode>(null);

  // Debounced live validation: schema-parse the derived config ~500ms after
  // the last edit. Guidance only (rail + pane badges) — the save-time full
  // error list stays as the backstop.
  const debouncedState = useDebounce(state, VALIDATE_DEBOUNCE_MS);
  const liveIssues = useMemo(() => {
    const r = toConfig(debouncedState);
    return r.ok ? [] : r.issues;
  }, [debouncedState]);
  const issueCounts = useMemo(() => countIssuesByStep(liveIssues), [liveIssues]);
  const liveBuckets = useMemo(() => bucketIssues(liveIssues), [liveIssues]);
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

  const previewEnabled = canPreview({
    targetHasFile: state.target.file instanceof File,
    sourceFileCount: state.sources.filter((s) => s.file instanceof File).length,
    schemaOk: liveIssues.length === 0,
  });

  // Snapshot the draft at mount time so the debounced autosave (which writes
  // emptyState ~1s after mount) can't clobber what we restore from.
  const draftSnapshotRef = useRef<DraftReadResult | null>(null);

  // On first mount: detect draft, capture snapshot, prompt user. Both
  // ok: true and ok: false (malformed) results count as "there is a draft" —
  // this is the reader-side complementary protection, not the anti-clobber
  // invariant itself (that lives inside writeDraft()).
  useEffect(() => {
    const result = readDraft();
    if (result && !loadName) {
      draftSnapshotRef.current = result;
      setDraftFound(true);
    }
  }, [loadName]);

  // Show onboarding card on first mount when truly pristine (no ?config=, no draft).
  useEffect(() => {
    const hasDraft = !!localStorage.getItem(DRAFT_KEY);
    if (!loadName && !hasDraft) {
      setShowOnboarding(true);
    }
    // Intentionally run once at mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply loaded config when it arrives.
  useEffect(() => {
    if (!existing) return;
    const inferred = inferColumnsFromConfig(existing);
    setState({
      name: existing.name,
      target: {
        file: null,
        sheet: existing.target_template.sheet,
        header_row: existing.target_template.header_row,
        columns: existing.target_template.columns,
        sample_filename: existing.target_template.sample_filename,
      },
      sources: existing.sources.map((s) => ({
        alias: s.alias,
        role: s.role,
        file: null,
        sheet: s.sheet,
        header_row: s.header_row,
        columns: inferred[s.alias] ?? [],
        sample_filename: s.sample_filename,
      })),
      joins: existing.joins,
      mappings: existing.mappings,
    });
  }, [existing]);

  // Debounced draft autosave. writeDraft() itself is a no-op for a pristine
  // state (don't write, don't delete) so a fresh mount can't clobber an
  // existing draft. Only explicit user actions (discardDraft / handleSave)
  // remove the stored draft.
  //
  // The handle is also kept in a ref (not just the effect-local `handle`) so
  // a successful save (handleSave, below) can cancel whichever timer is
  // still outstanding — a save changes no `state`, so the effect above won't
  // re-run and its own cleanup won't fire; without this ref the
  // already-scheduled write would fire after the save and resurrect the
  // draft it just cleared. Same fix as WizardPage.tsx:186-194.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    autosaveTimerRef.current = setTimeout(() => {
      writeDraft(state, "workbench");
    }, DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [state]);

  // Any state mutation dismisses the onboarding card for the rest of this session.
  const setStateAndDismissOnboarding: typeof setState = (value) => {
    setShowOnboarding(false);
    setState(value);
  };

  // S-14: which surface wrote the stored draft, for the restore banner. A
  // draft with no `_draftMeta` (written before this feature existed, or by
  // an older build) has no recoverable writer — show the same
  // "writerUnknown" fallback the malformed-draft case gets, rather than
  // guessing or rendering a raw i18n key.
  const draftWriterKey = () => {
    const result = draftSnapshotRef.current;
    if (result?.ok && result.meta) return draftWriterLabel(result.meta.writer);
    return "wizard.draftRestore.writerUnknown";
  };

  // Only reachable for an ok:true snapshot — the malformed-draft banner
  // (below) offers no Restore control, since there is nothing to restore.
  const restoreDraft = () => {
    const result = draftSnapshotRef.current;
    if (!result || !result.ok) return;
    setState(result.state);
    setDraftFound(false);
    draftSnapshotRef.current = null;
  };

  const discardDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
    setDraftFound(false);
    draftSnapshotRef.current = null;
  };

  const handleSave = async (overwrite = false) => {
    setSaveError(null);
    const result = toConfig(state);
    if (!result.ok) {
      setSaveError(formatIssues(result.issues, t, state.mappings));
      return;
    }
    const cfg = result.config;
    try {
      await save.mutateAsync({ config: cfg, overwrite });
      // Cancel whichever autosave write is still pending (see the ref's
      // comment above) before clearing the draft, so it can't resurrect it.
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      localStorage.removeItem(DRAFT_KEY);
      downloadJson(cfg);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPendingOverwrite(cfg);
        return;
      }
      const formatted = formatSaveError(e instanceof Error ? e.message : String(e));
      setSaveError(formatted === DEFAULT_SAVE_ERROR_KEY ? t(DEFAULT_SAVE_ERROR_KEY) : formatted);
    }
  };

  const handleDownloadCurrent = () => {
    setSaveError(null);
    const result = toConfig(state);
    if (!result.ok) {
      setSaveError(formatIssues(result.issues, t, state.mappings));
      return;
    }
    downloadJson(result.config);
  };

  const handlePreview = async () => {
    setPreviewError(null);
    const result = toConfig(state);
    if (!result.ok) {
      // Gate is debounced, so a click can race a just-broken state — surface
      // the same formatted issue list the save path uses.
      setPreviewError(formatIssues(result.issues, t, state.mappings));
      return;
    }
    if (!(state.target.file instanceof File)) return;
    const sourceFiles: Record<string, File> = {};
    for (const s of state.sources) {
      if (s.file instanceof File) sourceFiles[s.alias] = s.file;
    }
    try {
      await preview.mutateAsync({
        config: result.config,
        targetFile: state.target.file,
        sourceFiles,
      });
      setPreviewOpen(true);
    } catch (e) {
      if (e instanceof ApiError) {
        const idSuffix = e.requestId ? t("errors.requestIdSuffix", { id: e.requestId }) : "";
        setPreviewError(`${e.message || t("errors.generic")}${idSuffix}`);
      } else {
        setPreviewError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const scrollToStep = useCallback((id: StepId) => {
    document
      .getElementById(STEP_SCROLL_TARGETS[id])
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const handleLoadSelect = useCallback(
    (name: string) => {
      setShowOnboarding(false);
      if (name === "__new__") {
        setState(emptyState());
        params.delete("config");
        setParams(params);
      } else {
        params.set("config", name);
        setParams(params);
      }
    },
    [params, setParams]
  );

  const handleDeleteConfirm = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteConfig.mutateAsync(name);
      toast.success(t("dialog.deleteConfig.deleted", { name }));
      // Reset to new-project state and clear the URL param.
      setState(emptyState());
      params.delete("config");
      setParams(params);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Dialog open={pendingOverwrite !== null} onOpenChange={(open) => { if (!open) setPendingOverwrite(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialog.overwriteConfig.title")}</DialogTitle>
            <DialogDescription>{t("dialog.overwriteConfig.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingOverwrite(null)}>
              {t("dialog.overwriteConfig.cancel")}
            </Button>
            <Button
              onClick={async () => {
                setPendingOverwrite(null);
                void handleSave(true);
              }}
            >
              {t("dialog.overwriteConfig.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete config confirm dialog */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialog.deleteConfig.title")}</DialogTitle>
            <DialogDescription>
              {t("dialog.deleteConfig.description", { name: pendingDelete ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("dialog.deleteConfig.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm} disabled={deleteConfig.isPending}>
              {t("dialog.deleteConfig.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {draftFound && draftSnapshotRef.current?.ok && (
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
        </div>
      )}
      {draftFound && draftSnapshotRef.current?.ok === false && (
        <div className="rounded-md border bg-yellow-50 px-3 py-2 text-sm dark:bg-yellow-950/40">
          {t("config.draftUnreadable")}
          <Button size="sm" variant="ghost" className="ml-2" onClick={discardDraft}>
            {t("config.draftDiscard")}
          </Button>
        </div>
      )}

      <div id="cfg-toolbar" className="flex flex-wrap items-end gap-2">
        {/* Locks the name field while a save is in flight (Fix 2) so an
            edit made in that window can't schedule an autosave the success
            path then cancels (silently losing the edit). Navigation (rail,
            load-existing, delete/preview/download) stays OUTSIDE this
            fieldset — only editable config fields lock, same scope as
            WizardPage.tsx's equivalent fieldset. `contents` keeps this
            wrapper out of the toolbar's flex layout. */}
        <fieldset disabled={save.isPending} className="contents border-0 p-0 m-0">
        <div>
          <Label htmlFor="cfg-name">{t("config.name")}</Label>
          <Input
            id="cfg-name"
            value={state.name}
            onChange={(e) => setStateAndDismissOnboarding({ ...state, name: e.target.value })}
            placeholder={t("config.namePlaceholder") ?? ""}
            className={`w-64${liveBuckets.name.length > 0 ? " border-destructive" : ""}`}
          />
          {liveBuckets.name.map((issue, i) => (
            <p key={i} className="mt-0.5 text-xs text-destructive">
              {t(issue.message)}
            </p>
          ))}
        </div>
        </fieldset>
        <div className="flex items-end gap-1">
          <div>
            <Label>{t("config.loadExisting")}</Label>
            <Select value={loadName ?? ""} onChange={(e) => handleLoadSelect(e.target.value)} className="w-48">
              <option value="__new__">{t("config.newProject")}</option>
              {(list?.configs ?? []).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          {loadName && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-destructive"
              title={t("dialog.deleteConfig.title")}
              onClick={() => setPendingDelete(loadName)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={!previewEnabled || preview.isPending}
          >
            {preview.isPending ? t("config.loadingPreview") : t("config.preview.button")}
          </Button>
          <Button variant="outline" onClick={handleDownloadCurrent}>
            {t("config.downloadCurrent")}
          </Button>
          <Button onClick={() => handleSave(false)} disabled={save.isPending}>
            {t("config.saveAndDownload")}
          </Button>
        </div>
      </div>

      {saveError && <div className="text-sm text-destructive">{saveError}</div>}
      {previewError && <div className="text-sm text-destructive">{previewError}</div>}

      <div className="flex gap-3">
        <div className="self-start sticky top-[4.5rem]">
          <ChecklistRail states={stepStates} errorCounts={issueCounts} onStepClick={scrollToStep} />
        </div>
        {showOnboarding && isPristineState(state) && !draftFound && !loadName ? (
          <div className="flex min-w-0 flex-1 items-center justify-center min-h-[60vh]">
            <div className="rounded-xl border bg-card p-8 shadow-sm text-center max-w-md w-full space-y-6">
              <h2 className="text-xl font-semibold">{t("config.onboarding.title")}</h2>
              <ol className="space-y-2 text-sm text-muted-foreground text-left list-none">
                <li className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">1</span>
                  {t("config.onboarding.step1")}
                </li>
                <li className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-bold">2</span>
                  {t("config.onboarding.step2")}
                </li>
                <li className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-bold">3</span>
                  {t("config.onboarding.step3")}
                </li>
              </ol>
              <Button onClick={() => navigate("/wizard")}>
                {t("config.onboarding.cta")}
              </Button>
              <div>
                <Button
                  variant="link"
                  onClick={() => {
                    setShowOnboarding(false);
                    document
                      .getElementById(STEP_SCROLL_TARGETS.target)
                      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                  }}
                >
                  {t("config.onboarding.stayHere")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
        <fieldset
          disabled={save.isPending}
          className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(300px,1fr)_minmax(260px,1fr)_minmax(360px,1.4fr)] md:grid-cols-2 border-0 p-0 m-0"
        >
        <SourcesTree
          id="pane-sources"
          targetErrorCount={issueCounts.target}
          sourcesErrorCount={issueCounts.sources}
          sourcesSchemaIssues={liveBuckets.sources}
          targetFile={state.target.file}
          targetSheet={state.target.sheet}
          targetHeaderRow={state.target.header_row}
          targetColumns={state.target.columns}
          onTargetFile={(f) => { setShowOnboarding(false); setState({ ...state, target: { ...state.target, file: f } }); }}
          onTargetMeta={(m) =>
            setStateAndDismissOnboarding((prev) => ({
              ...prev,
              target: { ...prev.target, ...m },
              // Auto-seed mappings so the right pane lines up with the template's columns.
              // Existing rows whose target matches a column are preserved; orphans stay at the end.
              mappings: mergeMappingsWithColumns(prev.mappings, m.columns),
            }))
          }
          sources={state.sources}
          onSourcesChange={(sources) => setStateAndDismissOnboarding({ ...state, sources })}
          disabled={save.isPending}
        />
        <JoinsEditor
          id="pane-joins"
          errorCount={issueCounts.joins}
          joinsByIndex={liveBuckets.joinsByIndex}
          sources={state.sources}
          joins={state.joins}
          onChange={(joins) => setStateAndDismissOnboarding({ ...state, joins })}
        />
        <MappingsList
          id="pane-mappings"
          errorCount={issueCounts.mappings}
          mappingsByIndex={liveBuckets.mappingsByIndex}
          mappings={state.mappings}
          sources={state.sources}
          targetColumns={state.target.columns}
          onChange={(mappings) => setStateAndDismissOnboarding({ ...state, mappings })}
        />
        </fieldset>
        )}
      </div>

      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} data={preview.data ?? null} />
    </div>
  );
}

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
