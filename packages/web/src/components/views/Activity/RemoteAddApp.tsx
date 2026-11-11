import { Cell, If, type AsyncDerivedCell, type SourceCell } from "retend";
import { Icon } from "squire-ui";

import { ClientIcon, knownClient } from "./ClientName";
import type { RemoteAccessModel } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

interface AppEntry {
  label: string;
  url: string;
}

export interface AppTarget {
  name: string;
  where: string;
  entry?: AppEntry;
  paste: string;
  finish: string;
  note?: string;
  docs?: string;
}

export const APP_TARGETS: AppTarget[] = [
  {
    name: "ChatGPT",
    entry: { label: "ChatGPT Plugins", url: "https://chatgpt.com/plugins" },
    where: ". Select + → Add custom MCP server (on the web).",
    paste: "Name the plugin Squire. Under Connection, paste its public HTTPS MCP URL:",
    finish:
      "Configure OAuth, acknowledge the risk warning, then select Create as a plugin. Review the discovered tools.",
    note: "Requires a Business or Enterprise/Edu workspace and permission to create MCP plugins. Install the plugin after creating it, then select it with @ in a chat.",
    docs: "https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt",
  },
  {
    name: "Claude",
    entry: { label: "Claude Connectors", url: "https://claude.ai/customize/connectors" },
    where: ". Select Add → Custom → Web (or + Add → Add custom connector, if shown).",
    paste: "Name the connector Squire, then enter its remote MCP URL:",
    finish:
      "Continue through the detected authentication settings. Choose Sign in now, keep Claude's recommended published OAuth identity, and select Add.",
    note: "Team/Enterprise owners must add Squire under Organization settings → Connectors first; members then select Connect. Free accounts support one custom connector. Enable Squire in chat under + → Connectors.",
    docs: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  {
    name: "Gemini",
    entry: { label: "Gemini", url: "https://gemini.google.com/" },
    where:
      ". Open Settings → Connected Apps (or Personal Intelligence → Connected Apps). Under Custom apps, select Add a custom app.",
    paste: "Enter Squire's MCP URL in the custom app field:",
    finish: "Select Next and follow the connection prompts.",
    note: "Available to users 18+ in the US with a personal Google Account, English, and Keep Activity enabled. Set up on the web; select Squire with @ in a Gemini chat.",
    docs: "https://support.google.com/gemini/answer/17209137",
  },
  {
    name: "Grok",
    entry: { label: "Grok Connectors", url: "https://grok.com/connectors" },
    where: ". Select New Connector → Custom.",
    paste: "Enter Squire's remote MCP server URL:",
    finish: "Complete any required authentication, then use Squire in Grok.",
    note: "For Grok Business/Enterprise, a team admin must first add Squire in console.x.ai → Grok Business → Connectors → + Add Connector → Other.",
    docs: "https://docs.x.ai/grok/connectors",
  },
  {
    name: "Another app",
    where: "Open the custom remote MCP settings in a client that supports HTTPS MCP servers.",
    paste: "Enter Squire's Streamable HTTP MCP endpoint URL:",
    finish: "Save the connection and complete OAuth authorization when prompted.",
    note: "The client must support OAuth-protected remote MCP servers.",
  },
];

interface AddAppProps {
  remote: RemoteAccessModel;
  target: AppTarget;
  openTarget: AsyncDerivedCell<string | null>;
  expanded: SourceCell<string | null | undefined>;
}

/** Client-specific setup with a shared endpoint and OAuth device authorization. */
export function AddApp(props: AddAppProps) {
  const { remote, target, openTarget, expanded } = props;
  const isOpen = Cell.derivedAsync(async (get) => (await get(openTarget)) === target.name);
  const address = Cell.derivedAsync(async (get) => (await get(remote.status)).mcpUrl);
  const toggle = async () => {
    expanded.set((await openTarget.get()) === target.name ? null : target.name);
  };
  const copy = async () => remote.copy(await address.get());

  return (
    <div>
      <button type="button" class={classes.addApp} aria-expanded={isOpen} onClick={toggle}>
        {If(knownClient(target.name), (name) => (
          <ClientIcon name={name} class={classes.appIcon} />
        ))}
        <span class={classes.addAppName}>{target.name}</span>
        <Icon name="caret" class={classes.addCaret} aria-hidden="true" />
      </button>
      {If(isOpen, () => (
        <>
          <ol class={classes.steps}>
            <li>
              <span class={classes.stepNumber}>1</span>
              {If(target.entry, {
                true: (entry) => (
                  <p>
                    Open{" "}
                    <a
                      class={classes.stepLink}
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${entry.label} (opens in a new tab)`}
                    >
                      {entry.label}
                    </a>
                    {target.where}
                  </p>
                ),
                false: () => <p>{target.where}</p>,
              })}
            </li>
            <li>
              <span class={classes.stepNumber}>2</span>
              <div>
                <p>{target.paste}</p>
                <span class={classes.address}>
                  <code title={address}>{address}</code>
                  <button type="button" class={classes.copy} onClick={copy}>
                    <Icon name="copy" aria-hidden="true" />
                    <span>{If(remote.copied, { true: () => "Copied", false: () => "Copy" })}</span>
                  </button>
                </span>
              </div>
            </li>
            <li>
              <span class={classes.stepNumber}>3</span>
              <p>{target.finish}</p>
            </li>
            <li>
              <span class={classes.stepNumber}>4</span>
              <p>Sign in to Squire, choose this computer, and approve access.</p>
            </li>
          </ol>
          {If(target.note, (note) => (
            <p class={classes.appNote}>{note}</p>
          ))}
          {If(target.docs, (href) => (
            <a class={classes.appDocs} href={href} target="_blank" rel="noopener noreferrer">
              Setup help
            </a>
          ))}
        </>
      ))}
    </div>
  );
}
