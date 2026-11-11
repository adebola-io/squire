import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

import type { MermaidDiagram } from "./types";
import { highlightCode } from "./highlight";
import { renderMermaid } from "./mermaid";

/**
 * Render CommonMark and GitHub extensions. Sanitize assistant HTML; escape all HTML in user
 * messages and work logs. Both paths share formatting and code highlighting.
 */
export const md = new MarkdownIt("default", {
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
});

/** Start reply headings at h3 to keep them below page and chat headings. */
const HEADING_SHIFT: Record<string, string> = {
  h1: "h3",
  h2: "h4",
  h3: "h5",
  h4: "h6",
  h5: "h6",
  h6: "h6",
};

const shiftHeading: NonNullable<typeof md.renderer.rules.heading_open> = (
  tokens,
  index,
  options,
  _env,
  self,
) => {
  const token = tokens[index];
  token.tag = HEADING_SHIFT[token.tag] ?? token.tag;
  return self.renderToken(tokens, index, options);
};
md.renderer.rules.heading_open = shiftHeading;
md.renderer.rules.heading_close = shiftHeading;

// Allow `file:` links for app-controlled opening, not browser navigation.
const defaultValidateLink = md.validateLink.bind(md);
md.validateLink = (url) => /^file:/i.test(url.trim()) || defaultValidateLink(url);

/** Attribute containing the local path handled by the app. */
export const LOCAL_PATH_ATTRIBUTE = "data-local-path";
export const LOCAL_PATH_SELECTOR = `a[${LOCAL_PATH_ATTRIBUTE}]`;

/** Permit HTML only in assistant replies, then sanitize the rendered output. */
for (const type of ["html_block", "html_inline"]) {
  md.renderer.rules[type] = (tokens, index, _options, env) => {
    const source = tokens[index].content;
    if (!env.interactive) return md.utils.escapeHtml(source);
    // parse5 follows HTML (not XML) self-closing rules for custom tags.
    // The HTML parser aliases <Image> to the native <img> tag, so keep this
    // declarative component distinct until the controlled component pass.
    return source
      .replace(/<Image\b([^<>]*?)\s*\/>/gi, "<squire-image$1></squire-image>")
      .replace(/<Image\b([^<>]*?)>/gi, "<squire-image$1>")
      .replace(/<\/Image\s*>/gi, "</squire-image>")
      .replace(/<Icon\b([^<>]*?)\s*\/>/gi, "<Icon$1></Icon>");
  };
}

/** Recognized app routes; other absolute paths are local files. */
const APP_PATH = /^\/(?:(?:chat|connections|plugins|settings)(?:[/?#]|$)|[?#]|$)/;
/** File-position fragments to strip from paths: `#L42`, `#L42C3`, and `#L42-L50`. */
const LINE_FRAGMENT = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
/**
 * A Windows drive path, `C:/x` or `C:\x`. markdown-it percent-encodes backslashes, so `%5C`
 * stands for `\`. Tested before {@link URL_SCHEME}, which would read the drive as a scheme.
 */
const DRIVE_PATH = /^[a-z]:(?:[\\/]|%5c)/i;
/**
 * A UNC share, `\\server\share\x`: a server name between leading and following backslashes.
 * Markdown reads `\\` as an escaped `\`, so `[a](\\server\share)` arrives with one leading
 * backslash; one or two both mean the share.
 */
const UNC_PATH = /^(?:\\|%5c){1,2}[^\\/%?#]+(?:\\|%5c)/i;
const LEADING_BACKSLASHES = /^(?:\\|%5c)+/i;

type LinkTarget =
  | { kind: "web" }
  | { kind: "scheme" }
  | { kind: "app" }
  | { kind: "local"; path: string }
  | { kind: "unresolved" };

function decodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Distinguish web links, app routes and local file paths. Local paths must open through the app
 * rather than resolve against its origin.
 */
export function classifyLink(href: string): LinkTarget {
  if (/^(?:https?:)?\/\//i.test(href)) return { kind: "web" };
  if (href.startsWith("#")) return { kind: "app" };
  let path: string;
  if (/^file:/i.test(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return { kind: "unresolved" };
    }
    if (url.hostname && url.hostname !== "localhost") {
      // `file://server/share/x` names a UNC share by its host.
      path = `\\\\${url.hostname}${url.pathname.replace(/\//g, "\\")}`;
    } else if (/^\/\/[^/]/.test(url.pathname)) {
      // So does `file:////server/share/x`, with an empty host.
      path = url.pathname.replace(/\//g, "\\");
    } else {
      // `file:///C:/x` is the drive path `C:/x`.
      path = url.pathname.replace(/^\/(?=[A-Za-z]:\/)/, "");
    }
  } else if (DRIVE_PATH.test(href)) {
    path = href;
  } else if (UNC_PATH.test(href)) {
    path = `\\\\${href.replace(LEADING_BACKSLASHES, "")}`;
  } else if (URL_SCHEME.test(href)) {
    return { kind: "scheme" };
  } else if (href.startsWith("/")) {
    if (APP_PATH.test(href)) return { kind: "app" };
    path = href;
  } else if (href === "~" || href.startsWith("~/")) {
    path = href;
  } else {
    return { kind: "unresolved" };
  }
  return { kind: "local", path: decodePath(path.replace(LINE_FRAGMENT, "")) };
}

/**
 * The `file:` URL for a local path: `file:///Users/x`, `file:///C:/x`, and for a UNC share
 * `file:////server/share/x`, the form with an empty host that the reply sanitizer keeps. Each
 * path segment is encoded on its own, so `#` or `?` in a file name stays part of the path.
 */
export function fileHref(path: string) {
  const windows = /^[a-z]:\\|^\\\\/i.test(path);
  const slashed = windows ? path.replace(/\\/g, "/") : path;
  const encoded = slashed
    .split("/")
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
  return /^[a-z]:\//i.test(slashed) ? `file:///${encoded}` : `file://${encoded}`;
}

/** Rendered link attributes, beginning with `href`. */
function linkAttributes(href: string): [string, string][] {
  const target = classifyLink(href);
  switch (target.kind) {
    case "web":
      // Open external links in a new tab without an opener or referrer.
      return [
        ["href", href],
        ["target", "_blank"],
        ["rel", "noopener noreferrer"],
        ["title", href],
      ];
    case "local":
      // Keep `file:` hrefs for copying and hover previews; Markdown handles activation through
      // the app.
      return [
        ["href", fileHref(target.path)],
        [LOCAL_PATH_ATTRIBUTE, target.path],
        ["title", target.path],
      ];
    case "unresolved":
      // Render relative paths as text because no base directory is available.
      return [["title", href]];
    default:
      return [
        ["href", href],
        ["title", href],
      ];
  }
}

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  token.attrs = linkAttributes(token.attrGet("href") ?? "");
  return self.renderToken(tokens, index, options);
};

// Apply the HTML image URL allowlist to assistant Markdown images. Render user and work-log
// images as links.
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const src = token.attrGet("src") ?? "";
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  if (env.interactive) {
    return `<img src="${md.utils.escapeHtml(src)}" alt="${md.utils.escapeHtml(alt)}">`;
  }
  const label = md.utils.escapeHtml(alt === "" ? src : alt);
  const attributes = linkAttributes(src)
    .map(([name, value]) => `${name}="${md.utils.escapeHtml(value)}"`)
    .join(" ");
  return `<a ${attributes}>${label}</a>`;
};

// Constrain wide tables to a horizontally scrolling wrapper.
md.renderer.rules.table_open = () => {
  return '<div data-table tabindex="0"><table>\n';
};
md.renderer.rules.table_close = () => {
  return "</table></div>\n";
};

export interface HighlightedCodeMeta {
  highlightedHtml?: string;
  mermaid?: MermaidDiagram;
  mermaidSlot?: string;
}

/**
 * Highlight code fences and render Mermaid diagrams. Sets token metadata and returns diagrams
 * indexed by renderer slot. Used when preparing completed Markdown before mounting.
 */
export async function enrichCodeTokens(
  tokens: Token[],
  interactive: boolean,
): Promise<Map<string, MermaidDiagram>> {
  const diagrams = new Map<string, MermaidDiagram>();
  const blocks = tokens.filter((token) => token.type === "fence" || token.type === "code_block");
  await Promise.all(
    blocks.map(async (token, index) => {
      const language = token.type === "fence" ? (token.info.trim().split(/\s+/)[0] ?? "") : "";
      if (interactive && token.type === "fence" && language.toLowerCase() === "mermaid") {
        const diagram = await renderMermaid(token.content);
        if (diagram) {
          const slot = String(index);
          token.meta = { ...token.meta, mermaid: diagram, mermaidSlot: slot };
          diagrams.set(slot, diagram);
          return;
        }
      }
      const highlightedHtml = await highlightCode(token.content, language);
      token.meta = { ...token.meta, highlightedHtml };
    }),
  );
  return diagrams;
}

interface CodeToken {
  content: string;
  meta: unknown;
}

function codeHtml(token: CodeToken) {
  return (
    (token.meta as HighlightedCodeMeta | null)?.highlightedHtml ??
    md.utils.escapeHtml(token.content)
  );
}

/** Attributes used by rendered code blocks and copy controls. */
export const CODE_BLOCK_ATTRIBUTE = "data-code-block";
export const CODE_COPY_ATTRIBUTE = "data-copy-code";

const COPY_SVG =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
  '<path d="M5 15V6a2 2 0 0 1 2-2h9"/>' +
  "</svg>";

// Render escaped, highlighted code with a language label and copy button. Preserve the fence
// language for styling and accessibility.
function codeFrame(pre: string, language: string) {
  const label =
    language === "" ? "" : `<span data-code-language>${md.utils.escapeHtml(language)}</span>`;
  return (
    `<div ${CODE_BLOCK_ATTRIBUTE}>` +
    `<div data-code-header>${label}<button type="button" ${CODE_COPY_ATTRIBUTE} title="Copy code" aria-label="Copy code">${COPY_SVG}</button></div>` +
    `${pre}</div>\n`
  );
}

md.renderer.rules.fence = (tokens, index, _options, env) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0] ?? "";
  const diagram = (token.meta as HighlightedCodeMeta | null)?.mermaid;
  const slot = (token.meta as HighlightedCodeMeta | null)?.mermaidSlot;
  if (env.interactive && language.toLowerCase() === "mermaid" && diagram && slot) {
    return `<figure class="ui-mermaid" data-mermaid-slot="${slot}"></figure>\n`;
  }
  const code = codeHtml(token);
  if (language === "") {
    return codeFrame(`<pre><code>${code}</code></pre>`, "");
  }
  const name = md.utils.escapeHtml(language);
  const pre = `<pre data-language="${name}" aria-label="${name} code"><code class="language-${name}">${code}</code></pre>`;
  return codeFrame(pre, language);
};

// Use the same highlighter for indented code blocks without a language label.
md.renderer.rules.code_block = (tokens, index) => {
  return codeFrame(`<pre><code>${codeHtml(tokens[index])}</code></pre>`, "");
};

const TASK_MARKER = /^\[([ xX])\]\s+/;

interface TaskMeta {
  checked: boolean;
}

/** Replace GitHub task-list markers with read-only checkboxes and suppress the list bullet. */
md.core.ruler.after("inline", "task_lists", (state) => {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index += 1) {
    const inline = tokens[index];
    if (inline.type !== "inline" || tokens[index - 2].type !== "list_item_open") {
      continue;
    }
    const first = inline.children?.[0];
    if (first === undefined || first.type !== "text") {
      continue;
    }
    const marker = TASK_MARKER.exec(first.content);
    if (marker === null) {
      continue;
    }
    first.content = first.content.slice(marker[0].length);
    const checkbox = new state.Token("task_checkbox", "", 0);
    const meta: TaskMeta = { checked: marker[1] !== " " };
    checkbox.meta = meta;
    inline.children?.unshift(checkbox);
    tokens[index - 2].attrSet("data-task", "");
  }
});

md.renderer.rules.task_checkbox = (tokens, index) => {
  const checked = (tokens[index].meta as TaskMeta).checked;
  const state = checked ? " checked" : "";
  const label = checked ? "Done" : "Not done";
  return `<input type="checkbox" disabled${state} aria-label="${label}" /> `;
};
