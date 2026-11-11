"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

// This origin is fulfilled entirely by Playwright; it never reaches a server.
// The unguessable path and frame check keep control URLs private to this page.
class SignInHandoff {
  constructor(page, { plugin, pluginIcon, action, site, loginUrl, onCancelled }) {
    this.pluginIcon = pluginIcon;
    this.onCancelled = onCancelled;
    this.page = page;
    this.plugin = plugin;
    this.action = action;
    this.site = site;
    this.loginUrl = loginUrl;
    this.url = `https://squire.invalid/${crypto.randomBytes(24).toString("hex")}`;
    this.state = "ready";
    this.generation = 0;
  }

  html() {
    const hostname = new URL(this.loginUrl).hostname;
    const states = {
      ready: [`Sign in to ${this.plugin}`, null],
      loading: [`Opening ${this.plugin} sign-in`, null],
      failed: [
        `Couldn’t open ${this.plugin} sign-in`,
        `Couldn’t reach ${hostname}. Your request is still active, so check your connection and try again.`,
      ],
      signed_in: [
        `Signed in to ${this.plugin}`,
        "Squire is continuing your request. You can close this window.",
      ],
      expired: [
        `${this.plugin} sign-in expired`,
        "Return to the conversation that made this request and try again.",
      ],
      cancelled: ["Sign-in cancelled", "The request was cancelled. You can close this window."],
    };
    const [title, description] = states[this.state] ?? states.ready;
    const ready = this.state === "ready";
    const loading = this.state === "loading";
    const failed = this.state === "failed";
    const terminal = ["signed_in", "expired", "cancelled"].includes(this.state);
    const controls = [];
    const form = (action, label, primary) =>
      `<form method="post" action="${this.url}/${action}"><button type="submit" class="${primary ? "primary" : "secondary"}">${label}</button></form>`;
    if (ready || failed)
      controls.push(form("continue", ready ? "Continue to login" : "Try again", true));
    if (ready || failed || loading) controls.push(form("cancel", "Cancel", false));
    if (terminal) controls.push(form("close", "Close window", true));
    const fullWidth = loading || terminal;
    const actions = controls.length
      ? `<div class="actions${fullWidth ? " full" : ""}">${controls.join("")}</div>`
      : "";
    const details = ready
      ? `<dl>
          <div><dt>Requested action</dt><dd>${escape(this.action)}</dd></div>
          <div><dt>Sign-in page</dt><dd>${escape(hostname)}</dd></div>
        </dl>`
      : loading
        ? `<dl><div><dt>Sign-in page</dt><dd>${escape(hostname)}</dd></div></dl>`
        : `<p class="description">${escape(description)}</p>`;
    const mark = this.pluginIcon
      ? `<img class="plugin-mark" alt="" src="${escape(this.pluginIcon)}">`
      : "";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(title)} · Squire</title>
<style>
@font-face {
  font-family: "Geist";
  src: url("${this.url}/geist-sans.woff2") format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "Source Serif 4";
  src: url("${this.url}/source-serif-4.woff2") format("woff2");
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
}
:root {
  color-scheme: dark;
  --background: #151515;
  --foreground: #f5f5f5;
  --muted: #b5b5b5;
  --line: #454444;
}
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; }
body {
  background: var(--background);
  color: var(--foreground);
  font: 400 14px/1.5 "Geist", Arial, sans-serif;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  block-size: 64px;
  padding-inline: 24px;
  font-size: 16px;
}
.brand-mark { inline-size: 20px; block-size: 20px; object-fit: contain; }
main { inline-size: min(416px, calc(100% - 32px)); margin: 104px auto 40px; }
.heading { display: flex; align-items: center; gap: 16px; min-block-size: 32px; margin-block-end: 24px; }
.plugin-mark { inline-size: 32px; block-size: 32px; flex: 0 0 32px; object-fit: contain; }
h1 {
  margin: 0;
  font: 400 22px/1.3 "Source Serif 4", Georgia, serif;
  letter-spacing: -0.44px;
  overflow-wrap: anywhere;
}
dl { display: grid; gap: 8px; margin: 0; }
dl > div { display: grid; grid-template-columns: 150px minmax(0,1fr); min-block-size: 24px; }
dt, dd { margin: 0; font-size: 14px; line-height: 24px; }
dt { color: var(--muted); }
dd { overflow-wrap: anywhere; }
.description { margin: 0; color: var(--muted); font: 400 16px/1.65 "Geist", Arial, sans-serif; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-block-start: 24px; }
.actions form { margin: 0; }
.actions.full form { flex: 1; }
button {
  min-block-size: 48px;
  padding: 0 24px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--foreground);
  font: 400 16px/1 "Geist", Arial, sans-serif;
  white-space: nowrap;
  cursor: pointer;
}
.actions.full button { inline-size: 100%; }
button.primary { border-color: #f5f5f5; background: #f5f5f5; color: #151515; }
button:hover { filter: brightness(0.9); }
button:focus-visible { outline: 2px solid var(--foreground); outline-offset: 3px; }
.note { margin: 16px 0 0; color: var(--muted); font: 400 12px/1.65 "Geist", Arial, sans-serif; }
@media (max-width: 440px) {
  header { padding-inline: 16px; }
  main { margin-block-start: min(104px, 12dvh); }
  dl > div { grid-template-columns: minmax(0,1fr); gap: 0; }
}
</style>
</head>
<body>
<header><img class="brand-mark" src="${this.url}/squire-mark.svg" alt=""><span>Squire</span></header>
<main>
  <div class="heading">${mark}<h1>${escape(title)}</h1></div>
  ${details}
  ${actions}
  ${ready ? '<p class="note">Squire continues once you sign in and never sees your password.</p>' : ""}
</main>
</body>
</html>`;
  }

  headers() {
    return {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
    };
  }

  async fulfill(route) {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: this.headers(),
      body: this.html(),
    });
  }

  async start() {
    // Load the same fonts and brand mark used by Squire's own UI. No web
    // requests are made for assets and third-party login sites see no scripts.
    for (const [file, contentType] of [
      ["squire-mark.svg", "image/svg+xml"],
      ["geist-sans.woff2", "font/woff2"],
      ["source-serif-4.woff2", "font/woff2"],
    ]) {
      await this.page.route(this.url + "/" + file, async (route) => {
        if (route.request().method() !== "GET") return route.abort("blockedbyclient");
        await route.fulfill({
          status: 200,
          contentType,
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          body: fs.readFileSync(path.join(__dirname, file)),
        });
      });
    }
    await this.page.route(this.url, (route) => this.fulfill(route));
    const submit = (action) => async (route) => {
      const request = route.request();
      let valid = request.method() === "POST" && request.isNavigationRequest();
      try {
        valid &&= request.frame() === this.page.mainFrame();
        const permitted = [this.url, this.url + "/continue"];
        if (action === "close") permitted.push(this.url + "/cancel");
        valid &&= permitted.includes(request.frame().url());
      } catch {
        valid = false;
      }
      if (!valid) return route.abort("blockedbyclient");
      if (action === "close" && ["signed_in", "expired", "cancelled"].includes(this.state)) {
        await this.fulfill(route);
        setImmediate(() => void this.page.close().catch(() => {}));
      } else if (action === "cancel" && ["ready", "loading", "failed"].includes(this.state)) {
        this.generation++;
        this.state = "cancelled";
        await this.fulfill(route);
        this.onCancelled?.();
      } else if (action === "continue" && ["ready", "failed"].includes(this.state)) {
        const generation = ++this.generation;
        this.state = "loading";
        await this.fulfill(route);
        void this.openLogin(generation);
      } else {
        await route.abort("blockedbyclient");
      }
    };
    await this.page.route(this.url + "/cancel", submit("cancel"));
    await this.page.route(this.url + "/continue", submit("continue"));
    await this.page.route(this.url + "/close", submit("close"));
    await this.show();
  }

  async show() {
    await this.page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 10_000 });
  }

  async openLogin(generation) {
    try {
      // Let the local POST navigation commit before navigating to the site.
      await this.page.waitForURL(this.url + "/continue", {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      // Ensure the handoff is visible long enough to receive a Cancel
      // before a slow login navigation takes ownership of the page.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (generation !== this.generation) return;
      const response = await this.page.goto(this.loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (generation !== this.generation) {
        if (this.state === "cancelled") await this.show().catch(() => {});
        return;
      }
      if (response && response.status() >= 400) throw new Error("HTTP " + response.status());
      this.state = "login";
    } catch {
      if (generation !== this.generation || this.page.isClosed()) {
        if (
          this.state === "cancelled" &&
          !this.page.isClosed() &&
          this.page.url() !== this.url + "/cancel"
        ) {
          await this.show().catch(() => {});
        }
        return;
      }
      this.state = "failed";
      await this.show().catch(() => {});
    }
  }

  async finish(state) {
    if (!["signed_in", "expired"].includes(state)) throw new Error("Invalid sign-in state");
    this.generation++;
    this.state = state;
    await this.show();
  }
}

module.exports = { SignInHandoff };
