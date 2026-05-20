/** Middle pane: list of join rules (card per rule). */

import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { JoinRule } from "@/lib/schemas";
import type { SourceEntry } from "./SourcesTree";

type Props = {
  sources: SourceEntry[];
  joins: JoinRule[];
  onChange: (next: JoinRule[]) => void;
};

export function JoinsEditor({ sources, joins, onChange }: Props) {
  const { t } = useTranslation();

  const allFields = sources.flatMap((s) =>
    s.columns.filter(Boolean).map((c) => `${s.alias}.${c}`)
  );

  const update = (idx: number, patch: Partial<JoinRule>) => {
    onChange(joins.map((j, i) => (i === idx ? { ...j, ...patch } : j)));
  };
  const remove = (idx: number) => onChange(joins.filter((_, i) => i !== idx));
  const add = () =>
    onChange([
      ...joins,
      { left: allFields[0] ?? "", right: allFields[1] ?? "", type: "left" },
    ]);

  return (
    <div className="space-y-2 overflow-auto rounded-lg border p-4">
      <h3 className="text-sm font-semibold">{t("config.joinsPane")}</h3>
      {joins.length === 0 && (
        <p className="text-xs text-muted-foreground">No joins yet.</p>
      )}
      {joins.map((j, i) => (
        <div key={i} className="space-y-1 rounded-md border bg-card p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Join #{i + 1}</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => remove(i)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          <Select
            value={j.left}
            onChange={(e) => update(i, { left: e.target.value })}
            className="h-8"
          >
            <option value="">left side…</option>
            {allFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
          <div className="text-center text-muted-foreground">=</div>
          <Select
            value={j.right}
            onChange={(e) => update(i, { right: e.target.value })}
            className="h-8"
          >
            <option value="">right side…</option>
            {allFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
          <Select
            value={j.type}
            onChange={(e) => update(i, { type: e.target.value as JoinRule["type"] })}
            className="h-8"
          >
            <option value="left">left</option>
            <option value="inner">inner</option>
          </Select>
        </div>
      ))}
      <Button size="sm" variant="outline" className="w-full" onClick={add}>
        <Plus className="mr-1 h-3 w-3" /> {t("config.addJoin")}
      </Button>
    </div>
  );
}
