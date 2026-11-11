import { Await, Cell, If } from "retend";
import { useRouteQuery } from "retend/router";

import {
  FileToolDetails,
  fileToolKind,
  prepareFileToolDetails,
} from "@/components/ui/FileToolDetails";
import {
  ParallelToolDetails,
  prepareParallelToolDetails,
} from "@/components/ui/ParallelToolDetails";
import { SkillToolDetails } from "@/components/ui/SkillToolDetails";
import { ToolValue } from "@/components/ui/ToolValue";
import { type ToolCallPayload, getConversationCall } from "@/platform/desktopClient";
import type { ConversationToolCall, ToolCallStatus } from "@/platform/desktopEvents";

import {
  actionPluginId,
  formatStepDuration,
  resultAttachments,
  resultText,
  toolIcon,
} from "./chatModel";
import { ToolAttachments } from "./WorkLogPayloads";
import { ToolStep } from "./WorkLogToolStep";

import classes from "./WorkLog.module.css";

const OUTCOMES: Partial<Record<ToolCallStatus, string>> = {
  pending: "Waiting",
  running: "Running",
  error: "Failed",
  skipped: "Skipped",
  interrupted: "Outcome unknown",
};

/** Selectable execution row; details open in the side panel. */
interface ToolCallStepProps {
  call: Cell<ConversationToolCall>;
}

export function ToolCallStep(props: ToolCallStepProps) {
  const { call } = props;
  const query = useRouteQuery();
  const selected = query.get("step");
  const key = `tool:${call.get().id}`;
  const active = Cell.derived(() => selected.get() === key);
  const status = Cell.derived(() => call.get().status);
  const label = Cell.derived(() => call.get().label);
  const title = Cell.derived(() => `Inspect ${call.get().label}`);
  const icon = Cell.derived(() => toolIcon(call.get().tool));
  const pluginId = Cell.derived(() => actionPluginId(call.get()));
  const actionName = Cell.derived(() => {
    const current = call.get();
    return current.tool === "use_action" ? (current.action ?? null) : null;
  });
  const outcome = Cell.derived(() => {
    const current = call.get();
    return (
      OUTCOMES[current.status] ??
      (current.durationMs === null ? "" : formatStepDuration(current.durationMs))
    );
  });
  // Clicking the open step again closes the panel, like the Activity view.
  const togglePanel = () => {
    void (active.get() ? query.delete("step") : query.set("step", key));
  };
  return (
    <ToolStep
      label={label}
      icon={icon}
      status={status}
      pluginId={pluginId}
      selected={active}
      title={title}
      outcome={outcome}
      onSelect={togglePanel}
    >
      {If(actionName, (action) => (
        <span class={classes.toolActionName} title={action}>
          {action}
        </span>
      ))}
    </ToolStep>
  );
}

interface ToolPayloadProps {
  call: ConversationToolCall;
  conversationId: string;
  initial?: ToolCallPayload;
}

/** Structured tool-call viewer with file and parallel-call support. */
export function ToolPayload(props: ToolPayloadProps) {
  const { call, conversationId, initial } = props;
  const detail = Cell.derivedAsync(async (_get, signal) => {
    const payload = initial ?? (await getConversationCall(conversationId, call.id, signal));
    const result = payload.result;
    const raw =
      result !== null && typeof result === "object" && "structuredContent" in result
        ? result.structuredContent
        : null;
    const output = call.error ?? (raw === null || raw === undefined ? resultText(result) : raw);
    const kind = fileToolKind(call.tool);
    // Prepare file preview tokens with the call so the panel renders complete content.
    const parallel =
      call.tool === "multi_tool_use_parallel"
        ? await prepareParallelToolDetails({
            calls:
              payload.args !== null && typeof payload.args === "object" && "calls" in payload.args
                ? payload.args.calls
                : null,
            output: raw,
            status: call.status,
            error: call.error,
          })
        : null;
    const file =
      kind === null
        ? null
        : await prepareFileToolDetails({
            kind,
            args: payload.args,
            output: raw,
            status: call.status,
            error: call.error,
          });
    return { payload, output, file, parallel };
  });
  const error = Cell.derived(() => detail.error.get()?.message ?? null);
  return (
    <Await
      fallback={
        <p class={classes.io}>
          {If(error, {
            true: () => (
              <>
                <span>{error}</span>
                <button type="button" onClick={() => detail.revalidate()}>
                  Retry
                </button>
              </>
            ),
            false: () => "Loading call details…",
          })}
        </p>
      }
    >
      {If(detail, (data) => {
        const { payload, output, file, parallel } = data;
        const attachments = resultAttachments(payload.result);
        const skills = call.tool === "use_skills";
        const plain = file === null && parallel === null && !skills;
        return (
          <>
            {If(parallel, (prepared) => (
              <ParallelToolDetails prepared={prepared} />
            ))}
            {If(file, (prepared) => (
              <FileToolDetails prepared={prepared} />
            ))}
            {If(skills, () => (
              <SkillToolDetails
                args={payload.args}
                output={output}
                status={call.status}
                error={call.error}
              />
            ))}
            {If(plain, () => (
              <>
                <section class={classes.io}>
                  <h3 class={classes.ioHeading}>Input</h3>
                  <ToolValue value={payload.args} />
                </section>
                {If(output !== "", () => (
                  <section class={classes.io}>
                    <h3 class={classes.ioHeading}>Output</h3>
                    <ToolValue value={output} error={call.error !== null} />
                  </section>
                ))}
              </>
            ))}
            {If(attachments.length > 0, () => (
              <ToolAttachments attachments={attachments} />
            ))}
          </>
        );
      })}
    </Await>
  );
}
