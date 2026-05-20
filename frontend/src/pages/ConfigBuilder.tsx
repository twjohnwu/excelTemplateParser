/** ConfigBuilder page: three-pane workbench (sources / joins / mappings).
 * Supports loading an existing config via ?config=<name>, draft autosave,
 * "Save & Download" and "Download current config" buttons.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SourcesTree, type SourceEntry } from "@/features/config-builder/SourcesTree";
import { JoinsEditor } from "@/features/config-builder/JoinsEditor";
import { MappingsList } from "@/features/config-builder/MappingsList";
import { useConfig, useConfigList, useSaveConfig } from "@/hooks/useConfigs";
import { configSchema, type Config, type JoinRule, type Mapping } from "@/lib/schemas";
import { z } from "zod";

const DRAFT_KEY = "etp.configDraft.v1";
const DEBOUNCE_MS = 1000;

type FormState = {
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

const emptyState = (): FormState => ({
  name: "",
  target: { file: null, sheet: "", header_row: 1, columns: [] },
  sources: [
    { alias: "primary", role: "primary", file: null, sheet: "", header_row: 1, columns: [] },
  ],
  joins: [],
  mappings: [],
});

// File objects can't be JSON-serialized; strip them via undefined (which
// JSON.stringify omits) for both autosave and the empty-state comparison.
function toPersistable(s: FormState) {
  return {
    ...s,
    target: { ...s.target, file: undefined },
    sources: s.sources.map((src) => ({ ...src, file: undefined })),
  };
}

// Pre-computed "this state matches emptyState" sentinel — autosave compares
// against this to avoid persisting a draft when the form was never touched
// (emptyState contains a default primary source, so a naive non-empty check
// gives false positives).
const EMPTY_PERSISTABLE_JSON = JSON.stringify(toPersistable(emptyState()));

type ToConfigResult =
  | { ok: true; config: Config }
  | { ok: false; issues: z.ZodIssue[] };

function toConfig(state: FormState): ToConfigResult {
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

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((i) => {
      const path = i.path.join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("；");
}

import { inferColumnsFromConfig, mergeMappingsWithColumns } from "@/lib/configHelpers";

export function ConfigBuilder() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const loadName = params.get("config") ?? undefined;

  const { data: existing } = useConfig(loadName);
  const { data: list } = useConfigList();
  const save = useSaveConfig();

  const [state, setState] = useState<FormState>(emptyState);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftFound, setDraftFound] = useState(false);

  // Snapshot the draft at mount time so the debounced autosave (which writes
  // emptyState ~1s after mount) can't clobber what we restore from.
  const draftSnapshotRef = useRef<string | null>(null);

  // On first mount: detect draft, capture snapshot, prompt user.
  useEffect(() => {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft && !loadName) {
      draftSnapshotRef.current = draft;
      setDraftFound(true);
    }
  }, [loadName]);

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

  // Debounced draft autosave. Empty state is a no-op (don't write, don't
  // delete) so a fresh mount can't clobber an existing draft. Only explicit
  // user actions (discardDraft / handleSave) remove the stored draft.
  useEffect(() => {
    const handle = setTimeout(() => {
      const json = JSON.stringify(toPersistable(state));
      if (json === EMPTY_PERSISTABLE_JSON) return;
      try {
        localStorage.setItem(DRAFT_KEY, json);
      } catch {/* quota */}
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [state]);

  const restoreDraft = () => {
    const raw = draftSnapshotRef.current;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      setState({
        name: parsed.name ?? "",
        target: {
          file: null,
          sheet: parsed.target?.sheet ?? "",
          header_row: parsed.target?.header_row ?? 1,
          columns: parsed.target?.columns ?? [],
          sample_filename: parsed.target?.sample_filename,
        },
        sources: (parsed.sources ?? []).map((s: any) => ({ ...s, file: null })),
        joins: parsed.joins ?? [],
        mappings: parsed.mappings ?? [],
      });
    } catch {}
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
      setSaveError(formatIssues(result.issues));
      return;
    }
    const cfg = result.config;
    try {
      await save.mutateAsync({ config: cfg, overwrite });
      localStorage.removeItem(DRAFT_KEY);
      downloadJson(cfg);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm(t("config.overwriteConfirm", { name: cfg.name }))) {
          void handleSave(true);
        }
        return;
      }
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDownloadCurrent = () => {
    setSaveError(null);
    const result = toConfig(state);
    if (!result.ok) {
      setSaveError(formatIssues(result.issues));
      return;
    }
    downloadJson(result.config);
  };

  const handleLoadSelect = useCallback(
    (name: string) => {
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

  return (
    <div className="space-y-3">
      {draftFound && (
        <div className="rounded-md border bg-yellow-50 px-3 py-2 text-sm dark:bg-yellow-950/40">
          {t("config.draftRestorePrompt")}
          <Button size="sm" variant="ghost" className="ml-2" onClick={restoreDraft}>
            {t("config.draftRestore")}
          </Button>
          <Button size="sm" variant="ghost" onClick={discardDraft}>
            {t("config.draftDiscard")}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="cfg-name">{t("config.name")}</Label>
          <Input
            id="cfg-name"
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value })}
            placeholder={t("config.namePlaceholder") ?? ""}
            className="w-64"
          />
        </div>
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
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={handleDownloadCurrent}>
            {t("config.downloadCurrent")}
          </Button>
          <Button onClick={() => handleSave(false)} disabled={save.isPending}>
            {t("config.saveAndDownload")}
          </Button>
        </div>
      </div>

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      <div className="grid h-[calc(100vh-220px)] gap-3 lg:grid-cols-[minmax(300px,1fr)_minmax(260px,1fr)_minmax(360px,1.4fr)] md:grid-cols-2">
        <SourcesTree
          targetFile={state.target.file}
          targetSheet={state.target.sheet}
          targetHeaderRow={state.target.header_row}
          targetColumns={state.target.columns}
          onTargetFile={(f) => setState({ ...state, target: { ...state.target, file: f } })}
          onTargetMeta={(m) =>
            setState((prev) => ({
              ...prev,
              target: { ...prev.target, ...m },
              // Auto-seed mappings so the right pane lines up with the template's columns.
              // Existing rows whose target matches a column are preserved; orphans stay at the end.
              mappings: mergeMappingsWithColumns(prev.mappings, m.columns),
            }))
          }
          sources={state.sources}
          onSourcesChange={(sources) => setState({ ...state, sources })}
        />
        <JoinsEditor
          sources={state.sources}
          joins={state.joins}
          onChange={(joins) => setState({ ...state, joins })}
        />
        <MappingsList
          mappings={state.mappings}
          sources={state.sources}
          onChange={(mappings) => setState({ ...state, mappings })}
        />
      </div>
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
