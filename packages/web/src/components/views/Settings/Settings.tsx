import { Await, Cell, Switch } from "retend";
import { useCurrentRoute } from "retend/router";

import { LoadingState } from "@/components/ui/LoadingState";
import { PendingPage } from "@/components/ui/PendingPage";
import { Workspaces } from "@/components/views/Workspaces/Workspaces";
import { getDesktopSettings } from "@/platform/desktopClient";
import type { DesktopSettingsResponse } from "@/platform/desktopClient";
import { usePageSwitch } from "@/utils/pageSwitch";

import { Account } from "./Account/Account";
import { BrowserSettings } from "./BrowserSettings";
import { General } from "./General/General";
import { Providers } from "./Providers";
import { SettingsEditor } from "./SettingsEditor";

function sectionKey(path: string) {
  return path === "/settings" ? "general" : path.slice("/settings/".length).split("/")[0];
}

const EDITOR_SECTIONS = new Set(["network", "privacy", "advanced"]);

/** Retain the selected settings page while the next section's data becomes ready. */
export function Settings() {
  const route = useCurrentRoute();
  // Fetch persisted settings once per Settings visit. A successful save updates the same snapshot.
  const latest = Cell.source<DesktopSettingsResponse | null>(null);
  const key = Cell.derived(() => sectionKey(route.get().path));
  const settings = Cell.derivedAsync(async () => {
    const response = await getDesktopSettings();
    latest.set(response);
    return response;
  });
  const { pageKey, switching } = usePageSwitch(key, async (get) => {
    if (EDITOR_SECTIONS.has(get(key))) {
      await get(settings);
      const error = get(settings.error);
      if (error !== null) throw error;
    }
  });
  const loadError = Cell.derived(() => pageKey.error.get()?.message ?? null);
  const retry = () => {
    settings.revalidate();
    pageKey.revalidate();
  };
  const editor = (kind: "network" | "privacy" | "advanced") => {
    const initial = latest.get();
    return initial === null ? (
      <LoadingState screen label="Loading settings…" error={loadError} onRetry={retry} />
    ) : (
      <SettingsEditor
        kind={kind}
        initial={initial}
        onUpdated={(response) => latest.set(response)}
      />
    );
  };

  return (
    <Await
      fallback={<LoadingState screen label="Loading settings…" error={loadError} onRetry={retry} />}
    >
      <PendingPage switching={switching}>
        {Switch(pageKey, {
          general: General,
          account: Account,
          providers: Providers,
          workspaces: Workspaces,
          browser: BrowserSettings,
          network: () => editor("network"),
          privacy: () => editor("privacy"),
          advanced: () => editor("advanced"),
        })}
      </PendingPage>
    </Await>
  );
}
