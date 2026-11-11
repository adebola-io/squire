import { For, If } from "retend";
import type { SourceCell } from "retend";
import { Button, Loader } from "squire-ui";

import type { DesktopMarketplaceEntry, DesktopMcpAuthorization } from "@/platform/desktopClient";

import classes from "./Plugins.module.css";

interface SetupProps {
  entry: DesktopMarketplaceEntry;
}

export function MarketplaceMcpSetup(props: SetupProps) {
  const { entry } = props;
  return (
    <div class={classes.marketplaceMcpFields}>
      {If(entry.manifest.mcpTransport === "stdio", () => (
        <label>
          <span>Executable path (optional)</span>
          <input name="executablePath" type="text" placeholder="Use command from PATH" />
          <small>
            Only needed if Squire cannot find the executable. Use the full path to the installed
            app's CLI or uvx.
          </small>
        </label>
      ))}
      {For(
        entry.manifest.secrets,
        (secret) => (
          <label>
            <span>{secret.name}</span>
            <input name={secret.name} type="password" placeholder={secret.description} />
          </label>
        ),
        { key: "name" },
      )}
    </div>
  );
}

interface AuthorizeProps {
  authorization: SourceCell<DesktopMcpAuthorization | null>;
}

export function MarketplaceMcpAuthorize(props: AuthorizeProps) {
  const { authorization } = props;
  return (
    <div class={classes.mcpAuthorizePanel} aria-busy="true">
      <Loader class={classes.marketplaceMcpLoader} size="small" label="Waiting for authorization" />
      <p>Waiting for authorization…</p>
      {If(authorization, (current) => (
        <Button
          variant="outline"
          type="button"
          onClick={() => window.open(current.authorizationUrl, "_blank", "noopener")}
        >
          Open sign-in page
        </Button>
      ))}
    </div>
  );
}
