import {
  append,
  createNode,
  descendants,
  elementChildren,
  getAttribute,
  HTML_NS,
  remove,
  replaceWith,
  setAttribute,
  type HtmlParent,
} from "./htmlTree";
import { isRichIcon } from "./richIcons";

/**
 * Declarative answer components. Props are small named choices, not JS or CSS.
 * Resolved to inert HTML here; a native renderer can consume the same vocabulary.
 */
const COMPONENTS: Record<string, { tag: string; className: string; props: readonly string[] }> = {
  box: { tag: "div", className: "ui-box", props: ["border", "padding"] },
  row: { tag: "div", className: "ui-row", props: ["gap", "align", "justify", "wrap"] },
  column: { tag: "div", className: "ui-column", props: ["gap", "align"] },
  grid: { tag: "div", className: "ui-grid", props: ["columns", "gap", "align"] },
  icon: { tag: "span", className: "ui-icon ui-component-icon", props: ["size"] },
  "squire-image": { tag: "img", className: "ui-component-image", props: ["size"] },
  badge: { tag: "span", className: "ui-component-badge", props: ["tone"] },
  items: { tag: "section", className: "ui-recommendations", props: [] },
  item: { tag: "article", className: "ui-recommendation", props: [] },
};

const PROPS: Record<string, readonly string[]> = {
  gap: ["0", "1", "2", "3", "4"],
  padding: ["0", "1", "2", "3", "4"],
  columns: ["2", "3", "4"],
  align: ["start", "center", "end"],
  justify: ["start", "center", "end", "between"],
  tone: ["neutral", "success", "warning", "info"],
  size: ["sm", "md", "lg"],
  border: ["true"],
  wrap: ["true"],
};

export function resolveAnswerComponents(root: HtmlParent): void {
  // Bottom-up: replace the outer nodes only after their children are resolved.
  for (const element of descendants(root).reverse()) {
    const component = COMPONENTS[element.tagName];
    if (!component || element.namespaceURI !== HTML_NS) continue;
    const node = createNode(component.tag, component.className);
    if (element.tagName === "icon") {
      const name = getAttribute(element, "name");
      if (!name || !isRichIcon(name)) {
        remove(element);
        continue;
      }
      setAttribute(node, "data-icon", name);
      const size = getAttribute(element, "size");
      if (size && PROPS.size.includes(size)) setAttribute(node, "data-ui-size", size);
      setAttribute(node, "aria-hidden", "true");
    } else if (element.tagName === "item") {
      const firstImage = elementChildren(element).find((child) => child.tagName === "img");
      if (firstImage) append(node, firstImage);
      else {
        const iconName = getAttribute(element, "icon");
        if (iconName && isRichIcon(iconName)) {
          const icon = createNode("span", "ui-icon ui-component-icon");
          setAttribute(icon, "data-icon", iconName);
          setAttribute(icon, "aria-hidden", "true");
          append(node, icon);
        }
      }
      const content = createNode("div");
      append(content, ...element.childNodes);
      append(node, content);
    } else {
      if (element.tagName === "squire-image") {
        const src = getAttribute(element, "src");
        if (src) setAttribute(node, "src", src);
        setAttribute(node, "alt", getAttribute(element, "alt") || "Image unavailable");
      }
      for (const prop of component.props) {
        const value = getAttribute(element, prop);
        if (value !== null && PROPS[prop].includes(value))
          setAttribute(node, `data-ui-${prop}`, value);
      }
      append(node, ...element.childNodes);
    }
    replaceWith(element, node);
  }
}
