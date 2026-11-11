/**
 * Delegate tabs and local form-preview events within one sanitized assistant reply. These
 * browser-only controls cannot call tools.
 */
export function onRichClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>(".ui-tabs button[data-tab]");
  const tabs = button?.closest(".ui-tabs");
  if (!tabs || !button) return;
  const value = button.getAttribute("data-tab");
  const panels = Array.from(tabs.querySelectorAll("[data-panel]"));
  if (!panels.some((p) => p.getAttribute("data-panel") === value)) return;
  for (const tab of tabs.querySelectorAll("button[data-tab]")) {
    tab.setAttribute("aria-selected", String(tab === button));
  }
  for (const panel of panels)
    panel.toggleAttribute("hidden", panel.getAttribute("data-panel") !== value);
}

export function onRichSubmit(event: SubmitEvent) {
  if (!(event.target instanceof HTMLFormElement)) return;
  event.preventDefault();
  const form = event.target;
  if (!form.classList.contains("ui-form")) return;
  const values: string[] = [];
  for (const field of Array.from(form.elements)) {
    if (
      !(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      )
    )
      continue;
    if (
      !field.name ||
      (field instanceof HTMLInputElement &&
        ["password", "submit", "reset", "button"].includes(field.type))
    )
      continue;
    if (
      field instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(field.type) &&
      !field.checked
    )
      continue;
    values.push(field.name + ": " + field.value.slice(0, 200));
  }
  form.querySelector("output.ui-form-result")?.remove();
  const result = document.createElement("output");
  result.className = "ui-form-result";
  result.textContent = values.join("\n") || "No values selected";
  form.append(result);
}
