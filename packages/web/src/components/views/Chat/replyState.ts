import { Cell } from "retend";

import { useChat } from "@/scopes/ChatScope";

import { finalReply, formatDuration, messageText, turnStartedAt, type Turn } from "./chatModel";
import { prepareReplyMarkdown } from "./markdownRender";

/**
 * A `continued` reply ended when a follow-up joined the active run. It retains its execution
 * log but has no final answer.
 */
export type Phase = "working" | "done" | "continued" | "stopped" | "unanswered" | "error";

export interface ReplyPane {
  key: string;
  phase: Phase;
  text: string;
  messageId: string | null;
  reveal: boolean;
}

function phaseOf(
  hasFinal: boolean,
  isLast: boolean,
  status: string | undefined,
  joinedFollowUp: boolean,
): Phase {
  if (hasFinal) return "done";
  if (joinedFollowUp) return "continued";
  if (!isLast) return "stopped";
  if (status === "running") return "working";
  if (status === "error" || status === "interrupted") return "error";
  if (status === "idle") return "unanswered";
  return "stopped";
}

/**
 * Derive reply state and actions. `joinedFollowUp` ends this turn's work at the follow-up
 * timestamp and assigns subsequent output to the next turn.
 */
export function useReplyState(
  turn: Cell<Turn>,
  isLast: Cell<boolean>,
  entering: boolean,
  joinedFollowUp: Cell<string | null>,
) {
  const { snapshot } = useChat();
  let shownFinalId: string | null = null;
  const final = Cell.derived(() => {
    const answer = finalReply(turn.get());
    const running = snapshot.get()?.conversation.executionStatus === "running";
    // Execution can become running before keyed turn indices update. Preserve an already
    // displayed answer during that interval.
    if (running && isLast.get() && answer?.id !== shownFinalId) return null;
    if (answer !== null) shownFinalId = answer.id;
    return answer;
  });
  const phase = Cell.derived(() =>
    phaseOf(
      final.get() !== null,
      isLast.get(),
      snapshot.get()?.conversation.executionStatus,
      joinedFollowUp.get() !== null,
    ),
  );
  // Each turn starts no earlier than its own user message entering the transcript.
  // A queued follow-up can join an existing run, whose conversation-wide executionStartedAt
  // still belongs to the previous turn. Branched runs may instead start after an older message.
  // Retain the resolved start when the turn ends so subsequent runs cannot reset its duration.
  let observedExecutionStart: number | null = null;
  const startedAt = Cell.derived(() => {
    const userStart = turnStartedAt(turn.get());
    const conversation = snapshot.get()?.conversation;
    // Do not apply a new run's start time to the previous turn before the new turn is indexed.
    if (
      isLast.get() &&
      (conversation?.executionStatus !== "running" || phase.get() === "working")
    ) {
      const stamp = conversation?.executionStartedAt;
      if (stamp) {
        const parsed = Date.parse(stamp);
        if (Number.isFinite(parsed)) observedExecutionStart = Math.max(parsed, userStart);
      }
    }
    return Math.max(observedExecutionStart ?? userStart, userStart);
  });
  const errorText = Cell.derived(
    () => snapshot.get()?.conversation.executionError ?? "Squire stopped with an error.",
  );
  const workedFor = Cell.derived(() => {
    // A speculative model stream can precede tool calls. Only a durable final answer
    // or the next joined follow-up closes this turn's elapsed work duration.
    const joined = joinedFollowUp.get();
    const answer = final.get();
    const until =
      joined !== null ? Date.parse(joined) : answer === null ? null : Date.parse(answer.createdAt);
    return until === null ? "" : `Worked for ${formatDuration(until - startedAt.get())}`;
  });

  let sawWorking = entering;
  const preparedAnswer = Cell.source<string | null>(null);
  let preparingId: string | null = null;
  // Highlight a newly completed answer ahead of mounting it, so the reply arrives already
  // rendered instead of filling in after the pane appears.
  const pane = Cell.derived((): ReplyPane => {
    const currentPhase = phase.get();
    const answer = final.get();
    if (currentPhase === "working") sawWorking = true;
    if (currentPhase === "done" && answer !== null) {
      const text = messageText(answer);
      return {
        key: `done:${answer.id}`,
        phase: "done",
        text,
        messageId: answer.id,
        reveal: sawWorking,
      };
    }
    return {
      key: currentPhase,
      phase: currentPhase,
      text: "",
      messageId: null,
      reveal: false,
    };
  });

  const bodyPanes = Cell.derived(() => {
    const current = pane.get();
    if (current.phase === "done" && sawWorking && preparedAnswer.get() !== current.messageId) {
      return [];
    }
    return current.phase === "done" || current.phase === "error" ? [current] : [];
  });
  // Mount actions with the prepared answer, not ahead of it.
  const actionPanes = Cell.derived(() =>
    bodyPanes.get().filter((current) => current.phase === "done"),
  );

  const prepare = (answer: ReturnType<typeof finalReply>) => {
    if (answer === null || !sawWorking || preparingId === answer.id) return;
    preparingId = answer.id;
    void prepareReplyMarkdown(messageText(answer))
      .catch(() => undefined)
      .then(() => {
        if (preparingId === answer.id) preparedAnswer.set(answer.id);
      });
  };
  final.listen(prepare);
  // `listen` reports only later changes. A turn can mount with its answer already present
  // (a refetch after reconnecting delivers both at once), and that answer needs preparing too.
  prepare(final.get());

  return {
    errorText,
    workedFor,
    phase,
    bodyPanes,
    actionPanes,
  };
}

export type ReplyState = ReturnType<typeof useReplyState>;
