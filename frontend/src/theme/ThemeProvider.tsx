/** Theme provider: light/dark via data-theme attribute, persisted to localStorage.
 * Initial value: localStorage > prefers-color-scheme > "light".
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";
const KEY = "etp.theme";

type Ctx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };
const ThemeContext = createContext<Ctx | null>(null);

function detect(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializer runs once during first render, so we never momentarily
  // commit "light" before honoring prefers-color-scheme — and we never write
  // an unintended "light" to localStorage before detect() reads it back.
  const [theme, setThemeState] = useState<Theme>(() => detect());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    // localStorage only carries an explicit user choice. Without an entry,
    // detect() falls through to prefers-color-scheme on the next visit.
    localStorage.setItem(KEY, next);
  };

  const value = useMemo<Ctx>(
    () => ({ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }),
    [theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
