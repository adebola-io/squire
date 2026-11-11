import { Button } from "squire-ui";

import type { AccountModel } from "@/components/views/Settings/Account/useAccount";

import classes from "./Onboarding.module.css";

interface AccountProps {
  account: AccountModel;
  next: () => void;
}
interface RetryProps extends AccountProps {
  title: string;
}

/** Sign-in prompt for the account step. */
export function AccountDisconnected(props: AccountProps) {
  const { account, next } = props;
  return (
    <>
      <h1>Sign in to Squire</h1>
      <p>
        Squire shows a code, then you sign in or create an account in your browser and approve this
        computer there.
      </p>
      <Button onClick={account.connect} disabled={account.busy}>
        Continue in browser
      </Button>
      <Button variant="outline" onClick={next}>
        Skip for now
      </Button>
      <p class={classes.note}>
        A Squire account is needed for hosted services. You can use local features without signing
        in.
      </p>
    </>
  );
}

/** Expired, failed and revoked attempts. */
export function AccountRetry(props: RetryProps) {
  const { title, account, next } = props;
  return (
    <>
      <h1>{title}</h1>
      <p>Start a new request to sign in and approve this computer in your browser.</p>
      <Button onClick={account.connect} disabled={account.busy}>
        Try again
      </Button>
      <Button variant="outline" onClick={next}>
        Skip for now
      </Button>
    </>
  );
}
