import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Initializes the i18next singleton (side effect) so useTranslation() inside
// SheetHeaderPicker has resources instead of throwing — same pattern as
// WizardPage.test.tsx.
import "@/i18n";
import { api } from "@/lib/api";
import { SheetHeaderPicker } from "./SheetHeaderPicker";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: { ...actual.api, postForm: vi.fn() },
  };
});

function xlsxFile(name: string) {
  return new File(["dummy"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// Fix 3: a mount whose `value.sheet` is already set (e.g. a restored draft
// re-pointed at a re-uploaded file) must still compute `columns` — the old
// `if (!value.sheet)` guard silently skipped onChange whenever value.sheet
// was non-empty, leaving `columns` empty forever for that source and
// dropping it from JoinsEditor's field list (JoinsEditor.tsx:30-32).
describe("SheetHeaderPicker", () => {
  it("computesColumnsOnMountEvenWhenValueSheetIsAlreadySet", async () => {
    vi.mocked(api.postForm).mockResolvedValue({
      sheets: [{ name: "Sheet1", preview_rows: [["SKU", "Name"], ["1", "a"]], preview_starts_at: 1 }],
    });
    const onChange = vi.fn();

    render(
      <SheetHeaderPicker
        file={xlsxFile("t.xlsx")}
        value={{ sheet: "Sheet1", header_row: 1 }}
        onChange={onChange}
      />,
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        sheet: "Sheet1",
        header_row: 1,
        columns: ["SKU", "Name"],
      }),
    );
  });

  it("fallsBackToFirstSheetWhenValueSheetIsNotInTheResponse", async () => {
    vi.mocked(api.postForm).mockResolvedValue({
      sheets: [{ name: "Sheet1", preview_rows: [["SKU", "Name"], ["1", "a"]], preview_starts_at: 1 }],
    });
    const onChange = vi.fn();

    render(
      <SheetHeaderPicker
        file={xlsxFile("t.xlsx")}
        value={{ sheet: "Missing", header_row: 1 }}
        onChange={onChange}
      />,
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        sheet: "Sheet1",
        header_row: 1,
        columns: ["SKU", "Name"],
      }),
    );
  });

  // Fix (verifier finding): a restored draft's header_row can point past the
  // freshly re-uploaded file's preview window (e.g. header_row: 31 picked
  // earlier via "Load 30 more", but the re-upload only returns 2 rows) —
  // `preview_rows[headerRow - preview_starts_at]` is then `undefined` and
  // `rowAsHeaders` silently returns `[]`. The mount effect must reset to
  // header_row 1 instead of surfacing an out-of-range index as empty columns.
  it("resetsToRowOneWhenRestoredHeaderRowIsOutsidePreviewWindow", async () => {
    vi.mocked(api.postForm).mockResolvedValue({
      sheets: [{ name: "Sheet1", preview_rows: [["SKU", "Name"], ["1", "a"]], preview_starts_at: 1 }],
    });
    const onChange = vi.fn();

    render(
      <SheetHeaderPicker
        file={xlsxFile("t.xlsx")}
        value={{ sheet: "Sheet1", header_row: 31 }}
        onChange={onChange}
      />,
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        sheet: "Sheet1",
        header_row: 1,
        columns: ["SKU", "Name"],
      }),
    );
  });

  it("resetsToRowOneWhenFallingBackToFirstSheetWithAnOutOfRangeHeaderRow", async () => {
    vi.mocked(api.postForm).mockResolvedValue({
      sheets: [{ name: "Sheet1", preview_rows: [["SKU", "Name"], ["1", "a"]], preview_starts_at: 1 }],
    });
    const onChange = vi.fn();

    render(
      <SheetHeaderPicker
        file={xlsxFile("t.xlsx")}
        value={{ sheet: "Missing", header_row: 5 }}
        onChange={onChange}
      />,
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        sheet: "Sheet1",
        header_row: 1,
        columns: ["SKU", "Name"],
      }),
    );
  });
});
