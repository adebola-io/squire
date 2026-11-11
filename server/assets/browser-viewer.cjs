"use strict";

// Internal, host-only viewer protocol. No CDP endpoint or arbitrary method is
// exposed to the web client. Tabs/contexts remain owned by SharedBrowser.
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_VIEWERS = 16;
const MAX_CAPTURES = 8;
const SCREENCAST = { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1920 };

/** Chromium can briefly emit a compositor-sized JPEG with the old geometry
 * after a viewport change. Read only the small JPEG header before publishing;
 * the stream's declared CSS viewport must match the image's aspect ratio. */
function jpegDimensions(encoded) {
  const header = Buffer.from(encoded.slice(0, 16 * 1024), "base64");
  if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < header.length) {
    if (header[offset] !== 0xff) return null;
    while (header[offset] === 0xff) offset++;
    const marker = header[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > header.length) return null;
    const length = header.readUInt16BE(offset);
    if (length < 2 || offset + length > header.length) return null;
    // SOF markers: baseline, progressive and less common JPEG variants.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) return null;
      return { height: header.readUInt16BE(offset + 3), width: header.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

const KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
]);

class BrowserViewer {
  constructor(tabs, emit) {
    this.tabs = tabs;
    this.emit = emit;
    this.viewers = new Map();
    this.captures = new Map();
    this.starting = new Map();
  }
  authorize(scope, tab) {
    const record = this.tabs.resolve(tab);
    if (!scope || !record.scopes.has(scope))
      throw new Error("Tab is not attached to this conversation.");
    return record;
  }
  async request(request) {
    const { action, scope, tab, viewer: id, input } = request;
    if (action === "stop") {
      await this.stop(id);
      return {};
    }
    if (action === "list") {
      return {
        tabs: await Promise.all(
          this.tabs
            .list()
            .filter((r) => r.scopes.has(scope))
            .map(async (r) => ({
              tab: r.tab,
              title: await r.page.title().catch(() => ""),
              url: r.page.url(),
              viewport: r.page.viewportSize(),
              defaultViewport: r.context.runtime.viewport(),
              private: r.private,
              opener: r.opener,
              headless: r.context.headless,
            })),
        ),
      };
    }
    const record = this.authorize(scope, tab);
    if (action === "close") {
      // Closing a browser tab is different from detaching its resource handle.
      // Use the registry lease so private contexts are not disposed mid-close.
      await this.tabs.run(tab, (current) => current.page.close());
      return {};
    }
    if (action === "start") {
      if (this.viewers.has(id)) throw new Error("Viewer already exists.");
      if (this.viewers.size >= MAX_VIEWERS) {
        const error = new Error("Too many browser viewers.");
        error.code = "too_many_browser_viewers";
        throw error;
      }
      this.viewers.set(id, { scope, tab });
      try {
        await this.capture(record);
        return {};
      } catch (error) {
        await this.stop(id);
        throw error;
      }
    }
    const v = this.viewers.get(id);
    if (!v || v.scope !== scope || v.tab !== tab) throw new Error("Viewer is no longer active.");
    if (action !== "input" || !input) throw new Error("Invalid viewer input.");
    record.lastActivity = Date.now();
    record.context.runtime.touch();
    return this.input(record, input);
  }
  async capture(record) {
    const tab = record.tab;
    if (this.starting.has(tab)) return this.starting.get(tab);
    if (this.captures.has(tab)) return;
    if (this.captures.size + this.starting.size >= MAX_CAPTURES)
      throw new Error("Too many active browser tabs.");
    const task = this.startCapture(record);
    this.starting.set(tab, task);
    try {
      await task;
    } finally {
      this.starting.delete(tab);
    }
  }
  async startCapture(record) {
    const { tab, page } = record;
    const release = record.context.runtime.holdViewer();
    let cdp;
    let capture;
    try {
      cdp = await page.context().newCDPSession(page);
      capture = { cdp, release, last: 0, pending: null, flushTimer: null };
      this.captures.set(tab, capture);
      const flush = () => {
        capture.flushTimer = null;
        const latest = capture.pending;
        capture.pending = null;
        if (
          !latest ||
          this.captures.get(tab) !== capture ||
          process.stdout.writableLength > MAX_FRAME
        )
          return;
        capture.last = Date.now();
        this.publish(record, latest);
      };
      cdp.on("Page.screencastFrame", (frame) => {
        // Acknowledge immediately, but retain the latest frame when throttled:
        // dropping a one-off repaint can otherwise leave a stale view forever.
        cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        if (this.captures.get(tab) !== capture || process.stdout.writableLength > MAX_FRAME) return;
        const viewport = page.viewportSize();
        const actual = jpegDimensions(frame.data);
        if (!viewport || !actual || actual.width < 1 || actual.height < 1) return;
        const aspectError = Math.abs(
          actual.width * viewport.height - actual.height * viewport.width,
        );
        if (aspectError > actual.height * viewport.width * 0.015) return;
        capture.pending = { data: frame.data, viewport };
        if (capture.flushTimer) return;
        const delay = Math.max(0, 50 - (Date.now() - capture.last));
        if (delay) capture.flushTimer = setTimeout(flush, delay);
        else flush();
      });
      // Chromium's compositor can have a different minimum size than the CSS
      // viewport. Set the visible surface before the first frame.
      await cdp.send("Emulation.setVisibleSize", page.viewportSize());
      // A first still prevents an idle tab from waiting indefinitely for a
      // screencast repaint. A navigation can interrupt the screenshot; in that
      // case, keep the stream alive and let screencasting provide the frame.
      await this.still(record);
      await cdp.send("Page.enable");
      await cdp.send("Page.startScreencast", SCREENCAST);
    } catch (error) {
      this.captures.delete(tab);
      if (capture?.flushTimer) clearTimeout(capture.flushTimer);
      await cdp?.detach().catch(() => {});
      release();
      throw error;
    }
  }
  async still(record) {
    // Screenshots during screencasting can suppress future repaints; callers
    // take the still only before starting (or after stopping) the screencast.
    const bytes = await record.page
      .screenshot({ type: "jpeg", quality: 70, timeout: 2500 })
      .catch(() => null);
    if (bytes) {
      this.publish(record, {
        data: bytes.toString("base64"),
        viewport: record.page.viewportSize(),
      });
    }
  }
  async resume(record) {
    const capture = this.captures.get(record.tab);
    if (!capture) return;
    if (capture.flushTimer) clearTimeout(capture.flushTimer);
    capture.flushTimer = null;
    capture.pending = null;
    capture.last = 0;
    await capture.cdp.send("Page.stopScreencast");
    if (this.captures.get(record.tab) === capture) {
      await capture.cdp.send("Emulation.setVisibleSize", record.page.viewportSize());
      // A resize can be the only repaint on a static tab. Publish its new
      // dimensions immediately instead of waiting for another compositor tick.
      await this.still(record);
      if (this.captures.get(record.tab) === capture)
        await capture.cdp.send("Page.startScreencast", SCREENCAST);
    }
  }
  publish(record, frame) {
    if (
      !frame.viewport ||
      frame.data.length > Math.ceil(MAX_FRAME / 3) * 4 ||
      !this.tabs.live.has(record.tab)
    )
      return;
    if (this.isViewing(record.tab)) this.emit({ event: "viewer_frame", tab: record.tab, ...frame });
  }
  isViewing(tab) {
    return [...this.viewers.values()].some((viewer) => viewer.tab === tab);
  }
  async stop(id) {
    const v = this.viewers.get(id);
    if (!v) return;
    this.viewers.delete(id);
    const record = this.tabs.live.get(v.tab);
    if (record) record.lastActivity = Date.now();
    await this.starting.get(v.tab)?.catch(() => {});
    if (this.isViewing(v.tab)) return;
    const capture = this.captures.get(v.tab);
    if (capture) {
      this.captures.delete(v.tab);
      if (capture.flushTimer) clearTimeout(capture.flushTimer);
      capture.pending = null;
      await capture.cdp.send("Page.stopScreencast").catch(() => {});
      await capture.cdp.detach().catch(() => {});
      capture.release();
    }
  }
  closed(tab) {
    for (const [id, v] of this.viewers)
      if (v.tab === tab) {
        this.stop(id).catch(() => {});
      }
  }
  async input(record, event) {
    const { page } = record;
    const cdp = this.captures.get(record.tab)?.cdp;
    if (!cdp) throw new Error("Stream is not active.");
    const viewport = page.viewportSize();
    const point = () => {
      if (event.width !== viewport.width || event.height !== viewport.height)
        throw new Error("Viewport changed. Retry after the next frame.");
      for (const key of ["x", "y"])
        if (
          !Number.isFinite(event[key]) ||
          event[key] < 0 ||
          event[key] >= viewport[key === "x" ? "width" : "height"]
        )
          throw new Error("Invalid pointer coordinates.");
      return { x: event.x, y: event.y };
    };
    switch (event.type) {
      case "click": {
        const p = point();
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...p,
          button: "left",
          clickCount: 1,
        });
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...p,
          button: "left",
          clickCount: 1,
        });
        const focus = await page
          .evaluate(() => {
            const el = document.activeElement;
            if (
              !el ||
              !el.matches(
                'input:not([type="file"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
              )
            )
              return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })
          .catch(() => null);
        return { focus };
      }
      case "wheel": {
        const p = point();
        if (![event.dx, event.dy].every((n) => Number.isFinite(n) && Math.abs(n) <= 3000))
          throw new Error("Invalid scroll.");
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...p,
          deltaX: event.dx,
          deltaY: event.dy,
        });
        break;
      }
      case "text":
        if (typeof event.text !== "string" || event.text.length > 4096)
          throw new Error("Text is too large.");
        await cdp.send("Input.insertText", { text: event.text });
        break;
      case "key":
        if (!KEYS.has(event.key)) throw new Error("Unsupported key.");
        // Balanced key events; no held modifiers leak between viewers/agents.
        await page.keyboard.press(event.key, { timeout: 3000 });
        break;
      case "resize": {
        for (const key of ["width", "height"])
          if (!Number.isInteger(event[key]) || event[key] < 240 || event[key] > 3840)
            throw new Error("Viewport must be between 240 and 3840 CSS pixels.");
        await page.setViewportSize({ width: event.width, height: event.height });
        await this.resume(record);
        this.tabs.refreshMetadata(record);
        return { viewport: page.viewportSize() };
      }
      case "back":
        await page.goBack({ waitUntil: "commit", timeout: 5000 });
        break;
      case "forward":
        await page.goForward({ waitUntil: "commit", timeout: 5000 });
        break;
      case "reload":
        await page.reload({ waitUntil: "commit", timeout: 5000 });
        break;
      default:
        throw new Error("Unsupported browser input.");
    }
    return {};
  }
  async shutdown() {
    await Promise.all([...this.viewers.keys()].map((id) => this.stop(id)));
  }
}
module.exports = { BrowserViewer };
