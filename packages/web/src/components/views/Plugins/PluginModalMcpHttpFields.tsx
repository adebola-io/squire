import { Cell, If } from "retend";
import type { SourceCell } from "retend";
import { Field, Input, Toggle } from "squire-ui";

import { AdvancedToggle } from "./PluginModalMcpAdvancedToggle";
import { PairTextarea, usePairField } from "./PluginModalMcpPairField";

import classes from "./Plugins.module.css";

interface HttpFieldsProps {
  showAdvanced: SourceCell<boolean>;
  advancedLabel: Cell<string>;
  onToggle: () => void;
}

export function HttpFields(props: HttpFieldsProps) {
  const { showAdvanced, advancedLabel, onToggle } = props;
  const headers = usePairField("mcp-headers");
  const secretHeaders = usePairField("mcp-secret-headers");
  const authorize = Cell.source(false);
  const toggleAuthorization = () => authorize.set(!authorize.get());
  const detectGoogleMcp = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    try {
      const url = new URL(target.value);
      if (
        url.protocol === "https:" &&
        url.hostname.endsWith(".googleapis.com") &&
        url.pathname.startsWith("/mcp")
      ) {
        authorize.set(true);
      }
    } catch {
      // Ignore incomplete URLs while the user types.
    }
  };

  return (
    <>
      <Field id="mcp-url">
        <Field.Label>Server URL</Field.Label>
        <Input
          name="mcp-url"
          type="url"
          placeholder="https://example.com/mcp"
          onInput={detectGoogleMcp}
          required
        />
      </Field>
      <div class={classes.mcpSignInRow}>
        <span>Sign in before adding</span>
        <Toggle
          class={classes.detailToggle}
          name="mcp-oauth-authorize"
          value="true"
          on={authorize}
          title="Sign in before adding"
          aria-label="Sign in before adding"
          onChange={toggleAuthorization}
        />
      </div>
      {If(authorize, () => (
        <>
          <Field id="mcp-oauth-client-id">
            <Field.Label>OAuth client ID (optional)</Field.Label>
            <Input name="mcp-oauth-client-id" type="text" autoComplete="off" />
          </Field>
          <Field id="mcp-oauth-client-secret">
            <Field.Label>OAuth client secret (optional)</Field.Label>
            <Input name="mcp-oauth-client-secret" type="password" autoComplete="new-password" />
          </Field>
          <Field id="mcp-oauth-scopes">
            <Field.Label>OAuth scopes (space-separated, optional)</Field.Label>
            <Input name="mcp-oauth-scopes" type="text" autoComplete="off" />
          </Field>
        </>
      ))}
      <AdvancedToggle showAdvanced={showAdvanced} label={advancedLabel} onToggle={onToggle} />
      {If(showAdvanced, () => (
        <>
          <PairTextarea
            field={headers}
            label="Headers"
            name="mcp-headers"
            placeholder={"X-Client=desktop\nX-Region=us"}
          />
          <PairTextarea
            field={secretHeaders}
            label="Secret headers"
            name="mcp-secret-headers"
            placeholder="Authorization=Bearer token"
          />
        </>
      ))}
    </>
  );
}
