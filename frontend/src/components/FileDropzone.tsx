import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  multiple?: boolean;
  files: File[];
  onChange: (files: File[]) => void;
  hint?: string;
  accent?: "primary" | "lookup" | "target";
  /** Suppresses drop/click/keyboard activation on the root (a plain div,
   * not a form-associated element, so a surrounding `<fieldset disabled>`
   * doesn't reach it — see the save-in-flight lock at WizardPage.tsx). */
  disabled?: boolean;
};

const ACCENT_CLASS: Record<NonNullable<Props["accent"]>, string> = {
  primary: "border-blue-300 hover:bg-blue-50/50",
  lookup: "border-gray-300 hover:bg-gray-50/50",
  target: "border-emerald-300 hover:bg-emerald-50/50",
};

export function FileDropzone({
  multiple = false,
  files,
  onChange,
  hint,
  accent = "primary",
  disabled = false,
}: Props) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      onChange(multiple ? [...files, ...accepted] : accepted.slice(0, 1));
    },
    [files, multiple, onChange]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple,
    disabled,
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
  });

  const remove = (idx: number) => onChange(files.filter((_, i) => i !== idx));

  return (
    <div className="space-y-2">
      <div
        {...getRootProps()}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          ACCENT_CLASS[accent],
          isDragActive && "bg-accent/50"
        )}
      >
        <input {...getInputProps()} />
        <Upload className="mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{hint ?? "Drop xlsx files or click"}</p>
      </div>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-md bg-secondary/40 px-2 py-1 text-sm">
              <span className="truncate">{f.name}</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => remove(i)}>
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
