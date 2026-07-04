/** Left pane: target template + all source files with SheetHeaderPicker per file. */

import { useRef, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { FileDropzone } from "@/components/FileDropzone";
import { SheetHeaderPicker } from "@/components/SheetHeaderPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SourceRole } from "@/lib/schemas";

export type SourceEntry = {
  alias: string;
  role: SourceRole;
  file: File | null;
  sheet: string;
  header_row: number;
  columns: string[];
  sample_filename?: string;
};

type Props = {
  targetFile: File | null;
  targetSheet: string;
  targetHeaderRow: number;
  targetColumns: string[];
  onTargetFile: (f: File | null) => void;
  onTargetMeta: (m: { sheet: string; header_row: number; columns: string[] }) => void;
  sources: SourceEntry[];
  onSourcesChange: (next: SourceEntry[]) => void;
  /** DOM id so the checklist rail can scroll this pane into view. */
  id?: string;
  /** Live-validation issue counts shown as badges next to the section labels. */
  targetErrorCount?: number;
  sourcesErrorCount?: number;
  /** Schema-level issues for the sources section (duplicateAlias, noPrimary, etc.) */
  sourcesSchemaIssues?: z.ZodIssue[];
};

export function SourcesTree({
  targetFile, targetSheet, targetHeaderRow, targetColumns,
  onTargetFile, onTargetMeta,
  sources, onSourcesChange,
  id, targetErrorCount = 0, sourcesErrorCount = 0,
  sourcesSchemaIssues = [],
}: Props) {
  const { t } = useTranslation();
  const newSourceRef = useRef<HTMLDetailsElement | null>(null);

  // Aliases whose input has been blurred at least once. Duplicate validation
  // only shows after first blur (and thereafter on every change), so typing a
  // new alias isn't flagged mid-keystroke.
  const [touchedAliases, setTouchedAliases] = useState<Record<number, boolean>>({});

  const isDuplicateAlias = (idx: number): boolean => {
    const alias = sources[idx].alias.trim();
    if (!alias) return false;
    return sources.some((s, i) => i !== idx && s.alias.trim() === alias);
  };

  const updateSource = (idx: number, patch: Partial<SourceEntry>) => {
    onSourcesChange(sources.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const addSource = () => {
    onSourcesChange([
      ...sources,
      { alias: `source_${sources.length + 1}`, role: "lookup", file: null, sheet: "", header_row: 1, columns: [] },
    ]);
    // Scroll to the newly added source after React re-renders
    requestAnimationFrame(() => {
      newSourceRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };
  const removeSource = (idx: number) =>
    onSourcesChange(sources.filter((_, i) => i !== idx));

  /** Clone a source to point at a different sheet of the same xlsx.
   * The new alias inherits the file + sample_filename so BatchRunner can
   * detect "same source file" and avoid a redundant re-upload.
   */
  const addSheetVariant = (idx: number) => {
    const src = sources[idx];
    const suffix = sources.length + 1;
    onSourcesChange([
      ...sources,
      {
        alias: `${src.alias}_sheet${suffix}`,
        role: "lookup",
        file: src.file,                     // share File reference for in-memory reuse
        sheet: "",                          // user picks the other sheet
        header_row: 1,
        columns: [],
        sample_filename: src.sample_filename ?? src.file?.name,
      },
    ]);
  };

  return (
    <div id={id} className="flex flex-col rounded-lg border">
      <div className="p-4 space-y-4">
        <section>
          <Label className="mb-2 inline-flex items-center gap-1 text-sm">
            <FileText className="h-4 w-4 text-emerald-500" />
            {t("config.targetTemplate")}
            {targetErrorCount > 0 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                {targetErrorCount}
              </span>
            )}
          </Label>
          <FileDropzone
            accent="target"
            files={targetFile ? [targetFile] : []}
            onChange={(f) => onTargetFile(f[0] ?? null)}
            hint={t("config.uploadDropHint")}
          />
          {targetFile && (
            <div className="mt-2">
              <SheetHeaderPicker
                file={targetFile}
                value={{ sheet: targetSheet, header_row: targetHeaderRow }}
                onChange={onTargetMeta}
              />
            </div>
          )}
          {targetColumns.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("config.headersPrefix")}{targetColumns.filter(Boolean).join(", ")}
            </p>
          )}
        </section>

        <hr />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="inline-flex items-center gap-2 text-sm">
              {t("config.sourcesPane")}
              {sourcesErrorCount > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                  {sourcesErrorCount}
                </span>
              )}
            </Label>
          </div>

          {sourcesSchemaIssues.length > 0 && (
            <div className="space-y-0.5">
              {sourcesSchemaIssues.map((issue, i) => {
                const params = (issue as z.ZodIssue & { params?: Record<string, unknown> }).params ?? {};
                return (
                  <p key={i} className="text-xs text-destructive">
                    {t(issue.message, params)}
                  </p>
                );
              })}
            </div>
          )}

          {sources.map((s, idx) => (
            <details
              key={idx}
              open
              className="rounded-md border p-2"
              ref={idx === sources.length - 1 ? newSourceRef : undefined}
            >
              <summary className="flex cursor-pointer items-center gap-2 text-sm">
                <ChevronRight className="h-3 w-3" />
                <span className="font-medium">{s.alias}</span>
                <span className={s.role === "primary" ? "text-blue-600" : "text-muted-foreground"}>
                  ({s.role})
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      value={s.alias}
                      onChange={(e) => updateSource(idx, { alias: e.target.value })}
                      onBlur={() => setTouchedAliases((prev) => ({ ...prev, [idx]: true }))}
                      className={cn(
                        "text-xs",
                        touchedAliases[idx] && isDuplicateAlias(idx) && "border-destructive",
                      )}
                      placeholder="alias"
                    />
                    {touchedAliases[idx] && isDuplicateAlias(idx) && (
                      <p className="mt-1 text-xs text-destructive">{t("err.aliasDuplicate")}</p>
                    )}
                  </div>
                  <Select
                    value={s.role}
                    onChange={(e) => updateSource(idx, { role: e.target.value as SourceRole })}
                    className="h-9 w-32 text-xs"
                  >
                    <option value="primary">primary</option>
                    <option value="lookup">lookup</option>
                  </Select>
                  <Button size="sm" variant="ghost" onClick={() => removeSource(idx)}>
                    ✕
                  </Button>
                </div>
                <FileDropzone
                  accent={s.role === "primary" ? "primary" : "lookup"}
                  files={s.file ? [s.file] : []}
                  onChange={(f) => updateSource(idx, { file: f[0] ?? null })}
                  hint={t("config.uploadDropHint")}
                />
                {s.file && (
                  <SheetHeaderPicker
                    file={s.file}
                    value={{ sheet: s.sheet, header_row: s.header_row }}
                    onChange={({ sheet, header_row, columns }) =>
                      updateSource(idx, { sheet, header_row, columns })
                    }
                  />
                )}
                {s.columns.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("config.columnsPrefix")}{s.columns.filter(Boolean).slice(0, 8).join(", ")}
                    {s.columns.length > 8 ? "…" : ""}
                  </p>
                )}
                {(s.file || s.sample_filename) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => addSheetVariant(idx)}
                  >
                    {t("config.addSheetVariant")}
                  </Button>
                )}
              </div>
            </details>
          ))}
        </section>

        <div className="border-t pt-2">
          <Button size="sm" variant="outline" className="w-full" onClick={addSource}>
            {t("config.addSource")}
          </Button>
        </div>
      </div>
    </div>
  );
}
