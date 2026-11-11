import { Cell, Switch } from "retend";
import { ModalHeading } from "squire-ui";

import { Select } from "@/components/ui/Select";
import type { DesktopMcpTransport } from "@/platform/desktopClient";

import { HttpFields } from "./PluginModalMcpHttpFields";
import { StdioFields } from "./PluginModalMcpStdioFields";

import classes from "./Plugins.module.css";

export function McpForm() {
  const transport = Cell.source<DesktopMcpTransport>("streamable_http");
  const showAdvanced = Cell.source(false);
  const advancedLabel = Cell.derived(() =>
    transport.get() === "streamable_http"
      ? "Advanced (optional headers)"
      : "Advanced (optional environment)",
  );

  const selectTransport = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    transport.set(target.value === "stdio" ? "stdio" : "streamable_http");
    showAdvanced.set(false);
  };

  const toggleAdvanced = () => {
    showAdvanced.set(!showAdvanced.get());
  };

  return (
    <>
      <ModalHeading
        title="Add MCP Connector"
        subtitle="Connect an MCP server to add its tools to Squire."
      />
      <Select
        id="mcp-transport"
        class={classes.mcpTransportSelect}
        name="mcp-transport"
        onChange={selectTransport}
      >
        <option value="streamable_http">Remote</option>
        <option value="stdio">Local</option>
      </Select>
      {Switch(transport, {
        streamable_http: () => (
          <HttpFields
            showAdvanced={showAdvanced}
            advancedLabel={advancedLabel}
            onToggle={toggleAdvanced}
          />
        ),
        stdio: () => (
          <StdioFields
            showAdvanced={showAdvanced}
            advancedLabel={advancedLabel}
            onToggle={toggleAdvanced}
          />
        ),
      })}
    </>
  );
}
