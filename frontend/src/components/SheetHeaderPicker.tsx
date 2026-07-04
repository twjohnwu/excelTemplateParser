/** SheetHeaderPicker: upload xlsx → choose sheet → click row to set as header.
 * Preview shows 30 rows by default; "Load 30 more" extends the window.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type SheetPreview = {
  name: string;
  preview_rows: unknown[][];
  preview_starts_at: number;
};

type Props = {
  file: File;
  value: { sheet: string; header_row: number };
  onChange: (v: { sheet: string; header_row: number; columns: string[] }) => void;
};

export function SheetHeaderPicker({ file, value, onChange }: Props) {
  const { t } = useTranslation();
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load initial 30 rows on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const form = new FormData();
    form.append("file", file);
    api
      .postForm<{ sheets: SheetPreview[] }>("/api/templates/parse", form)
      .then((res) => {
        if (cancelled) return;
        setSheets(res.sheets);
        if (!value.sheet && res.sheets.length > 0) {
          const first = res.sheets[0];
          onChange({
            sheet: first.name,
            header_row: value.header_row || 1,
            columns: rowAsHeaders(first.preview_rows[(value.header_row || 1) - 1]),
          });
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const loadMore = async () => {
    if (!value.sheet) return;
    const sheet = sheets.find((s) => s.name === value.sheet);
    if (!sheet) return;
    setLoading(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await api.postForm<{ sheets: SheetPreview[] }>(
        `/api/templates/parse?from_row=${sheet.preview_starts_at + sheet.preview_rows.length}`,
        form
      );
      const more = res.sheets.find((s) => s.name === value.sheet);
      if (more) {
        setSheets((all) =>
          all.map((s) =>
            s.name === value.sheet
              ? { ...s, preview_rows: [...s.preview_rows, ...more.preview_rows] }
              : s
          )
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const sheet = sheets.find((s) => s.name === value.sheet) ?? sheets[0];
  if (loading && sheets.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("config.loadingPreview")}</p>;
  }
  if (error) {
    return <p className="text-xs text-destructive">{error}</p>;
  }
  if (!sheet) return null;

  const headerRowIndex = value.header_row - sheet.preview_starts_at;
  const columnsForHeader = (rowIdx0: number) => rowAsHeaders(sheet.preview_rows[rowIdx0]);

  return (
    <div className="space-y-2">
      {sheets.length > 1 && (
        <Select
          value={value.sheet}
          onChange={(e) => {
            const nextSheet = sheets.find((s) => s.name === e.target.value)!;
            onChange({
              sheet: nextSheet.name,
              header_row: 1,
              columns: rowAsHeaders(nextSheet.preview_rows[0]),
            });
          }}
        >
          {sheets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </Select>
      )}

      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
        {value.header_row > 0 && headerRowIndex >= 0 && headerRowIndex < sheet.preview_rows.length ? (
          <span className="font-medium">
            {t("config.headerRowConfirmed", { row: value.header_row })}
          </span>
        ) : (
          t("config.headerRowBanner")
        )}
      </div>

      <div className="max-h-64 overflow-auto rounded-md border text-xs">
        <table className="w-full">
          <tbody>
            {sheet.preview_rows.map((row, i) => {
              const rowNumber = sheet.preview_starts_at + i;
              const isHeader = i === headerRowIndex;
              return (
                <tr
                  key={i}
                  onClick={() =>
                    onChange({
                      sheet: sheet.name,
                      header_row: rowNumber,
                      columns: columnsForHeader(i),
                    })
                  }
                  className={cn(
                    "cursor-pointer hover:bg-accent/50",
                    isHeader &&
                      "bg-blue-100 font-semibold text-blue-900 dark:bg-blue-900/40 dark:text-blue-100"
                  )}
                >
                  <td className="border-r bg-muted px-2 py-1 text-muted-foreground select-none">
                    {rowNumber}
                  </td>
                  {row.map((cell, j) => (
                    <td key={j} className="border-b px-2 py-1">
                      {cell == null ? "" : String(cell)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("config.headerRowHint")}</p>
        <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
          {t("config.loadMoreRows")}
        </Button>
      </div>
    </div>
  );
}

function rowAsHeaders(row: unknown[] | undefined): string[] {
  if (!row) return [];
  return row.map((c) => (c == null ? "" : String(c)));
}
