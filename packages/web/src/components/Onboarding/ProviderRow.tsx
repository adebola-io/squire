import { If } from "retend";
import { Icon, isIconName } from "squire-ui";

import { isConnected } from "@/components/views/Settings/ProviderList";
import { initialLetter } from "@/components/views/Settings/ProviderMark";
import type { DesktopProviderProfile } from "@/platform/desktopClient";

import classes from "./Onboarding.module.css";

function subtitle(profile: DesktopProviderProfile) {
  if (profile.kind === "chatgpt") return "Connect your ChatGPT account";
  if (!profile.builtin) return profile.baseUrl || "Custom provider";
  const article = /^[aeiou]/i.test(profile.displayName) ? "an" : "a";
  return `Use ${article} ${profile.displayName} API key`;
}

function actionLabel(profile: DesktopProviderProfile) {
  if (isConnected(profile)) return "Connected";
  return profile.kind === "chatgpt" ? "Connect" : "Add key";
}

interface ProviderRowProps {
  profile: DesktopProviderProfile;
  select: () => void;
}

/** One provider in the onboarding list: mark, name, what connecting means, and its state. */
export function ProviderRow(props: ProviderRowProps) {
  const { profile, select } = props;
  const connected = isConnected(profile);
  const action = actionLabel(profile);
  const description = subtitle(profile);
  // The brand mark on its own, as in the design; a letter when there is no mark.
  const icon = profile.icon;
  const mark = isIconName(icon) ? <Icon name={icon} /> : initialLetter(profile.displayName);
  return (
    <li>
      <button type="button" onClick={select}>
        <span class={classes.customMark} aria-hidden="true">
          {mark}
        </span>
        <span class={classes.rowText}>
          <strong>{profile.displayName}</strong>
          <span>{description}</span>
        </span>
        <span class={classes.rowAction} data-connected={connected}>
          {If(connected, () => (
            <Icon name="checkmark" aria-hidden="true" />
          ))}
          {action}
          <Icon name="caret" class={classes.rowCaret} aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}
