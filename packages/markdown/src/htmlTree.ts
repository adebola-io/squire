import { html, parseFragment, type DefaultTreeAdapterTypes } from "parse5";

/**
 * DOM-independent HTML utilities backed by parse5. Use browser-compatible fragment parsing in
 * web, worker and native runtimes.
 */
export type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export type HtmlParent = DefaultTreeAdapterTypes.ParentNode;
export type HtmlFragment = DefaultTreeAdapterTypes.DocumentFragment;
export type HtmlText = DefaultTreeAdapterTypes.TextNode;

export const HTML_NS = html.NS.HTML;
export const SVG_NS = html.NS.SVG;

/**
 * Parse as template content with scripting disabled, matching `template.innerHTML` and its
 * handling of `<noscript>`.
 */
export function parseHtml(source: string): HtmlFragment {
  return parseFragment(source, { scriptingEnabled: false });
}

const VOID_ELEMENTS = new Set(
  "area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr".split(
    " ",
  ),
);
const RAW_TEXT_ELEMENTS = new Set("style script xmp iframe noembed noframes plaintext".split(" "));

function escapeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\u00a0", "&nbsp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Escape angle brackets in attribute values to match browser serialization. */
function escapeAttribute(value: string) {
  return escapeText(value).replaceAll('"', "&quot;");
}

function serializeChildren(parent: HtmlParent): string {
  const rawText =
    isElement(parent) && parent.namespaceURI === HTML_NS && RAW_TEXT_ELEMENTS.has(parent.tagName);
  let output = "";
  for (const node of parent.childNodes) {
    if (isText(node)) {
      output += rawText ? node.value : escapeText(node.value);
    } else if (node.nodeName === "#comment") {
      output += `<!--${(node as DefaultTreeAdapterTypes.CommentNode).data}-->`;
    } else if (isElement(node)) {
      const attributes = node.attrs
        .map((attribute) => ` ${attributeName(attribute)}="${escapeAttribute(attribute.value)}"`)
        .join("");
      output += `<${node.tagName}${attributes}>`;
      if (node.namespaceURI === HTML_NS && VOID_ELEMENTS.has(node.tagName)) continue;
      const content = "content" in node ? (node as DefaultTreeAdapterTypes.Template).content : node;
      output += serializeChildren(content) + `</${node.tagName}>`;
    }
  }
  return output;
}

/**
 * Serialize HTML fragments with browser-compatible attribute escaping. Keep the output stable
 * when reparsed.
 */
export function serializeHtml(fragment: HtmlFragment): string {
  return serializeChildren(fragment);
}

export function isElement(node: HtmlNode | HtmlParent): node is HtmlElement {
  return "tagName" in node;
}

export function isText(node: HtmlNode): node is HtmlText {
  return node.nodeName === "#text";
}

export function createElement(tagName: string, namespace: html.NS = HTML_NS): HtmlElement {
  return {
    nodeName: tagName,
    tagName,
    attrs: [],
    namespaceURI: namespace,
    parentNode: null,
    childNodes: [],
  };
}

export function createText(value: string): HtmlText {
  return { nodeName: "#text", value, parentNode: null };
}

/** Create an HTML element with optional class and text content. */
export function createNode(tagName: string, className?: string, text?: string): HtmlElement {
  const node = createElement(tagName);
  if (className) setAttribute(node, "class", className);
  if (text !== undefined) setText(node, text);
  return node;
}

export function elementChildren(parent: HtmlParent): HtmlElement[] {
  return parent.childNodes.filter(isElement);
}

/** Return a static list of descendant elements in document order. */
export function descendants(root: HtmlParent): HtmlElement[] {
  const found: HtmlElement[] = [];
  const visit = (parent: HtmlParent) => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

interface NamedAttribute {
  name: string;
  prefix?: string;
}

/** Qualified attribute name, including a namespace prefix such as `xlink:`. */
export function attributeName(attribute: NamedAttribute): string {
  return attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
}

export function getAttribute(element: HtmlElement, name: string): string | null {
  return element.attrs.find((attribute) => attributeName(attribute) === name)?.value ?? null;
}

export function hasAttribute(element: HtmlElement, name: string): boolean {
  return getAttribute(element, name) !== null;
}

/** Update an attribute in place, appending it if absent. */
export function setAttribute(element: HtmlElement, name: string, value: string): void {
  const existing = element.attrs.find((attribute) => attributeName(attribute) === name);
  if (existing) existing.value = value;
  else element.attrs.push({ name, value });
}

export function removeAttribute(element: HtmlElement, name: string): void {
  element.attrs = element.attrs.filter((attribute) => attributeName(attribute) !== name);
}

export function toggleAttribute(element: HtmlElement, name: string, force: boolean): void {
  if (force) {
    if (!hasAttribute(element, name)) setAttribute(element, name, "");
  } else {
    removeAttribute(element, name);
  }
}

export function hasClass(element: HtmlElement, className: string): boolean {
  return (getAttribute(element, "class") ?? "").split(/\s+/).includes(className);
}

export function addClass(element: HtmlElement, className: string): void {
  const classes = (getAttribute(element, "class") ?? "").split(/\s+/).filter(Boolean);
  if (!classes.includes(className))
    setAttribute(element, "class", [...classes, className].join(" "));
}

export function setText(element: HtmlElement, text: string): void {
  for (const child of element.childNodes) child.parentNode = null;
  element.childNodes = [];
  append(element, createText(text));
}

function detach(node: HtmlNode): void {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index >= 0) parent.childNodes.splice(index, 1);
  node.parentNode = null;
}

export function remove(node: HtmlNode): void {
  detach(node);
}

export function append(parent: HtmlParent, ...nodes: HtmlNode[]): void {
  for (const node of nodes) {
    detach(node);
    node.parentNode = parent;
    parent.childNodes.push(node);
  }
}

export function prepend(parent: HtmlParent, node: HtmlNode): void {
  detach(node);
  node.parentNode = parent;
  parent.childNodes.unshift(node);
}

/** Replace a node with the supplied nodes. */
export function replaceWith(node: HtmlNode, ...nodes: HtmlNode[]): void {
  const parent = node.parentNode;
  if (!parent) return;
  const replacements = nodes.filter((replacement) => replacement !== node);
  for (const replacement of replacements) detach(replacement);
  const index = parent.childNodes.indexOf(node);
  if (index < 0) return;
  for (const replacement of replacements) replacement.parentNode = parent;
  parent.childNodes.splice(index, 1, ...replacements);
  node.parentNode = null;
}

export function nextElementSibling(element: HtmlElement): HtmlElement | null {
  const siblings = element.parentNode?.childNodes ?? [];
  for (let index = siblings.indexOf(element) + 1; index < siblings.length; index += 1) {
    const sibling = siblings[index];
    if (isElement(sibling)) return sibling;
  }
  return null;
}

export function textContent(node: HtmlNode): string {
  if (isText(node)) return node.value;
  return isElement(node) ? node.childNodes.map(textContent).join("") : "";
}
