import { Cell, For, If, type AsyncCell } from "retend";
import { FadeScroll, Icon } from "squire-ui";

import {
  FileToolDetails,
  fileToolKind,
  prepareFileToolDetails,
  type PreparedFileToolDetails,
} from "@/components/ui/FileToolDetails";
import { useImageZoom, ZoomImage, zoomImageId } from "@/components/ui/ImageZoom/ImageZoom";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  ParallelToolDetails,
  parallelToolCode,
  prepareParallelToolDetails,
  type PreparedParallelToolDetails,
} from "@/components/ui/ParallelToolDetails";
import { SkillToolDetails } from "@/components/ui/SkillToolDetails";
import { ToolValue, toolValueCode } from "@/components/ui/ToolValue";
import { getThreadCall, getConnectionThread } from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";

import { ClientIcon, clientIconSrc } from "./ClientName";
import { prepareHighlightedCode } from "./HighlightedCode";
import { toolCallName } from "./ToolCall";
import type { ToolCallDetail } from "./ToolCalls";

import classes from "./Activity.module.css";

interface PanelMedia {
  mimeType: string;
  url: string;
}

interface ToolCallPanelProps {
  entryId: string;
  prepared: PreparedToolCallPanel;
}

interface ConnectionThreadInfo {
  title: string;
  client: string;
}

interface PanelItem {
  name: string;
  detail?: string;
  body: unknown;
  media?: PanelMedia;
}

function row(name: string, body: unknown, detail?: string): PanelItem {
  return { name, body, detail };
}

function inputItems(call: ToolCallDetail): PanelItem[] {
  return Object.entries(call.args)
    .filter(([name]) => name !== "thread_id")
    .map(([name, body]) => row(name, body));
}

function outputItems(call: ToolCallDetail): PanelItem[] {
  const result = call.result;
  if (!result) return [row("result", "No result yet.")];
  if (result.error) return [row("error", result.error.message, "error")];
  const content = result.structuredContent!;
  const rows = [row("result", content)];
  return rows.concat(
    (result.attachments ?? []).map((attachment, index) => ({
      name: `attachment ${index + 1}`,
      body: attachment.name ?? "Attachment",
      media: {
        mimeType: attachment.mimeType,
        url: attachment.url,
      },
    })),
  );
}

interface PanelSectionProps {
  rows: AsyncCell<PanelItem[]>;
  title: string;
}

function mediaElement(media: PanelMedia, name: string) {
  if (media.mimeType.startsWith("image/")) {
    return <PanelImage media={media} name={name} />;
  }
  if (media.mimeType.startsWith("audio/")) {
    return <audio class={classes.toolCallPanelMedia} src={media.url} controls={"true" as const} />;
  }
  if (media.mimeType.startsWith("video/")) {
    return <video class={classes.toolCallPanelMedia} src={media.url} controls={"true" as const} />;
  }
  return (
    <a href={media.url} download="">
      Download {media.mimeType}
    </a>
  );
}

interface PanelImageProps {
  media: PanelMedia;
  name: string;
}

function PanelImage(props: PanelImageProps) {
  const { media, name } = props;
  const id = zoomImageId();
  const openZoom = useImageZoom();
  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openZoom({ id, src: media.url, alt: name });
  };
  return (
    <a
      class={classes.toolCallPanelImage}
      href={media.url}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
    >
      <ZoomImage id={id} src={media.url} alt={name} />
    </a>
  );
}

function PanelSection(props: PanelSectionProps) {
  const { rows, title } = props;
  return (
    <section class={classes.toolCallPanelSection}>
      <h3 class={classes.toolCallPanelSectionTitle}>{title}</h3>
      <ol class={classes.toolCallPanelRows}>
        {For(rows, (row) => (
          <li class={classes.toolCallPanelRow} data-status={row.detail}>
            <div class={classes.toolCallPanelRowHeader}>
              <strong>{row.name}</strong>
              {If(row.detail, (detail) => (
                <span>{detail}</span>
              ))}
            </div>
            <div class={classes.toolCallPanelValueScroll}>
              <ToolValue value={row.body} error={row.detail === "error"} />
            </div>
            {If(row.media, (media) => mediaElement(media, row.name))}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Prepare the entry, thread and highlighted values together so the panel updates atomically
 * when selection changes.
 */
export interface PreparedToolCallPanel {
  detail: ToolCallDetail;
  session: ConnectionThreadInfo;
  /** File previews prepared with the panel data. */
  file: PreparedFileToolDetails | null;
  parallel: PreparedParallelToolDetails | null;
}

export async function loadToolCallPanel(
  entryId: string,
  signal: AbortSignal,
): Promise<PreparedToolCallPanel> {
  const detail = await getThreadCall<ToolCallDetail>(entryId, signal);
  const thread = await getConnectionThread<ConnectionThreadInfo>(detail.threadId, signal);
  const kind = fileToolKind(detail.tool);
  const output = detail.result?.structuredContent;
  const error = detail.result?.error?.message ?? detail.error;

  if (detail.tool === "multi_tool_use_parallel") {
    const calls = detail.args.calls;
    const parallel = await prepareParallelToolDetails({
      calls,
      output,
      status: detail.status,
      error,
    });
    await prepareHighlightedCode(parallelToolCode({ calls, output, status: detail.status }));
    return { detail, session: thread, file: null, parallel };
  }

  if (kind !== null) {
    const file = await prepareFileToolDetails({
      kind,
      args: detail.args,
      output: output ?? null,
      status: detail.status,
      error,
    });
    return { detail, session: thread, file, parallel: null };
  }

  if (detail.tool !== "use_skills") {
    const items = [...inputItems(detail), ...outputItems(detail)];
    await prepareHighlightedCode(items.flatMap((item) => toolValueCode(item.body)));
  }
  return { detail, session: thread, file: null, parallel: null };
}

function useToolCallPanelState(entryId: string, prepared: PreparedToolCallPanel) {
  let initial: PreparedToolCallPanel | null = prepared;
  const entry = Cell.derivedAsync(async (_get, signal) => {
    if (initial !== null) {
      const value = initial;
      initial = null;
      return value;
    }
    return loadToolCallPanel(entryId, signal);
  });
  const detail = Cell.derivedAsync(async (get) => (await get(entry)).detail);
  const file = Cell.derivedAsync(async (get) => (await get(entry)).file);
  const parallel = Cell.derivedAsync(async (get) => (await get(entry)).parallel);
  const session = Cell.derivedAsync(async (get) => (await get(entry)).session);
  const tool = Cell.derivedAsync(async (get) => (await get(detail)).tool);
  const normalizedName = Cell.derivedAsync(async (get) => {
    const current = await get(detail);
    return toolCallName(current.tool, current.description);
  });
  const status = Cell.derivedAsync(async (get) => (await get(detail)).status);
  const startedAt = Cell.derivedAsync(async (get) => (await get(detail)).startedAt);
  const dateRan = Cell.derivedAsync(async (get) =>
    new Date(await get(startedAt)).toLocaleString(navigator.languages[0], {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
  const duration = Cell.derivedAsync(async (get) => (await get(detail)).durationMs);
  const threadClient = Cell.derivedAsync(async (get) => (await get(session))?.client ?? "");
  const threadTitle = Cell.derivedAsync(async (get) => (await get(session))?.title ?? "");

  onDesktopEvent("activity", async (event) => {
    let current;
    try {
      current = await detail.get();
    } catch {
      return;
    }
    const ours = event.threadId === undefined || event.threadId === current.threadId;
    if (ours && current.status === "running") {
      entry.revalidate();
    }
  });
  const inputRows = Cell.derivedAsync(async (get) => inputItems(await get(detail)));
  const rows = Cell.derivedAsync(async (get) => outputItems(await get(detail)));

  const loadError = Cell.derived(() => entry.error.get()?.message ?? null);
  const showPanel = Cell.derived(() => entry.error.get() === null);
  const retry = () => {
    entry.revalidate();
  };
  return {
    showPanel,
    normalizedName,
    status,
    tool,
    duration,
    startedAt,
    dateRan,
    threadClient,
    threadTitle,
    detail,
    file,
    parallel,
    inputRows,
    rows,
    loadError,
    retry,
  };
}

/**
 * Render a prepared connection entry. SidePanel manages content transitions; activity events
 * refresh the displayed entry.
 */
export function ToolCallPanel(props: ToolCallPanelProps) {
  const { entryId, prepared } = props;
  const {
    showPanel,
    normalizedName,
    status,
    tool,
    duration,
    startedAt,
    dateRan,
    threadClient,
    threadTitle,
    detail,
    file,
    parallel,
    inputRows,
    rows,
    loadError,
    retry,
  } = useToolCallPanelState(entryId, prepared);

  return If(showPanel, {
    true: () => (
      <div class={classes.toolCallPanel}>
        <div class={classes.toolCallPanelHeader}>
          <h2 class={classes.toolCallPanelTitle}>{normalizedName}</h2>
          <span class={[classes.toolCallStatus, classes.toolCallPanelStatus]} data-status={status}>
            {status}
          </span>
          <p class={classes.toolCallPanelTool}>{tool}</p>
          <p class={classes.toolCallPanelMetadata}>
            <Icon name="bolt" class={classes.toolCallPanelIcon} />
            {duration}ms
            <Icon name="clock" class={classes.toolCallPanelIcon} />
            <time dateTime={startedAt}>{dateRan}</time>
          </p>
        </div>
        <section class={classes.toolCallPanelSection}>
          <h3 class={classes.toolCallPanelSectionTitle}>Thread</h3>
          <div class={classes.toolCallPanelThread}>
            {If(threadClient, (client) =>
              If(clientIconSrc(client), () => (
                <ClientIcon name={client} class={classes.toolCallPanelThreadIcon} />
              )),
            )}
            <FadeScroll direction="horizontal" class={classes.toolCallPanelThreadTitleScroll}>
              <span class={classes.toolCallPanelThreadTitle}>{threadTitle}</span>
            </FadeScroll>
          </div>
        </section>
        {If(detail, (call) => {
          const skills = call.tool === "use_skills";
          const plain =
            fileToolKind(call.tool) === null && call.tool !== "multi_tool_use_parallel" && !skills;
          return (
            <>
              {If(parallel, (preparedCalls) => (
                <ParallelToolDetails prepared={preparedCalls} />
              ))}
              {If(file, (preparedFile) => (
                <FileToolDetails prepared={preparedFile} />
              ))}
              {If(skills, () => (
                <SkillToolDetails
                  args={call.args}
                  output={call.result?.structuredContent}
                  status={call.status}
                  error={call.result?.error?.message ?? call.error}
                />
              ))}
              {If(plain, () => (
                <>
                  <PanelSection rows={inputRows} title="Input" />
                  <PanelSection rows={rows} title="Output" />
                </>
              ))}
            </>
          );
        })}
      </div>
    ),
    false: () => (
      <LoadingState region label="Fetching tool call…" error={loadError} onRetry={retry} />
    ),
  });
}
