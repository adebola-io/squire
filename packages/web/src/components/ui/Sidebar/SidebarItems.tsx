import { Cell, Switch } from "retend";
import { useCurrentRoute } from "retend/router";

import { ChatSidebar } from "@/components/views/Chat/ChatSidebar";
import { SettingsSidebar } from "@/components/views/Settings/SettingsSidebar";

import classes from "./Sidebar.module.css";

/** Show Settings navigation on settings routes and chat history elsewhere. */
export function SidebarItems() {
  const route = useCurrentRoute();
  const mode = Cell.derived(() => {
    const path = route.get().path;
    return path === "/settings" || path.startsWith("/settings/") ? "Settings" : "Chat";
  });

  return (
    <nav class={classes.sidebarNav}>
      {Switch(mode, {
        Settings: SettingsSidebar,
        Chat: ChatSidebar,
      })}
    </nav>
  );
}
