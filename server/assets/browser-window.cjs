"use strict";
const { termuxPrefix } = require("./browser-platform.cjs");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function probeGraphicalHost() {
  if (process.env.SQUIRE_BROWSER_HEADLESS === "1") return false;
  let consoleOwned = false;
  let interactive = false;
  try {
    if (process.platform === "darwin")
      consoleOwned = fs.statSync("/dev/console").uid === process.getuid();
    if (process.platform === "win32") {
      interactive =
        // A cold PowerShell start alone can take several seconds; a short limit made
        // Windows report no window at random.
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::UserInteractive"],
          { encoding: "utf8", timeout: 15_000, windowsHide: true },
        )
          .trim()
          .toLowerCase() === "true";
    }
  } catch {
    /* Detection failure leaves native window access unavailable. */
  }
  if (process.platform === "darwin") return consoleOwned;
  if (process.platform === "win32") return interactive;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

let graphicalAvailable;

/** Whether a browser window can open here. Probed once, when first asked. */
function graphicalHost() {
  graphicalAvailable ??= probeGraphicalHost();
  return graphicalAvailable;
}

/** Why no browser window can open here, and what would make one possible. */
const NO_WINDOW_MESSAGE = termuxPrefix
  ? "This device has no display for a browser window. In Termux a window needs Termux:X11: install the Termux:X11 app and `pkg install termux-x11-nightly`, run `termux-x11 :0 &`, then start Squire with DISPLAY=:0."
  : "This host has no graphical browser window.";

module.exports = { graphicalHost, NO_WINDOW_MESSAGE };
