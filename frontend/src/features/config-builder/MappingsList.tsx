/** Right pane: list of mappings (inline-expandable rows). */

import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { MappingRow } from "./MappingRow";
import type { Mapping } from "@/lib/schemas";
import type { SourceEntry } from "./SourcesTree";

type Props = {
  mappings: Mapping[];
  sources: SourceEntry[];
  onChange: (next: Mapping[]) => void;
};

export function MappingsList({ mappings, sources, onChange }: Props) {
  const { t } = useTranslation();

  const availableFields = sources.flatMap((s) =>
    s.columns.filter(Boolean).map((c) => `${s.alias}.${c}`)
  );
  const availableAliases = sources.map((s) => s.alias);

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
    <div className="space-y-2 overflow-auto rounded-lg border p-4">
      <h3 className="text-sm font-semibold">{t("config.mappingsPane")}</h3>
      <div className="space-y-2">
        {mappings.map((m, i) => (
          <MappingRow
            key={i}
            mapping={m}
            availableFields={availableFields}
            availableAliases={availableAliases}
            onChange={(next) => update(i, next)}
            onRemove={() => remove(i)}
          />
        ))}
      </div>
      <Button size="sm" variant="outline" className="w-full" onClick={add}>
        <Plus className="mr-1 h-3 w-3" /> {t("config.addMapping")}
      </Button>
    </div>
  );
}
