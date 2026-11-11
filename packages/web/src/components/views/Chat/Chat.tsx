import { Await, Cell, If, Switch } from "retend";
import { EmptyScreen } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import { LoadingState } from "@/components/ui/LoadingState";
import { SidePanel } from "@/components/ui/RightPanel/RightPanel";
import {
  VirtualKeyboardAwareView,
  VirtualKeyboardTriggers,
} from "@/components/ui/VirtualKeyboardAwareView";
import { useChat } from "@/scopes/ChatScope";

import { ChatHome } from "./ChatHome";
import { useWorkStepPanel } from "./ChatStepPanel";
import { Composer } from "./Composer";
import { ConversationView } from "./ConversationView";

import classes from "./Chat.module.css";

/**
 * Keep one composer mounted beneath the changing home introduction or conversation transcript.
 * Preserve the previous transcript (inert) while the next chat loads; execution steps open in
 * the side panel.
 */
export function Chat() {
  const { providers, selectedId, snapshot, conversationError, refreshProviders } = useChat();
  const keyboardHeight = Cell.source(0);
  const providersError = Cell.derived(() => providers.error.get()?.message ?? null);
  const composerTranslate = Cell.derived(() => `0px -${keyboardHeight.get()}px`);
  const keyboardVisible = Cell.derived(() => keyboardHeight.get() > 0);
  const inspector = useWorkStepPanel();
  // Check provider readiness once. Route changes must not suspend the chat view.
  const hasProviders = Cell.derivedAsync(async (get) => {
    return (await get(providers)).profiles.length > 0;
  });
  // Keep the home screen visible until the first conversation loads or fails. Direct chat links
  // use the normal loading state.
  let shown: "home" | "conversation" = selectedId.get() === null ? "home" : "conversation";
  const mode = Cell.derived(() => {
    const ready = snapshot.get() !== null || conversationError.get() !== null;
    if (selectedId.get() === null) {
      shown = "home";
    } else if (ready || shown === "conversation") {
      shown = "conversation";
    }
    return shown;
  });

  return (
    <Await
      fallback={
        <LoadingState
          screen
          label="Opening chat…"
          error={providersError}
          onRetry={refreshProviders}
        />
      }
    >
      {If(hasProviders, {
        true: () => (
          <section class={classes.chatView} data-mode={mode}>
            {Switch(mode, {
              home: () => <ChatHome />,
              conversation: () => <ConversationView />,
            })}
            <VirtualKeyboardAwareView
              class={classes.column}
              data-keyboard-visible={keyboardVisible}
              style={{ translate: composerTranslate }}
              onKeyboardVisibilityChange={({ approximateHeight }) => {
                keyboardHeight.set(approximateHeight);
              }}
            >
              {() => (
                <VirtualKeyboardTriggers>
                  <Composer />
                </VirtualKeyboardTriggers>
              )}
            </VirtualKeyboardAwareView>
          </section>
        ),
        false: () => <ChatSetup />,
      })}
      <SidePanel content={inspector.content} onClose={inspector.close} />
    </Await>
  );
}

function ChatSetup() {
  return (
    <section class={classes.home}>
      <EmptyScreen icon="extension" text="Add a provider in Settings to start chatting." />
      <AppLink href="/settings/providers" class={classes.setupLink}>
        Set up a provider
      </AppLink>
    </section>
  );
}
