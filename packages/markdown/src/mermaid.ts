/**
 * Render Mermaid to standalone light/dark SVG using beautiful-mermaid without a DOM. Reuse one
 * layout for both themes and resolve CSS colors to hex for native SVG compatibility. Accept
 * Mermaid source only, never model-authored SVG.
 */

import type { MermaidDiagram } from "./types";
import { renderMermaidSVG } from "beautiful-mermaid";
export type { MermaidDiagram } from "./types";

/** Hex colors in `#rgb` or `#rrggbb` form. Derive unset roles from `bg` and `fg`. */
export interface DiagramPalette {
  bg: string;
  fg: string;
  line?: string;
  accent?: string;
  muted?: string;
  surface?: string;
  border?: string;
}

export interface MermaidRenderOptions {
  /** Available width in logical pixels. Reorient oversized horizontal flowcharts vertically. */
  maxWidth?: number;
}

export const LIGHT_PALETTE: DiagramPalette = { bg: "#ffffff", fg: "#27272a" };
export const DARK_PALETTE: DiagramPalette = { bg: "#18181b", fg: "#fafafa" };
/** Default maximum width of the chat content column. */
const READING_WIDTH = 680;
/** Font used by beautiful-mermaid's text metrics. */
const FONT = "Inter";
const MAX_SOURCE_LENGTH = 12_000;
/** Minimum width before horizontal flowcharts switch to vertical layout. */
const NARROW_WIDTH = 680;
const HORIZONTAL_FLOWCHART = /^(\s*(?:flowchart|graph))\s+(?:LR|RL)\b/im;

/**
 * Return generated SVG, or null for invalid syntax, unsupported diagram types, or unsafe output
 * so the source can remain a code block.
 */
export async function renderMermaid(
  source: string,
  options: MermaidRenderOptions = {},
): Promise<MermaidDiagram | null> {
  // Reject configuration directives and click handlers in static diagrams.
  if (/%%\s*\{|\bclick\s+\S+/i.test(source)) return null;
  // Remove leading comments before detecting the diagram type.
  const input = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("%%"))
    .join("\n")
    .trim();
  if (input.length === 0 || input.length > MAX_SOURCE_LENGTH) return null;

  const accessibleText = `Diagram: ${input.replace(/\s+/g, " ").slice(0, 600)}`;
  const draw = (text: string): MermaidDiagram | null => {
    try {
      const raw = renderMermaidSVG(text, {
        ...LIGHT_PALETTE,
        font: FONT,
        transparent: true,
      });
      // Use system fonts to avoid Google Fonts requests.
      const layout = raw.replace(/@import\s+url\([^)]*\)\s*;?/g, "");
      const light = flattenColors(layout, LIGHT_PALETTE);
      const dark = flattenColors(layout, DARK_PALETTE);
      if (!isInert(light) || !isInert(dark)) return null;
      const openTag = /<svg\b[^>]*>/.exec(light)?.[0] ?? "";
      const width = Number(/\swidth="([\d.]+)"/.exec(openTag)?.[1]);
      const height = Number(/\sheight="([\d.]+)"/.exec(openTag)?.[1]);
      if (!(width > 0 && height > 0)) return null;
      return { light, dark, width, height, accessibleText };
    } catch {
      return null;
    }
  };

  // Reorient diagrams that would otherwise require unreadably small labels.
  const maxWidth = options.maxWidth ?? READING_WIDTH;
  const stacked = input.replace(HORIZONTAL_FLOWCHART, "$1 TB");
  if (stacked !== input && maxWidth < NARROW_WIDTH) return draw(stacked);
  const diagram = draw(input);
  if (diagram && stacked !== input && diagram.width > maxWidth * 1.2) {
    return draw(stacked) ?? diagram;
  }
  return diagram;
}

/**
 * Check generated SVG because labels contain model input. Reject suspicious output and retain
 * the source as code on false positives.
 */
function isInert(svg: string) {
  return ![
    /<\s*(?:script|foreignObject|iframe|object|embed|image|use|a)\b/i,
    /\son[a-z]+\s*=/i,
    /\bhref\s*=\s*["'](?!#)/i,
    /url\(\s*['"]?(?!#)/i,
    /@import/i,
  ].some((pattern) => pattern.test(svg));
}

// Resolve CSS custom properties to concrete colors.

const STYLE_BLOCK = /<style>([\s\S]*?)<\/style>/g;
const STYLE_ATTRIBUTE = /\sstyle="([^"]*)"/;
const DECLARATION = /(--[\w-]+)\s*:\s*([^;"}]+);?/g;

/**
 * Resolve `var()` and `color-mix()` from the palette and remove custom-property declarations.
 * Rewrite style attributes and blocks only, preserving label text.
 */
function flattenColors(svg: string, palette: DiagramPalette): string {
  const declarations = new Map<string, string>();
  const collect = (css: string) => {
    for (const match of css.matchAll(DECLARATION)) {
      declarations.set(match[1], match[2].trim());
    }
  };
  for (const match of svg.matchAll(STYLE_BLOCK)) collect(match[1]);
  const rootStyle = STYLE_ATTRIBUTE.exec(/<svg\b[^>]*>/.exec(svg)?.[0] ?? "")?.[1];
  if (rootStyle) collect(rootStyle);
  // Replace base palette roles so dependent mixed colors update consistently.
  for (const [role, value] of Object.entries(palette)) {
    if (value) declarations.set(`--${role}`, value);
  }

  const resolve = (value: string, depth = 0): string => {
    if (depth > 16) return value;
    const withVars = replaceCalls(value, "var", (args) => {
      const [name = "", ...fallback] = splitTopLevel(args);
      const declared = declarations.get(name.trim());
      if (declared !== undefined) return resolve(declared, depth + 1);
      return fallback.length > 0 ? resolve(fallback.join(",").trim(), depth + 1) : null;
    });
    return replaceCalls(withVars, "color-mix", mixColors);
  };
  const withoutDeclarations = (css: string) => css.replace(DECLARATION, "");

  return svg
    .replace(STYLE_BLOCK, (_, css: string) => `<style>${withoutDeclarations(resolve(css))}</style>`)
    .replace(/<(?!\/?style\b)[^>]+>/g, (tag) =>
      resolve(tag).replace(STYLE_ATTRIBUTE, (_, css: string) => {
        const rest = withoutDeclarations(css).replace(/^[\s;]+|[\s;]+$/g, "");
        return rest === "" ? "" : ` style="${rest}"`;
      }),
    );
}

/** Rewrite balanced function calls. Return null to preserve a call unchanged. */
function replaceCalls(
  text: string,
  name: string,
  evaluate: (args: string) => string | null,
): string {
  const opener = `${name}(`;
  let output = "";
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(opener, cursor);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = start + name.length; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      else if (text[index] === ")" && (depth -= 1) === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) break;
    const value = evaluate(text.slice(start + opener.length, end - 1));
    output += text.slice(cursor, start) + (value ?? text.slice(start, end));
    cursor = end;
  }
  return output + text.slice(cursor);
}

function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(args.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(args.slice(from));
  return parts;
}

/** Mix hex colors using CSS `color-mix(in srgb, ...)` rules. */
function mixColors(args: string): string | null {
  const [space, first, second] = splitTopLevel(args).map((part) => part.trim());
  if (space !== "in srgb" || !first || !second) return null;
  const a = colorStop(first);
  const b = colorStop(second);
  if (!a || !b) return null;
  let weightA = a.percent ?? (b.percent === undefined ? 50 : 100 - b.percent);
  let weightB = b.percent ?? 100 - weightA;
  const total = weightA + weightB;
  if (total <= 0) return null;
  weightA /= total;
  weightB /= total;
  const channel = (index: number) =>
    Math.round(a.rgb[index] * weightA + b.rgb[index] * weightB)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

interface ColorStop {
  rgb: number[];
  percent?: number;
}

function colorStop(stop: string): ColorStop | null {
  const match = /^(#[\da-f]{3,8})(?:\s+([\d.]+)%)?$/i.exec(stop);
  if (!match) return null;
  let hex = match[1].slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((digit) => digit + digit).join("");
  if (hex.length !== 6 && hex.length !== 8) return null;
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return { rgb, percent: match[2] === undefined ? undefined : Number(match[2]) };
}
