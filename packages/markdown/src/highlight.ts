import {
  type BundledLanguage,
  bundledLanguages,
  bundledLanguagesAlias,
  createCssVariablesTheme,
  createHighlighter,
} from "shiki";

const MAX_CODE_LENGTH = 40_000;

/**
 * Map supported TextMate token roles to stylesheet colors. Leave unsupported scopes unstyled
 * instead of referencing undefined theme variables.
 */
const STYLES = new Set([
  "comment",
  "string",
  "string-expression",
  "number",
  "type",
  "operator",
  "constant",
  "keyword",
  "parameter",
  "function",
  "punctuation",
  "link",
  "inserted",
  "deleted",
  "changed",
]);

/** Known language extensions and exact filenames. */
const FILE_LANGUAGES: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dockerfile: "docker",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  php: "php",
  pl: "perl",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zsh: "bash",
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** Split preview lines without counting a trailing newline as an extra empty row. */
export function toLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Infer the language from the filename before examining content. Return an empty string when
 * unknown.
 */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (Object.hasOwn(FILE_LANGUAGES, name)) return FILE_LANGUAGES[name];
  const extension = name.slice(name.lastIndexOf(".") + 1);
  return Object.hasOwn(FILE_LANGUAGES, extension) ? FILE_LANGUAGES[extension] : "";
}

// Initialize Shiki with the app to reduce first-code-block latency.
const highlighterReady = createHighlighter({
  themes: [
    createCssVariablesTheme({
      name: "squire",
      variablePrefix: "--squire-code-",
      fontStyle: false,
    }),
  ],
  langs: [],
});
// Let callers fall back to plain text if initialization fails.
highlighterReady.catch(() => undefined);

/**
 * Serialize grammar loading to avoid concurrent registry writes and incomplete tokenization.
 */
let languageQueue: Promise<void> = Promise.resolve();

function ensureLanguage(
  highlighter: Awaited<typeof highlighterReady>,
  language: BundledLanguage,
): Promise<void> {
  const load = languageQueue.then(async () => {
    if (highlighter.getLoadedLanguages().includes(language)) return;
    await highlighter.loadLanguage(language);
  });
  languageQueue = load.catch(() => undefined);
  return load;
}

function guessLanguage(source: string): string {
  const value = source.trimStart();
  if (/^[{[]/.test(value)) {
    try {
      JSON.parse(value);
      return "json";
    } catch {
      // This can be source code rather than JSON.
    }
  }
  if (/^(?:export\s+)?(?:interface|type|enum)\s+\w+|^import\s+type\b/m.test(value))
    return "typescript";
  if (/^(?:import |export |const |let |var |function |class )/m.test(value)) return "javascript";
  if (/^(?:def |from \w+ import |#!.*python)/m.test(value)) return "python";
  if (/^(?:#!.*(?:ba|z|)sh|\$ )/m.test(value)) return "bash";
  if (/^(?:SELECT |INSERT |UPDATE |DELETE |CREATE TABLE )/im.test(value)) return "sql";
  return "";
}

interface SourceToken {
  content: string;
  color?: string;
}

/**
 * Return tokens per line, or null for oversized content, unknown languages, or an unavailable
 * highlighter.
 */
async function tokenize(source: string, language: string): Promise<SourceToken[][] | null> {
  if (!source.trim() || source.length > MAX_CODE_LENGTH) return null;

  const chosen = (language.trim().toLowerCase() || guessLanguage(source)).replace(/^language-/, "");
  if (!chosen || chosen === "text" || chosen === "plaintext") return null;

  try {
    const highlighter = await highlighterReady;
    if (!(chosen in bundledLanguages) && !(chosen in bundledLanguagesAlias)) return null;
    const selected = chosen as BundledLanguage;
    await ensureLanguage(highlighter, selected);
    const { tokens } = highlighter.codeToTokens(source, { lang: selected, theme: "squire" });
    return tokens;
  } catch {
    return null;
  }
}

/** Changed character range within one line. */
export interface LineChange {
  start: number;
  end: number;
}

interface Piece {
  text: string;
  changed: boolean;
}

/** Split tokens at changed-range boundaries. */
function splitAtChanges(text: string, offset: number, changes: LineChange[]): Piece[] {
  if (changes.length === 0) return [{ text, changed: false }];

  const end = offset + text.length;
  const bounds = new Set<number>([offset, end]);
  for (const change of changes) {
    if (change.start > offset && change.start < end) bounds.add(change.start);
    if (change.end > offset && change.end < end) bounds.add(change.end);
  }

  const stops = [...bounds].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const start = stops[index];
    const stop = stops[index + 1];
    pieces.push({
      text: text.slice(start - offset, stop - offset),
      changed: changes.some((change) => change.start < stop && change.end > start),
    });
  }
  return pieces;
}

/** Escape an unhighlighted line while retaining changed spans. */
function renderPlainLine(text: string, changes: LineChange[]): string {
  return splitAtChanges(text, 0, changes)
    .map((piece) =>
      piece.changed ? `<span data-change>${escapeHtml(piece.text)}</span>` : escapeHtml(piece.text),
    )
    .join("");
}

/** Render escaped line markup using only supported token roles. */
function renderLine(tokens: SourceToken[], changes: LineChange[]): string {
  const parts: string[] = [];
  let offset = 0;

  for (const token of tokens) {
    const role = /--squire-code-token-([a-z-]+)/.exec(token.color ?? "")?.[1];
    const syntax = role && STYLES.has(role) ? role : null;
    for (const piece of splitAtChanges(token.content, offset, changes)) {
      const contents = escapeHtml(piece.text);
      const text = piece.changed ? `<span data-change>${contents}</span>` : contents;
      parts.push(syntax ? `<span data-syntax="${syntax}">${text}</span>` : text);
    }
    offset += token.content.length;
  }

  return parts.join("");
}

/**
 * Escape source and attach fixed `data-syntax` token roles. Do not emit model-controlled CSS.
 */
export async function highlightCode(source: string, language = ""): Promise<string> {
  const fallback = () => escapeHtml(source);
  const tokens = await tokenize(source, language);
  if (!tokens) return fallback();

  const contents = tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
  // Preserve exact source text, including trailing newlines, for copying.
  if (contents !== source) return fallback();

  return tokens.map((line) => renderLine(line, [])).join("\n");
}

export interface HighlightedLines {
  /** Escaped syntax markup for each source line. */
  lines: string[];
  /** Whether highlighting fell back to plain escaped lines. */
  plain: boolean;
}

/**
 * Highlight lines independently for diff and numbered previews. Preserve alignment with
 * `toLines(source)` and fall back to escaped source if token text or line counts differ. Apply
 * per-line changed ranges at the same indices.
 */
export async function highlightLines(
  source: string,
  language = "",
  changes: LineChange[][] = [],
): Promise<HighlightedLines> {
  if (source === "") return { lines: [], plain: false };
  const lines = toLines(source);
  // Preserve changed ranges in plain-text fallback output.
  const plain = {
    lines: lines.map((line, index) => renderPlainLine(line, changes[index] ?? [])),
    plain: true,
  };

  const tokens = await tokenize(source, language);
  if (!tokens) return plain;

  // Discard Shiki's synthetic final line from the preview.
  const shown =
    tokens.length === lines.length + 1 && tokens[tokens.length - 1].length === 0
      ? tokens.slice(0, -1)
      : tokens;
  if (shown.length !== lines.length) return plain;

  const texts = shown.map((line) => line.map((token) => token.content).join(""));
  if (texts.some((text, index) => text !== lines[index])) return plain;

  return {
    lines: shown.map((line, index) => renderLine(line, changes[index] ?? [])),
    plain: false,
  };
}
