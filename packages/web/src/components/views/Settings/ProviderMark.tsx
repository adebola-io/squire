import type { JSX } from "retend/jsx-runtime";
import { Icon, isIconName } from "squire-ui";

import classes from "./Providers.module.css";

interface ProviderTileProps {
  letter: JSX.ValueOrCellOrPromise<string>;
  large?: boolean;
}

/** Letter tile used when the provider has no brand icon. */
export function ProviderTile(props: ProviderTileProps) {
  const { letter, large = false } = props;
  return (
    <span class={classes.providerTile} data-large={large} aria-hidden="true">
      {letter}
    </span>
  );
}

/** Initial used in the provider tile. */
export function initialLetter(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

interface ProviderMarkProps {
  icon: string;
  name: string;
  large?: boolean;
}

/** Render a known provider icon, falling back to a letter tile. */
export function ProviderMark(props: ProviderMarkProps) {
  const { icon, name, large = false } = props;
  if (isIconName(icon)) {
    return (
      <span class={classes.providerTile} data-large={large} aria-hidden="true">
        <Icon name={icon} />
      </span>
    );
  }
  return <ProviderTile letter={initialLetter(name)} large={large} />;
}
