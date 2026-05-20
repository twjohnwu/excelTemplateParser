/** Left pane: target template + all source files with SheetHeaderPicker per file. */

import { ChevronRight, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FileDropzone } from "@/components/FileDropzone";
import { SheetHeaderPicker } from "@/components/SheetHeaderPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
};

export function SourcesTree({
  targetFile, targetSheet, targetHeaderRow, targetColumns,
  onTargetFile, onTargetMeta,
  sources, onSourcesChange,
}: Props) {
  const { t } = useTranslation();

  const updateSource = (idx: number, patch: Partial<SourceEntry>) => {
    onSourcesChange(sources.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const addSource = () =>
    onSourcesChange([
      ...sources,
      { alias: `source_${sources.length + 1}`, role: "lookup", file: null, sheet: "", header_row: 1, columns: [] },
    ]);
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
    <div className="space-y-4 overflow-auto rounded-lg border p-4">
      <section>
        <Label className="mb-2 inline-flex items-center gap-1 text-sm">
          <FileText className="h-4 w-4 text-emerald-500" />
          {t("config.targetTemplate")}
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
            Headers: {targetColumns.filter(Boolean).join(", ")}
          </p>
        )}
      </section>

      <hr />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t("config.sourcesPane")}</Label>
          <Button size="sm" variant="outline" onClick={addSource}>
            + Source
          </Button>
        </div>

        {sources.map((s, idx) => (
          <details key={idx} open className="rounded-md border p-2">
            <summary className="flex cursor-pointer items-center gap-2 text-sm">
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium">{s.alias}</span>
              <span className={s.role === "primary" ? "text-blue-600" : "text-muted-foreground"}>
                ({s.role})
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              <div className="flex gap-2">
                <Input
                  value={s.alias}
                  onChange={(e) => updateSource(idx, { alias: e.target.value })}
                  className="text-xs"
                  placeholder="alias"
                />
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
                  Columns: {s.columns.filter(Boolean).slice(0, 8).join(", ")}
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
                  + 同檔另一 sheet
                </Button>
              )}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
