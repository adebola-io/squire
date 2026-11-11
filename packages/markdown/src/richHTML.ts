import {
  addClass,
  append,
  attributeName,
  createElement,
  createNode,
  createText,
  descendants,
  elementChildren,
  getAttribute,
  hasAttribute,
  hasClass,
  HTML_NS,
  isText,
  nextElementSibling,
  parseHtml,
  remove,
  removeAttribute,
  replaceWith,
  serializeHtml,
  setAttribute,
  SVG_NS,
  textContent,
  toggleAttribute,
  type HtmlElement,
  type HtmlFragment,
  type HtmlParent,
} from "./htmlTree";
import type { MermaidDiagram } from "./types";
import { enhanceChart } from "./richCharts";
import { enhanceIcons } from "./richIcons";
import { resolveAnswerComponents } from "./answerComponents";

/**
 * Sanitize assistant HTML through explicit tag, attribute, URL and class allowlists on a parse5
 * tree. Rich controls use scoped `ui-*` classes; charts and tabs are enhanced by trusted code.
 * Browser event handling is in `richEvents`.
 */
const TAGS = new Set(
  "p div span section article header footer h1 h2 h3 h4 h5 h6 strong em b i u s del small mark sub sup br hr blockquote ul ol li dl dt dd a pre code kbd samp table thead tbody tfoot tr th td caption figure figcaption img picture source details summary progress meter button form label input textarea select option optgroup output svg g path rect circle ellipse line polyline polygon text title defs marker".split(
    " ",
  ),
);
/** SVG tag allowlist; other allowed tags use the HTML namespace. */
const SVG_TAGS = new Set(
  "svg g path rect circle ellipse line polyline polygon text title defs marker a".split(" "),
);
const DISCARD = new Set(
  "script style iframe object embed link meta base template head noscript canvas video audio track portal frameset frame foreignobject animate animatetransform set use image filter mask pattern".split(
    " ",
  ),
);
const UI_CLASSES = new Set(
  "ui-badge ui-success ui-warning ui-error ui-info ui-muted ui-caption ui-highlight ui-note ui-chart ui-tabs ui-form ui-small ui-blue ui-green ui-teal ui-violet ui-amber ui-orange ui-rose ui-cyan ui-indigo ui-lime ui-pink ui-eyebrow ui-lead ui-pullquote ui-stat ui-steps ui-chips ui-divider ui-flow ui-illustration ui-icon ui-recommendations ui-recommendation ui-box ui-row ui-column ui-grid ui-component-icon ui-component-badge ui-component-image".split(
    " ",
  ),
);
const GENERATED_ATTRIBUTES = new Set(
  "data-table data-task data-code-block data-code-header data-code-language data-copy-code data-done data-syntax data-language data-mermaid-slot".split(
    " ",
  ),
);
const SIMPLE_ATTRIBUTES = new Set(
  "title aria-label aria-hidden role scope colspan rowspan alt open hidden disabled checked selected required placeholder name value type min max step low high optimum for tabindex".split(
    " ",
  ),
);
const SVG_ATTRIBUTES = new Set(
  "viewbox fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset x y x1 x2 y1 y2 cx cy r rx ry width height d points preserveaspectratio vector-effect opacity fill-opacity stroke-opacity text-anchor dominant-baseline font-size transform markerwidth markerheight markerunits refx refy orient".split(
    " ",
  ),
);
const ALLOWED_TYPES = new Set(
  "text search number date time range checkbox radio email url password submit reset button".split(
    " ",
  ),
);
const UI_PROPS = new Set("gap padding columns align justify tone size border wrap".split(" "));
const UI_VALUES = new Set(
  "0 1 2 3 4 start center end between neutral success warning info sm md lg true".split(" "),
);
const CHART_KINDS = ["bar", "line", "donut", "area", "column", "scatter", "lollipop", "waffle"];
const ROLES = ["img", "status", "group", "tablist", "tab", "tabpanel", "progressbar"];

function publicImage(src: string): string | null {
  if (/^\/attachments\/[a-f0-9]{64}$/.test(src)) return src;
  if (src.length > 2048 || src !== src.trim()) return null;
  try {
    const url = new URL(src);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port !== "" && url.port !== "443") ||
      !url.hostname.includes(".") ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      url.hostname.startsWith("[")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeLink(href: string): boolean {
  if (href.length > 2048 || /\p{Cc}/u.test(href) || href !== href.trim()) return false;
  return /^(https?:\/\/|mailto:|tel:|file:\/\/\/|\/(?!\/)|#|~\/)/i.test(href);
}

/** Remove HTML comments from rendered replies. */
function removeComments(parent: HtmlParent) {
  // Collect nodes before removal to avoid skipping siblings during iteration.
  const comments = parent.childNodes.filter((child) => child.nodeName === "#comment");
  for (const comment of comments) remove(comment);
}

interface OriginalAttribute {
  name: string;
  value: string;
}

function clean(element: HtmlElement): void {
  const tag = element.tagName.toLowerCase();
  const inSvg = element.namespaceURI === SVG_NS;
  if (DISCARD.has(tag) || (inSvg && tag === "text")) {
    remove(element);
    return;
  }
  removeComments(element);
  // Validate element namespaces as well as names. Foreign elements can serialize and reparse as
  // active HTML elements, such as `<input>` inside MathML.
  const allowed =
    TAGS.has(tag) && (element.namespaceURI === HTML_NS || (inSvg && SVG_TAGS.has(tag)));
  if (!allowed) {
    for (const child of elementChildren(element)) clean(child);
    replaceWith(element, ...element.childNodes);
    return;
  }

  // Compare names case-insensitively but preserve parser spelling for case-sensitive SVG
  // attributes such as `viewBox`.
  const original = new Map<string, OriginalAttribute>();
  for (const attribute of element.attrs) {
    const name = attributeName(attribute);
    original.set(name.toLowerCase(), { name, value: attribute.value });
  }
  element.attrs = [];
  const keep = (name: string, value: string) => setAttribute(element, name, value);

  const cls = (original.get("class")?.value ?? "")
    .split(/\s+/)
    .filter((name) => UI_CLASSES.has(name) || /^language-[\w+#.-]{1,48}$/.test(name));
  if (cls.length) keep("class", cls.join(" "));

  for (const [name, { name: spelled, value }] of original) {
    if (GENERATED_ATTRIBUTES.has(name) && value.length < 200) {
      keep(name, value);
    } else if (name.startsWith("data-ui-") && UI_PROPS.has(name.slice(8)) && UI_VALUES.has(value)) {
      keep(name, value);
    } else if (name === "data-chart" && tag === "div" && CHART_KINDS.includes(value)) {
      keep(name, value);
    } else if (name === "data-palette" && tag === "div" && value === "categorical") {
      keep(name, value);
    } else if (
      (name === "data-label" ||
        name === "data-value" ||
        name === "data-x" ||
        name === "data-icon" ||
        name === "data-tab" ||
        name === "data-panel") &&
      value.length < 160 &&
      tag !== "svg"
    ) {
      keep(name, value);
    } else if (name === "id" && tag === "marker" && /^[a-z][\w-]{0,63}$/i.test(value)) {
      keep(name, value);
    } else if (name === "marker-end" && inSvg && /^url\(#[\w-]{1,64}\)$/.test(value)) {
      keep(name, value);
    } else if (name === "class" || name === "style" || name.startsWith("on")) {
      continue;
    } else if (name === "href" && tag === "a" && safeLink(value)) {
      keep("href", value);
      if (/^https?:\/\//i.test(value)) {
        keep("target", "_blank");
        keep("rel", "noopener noreferrer");
      }
    } else if (name === "data-local-path" && tag === "a" && value.length < 2048) {
      // Open local paths only on explicit activation through Markdown.
      keep(name, value);
    } else if (name === "src" && tag === "img") {
      const src = publicImage(value);
      if (src) {
        keep("src", src);
        keep("loading", "lazy");
        keep("referrerpolicy", "no-referrer");
      }
    } else if (name === "aria-selected" && (value === "true" || value === "false")) {
      keep(name, value);
    } else if (name === "start" && tag === "ol" && /^\d{1,5}$/.test(value)) {
      keep(name, value);
    } else if (SIMPLE_ATTRIBUTES.has(name) && value.length <= 200) {
      if (name === "type" && !ALLOWED_TYPES.has(value)) continue;
      if (
        (name === "colspan" || name === "rowspan" || name === "tabindex") &&
        !/^-?\d{1,4}$/.test(value)
      )
        continue;
      if ((name === "name" || name === "for") && !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) continue;
      if (name === "role" && !ROLES.includes(value)) continue;
      keep(name, value);
    } else if (
      inSvg &&
      SVG_ATTRIBUTES.has(name) &&
      value.length < 3000 &&
      /^[\w\s,.#%()+-]*$/.test(value)
    ) {
      keep(spelled, value);
    }
  }

  if (tag === "a" && !hasAttribute(element, "href")) removeAttribute(element, "data-local-path");
  if (tag === "img" && !hasAttribute(element, "src")) {
    replaceWith(element, createText(original.get("alt")?.value || "Image unavailable"));
    return;
  }
  if (tag === "form") keep("autocomplete", "off");
  if (tag === "button" && !hasAttribute(element, "type")) keep("type", "button");
  for (const child of elementChildren(element)) clean(child);
}

function initializeTabs(root: HtmlParent) {
  for (const tabs of descendants(root).filter((element) => hasClass(element, "ui-tabs"))) {
    const inside = descendants(tabs);
    const buttons = inside.filter(
      (element) => element.tagName === "button" && hasAttribute(element, "data-tab"),
    );
    const panels = inside.filter((element) => hasAttribute(element, "data-panel"));
    const first = buttons.find((button) =>
      panels.some(
        (panel) => getAttribute(panel, "data-panel") === getAttribute(button, "data-tab"),
      ),
    );
    for (const button of buttons) {
      setAttribute(button, "role", "tab");
      setAttribute(button, "aria-selected", String(button === first));
    }
    for (const panel of panels) {
      setAttribute(panel, "role", "tabpanel");
      toggleAttribute(
        panel,
        "hidden",
        getAttribute(panel, "data-panel") !== (first ? getAttribute(first, "data-tab") : undefined),
      );
    }
  }
}

/** Group adjacent Markdown images into a swipeable gallery. */
function groupMarkdownImages(root: HtmlParent) {
  const paragraphs = descendants(root).filter((p) => {
    if (p.tagName !== "p") return false;
    const elements = elementChildren(p);
    return (
      elements.length === 1 &&
      elements[0].tagName === "img" &&
      p.childNodes.every((node) => !isText(node) || !node.value.trim())
    );
  });
  const candidates = new Set<HtmlElement>(paragraphs);
  for (const first of paragraphs) {
    if (!candidates.has(first)) continue;
    const group = [first];
    let next = nextElementSibling(first);
    while (next && candidates.has(next)) {
      group.push(next);
      next = nextElementSibling(next);
    }
    group.forEach((p) => candidates.delete(p));
    if (group.length < 2) continue;
    const gallery = createNode("div", "ui-gallery");
    setAttribute(gallery, "role", "region");
    setAttribute(gallery, "aria-label", "Image gallery");
    setAttribute(gallery, "tabindex", "0");
    replaceWith(first, gallery);
    for (const paragraph of group) {
      const figure = createNode("figure");
      append(figure, elementChildren(paragraph)[0]);
      append(gallery, figure);
      remove(paragraph);
    }
  }
}

/** Render simple key/value tables as stacked pairs in narrow columns. */
function enhancePairTables(root: HtmlParent) {
  const childrenNamed = (parents: HtmlElement[], tag: string) =>
    parents.flatMap((parent) => elementChildren(parent).filter((child) => child.tagName === tag));
  for (const table of descendants(root).filter((element) => element.tagName === "table")) {
    const headings = childrenNamed(childrenNamed(childrenNamed([table], "thead"), "tr"), "th");
    const rows = childrenNamed(childrenNamed([table], "tbody"), "tr");
    if (headings.length !== 2 || !rows.length) continue;
    if (
      rows.some(
        (row) =>
          elementChildren(row).length !== 2 ||
          elementChildren(row).some(
            (cell) =>
              cell.tagName !== "td" ||
              hasAttribute(cell, "colspan") ||
              hasAttribute(cell, "rowspan"),
          ),
      )
    )
      continue;
    addClass(table, "ui-pair-table");
  }
}

/**
 * Insert generated light/dark diagram images into their code-fence slots after sanitization.
 * Mark each with `data-scheme` for theme selection.
 */
function fillDiagrams(root: HtmlParent, diagrams: ReadonlyMap<string, MermaidDiagram>) {
  const filled = new Set<string>();
  for (const figure of descendants(root)) {
    const slot = figure.tagName === "figure" ? getAttribute(figure, "data-mermaid-slot") : null;
    if (slot === null) continue;
    removeAttribute(figure, "data-mermaid-slot");
    const diagram = diagrams.get(slot);
    if (!diagram || filled.has(slot)) continue;
    filled.add(slot);
    addClass(figure, "ui-mermaid");
    for (const scheme of ["light", "dark"] as const) {
      const image = createElement("img");
      setAttribute(image, "data-scheme", scheme);
      setAttribute(image, "alt", diagram.accessibleText);
      setAttribute(
        image,
        "src",
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram[scheme])}`,
      );
      // Reserve layout space using the intrinsic image dimensions before decoding.
      setAttribute(image, "width", String(Math.round(diagram.width)));
      setAttribute(image, "height", String(Math.round(diagram.height)));
      append(figure, image);
    }
  }
}

export interface SanitizeOptions {
  /** Rendered diagrams indexed by code-fence slot. */
  diagrams?: ReadonlyMap<string, MermaidDiagram>;
}

function cleanFragment(fragment: HtmlFragment) {
  removeComments(fragment);
  for (const child of elementChildren(fragment)) clean(child);
}

/** Maximum sanitization passes before falling back to plain text. */
const MAX_PASSES = 4;

/**
 * Reparse and sanitize until serialization stabilizes. Removing disallowed wrappers can change
 * namespaces or nesting on the next browser parse.
 */
function stableCleanFragment(html: string): HtmlFragment {
  let fragment = parseHtml(html);
  cleanFragment(fragment);
  for (let pass = 1; pass < MAX_PASSES; pass += 1) {
    const markup = serializeHtml(fragment);
    const reparsed = parseHtml(markup);
    if (serializeHtml(reparsed) === markup) return fragment;
    cleanFragment(reparsed);
    fragment = reparsed;
  }
  const markup = serializeHtml(fragment);
  if (serializeHtml(parseHtml(markup)) === markup) return fragment;
  // Fall back to text when markup does not stabilize.
  const text = parseHtml("");
  append(text, createText(fragment.childNodes.map(textContent).join("")));
  return text;
}

/** Return allowlisted, inert HTML without model-authored scripts or CSS. */
export function sanitizeRichHtml(html: string, options: SanitizeOptions = {}): string {
  const hasComponents = /<(?:Box|Row|Column|Grid|Icon|Image|squire-image|Badge|Items|Item)\b/i.test(
    html,
  );
  let markup = html;
  if (hasComponents) {
    const fragment = parseHtml(html);
    resolveAnswerComponents(fragment);
    markup = serializeHtml(fragment);
  }
  const clean = stableCleanFragment(markup);
  // A block component inside a Markdown paragraph leaves an empty <p> after HTML reparsing.
  if (hasComponents) {
    for (const node of descendants(clean)) {
      if (node.tagName === "p" && !textContent(node).trim() && !elementChildren(node).length)
        remove(node);
    }
  }
  groupMarkdownImages(clean);
  enhancePairTables(clean);
  for (const chart of descendants(clean)) {
    if (hasClass(chart, "ui-chart") && hasAttribute(chart, "data-chart")) enhanceChart(chart);
  }
  enhanceIcons(clean);
  initializeTabs(clean);
  if (options.diagrams?.size) fillDiagrams(clean, options.diagrams);
  return serializeHtml(clean);
}
