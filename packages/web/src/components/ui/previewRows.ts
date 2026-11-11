import {
  escapeHtml,
  highlightLines,
  languageForPath,
  toLines,
  type LineChange,
} from "@squire/markdown/highlight";
import { diffWordsWithSpace, structuredPatch, type Change, type StructuredPatchHunk } from "diff";

/** Context lines retained around each diff hunk. */
const DIFF_CONTEXT = 3;
/** Maximum rows in a file preview. */
const MAX_ROWS = 400;

export interface PreviewLine {
  /** `gap` separates distant hunks; `context` rows are unchanged code. */
  kind: "context" | "add" | "remove" | "gap";
  /**
   * Gutter label. Content previews use source line numbers; snippet diffs omit relative line
   * numbers.
   */
  label: string;
  /** Escaped syntax markup for one source line. */
  html: string;
}

export interface FilePreviewModel {
  mode: "diff" | "content";
  lines: PreviewLine[];
  /** Whether syntax highlighting fell back to escaped text. */
  plain: boolean;
  /** Whether the preview omits trailing content. */
  truncated: boolean;
}

export interface FilePreviewRequest {
  path: string;
  before?: string;
  after?: string;
  content?: string;
  startLine?: number;
}

interface DraftLines {
  lines: PreviewLine[];
  plain: boolean;
  truncated: boolean;
}

interface HunkEmphasis {
  old: LineChange[][];
  next: LineChange[][];
}

/** Hunk text without its diff marker or line ending. */
function lineText(line: string): string {
  return line.slice(1).replace(/\r?\n$/, "");
}

/** Exclude diff metadata such as the no-newline marker. */
function isContent(line: string): boolean {
  return !line.startsWith("\\");
}

/** Highlight each side as a complete string to preserve multiline token scopes. */
function sideText(lines: string[], marker: string): string {
  return lines
    .filter((line) => isContent(line) && !line.startsWith(marker))
    .map(lineText)
    .join("\n");
}

/** Text present on only one side of a word diff. */
function changesFor(changes: Change[], side: "old" | "next"): LineChange[] {
  const spans: LineChange[] = [];
  let offset = 0;
  for (const change of changes) {
    const changed = side === "old" ? change.removed : change.added;
    const absent = side === "old" ? change.added : change.removed;
    if (changed) spans.push({ start: offset, end: offset + change.value.length });
    if (!absent) offset += change.value.length;
  }
  return spans;
}

/**
 * Pair removed and added lines for word-level highlighting. Unpaired lines use the row-level
 * added or removed style.
 */
function emphasisFor(hunk: StructuredPatchHunk): HunkEmphasis {
  const rows = hunk.lines
    .filter(isContent)
    .map((line) => ({ kind: line[0], text: lineText(line) }));
  const oldTexts: string[] = [];
  const nextTexts: string[] = [];
  const old: LineChange[][] = [];
  const next: LineChange[][] = [];

  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind === "-") {
      const removed: number[] = [];
      const added: number[] = [];
      while (index < rows.length && rows[index].kind === "-") {
        removed.push(old.length);
        old.push([]);
        oldTexts.push(rows[index].text);
        index += 1;
      }
      while (index < rows.length && rows[index].kind === "+") {
        added.push(next.length);
        next.push([]);
        nextTexts.push(rows[index].text);
        index += 1;
      }

      const pairs = Math.min(removed.length, added.length);
      for (let pair = 0; pair < pairs; pair += 1) {
        const changes = diffWordsWithSpace(oldTexts[removed[pair]], nextTexts[added[pair]]);
        old[removed[pair]] = changesFor(changes, "old");
        next[added[pair]] = changesFor(changes, "next");
      }
      continue;
    }

    if (rows[index].kind === "+") {
      next.push([]);
      nextTexts.push(rows[index].text);
    } else {
      old.push([]);
      next.push([]);
      oldTexts.push(rows[index].text);
      nextTexts.push(rows[index].text);
    }
    index += 1;
  }

  return { old, next };
}

async function diffLines(before: string, after: string, language: string): Promise<DraftLines> {
  const { hunks } = structuredPatch("", "", before, after, "", "", { context: DIFF_CONTEXT });
  const lines: PreviewLine[] = [];
  let plain = false;

  // Show the full file when an edit produces no diff.
  if (hunks.length === 0) {
    const whole = await highlightLines(after, language);
    const rows: PreviewLine[] = whole.lines.map((html) => ({ kind: "context", label: "", html }));
    return { lines: rows, plain: whole.plain, truncated: false };
  }

  for (const hunk of hunks) {
    if (lines.length > 0) lines.push({ kind: "gap", label: "", html: "" });
    const emphasis = emphasisFor(hunk);
    const oldSide = await highlightLines(sideText(hunk.lines, "+"), language, emphasis.old);
    const newSide = await highlightLines(sideText(hunk.lines, "-"), language, emphasis.next);
    plain ||= oldSide.plain || newSide.plain;

    let old = 0;
    let next = 0;
    for (const line of hunk.lines) {
      if (!isContent(line)) continue;
      const text = lineText(line);
      if (line.startsWith("-")) {
        lines.push({ kind: "remove", label: "", html: oldSide.lines[old++] ?? escapeHtml(text) });
      } else if (line.startsWith("+")) {
        lines.push({ kind: "add", label: "", html: newSide.lines[next++] ?? escapeHtml(text) });
      } else {
        lines.push({ kind: "context", label: "", html: newSide.lines[next++] ?? escapeHtml(text) });
        old += 1;
      }
    }
  }

  return { lines, plain, truncated: false };
}

async function numberedLines(
  content: string,
  startLine: number,
  language: string,
): Promise<DraftLines> {
  // Only the rows a preview shows are highlighted.
  const all = toLines(content);
  const shown = all.slice(0, MAX_ROWS);
  const { lines, plain } = await highlightLines(shown.join("\n"), language);
  const first = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
  const rows: PreviewLine[] = lines.map((html, index) => ({
    kind: "context",
    label: String(first + index),
    html,
  }));
  return { lines: rows, plain, truncated: all.length > shown.length };
}

/**
 * Prepare file preview rows without a DOM. Preserve line count and fall back to escaped text if
 * highlighting fails.
 */
export async function buildFilePreview(request: FilePreviewRequest): Promise<FilePreviewModel> {
  const { path, before, after, content, startLine } = request;
  const language = languageForPath(path);
  const isDiff = before !== undefined && after !== undefined;

  const draft = isDiff
    ? await diffLines(before, after, language)
    : await numberedLines(content ?? "", startLine ?? 1, language);

  const lines = draft.lines.slice(0, MAX_ROWS);
  // Omit trailing separators.
  if (lines.at(-1)?.kind === "gap") lines.pop();

  return {
    mode: isDiff ? "diff" : "content",
    lines,
    plain: draft.plain,
    truncated: draft.truncated || draft.lines.length > lines.length,
  };
}
