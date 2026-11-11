import { If } from "retend";

import { HighlightedCode } from "@/components/views/Activity/HighlightedCode";

import { ValueArray } from "./ToolValueArray";
import { ValueTable } from "./ToolValueTable";

import classes from "./ToolValue.module.css";

const MAX_JSON_LENGTH = 200_000;
/** Page size for array and object output. */
export const TOOL_VALUE_PAGE_SIZE = 40;

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Render top-level strings and code-like named fields as code. */
function showsAsCode(value: string, name: string | undefined) {
  return (
    name === undefined ||
    /^(code|script|source|sql|diff|patch|command|expression)$/i.test(name) ||
    /^\s*(?:const |let |var |import |export |function |class |def |SELECT |INSERT |UPDATE |#!)/m.test(
      value,
    )
  );
}

/**
 * Collect code shown on the first page for `prepareHighlightedCode`. Keep traversal consistent
 * with `Value`, `ValueArray` and `ValueTable`.
 */
function valueCode(source: unknown, name: string | undefined, out: string[]) {
  const value = decodeToolValue(source);
  if (typeof value === "string") {
    if (showsAsCode(value, name)) out.push(value || "—");
    return;
  }
  if (!isContainer(value)) return;
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item) => ["item", item])
    : Object.entries(value);
  for (const [key, entry] of entries.slice(0, TOOL_VALUE_PAGE_SIZE)) {
    const nested = decodeToolValue(entry);
    if (isContainer(nested)) {
      out.push(JSON.stringify(nested, null, 2));
    } else {
      valueCode(nested, key, out);
    }
  }
}

/** Code highlighted when this tool value first renders. */
export function toolValueCode(value: unknown): string[] {
  const out: string[] = [];
  valueCode(decodeToolValue(value), undefined, out);
  return out;
}

/** Parse complete JSON and decode common double-escaped tool output safely. */
export function decodeToolValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_JSON_LENGTH) return value;
  const text = value.trim();
  if (/^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A tool may return JSON inside a second string escaping layer.
    }
  }

  // This is display-only; all text is escaped by JSX or highlightCode.
  const readable = value
    .replace(/\\\\/g, "\\")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');
  if (readable !== value && /^[\s]*[[{]/.test(readable)) {
    try {
      return JSON.parse(readable) as unknown;
    } catch {
      // Show the readable lines even when this was only a JSON fragment.
    }
  }
  return readable;
}

interface ToolValueProps {
  value: unknown;
  error?: boolean;
}

/** Shared output viewer for chat and connection tool calls. */
export function ToolValue(props: ToolValueProps) {
  const { value, error = false } = props;
  return (
    <div class={classes.root} data-error={error}>
      <Value value={decodeToolValue(value)} />
    </div>
  );
}

interface ValueProps {
  value: unknown;
  name?: string;
}

/** Nested objects show as highlighted JSON instead of recursively paginated tables. */
export function NestedValue(props: ValueProps) {
  const value = decodeToolValue(props.value);
  return If(isContainer(value), {
    true: () => (
      <div class={classes.code}>
        <HighlightedCode source={JSON.stringify(value, null, 2)} />
      </div>
    ),
    false: () => <Value value={value} name={props.name} />,
  });
}

export function Value(props: ValueProps) {
  const { value: source, name } = props;
  const value = decodeToolValue(source);

  if (value === null || value === undefined) {
    return <span class={classes.muted}>null</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return (
      <code class={classes.scalar} data-type={typeof value}>
        {String(value)}
      </code>
    );
  }
  if (typeof value === "string") {
    if (showsAsCode(value, name)) {
      const content = value || "—";
      return (
        <div class={classes.code}>
          <HighlightedCode source={content} />
        </div>
      );
    }
    const content = value === "" ? '""' : value;
    return (
      <span class={classes.string} title={value}>
        {content}
      </span>
    );
  }
  if (!isContainer(value)) {
    return <span class={classes.string}>{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return <ValueArray items={value} />;
  }
  return <ValueTable entries={Object.entries(value)} />;
}
