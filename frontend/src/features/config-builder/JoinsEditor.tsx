/** Middle pane: list of join rules (card per rule). */

import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { columnRefMissing, type ColumnCheckSource } from "@/lib/configHelpers";
import type { JoinRule } from "@/lib/schemas";
import type { SourceEntry } from "./SourcesTree";

type Props = {
  sources: SourceEntry[];
  joins: JoinRule[];
  onChange: (next: JoinRule[]) => void;
  /** DOM id so the checklist rail can scroll this pane into view. */
  id?: string;
  /** Live-validation issue count shown as a badge in the pane header. */
  errorCount?: number;
  /** Schema-level issues per join index (from bucketIssues). */
  joinsByIndex?: Map<number, z.ZodIssue[]>;
};

export function JoinsEditor({ sources, joins, onChange, id, errorCount = 0, joinsByIndex }: Props) {
  const { t } = useTranslation();
  const newJoinRef = useRef<HTMLDivElement | null>(null);

  const allFields = sources.flatMap((s) =>
    s.columns.filter(Boolean).map((c) => `${s.alias}.${c}`)
  );

  const checkSources: ColumnCheckSource[] = sources.map((s) => ({
    alias: s.alias,
    columns: s.columns.filter(Boolean),
    hasUpload: s.file != null,
  }));
  const warnFor = (ref: string): string | null =>
    columnRefMissing(ref, checkSources)
      ? t("err.columnNotInSource", { alias: ref.split(".", 1)[0] })
      : null;

  const update = (idx: number, patch: Partial<JoinRule>) => {
    onChange(joins.map((j, i) => (i === idx ? { ...j, ...patch } : j)));
  };
  const remove = (idx: number) => onChange(joins.filter((_, i) => i !== idx));
  const add = () => {
    onChange([
      ...joins,
      { left: allFields[0] ?? "", right: allFields[1] ?? "", type: "left" },
    ]);
    requestAnimationFrame(() => {
      newJoinRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  return (
    <div id={id} className="flex flex-col rounded-lg border">
      <div className="p-4 space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {t("config.joinsPane")}
          {errorCount > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {errorCount}
            </span>
          )}
        </h3>
        {joins.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("config.noJoins")}</p>
        )}
        {joins.map((j, i) => (
          <div
            key={i}
            className="space-y-1 rounded-md border bg-card p-2 text-xs"
            ref={i === joins.length - 1 ? newJoinRef : undefined}
          >
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("config.joinNumber", { n: i + 1 })}</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => remove(i)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
            <Select
              value={j.left}
              onChange={(e) => update(i, { left: e.target.value })}
              className="h-8"
            >
              <option value="">{t("config.joinLeft")}</option>
              {allFields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
            {warnFor(j.left) && <p className="text-xs text-destructive">{warnFor(j.left)}</p>}
            <div className="text-center text-muted-foreground">=</div>
            <Select
              value={j.right}
              onChange={(e) => update(i, { right: e.target.value })}
              className="h-8"
            >
              <option value="">{t("config.joinRight")}</option>
              {allFields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
            {warnFor(j.right) && <p className="text-xs text-destructive">{warnFor(j.right)}</p>}
            <Select
              value={j.type}
              onChange={(e) => update(i, { type: e.target.value as JoinRule["type"] })}
              className="h-8"
            >
              <option value="left">left</option>
              <option value="inner">inner</option>
            </Select>
            {(joinsByIndex?.get(i) ?? []).map((issue, k) => {
              const params = (issue as z.ZodIssue & { params?: Record<string, unknown> }).params ?? {};
              return (
                <p key={k} className="text-xs text-destructive">
                  {t(issue.message, params)}
                </p>
              );
            })}
          </div>
        ))}
        {allFields.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("joins.hint.no_columns")}</p>
        )}

        <div className="border-t pt-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={add}
            disabled={allFields.length === 0}
          >
            <Plus className="mr-1 h-3 w-3" /> {t("config.addJoin")}
          </Button>
        </div>
      </div>
    </div>
  );
}
