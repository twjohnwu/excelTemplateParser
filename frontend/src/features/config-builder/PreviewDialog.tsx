/** Modal showing the server-computed preview (columns × rows) of the draft config. */

import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PreviewResult } from "@/lib/previewHelpers";
import type { CellValue } from "@/lib/schemas";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: PreviewResult | null;
};

function renderCell(cell: CellValue): string {
  if (cell === null || cell === undefined || cell === "") return "—";
  return String(cell);
}

export function PreviewDialog({ open, onOpenChange, data }: Props) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("config.preview.title")}</DialogTitle>
          <DialogDescription>
            {t("config.preview.rowCount", { n: data?.rows.length ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        {data && data.rows.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("config.preview.empty")}</p>
        )}
        {data && data.rows.length > 0 && (
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {data.columns.map((c, i) => (
                    <th key={`${c}-${i}`} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, ri) => (
                  <tr key={ri} className="border-t">
                    {row.map((cell, ci) => (
                      <td key={ci} className="whitespace-nowrap px-2 py-1">
                        {renderCell(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.truncated && (
          <p className="text-xs text-muted-foreground">{t("config.preview.truncated")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
