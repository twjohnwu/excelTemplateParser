import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme } from "./ThemeProvider";

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <button onClick={toggle}>toggle</button>
    </>
  );
}

const setPrefersDark = (matches: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: matches && q.includes("dark"),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  localStorage.clear();
});

describe("ThemeProvider", () => {
  it("honors prefers-color-scheme: dark on first visit (no localStorage)", () => {
    setPrefersDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    // localStorage MUST stay empty so future visits keep tracking system prefs
    expect(localStorage.getItem("etp.theme")).toBeNull();
  });

  it("defaults to light when prefers-color-scheme is light", () => {
    setPrefersDark(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(localStorage.getItem("etp.theme")).toBeNull();
  });

  it("respects explicit stored value over system pref", () => {
    setPrefersDark(true);
    localStorage.setItem("etp.theme", "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("theme").textContent).toBe("light");
  });

  it("toggle writes to localStorage", () => {
    setPrefersDark(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    act(() => {
      screen.getByText("toggle").click();
    });
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(localStorage.getItem("etp.theme")).toBe("dark");
  });
});
