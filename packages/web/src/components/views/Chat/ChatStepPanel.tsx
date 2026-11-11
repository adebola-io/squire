import { Cell, For, If } from "retend";
import { useRouteQuery } from "retend/router";

import { type PanelContent, preparedPanel } from "@/components/ui/RightPanel/RightPanel";
import { getConversationCall, type ToolCallPayload } from "@/platform/desktopClient";
import type { ToolCallStatus } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { type LogStep, toTurns, workSteps } from "./chatModel";
import { ChatToolIcon } from "./ChatToolIcon";
import { Markdown } from "./Markdown";
import { ToolPayload } from "./WorkLogParts";

import activityClasses from "../Activity/Activity.module.css";
import classes from "./WorkLog.module.css";

/** Select execution steps through the URL so links and history restore the selection. */
export function useWorkStepPanel() {
  const { selectedId, snapshot } = useChat();
  const query = useRouteQuery();
  const selected = query.get("step");
  const content = Cell.derived((): PanelContent | null => {
    const conversationId = selectedId.get();
    const stepId = selected.get();
    if (conversationId === null || stepId === null) return null;
    return preparedPanel(
      `${conversationId}:${stepId}`,
      async (signal): Promise<PreparedStep | null> => {
        const current = snapshot.peek();
        if (current?.conversation.id !== conversationId) return null;
        const turns = toTurns(current.messages);
        const step = turns
          .flatMap((turn, index) =>
            workSteps(
              turn,
              index !== turns.length - 1 || current.conversation.executionStatus !== "running",
            ),
          )
          .find((entry) => matches(entry, stepId));
        if (step?.kind !== "tool") return null;
        return {
          payload: await getConversationCall(conversationId, step.call.id, signal),
          status: step.call.status,
        };
      },
      (prepared) => (
        <ChatStepPanel conversationId={conversationId} stepId={stepId} prepared={prepared} />
      ),
    );
  });
  const close = () => void query.delete("step");
  return { content, close };
}

function matches(step: LogStep, id: string) {
  return step.kind === "tool" ? id === `tool:${step.call.id}` : id === step.key;
}

interface PreparedStep {
  payload: ToolCallPayload;
  status: ToolCallStatus;
}

interface ChatStepPanelProps {
  conversationId: string;
  stepId: string;
  prepared: PreparedStep | null;
}

/** Reuse the connection tool-call layout without loading a separate activity session. */
function ChatStepPanel(props: ChatStepPanelProps) {
  const { conversationId, stepId, prepared } = props;
  const { snapshot } = useChat();
  const selected = Cell.derived(() => {
    const current = snapshot.get();
    if (current === null || current.conversation.id !== conversationId) return [];
    const turns = toTurns(current.messages);
    for (const [index, turn] of turns.entries()) {
      const complete =
        index !== turns.length - 1 || current.conversation.executionStatus !== "running";
      const step = workSteps(turn, complete).find((entry) => matches(entry, stepId));
      if (step !== undefined) {
        // Refresh the inspector when a running call completes.
        const key = step.kind === "tool" ? `${stepId}:${step.call.status}` : stepId;
        return [{ key, step }];
      }
    }
    return [];
  });
  const missing = Cell.derived(() => selected.get().length === 0);
  return (
    <div class={activityClasses.toolCallPanel}>
      {For(
        selected,
        ({ step }) => (
          <StepDetail step={step} conversationId={conversationId} prepared={prepared} />
        ),
        { key: "key" },
      )}
      {If(missing, () => (
        <p class={classes.inspectorMissing}>
          This step is not in the currently loaded history. Load earlier chat messages to inspect
          it.
        </p>
      ))}
    </div>
  );
}

interface StepDetailProps {
  step: LogStep;
  conversationId: string;
  prepared: PreparedStep | null;
}

function StepDetail(props: StepDetailProps) {
  const { step, conversationId, prepared } = props;
  if (step.kind === "tool") {
    const { call } = step;
    const duration = call.durationMs === null ? "In progress" : `${call.durationMs}ms`;
    const initial = prepared?.status === call.status ? prepared.payload : undefined;
    return (
      <>
        <header class={activityClasses.toolCallPanelHeader}>
          <h2 class={activityClasses.toolCallPanelTitle}>{call.label}</h2>
          <span
            class={[activityClasses.toolCallStatus, activityClasses.toolCallPanelStatus]}
            data-status={call.status}
          >
            {call.status}
          </span>
          <p class={activityClasses.toolCallPanelTool}>{call.tool}</p>
          <p class={activityClasses.toolCallPanelMetadata}>
            <ChatToolIcon name="plugin" />
            {duration}
          </p>
        </header>
        <ToolPayload call={call} conversationId={conversationId} initial={initial} />
      </>
    );
  }

  const title = step.kind === "message" ? "Progress update" : "Completed";

  const description = "Execution completed.";
  const body =
    step.kind === "message" ? (
      <div class={classes.inspectorMessage}>
        <Markdown text={step.text} />
      </div>
    ) : (
      <p class={classes.inspectorMissing}>{description}</p>
    );
  return (
    <>
      <header class={activityClasses.toolCallPanelHeader}>
        <h2 class={activityClasses.toolCallPanelTitle}>{title}</h2>
      </header>
      {body}
    </>
  );
}
