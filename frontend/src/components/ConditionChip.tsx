/** 3-chip condition editor: field / op / value with color-coded backgrounds. */

import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { type Condition, type Operator, operatorSchema } from "@/lib/schemas";

type Props = {
  condition: Condition;
  availableFields: string[]; // qualified alias.col list
  onChange: (next: Condition) => void;
  onRemove: () => void;
};

export function ConditionChip({ condition, availableFields, onChange, onRemove }: Props) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md bg-secondary/40 px-2 py-1 text-xs">
      <Select
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
        className="h-7 w-40 bg-yellow-100 px-2 py-0 text-xs dark:bg-yellow-900/40"
      >
        {availableFields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </Select>
      <Select
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value as Operator })}
        className="h-7 w-24 bg-gray-200 px-2 py-0 text-xs dark:bg-gray-700"
      >
        {operatorSchema.options.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </Select>
      <Input
        value={typeof condition.value === "string" ? condition.value : JSON.stringify(condition.value)}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
        className="h-7 w-32 bg-blue-100 px-2 py-0 text-xs dark:bg-blue-900/40"
      />
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRemove}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
