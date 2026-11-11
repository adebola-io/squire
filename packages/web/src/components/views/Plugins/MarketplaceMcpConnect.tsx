import { Cell, If, onSetup, Switch } from "retend";
import { Button, Dialog, Loader, ModalHeading } from "squire-ui";

import { connectMarketplaceMcp, installMarketplaceMcpCandidate } from "@/platform/desktopClient";
import type { DesktopMarketplaceEntry } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { usePluginState } from "@/scopes/PluginScope";

import { MarketplaceMcpFooter } from "./MarketplaceMcpFooter";
import { MarketplaceMcpAuthorize, MarketplaceMcpSetup } from "./MarketplaceMcpSteps";
import { useMcpCandidateFlow } from "./PluginMcpCandidateFlow";
import { PluginModalMcpReviewActions } from "./PluginModalMcpReviewActions";

import classes from "./Plugins.module.css";

interface MarketplaceMcpConnectProps {
  entry: DesktopMarketplaceEntry;
  iconTrigger?: boolean;
  retry?: boolean;
}

type Step = "setup" | "connecting" | "authorize" | "review" | "error";

const STEP_COPY: Record<Step, readonly [string, string]> = {
  setup: ["Connect", "Enter the credentials required by this server."],
  connecting: ["Connecting to", "Discovering the actions available from this server."],
  error: ["Couldn’t connect to", "The connection failed. Review the error and retry when ready."],
  authorize: ["Sign in to", "Authorize access in your browser to continue."],
  review: ["Review", "Confirm the actions before adding this connector."],
};

/** One connection attempt; it lives exactly as long as its dialog. */
function useMcpInstallation(entry: DesktopMarketplaceEntry, onClose: () => void) {
  const step = Cell.source<Step>("setup");
  const mcp = useMcpCandidateFlow();
  const { candidate, authorization } = mcp;
  const error = Cell.source<string | null>(null);
  let closed = false;

  const connect = Cell.task(async (form: FormData) => {
    const token = mcp.attempt.get();
    error.set(null);
    step.set("connecting");
    try {
      const credentials: Record<string, string> = {};
      for (const secret of entry.manifest.secrets) {
        const value = form.get(secret.name);
        if (typeof value === "string" && value) credentials[secret.name] = value;
      }
      const executablePath = form.get("executablePath")?.toString().trim();
      const response = await connectMarketplaceMcp({
        id: entry.manifest.id,
        credentials,
        ...(executablePath ? { executablePath } : {}),
      });
      if ((await mcp.accept(response, token, () => step.set("authorize"))) && !closed) {
        step.set("review");
      }
    } catch (cause) {
      if (!closed && token === mcp.attempt.get()) {
        error.set(cause instanceof Error ? cause.message : "Connection failed.");
        step.set("error");
      }
    }
  });

  /** Leaves the flow; `cancel` releases a candidate the server has not claimed. */
  const finish = (cancel: boolean) => {
    if (closed) return;
    closed = true;
    mcp.clear(cancel);
    onClose();
  };

  const install = Cell.task(async () => {
    const current = candidate.get();
    if (!current) return;
    const token = mcp.attempt.get();
    const isCurrent = () => !closed && mcp.attempt.get() === token && candidate.get() === current;
    try {
      await installMarketplaceMcpCandidate(current.candidateId);
      if (isCurrent()) finish(false);
    } catch (cause) {
      if (isCurrent()) {
        mcp.clear(true);
        step.set("error");
        error.set(cause instanceof Error ? cause.message : "Installation could not be started.");
      }
    }
  });

  const reconnect = () => void connect.runWith(new FormData());
  /** Servers that need no input connect straight away. */
  const start = () => {
    if (entry.manifest.secrets.length === 0) reconnect();
  };
  /** Credentials and local executables can be corrected; others just reconnect. */
  const retry = () => {
    error.set(null);
    if (entry.manifest.secrets.length > 0 || entry.manifest.mcpTransport === "stdio") {
      step.set("setup");
    } else {
      reconnect();
    }
  };
  const submit = (event?: SubmitEvent) => {
    if (!event) return;
    void connect.runWith(new FormData(event.currentTarget as HTMLFormElement));
  };

  return {
    step,
    candidate,
    authorization,
    error,
    connect,
    install,
    close: () => finish(true),
    start,
    retry,
    submit,
  };
}

export type MarketplaceMcpFlow = ReturnType<typeof useMcpInstallation>;

interface MarketplaceMcpDialogProps {
  entry: DesktopMarketplaceEntry;
}

function MarketplaceMcpDialog(props: MarketplaceMcpDialogProps) {
  const { entry } = props;
  const { mcpConnect } = usePluginState();
  const scheme = useColorScheme();
  const open = Cell.source(true);
  const flow = useMcpInstallation(entry, () => mcpConnect.set(null));
  const iconUrl = Cell.derived(() => `${entry.iconUrl}?variant=${scheme.get()}`);
  const title = Cell.derived(() => `${STEP_COPY[flow.step.get()][0]} ${entry.manifest.name}`);
  const subtitle = Cell.derived(() =>
    flow.step.get() === "setup" && entry.manifest.mcpTransport === "stdio"
      ? "Use the installed CLI, or supply its executable path."
      : STEP_COPY[flow.step.get()][1],
  );
  const connectionType = entry.manifest.mcpTransport === "streamable_http" ? "Remote" : "Local";

  onSetup(() => {
    flow.start();
    // Leaving the plugins view mid-flow releases the pending candidate.
    return flow.close;
  });

  return (
    <Dialog
      id={`marketplace-mcp-${entry.manifest.id}`}
      open={open}
      onOpenChange={(next) => {
        if (!next) flow.close();
      }}
    >
      <Dialog.Content
        size="larger"
        class={classes.addPluginDialog}
        ariaLabel={`Connect ${entry.manifest.name}`}
      >
        <form class={classes.addPluginModal} onSubmit--prevent={flow.submit}>
          <div class={classes.modalBody}>
            <ModalHeading title={title} subtitle={subtitle} />
            <div class={classes.marketplaceMcpIdentity}>
              <span class={classes.pluginIconFrame} style={{ color: entry.manifest.themeColor }}>
                <img class={classes.pluginIcon} src={iconUrl} alt="" aria-hidden="true" />
              </span>
              <div>
                <strong>{entry.manifest.name}</strong>
                <span>{connectionType} MCP server</span>
              </div>
            </div>
            {Switch(flow.step, {
              setup: () => <MarketplaceMcpSetup entry={entry} />,
              connecting: () => (
                <div class={classes.marketplaceMcpProgress} role="status" aria-live="polite">
                  <Loader
                    class={classes.marketplaceMcpLoader}
                    size="small"
                    label="Connecting to MCP server"
                  />
                  <p>Contacting the server and reading its available actions…</p>
                </div>
              ),
              error: () => null,
              authorize: () => <MarketplaceMcpAuthorize authorization={flow.authorization} />,
              review: () =>
                If(flow.candidate, (candidate) => (
                  <PluginModalMcpReviewActions
                    actions={candidate.actions}
                    connection={candidate.connection}
                  />
                )),
            })}
          </div>
          <MarketplaceMcpFooter flow={flow} />
        </form>
      </Dialog.Content>
    </Dialog>
  );
}

/**
 * The one connection dialog for the plugins view. It belongs to the plugin
 * scope rather than to a card, so refreshing the catalog never re-creates an
 * open flow.
 */
export function MarketplaceMcpDialogHost() {
  const { mcpConnect } = usePluginState();
  return If(mcpConnect, (entry) => <MarketplaceMcpDialog entry={entry} />);
}

export function MarketplaceMcpConnect(props: MarketplaceMcpConnectProps) {
  const { entry, iconTrigger = false, retry = false } = props;
  const { mcpConnect } = usePluginState();
  const begin = () => mcpConnect.set(entry);
  const actionLabel = `${retry ? "Retry" : "Connect"} ${entry.manifest.name}`;
  const buttonLabel = retry ? "Retry connection" : "Connect";
  const failed = retry || undefined;
  return If(iconTrigger, {
    true: () => (
      <button
        class={classes.marketplaceCardAction}
        type="button"
        data-failed={failed}
        aria-label={actionLabel}
        title={actionLabel}
        onClick={begin}
      >
        {If(retry, {
          true: () => <span aria-hidden="true">!</span>,
          false: () => (
            <span class={classes.marketplaceCardPlus} aria-hidden="true">
              +
            </span>
          ),
        })}
      </button>
    ),
    false: () => (
      <Button type="button" onClick={begin}>
        {buttonLabel}
      </Button>
    ),
  });
}
