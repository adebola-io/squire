import { Cell, If, onSetup } from "retend";
import { Button, Icon } from "squire-ui";

import type { AccountModel } from "@/components/views/Settings/Account/useAccount";

import classes from "./Onboarding.module.css";

interface ApprovalWaitingProps {
  account: AccountModel;
}

/** Keep the code visible while the person compares it with the website. */
function ApprovalCode(props: ApprovalWaitingProps) {
  const { account } = props;
  const copied = Cell.source(false);
  const copyLabel = Cell.derived(() => (copied.get() ? "Copied" : "Copy code"));
  let timer: number | undefined;
  const copy = async () => {
    const code = await account.userCode.get();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      copied.set(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => copied.set(false), 1600);
    } catch {
      copied.set(false);
    }
  };
  onSetup(() => () => window.clearTimeout(timer));
  return (
    <>
      <p class={classes.codeLabel}>Code shown in Squire</p>
      <div class={classes.codeRow}>
        <strong class={classes.code}>{account.userCode}</strong>
        <button
          type="button"
          class={classes.copyCode}
          title={copyLabel}
          aria-label={copyLabel}
          onClick={() => void copy()}
        >
          {If(copied, {
            true: () => <Icon name="checkmark" aria-hidden="true" />,
            false: () => <Icon name="copy" aria-hidden="true" />,
          })}
        </button>
      </div>
    </>
  );
}

/** Native link opens the website on the same click that starts the persistent progress state. */
export function ApprovalWaiting(props: ApprovalWaitingProps) {
  const { account } = props;
  const opened = Cell.source(false);
  const approvalUrl = Cell.derivedAsync(
    async (get) => (await get(account.status))?.approvalUrl ?? null,
  );

  return (
    <>
      <h1>Approve this computer</h1>
      {If(opened, {
        true: () => (
          <p class={classes.approvalProgress} role="status">
            Finish approval in your browser. Squire will continue automatically once connected.
          </p>
        ),
        false: () => (
          <>
            <p class={classes.waiting} role="status">
              <span class={classes.waitingDot} aria-hidden="true" />
              Waiting for approval
            </p>
            <p>
              Sign in in your browser, check that the code matches, then approve this computer
              there.
            </p>
          </>
        ),
      })}
      <ApprovalCode account={account} />
      <div class={classes.approvalActions}>
        {If(approvalUrl, (href) => (
          <a
            class={classes.openApproval}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-busy={opened}
            aria-disabled={opened}
            onClick={(event) => {
              if (opened.get()) {
                event.preventDefault();
              } else {
                opened.set(true);
              }
            }}
          >
            {If(opened, {
              true: () => (
                <>
                  <Icon name="loading" class={classes.approvalSpinner} aria-hidden="true" />
                  Connecting your device
                </>
              ),
              false: () => "Open the approval page",
            })}
          </a>
        ))}
        <Button variant="ghost" onClick={account.disconnect}>
          Cancel
        </Button>
      </div>
      <p class={classes.fine}>
        Only approve a request you started. If the code doesn’t match the one in your browser,
        cancel here and change your Squire password.
      </p>
      {If(opened, () =>
        If(approvalUrl, (href) => (
          <p class={classes.fine}>
            Didn’t open?{" "}
            <a href={href} target="_blank" rel="noopener noreferrer">
              Open the approval page again
            </a>
            .
          </p>
        )),
      )}
    </>
  );
}
