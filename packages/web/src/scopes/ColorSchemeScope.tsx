import { Cell, createScope, onSetup, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";

export type ColorScheme = "light" | "dark";
export type AppearancePreference = "system" | ColorScheme;

interface ColorSchemeProviderProps {
  children: JSX.Children;
}

interface AppearanceState {
  preference: Cell<AppearancePreference>;
  setPreference: (next: AppearancePreference) => void;
}

const STORAGE_KEY = "squire.appearance";
const ColorSchemeScope = createScope<Cell<ColorScheme>>();
const AppearanceScope = createScope<AppearanceState>();

function savedPreference(): AppearancePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Share the resolved appearance preference between CSS and theme-aware icons. */
export function ColorSchemeProvider(props: ColorSchemeProviderProps) {
  const { children } = props;
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const system = Cell.source<ColorScheme>(query.matches ? "light" : "dark");
  const preference = Cell.source<AppearancePreference>(savedPreference());
  const scheme = Cell.derived<ColorScheme>(() => {
    return preference.get() === "system" ? system.get() : (preference.get() as ColorScheme);
  });

  // Derive the favicon from the selected theme because SVG media queries cannot read the app's
  // theme override.
  const applyScheme = (value: ColorScheme) => {
    document.documentElement.dataset.colorScheme = value;
    const href = `/favicon-${value}.svg?v=7`;
    const previous = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (previous?.getAttribute("href") === href) return;
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.href = href;
    if (previous) previous.replaceWith(favicon);
    else document.head.append(favicon);
  };

  // Apply saved appearance before rendering children to prevent a system-theme flash.
  applyScheme(scheme.get());

  const setPreference = (next: AppearancePreference) => {
    if (next === preference.get()) return;
    try {
      if (next === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can forbid storage. The current session still works.
    }
    preference.set(next);
  };

  scheme.listen(applyScheme);

  onSetup(() => {
    const updateSystem = (event: MediaQueryListEvent) => {
      system.set(event.matches ? "light" : "dark");
    };
    query.addEventListener("change", updateSystem);
    return () => query.removeEventListener("change", updateSystem);
  });

  return (
    <ColorSchemeScope.Provider value={scheme}>
      <AppearanceScope.Provider value={{ preference, setPreference }}>
        {children}
      </AppearanceScope.Provider>
    </ColorSchemeScope.Provider>
  );
}

export function useColorScheme(): Cell<ColorScheme> {
  return useScopeContext(ColorSchemeScope);
}

export function useAppearancePreference(): AppearanceState {
  return useScopeContext(AppearanceScope);
}
