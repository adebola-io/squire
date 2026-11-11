/** Host-local browser viewer API. Tab handles are capabilities only when paired with
 * a server-validated conversation or Connection thread association. */
export type BrowserScopeKind = "conversation" | "thread";

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserTab {
  tab: string;
  title: string;
  url: string;
  viewport: BrowserViewport | null;
  defaultViewport: BrowserViewport | null;
  headless: boolean;
  opener?: string;
  private: boolean;
}

export function browserTabPath(kind: BrowserScopeKind, id: string, tab?: string) {
  const base = "/desktop/browser/" + kind + "/" + encodeURIComponent(id) + "/tabs";
  return tab === undefined ? base : base + "/" + encodeURIComponent(tab);
}

export interface BrowserThreadPresence {
  id: string;
  count: number;
}

export interface BrowserPresence {
  conversations: string[];
  threads: BrowserThreadPresence[];
}

/** One lightweight lookup covers every row without opening or capturing tabs. */
export async function getBrowserPresence(signal?: AbortSignal): Promise<BrowserPresence> {
  const response = await fetch("/desktop/browser/active-conversations", { signal });
  if (!response.ok) throw new Error("Could not load browser presence.");
  return (await response.json()) as BrowserPresence;
}

export async function getBrowserTabs(kind: BrowserScopeKind, id: string, signal?: AbortSignal) {
  const response = await fetch(browserTabPath(kind, id), { signal });
  if (!response.ok) throw new Error("Could not load browser tabs.");
  const result: { tabs: BrowserTab[] } = await response.json();
  return result.tabs;
}

/** Close the real browser page, not merely its association with the conversation. */
export async function closeBrowserTab(kind: BrowserScopeKind, id: string, tab: string) {
  const response = await fetch(browserTabPath(kind, id, tab) + "/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("This browser tab is no longer available.");
    throw new Error("Could not close the browser tab.");
  }
}

export function browserThumbnailUrl(kind: BrowserScopeKind, id: string, tab: string) {
  return browserTabPath(kind, id, tab) + "/thumbnail";
}

export function browserSocketUrl(kind: BrowserScopeKind, id: string, tab: string) {
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  return scheme + location.host + browserTabPath(kind, id, tab) + "/stream";
}
