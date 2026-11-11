import { For } from "retend";
import { Icon } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import { SidebarItem } from "@/components/ui/Sidebar/SidebarItem";

import { SETTINGS_SECTIONS } from "./SettingsSections";

import classes from "./Settings.module.css";
import sidebarClasses from "@/components/ui/Sidebar/Sidebar.module.css";

/** Replace chat history with Settings navigation on settings routes. */
export function SettingsSidebar() {
  return (
    <div class={classes.settingsSidebar}>
      <AppLink href="/" class={classes.sidebarHeading} title="Back to Squire">
        <Icon class={classes.sidebarHeadingIcon} name="caret" aria-hidden="true" />
        <h2 class={classes.sidebarHeadingText}>Settings</h2>
      </AppLink>
      <div class={sidebarClasses.sidebarNav}>
        {For(
          [...SETTINGS_SECTIONS],
          ({ name, icon, path, exact }) => (
            <SidebarItem name={name} icon={icon} path={path} exact={exact} />
          ),
          { key: "path" },
        )}
      </div>
    </div>
  );
}
