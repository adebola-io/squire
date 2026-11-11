import type { JSX } from "retend/jsx-runtime";

import classes from "./Account.module.css";

/** Semantic status tone, also expressed by the status text. */
export type Tone = "idle" | "pending" | "success" | "error";

interface AccountBlockProps {
  tone: Tone;
  headline: JSX.Children;
  /** Plain-text headline used as the truncated-content tooltip. */
  title: JSX.ValueOrCellOrPromise<string>;
  detail: JSX.Children;
  actions: JSX.Children;
  busy?: JSX.ValueOrCellOrPromise<boolean>;
}

/** Account connection status and actions. */
export function AccountBlock(props: AccountBlockProps) {
  const { tone, headline, title, detail, actions, busy = false } = props;
  return (
    <div class={classes.block} aria-busy={busy}>
      <h2 class={classes.headline} title={title}>
        {headline}
      </h2>
      <div class={classes.detail}>
        <span class={classes.dotLine} aria-hidden="true">
          <span class={classes.dot} data-tone={tone} />
        </span>
        <p class={classes.detailText}>{detail}</p>
      </div>
      <div class={classes.actions}>{actions}</div>
    </div>
  );
}
