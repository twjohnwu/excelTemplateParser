import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileDropzone } from "./FileDropzone";

function xlsxFile(name: string) {
  return new File(["dummy"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// REQ-10 / S-18: the visible root produced by getRootProps() (tabIndex: 0)
// must carry a keyboard focus-visible ring style. The hidden <input> from
// getInputProps() has tabIndex: -1 (react-dropzone) and can never receive
// Tab focus, so it is not a valid target for this assertion.
describe("FileDropzone", () => {
  it("appliesFocusVisibleRingToRootOnTabFocus", () => {
    const { container } = render(<FileDropzone files={[]} onChange={() => {}} />);

    // The root is the div carrying tabIndex: 0 from getRootProps() —
    // selected by that attribute, not by role (react-dropzone assigns no
    // default role) and not the hidden input (tabIndex: -1).
    const root = container.querySelector('div[tabindex="0"]');

    expect(root).not.toBeNull();
    expect(root?.className).toMatch(/focus-visible/);
    expect(root?.className).toMatch(/ring/);
  });

  // The root <div {...getRootProps()}> is plain DOM, not form-associated,
  // so a surrounding `<fieldset disabled>` (save-in-flight lock) doesn't
  // reach it — the component's own `disabled` prop must.
  it("suppressesFileSelectionWhenDisabledAcceptsWhenEnabled", async () => {
    const onChange = vi.fn();
    const file = xlsxFile("a.xlsx");

    const { container, rerender } = render(
      <FileDropzone files={[]} onChange={onChange} disabled />
    );
    const disabledRoot = container.querySelector('div[tabindex="0"]');
    // react-dropzone omits tabIndex entirely while disabled (verified
    // against node_modules/react-dropzone/dist/es/index.js:940-942).
    expect(disabledRoot).toBeNull();

    const disabledInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(disabledInput, { target: { files: [file] } });
    // react-dropzone resolves the file list asynchronously (file-selector's
    // fromEvent returns a Promise) even when disabled short-circuits the
    // handler — give any pending microtask a turn before asserting the
    // negative, per S-18's own async-parse waitFor pattern.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();

    rerender(<FileDropzone files={[]} onChange={onChange} disabled={false} />);
    const enabledInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(enabledInput, { target: { files: [file] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([file]));
  });
});
