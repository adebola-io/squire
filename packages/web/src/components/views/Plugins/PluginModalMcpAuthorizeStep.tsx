import { Button, Loader, ModalHeading } from "squire-ui";

import type { DesktopMcpAuthorization } from "@/platform/desktopClient";

import classes from "./Plugins.module.css";

interface PluginModalMcpAuthorizeStepProps {
  authorization: DesktopMcpAuthorization;
}

export function PluginModalMcpAuthorizeStep(props: PluginModalMcpAuthorizeStepProps) {
  const { authorization } = props;

  const openSignIn = () => {
    window.open(authorization.authorizationUrl, "_blank", "noopener");
  };

  return (
    <>
      <ModalHeading
        title="Authorize MCP Server"
        subtitle="This server requires sign-in. Open the sign-in page below. Squire continues when sign-in is complete."
      />
      <div class={classes.mcpAuthorizePanel} aria-busy="true">
        <Loader label="Waiting for authorization" />
        <p title="Waiting for authorization">Waiting for authorization…</p>
        <Button variant="outline" type="button" onClick={openSignIn}>
          Open sign-in page
        </Button>
      </div>
    </>
  );
}
