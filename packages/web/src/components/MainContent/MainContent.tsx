import { Cell } from "retend";
import { Outlet, useCurrentRoute } from "retend/router";

import classes from "./MainContent.module.css";

/**
 * Render the active route and optional side panel. CSS adjusts the content gutter when the
 * panel opens.
 */
export function MainContent() {
  const route = useCurrentRoute();
  const isChat = Cell.derived(() => {
    const path = route.get().path;
    return path === "/" || path === "/chat" || path.startsWith("/chat/");
  });

  return (
    <div class={classes.mainContent} data-chat-page={isChat}>
      <Outlet />
    </div>
  );
}
