import * as v from "valibot";

/**
 * Runtime-validated shapes for everything the server sends the chat UI.
 * These schemas are the single source of truth: TypeScript types below are
 * derived from them, events are validated once at the socket boundary, and
 * the four sync-engine fetches are validated on receipt. Anything else is a
 * type error at compile time or a loud, logged drop at runtime — never a
 * silent `undefined` deep in a view.
 *
 * Contracts: `server/src/conversations/{mod,events,artifacts}.rs`,
 * `server/src/providers/types.rs`.
 * Objects strip unknown keys, so the server can add fields without breaking
 * old clients; wrong types or missing required fields fail loudly.
 */

const ModelRefSchema = v.object({ profileId: v.string(), modelId: v.string() });
export type ModelRef = v.InferOutput<typeof ModelRefSchema>;

const ConversationUsageSchema = v.object({
  input: v.number(),
  output: v.number(),
  cachedRead: v.number(),
  cachedWrite: v.number(),
});
export type ConversationUsage = v.InferOutput<typeof ConversationUsageSchema>;

const MessageAttachmentSchema = v.object({
  index: v.number(),
  hash: v.string(),
  name: v.string(),
  mimeType: v.string(),
  bytes: v.number(),
  width: v.optional(v.nullable(v.number())),
  height: v.optional(v.nullable(v.number())),
});
export type MessageAttachment = v.InferOutput<typeof MessageAttachmentSchema>;

const ToolCallStatusSchema = v.picklist([
  "pending",
  "running",
  "completed",
  "error",
  "skipped",
  "interrupted",
]);
export type ToolCallStatus = v.InferOutput<typeof ToolCallStatusSchema>;

const ConversationToolCallSchema = v.object({
  id: v.string(),
  messageId: v.string(),
  callId: v.string(),
  tool: v.string(),
  label: v.string(),
  pluginId: v.nullable(v.string()),
  action: v.optional(v.nullable(v.string())),
  args: v.unknown(),
  result: v.unknown(),
  status: ToolCallStatusSchema,
  mutative: v.boolean(),
  error: v.nullable(v.string()),
  startedAt: v.nullable(v.string()),
  finishedAt: v.nullable(v.string()),
  durationMs: v.nullable(v.number()),
});
export type ConversationToolCall = v.InferOutput<typeof ConversationToolCallSchema>;

const ConversationContentPartSchema = v.union([
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("reasoning"),
    opaque: v.optional(v.unknown()),
    text: v.optional(v.string()),
  }),
  v.object({ type: v.literal("image"), url: v.string() }),
  v.object({ type: v.literal("providerState"), data: v.unknown() }),
  v.object({
    type: v.literal("toolCall"),
    id: v.string(),
    name: v.string(),
    args: v.unknown(),
  }),
  v.object({
    type: v.literal("toolResult"),
    callId: v.string(),
    content: v.string(),
    isError: v.boolean(),
  }),
]);
export type ConversationContentPart = v.InferOutput<typeof ConversationContentPartSchema>;

const ConversationMessageSchema = v.object({
  id: v.string(),
  clientMessageId: v.nullable(v.string()),
  epochId: v.nullable(v.string()),
  seq: v.nullable(v.number()),
  role: v.picklist(["user", "assistant", "system"]),
  createdAt: v.string(),
  responseStartedAt: v.nullable(v.string()),
  model: v.nullable(ModelRefSchema),
  parts: v.array(ConversationContentPartSchema),
  usage: v.nullable(ConversationUsageSchema),
  status: v.picklist(["complete", "queued"]),
  toolCalls: v.optional(v.array(ConversationToolCallSchema)),
  attachments: v.array(MessageAttachmentSchema),
  editable: v.boolean(),
  hasReasoning: v.boolean(),
  joinedRun: v.boolean(),
});
export type ConversationMessage = v.InferOutput<typeof ConversationMessageSchema>;

const ExecutionStatusSchema = v.picklist(["idle", "running", "stopped", "error", "interrupted"]);
export type ExecutionStatus = v.InferOutput<typeof ExecutionStatusSchema>;

const DesktopConversationSchema = v.object({
  activeEpochStartSeq: v.number(),
  lastSeq: v.number(),
  id: v.string(),
  title: v.string(),
  titleSource: v.picklist(["none", "auto", "user"]),
  createdAt: v.string(),
  updatedAt: v.string(),
  currentModel: v.nullable(ModelRefSchema),
  executionStatus: ExecutionStatusSchema,
  executionStartedAt: v.nullable(v.string()),
  executionError: v.nullable(v.string()),
  preview: v.nullable(v.string()),
  titleHighlight: v.nullable(v.string()),
  matchExcerpt: v.nullable(v.string()),
  lastSeenSeq: v.number(),
  unread: v.boolean(),
  branchedFromConversation: v.nullable(v.string()),
  branchedFromMessage: v.nullable(v.string()),
});
export type DesktopConversation = v.InferOutput<typeof DesktopConversationSchema>;

const ConversationJobSchema = v.object({
  id: v.string(),
  action: v.string(),
  label: v.string(),
  pluginId: v.nullable(v.string()),
  state: v.picklist(["running", "completed", "error", "cancelled", "interrupted"]),
  startedAt: v.string(),
  finishedAt: v.nullable(v.string()),
});
export type ConversationJob = v.InferOutput<typeof ConversationJobSchema>;

const LiveActivitySchema = v.union([
  v.object({ kind: v.literal("thinking") }),
  v.object({ kind: v.literal("compacting") }),
  v.object({
    kind: v.literal("tool"),
    toolCallId: v.string(),
    tool: v.string(),
    label: v.string(),
    pluginId: v.nullable(v.string()),
  }),
]);
export type LiveActivity = v.InferOutput<typeof LiveActivitySchema>;

const ConversationSnapshotSchema = v.object({
  conversation: DesktopConversationSchema,
  messages: v.array(ConversationMessageSchema),
  queued: v.array(ConversationMessageSchema),
  jobs: v.array(ConversationJobSchema),
  live: v.nullable(LiveActivitySchema),
  nextBefore: v.nullable(v.number()),
  revision: v.number(),
});
export type ConversationSnapshot = v.InferOutput<typeof ConversationSnapshotSchema>;

const ConversationListResponseSchema = v.object({
  conversations: v.array(DesktopConversationSchema),
  revisions: v.record(v.string(), v.number()),
  nextCursor: v.nullable(v.string()),
});
export type ConversationListResponse = v.InferOutput<typeof ConversationListResponseSchema>;

const MessagePageSchema = v.object({
  messages: v.array(ConversationMessageSchema),
  nextBefore: v.nullable(v.number()),
});
export type MessagePage = v.InferOutput<typeof MessagePageSchema>;

/** Shared envelope the server attaches to conversation events. */
const conversationEnvelopeEntries = {
  conversationId: v.string(),
  revision: v.optional(v.number()),
  conversation: v.optional(v.nullable(DesktopConversationSchema)),
  message: v.optional(v.nullable(ConversationMessageSchema)),
  toolCall: v.optional(v.nullable(ConversationToolCallSchema)),
  queued: v.optional(v.array(ConversationMessageSchema)),
  jobs: v.optional(v.array(ConversationJobSchema)),
  live: v.optional(v.nullable(LiveActivitySchema)),
};

function conversationEvent<Type extends string>(type: Type) {
  return v.object({ type: v.literal(type), ...conversationEnvelopeEntries });
}

const conversationEventSchemas = [
  conversationEvent("model.started"),
  conversationEvent("model.finished"),
  conversationEvent("execution.started"),
  conversationEvent("execution.finished"),
  conversationEvent("conversation.updated"),
  conversationEvent("message.appended"),
  conversationEvent("queue.updated"),
  conversationEvent("tool.started"),
  conversationEvent("tool.finished"),
  conversationEvent("compaction.updated"),
  conversationEvent("transcript.replaced"),
] as const;

export const CONVERSATION_EVENTS = conversationEventSchemas.map(
  (schema) => schema.entries.type.literal,
);

const DesktopMessageSchema = v.variant("type", [
  ...conversationEventSchemas,
  v.object({
    type: v.literal("model.reasoning.delta"),
    conversationId: v.string(),
    delta: v.string(),
  }),
  v.object({ type: v.literal("activity"), threadId: v.optional(v.string()) }),
  v.object({ type: v.literal("resync") }),
  v.object({
    type: v.literal("marketplace.operations"),
    operation: v.object({
      id: v.string(),
      integrationId: v.string(),
      status: v.picklist(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]),
      phase: v.string(),
      percent: v.nullable(v.number()),
      error: v.nullable(v.string()),
      createdAt: v.number(),
      finishedAt: v.nullable(v.number()),
    }),
  }),
  v.object({ type: v.literal("plugins.changed") }),
  v.object({ type: v.literal("account") }),
  v.object({ type: v.literal("remote") }),
  v.object({
    type: v.literal("browser.tabs.changed"),
    scope: v.optional(v.string()),
    metadataOnly: v.optional(v.boolean()),
  }),
  v.object({ type: v.literal("connection.opened") }),
]);
export type DesktopMessage = v.InferOutput<typeof DesktopMessageSchema>;

/** Every conversation-scoped event carries the synchronization envelope. */
export type ConversationEvent = Exclude<
  Extract<DesktopMessage, { conversationId: string }>,
  { type: "model.reasoning.delta" }
>;

/** Narrow a desktop event by its type tag. */
export type DesktopMessageOf<Type extends DesktopMessage["type"]> = Extract<
  DesktopMessage,
  { type: Type }
>;

/** The locally synthesized reconnect event. */
export type ConnectionOpenedEvent = DesktopMessageOf<"connection.opened">;

/**
 * DOM delivery vehicle for a validated socket message. The DOM type string is
 * the message type, so existing per-type listeners keep working; receivers
 * narrow with instanceof and read an exact payload — no casts, no `detail`.
 */
export class DesktopEvent extends Event {
  constructor(readonly message: DesktopMessage) {
    super(message.type);
  }
}

/**
 * Validate one inbound socket message. Throws a loud error naming the bad
 * field; callers log and drop the message without touching state.
 */
export function parseDesktopMessage(data: unknown): DesktopMessage {
  return v.parse(DesktopMessageSchema, data);
}

export {
  ConversationJobSchema,
  ConversationListResponseSchema,
  ConversationMessageSchema,
  ConversationSnapshotSchema,
  ConversationToolCallSchema,
  DesktopConversationSchema,
  LiveActivitySchema,
  MessagePageSchema,
  ModelRefSchema,
};
