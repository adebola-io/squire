import { differenceInCalendarDays } from "date-fns";
import type { IconName } from "squire-ui";

import type {
  ConversationMessage,
  ConversationToolCall,
  DesktopConversation,
} from "@/platform/desktopEvents";
import { asRecord } from "@/utils/misc";

/**
 * Extract the plugin ID from a `<plugin>.<action>` name when a job has no explicit plugin ID.
 */
export function actionPluginIdFromName(action: string): string | null {
  const dot = action.indexOf(".");
  return dot > 0 ? action.slice(0, dot) : null;
}

export function actionPluginId(call: ConversationToolCall): string | null {
  if (call.pluginId !== undefined && call.pluginId !== null) return call.pluginId;
  const args = call.args;
  if (
    call.tool !== "use_action" ||
    args === null ||
    typeof args !== "object" ||
    !("action" in args) ||
    typeof args.action !== "string"
  ) {
    return null;
  }
  return actionPluginIdFromName(args.action);
}

/** User messages and assistant work grouped into one turn. */
export interface Turn {
  id: string;
  users: ConversationMessage[];
  replies: ConversationMessage[];
}

/** Single-line message preview with Markdown markers removed. */
export function plainPreview(text: string) {
  return text
    .replace(/```/g, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/, "")
    .trim();
}

export function messageText(message: ConversationMessage) {
  return message.parts
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

/** Execution-log entry in chronological order. */
export type LogStep =
  | { key: string; kind: "message"; text: string }
  | { key: string; kind: "tool"; call: ConversationToolCall }
  | { key: string; kind: "reasoning"; messageId: string }
  | { key: string; kind: "reasoning"; live: true }
  | { key: string; kind: "done" };

/**
 * Build the work log from progress messages, reasoning and tool calls.
 * Exclude the final answer, then mark completion. User follow-ups start the next turn.
 */
export function workSteps(turn: Turn, completed = false): LogStep[] {
  // A text-only assistant message is a final answer even before the execution status
  // changes. Never briefly show it in the execution log during that event gap.
  const final = finalReply(turn);
  const steps: LogStep[] = [];
  for (const [index, reply] of turn.replies.entries()) {
    if (reply.hasReasoning) {
      steps.push({ key: `reasoning:${turn.id}:${index}`, kind: "reasoning", messageId: reply.id });
    }
    const text = messageText(reply).trim();
    if (reply !== final && text !== "") {
      steps.push({ key: `${reply.id}:message`, kind: "message", text });
    }
    for (const call of reply.toolCalls ?? []) {
      steps.push({ key: `tool:${call.id}`, kind: "tool", call });
    }
  }
  if (completed && final !== null) {
    steps.push({ key: `${final.id}:done`, kind: "done" });
  }
  return steps;
}

/** Format short durations with tenths, longer durations with minute/second precision. */
export function formatStepDuration(milliseconds: number) {
  if (milliseconds < 100) {
    return "<0.1s";
  }
  if (milliseconds < 10_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
  return formatDuration(milliseconds);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

/** Render a tool result as its error, plain text, or JSON. */
export function resultText(result: unknown) {
  if (!isRecord(result)) {
    return "";
  }
  if (isRecord(result.error) && typeof result.error.message === "string") {
    return result.error.message;
  }
  const content = result.structuredContent ?? result;
  if (isRecord(content) && typeof content.result === "string") {
    return content.result;
  }
  return JSON.stringify(content, null, 2);
}

export interface ResultAttachment {
  index: number;
  mimeType: string;
  hash: string;
}

export function resultAttachments(result: unknown): ResultAttachment[] {
  if (!isRecord(result) || !Array.isArray(result.attachments)) {
    return [];
  }
  return result.attachments.flatMap((attachment, index) => {
    if (isRecord(attachment) && typeof attachment.mimeType === "string") {
      return [
        {
          index,
          mimeType: attachment.mimeType,
          hash: typeof attachment.hash === "string" ? attachment.hash : "",
        },
      ];
    }
    return [];
  });
}

/**
 * Group user messages with subsequent assistant work. Consecutive queued messages share a turn;
 * a follow-up joining an active run starts a new turn. User messages never enter the work log.
 */
export function toTurns(messages: ConversationMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const current = turns.at(-1);
    if (message.role === "user") {
      if (current !== undefined && current.replies.length === 0) {
        current.users.push(message);
      } else {
        turns.push({ id: message.id, users: [message], replies: [] });
      }
      continue;
    }
    if (current === undefined) {
      turns.push({ id: message.id, users: [], replies: [message] });
      continue;
    }
    current.replies.push(message);
  }
  return turns;
}

/** Final text-only reply that ends the turn. */
export function finalReply(turn: Turn) {
  const last = turn.replies.at(-1);
  if (last === undefined || (last.toolCalls ?? []).length > 0) {
    return null;
  }
  if (messageText(last).trim() === "") {
    return null;
  }
  return last;
}

/** Use the latest request timestamp, excluding follow-ups that joined an active run. */
export function turnStartedAt(turn: Turn) {
  const request =
    turn.users.findLast((user) => !user.joinedRun) ?? turn.users[0] ?? turn.replies[0];
  return Date.parse(request.responseStartedAt ?? request.createdAt);
}

export function formatDuration(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

const TOOL_ICONS: Record<string, IconName> = {
  read_files: "file",
  edit_files: "edit",
  write_files: "edit",
  delete: "trash",
  mkdir: "folder",
  get_file_tree: "grid",
  search_files: "search",
  search_file_contents: "search",
  use_skills: "info",
  read_skill_resources: "info",
  search_actions: "search",
  check_job: "clock",
  cancel_job: "cancel",
  web_search: "search",
  web_search_images: "search",
  fetch_page: "browser",
};

export function toolIcon(tool: string): IconName {
  return TOOL_ICONS[tool] ?? "plugin";
}

export interface ConversationGroup {
  label: string;
  conversations: DesktopConversation[];
}

/** Section of the sidebar history, keyed by its oldest row. */
export interface HistorySection extends ConversationGroup {
  key: string;
}

/** Parts of the day used for chats from today, as exclusive upper hour bounds. */
const DAY_PARTS = [
  { until: 5, label: "Last night" },
  { until: 12, label: "This morning" },
  { until: 17, label: "This afternoon" },
  { until: 24, label: "This evening" },
] as const;

/** Headings for the last few hours, indexed by the hour count less one. */
const HOUR_LABELS = ["An hour ago", "Two hours ago", "Three hours ago"];

const HOUR_MS = 60 * 60 * 1000;

/** Part of the day a timestamp falls in. */
function partOfDay(date: Date) {
  const hour = date.getHours();
  return DAY_PARTS.find((part) => hour < part.until) ?? DAY_PARTS[DAY_PARTS.length - 1];
}

/** Month heading for conversations older than the recent grouping. */
function monthLabel(updated: Date, now: Date) {
  const sameYear = updated.getFullYear() === now.getFullYear();
  return updated.toLocaleDateString(
    undefined,
    sameYear ? { month: "long" } : { month: "long", year: "numeric" },
  );
}

/**
 * Heading a conversation belongs under. Recent chats are named by how long ago they were or by the
 * part of the day they fell in, and older ones step through days, weeks and months.
 */
export function relativeLabel(updatedAt: string, now: Date) {
  const updated = new Date(updatedAt);
  const elapsed = now.getTime() - updated.getTime();
  if (Number.isNaN(elapsed)) return "Earlier";
  if (elapsed < HOUR_MS) return "Most Recent";

  const days = differenceInCalendarDays(now, updated);
  if (days <= 0) {
    const part = partOfDay(updated);
    // Count hours only within the stretch of the day still in progress.
    if (part === partOfDay(now)) {
      const hours = Math.round(elapsed / HOUR_MS);
      if (hours <= HOUR_LABELS.length) return HOUR_LABELS[hours - 1];
      return "A few hours ago";
    }
    return part.label;
  }

  if (days === 1) {
    const part = partOfDay(updated);
    return part.label === "This evening" || part.label === "Last night"
      ? "Last night"
      : "Yesterday";
  }
  if (days === 2) return "Two days ago";
  if (days <= 6) return "A few days ago";
  if (days <= 13) return "Last week";
  if (days <= 20) return "Two weeks ago";
  if (days <= 27) return "A few weeks ago";
  if (days <= 59) return "Last month";
  if (days <= 89) return "Two months ago";
  return monthLabel(updated, now);
}

/**
 * Preserve newest-first conversation order within labelled groups. Each group is keyed by its
 * oldest row, so it keeps its identity as newer chats arrive above it.
 */
export function groupConversations(
  conversations: DesktopConversation[],
  now: Date,
): HistorySection[] {
  const groups: HistorySection[] = [];
  for (const conversation of conversations) {
    const label = relativeLabel(conversation.updatedAt, now);
    const current = groups.at(-1);
    if (current !== undefined && current.label === label) {
      current.conversations.push(conversation);
      current.key = conversation.id;
    } else {
      groups.push({ key: conversation.id, label, conversations: [conversation] });
    }
  }
  return groups;
}

/** Time-based greeting with an optional first name. */
export function greeting(now: Date, name?: string | null) {
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  // Exclude email addresses from greetings, including legacy accounts that stored an email as
  // their name.
  const firstName = name?.includes("@") ? undefined : name?.trim().split(/\s+/)[0];
  return firstName ? `Good ${part}, ${firstName}.` : `Good ${part}.`;
}
