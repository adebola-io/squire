"use strict";

const { termuxPrefix } = require("./browser-platform.cjs");

const DISK_CACHE_BYTES = 512 * 1024 * 1024;

function launchOptions(browser, headless, viewport, downloadsPath, timeout = 20_000) {
  const options = {
    headless,
    // Chromium's sandbox needs kernel features an Android app cannot use,
    // so Termux's Chromium runs without it.
    chromiumSandbox: !termuxPrefix,
    acceptDownloads: true,
    downloadsPath,
    timeout,
    // Real Chrome reports navigator.webdriver === false, but Chromium flips it
    // to true for automated sessions, which is the tell most sites key off.
    // This restores the normal value for the real installed browser.
    args: [
      "--disable-blink-features=AutomationControlled",
      // Bounds the page cache, which storage limits do not count (see browser-storage.cjs).
      // Chrome evicts the oldest entries past it.
      `--disk-cache-size=${DISK_CACHE_BYTES}`,
    ],
  };
  if (headless) {
    options.viewport = viewport;
    options.deviceScaleFactor = 1;
  } else {
    options.viewport = null;
    options.args.push(`--window-size=${viewport.width},${viewport.height}`);
  }
  if (browser.launchStrategy === "playwright-channel") {
    options.channel = browser.playwrightChannel;
  } else {
    options.executablePath = browser.canonicalPath;
  }
  return options;
}

module.exports = { launchOptions };
