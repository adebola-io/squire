import { Cell } from "retend";

import { Select } from "@/components/ui/Select";
import { SettingRow } from "@/components/views/Settings/SettingRow";
import { useAppearancePreference } from "@/scopes/ColorSchemeScope";

import classes from "./General.module.css";

/** Apply appearance changes immediately. */
export function AppearanceSetting() {
  const { preference, setPreference } = useAppearancePreference();
  const system = Cell.derived(() => preference.get() === "system");
  const light = Cell.derived(() => preference.get() === "light");
  const dark = Cell.derived(() => preference.get() === "dark");
  const change = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "system" || value === "light" || value === "dark") {
      setPreference(value);
    }
  };

  return (
    <SettingRow
      label="Appearance"
      labelFor="squire-appearance"
      hint="Follow your device or choose a theme."
    >
      <div class={classes.selectControl}>
        <Select id="squire-appearance" onChange={change}>
          <option value="system" selected={system}>
            System
          </option>
          <option value="light" selected={light}>
            Light
          </option>
          <option value="dark" selected={dark}>
            Dark
          </option>
        </Select>
      </div>
    </SettingRow>
  );
}
