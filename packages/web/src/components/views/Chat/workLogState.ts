import { Cell } from "retend";

import { useChat } from "@/scopes/ChatScope";

import { type LogStep, type Turn, workSteps } from "./chatModel";

export type LogEntry = LogStep | { key: string; kind: "earlier"; count: number | null };

// Keep mounting costs bounded even when a single running turn has hundreds of tool calls.
const PAGE_SIZE = 24;

/**
 * Derive a turn's execution log from the supplied turn to avoid rebuilding all turns for each
 * historical row.
 */
export function useInlineWorkState(turn: Cell<Turn>, isLast: Cell<boolean>) {
  const { snapshot, live, liveReasoning, loadOlderMessages, loadingOlderMessages } = useChat();
  const rendered = Cell.source(PAGE_SIZE);
  const completed = Cell.derived(() => {
    return !isLast.get() || snapshot.get()?.conversation.executionStatus !== "running";
  });
  const executing = Cell.derived(() => !completed.get());
  const steps = Cell.derived(() => workSteps(turn.get(), completed.get()));
  // Mount the step when the model starts, without waiting for its first reasoning token.
  // Keep it through the brief gap between model.finished and message.appended.
  const showLiveReasoning = Cell.derived(
    () => !completed.get() && (live.get()?.kind === "thinking" || liveReasoning.get() !== ""),
  );
  const hasWork = Cell.derived(
    () => showLiveReasoning.get() || steps.get().some((step) => step.kind !== "done"),
  );
  const hasEarlier = Cell.derived(() => {
    const current = snapshot.get();
    return turn.get().users.length === 0 && current !== null && current.nextBefore !== null;
  });
  const showEarlier = () => {
    if (loadingOlderMessages.get()) return;
    const limit = rendered.get();
    if (steps.get().length > limit) {
      rendered.set(limit + PAGE_SIZE);
    } else if (hasEarlier.get()) {
      rendered.set(limit + PAGE_SIZE);
      void loadOlderMessages();
    }
  };

  const entries = Cell.derived((): LogEntry[] => {
    const current = turn.get();
    const all: LogStep[] = showLiveReasoning.get()
      ? [
          ...steps.get(),
          {
            key: `reasoning:${current.id}:${current.replies.length}`,
            kind: "reasoning",
            live: true,
          },
        ]
      : steps.get();
    const hidden = all.length - rendered.get();
    if (hidden <= 0 && !hasEarlier.get()) return all;
    return [
      {
        key: `earlier:${hidden}:${hasEarlier.get()}`,
        kind: "earlier",
        count: hidden > 0 ? Math.min(hidden, PAGE_SIZE) : null,
      },
      ...all.slice(-rendered.get()),
    ];
  });

  return {
    entries,
    hasWork,
    executing,
    showEarlier,
    loadingEarlier: loadingOlderMessages,
  };
}

export type InlineWorkState = ReturnType<typeof useInlineWorkState>;
