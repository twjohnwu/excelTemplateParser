/** Right pane: list of mappings (inline-expandable rows). */

import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { MappingRow } from "./MappingRow";
import { columnRefMissing, type ColumnCheckSource } from "@/lib/configHelpers";
import type { Mapping } from "@/lib/schemas";
import type { SourceEntry } from "./SourcesTree";

type Props = {
  mappings: Mapping[];
  sources: SourceEntry[];
  /** Columns from the uploaded target template. Rows whose target is one of
   * these are treated as template-derived and get a read-only target chip.
   * Empty when no template uploaded yet → everything stays editable. */
  targetColumns: string[];
  onChange: (next: Mapping[]) => void;
  /** DOM id so the checklist rail can scroll this pane into view. */
  id?: string;
  /** Live-validation issue count shown as a badge in the pane header. */
  errorCount?: number;
  /** Schema-level issues per mapping index (from bucketIssues). */
  mappingsByIndex?: Map<number, z.ZodIssue[]>;
};

export function MappingsList({ mappings, sources, targetColumns, onChange, id, errorCount = 0, mappingsByIndex }: Props) {
  const { t } = useTranslation();

  const availableFields = sources.flatMap((s) =>
    s.columns.filter(Boolean).map((c) => `${s.alias}.${c}`)
  );
  const availableAliases = sources.map((s) => s.alias);

  const templateTargets = new Set(targetColumns.filter(Boolean));
  const checkSources: ColumnCheckSource[] = sources.map((s) => ({
    alias: s.alias,
    columns: s.columns.filter(Boolean),
    hasUpload: s.file != null,
  }));

  const update = (idx: number, next: Mapping) =>
    onChange(mappings.map((m, i) => (i === idx ? next : m)));
  const remove = (idx: number) =>
    onChange(mappings.filter((_, i) => i !== idx));
  const add = () =>
    onChange([
      ...mappings,
      { target: "", source: availableFields[0] ?? "", conditions: [], default: "" },
    ]);

  return (
    <div id={id} className="flex flex-col rounded-lg border">
      <div className="p-4 space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {t("config.mappingsPane")}
          {errorCount > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {errorCount}
            </span>
          )}
        </h3>
        <div className="space-y-2">
          {mappings.map((m, i) => {
            const rowIssues = mappingsByIndex?.get(i) ?? [];
            const schemaErrors = rowIssues.map((issue) => {
              const params = (issue as z.ZodIssue & { params?: Record<string, unknown> }).params ?? {};
              return t(issue.message, params);
            });
            return (
              <MappingRow
                key={i}
                mapping={m}
                availableFields={availableFields}
                availableAliases={availableAliases}
                readOnlyTarget={m.target !== "" && templateTargets.has(m.target)}
                columnWarning={
                  columnRefMissing(m.source, checkSources)
                    ? t("err.columnNotInSource", { alias: m.source!.split(".", 1)[0] })
                    : undefined
                }
                schemaErrors={schemaErrors.length > 0 ? schemaErrors : undefined}
                onChange={(next) => update(i, next)}
                onRemove={() => remove(i)}
              />
            );
          })}
        </div>

        <div className="border-t pt-2">
          <Button size="sm" variant="outline" className="w-full" onClick={add}>
            <Plus className="mr-1 h-3 w-3" /> {t("config.addMapping")}
          </Button>
        </div>
      </div>
    </div>
  );
}
