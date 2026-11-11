import * as v from "valibot";

import type { ConversationMessage, DesktopConversation, ModelRef } from "./desktopEvents";
import {
  ConversationListResponseSchema,
  ConversationSnapshotSchema,
  MessagePageSchema,
} from "./desktopEvents";

function desktopErrorMessage(body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return body;
    const error = parsed.error;
    return typeof error === "string" ? error : body;
  } catch {
    return body;
  }
}

export class DesktopRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DesktopRequestError";
  }
}

interface DesktopStructuredError {
  code: string;
  message: string;
}

async function desktopResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let structured: DesktopStructuredError | undefined;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.code === "string" && typeof parsed?.message === "string") {
        structured = parsed;
      }
    } catch {
      // Other desktop endpoints retain their existing text/error response.
    }
    throw new DesktopRequestError(
      structured?.message ??
        (desktopErrorMessage(body) || `Request failed with status ${response.status}`),
      response.status,
      structured?.code,
    );
  }
  return response.json();
}

async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return desktopResponse<T>(await fetch(path, init));
}

const desktopGet = <T>(path: string, signal?: AbortSignal) => desktopRequest<T>(path, { signal });
const desktopPost = <T>(path: string, body?: unknown) =>
  desktopRequest<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const desktopPostForm = <T>(path: string, body: FormData) =>
  desktopRequest<T>(path, { method: "POST", body });

interface OnboardingStatus {
  pending: boolean;
}
export const getOnboardingStatus = () => desktopGet<OnboardingStatus>("/desktop/onboarding");
export const completeOnboarding = () => desktopPost<OnboardingStatus>("/desktop/onboarding");

interface DesktopSettingsPorts {
  web: number;
}

interface DesktopSettingsLimits {
  connectionPayloadRetentionDays: number;
  maxFileSizeBytes: number;
  maxReadFileSizeBytes: number;
  maxSearchLineLength: number;
  commandTimeoutMs: number;
  actionMaxRuntimeMs: number;
  commandOutputLimitBytes: number;
  treeMaxResults: number;
}

/** Persisted settings. */
export interface DesktopSettingsValues {
  ports: DesktopSettingsPorts;
  limits: DesktopSettingsLimits;
}

export interface DesktopSettingsResponse {
  settings: DesktopSettingsValues;
  restartRequired: boolean;
}

export const getDesktopSettings = () => desktopGet<DesktopSettingsResponse>("/desktop/settings");
type DesktopSettingsChange = {
  [Key in keyof DesktopSettingsValues]?: DesktopSettingsValues[Key] extends object
    ? Partial<DesktopSettingsValues[Key]>
    : DesktopSettingsValues[Key];
};

export const updateDesktopSettings = (change: DesktopSettingsChange) =>
  desktopPost<DesktopSettingsResponse>("/desktop/settings", change);

export interface BulkDeleteResult {
  deleted: number;
}

export interface DesktopPluginIndex {
  plugins: DesktopPlugin[];
}

/** Manifest environment/header value: a literal or plugin-secret reference. */
export type DesktopMcpConfigValue = string | { secret: string };

export type DesktopMcpConfig<V = Record<string, DesktopMcpConfigValue>> =
  | { transport: "stdio"; command: string; args?: string[]; env?: V }
  | { transport: "streamable_http"; url: string; headers?: V };

export type DesktopMcpTransport = DesktopMcpConfig["transport"];

export interface DesktopPlugin {
  id: string;
  name: string;
  version: string | null;
  description: string;
  themeColor: string;
  runtime: "wasm" | "mcp";
  /** Only present for plugins installed through the curated marketplace. */
  marketplace?: DesktopMarketplaceProvenance;
  /** Whether the HTTP MCP plugin supports authorization. */
  oauth: boolean;
  enabled: boolean;
  secrets: DesktopPluginSecret[];
  actions: DesktopPluginAction[];
}

export interface DesktopPluginSecret {
  name: string;
  description: string;
}

export interface DesktopPluginSecretState extends DesktopPluginSecret {
  configured: boolean;
}

export interface DesktopPluginSecretsResponse {
  secrets: DesktopPluginSecretState[];
}

export interface DesktopPluginAction {
  id: string;
  name: string;
  description: string;
  args: string[];
  mutative: boolean;
  enabled: boolean;
}

export interface DesktopPluginPreviewIcons {
  light: string;
  dark: string;
}

export interface DesktopPluginPreviewResult {
  fileName: string;
  status: "previewed" | "error";
  error?: string;
  iconDataUrls?: DesktopPluginPreviewIcons;
  plugin?: DesktopPluginPreview;
}

/** Common fields in uploaded plugin manifests. */
interface DesktopPluginPreviewBase {
  id: string;
  name: string;
  version?: string;
  description: string;
  themeColor: string;
  secrets: DesktopPluginSecret[];
}

export type DesktopPluginPreview =
  | (DesktopPluginPreviewBase & { runtime: "wasm"; actions: DesktopPluginPreviewAction[] })
  | (DesktopPluginPreviewBase & { runtime: "mcp"; mcp: DesktopMcpConfig });

export interface DesktopPluginPreviewAction {
  name: string;
  description: string;
}

export interface DesktopPluginImportResponse {
  results: DesktopPluginImportResult[];
}

export interface DesktopPluginImportResult {
  fileName: string;
  status: "installed" | "error";
  error?: string;
  plugin?: DesktopPlugin;
}

export interface DesktopMcpConnectValue {
  name: string;
  value: string;
  sensitive?: boolean;
}

export type DesktopMcpConnectRequest = DesktopMcpConfig<DesktopMcpConnectValue[]> & {
  oauth?: {
    authorize: boolean;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  };
};

export interface DesktopMcpCandidateAction {
  name: string;
  upstreamName: string;
  title?: string | null;
  description: string;
}

export interface DesktopMcpCandidate {
  candidateId: string;
  suggestedName: string;
  suggestedDescription: string;
  suggestedVersion?: string | null;
  suggestedIconSrc?: string | null;
  websiteUrl?: string | null;
  connection: string;
  protocolVersion?: string | null;
  actions: DesktopMcpCandidateAction[];
  secrets: DesktopPluginSecret[];
}

export interface DesktopMcpAuthorization {
  candidateId: string;
  authorizationUrl: string;
}

export type DesktopMcpConnectResponse =
  | { status: "ready"; candidate: DesktopMcpCandidate }
  | ({ status: "oauth_required" } & DesktopMcpAuthorization);

export type DesktopMcpCandidateStatus =
  | { status: "pending" }
  | { status: "ready"; candidate: DesktopMcpCandidate }
  | { status: "authorized" }
  | { status: "failed"; error: string };

export interface DesktopMcpInstallRequest {
  name: string;
  version?: string | null;
  description: string;
  themeColor: string;
  iconSrc?: string | null;
}

/** Secret values for each upload, keyed by filename. */
export type DesktopPluginCredentials = Record<string, Record<string, string>>;

function pluginFilesFormData(files: File[], credentials: DesktopPluginCredentials = {}) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("plugins", file, file.name);
  }
  if (Object.keys(credentials).length) {
    formData.append("credentials", JSON.stringify(credentials));
  }
  return formData;
}

export interface DesktopDirectoryEntry {
  name: string;
  path: string;
}

export interface DesktopDriveEntry extends DesktopDirectoryEntry {
  /** The drive the listed folder is on. */
  current: boolean;
}

export interface DesktopDirectoryListing {
  path: string;
  parentPath: string | null;
  homePath: string;
  /** Every folder from the filesystem root down to `path`. */
  breadcrumbs: DesktopDirectoryEntry[];
  /** Drive roots on Windows; empty on other systems. */
  drives: DesktopDriveEntry[];
  directories: DesktopDirectoryEntry[];
}

export const listWorkspaceRoots = <T>() => desktopGet<T>("/desktop/workspaces");
export const browseWorkspaceDirectories = (path?: string, signal?: AbortSignal) => {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return desktopGet<DesktopDirectoryListing>(`/desktop/workspaces/browse${query}`, signal);
};
export const addWorkspaceRoot = (path: string) => desktopPost("/desktop/workspaces/add", { path });
export const setWorkspaceRootEnabled = (path: string) =>
  desktopPost("/desktop/workspaces/toggle", { path });
export const removeWorkspaceRoot = (path: string) =>
  desktopPost("/desktop/workspaces/remove", { path });
export const revealWorkspaceRoot = (path: string) =>
  desktopPost("/desktop/workspaces/reveal", { path });

export interface OpenLocalPathResult {
  /**
   * `revealed` means the path was shown instead of opened because opening it could execute
   * code.
   */
  action: "opened" | "revealed";
  path: string;
}

/** Open an enabled-root file or folder using the system default application. */
export const openLocalPath = (path: string) =>
  desktopPost<OpenLocalPathResult>("/desktop/files/open", { path });

/** Encode a nonempty search query. */
const searchParam = (query: string, separator: "?" | "&") =>
  query === "" ? "" : `${separator}q=${encodeURIComponent(query)}`;

export const listConnectionClients = <T>(query: string, signal?: AbortSignal) =>
  desktopGet<T>(`/desktop/connections${searchParam(query, "?")}`, signal);

export const listAllConnectionThreads = <T>(
  limit: number,
  before: ConnectionCursor | null,
  query: string,
  signal?: AbortSignal,
) => {
  const cursor =
    before === null
      ? ""
      : `&beforeLastActivityAt=${encodeURIComponent(before.lastActivityAt)}&beforeId=${encodeURIComponent(before.cursorId)}`;
  return desktopGet<T>(
    `/desktop/connections/threads?limit=${limit}${cursor}${searchParam(query, "&")}`,
    signal,
  );
};
interface ConnectionCursor {
  lastActivityAt: string;
  cursorId: string;
}

export const listConnectionThreads = <T>(
  client: string,
  before: ConnectionCursor,
  query: string,
  signal?: AbortSignal,
) =>
  desktopGet<T>(
    `/desktop/connections/${encodeURIComponent(client)}/threads?limit=5&beforeLastActivityAt=${encodeURIComponent(before.lastActivityAt)}&beforeId=${encodeURIComponent(before.cursorId)}${searchParam(query, "&")}`,
    signal,
  );
export const getConnectionThread = <T>(threadId: string, signal?: AbortSignal) =>
  desktopGet<T>(`/desktop/threads/${encodeURIComponent(threadId)}`, signal);
export const deleteConnectionThread = (threadId: string) =>
  desktopPost<boolean>(`/desktop/threads/${encodeURIComponent(threadId)}/delete`);
export const listActivityForThread = <T>(
  threadId: string,
  limit: number,
  before: string | null,
  signal?: AbortSignal,
) =>
  desktopGet<T>(
    `/desktop/threads/${threadId}/calls?limit=${limit}${before === null ? "" : `&before=${encodeURIComponent(before)}`}`,
    signal,
  );
export const getThreadCall = <T>(entryId: string, signal?: AbortSignal) =>
  desktopGet<T>(`/desktop/thread-calls/${encodeURIComponent(entryId)}`, signal);

const pluginPath = (pluginId: string, suffix = "") =>
  `/desktop/plugins/${encodeURIComponent(pluginId)}${suffix}`;

export const listInstalledPlugins = () => desktopGet<DesktopPluginIndex>("/desktop/plugins");

/** Public discovery is separate from installed plugin state and never used as an install instruction. */
export interface DesktopMarketplaceProvenance {
  integrationId: string;
  artifactSha256?: string;
}

export interface DesktopMarketplaceManifest {
  id: string;
  name: string;
  description: string;
  version: string | null;
  runtime: "wasm" | "mcp";
  mcpTransport?: "stdio" | "streamable_http" | "loopback_http";
  secrets: DesktopPluginSecret[];
  themeColor: string;
}

export interface DesktopMarketplaceCategory {
  id: string;
  name: string;
}

/** A Discover filter. Entries name its categories, never the group itself. */
export interface DesktopMarketplaceCategoryGroup {
  id: string;
  name: string;
  categories: DesktopMarketplaceCategory[];
}

export interface DesktopMarketplaceUpdate {
  /** Patch releases install themselves; higher minors wait for approval. */
  kind: "auto" | "approval";
  version: string;
}

export interface DesktopMarketplaceEntry {
  artifactSha256: string | null;
  manifest: DesktopMarketplaceManifest;
  categories: string[];
  overview?: string;
  releaseNotes?: string;
  publishedAt?: string;
  installation: "not_installed" | "managed" | "unmanaged";
  /** Present when the installed copy is older than the published one. */
  update?: DesktopMarketplaceUpdate | null;
  iconUrl: string;
}

export interface DesktopMarketplaceCatalog {
  groups: DesktopMarketplaceCategoryGroup[];
  entries: DesktopMarketplaceEntry[];
}

export interface DesktopMarketplaceSnapshot {
  catalog: DesktopMarketplaceCatalog | null;
  error?: string;
}

export const getCachedMarketplace = () =>
  desktopGet<DesktopMarketplaceSnapshot>("/desktop/plugins/marketplace");

export const refreshMarketplace = () =>
  desktopPost<DesktopMarketplaceSnapshot>("/desktop/plugins/marketplace/refresh");

/** Backend-owned install/update operation; remains active across view changes. */
export interface DesktopMarketplaceOperation {
  id: string;
  integrationId: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  phase: string;
  percent: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const marketplaceOperationsPath = "/desktop/plugins/marketplace/operations";
export const listMarketplaceOperations = () =>
  desktopGet<DesktopMarketplaceOperation[]>(marketplaceOperationsPath);
export const cancelMarketplaceOperation = (id: string) =>
  desktopPost<DesktopMarketplaceOperation>(
    `${marketplaceOperationsPath}/${encodeURIComponent(id)}/cancel`,
  );
function marketplaceRelease(entry: DesktopMarketplaceEntry) {
  const { id, version } = entry.manifest;
  if (!version || !entry.artifactSha256) throw new Error("Marketplace release is unavailable.");
  return { id, version, artifactSha256: entry.artifactSha256 };
}

export const installMarketplaceWasm = (entry: DesktopMarketplaceEntry) =>
  desktopPost<DesktopMarketplaceOperation>(
    "/desktop/plugins/marketplace/install",
    marketplaceRelease(entry),
  );
export const updateMarketplaceWasm = (entry: DesktopMarketplaceEntry) =>
  desktopPost<DesktopMarketplaceOperation>(
    "/desktop/plugins/marketplace/update",
    marketplaceRelease(entry),
  );

/** Discovery is separate from confirmation so OAuth and action review reuse existing MCP UI. */
export interface DesktopMarketplaceMcpConnectRequest {
  id: string;
  credentials?: Record<string, string>;
  executablePath?: string;
  oauth?: DesktopMcpConnectRequest["oauth"];
}

export const connectMarketplaceMcp = (request: DesktopMarketplaceMcpConnectRequest) =>
  desktopPost<DesktopMcpConnectResponse>("/desktop/plugins/marketplace/mcp/connect", request);

export const installMarketplaceMcpCandidate = (candidateId: string) =>
  desktopPost<DesktopMarketplaceOperation>(
    `/desktop/plugins/marketplace/mcp/candidates/${encodeURIComponent(candidateId)}/install`,
  );
/** Optional `icon-<variant>.svg` plugin icons for each color scheme. */
export type PluginIconVariant = "light" | "dark";
export const pluginIconUrl = (pluginId: string, variant?: PluginIconVariant) =>
  pluginPath(pluginId, `/icon${variant ? `?variant=${variant}` : ""}`);
export const importPlugins = (files: File[], credentials: DesktopPluginCredentials) =>
  desktopPostForm<DesktopPluginImportResponse>(
    "/desktop/plugins/import",
    pluginFilesFormData(files, credentials),
  );
export const connectMcpServer = (request: DesktopMcpConnectRequest) =>
  desktopPost<DesktopMcpConnectResponse>("/desktop/plugins/mcp/connect", request);
const mcpCandidatePath = (candidateId: string, suffix = "") =>
  `/desktop/plugins/mcp/candidates/${encodeURIComponent(candidateId)}${suffix}`;
export const getMcpCandidateStatus = (candidateId: string) =>
  desktopGet<DesktopMcpCandidateStatus>(mcpCandidatePath(candidateId, "/status"));
export const installMcpCandidate = (candidateId: string, request: DesktopMcpInstallRequest) =>
  desktopPost<DesktopPlugin>(mcpCandidatePath(candidateId, "/install"), request);
export const cancelMcpCandidate = (candidateId: string) =>
  desktopPost<boolean>(mcpCandidatePath(candidateId, "/cancel"));
export const authorizeMcpPlugin = (pluginId: string) =>
  desktopPost<DesktopMcpAuthorization>(pluginPath(pluginId, "/mcp/authorize"));

const MCP_AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Poll an OAuth candidate until completion, server error, five-minute timeout, or `isActive()`
 * cancellation.
 */
export async function waitForMcpCandidate(candidateId: string, isActive: () => boolean) {
  const deadline = Date.now() + MCP_AUTHORIZATION_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    if (!isActive()) throw new Error("MCP authorization cancelled.");
    if (Date.now() > deadline) throw new Error("MCP authorization timed out.");
    const status = await getMcpCandidateStatus(candidateId);
    if (status.status === "failed") throw new Error(status.error);
    if (status.status !== "pending") return status;
  }
}
export const setPluginEnabled = (pluginId: string, enabled: boolean) =>
  desktopPost<DesktopPlugin>(pluginPath(pluginId, "/set-enabled"), { enabled });
export const setPluginActionEnabled = (pluginId: string, actionName: string, enabled: boolean) =>
  desktopPost<DesktopPlugin>(
    pluginPath(pluginId, `/actions/${encodeURIComponent(actionName)}/set-enabled`),
    { enabled },
  );
export const deletePlugin = (pluginId: string) =>
  desktopPost<boolean>(pluginPath(pluginId, "/delete"));
export const deleteAllPlugins = () =>
  desktopPost<BulkDeleteResult>("/desktop/plugins/delete-all", { confirmation: "DELETE" });
export const listPluginSecrets = (pluginId: string) =>
  desktopGet<DesktopPluginSecretsResponse>(pluginPath(pluginId, "/secrets"));
export const setPluginSecret = (pluginId: string, secretName: string, value: string) =>
  desktopPost<DesktopPluginSecretsResponse>(
    pluginPath(pluginId, `/secrets/${encodeURIComponent(secretName)}`),
    { value },
  );

// Agent-engine record types live in `./desktopEvents` as valibot schemas
// (single source of truth, validated at the socket boundary and on fetch).

export interface DesktopProviderProfile {
  id: string;
  displayName: string;
  kind: string;
  baseUrl: string;
  builtin: boolean;
  configured: boolean;
  /** Last four characters of the saved key; empty if unavailable. */
  keyHint: string;
  keyLabel: string;
  keyPlaceholder: string;
  docUrl: string;
  icon: string;
}

export interface DesktopProviders {
  profiles: DesktopProviderProfile[];
  defaultModel: ModelRef | null;
}

/** Sidebar and search page size. */
export const CONVERSATION_PAGE_SIZE = 50;

export interface ConversationStopResponse {
  stopped: boolean;
}

export interface ConversationSendNowResponse {
  ok: boolean;
}

export interface ConversationDeleteResponse {
  deleted: boolean;
}

const conversationPath = (id: string, suffix = "") =>
  `/desktop/conversations/${encodeURIComponent(id)}${suffix}`;

/**
 * Account-connection API types matching `server/src/account.rs`. The server handles enrollment;
 * the client starts it and reads status.
 */
export type AccountState =
  | "disconnected"
  | "awaitingApproval"
  | "connected"
  | "failed"
  | "expired"
  | "revoked";

export interface AccountStatus {
  state: AccountState;
  installationId?: string;
  accountId?: string;
  /** Server-provided approval URL while awaiting approval. */
  approvalUrl?: string;
  /** User-verification code while awaiting approval. */
  userCode?: string;
  /** Approval-link expiry in Unix seconds. */
  expiresAt?: number;
  /** Error from a failed, expired or revoked attempt. */
  error?: string;
}

/** Current connected account profile from Squire. */
export interface AccountProfile {
  name: string;
  /** Given name from Google sign-in; null for other registration methods. */
  givenName: string | null;
  email: string;
  /** Optional account-image URL from Google sign-in. */
  image: string | null;
  deviceName: string;
  os: string;
  /** Unix seconds. */
  connectedAt: number;
  manageUrl: string;
}

export interface AccountDisconnectResult {
  revokedRemotely: boolean;
  warning?: string;
}

export const getAccountStatus = (signal?: AbortSignal) =>
  desktopGet<AccountStatus>("/desktop/account", signal);
export const getAccountProfile = (signal?: AbortSignal) =>
  desktopGet<AccountProfile>("/desktop/account/profile", signal);
export const connectAccount = () => desktopPost<AccountStatus>("/desktop/account/connect");
/** Cancel approval, disconnect the account, or clear a failed attempt. */
export const disconnectAccount = () =>
  desktopPost<AccountDisconnectResult>("/desktop/account/disconnect");

/** Remote Access state from the local server. */
export type RemoteState =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "signedOut"
  | "revoked"
  | "incompatible";

/** One line in the Remote Access diagnostics event list. */
export interface RemoteEvent {
  /** Unix milliseconds. */
  at: number;
  tone: "info" | "success" | "error";
  text: string;
}

export interface RemoteStatus {
  state: RemoteState;
  enabled: boolean;
  accountConnected: boolean;
  deviceName: string;
  /** The operating system as people name it, such as "macOS 26.0". */
  os: string;
  mcpUrl: string;
  protocolVersion: number;
  /** Connection attempts since the last success; 0 while connected. */
  attempt: number;
  /** Unix milliseconds when the current socket opened, while connected. */
  connectedSince: number | null;
  /** Unix milliseconds of the last lease Squire sent. */
  lastLeaseAt: number | null;
  error?: string;
  errorAt: number | null;
  /** Newest first. */
  events: RemoteEvent[];
}

export const getRemoteStatus = (signal?: AbortSignal) =>
  desktopGet<RemoteStatus>("/desktop/remote", signal);
export const setRemoteEnabled = (enabled: boolean) =>
  desktopPost<RemoteStatus>("/desktop/remote/set-enabled", { enabled });

export interface ChatGPTStatus {
  pending: boolean;
  error: string | null;
  connected: boolean;
  verificationUri: string | null;
  userCode: string | null;
}
export interface ChatGPTSignInResult {
  started: boolean;
}
export interface ChatGPTSignOutResult {
  signedOut: boolean;
}
export const getChatGPTStatus = () => desktopGet<ChatGPTStatus>("/desktop/chatgpt/status");
export const startChatGPTSignIn = () =>
  desktopPost<ChatGPTSignInResult>("/desktop/chatgpt/start", {});
export const signOutChatGPT = () =>
  desktopPost<ChatGPTSignOutResult>("/desktop/chatgpt/signout", {});
export const getAgentProviders = (signal?: AbortSignal) =>
  desktopGet<DesktopProviders>("/desktop/providers", signal);
export const listConversations = (
  signal?: AbortSignal,
  query = "",
  after: string | null = null,
) => {
  const params = new URLSearchParams({ limit: String(CONVERSATION_PAGE_SIZE), q: query });
  if (after !== null) {
    params.set("after", after);
  }
  return desktopGet(`/desktop/conversations?${params}`, signal).then((data) =>
    v.parse(ConversationListResponseSchema, data),
  );
};
export interface StartConversationInput {
  text: string;
  modelRef?: ModelRef | null;
  nativeOptions?: unknown;
  attachments?: AttachmentInput[];
  clientMessageId?: string;
}

export const startConversation = (message: StartConversationInput) =>
  desktopPost<DesktopConversation>("/desktop/conversations", message);
export const getConversation = (id: string, signal?: AbortSignal) =>
  desktopGet(conversationPath(id), signal).then((data) =>
    v.parse(ConversationSnapshotSchema, data),
  );
export const sendConversationMessage = (
  id: string,
  text: string,
  modelRef?: ModelRef | null,
  nativeOptions?: unknown,
  attachments: AttachmentInput[] = [],
  clientMessageId?: string,
) =>
  desktopPost<ConversationMessage>(conversationPath(id, "/messages"), {
    text,
    modelRef,
    nativeOptions,
    attachments,
    clientMessageId,
  });
export const stopConversation = (id: string) =>
  desktopPost<ConversationStopResponse>(conversationPath(id, "/stop"));
export const sendQueuedNow = (id: string) =>
  desktopPost<ConversationSendNowResponse>(conversationPath(id, "/queued/send-now"));
export const deleteQueuedMessage = (id: string, messageId: string) =>
  desktopPost<ConversationDeleteResponse>(
    conversationPath(id, `/queued/${encodeURIComponent(messageId)}/delete`),
  );

export const cancelConversationJob = (conversation: string, job: string) => {
  return desktopPost(`${conversationPath(conversation)}/jobs/${encodeURIComponent(job)}/cancel`);
};

/** Tool-result attachment served from conversation storage. */

export interface AttachmentInput {
  name: string;
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
}
export interface ModelMetadata {
  contextWindow: number;
  maxOutput: number;
  tools: boolean;
  vision: boolean;
  reasoningStyle: string;
  inputPrice: number | null;
  outputPrice: number | null;
  /** Optional catalog display name. */
  name?: string | null;
  /** Supported reasoning levels in ascending order. */
  reasoningLevels?: string[];
  /** Model-default reasoning level when no override is set. */
  reasoningDefault?: string | null;
}
export interface ModelPrefs {
  hidden: boolean;
  alias: string | null;
  nativeOptions: unknown;
  metadata: ModelMetadata | null;
}
export interface ModelInfo {
  id: string;
  metadata: ModelMetadata;
  prefs: ModelPrefs;
}
export interface ProfileInput {
  id?: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  sessionHeader?: string | null;
}
export const createProvider = (input: ProfileInput) => {
  return desktopPost<DesktopProviderProfile>("/desktop/providers", input);
};
export const updateProvider = (id: string, input: ProfileInput) => {
  return desktopPost<DesktopProviderProfile>(
    `/desktop/providers/${encodeURIComponent(id)}/update`,
    input,
  );
};
export const deleteProvider = (id: string) => {
  return desktopPost<ConversationDeleteResponse>(
    `/desktop/providers/${encodeURIComponent(id)}/delete`,
  );
};
export interface ModelPageOptions {
  q?: string;
  limit?: number;
  /** The previous page's `nextCursor`. */
  after?: string | null;
  /** Include a model ID even when it falls outside the requested page. */
  include?: string | null;
  /** Bypass the cached model list and query the provider. */
  refresh?: boolean;
}

/** List a provider's models; omit `limit` to return the complete list. */
export const discoverModels = (
  profile: string,
  signal?: AbortSignal,
  options: ModelPageOptions = {},
) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...options, refresh: options.refresh || null })) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.size === 0 ? "" : `?${params}`;
  return desktopGet<ModelListResponse>(
    `/desktop/providers/${encodeURIComponent(profile)}/models${query}`,
    signal,
  );
};
export const saveModelPrefs = (model: ModelRef, prefs: ModelPrefs) => {
  return desktopPost(
    `/desktop/models/${encodeURIComponent(model.profileId)}/${encodeURIComponent(model.modelId)}`,
    prefs,
  );
};
export const markConversationSeen = (id: string, throughSeq: number) => {
  return desktopPost<DesktopConversation>(conversationPath(id, "/seen"), { throughSeq });
};
export const editConversationMessage = (id: string, mid: string, text: string) => {
  return desktopPost<ConversationMessage>(
    conversationPath(id, `/messages/${encodeURIComponent(mid)}/edit`),
    { text },
  );
};
export const editQueuedMessage = (id: string, mid: string, text: string) => {
  return desktopPost<ConversationMessage>(
    conversationPath(id, `/queued/${encodeURIComponent(mid)}/edit`),
    { text },
  );
};
export const branchConversation = (id: string, mid: string) => {
  return desktopPost<DesktopConversation>(
    conversationPath(id, `/messages/${encodeURIComponent(mid)}/branch`),
  );
};
export const renameConversation = (id: string, title: string) => {
  return desktopPost<DesktopConversation>(conversationPath(id, "/rename"), { title });
};
export const deleteConversation = (id: string) => {
  return desktopPost<ConversationDeleteResponse>(conversationPath(id, "/delete"));
};
export const deleteAllConversations = () =>
  desktopPost<BulkDeleteResult>("/desktop/conversations/delete-all", { confirmation: "DELETE" });
export const deleteAllThreads = () =>
  desktopPost<BulkDeleteResult>("/desktop/threads/delete-all", { confirmation: "DELETE" });

/** Capabilities shared by all models from a provider. */
export interface CommonCapabilities {
  tools: boolean;
  vision: boolean;
}

export interface ModelListResponse {
  models: ModelInfo[];
  /** Total matches across all pages. */
  total: number;
  nextCursor: string | null;
  common: CommonCapabilities;
}

export const getConversationMessages = (id: string, before: number, signal?: AbortSignal) =>
  desktopGet(conversationPath(id, `/messages?before=${before}`), signal).then((data) =>
    v.parse(MessagePageSchema, data),
  );

interface ConversationMessagePart {
  type: string;
  text?: string;
}

/** Retrieve a committed assistant message's text and reasoning on demand. */
export const getConversationMessageParts = (id: string, messageId: string, signal?: AbortSignal) =>
  desktopGet<ConversationMessagePart[]>(
    conversationPath(id, `/messages/${encodeURIComponent(messageId)}/payload`),
    signal,
  );

/** Full arguments, output and model text for one tool call. */
export interface ToolCallPayload {
  args: unknown;
  result: unknown;
}
export const getConversationCall = (id: string, call: string, signal?: AbortSignal) =>
  desktopGet<ToolCallPayload>(
    conversationPath(id, `/tool-calls/${encodeURIComponent(call)}`),
    signal,
  );
export const blobAttachmentUrl = (hash: string) => `/attachments/${encodeURIComponent(hash)}`;

export interface BrowserApplication {
  executable: string;
  label: string;
  family: string;
}
export interface BrowserSettingsResponse {
  browsers: BrowserApplication[];
  selected: string;
  initialized: boolean;
  graphical: boolean;
}
export interface BrowserSettingsChange {
  action: "open" | "reset" | "select";
  executable?: string;
  confirm?: boolean;
}
/** Set `refresh` to detect installed browsers again instead of using cached results. */
export const getBrowserSettings = (signal?: AbortSignal, refresh = false) =>
  desktopGet<BrowserSettingsResponse>(
    refresh ? "/desktop/browser?refresh=true" : "/desktop/browser",
    signal,
  );
interface BrowserSettingsResult {
  saved?: boolean;
  opened?: boolean;
}
export const changeBrowserSettings = (change: BrowserSettingsChange) =>
  desktopPost<BrowserSettingsResult>("/desktop/browser", change);
