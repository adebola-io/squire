import { Cell } from "retend";
import { Icon } from "squire-ui";

import { useChat } from "@/scopes/ChatScope";

import { CopyButton } from "./CopyButton";
import type { ReplyPane } from "./replyState";

import classes from "./Chat.module.css";

interface ReplyActionsProps {
  pane: ReplyPane;
}

/** Copy and branch controls for a completed reply. */
export function ReplyActions(props: ReplyActionsProps) {
  const { pane } = props;
  const { branch, busy, snapshot } = useChat();
  const branchDisabled = Cell.derived(() => {
    return busy.get() || snapshot.get()?.conversation.executionStatus === "running";
  });

  const copyText = () => {
    return pane.text;
  };
  const branchHere = async () => {
    if (pane.messageId !== null) {
      await branch(pane.messageId);
    }
  };

  return (
    <>
      <CopyButton text={copyText} label="Copy reply" />
      <button
        type="button"
        class={classes.actionButton}
        disabled={branchDisabled}
        onClick={branchHere}
        title="Branch into a new chat from this reply"
        aria-label="Branch into a new chat from this reply"
      >
        <Icon name="branch" aria-hidden="true" />
      </button>
    </>
  );
}
