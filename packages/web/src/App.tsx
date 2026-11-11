import { AppRouter } from "@/router";
import { BrowserPresenceProvider } from "@/scopes/BrowserPresenceScope";
import { DesktopEventsProvider } from "@/scopes/DesktopEventsScope";

export default function App() {
  return (
    <DesktopEventsProvider>
      <BrowserPresenceProvider>
        <AppRouter />
      </BrowserPresenceProvider>
    </DesktopEventsProvider>
  );
}
