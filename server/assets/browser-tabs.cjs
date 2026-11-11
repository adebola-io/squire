"use strict";
const { randomBytes } = require("node:crypto");

const IDLE_MS = 30 * 60 * 1000;
function failure(code) {
  return Object.assign(
    new Error(
      {
        tab_not_found: "Unknown tab; list tabs before continuing.",
        tab_closed: "The tab was closed; list tabs or create another.",
        tab_expired: "The inactive tab expired; create a new tab explicitly.",
        runtime_lost: "The browser runtime ended; list tabs or create a new tab explicitly.",
        browser_capacity_reached: "This context already has 32 tabs; close an unused tab.",
      }[code],
    ),
    { code },
  );
}

// The page WeakMap retains opener identity after closure without retaining pages.
class TabRegistry {
  constructor({
    now = Date.now,
    onEmpty = () => {},
    onEvent = () => {},
    hasViewer = () => false,
  } = {}) {
    this.now = now;
    this.onEmpty = onEmpty;
    this.onEvent = onEvent;
    this.hasViewer = hasViewer;
    this.live = new Map();
    this.pages = new WeakMap();
    this.invalid = new Map();
    this.contexts = new Map();
  }
  register(page, options) {
    const existing = this.pages.get(page);
    const parent = options.opener && this.pages.get(options.opener);
    if (existing) {
      const previousOrigin = existing.origin;
      const previousOpener = existing.opener;
      if (parent) {
        existing.opener = parent.tab;
        existing.origin = parent.origin;
        for (const scope of parent.scopes) this.attachScope(existing, scope);
      } else if (options.origin) existing.origin = options.origin;
      if (existing.origin !== previousOrigin || existing.opener !== previousOpener)
        this.publish(existing);
      return existing.tab;
    }
    const { context } = options;
    let state = this.contexts.get(context);
    if (!state) {
      state = { tabs: new Set(), active: 0, disposed: false, private: options.private === true };
      this.contexts.set(context, state);
    }
    if (state.tabs.size >= 32) {
      page.close().catch(() => {});
      throw failure("browser_capacity_reached");
    }
    const tab = `tab-${randomBytes(16).toString("hex")}`;
    const record = {
      tab,
      page,
      context,
      viewOnly: options.viewOnly === true,
      private: options.private === true,
      origin: parent?.origin ?? options.origin ?? "manual",
      opener: parent?.tab,
      lastActivity: this.now(),
      active: 0,
      scopes: new Set(parent?.scopes ?? []),
      tail: Promise.resolve(),
    };
    this.live.set(tab, record);
    this.pages.set(page, record);
    state.tabs.add(tab);
    // Navigation changes URL/title without creating a new tab. Coalesce the
    // main-frame and DOM-ready notifications into one metadata invalidation.
    let metadataTimer;
    const metadataChanged = () => {
      clearTimeout(metadataTimer);
      metadataTimer = setTimeout(() => {
        if (this.live.has(tab))
          this.onEvent({ event: "tab_updated", tab, scopes: [...record.scopes] });
      }, 100).unref();
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) metadataChanged();
    });
    page.on("domcontentloaded", metadataChanged);
    page.once("close", () => {
      clearTimeout(metadataTimer);
      this.remove(record, "tab_closed");
    });
    this.publish(record);
    return tab;
  }
  publish(record) {
    this.onEvent({
      event: "tab_registered",
      tab: record.tab,
      scopes: [...record.scopes],
      context: record.context,
      private: record.private,
      origin: record.origin,
      opener: record.opener,
      lastActivity: record.lastActivity,
    });
  }
  attachScope(record, scope) {
    if (!scope || record.scopes.has(scope)) return;
    record.scopes.add(scope);
    this.onEvent({ event: "tab_scope_attached", tab: record.tab, scopes: [scope] });
  }
  refreshMetadata(record) {
    if (!this.live.has(record.tab)) return;
    this.onEvent({ event: "tab_updated", tab: record.tab, scopes: [...record.scopes] });
  }
  list() {
    return [...this.live.values()];
  }
  listForAgent() {
    return this.list().filter((record) => !record.viewOnly);
  }
  resolveForAgent(tab) {
    const record = this.resolve(tab);
    if (record.viewOnly) throw failure("tab_not_found");
    return record;
  }
  runForAgent(tab, operation) {
    this.resolveForAgent(tab);
    return this.run(tab, (record) => {
      if (record.viewOnly) throw failure("tab_not_found");
      return operation(record);
    });
  }
  resolve(tab) {
    const record = this.live.get(tab);
    if (!record) throw failure(this.invalid.get(tab) ?? "tab_not_found");
    return record;
  }
  remove(record, code) {
    if (!this.live.delete(record.tab)) return;
    this.invalid.set(record.tab, code);
    if (this.invalid.size > 4096) this.invalid.delete(this.invalid.keys().next().value);
    this.contexts.get(record.context)?.tabs.delete(record.tab);
    this.onEvent({
      event: "tab_invalidated",
      tab: record.tab,
      scopes: [...record.scopes],
      context: record.context,
      code,
    });
    this.disposeIfEmpty(record.context);
  }
  disposeIfEmpty(context) {
    const state = this.contexts.get(context);
    if (!state || state.disposed || state.tabs.size || state.active) return;
    if (!state.private) return;
    state.disposed = true;
    this.contexts.delete(context);
    return this.onEmpty(context);
  }
  async protectContext(context, operation) {
    let state = this.contexts.get(context);
    if (!state) {
      state = { tabs: new Set(), active: 0, disposed: false, private: context.private === true };
      this.contexts.set(context, state);
    }
    state.active++;
    try {
      return await operation();
    } finally {
      state.active--;
      await this.disposeIfEmpty(context);
    }
  }
  async protect(tab, operation) {
    const record = this.resolve(tab);
    const state = this.contexts.get(record.context);
    state.active++;
    record.active++;
    record.lastActivity = this.now();
    try {
      return await operation(record);
    } finally {
      record.active--;
      state.active--;
      record.lastActivity = this.now();
      await this.disposeIfEmpty(record.context);
    }
  }
  run(tab, operation) {
    return this.protect(tab, (record) => {
      const task = record.tail
        .catch(() => {})
        .then(() => {
          this.resolve(tab);
          return operation(record);
        });
      record.tail = task.catch(() => {});
      return task;
    });
  }
  async expire() {
    for (const record of this.live.values()) {
      if (
        record.origin !== "agent" ||
        record.active ||
        this.hasViewer(record.tab) ||
        this.now() - record.lastActivity < IDLE_MS
      )
        continue;
      this.remove(record, "tab_expired");
      await record.page.close().catch(() => {});
    }
  }
  invalidateContext(context) {
    const state = this.contexts.get(context);
    for (const record of this.live.values()) {
      if (record.context === context) this.remove(record, "runtime_lost");
    }
    if (!state?.private) this.contexts.delete(context);
    else this.disposeIfEmpty(context);
  }
}
module.exports = { TabRegistry };
