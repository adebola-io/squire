import { Cell, If } from "retend";
import type { SourceCell } from "retend";
import { SearchInput } from "squire-ui";

import classes from "./Plugins.module.css";

interface PluginDetailPanelHeaderProps {
  error?: Cell<string | null>;
  search: SourceCell<string>;
  placeholder: string;
}

export function PluginDetailPanelHeader(props: PluginDetailPanelHeaderProps) {
  const { error: propError, search, placeholder } = props;
  const error = propError ?? Cell.source<string | null>(null);

  return (
    <div class={classes.detailPanelHeader}>
      {If(error, (message) => (
        <p class={classes.detailError} role="alert" title={message}>
          {message}
        </p>
      ))}
      <SearchInput model={search} placeholder={placeholder} label={placeholder} />
    </div>
  );
}
