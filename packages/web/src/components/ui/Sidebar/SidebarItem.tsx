import { Cell } from "retend";
import { useCurrentRoute } from "retend/router";
import { Icon, type IconName } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";

import classes from "./Sidebar.module.css";

export interface SidebarItemProps {
  name: string;
  icon: IconName;
  /** Destination path; also active for descendant routes. */
  path: string;
  exact?: boolean;
}

export function SidebarItem(props: SidebarItemProps) {
  const { name, icon, path, exact = false } = props;
  const route = useCurrentRoute();
  const isCurrent = Cell.derived(() => {
    const current = route.get().path;
    if (path === "/" || exact) {
      return current === path;
    }
    return current === path || current.startsWith(`${path}/`);
  });

  const ariaCurrent = Cell.derived(() => {
    return isCurrent.get() ? "page" : undefined;
  });

  return (
    <AppLink
      href={path}
      class={classes.sidebarItem}
      data-selected={isCurrent}
      aria-current={ariaCurrent}
    >
      <Icon name={icon} class={classes.sidebarItemIcon} aria-hidden="true" />
      <span class={classes.sidebarItemName} title={name}>
        {name}
      </span>
    </AppLink>
  );
}
