/** RED-phase contract tests for the two wizard entry points
 * (STDD/create-project-wizard/design-ux.md's User flows section + its
 * 「入口 affordance（REQ-09）」 subsection): a top-nav tab and the onboarding
 * card's primary CTA must both lead to `/wizard`; the card's
 * secondary action must keep the user in the three-pane workbench at
 * `/configs`; and the existing `/configs/new` creation entry must keep
 * working unmodified. No implementation exists yet for the nav tab or the
 * secondary action, and the onboarding CTA currently only dismisses the
 * card in place (`ConfigBuilder.tsx:469-477`) rather than navigating.
 *
 * `/wizard` is also the app's root: `/` and the legacy `/configs/wizard`
 * path both redirect to it (App.tsx's route table).
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Initializes the i18next singleton (side effect) so useTranslation() inside
// the mounted App has resources instead of throwing — same pattern as
// WizardPage.test.tsx / ConfigBuilder.characterization.test.ts.
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { DRAFT_KEY } from "@/lib/configForm";

import { App } from "@/App";

// App mounts ConfigBuilder/WizardPage, both of which fetch the config list
// on mount via @/lib/api — stub the transport so no case depends on a real
// backend, mirroring WizardPage.test.tsx's mocking pattern.
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockResolvedValue({ configs: [] }),
      post: vi.fn(),
      postForm: vi.fn(),
    },
  };
});

/** Renders the pathname of the active route into a testid so tests can
 * assert on client-side navigation without reaching into router internals. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function renderApp(initialPath: string) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <LocationProbe />
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function currentPath() {
  return screen.getByTestId("location-probe").textContent;
}

// jsdom's detected navigator.language is not guaranteed to be zh-TW, and the
// scenarios below assert zh-TW UI copy — pin the shared i18n singleton per
// test and restore it afterward. Same precedent as WizardPage.test.tsx:187-196.
let previousLanguage: string;

beforeEach(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage("zh-TW");
  localStorage.removeItem(DRAFT_KEY);
  vi.clearAllMocks();
});

afterEach(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe("App wizard entry points (REQ-09)", () => {
  it("topNavTabNavigatesToWizard", async () => {
    renderApp("/configs");

    const tab = screen.getByText(i18n.t("app.wizard"));
    fireEvent.click(tab);

    await waitFor(() => expect(currentPath()).toBe("/wizard"));
    // Wizard content renders: WizardPage's own prev/next navigation labels,
    // never used by ConfigBuilder (WizardPage.tsx:366-371).
    expect(screen.getByText(i18n.t("wizard.nav.next"))).toBeVisible();
  });

  it("onboardingPrimaryCtaNavigatesToWizard", async () => {
    renderApp("/configs");

    // Pristine state, no stored draft, no ?config= — onboarding card shows
    // (ConfigBuilder.tsx:162-170, :450).
    const cta = await screen.findByText(i18n.t("config.onboarding.cta"));
    fireEvent.click(cta);

    await waitFor(() => expect(currentPath()).toBe("/wizard"));
  });

  it("onboardingSecondaryStaysInWorkbench", async () => {
    renderApp("/configs");

    const secondary = await screen.findByText(i18n.t("config.onboarding.stayHere"));
    fireEvent.click(secondary);

    // URL unchanged, card dismissed, three-pane workbench shown — today's
    // behaviour at ConfigBuilder.tsx:469-477 demoted from primary to
    // secondary, must not be lost.
    expect(currentPath()).toBe("/configs");
    await waitFor(() =>
      expect(screen.queryByText(i18n.t("config.onboarding.title"))).not.toBeInTheDocument(),
    );
    expect(document.getElementById("pane-sources")).toBeInTheDocument();
  });

  it("navTabActiveStateIsExclusive", async () => {
    // react-router-dom v6's default NavLink `isActive` matches descendant
    // paths too, so without `end` both "/configs" and "/wizard"
    // tabs render active simultaneously at "/wizard" (TopMenuBar.tsx
    // NavTab, previously no `end` prop) — assert exactly one tab is active
    // on each of the three top-level routes, not just the wizard route.
    // Each block also asserts `aria-current`, which react-router-dom's own
    // NavLink computes independently of the visual `className` (see
    // TopMenuBar.tsx's NavTab doc comment) — exactly one tab may carry
    // aria-current="page" per route, and it must be the same tab that
    // carries the visual `text-foreground` class.
    const first = renderApp("/wizard");
    await waitFor(() => expect(currentPath()).toBe("/wizard"));
    expect(screen.getByText(i18n.t("app.wizard")).className).toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.configBuilder")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.batchRunner")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.wizard")).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(i18n.t("app.configBuilder")).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(i18n.t("app.batchRunner")).getAttribute("aria-current")).toBeNull();
    first.unmount();

    const second = renderApp("/configs");
    await waitFor(() => expect(currentPath()).toBe("/configs"));
    expect(screen.getByText(i18n.t("app.configBuilder")).className).toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.wizard")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.batchRunner")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.configBuilder")).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(i18n.t("app.wizard")).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(i18n.t("app.batchRunner")).getAttribute("aria-current")).toBeNull();
    second.unmount();

    const third = renderApp("/batch");
    await waitFor(() => expect(currentPath()).toBe("/batch"));
    expect(screen.getByText(i18n.t("app.batchRunner")).className).toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.configBuilder")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.wizard")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.batchRunner")).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(i18n.t("app.configBuilder")).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(i18n.t("app.wizard")).getAttribute("aria-current")).toBeNull();
    third.unmount();

    // "/configs/new" (App.tsx:44) renders ConfigBuilder like "/configs" but
    // has no tab of its own — it must prefix-match onto 「專案設定」, not
    // light up nothing (the over-correction this test guards against) and
    // not light up 「建立精靈」.
    const fourth = renderApp("/configs/new");
    await waitFor(() => expect(currentPath()).toBe("/configs/new"));
    expect(screen.getByText(i18n.t("app.configBuilder")).className).toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.wizard")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.batchRunner")).className).not.toContain("text-foreground");
    expect(screen.getByText(i18n.t("app.configBuilder")).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(i18n.t("app.wizard")).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(i18n.t("app.batchRunner")).getAttribute("aria-current")).toBeNull();
  });

  it("configsNewStillRendersWorkbench", () => {
    renderApp("/configs/new");

    // No redirect away from /configs/new (REQ-09, spec.md's rejected
    // options explicitly declined replacing this entry).
    expect(currentPath()).toBe("/configs/new");
    // ConfigBuilder renders: its toolbar is present unconditionally, even
    // while the onboarding card also shows for a pristine mount
    // (ConfigBuilder.tsx:386, rendered before the onboarding conditional at
    // ConfigBuilder.tsx:450).
    expect(document.getElementById("cfg-toolbar")).toBeInTheDocument();
  });

  it("rootRedirectsToWizard", async () => {
    renderApp("/");

    await waitFor(() => expect(currentPath()).toBe("/wizard"));
    expect(screen.getByText(i18n.t("wizard.nav.next"))).toBeVisible();
  });

  it("legacyWizardPathRedirects", async () => {
    renderApp("/configs/wizard");

    await waitFor(() => expect(currentPath()).toBe("/wizard"));
  });
});
