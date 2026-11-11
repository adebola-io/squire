import { Cell, If, onConnected } from "retend";
import { Icon } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import { useAccountView } from "@/scopes/AccountScope";

import classes from "./Sidebar.module.css";

/** Account avatar with icon and loading fallbacks. */
function Avatar() {
  const view = useAccountView();
  const failed = Cell.source(false);
  const image = Cell.derivedAsync(async (get) => {
    const current = await get(view);
    return current.state === "signedIn" ? (current.image ?? "") : "";
  });
  const showImage = Cell.derivedAsync(async (get) => !get(failed) && (await get(image)) !== "");
  return (
    <span class={classes.avatar} aria-hidden="true">
      {If(view.pending, {
        true: () => <Icon name="loading" class={classes.avatarLoader} />,
        false: () =>
          If(showImage, {
            true: () => <img src={image} alt="" onError={() => failed.set(true)} />,
            false: () => <Icon name="user" />,
          }),
      })}
    </span>
  );
}

/** Sidebar account menu with a Settings link. */
export function AccountMenu() {
  const view = useAccountView();
  const open = Cell.source(false);
  const row = Cell.source<HTMLDivElement | null>(null);
  const trigger = Cell.source<HTMLButtonElement | null>(null);
  const name = Cell.derivedAsync(async (get) => {
    const current = await get(view);
    return current.state === "signedIn" ? current.name : "Not signed in";
  });
  const label = Cell.derived(() =>
    view.pending.get() ? "Loading account" : "Account and settings",
  );
  const close = () => open.set(false);

  // Keep the panel inside the sidebar's modal dialog. A popover teleported to <body>
  // is inert while the mobile sidebar is open, so taps on its links hit the backdrop.
  onConnected(row, (element) => {
    const document = element.ownerDocument;
    const dismissOutside = (event: PointerEvent) => {
      if (open.get() && !element.contains(event.target as Node)) close();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open.get()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.peek()?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape, true);
    };
  });

  return (
    <div ref={row} class={classes.accountRow}>
      <button
        ref={trigger}
        type="button"
        class={classes.accountTrigger}
        aria-label={label}
        aria-busy={view.pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => open.set(!open.get())}
      >
        <Avatar />
        {If(view.pending, {
          true: () => <span class={classes.accountLoading}>Loading account…</span>,
          false: () => (
            <span class={classes.accountName} title={name}>
              {name}
            </span>
          ),
        })}
        <Icon name="caret" class={classes.accountCaret} aria-hidden="true" />
      </button>
      {If(open, () => (
        <div class={classes.accountMenu} role="dialog" aria-label="Account and settings">
          <AppLink href="/settings/account" class={classes.accountMenuItem} onNavigate={close}>
            <Icon name="user" aria-hidden="true" />
            Account
          </AppLink>
          <AppLink href="/settings" class={classes.accountMenuItem} onNavigate={close}>
            <Icon name="settings" aria-hidden="true" />
            Settings
          </AppLink>
        </div>
      ))}
    </div>
  );
}
