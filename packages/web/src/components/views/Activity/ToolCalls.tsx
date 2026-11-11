import { Cell, For, If } from "retend";
import { Button } from "squire-ui";

import { useThreadCalls } from "./threadCalls";
import { ToolCall, type ToolCallName } from "./ToolCall";

import classes from "./Activity.module.css";

interface ToolCallsProps {
  open: Cell<boolean>;
  threadId: string;
}

export interface ActivityAttachment {
  name?: string;
  hash: string;
  url: string;
  mimeType: string;
}

export interface ActivityError {
  message: string;
}

export interface ActivityResult {
  structuredContent?: Record<string, unknown>;
  attachments?: ActivityAttachment[];
  error?: ActivityError;
}

/** Tool-call summary without arguments or results. */
export interface ToolCallType {
  id: string;
  tool: ToolCallName;
  description: string;
  command: string | null;
  cwd: string | null;
  metadata: string | null;
  error: string | null;
  status: "completed" | "error" | "running";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  source: "mcp" | "tool_api" | "internal";
  threadId: string;
}

/** Full tool-call data loaded when the details panel opens. */
export interface ToolCallDetail extends ToolCallType {
  args: Record<string, unknown>;
  result: ActivityResult | null;
}

export function ToolCalls(props: ToolCallsProps) {
  const { open, threadId } = props;
  const { toolCalls, maxToolCalls, hasOlder, loadingOlder, olderError, revealFrom, showOlder } =
    useThreadCalls(open, threadId);

  return (
    <div class={classes.toolCallsContainer}>
      {If(olderError, (message) => (
        <p role="alert">{message}</p>
      ))}
      <ul class={classes.toolCallList} style={{ "--max-tool-calls": maxToolCalls }}>
        {For(
          toolCalls,
          (item, index) => {
            // Retain the initial value until `For` removes a row from a shrinking list.
            const call = Cell.derivedAsync(
              async (get) => (await get(toolCalls))[get(index)] ?? item,
            );
            return <ToolCall id={item.id} call={call} index={index} revealFrom={revealFrom} />;
          },
          { key: "id" },
        )}
      </ul>
      {If(hasOlder, () => (
        <Button
          variant="ghost"
          class={classes.toolCallsMoreButton}
          type="button"
          onClick={showOlder}
          disabled={loadingOlder}
        >
          Show Older
        </Button>
      ))}
    </div>
  );
}
