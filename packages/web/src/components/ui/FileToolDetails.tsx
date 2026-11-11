import { For, If } from "retend";
import { FadeScroll, Icon } from "squire-ui";

import { asRecord, pluralize } from "@/utils/misc";

import { FilePreview } from "./FilePreview";
import { buildFilePreview, type FilePreviewModel } from "./previewRows";
import { ToolValue } from "./ToolValue";

import classes from "./FileToolDetails.module.css";

type Data = Record<string, unknown>;

const TOOL_TITLES = {
  edit_files: ["Edits requested", "Changes applied"],
  write_files: ["Writes requested", "Files written"],
  read_files: ["Files read", "Files read"],
  delete: ["Deletions requested", "Paths deleted"],
  mkdir: ["Folders requested", "Folders created"],
  search_files: ["Matching files", "Matching files"],
  search_file_contents: ["Content matches", "Content matches"],
  get_file_tree: ["File tree", "File tree"],
} as const;

export type FileToolKind = keyof typeof TOOL_TITLES;
export type FileToolStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "skipped"
  | "interrupted";

interface FileRow {
  path: string;
  detail: string;
  before?: string;
  after?: string;
  content?: string;
  startLine?: number;
  failure?: string;
}

interface PreparedFileRow extends FileRow {
  /** Precomputed file preview for this tool call. */
  preview: FilePreviewModel | null;
}

interface FileToolDetailsProps {
  kind: FileToolKind;
  args: unknown;
  output: unknown;
  status: FileToolStatus;
  error?: string | null;
}

interface PreparedFileToolDetailsProps {
  prepared: PreparedFileToolDetails;
}

/** File-tool display data derived from the call. */
export interface FileToolModel {
  kind: FileToolKind;
  rows: FileRow[];
  isRead: boolean;
  isSearch: boolean;
  isMutation: boolean;
  confirmed: boolean;
  title: string;
  count: string;
  path: string;
  query: string;
  maxResults: string;
  plain: string;
  errors: string[];
  error?: string | null;
  showOther: boolean;
  other: Record<string, unknown> | null;
  resultSummary: string | null;
  status: FileToolStatus;
}

/** File-tool model with prepared preview rows. */
export interface PreparedFileToolDetails extends FileToolModel {
  rows: PreparedFileRow[];
}

export function fileToolKind(name: string): FileToolKind | null {
  return (
    (Object.keys(TOOL_TITLES) as FileToolKind[]).find(
      (kind) => name === kind || name.endsWith(`.${kind}`) || name.endsWith(`__${kind}`),
    ) ?? null
  );
}

function records(value: unknown): Data[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Data => item !== null)
    : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowForRead(request: Data, file?: Data, error?: Data): FileRow {
  const start = typeof request.start === "number" ? request.start : undefined;
  const end = typeof request.end === "number" ? request.end : undefined;
  return {
    path: string(request.path),
    detail:
      start === undefined ? "File content" : `Lines ${start}${end === undefined ? "" : `–${end}`}`,
    content: file && typeof file.content === "string" ? file.content : undefined,
    startLine: start && Number.isInteger(start) && start > 0 ? start : 1,
    failure: error ? string(error.message) || "File read failed" : undefined,
  };
}

function readRows(requests: Data[], data: Data | null): FileRow[] {
  const key = (file: Data) => JSON.stringify([file.path, file.start ?? null, file.end ?? null]);
  type Group = { items: Data[]; next: number };
  const groupBy = (items: Data[], identify: (item: Data) => string) => {
    const groups = new Map<string, Group>();
    for (const item of items) {
      const id = identify(item);
      let group = groups.get(id);
      if (!group) {
        group = { items: [], next: 0 };
        groups.set(id, group);
      }
      group.items.push(item);
    }
    return (id: string) => {
      const group = groups.get(id);
      return group?.items[group.next++];
    };
  };
  const success = groupBy(records(data?.files), key);
  const failure = groupBy(records(data?.errors), (item) => string(item.path));

  return requests.map((request) => {
    const file = success(key(request));
    return rowForRead(request, file, file ? undefined : failure(string(request.path)));
  });
}

function rowsFor(kind: FileToolKind, args: Data, data: Data | null): FileRow[] {
  switch (kind) {
    case "edit_files":
      return records(args.edits).map((edit) => ({
        path: string(edit.path),
        detail: "Replace text",
        before: string(edit.find),
        after: string(edit.replace),
      }));
    case "read_files":
      return readRows(records(args.files), data);
    case "write_files":
      return records(args.files).map((file) => {
        const content = string(file.content);
        const count = content === "" ? 0 : content.split("\n").length;
        return {
          path: string(file.path),
          detail: pluralize(count, "line", "lines"),
          content,
        };
      });
    case "delete":
    case "mkdir":
      return (Array.isArray(args.paths) ? args.paths : [])
        .filter((path): path is string => typeof path === "string")
        .map((path) => ({
          path,
          detail: kind === "delete" ? "Delete" : "Create folder",
        }));
    default:
      return [];
  }
}

interface FileEntryProps {
  row: PreparedFileRow;
}

function FileEntry(props: FileEntryProps) {
  const { row } = props;
  return (
    <li class={classes.fileEntry}>
      <div class={classes.fileHeader}>
        <Icon name="file" class={classes.fileIcon} aria-hidden="true" />
        <span class={classes.path} title={row.path}>
          <span class={classes.pathText} dir="ltr">
            {row.path}
          </span>
        </span>
        <span class={classes.detail}>{row.detail}</span>
      </div>
      {If(row.failure, (message) => (
        <p class={classes.error} role="alert">
          {message}
        </p>
      ))}
      {If(row.preview, (preview) => (
        <FadeScroll
          class={classes.fileBody}
          tabIndex={0}
          role="region"
          aria-label={`Preview of ${row.path}`}
        >
          <FilePreview preview={preview} />
        </FadeScroll>
      ))}
    </li>
  );
}

/** Confirm successful mutations from the result, not the requested operations. */
export function fileToolModel(props: FileToolDetailsProps): FileToolModel {
  const { kind, output, status, error } = props;
  const args = asRecord(props.args) ?? {};
  const data = asRecord(output);
  const rows = rowsFor(kind, args, data);
  const isRead = kind === "read_files";
  const isSearch =
    kind === "search_files" || kind === "search_file_contents" || kind === "get_file_tree";
  const isMutation =
    kind === "edit_files" || kind === "write_files" || kind === "delete" || kind === "mkdir";
  const received = status === "completed" && error == null && data !== null;
  const resultCount = kind === "edit_files" ? data?.replacements : data?.files;
  const confirmed =
    isMutation && received && typeof resultCount === "number" && resultCount === rows.length;
  const succeeded = records(data?.files).length;
  const failed = records(data?.errors).length;
  const title = TOOL_TITLES[kind][confirmed ? 1 : 0];
  const count = isRead
    ? received
      ? `${succeeded} read${failed ? ` · ${failed} failed` : ""}`
      : `${rows.length} requested`
    : isMutation
      ? kind === "edit_files"
        ? pluralize(rows.length, "replacement", "replacements")
        : pluralize(rows.length, "path", "paths")
      : "";
  const errors = isRead
    ? []
    : records(data?.errors).map((item) => string(item.message) || "File operation failed");
  const path = string(args.in) || string(args.path);
  const query = string(args.query) || string(args.regex);
  const maxResults =
    typeof args.max_results === "number" || typeof args.max_results === "string"
      ? String(args.max_results)
      : "";
  const plain = typeof output === "string" ? output : string(data?.content) || string(data?.text);
  const handled = isRead
    ? ["files", "errors"]
    : isSearch
      ? ["content", "text", "errors"]
      : ["files", "replacements", "errors"];
  const other =
    data === null
      ? null
      : Object.fromEntries(Object.entries(data).filter(([name]) => !handled.includes(name)));
  const showOther = other !== null && Object.keys(other).length > 0 && plain === "";
  const resultSummary = confirmed
    ? kind === "edit_files"
      ? `${resultCount} replacements applied`
      : `${resultCount} paths processed`
    : null;

  return {
    kind,
    rows,
    isRead,
    isSearch,
    isMutation,
    confirmed,
    title,
    count,
    path,
    query,
    maxResults,
    plain,
    errors,
    error,
    showOther,
    other,
    resultSummary,
    status,
  };
}

export function FileToolDetails(props: PreparedFileToolDetailsProps) {
  const { prepared } = props;
  const {
    rows,
    isSearch,
    title,
    count,
    path,
    query,
    maxResults,
    plain,
    errors,
    error,
    showOther,
    other,
    resultSummary,
  } = prepared;

  return (
    <section class={classes.root}>
      <h3 class={classes.heading}>
        {title}
        {If(!isSearch, () => (
          <span>{count}</span>
        ))}
      </h3>
      {If(isSearch && path !== "", () => (
        <div class={classes.query}>
          <span>In</span>
          <code title={path}>{path}</code>
        </div>
      ))}
      {If(isSearch && query !== "", () => (
        <div class={classes.query}>
          <span>Query</span>
          <code title={query}>{query}</code>
        </div>
      ))}
      {If(isSearch && maxResults !== "", () => (
        <div class={classes.query}>
          <span>Max results</span>
          <code>{maxResults}</code>
        </div>
      ))}
      {If(rows.length > 0, () => (
        <ul class={classes.files} data-entries={String(rows.length)}>
          {For(rows, (row) => (
            <FileEntry row={row} />
          ))}
        </ul>
      ))}
      {If(!isSearch && rows.length === 0, () => (
        <p class={classes.empty}>No paths specified.</p>
      ))}
      {If(isSearch && plain !== "", () => (
        <pre class={classes.source} tabIndex={0}>
          <code>{plain}</code>
        </pre>
      ))}
      {If(resultSummary, (summary) => (
        <p class={classes.muted}>{summary}</p>
      ))}
      {If(error, (message) => (
        <p class={classes.error} role="alert">
          {message}
        </p>
      ))}
      {For(errors, (message) => (
        <p class={classes.error} role="alert">
          {message}
        </p>
      ))}
      {If(showOther, () => (
        <div class={classes.extra}>
          <h4 class={classes.extraHeading}>Additional output</h4>
          <ToolValue value={other} />
        </div>
      ))}
    </section>
  );
}

/** Show a preview only when the call includes content. */
async function prepareRow(row: FileRow): Promise<PreparedFileRow> {
  const hasBody =
    (row.before !== undefined && row.after !== undefined) || row.content !== undefined;
  return { ...row, preview: hasBody ? await buildFilePreview(row) : null };
}

/**
 * Prepare diff and syntax-highlighted rows before rendering, so the viewer needs no additional
 * async work.
 */
export async function prepareFileToolDetails(
  props: FileToolDetailsProps,
): Promise<PreparedFileToolDetails> {
  const model = fileToolModel(props);
  const rows = await Promise.all(model.rows.map(prepareRow));
  return { ...model, rows };
}
