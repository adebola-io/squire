import { Await, Cell, If } from "retend";

import { SettingRow } from "@/components/views/Settings/SettingRow";

import type { AccountStateProps } from "./useAccount";

import classes from "./Account.module.css";

/**
 * Use the account-management URL supplied by the server. Reserve its row before profile loading
 * completes to prevent layout shifts.
 */
export function ManageAccountRow(props: AccountStateProps) {
  const { account } = props;
  const { profile } = account;
  const manageUrl = Cell.derivedAsync(async (get) => (await get(profile))?.manageUrl ?? null);
  const manageHost = Cell.derivedAsync(async (get) => {
    const url = await get(manageUrl);
    return url === null ? "" : new URL(url).host;
  });
  // Reserve link space until the management URL resolves.
  const placeholder = () => (
    <span class={classes.link} aria-disabled="true">
      Manage account
    </span>
  );

  return (
    <div class={classes.rows}>
      <SettingRow
        label="Devices and sign-in"
        hint="Review the installations connected to this account and revoke access from any of them."
      >
        <Await fallback={placeholder()}>
          {If(manageUrl, {
            true: (href) => (
              <a class={classes.link} href={href} target="_blank" rel="noopener noreferrer">
                Manage on {manageHost}
                <span aria-hidden="true"> ↗</span>
              </a>
            ),
            false: placeholder,
          })}
        </Await>
      </SettingRow>
    </div>
  );
}
