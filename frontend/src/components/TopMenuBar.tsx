/** TopMenuBar: tabs + active-jobs badge dropdown + language + theme toggle. */

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Languages, Moon, Sun, Bell } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { JobsPanel } from "@/components/JobsPanel";
import { useTheme } from "@/theme/ThemeProvider";
import { api } from "@/lib/api";
import { listRecent, type RecentJob } from "@/lib/recentJobs";
import { cn } from "@/lib/utils";
import type { JobSnapshot } from "@/lib/schemas";

export function TopMenuBar() {
  const { t, i18n } = useTranslation();
  const { theme, toggle } = useTheme();
  const [recents, setRecents] = useState<RecentJob[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, JobSnapshot | undefined>>({});

  const refresh = () => setRecents(listRecent());

  useEffect(() => {
    refresh();
    // Refresh on storage events (e.g., another tab adds a job).
    const onStorage = () => refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (recents.length === 0) {
      setSnapshots({});
      return;
    }
    let alive = true;
    const ids = recents.map((j) => j.id).join(",");
    api
      .get<{ snapshots: Array<Record<string, unknown>> }>(`/api/jobs?ids=${ids}`)
      .then((res) => {
        if (!alive) return;
        const map: Record<string, JobSnapshot> = {};
        for (const s of res.snapshots) {
          if (s.status !== "missing" && typeof s.job_id === "string") {
            map[s.job_id] = s as unknown as JobSnapshot;
          }
        }
        setSnapshots(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [recents]);

  const activeCount = recents.filter((j) => {
    const s = snapshots[j.id];
    return !s || (s.status !== "done" && s.status !== "failed" && s.status !== "cancelled");
  }).length;

  const switchLang = () => i18n.changeLanguage(i18n.language.startsWith("zh") ? "en" : "zh-TW");

  return (
    <header className="sticky top-0 z-30 border-b bg-background">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center px-4">
        <h1 className="mr-6 text-sm font-semibold">{t("app.title")}</h1>
        <nav className="flex items-center gap-1">
          <NavTab to="/wizard" activeOn={["/wizard"]}>
            {t("app.wizard")}
          </NavTab>
          {/* Exact paths from App.tsx's route table (App.tsx:41-47): "/configs"
              and "/configs/new" both render ConfigBuilder and share this tab;
              "/wizard" is its own route and must NOT match here. */}
          <NavTab to="/configs" activeOn={["/configs", "/configs/new"]}>
            {t("app.configBuilder")}
          </NavTab>
          <NavTab to="/batch" activeOn={["/batch"]}>
            {t("app.batchRunner")}
          </NavTab>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="relative">
                <Bell className="h-4 w-4" />
                {activeCount > 0 && (
                  <span className="absolute -right-1 -top-1 rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {activeCount}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <JobsPanel recents={recents} snapshots={snapshots} onChange={refresh} />
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="ghost" size="sm" onClick={switchLang} aria-label={t("app.language")}>
            <Languages className="mr-1 h-4 w-4" />
            <span className="text-xs">{t("app.langLabel")}</span>
          </Button>

          <Button variant="ghost" size="icon" onClick={toggle} aria-label="theme">
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * `activeOn` lists the exact pathnames (from App.tsx's route table) this tab
 * should light up on. This replaces `NavLink`'s built-in `end`/prefix
 * matching, which cannot express "/configs and /configs/new, but not
 * /wizard" — a reader can check `activeOn` against the route table
 * directly instead of reasoning about react-router's matching semantics.
 *
 * Renders a plain `Link` (not `NavLink`) so `isActive` from `activeOn` is
 * the SINGLE source for both the visual class and `aria-current`.
 * `NavLink` computes its own `isActive` internally via prefix matching and
 * always uses it for `aria-current`, regardless of what `className` does —
 * an `aria-current` prop passed to `NavLink` is captured as the string to
 * use *when active*, not a way to force presence/absence, so `NavLink`
 * cannot be made to agree with `activeOn` here; `Link` has no built-in
 * matching to disagree with.
 */
function NavTab({
  to,
  activeOn,
  children,
}: {
  to: string;
  activeOn: string[];
  children: React.ReactNode;
}) {
  const { pathname } = useLocation();
  const isActive = activeOn.includes(pathname);
  return (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {children}
    </Link>
  );
}
