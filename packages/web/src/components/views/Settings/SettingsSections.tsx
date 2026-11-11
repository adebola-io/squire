/** Shared definitions for Settings navigation, routes and titles. */
export const SETTINGS_SECTIONS = [
  { path: "/settings", name: "General", icon: "settings", exact: true },
  {
    path: "/settings/account",
    name: "Account",
    icon: "user",
    exact: false,
  },
  {
    path: "/settings/providers",
    name: "Providers",
    icon: "extension",
    exact: false,
  },
  {
    path: "/settings/workspaces",
    name: "Workspaces",
    icon: "grid",
    exact: false,
  },
  {
    path: "/settings/browser",
    name: "Browser",
    icon: "browser",
    exact: false,
  },
  {
    path: "/settings/network",
    name: "Network",
    icon: "activity",
    exact: false,
  },
  {
    path: "/settings/privacy",
    name: "Security & data",
    icon: "checkmark",
    exact: false,
  },
  {
    path: "/settings/advanced",
    name: "Advanced",
    icon: "settings",
    exact: false,
  },
] as const;
