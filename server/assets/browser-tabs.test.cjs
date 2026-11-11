"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TabRegistry } = require("./browser-tabs.cjs");
const { SharedBrowser } = require("./browser-shared.cjs");

function fakePage() {
  const page = new EventEmitter();
  page.close = async () => page.emit("close");
  return page;
}

test("scope additions publish exactly once, and closing publishes original scopes", async () => {
  const events = [];
  const registry = new TabRegistry({ onEvent: (event) => events.push(event) });
  const context = {};
  const page = fakePage();
  const tab = registry.register(page, { context, origin: "agent" });
  assert.deepEqual(events[0].scopes, []);
  const record = registry.resolve(tab);
  registry.attachScope(record, "conversation:63");
  registry.attachScope(record, "conversation:63");
  assert.deepEqual(
    events.filter((e) => e.event === "tab_scope_attached").map((e) => e.scopes),
    [["conversation:63"]],
  );
  await page.close();
  assert.deepEqual(events.at(-1).scopes, ["conversation:63"]);
  assert.equal(events.at(-1).event, "tab_invalidated");
});

test("popup registration inherits scopes without guessing who clicked", () => {
  const events = [];
  const registry = new TabRegistry({ onEvent: (event) => events.push(event) });
  const context = {};
  const parent = fakePage();
  const parentId = registry.register(parent, { context, origin: "agent" });
  registry.attachScope(registry.resolve(parentId), "thread:55317fc32b79");
  const popup = fakePage();
  registry.register(popup, { context, opener: parent });
  assert.deepEqual(events.at(-1).scopes, ["thread:55317fc32b79"]);
  assert.equal(events.at(-1).opener, parentId);
});

test("active viewers protect agent tabs against idle eviction without a per-tab counter", async () => {
  let viewing = true;
  const registry = new TabRegistry({
    now: () => 50 * 60 * 1000,
    hasViewer: () => viewing,
  });
  const tab = registry.register(fakePage(), { context: {}, origin: "agent" });
  registry.resolve(tab).lastActivity = 0;
  await registry.expire();
  assert.equal(registry.live.has(tab), true);
  viewing = false;
  await registry.expire();
  assert.equal(registry.live.has(tab), false);
});

test("SharedBrowser forwards scope attachment without assuming a context exists", () => {
  const events = [];
  const shared = new SharedBrowser({
    event: (event) => events.push(event),
  });
  clearInterval(shared.timer);
  const page = fakePage();
  const tab = shared.tabs.register(page, { context: { profile: "private" }, origin: "agent" });
  shared.tabs.attachScope(shared.tabs.resolve(tab), "conversation:63");
  const event = events.find((e) => e.event === "tab_scope_attached");
  assert.equal(event.tab, tab);
  assert.deepEqual(event.scopes, ["conversation:63"]);
  assert.equal(event.owner, "browser");
});

test("navigation coalesces metadata changes without changing membership", async () => {
  const events = [];
  const registry = new TabRegistry({ onEvent: (event) => events.push(event) });
  const page = fakePage();
  const mainFrame = {};
  page.mainFrame = () => mainFrame;
  const tab = registry.register(page, { context: {}, origin: "agent" });
  registry.attachScope(registry.resolve(tab), "conversation:63");
  page.emit("framenavigated", mainFrame);
  page.emit("domcontentloaded");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const updates = events.filter((event) => event.event === "tab_updated");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].tab, tab);
  assert.deepEqual(updates[0].scopes, ["conversation:63"]);
  await page.close();
});
