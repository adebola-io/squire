import { For, If } from "retend";

import { asRecord } from "@/utils/misc";

import {
  FileToolDetails,
  fileToolKind,
  type FileToolStatus,
  prepareFileToolDetails,
  type PreparedFileToolDetails,
} from "./FileToolDetails";
import { SkillToolDetails } from "./SkillToolDetails";
import { ToolValue, toolValueCode } from "./ToolValue";

import classes from "./ParallelToolDetails.module.css";

interface ParallelToolDetailsProps {
  calls: unknown;
  output: unknown;
  status: FileToolStatus;
  error?: string | null;
}

function message(value: unknown): string | null {
  const error = asRecord(value);
  return typeof error?.message === "string" ? error.message : null;
}

/** Results correspond to calls by index, including individual failures. */
export function parallelToolItems(props: ParallelToolDetailsProps) {
  const calls = Array.isArray(props.calls) ? props.calls : [];
  const results = asRecord(props.output)?.results;
  const completed = Array.isArray(results) ? results : [];
  return calls.map((value, index) => {
    const call = asRecord(value);
    const result = asRecord(completed[index]);
    const tool = typeof call?.tool === "string" ? call.tool : "Unknown tool";
    const error = message(result?.error);
    const status: FileToolStatus = result
      ? error
        ? "error"
        : "completed"
      : props.status === "completed" || props.status === "error"
        ? "interrupted"
        : props.status;
    return {
      tool,
      args: call?.arguments ?? {},
      kind: fileToolKind(tool),
      output: result?.structuredContent ?? null,
      error,
      status,
    };
  });
}

/** Highlight only generic children; file previews render their own tokens. */
export function parallelToolCode(props: ParallelToolDetailsProps): string[] {
  return parallelToolItems(props).flatMap((item) =>
    item.kind === null && item.tool !== "use_skills"
      ? [...toolValueCode(item.args), ...toolValueCode(item.output)]
      : [],
  );
}

const STATUS_LABELS: Record<FileToolStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  error: "Failed",
  skipped: "Skipped",
  interrupted: "Outcome unknown",
};

interface PreparedParallelItem {
  item: ReturnType<typeof parallelToolItems>[number];
  /** Prepared file previews for a nested file-tool call. */
  details: PreparedFileToolDetails | null;
}

export interface PreparedParallelToolDetails {
  items: PreparedParallelItem[];
  error?: string | null;
}

/**
 * Prepare nested file previews with their calls so the parallel viewer renders synchronously.
 */
export async function prepareParallelToolDetails(
  props: ParallelToolDetailsProps,
): Promise<PreparedParallelToolDetails> {
  const items = await Promise.all(
    parallelToolItems(props).map(async (item) => ({
      item,
      details:
        item.kind === null
          ? null
          : await prepareFileToolDetails({
              kind: item.kind,
              args: item.args,
              output: item.output,
              status: item.status,
              error: item.error,
            }),
    })),
  );
  return { items, error: props.error };
}

interface ParallelEntryProps {
  entry: PreparedParallelItem;
}

function ParallelEntry(props: ParallelEntryProps) {
  const { entry } = props;
  const { item, details } = entry;
  return (
    <li class={classes.entry} data-status={item.status}>
      <div class={classes.header}>
        <span class={classes.index} aria-hidden="true" />
        <strong class={classes.name} title={item.tool}>
          {item.tool}
        </strong>
        <span class={classes.status}>{STATUS_LABELS[item.status]}</span>
      </div>
      {If(details, {
        true: (prepared) => <FileToolDetails prepared={prepared} />,
        false: () =>
          If(item.tool === "use_skills", {
            true: () => (
              <SkillToolDetails
                args={item.args}
                output={item.output}
                status={item.status}
                error={item.error}
              />
            ),
            false: () => (
              <>
                <div class={classes.section}>
                  <h4>Input</h4>
                  <div class={classes.value}>
                    <ToolValue value={item.args} />
                  </div>
                </div>
                {If(item.output !== null, () => (
                  <div class={classes.section}>
                    <h4>Output</h4>
                    <div class={classes.value}>
                      <ToolValue value={item.output} />
                    </div>
                  </div>
                ))}
                {If(item.error, (error) => (
                  <p class={classes.error} role="alert">
                    {error}
                  </p>
                ))}
              </>
            ),
          }),
      })}
    </li>
  );
}

interface PreparedParallelToolDetailsProps {
  prepared: PreparedParallelToolDetails;
}

/** Render nested calls directly without an extra argument table. */
export function ParallelToolDetails(props: PreparedParallelToolDetailsProps) {
  const { prepared } = props;
  const { items, error } = prepared;
  return (
    <section class={classes.root}>
      <h3 class={classes.title}>
        Parallel calls <span>{items.length}</span>
      </h3>
      <ol class={classes.list}>
        {For(items, (entry) => (
          <ParallelEntry entry={entry} />
        ))}
      </ol>
      {If(error, (message) => (
        <p class={classes.error} role="alert">
          {message}
        </p>
      ))}
    </section>
  );
}
