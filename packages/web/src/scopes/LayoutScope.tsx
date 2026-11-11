import { Cell, createScope, onSetup, type SourceCell, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";

/**
 * Store sidebar visibility as a layout preference. Keep route and detail selections in the URL.
 */
interface LayoutState {
  sidebarIsOpen: SourceCell<boolean>;
}

interface LayoutProviderProps {
  children: JSX.Children;
}

const LayoutScope = createScope<LayoutState>();

/**
 * Sidebar breakpoint in rem. Start collapsed below it and collapse when the viewport narrows
 * past it.
 */
const NARROW = "(max-width: 48rem)";

export function LayoutProvider(props: LayoutProviderProps) {
  const { children } = props;
  const narrow = window.matchMedia(NARROW);
  const layout: LayoutState = { sidebarIsOpen: Cell.source(!narrow.matches) };
  onSetup(() => {
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        layout.sidebarIsOpen.set(false);
      }
    };
    narrow.addEventListener("change", onChange);
    return () => {
      narrow.removeEventListener("change", onChange);
    };
  });
  return <LayoutScope.Provider value={layout}>{children}</LayoutScope.Provider>;
}

export function useLayout() {
  return useScopeContext(LayoutScope);
}
