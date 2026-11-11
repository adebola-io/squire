import { Cell } from "retend";

import { ChatToolIcon } from "./ChatToolIcon";
import { EarlierSteps } from "./EarlierSteps";
import { Markdown } from "./Markdown";
import { ToolCallStep } from "./WorkLogParts";
import { ReasoningStep } from "./WorkLogReasoning";
import type { LogEntry } from "./workLogState";

import classes from "./WorkLog.module.css";

interface LogStepItemProps {
  entry: Cell<LogEntry>;
  loadingEarlier: Cell<boolean>;
  onShowEarlier: () => void;
}

/** Keep execution rows mounted and open details in the side panel. */
export function LogStepItem(props: LogStepItemProps) {
  const { entry, loadingEarlier, onShowEarlier } = props;
  const current = entry.get();

  switch (current.kind) {
    case "tool": {
      const call = Cell.derived(() => {
        const latest = entry.get();
        return latest.kind === "tool" ? latest.call : current.call;
      });
      return <ToolCallStep call={call} />;
    }
    case "reasoning":
      return <ReasoningStep entry={entry} />;
    case "earlier":
      return <EarlierSteps count={current.count} loading={loadingEarlier} onShow={onShowEarlier} />;
    case "message":
      return (
        <li class={classes.step} data-kind="message">
          <span class={classes.marker} aria-hidden="true">
            <span class={classes.milestone} />
          </span>
          <div class={classes.stepMessage}>
            <div class={classes.stepMarkdown}>
              <Markdown text={current.text} />
            </div>
          </div>
        </li>
      );
    case "done":
      return (
        <li class={classes.step} data-kind="done">
          <span class={classes.marker}>
            <ChatToolIcon name="checkmark" />
          </span>
          <div class={classes.body}>
            <p class={classes.stepTitle}>Done</p>
          </div>
        </li>
      );
  }
}
