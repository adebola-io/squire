import { Cell, If, onSetup } from "retend";
import { Button, Icon } from "squire-ui";

import {
  getChatGPTStatus,
  signOutChatGPT,
  startChatGPTSignIn,
  type ChatGPTStatus,
} from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { errorMessage } from "@/utils/misc";

import classes from "./Providers.module.css";

function useChatGPTConnection() {
  const { refreshProviders, modelDiscovery } = useChat();
  const status = Cell.source<ChatGPTStatus | null>(null);
  const busy = Cell.source(false);
  const error = Cell.source<string | null>(null);
  const displayedError = Cell.derived(() => error.get() ?? status.get()?.error ?? null);
  const pending = Cell.derived(() => status.get()?.pending ?? false);
  const connected = Cell.derived(() => status.get()?.connected ?? false);
  const verificationUri = Cell.derived(() => status.get()?.verificationUri ?? null);
  const userCode = Cell.derived(() => status.get()?.userCode ?? null);
  let disposed = false;

  const refresh = async () => {
    try {
      const next = await getChatGPTStatus();
      if (!disposed) status.set(next);
      return next;
    } catch (cause) {
      if (!disposed) error.set(errorMessage(cause));
      return null;
    }
  };

  const changed = () => {
    refreshProviders();
    modelDiscovery.refresh("chatgpt");
  };

  const waitForSignIn = async () => {
    for (let i = 0; i < 900 && !disposed; i++) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
      if (disposed) return;
      const next = await refresh();
      if (next && !next.pending) {
        changed();
        if (next.error) error.set(next.error);
        return;
      }
    }
  };

  const run = async (action: () => Promise<unknown>, updateModels = true) => {
    if (busy.get()) return;
    busy.set(true);
    error.set(null);
    try {
      await action();
      await refresh();
      if (updateModels) changed();
    } catch (cause) {
      error.set(errorMessage(cause));
    } finally {
      busy.set(false);
    }
  };

  const start = () => {
    void run(async () => {
      await startChatGPTSignIn();
      void waitForSignIn();
    }, false);
  };

  const signOut = () => {
    void run(() => signOutChatGPT());
  };

  onSetup(() => {
    void refresh();
    return () => {
      disposed = true;
    };
  });

  return { busy, pending, connected, verificationUri, userCode, displayedError, start, signOut };
}

export function ChatGPTConnection() {
  const { busy, pending, connected, verificationUri, userCode, displayedError, start, signOut } =
    useChatGPTConnection();

  return (
    <section class={classes.chatgptConnection} aria-label="ChatGPT account">
      <div class={classes.chatgptHeading}>
        <div>
          <h3>ChatGPT account</h3>
          <p>Connect your ChatGPT subscription using a device authorization code.</p>
        </div>
        {If(connected, () => (
          <span class={classes.chatgptConnected}>
            <Icon name="checkmark" aria-hidden="true" /> Connected
          </span>
        ))}
      </div>
      <div class={classes.chatgptActions}>
        {If(pending, {
          true: () => (
            <Button variant="ghost" disabled={busy} onClick={signOut}>
              Cancel sign-in
            </Button>
          ),
          false: () =>
            If(connected, {
              true: () => (
                <Button variant="ghost" disabled={busy} onClick={signOut}>
                  Sign out
                </Button>
              ),
              false: () => (
                <Button disabled={busy} onClick={start}>
                  <Icon name="openai" aria-hidden="true" />
                  Connect ChatGPT
                </Button>
              ),
            }),
        })}
      </div>
      {If(verificationUri, (uri) => (
        <p class={classes.chatgptNote}>
          Open{" "}
          <a href={uri} target="_blank" rel="noopener noreferrer">
            {uri}
          </a>{" "}
          and enter the code{" "}
          {If(userCode, (code) => (
            <strong class={classes.chatgptDeviceCode}>{code}</strong>
          ))}
          .
        </p>
      ))}
      {If(pending, () => (
        <p class={classes.chatgptNote}>Waiting for device authorization.</p>
      ))}
      {If(displayedError, (message) => (
        <p class={classes.chatgptError} role="alert">
          {message}
        </p>
      ))}
    </section>
  );
}
