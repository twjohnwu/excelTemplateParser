/** One row of MappingsList: collapsed shows target ← source/cell/literal;
 * expanded shows the 3-way type toggle + condition chips + default editor.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConditionChip } from "@/components/ConditionChip";
import { cn } from "@/lib/utils";
import { cellAddressPattern, type Mapping } from "@/lib/schemas";

type Props = {
  mapping: Mapping;
  availableFields: string[];
  availableAliases: string[];
  onChange: (next: Mapping) => void;
  onRemove: () => void;
};

type Mode = "source" | "source_cell" | "literal";

// Priority: literal > source_cell > source. `null` (backend serialized None)
// behaves like `undefined`; empty string `""` for literal is still literal mode
// so that the toggle UI doesn't bounce back.
export const modeOf = (m: Mapping): Mode => {
  if (m.literal !== undefined && m.literal !== null) return "literal";
  if (m.source_cell !== undefined && m.source_cell !== null) return "source_cell";
  return "source";
};

export function MappingRow({ mapping, availableFields, availableAliases, onChange, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const Caret = open ? ChevronDown : ChevronRight;
  const mode = modeOf(mapping);

  const switchTo = (next: Mode) => {
    if (next === mode) return;
    if (next === "literal") {
      onChange({ ...mapping, source: undefined, source_cell: undefined, literal: "" });
    } else if (next === "source_cell") {
      onChange({
        ...mapping,
        source: undefined,
        literal: undefined,
        source_cell: { alias: availableAliases[0] ?? "", address: "" },
      });
    } else {
      onChange({ ...mapping, source_cell: undefined, literal: undefined, source: "" });
    }
  };

  const cell = mapping.source_cell ?? undefined;
  const addressValid = !cell?.address || cellAddressPattern.test(cell.address);

  return (
    <div className={cn("rounded-md border", open && "bg-blue-50/40 dark:bg-blue-950/20")}>
      <div className="flex items-center gap-2 px-2 py-1">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen((v) => !v)}>
          <Caret className="h-3 w-3" />
        </Button>
        <Input
          value={mapping.target}
          onChange={(e) => onChange({ ...mapping, target: e.target.value })}
          className="h-7 w-40 text-xs font-medium"
        />
        <span className="text-muted-foreground">←</span>

        {mode === "source" && (
          <Select
            value={mapping.source ?? ""}
            onChange={(e) => onChange({ ...mapping, source: e.target.value })}
            className="h-7 flex-1 text-xs"
          >
            <option value="">select source…</option>
            {availableFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        )}

        {mode === "source_cell" && (
          <div className="flex flex-1 items-center gap-1">
            <Select
              value={cell?.alias ?? ""}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  source_cell: { alias: e.target.value, address: cell?.address ?? "" },
                })
              }
              className="h-7 w-32 text-xs"
            >
              <option value="">alias…</option>
              {availableAliases.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            <span className="text-muted-foreground">!</span>
            <Input
              value={cell?.address ?? ""}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  source_cell: { alias: cell?.alias ?? "", address: e.target.value.toUpperCase() },
                })
              }
              placeholder="A3"
              title={addressValid ? undefined : "需為 Excel 位址，如 A3"}
              className={cn(
                "h-7 flex-1 text-xs bg-violet-50 dark:bg-violet-950/30",
                !addressValid && "border-destructive",
              )}
            />
          </div>
        )}

        {mode === "literal" && (
          <Input
            value={
              typeof mapping.literal === "string"
                ? mapping.literal
                : mapping.literal == null
                ? ""
                : JSON.stringify(mapping.literal)
            }
            onChange={(e) => onChange({ ...mapping, literal: e.target.value })}
            placeholder="固定值"
            className="h-7 flex-1 text-xs bg-amber-50 dark:bg-amber-950/30"
          />
        )}

        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRemove}>
          <X className="h-3 w-3" />
        </Button>
      </div>

      {open && (
        <div className="space-y-3 border-t px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium">類型</span>
            <div className="inline-flex overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => switchTo("source")}
                className={cn(
                  "px-2 py-0.5",
                  mode === "source" ? "bg-blue-500 text-white" : "bg-transparent",
                )}
              >
                來源欄位
              </button>
              <button
                type="button"
                onClick={() => switchTo("source_cell")}
                className={cn(
                  "px-2 py-0.5 border-l",
                  mode === "source_cell" ? "bg-violet-500 text-white" : "bg-transparent",
                )}
              >
                固定儲存格
              </button>
              <button
                type="button"
                onClick={() => switchTo("literal")}
                className={cn(
                  "px-2 py-0.5 border-l",
                  mode === "literal" ? "bg-amber-500 text-white" : "bg-transparent",
                )}
              >
                固定值
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 font-medium">Conditions</div>
            <div className="flex flex-wrap gap-2">
              {mapping.conditions.map((c, i) => (
                <ConditionChip
                  key={i}
                  condition={c}
                  availableFields={availableFields}
                  onChange={(next) =>
                    onChange({
                      ...mapping,
                      conditions: mapping.conditions.map((cc, j) => (j === i ? next : cc)),
                    })
                  }
                  onRemove={() =>
                    onChange({
                      ...mapping,
                      conditions: mapping.conditions.filter((_, j) => j !== i),
                    })
                  }
                />
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...mapping,
                    conditions: [
                      ...mapping.conditions,
                      { field: availableFields[0] ?? "", op: "==", value: "" },
                    ],
                  })
                }
              >
                <Plus className="mr-1 h-3 w-3" /> condition
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-medium">Default</span>
            <Input
              value={typeof mapping.default === "string" ? mapping.default : JSON.stringify(mapping.default)}
              onChange={(e) => onChange({ ...mapping, default: e.target.value })}
              className="h-7 w-40 text-xs"
            />
          </div>
        </div>
      )}
    </div>
  );
}
