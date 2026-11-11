import { ClientIcon as SharedClientIcon } from "squire-ui";

import classes from "./Activity.module.css";

export { knownClient, clientIconSrc } from "squire-ui";

interface ClientNameProps {
  name: string;
}

interface ClientIconProps {
  name: string;
  class?: string;
}

/** Use the shared client mark with Activity's theme and size styling. */
export function ClientIcon(props: ClientIconProps) {
  const { name, class: iconSizeClass } = props;
  return <SharedClientIcon name={name} class={[classes.clientIcon, iconSizeClass]} />;
}

export function ClientName(props: ClientNameProps) {
  const { name } = props;

  return (
    <div class={classes.clientName}>
      <ClientIcon name={name} class={classes.clientNameIcon} />
      <span title={name}>{name}</span>
    </div>
  );
}
