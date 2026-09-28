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
  /** Suppresses row-click header selection. The rows are plain `<tr>`
   * elements, not form-associated, so a surrounding `<fieldset disabled>`
   * doesn't reach them — see the save-in-flight lock at WizardPage.tsx. */
  disabled?: boolean;
};

export function SheetHeaderPicker({ file, value, onChange, disabled = false }: Props) {
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
        // Always (re)compute columns on mount, even when value.sheet is
        // already set (e.g. a restored draft re-pointed at a re-uploaded
        // file) — otherwise `columns` stays empty forever for that source,
        // dropping it from JoinsEditor's field list (JoinsEditor.tsx:30-32).
        // Fall back to the first sheet when value.sheet isn't in the
        // response (e.g. it named a sheet from a different file).
        const matched = res.sheets.find((s) => s.name === value.sheet);
        const picked = matched ?? res.sheets[0];
        if (picked) {
          let headerRow = value.header_row || 1;
          let idx = headerRow - picked.preview_starts_at;
          // A restored draft's header_row can point past this file's
          // preview window (e.g. row 31 picked earlier via "Load 30 more",
          // but the re-uploaded file's fresh preview only covers rows
          // 1-30) — or the sheet itself didn't match and we fell back to
          // the first sheet. Either way the old header_row is meaningless
          // for this data, so reset to row 1 instead of indexing out of
          // bounds into `[]`.
          if (!matched || idx < 0 || idx >= picked.preview_rows.length) {
            headerRow = 1;
            idx = 0;
          }
          onChange({
            sheet: picked.name,
            header_row: headerRow,
            columns: rowAsHeaders(picked.preview_rows[idx]),
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
                  onClick={
                    disabled
                      ? undefined
                      : () =>
                          onChange({
                            sheet: sheet.name,
                            header_row: rowNumber,
                            columns: columnsForHeader(i),
                          })
                  }
                  className={cn(
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/50",
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
