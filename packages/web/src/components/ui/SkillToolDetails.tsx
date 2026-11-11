import { Cell, For, If } from "retend";
import { Icon } from "squire-ui";

import { Markdown } from "@/components/views/Chat/Markdown";
import { asRecord } from "@/utils/misc";

import classes from "./SkillToolDetails.module.css";

type Data = Record<string, unknown>;
type SkillStatus = "loaded" | "failed" | "waiting" | "unavailable";

interface SkillRow {
  name: string;
  description: string;
  includeResources: boolean;
  content: string | null;
  instructions: string | null;
  error: string | null;
  status: SkillStatus;
}

interface SkillToolDetailsProps {
  args: unknown;
  output: unknown;
  status: string;
  error?: string | null;
}

function objects(value: unknown): Data[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Data => item !== null)
    : [];
}

function nameOf(item: Data): string {
  return typeof item.skill === "string" ? item.skill : "";
}

/** Remove the transport header and YAML frontmatter from skill content. */
function skillInstructions(content: string): string {
  const marker = /(?:^|\n)## Instructions\r?\n/;
  const match = marker.exec(content);
  const body = match ? content.slice(match.index + match[0].length) : content;
  const frontmatter = /^---\r?\nname:[\s\S]*?\r?\n---\r?\n/.exec(body);
  return (frontmatter ? body.slice(frontmatter[0].length) : body).trimStart();
}

function takeMatching(items: Data[], name: string): Data | undefined {
  const index = items.findIndex((item) => nameOf(item) === name);
  return index < 0 ? undefined : items.splice(index, 1)[0];
}

/** Match each requested skill to its result. */
export function skillToolModel(props: SkillToolDetailsProps) {
  const args = asRecord(props.args);
  const data = asRecord(props.output);
  const successes = objects(data?.skills);
  const failures = objects(data?.errors);
  const requests = objects(args?.skills);
  const failed = props.status === "error" || Boolean(props.error);
  const selected: Data[] =
    requests.length > 0
      ? requests
      : [...successes, ...failures].map((item) => ({ skill: nameOf(item) }));
  const rows: SkillRow[] = selected.map((request) => {
    const name = nameOf(request);
    const success = takeMatching(successes, name);
    const failure = success ? undefined : takeMatching(failures, name);
    const content = typeof success?.content === "string" ? success.content : null;
    const error = typeof failure?.message === "string" ? failure.message : null;
    return {
      name: name || "Unnamed skill",
      description: content?.match(/^# Skill: [^\n]*\n([^\n]*)/)?.[1]?.trim() ?? "",
      includeResources: request.include_resources === true,
      content,
      instructions: content === null ? null : skillInstructions(content),
      error,
      status: error
        ? "failed"
        : content !== null
          ? "loaded"
          : failed
            ? "failed"
            : props.status === "running" || props.status === "pending"
              ? "waiting"
              : "unavailable",
    };
  });
  const unmatchedErrors = failures.map((item) =>
    typeof item.message === "string" ? item.message : "Skill could not be loaded",
  );
  return { rows, errors: unmatchedErrors, error: props.error };
}

interface SkillEntryProps {
  row: SkillRow;
}

function SkillEntry(props: SkillEntryProps) {
  const { row } = props;
  const open = Cell.source(false);
  const toggle = () => open.set(!open.get());
  const statusLabel = {
    loaded: "Loaded",
    failed: "Failed",
    waiting: "Loading",
    unavailable: "No result",
  }[row.status];
  const heading = (
    <>
      <Icon name="brain" class={classes.icon} aria-hidden="true" />
      <span class={classes.name} title={row.name}>
        {row.name}
      </span>
      {If(row.includeResources, () => (
        <span class={classes.resources}>Resources requested</span>
      ))}
      <span class={classes.status}>{statusLabel}</span>
      {If(row.content !== null, () => (
        <Icon name="caret" class={classes.caret} aria-hidden="true" />
      ))}
    </>
  );
  return (
    <li class={classes.entry} data-status={row.status}>
      {If(row.content !== null, {
        true: () => (
          <button type="button" class={classes.header} onClick={toggle} aria-expanded={open}>
            {heading}
          </button>
        ),
        false: () => <div class={classes.header}>{heading}</div>,
      })}
      {If(row.description !== "", () => (
        <p class={classes.description}>{row.description}</p>
      ))}
      {If(row.error, (message) => (
        <p class={classes.error} role="alert">
          {message}
        </p>
      ))}
      {If(row.status === "unavailable", () => (
        <p class={classes.muted}>No content was returned for this skill.</p>
      ))}
      {If(row.content !== null, () =>
        If(open, () => (
          <div
            class={classes.content}
            role="region"
            aria-label={`Instructions for ${row.name}`}
            tabIndex={0}
          >
            <Markdown text={row.instructions ?? ""} />
          </div>
        )),
      )}
    </li>
  );
}

/** Render skill Markdown only when expanded. */
export function SkillToolDetails(props: SkillToolDetailsProps) {
  const { args, output, status, error: resultError } = props;
  const { rows, errors, error } = skillToolModel({ args, output, status, error: resultError });
  return (
    <section class={classes.root}>
      <h3 class={classes.title}>
        Skills <span>{rows.length}</span>
      </h3>
      {If(rows.length > 0, () => (
        <ul class={classes.list}>
          {For(rows, (row) => (
            <SkillEntry row={row} />
          ))}
        </ul>
      ))}
      {If(rows.length === 0, () => (
        <p class={classes.muted}>No skills specified.</p>
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
    </section>
  );
}
