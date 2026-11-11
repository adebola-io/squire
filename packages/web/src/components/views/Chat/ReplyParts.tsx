import { Cell, If } from "retend";
import { Icon } from "squire-ui";

import { Markdown } from "./Markdown";
import type { Phase, ReplyPane, ReplyState } from "./replyState";

import classes from "./Chat.module.css";

interface ReplyPartProps {
  pane: ReplyPane;
  reply: ReplyState;
}

interface ReplyHeaderProps {
  phase: Cell<Phase>;
  reply: ReplyState;
  hasWork: Cell<boolean>;
  open: Cell<boolean>;
  onToggle: () => void;
}

/** Stable work status; reasoning and individual actions belong in the Work Log. */
export function ReplyHeader(props: ReplyHeaderProps) {
  const { phase, reply, hasWork, open, onToggle } = props;
  const expanded = Cell.derived(() => String(hasWork.get() && open.get()));
  const disabled = Cell.derived(() => !hasWork.get());
  const toggleTitle = Cell.derived(() => (hasWork.get() ? "Show or hide execution history" : ""));
  const label = Cell.derived(() => {
    switch (phase.get()) {
      case "working":
        return "Working";
      case "done":
      case "continued":
        return reply.workedFor.get();
      case "error":
        return "Ended with an error";
      case "unanswered":
        return "Ended without an answer";
      default:
        return "Stopped";
    }
  });
  return (
    <div class={classes.replyHeader} data-phase={phase}>
      <button
        type="button"
        class={classes.workToggle}
        disabled={disabled}
        aria-expanded={expanded}
        aria-label="Toggle execution history"
        title={toggleTitle}
        onClick={onToggle}
      >
        <span class={classes.workStatus} role="status" aria-live="polite">
          {label}
        </span>
        {If(hasWork, () => (
          <span class={classes.workToggleMarker} aria-hidden="true">
            <Icon name="caret" class={classes.workToggleCaret} />
          </span>
        ))}
      </button>
    </div>
  );
}

export function ReplyBody(props: ReplyPartProps) {
  const { pane, reply } = props;
  switch (pane.phase) {
    case "done":
      return <Markdown text={pane.text} interactive />;
    case "error":
      return (
        <p class={classes.replyError} role="alert">
          {reply.errorText}
        </p>
      );
    default:
      return [];
  }
}
