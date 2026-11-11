import { Cell } from "retend";
import type { JSX } from "retend/jsx-runtime";
import { Icon } from "squire-ui";

import { useLayout } from "@/scopes/LayoutScope";

import classes from "./Sidebar.module.css";

type NativeButtonProps = JSX.IntrinsicElements["button"];
interface SidebarToggleProps extends NativeButtonProps {}

export function SidebarToggle(props: SidebarToggleProps) {
  const { class: className, ...restProps } = props;
  const { sidebarIsOpen } = useLayout();
  const label = Cell.derived(() => {
    return sidebarIsOpen.get() ? "Hide sidebar" : "Show sidebar";
  });
  const toggleSidebar = () => {
    sidebarIsOpen.set(!sidebarIsOpen.get());
  };

  return (
    <button
      {...restProps}
      type="button"
      class={[classes.sidebarToggle, classes.sidebarToggleFloating, className]}
      data-sidebar-open={sidebarIsOpen}
      aria-label={label}
      aria-expanded={sidebarIsOpen}
      title={label}
      onClick={toggleSidebar}
    >
      <Icon name="sidebar" aria-hidden="true" />
    </button>
  );
}
