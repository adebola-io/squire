import {
  append,
  createElement,
  createNode,
  createText,
  elementChildren,
  getAttribute,
  hasClass,
  replaceWith,
  setAttribute,
  setText,
  SVG_NS,
  addClass,
  type HtmlElement,
} from "./htmlTree";
import { CHART_COLORS, RICH_TONES } from "./richPalette";

interface Point {
  label: string;
  value: number;
  x: number;
}

/** Cycle the series palette for additional points. */
const tone = (index: number) => CHART_COLORS[index % CHART_COLORS.length];

function svg(tag: string, attrs: Record<string, string>): HtmlElement {
  const element = createElement(tag, SVG_NS);
  for (const [key, value] of Object.entries(attrs)) setAttribute(element, key, value);
  return element;
}

/** Serialize inline styles in CSSOM-compatible form. */
function setStyle(element: HtmlElement, declarations: Record<string, string>) {
  const css = Object.entries(declarations)
    .map(([property, value]) => `${property}: ${value};`)
    .join(" ");
  setAttribute(element, "style", css);
}

function pointsFor(element: HtmlElement): Point[] {
  return elementChildren(element)
    .slice(0, 30)
    .flatMap((child, index) => {
      const label = getAttribute(child, "data-label") ?? "";
      const raw = getAttribute(child, "data-value");
      if (!raw?.trim() || !label.trim()) return [];
      const value = Number(raw);
      const xRaw = getAttribute(child, "data-x");
      const x = xRaw?.trim() ? Number(xRaw) : index;
      if (
        !Number.isFinite(value) ||
        Math.abs(value) > 1e9 ||
        !Number.isFinite(x) ||
        Math.abs(x) > 1e9
      )
        return [];
      return [{ label: label.slice(0, 80), value, x }];
    });
}

function markTitle(element: HtmlElement, text: string) {
  const title = svg("title", {});
  setText(title, text);
  append(element, title);
}

function appendLegend(figure: HtmlElement, points: Point[]) {
  const legend = createNode("div", "ui-chart-legend");
  points.forEach((point, index) => {
    const swatch = createNode("i");
    setStyle(swatch, { background: tone(index) });
    const item = createNode("span");
    append(item, swatch, createText(point.label + ": " + point.value));
    append(legend, item);
  });
  append(figure, legend);
}

/** Build charts from `.ui-chart[data-chart]` attributes. Do not execute model-authored code. */
export function enhanceChart(element: HtmlElement): void {
  const kind = getAttribute(element, "data-chart");
  if (!kind) return;
  const points = pointsFor(element);
  if (!points.length) return;
  const caption = getAttribute(element, "aria-label") || "Data chart";
  const figure = createNode("figure", "ui-chart-output");
  setAttribute(figure, "role", "img");
  setAttribute(
    figure,
    "aria-label",
    caption + ". " + points.map((p) => p.label + ": " + p.value).join("; "),
  );
  for (const tone of RICH_TONES) {
    if (hasClass(element, tone)) addClass(figure, tone);
  }
  const categorical = getAttribute(element, "data-palette") === "categorical";
  if (kind === "bar" || kind === "lollipop") {
    const min = Math.min(0, ...points.map((p) => p.value));
    const max = Math.max(0, ...points.map((p) => p.value));
    const span = max - min || 1;
    for (const [index, point] of points.entries()) {
      const row = createNode("div", "ui-chart-row");
      const track = createNode("div", "ui-chart-track");
      const bar = createNode("span", kind === "bar" ? "ui-chart-bar" : "ui-chart-lollipop");
      const zero = (-min / span) * 100;
      const end = ((point.value - min) / span) * 100;
      setStyle(bar, {
        left: Math.min(zero, end) + "%",
        width: Math.abs(zero - end) + "%",
        ...(categorical ? { background: tone(index) } : {}),
      });
      setAttribute(bar, "title", point.label + ": " + point.value);
      if (kind === "lollipop" && point.value < 0) setAttribute(bar, "data-negative", "");
      append(track, bar);
      append(
        row,
        createNode("span", "ui-chart-name", point.label),
        track,
        createNode("span", "ui-chart-number", String(point.value)),
      );
      append(figure, row);
    }
  } else if (kind === "donut") {
    const positive = points.filter((point) => point.value > 0);
    const sum = positive.reduce((total, point) => total + point.value, 0);
    if (!sum) return;
    let offset = 0;
    const stops = positive.map((point, index) => {
      const start = offset;
      offset += (point.value / sum) * 100;
      return tone(index) + " " + start + "% " + offset + "%";
    });
    const ring = createNode("div", "ui-chart-donut");
    setStyle(ring, { background: "conic-gradient(" + stops.join(",") + ")" });
    append(figure, ring);
    appendLegend(figure, positive);
  } else if (kind === "waffle") {
    const positive = points.filter((p) => p.value > 0);
    const total = positive.reduce((sum, p) => sum + p.value, 0);
    if (!total) return;
    const cells = positive.map((p) => (p.value / total) * 100);
    const counts = cells.map(Math.floor);
    const spare = 100 - counts.reduce((sum, count) => sum + count, 0);
    const order = cells
      .map((value, index) => ({ index, fraction: value - counts[index] }))
      .sort((a, b) => b.fraction - a.fraction);
    for (let n = 0; n < spare; n++) counts[order[n].index]++;
    const waffle = createNode("div", "ui-chart-waffle");
    for (const [index, point] of positive.entries()) {
      for (let n = 0; n < counts[index]; n++) {
        const cell = createNode("span");
        setStyle(cell, { background: tone(index) });
        setAttribute(cell, "title", point.label + ": " + point.value);
        append(waffle, cell);
      }
    }
    append(figure, waffle);
    appendLegend(figure, positive);
  } else {
    const canvas = svg("svg", {
      viewBox: "0 0 520 220",
      preserveAspectRatio: "none",
      class: "ui-chart-line",
      "aria-hidden": "true",
    });
    const min = Math.min(0, ...points.map((p) => p.value));
    const max = Math.max(0, ...points.map((p) => p.value));
    const xMin = Math.min(...points.map((p) => p.x));
    const xMax = Math.max(...points.map((p) => p.x));
    const y = (v: number) => 194 - ((v - min) / (max - min || 1)) * 172;
    const x = (v: number) => 16 + ((v - xMin) / (xMax - xMin || 1)) * 488;
    const zero = y(0);
    append(
      canvas,
      svg("line", {
        x1: "16",
        x2: "504",
        y1: String(zero),
        y2: String(zero),
        class: "ui-chart-axis",
      }),
    );
    const coords = points.map((p) => ({ x: x(p.x), y: y(p.value) }));
    if (kind === "area" || kind === "line") {
      const d = coords.map((p, index) => (index ? "L" : "M") + p.x + " " + p.y).join(" ");
      if (kind === "area") {
        append(
          canvas,
          svg("path", {
            d:
              d +
              " L " +
              coords[coords.length - 1].x +
              " " +
              zero +
              " L " +
              coords[0].x +
              " " +
              zero +
              " Z",
            class: "ui-chart-area",
          }),
        );
      }
      append(canvas, svg("path", { d, class: "ui-chart-stroke" }));
    }
    points.forEach((point, index) => {
      const p = coords[index];
      const barWidth = Math.min(50, (488 / points.length) * 0.68);
      const shape =
        kind === "column"
          ? svg("rect", {
              x: String(p.x - barWidth / 2),
              y: String(Math.min(zero, p.y)),
              width: String(barWidth),
              height: String(Math.max(1, Math.abs(zero - p.y))),
              fill: categorical ? tone(index) : "currentColor",
            })
          : svg("circle", {
              cx: String(p.x),
              cy: String(p.y),
              r: kind === "scatter" ? "5" : "3.5",
              fill: categorical ? tone(index) : "currentColor",
            });
      markTitle(shape, point.label + ": " + point.value);
      append(canvas, shape);
    });
    append(figure, canvas);
    const labels = createNode("div", "ui-chart-labels");
    const visible = points.length <= 8 ? points : [points[0], points[points.length - 1]];
    visible.forEach((point) => append(labels, createNode("span", undefined, point.label)));
    append(figure, labels);
  }
  append(figure, createNode("figcaption", "ui-caption", caption));
  replaceWith(element, figure);
}
