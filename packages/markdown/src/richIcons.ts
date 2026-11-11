import {
  append,
  createElement,
  descendants,
  getAttribute,
  hasClass,
  HTML_NS,
  prepend,
  setAttribute,
  SVG_NS,
  type HtmlParent,
} from "./htmlTree";

/** Use trusted icon paths rather than model-supplied SVG. */
const PATHS: Record<string, string> = {
  "arrow-right": "M5 12h14m-6-6 6 6-6 6",
  "arrow-up-right": "M7 17 17 7M8 7h9v9",
  "arrow-down-right": "M7 7 17 17M8 17h9V8",
  "trending-up": "m3 17 6-6 4 4 8-8m-6 0h6v6",
  "trending-down": "m3 7 6 6 4-4 8 8m-6 0h6v-6",
  check: "M4 12l5 5L20 6",
  close: "M6 6l12 12M18 6 6 18",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l4 2",
  calendar: "M4 5h16v16H4zM8 3v4m8-4v4M4 10h16",
  "map-pin": "M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11Zm0-14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  sparkles: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z",
  globe: "M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Zm0 0h18M12 3c-5 4-5 14 0 18m0-18c5 4 5 14 0 18",
  star: "m12 2 3.1 6.4 7 1-5 4.9 1.2 7-6.3-3.4-6.3 3.4 1.2-7-5-4.9 7-1L12 2Z",
  bolt: "m13 2-9 12h7l-1 8 10-12h-7V2Z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-10v.5",
  leaf: "M20 4C7 4 4 9 4 15c0 4 5 6 9 3 5-4 7-10 7-14ZM4 21c3-6 7-9 12-12",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2",
  moon: "M20 16A8 8 0 0 1 8 4a8 8 0 1 0 12 12Z",
  play: "M7 4v16l13-8-13-8Z",
  "book-open": "M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14",
  users:
    "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-5a4 4 0 0 1 0 8m1 6h4v-2a4 4 0 0 0-3-3.9",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
  image: "M3 3h18v18H3zM8 9h.01M3 17l5-5 4 4 3-3 6 6",
  monitor: "M8 21h8m-4-4v4M3 4h18v13H3z",
  server: "M4 3h16v7H4zM4 14h16v7H4zM7 6h.01M7 17h.01",
  database:
    "M21 5c0 1.7-4 3-9 3S3 6.7 3 5s4-3 9-3 9 1.3 9 3ZM3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3",
  shield: "M12 2 4 6v6c0 6 4 9 8 10 4-1 8-4 8-10V6l-8-4Zm-4 10 3 3 5-6",
  warning: "m12 3 10 18H2L12 3Zm0 7v4m0 3v.5",
  compass: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4-6-8 4 4-8-4 4Z",
};

export const isRichIcon = (name: string) => Object.hasOwn(PATHS, name);

/** Prepend the named icon to `span.ui-icon[data-icon]`. */
export function enhanceIcons(root: HtmlParent): void {
  for (const element of descendants(root)) {
    if (element.tagName !== "span" || element.namespaceURI !== HTML_NS) continue;
    if (!hasClass(element, "ui-icon")) continue;
    const name = getAttribute(element, "data-icon");
    if (name === null) continue;
    const path = Object.hasOwn(PATHS, name) ? PATHS[name] : undefined;
    if (!path) continue;
    const icon = createElement("svg", SVG_NS);
    for (const [attribute, value] of Object.entries({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    }))
      setAttribute(icon, attribute, value);
    const shape = createElement("path", SVG_NS);
    setAttribute(shape, "d", path);
    append(icon, shape);
    prepend(element, icon);
  }
}
