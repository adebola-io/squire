import { AsyncCell, Cell, If } from "retend";
import { useRouteQuery } from "retend/router";
import { Icon, type IconName } from "squire-ui";

import { pluginIconUrl } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { formatDateRelative } from "@/utils/date";

import type { ToolCallType } from "./ToolCalls";

import classes from "./Activity.module.css";

interface ToolCallProps {
  /** Stable entry ID used as the row key. */
  id: string;
  call: AsyncCell<ToolCallType>;
  index: Cell<number>;
  revealFrom: Cell<number | null>;
}

const TOOL_CALLS = {
  start_thread: ["Start Thread", "start"],
  ping: ["Ping", "bolt"],
  multi_tool_use_parallel: ["Parallel Tool Call", "parallel"],
  edit_files: ["Edit Files", "edit"],
  write_files: ["Write Files", "edit"],
  delete: ["Delete", "edit"],
  mkdir: ["Create Folder", "folder"],
  read_files: ["Read Files", "file"],
  search_files: ["Search Files", "search"],
  search_file_contents: ["Search File Contents", "search"],
  search_actions: ["Search Actions", "search"],
  use_action: ["Use Action", "plugin"],
  check_job: ["Check Job", "clock"],
  cancel_job: ["Cancel Job", "cancel"],
  get_file_tree: ["Get File Tree", "grid"],
  use_skills: ["Use Skills", "brain"],
  read_skill_resources: ["Read Skill Resources", "info"],
  web_search: ["Web Search", "search"],
  web_search_images: ["Image Search", "search"],
  fetch_page: ["Fetch Page", "browser"],
} as const satisfies Record<string, readonly [string, IconName]>;

export type ToolCallName = keyof typeof TOOL_CALLS;

/** Action annotation when present; older rows keep their friendly tool name. */
export function toolCallName(tool: string, description?: string): string {
  if (tool === "use_action" && description?.trim() && description !== tool) return description;
  return tool in TOOL_CALLS ? TOOL_CALLS[tool as ToolCallName][0] : tool;
}

export function ToolCall(props: ToolCallProps) {
  const { id, call, index, revealFrom } = props;
  const colorScheme = useColorScheme();
  // The `entry` query parameter selects the open tool-call panel.
  const query = useRouteQuery();
  const openEntry = query.get("entry");
  const isOpen = Cell.derived(() => openEntry.get() === id);
  const normalizedName = Cell.derivedAsync(async (get) => {
    const current = await get(call);
    return toolCallName(current.tool, current.description);
  });
  const iconName = Cell.derivedAsync(
    async (get) => TOOL_CALLS[(await get(call)).tool]?.[1] ?? "card",
  );
  const pluginIcon = Cell.derivedAsync(async (get) => {
    const { tool, metadata } = await get(call);
    if (tool !== "use_action" || !metadata) return null;
    const dot = metadata.indexOf(".");
    return dot > 0 ? pluginIconUrl(metadata.slice(0, dot), get(colorScheme)) : null;
  });
  const timeRan = Cell.derivedAsync(async (get) =>
    formatDateRelative((await get(call)).startedAt, { timeStyle: "medium" }),
  );
  const status = Cell.derivedAsync(async (get) => (await get(call)).status);
  const metadetail = Cell.derivedAsync(async (get) => (await get(call)).metadata ?? "");
  const hasMetadetail = Cell.derivedAsync(async (get) => (await get(metadetail)) !== "");
  const revealed = Cell.derived(() => {
    const from = revealFrom.get();
    return from !== null && index.get() >= from;
  });
  const revealIndex = Cell.derived(() => {
    const from = revealFrom.get();
    return from === null ? 0 : Math.max(0, index.get() - from);
  });
  const revealStyle = Cell.derived(() => ({
    "--tool-call-reveal-index": revealIndex.get(),
  }));

  // Use the stable ID directly. Awaiting the call would also wait for repeated list refreshes
  // during agent activity.
  const togglePanel = () => {
    void (openEntry.get() === id ? query.delete("entry") : query.set("entry", id));
  };

  return (
    <li class={classes.toolCallListItemContainer} data-revealed={revealed} style={revealStyle}>
      <button
        type="button"
        class={classes.toolCallListItem}
        data-selected={isOpen}
        onClick={togglePanel}
      >
        <div data-has-metadetail={hasMetadetail} class={classes.toolCall}>
          {If(pluginIcon, {
            true: (src) => <img src={src} class={classes.toolCallIcon} alt="" aria-hidden="true" />,
            false: () => <Icon name={iconName} class={classes.toolCallIcon} />,
          })}
          <span class={classes.toolCallName}>
            {normalizedName}
            <span class={classes.toolCallMetadetail}>{metadetail}</span>
          </span>
          <span class={classes.toolCallDetails}>
            <time class={classes.toolCallTime}>{timeRan}</time>•
            <span class={classes.toolCallStatus} data-status={status}>
              {status}
            </span>
          </span>
        </div>
      </button>
    </li>
  );
}
