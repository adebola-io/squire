import { onSetup } from "retend";
import { attachRouter } from "retend-web";
import type { JSX } from "retend/jsx-runtime";
import { defineRoutes, Outlet, Router, RouterProvider } from "retend/router";

import { Connections } from "@/components/views/Activity/Activity";
import { Chat } from "@/components/views/Chat/Chat";
import { Plugins } from "@/components/views/Plugins/Plugins";
import { Settings } from "@/components/views/Settings/Settings";
import { SETTINGS_SECTIONS } from "@/components/views/Settings/SettingsSections";
import { Shell } from "@/Shell";

/** Parameter-only leaf routes keep parent views mounted when selection IDs change. */
function RouteParams(): JSX.Template {
  return [];
}

/**
 * App routes and page titles. Conversation, plugin and provider IDs use path parameters; detail
 * panels and settings selections use query parameters.
 */
export const routes = defineRoutes([
  {
    path: "/",
    title: "Squire",
    component: Shell,
    children: [
      {
        path: "",
        component: Chat,
        children: [
          { path: "", component: RouteParams },
          {
            path: "chat",
            title: "Chat · Squire",
            component: RouteParams,
            children: [
              { path: "", component: RouteParams },
              { path: ":conversationId", component: RouteParams },
            ],
          },
        ],
      },
      { path: "connections", title: "Connections · Squire", component: Connections },
      {
        path: "plugins",
        title: "Plugins · Squire",
        component: Plugins,
        children: [
          { path: "", component: RouteParams },
          { path: ":pluginId", component: RouteParams },
        ],
      },
      {
        path: "settings",
        component: Settings,
        children: SETTINGS_SECTIONS.map((section) => ({
          path: section.path === "/settings" ? "" : section.path.slice("/settings/".length),
          title: `${section.name} · Squire`,
          component: RouteParams,
          children:
            section.path === "/settings/providers"
              ? [
                  { path: "", component: RouteParams },
                  { path: ":providerId", component: RouteParams },
                ]
              : [],
        })),
      },
    ],
  },
]);

/**
 * Attach browser history and initialize the current route with replace so the adapter applies
 * its title without adding a history entry. Mounting may occur after the window load event.
 */
export function AppRouter() {
  const router = new Router({ routes });

  onSetup(() => {
    const detach = attachRouter(router, window);
    const { pathname, search, hash } = window.location;
    void router.replace(`${pathname}${search}${hash}`);
    return detach;
  });

  return (
    <RouterProvider router={router}>
      <Outlet />
    </RouterProvider>
  );
}
