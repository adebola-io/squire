import { Cell, If } from "retend";

import { MainContent } from "@/components/MainContent/MainContent";
import { Onboarding } from "@/components/Onboarding/Onboarding";
import { ImageZoomProvider } from "@/components/ui/ImageZoom/ImageZoom";
import { Sidebar } from "@/components/ui/Sidebar/Sidebar";
import { SidebarToggle } from "@/components/ui/Sidebar/SidebarToggle";
import { getOnboardingStatus } from "@/platform/desktopClient";
import { AccountProvider } from "@/scopes/AccountScope";
import { BrowserSettingsProvider } from "@/scopes/BrowserSettingsScope";
import { ChatProvider } from "@/scopes/ChatScope";
import { ColorSchemeProvider } from "@/scopes/ColorSchemeScope";
import { LayoutProvider } from "@/scopes/LayoutScope";

import classes from "./App.module.css";

/** Shared route layout and account/chat providers for the sidebar and main view. */
export function Shell() {
  // Nothing renders until Squire says whether onboarding is pending, so the app never paints
  // and then disappears under the welcome screen. A failed check shows the app.
  const onboarding = Cell.derivedAsync(async () => {
    try {
      return (await getOnboardingStatus()).pending;
    } catch {
      return false;
    }
  });
  const known = Cell.derivedAsync(async (get) => {
    await get(onboarding);
    return true;
  });
  return (
    <ColorSchemeProvider>
      <LayoutProvider>
        <AccountProvider>
          <BrowserSettingsProvider>
            <ChatProvider>
              <ImageZoomProvider>
                {If(known, () => (
                  <>
                    <div class={classes.app}>
                      <Sidebar />
                      <SidebarToggle />
                      <MainContent />
                    </div>
                    {If(onboarding, () => (
                      <Onboarding />
                    ))}
                  </>
                ))}
              </ImageZoomProvider>
            </ChatProvider>
          </BrowserSettingsProvider>
        </AccountProvider>
      </LayoutProvider>
    </ColorSchemeProvider>
  );
}
