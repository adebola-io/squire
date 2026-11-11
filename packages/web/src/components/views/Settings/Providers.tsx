import { Await, Cell, Switch } from "retend";
import { useCurrentRoute } from "retend/router";

import { LoadingState } from "@/components/ui/LoadingState";
import { PendingPage } from "@/components/ui/PendingPage";
import { useChat } from "@/scopes/ChatScope";
import { usePageSwitch } from "@/utils/pageSwitch";

import { ProviderDetail } from "./ProviderDetail";
import { ProviderList } from "./ProviderList";

const LIST = "list";
const PROVIDER = "provider:";

/**
 * Route between the provider list and details, with tab and model-dialog selections in query
 * parameters. Preserve the current page until provider data resolves; load model lists
 * independently inside each page.
 */
export function Providers() {
  const route = useCurrentRoute();
  const { providers, refreshProviders } = useChat();
  const loadError = Cell.derived(() => providers.error.get()?.message ?? null);
  const key = Cell.derived(() => {
    const providerId = route.get().params.get("providerId") ?? null;
    return providerId === null ? LIST : `${PROVIDER}${providerId}`;
  });
  const { pageKey, switching } = usePageSwitch(key, async (get) => {
    await get(providers);
    // Let Await display retry feedback when providers cannot load.
    const error = get(providers.error);
    if (error !== null) {
      throw error;
    }
  });

  return (
    <Await
      fallback={
        <LoadingState
          screen
          label="Fetching providers…"
          error={loadError}
          onRetry={refreshProviders}
        />
      }
    >
      <PendingPage switching={switching}>
        {Switch(pageKey, { [LIST]: () => <ProviderList /> }, (shown) => (
          <ProviderDetail providerId={shown.slice(PROVIDER.length)} />
        ))}
      </PendingPage>
    </Await>
  );
}
