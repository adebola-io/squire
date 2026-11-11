"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BrowserViewer } = require("./browser-viewer.cjs");

test("closing a viewer tab closes the actual browser page", async () => {
  const calls = [];
  const record = {
    tab: "tab-test",
    scopes: new Set(["conversation:63"]),
    page: {
      close: async () => {
        calls.push("page.close");
      },
    },
  };
  const registry = {
    resolve: (tab) => {
      assert.equal(tab, record.tab);
      return record;
    },
    run: async (tab, action) => {
      assert.equal(tab, record.tab);
      return action(record);
    },
  };
  const viewer = new BrowserViewer(registry, () => {});
  try {
    await viewer.request({ action: "close", scope: "conversation:63", tab: record.tab });
    assert.deepEqual(calls, ["page.close"]);
    assert.equal(record.scopes.has("conversation:63"), true, "closing is not detaching");
  } finally {
    await viewer.shutdown();
  }
});

test("only an attached conversation can close a browser tab", async () => {
  let closed = false;
  const record = {
    tab: "tab-test",
    scopes: new Set(["conversation:63"]),
    page: {
      close: async () => {
        closed = true;
      },
    },
  };
  const viewer = new BrowserViewer(
    {
      resolve: () => record,
      run: async (_, action) => action(record),
    },
    () => {},
  );
  try {
    await assert.rejects(
      viewer.request({ action: "close", scope: "conversation:64", tab: record.tab }),
      /not attached/,
    );
    assert.equal(closed, false);
  } finally {
    await viewer.shutdown();
  }
});

test("multiple viewers share one per-tab frame event, without a viewer list or replay", async () => {
  const { BrowserViewer } = require("./browser-viewer.cjs");
  const events = [];
  const record = {
    tab: "tab-shared",
    scopes: new Set(["conversation:63"]),
    page: {},
    context: { headless: true, runtime: { touch() {} } },
  };
  const registry = {
    resolve: () => record,
    live: new Map([[record.tab, record]]),
  };
  const viewer = new BrowserViewer(registry, (event) => events.push(event));
  let captures = 0;
  viewer.startCapture = async (current) => {
    captures++;
    viewer.captures.set(current.tab, {
      cdp: { send: async () => {}, detach: async () => {} },
      release: () => {},
      pending: null,
      flushTimer: null,
    });
  };
  try {
    for (const id of ["a", "b"]) {
      await viewer.request({
        action: "start",
        scope: "conversation:63",
        tab: record.tab,
        viewer: id,
      });
    }
    assert.equal(captures, 1, "both viewers share a single underlying CDP capture");
    viewer.publish(record, { data: "ZmFrZQ==", viewport: { width: 1280, height: 720 } });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "viewer_frame");
    assert.equal(events[0].tab, record.tab);
    assert.equal("viewers" in events[0], false);
    await viewer.request({ action: "stop", viewer: "a" });
    assert.equal(viewer.isViewing(record.tab), true);
    await viewer.request({ action: "stop", viewer: "b" });
    assert.equal(viewer.isViewing(record.tab), false);
  } finally {
    await viewer.shutdown();
  }
});

test("Node is the sole viewer-cap authority", async () => {
  const record = {
    tab: "tab-cap",
    scopes: new Set(["conversation:63"]),
    page: {},
    context: { runtime: { touch() {} } },
  };
  const registry = { resolve: () => record, live: new Map([[record.tab, record]]) };
  const viewer = new BrowserViewer(registry, () => {});
  viewer.startCapture = async (current) => {
    viewer.captures.set(current.tab, {
      cdp: { send: async () => {}, detach: async () => {} },
      release: () => {},
      flushTimer: null,
      pending: null,
    });
  };
  try {
    for (let i = 0; i < 16; i++) {
      await viewer.request({
        action: "start",
        tab: record.tab,
        scope: "conversation:63",
        viewer: "v" + i,
      });
    }
    await assert.rejects(
      viewer.request({
        action: "start",
        tab: record.tab,
        scope: "conversation:63",
        viewer: "overflow",
      }),
      (error) => error.code === "too_many_browser_viewers",
      "the capacity limit must use a stable error code, independent of its text",
    );
  } finally {
    await viewer.shutdown();
  }
});
