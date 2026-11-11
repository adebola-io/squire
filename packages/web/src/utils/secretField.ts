import { Cell } from "retend";
import type { IconName } from "squire-ui";

/**
 * Secret-field visibility state and toggle labels. `noun` supplies the field name used in the
 * label.
 */
export function useSecretVisibility(noun = "API key") {
  const visible = Cell.source(false);
  const inputType = Cell.derived(() => (visible.get() ? "text" : "password"));
  const label = Cell.derived(() => `${visible.get() ? "Hide" : "Show"} ${noun}`);
  const icon = Cell.derived((): IconName => (visible.get() ? "eyeClosed" : "eye"));
  const toggle = () => visible.set(!visible.get());
  const hide = () => visible.set(false);
  return { inputType, label, icon, toggle, hide };
}
