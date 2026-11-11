import { Cell, onConnected } from "retend";
import { useCurrentRoute } from "retend/router";
import { Icon } from "squire-ui";

import { SidebarItems } from "@/components/ui/Sidebar/SidebarItems";
import { useLayout } from "@/scopes/LayoutScope";

import { mountSidebar } from "./sidebarRuntime";

import classes from "./Sidebar.module.css";

/** Desktop sidebar stays in the layout. On mobile the same contents open as a modal drawer. */
export function Sidebar() {
  const { sidebarIsOpen } = useLayout();
  const route = useCurrentRoute();
  const dialog = Cell.source<HTMLDialogElement | null>(null);
  const sidebarIsClosed = Cell.derived(() => !sidebarIsOpen.get());
  const close = () => sidebarIsOpen.set(false);
  const onCancel = (event: Event) => {
    event.preventDefault();
    if (sidebarIsOpen.get()) close();
    else dialog.get()?.close();
  };
  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === dialog.get()) close();
  };

  onConnected(dialog, (element) => {
    return mountSidebar(element, sidebarIsOpen, (listener) => route.listen(listener));
  });

  return (
    <dialog
      id="squire-navigation"
      ref={dialog}
      class={classes.sidebarContainer}
      data-is-closed={sidebarIsClosed}
      aria-label="Navigation"
      onCancel={onCancel}
      onClick={onBackdropClick}
    >
      <aside class={classes.sidebar} inert={sidebarIsClosed} ariaHidden={sidebarIsClosed}>
        <div class={classes.mobileSidebarHeader}>
          <button type="button" aria-label="Close navigation" onClick={close}>
            <Icon name="cancel" aria-hidden="true" />
          </button>
        </div>
        <SidebarItems />
      </aside>
    </dialog>
  );
}
