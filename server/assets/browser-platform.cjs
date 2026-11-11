"use strict";

// Termux's Node.js reports process.platform as "android", and playwright-core
// throws "Unsupported platform" as soon as it loads. Termux is a Linux
// userland, so present it as Linux before anything requires Playwright.
// `termuxPrefix` keeps the difference for the few places it matters.
const android = process.platform === "android";
if (android) Object.defineProperty(process, "platform", { value: "linux" });

/** Where Termux installs its packages (Chromium, procps); null elsewhere. */
const termuxPrefix = android ? process.env.PREFIX || "/data/data/com.termux/files/usr" : null;

module.exports = { termuxPrefix };
