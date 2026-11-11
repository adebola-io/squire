"use strict";

// First, so every later require (playwright-core above all) sees Termux as Linux.
const { termuxPrefix } = require("./browser-platform.cjs");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { AsyncLocalStorage } = require("node:async_hooks");
const { spawn, spawnSync } = require("node:child_process");

const { launchOptions } = require("./browser-launch.cjs");
const { SignInHandoff } = require("./browser-sign-in.cjs");
const {
  directoryBytes,
  profileStorageBytes,
  ownerStorageBytes,
  trimBrowserCaches,
} = require("./browser-storage.cjs");

const REQUEST_CONTEXT = new AsyncLocalStorage();

const PLAYWRIGHT_VERSION = require("./package.json").dependencies["playwright-core"];
const RESPONSE_RESERVE_MS = 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MAX_MS = 20_000;
const LONG_OPERATION_TIMEOUT_MAX_MS = 60_000;
const LONG_OPERATION_ACTIONS = new Set(["new_tab", "goto", "reload", "back", "forward"]);
const OPERATION_WATCHDOG_GRACE_MS = 250;
const DEFAULT_INSPECT_DEPTH = 8;
const DEFAULT_INSPECT_BOXES = false;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const BROWSER_STARTUP_MS = 20_000;
const MAX_PAGES = 32;
const MAX_QUEUE = 8;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const SELECTOR_WAIT_STATES = ["attached", "detached", "visible", "hidden"];
const DOWNLOAD_METADATA_LOCK_WAIT_MS = 60_000;
const DEFAULT_CONTENT_BYTES = 8 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const DEFAULT_LIST_BYTES = 8 * 1024;
const MAX_LIST_BYTES = 64 * 1024;
const MIN_OUTPUT_BYTES = 1024;
const IDLE_EVICTION_MS = 30 * 60 * 1_000;
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PAGE_PATTERN = /^p[a-f0-9]{12}_[0-9]+$/;
const SCREENSHOT_PATTERN = /^s[a-f0-9]{16}$/;
const BROWSERS = {
  chrome: ["playwright-channel", "chrome"],
  edge: ["playwright-channel", "msedge"],
  brave: ["executable-path", null],
  chromium: ["executable-path", null],
};
const FAMILIES = Object.keys(BROWSERS);
const BROWSER_LABELS = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  chromium: "Chromium",
};
/** A browser's product name, with its channel when not stable ("Microsoft Edge Beta"). */
function browserLabel(browser) {
  const name = BROWSER_LABELS[browser.family] ?? browser.family;
  if (!browser.channel || browser.channel === "stable") return name;
  return `${name} ${browser.channel[0].toUpperCase()}${browser.channel.slice(1)}`;
}
const MAC_BROWSER_BUNDLES = {
  chrome: [["com.google.Chrome", "Google Chrome", "stable"]],
  edge: [
    ["com.microsoft.edgemac", "Microsoft Edge", "stable"],
    ["com.microsoft.edgemac.Beta", "Microsoft Edge Beta", "beta"],
    ["com.microsoft.edgemac.Dev", "Microsoft Edge Dev", "dev"],
    ["com.microsoft.edgemac.Canary", "Microsoft Edge Canary", "canary"],
  ],
  brave: [["com.brave.Browser", "Brave Browser", "stable"]],
  chromium: [["org.chromium.Chromium", "Chromium", "stable"]],
};
const CONSOLE_LEVELS = ["error", "warning", "info", "debug"];
const NAVIGATION_ACTIONS = ["goto", "back", "forward", "reload"];
const NON_CLICK_INTERACTION_ACTIONS = [
  "double_click",
  "key",
  "click_at",
  "drag",
  "wheel_at",
  "fill",
  "fill_form",
  "type",
  "press",
  "select_option",
  "select_combobox",
  "check",
  "uncheck",
  "hover",
  "focus",
  "scroll",
  "scroll_to_element",
  "upload",
];
const INTERACTION_ACTIONS = [
  "click",
  "click_and_wait",
  "click_and_inspect",
  "click_and_capture_response",
  ...NON_CLICK_INTERACTION_ACTIONS,
];
const DIALOG_ACTIONS = ["accept_next_dialog", "dismiss_next_dialog"];
const SCREENSHOT_ACTIONS = ["screenshot_viewport", "screenshot_full_page", "screenshot_element"];
const EMPTY_RESULT_ACTIONS = [
  "stop_profile",
  "delete_profile",
  "close_tab",
  ...NON_CLICK_INTERACTION_ACTIONS,
  ...DIALOG_ACTIONS,
  "clear_console",
  "move_download",
  "export_screenshot",
  "delete_screenshot",
];
const SUPPORTED_ACTIONS = new Set([
  "create_profile",
  "start_profile",
  "stop_profile",
  "delete_profile",
  "list_profiles",
  "list_tabs",
  "new_tab",
  "close_tab",
  "resize",
  "inspect_page",
  "inspect_element",
  ...NAVIGATION_ACTIONS,
  ...INTERACTION_ACTIONS,
  ...DIALOG_ACTIONS,
  "wait_for_text",
  "wait_for_url",
  "wait_for_selector",
  "wait_for_load",
  "wait_for_dom_content_loaded",
  "wait_for_network_idle",
  "read_console",
  "clear_console",
  "evaluate_page",
  "evaluate_element",
  "sign_in_start",
  "sign_in_state",
  "sign_in_finish",
  "export_cookies",
  "list_downloads",
  "move_download",
  ...SCREENSHOT_ACTIONS,
  "list_screenshots",
  "export_screenshot",
  "delete_screenshot",
]);
const SAFE_OUTPUT_TOKEN = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%+-]+$/;

class BrowserError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function invalid(argument, reason) {
  return new BrowserError("invalid_argument", `${argument}: ${reason}`, { argument, reason });
}

function profileName(args) {
  const profile = args.profile;
  if (typeof profile !== "string" || profile.length === 0) {
    throw invalid("profile", "is required");
  }
  if (!PROFILE_PATTERN.test(profile) || profile === "." || profile === "..") {
    throw invalid("profile", "must match [A-Za-z0-9._-]{1,64}, excluding . and ..");
  }
  return profile;
}

function numberArg(args, name, defaultValue, minimum, maximum) {
  const value = args[name] ?? defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw invalid(name, "must be a number");
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function boundedIntegerArg(args, name, defaultValue, minimum, maximum) {
  const value = args[name] ?? defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalid(name, "must be an integer");
  if (parsed < minimum || parsed > maximum) {
    throw invalid(name, `must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function pointerNumber(args, name, maximum) {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= maximum) {
    throw invalid(
      name,
      `must be a finite viewport coordinate between 0 and ${maximum} (exclusive)`,
    );
  }
  return value;
}

function pointerPoint(page, args, xName, yName) {
  const viewport = page.viewportSize();
  if (!viewport) throw new BrowserError("viewport_unavailable", "the page has no viewport");
  return {
    x: pointerNumber(args, xName, viewport.width),
    y: pointerNumber(args, yName, viewport.height),
  };
}

function pointerModifiers(args) {
  const modifiers = args.modifiers ?? [];
  if (
    !Array.isArray(modifiers) ||
    modifiers.length > 4 ||
    new Set(modifiers).size !== modifiers.length ||
    modifiers.some((key) => !["Shift", "Control", "Alt", "Meta"].includes(key))
  ) {
    throw invalid("modifiers", "must be a unique list of Shift, Control, Alt, or Meta");
  }
  return modifiers;
}

async function withPointerModifiers(page, modifiers, run) {
  const held = [];
  try {
    for (const key of modifiers) {
      await page.keyboard.down(key);
      held.push(key);
    }
    return await run();
  } finally {
    for (const key of held.reverse()) await page.keyboard.up(key).catch(() => {});
  }
}

function wheelDelta(args, name) {
  const value = args[name] ?? 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100_000) {
    throw invalid(name, "must be a finite number between -100000 and 100000");
  }
  return value;
}

function booleanArg(args, name, defaultValue) {
  const value = args[name] ?? defaultValue;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw invalid(name, "must be boolean");
}

function choiceArg(args, name, choices) {
  const value = args[name];
  if (!choices.includes(value)) throw invalid(name, `must be one of ${choices.join(", ")}`);
  return value;
}

function stringArg(args, name, defaultValue, { allowEmpty = true } = {}) {
  const value = args[name] ?? defaultValue;
  if (typeof value !== "string") throw invalid(name, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalid(name, "must not be empty");
  return value;
}

function deadlineError(message, state) {
  return new BrowserError("host_deadline_exceeded", message, {
    deadlineState: state,
    responseReserveMs: RESPONSE_RESERVE_MS,
  });
}

function dataRoot() {
  const root = REQUEST_CONTEXT.getStore()?.ownerDir;
  if (typeof root !== "string" || root.length === 0) {
    throw new BrowserError("browser_internal_error", "browser owner directory is unavailable");
  }
  return root;
}

function profileRoot(profile) {
  const request = REQUEST_CONTEXT.getStore();
  if (request?.profile !== profile || typeof request.profileDir !== "string") {
    throw new BrowserError("browser_internal_error", "browser profile directory is unavailable", {
      profile,
    });
  }
  return request.profileDir;
}

function readJson(file, missingValue) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return missingValue;
    }
    throw error;
  }
}

function privateDirectory(directory) {
  const created = !fs.existsSync(directory);
  if (!created && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`private browser directory must not be a symlink: ${directory}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!created) {
    return;
  }
  if (process.platform === "win32") {
    const owner = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const result = spawnSync(
      "icacls.exe",
      [directory, "/inheritance:r", "/grant:r", `${owner}:(OI)(CI)F`],
      { timeout: 2_000, windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`failed to apply owner-only ACL to ${directory}`);
    }
  } else {
    fs.chmodSync(directory, 0o700);
  }
}

function writeJson(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectAfter(ms, error) {
  return new Promise((_, reject) => setTimeout(() => reject(error), ms).unref());
}

function errorResult(error) {
  const known = error instanceof BrowserError;
  const code = known ? error.code : "browser_internal_error";
  const message = known ? error.message : String(error.message ?? error);
  const details = known ? error.details : {};
  return { error: { code, message: message.slice(0, 1_024), details } };
}

function compactValue(value) {
  if (value === null) return "-";
  if (typeof value === "string") {
    return value.length > 0 && SAFE_OUTPUT_TOKEN.test(value) ? value : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (
    Array.isArray(value) &&
    value.every((item) => ["string", "number", "boolean"].includes(typeof item))
  ) {
    return value.map(compactValue).join(",");
  }
  return JSON.stringify(value);
}

function record(fields) {
  return fields
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${compactValue(value)}`)
    .join(" ");
}

function listBudget(args) {
  return numberArg(args, "max_bytes", DEFAULT_LIST_BYTES, MIN_OUTPUT_BYTES, MAX_LIST_BYTES);
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
}

function consoleLevel(type) {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning" || type === "warn") return "warning";
  if (type === "info" || type === "log") return "info";
  return "debug";
}

function candidateFrames(page, frameUrl) {
  return frameUrl === undefined
    ? [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())]
    : page.frames().filter((frame) => frame.url().includes(frameUrl));
}

function evaluationText(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function evaluateElementFunction(locator, expression) {
  return locator.evaluate((element, source) => {
    const elementFunction = (0, eval)(`(${source})`);
    if (typeof elementFunction !== "function") {
      throw new TypeError("element expression must evaluate to a function");
    }
    return elementFunction(element);
  }, expression);
}

function boundedStructuredCollection(base, key, items, args) {
  const maximumBytes = listBudget(args);
  const full = { ...base, [key]: items };
  if (Buffer.byteLength(JSON.stringify(full)) <= maximumBytes) return full;

  const shown = [];
  const truncated = { ...base, [key]: shown, truncated: true, omittedItems: items.length };
  let bytes = Buffer.byteLength(JSON.stringify(truncated));
  for (const item of items) {
    const omitted = items.length - shown.length - 1;
    if (omitted === 0) break;
    const nextBytes =
      bytes +
      Buffer.byteLength(JSON.stringify(item)) +
      (shown.length ? 1 : 0) +
      String(omitted).length -
      String(truncated.omittedItems).length;
    if (nextBytes > maximumBytes) break;
    shown.push(item);
    truncated.omittedItems = omitted;
    bytes = nextBytes;
  }
  return truncated;
}

function structuredContent(result, type, trust) {
  const content = { type, trust, text: result.content };
  if (result.truncated) {
    content.truncated = true;
    content.totalBytes = result.totalContentBytes;
  }
  return content;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function structuredActionResult(action, result, args = {}) {
  if (["sign_in_start", "sign_in_state", "sign_in_finish"].includes(action))
    return { state: result.state };
  if (["inspect_page", "inspect_element", "click_and_inspect"].includes(action)) {
    return {
      url: result.url,
      title: result.title,
      ...(result.downloadStarted ? { downloadStarted: true } : {}),
      content: structuredContent(result, result.contentType, result.contentTrust),
    };
  }
  if (action === "create_profile") {
    return { browser: { family: result.browserFamily, version: result.browserVersion } };
  }
  if (action === "start_profile") {
    return {
      page: result.page,
      headless: result.headless,
      headlessApplied: result.headlessApplied,
      ...(result.abandonedOperation === undefined
        ? {}
        : { abandonedOperation: result.abandonedOperation }),
    };
  }
  if (action === "list_profiles") {
    return boundedStructuredCollection(
      {},
      "profiles",
      result.profiles.map((item) => ({
        ...pick(item, [
          "profile",
          "state",
          "headless",
          "width",
          "height",
          "pages",
          "bytes",
          "lastUsed",
          "abandonedOperation",
          "diagnostic",
        ]),
        browser: { family: item.browserFamily, version: item.browserVersion },
      })),
      args,
    );
  }
  if (action === "list_tabs") {
    return boundedStructuredCollection({}, "tabs", result.tabs, args);
  }
  if (action === "list_downloads") {
    return boundedStructuredCollection(
      {},
      "downloads",
      result.downloads.map((item) => ({
        ...pick(item, [
          "id",
          "state",
          "filename",
          "bytes",
          "createdAt",
          "destination",
          "error",
          "errorDetails",
        ]),
        ...(item.cleanupPending ? { cleanupPending: true } : {}),
      })),
      args,
    );
  }
  if (action === "list_screenshots") {
    return boundedStructuredCollection(
      {},
      "screenshots",
      result.screenshots.map((item) => pick(item, ["id", "bytes", "createdAt"])),
      args,
    );
  }
  if (SCREENSHOT_ACTIONS.includes(action)) {
    return { screenshotId: result.screenshotId };
  }
  if (action === "read_console") {
    return boundedStructuredCollection(
      { contentTrust: "untrusted-web" },
      "messages",
      result.messages,
      args,
    );
  }
  if (action === "click_and_capture_response") {
    return {
      ...(result.downloadStarted ? { downloadStarted: true } : {}),
      response: {
        url: result.response.url,
        method: result.response.method,
        status: result.response.status,
        content: structuredContent(result.response, "http-response-text", "untrusted-web"),
      },
    };
  }
  if (["evaluate_page", "evaluate_element"].includes(action)) {
    return { content: structuredContent(result, "javascript-result", "untrusted-web") };
  }
  if (action === "export_cookies") return { cookies: result.cookies };
  if (action === "new_tab") {
    return pick(result, ["page", "url", "title"]);
  }
  if (action === "resize") {
    return pick(result, ["profile", "width", "height"]);
  }
  if (action === "close_tab") return {};
  if ([...NAVIGATION_ACTIONS, "click", "click_and_wait"].includes(action)) {
    return {
      url: result.url,
      title: result.title,
      ...(result.downloadStarted ? { downloadStarted: true } : {}),
    };
  }
  if (action.startsWith("wait_for_")) return { status: result.status };
  if (EMPTY_RESULT_ACTIONS.includes(action)) {
    return {};
  }
  throw invalid("action", `unknown browser action ${action}`);
}

function canonicalSuccess(action, result, args = {}) {
  const output = { structuredContent: structuredActionResult(action, result, args) };
  if (result.attachmentPath !== undefined) {
    output.attachments = [{ path: result.attachmentPath, mimeType: result.mimeType }];
  }
  return output;
}

function formatError(error) {
  const value = errorResult(error).error;
  return record([
    ["error", value.code],
    ["message", value.message],
    ...Object.entries(value.details ?? {}),
  ]);
}

function browserCandidate(
  family,
  executablePath,
  launchStrategy = BROWSERS[family][0],
  playwrightChannel = BROWSERS[family][1],
  channel = "stable",
) {
  return [family, launchStrategy, playwrightChannel, executablePath, channel];
}

function spotlightApplicationBundles(bundleId) {
  const result = spawnSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function macExecutableCandidates(home = os.homedir(), findBundles = spotlightApplicationBundles) {
  const roots = ["/Applications", path.join(home, "Applications")];
  return Object.entries(MAC_BROWSER_BUNDLES).flatMap(([family, variants]) =>
    variants.flatMap(([bundleId, name, channel]) => {
      const app = `${name}.app`;
      const bundles = new Set([
        ...roots.map((root) => path.join(root, app)),
        ...findBundles(bundleId).filter((bundle) =>
          roots.some((root) => {
            const relative = path.relative(root, bundle);
            return (
              relative !== "" &&
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
            );
          }),
        ),
      ]);
      return [...bundles].map((bundle) => {
        const systemStable = channel === "stable" && bundle === path.join("/Applications", app);
        return browserCandidate(
          family,
          path.join(bundle, "Contents", "MacOS", name),
          systemStable ? BROWSERS[family][0] : "executable-path",
          systemStable ? BROWSERS[family][1] : null,
          channel,
        );
      });
    }),
  );
}

function executableCandidates() {
  const managed = process.env.SQUIRE_MANAGED_CHROMIUM;
  const managedCandidate = managed ? [browserCandidate("chromium", managed)] : [];
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [...macExecutableCandidates(home), ...managedCandidate];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const browsers = {
      chrome: [
        "chrome.exe",
        [
          path.join(programFiles, "Google/Chrome/Application/chrome.exe"),
          path.join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
          path.join(local, "Google/Chrome/Application/chrome.exe"),
        ],
      ],
      edge: [
        "msedge.exe",
        [
          path.join(programFilesX86, "Microsoft/Edge/Application/msedge.exe"),
          path.join(programFiles, "Microsoft/Edge/Application/msedge.exe"),
        ],
      ],
      brave: [
        "brave.exe",
        [
          path.join(programFiles, "BraveSoftware/Brave-Browser/Application/brave.exe"),
          path.join(local, "BraveSoftware/Brave-Browser/Application/brave.exe"),
        ],
      ],
      chromium: ["chromium.exe", [path.join(local, "Chromium/Application/chrome.exe")]],
    };
    return [
      ...Object.entries(browsers).flatMap(([family, [executable, locations]]) => {
        const registered = ["HKLM", "HKCU"].flatMap((hive) => {
          const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`;
          const result = spawnSync("reg.exe", ["query", key, "/ve"], {
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 16 * 1024,
            windowsHide: true,
          });
          const match = result.status === 0 ? result.stdout.match(/REG_SZ\s+([^\r\n]+)/) : null;
          return match === null ? [] : [match[1].trim().replace(/^"|"$/g, "")];
        });
        return [...registered, ...locations].map((location) => browserCandidate(family, location));
      }),
      ...managedCandidate,
    ];
  }
  const roots = termuxPrefix
    ? [path.join(termuxPrefix, "bin")]
    : ["/usr/local/bin", "/usr/bin", "/snap/bin"];
  const browsers = {
    chrome: [["google-chrome", "google-chrome-stable"], ["/opt/google/chrome/google-chrome"]],
    edge: [["microsoft-edge", "microsoft-edge-stable"], ["/opt/microsoft/msedge/microsoft-edge"]],
    brave: [["brave-browser", "brave-browser-stable"], ["/opt/brave.com/brave/brave-browser"]],
    chromium: [["chromium", "chromium-browser"], ["/usr/lib/chromium/chromium"]],
  };
  return [
    ...Object.entries(browsers).flatMap(([family, [names, locations]]) =>
      [...names.flatMap((name) => roots.map((root) => path.join(root, name))), ...locations].map(
        (location) => browserCandidate(family, location),
      ),
    ),
    ...managedCandidate,
  ];
}

function macBundleValue(executablePath, key) {
  const bundleEnd = executablePath.indexOf(".app/");
  if (bundleEnd < 0) throw new Error("executable is not inside a macOS app bundle");
  const plist = path.join(executablePath.slice(0, bundleEnd + 4), "Contents", "Info.plist");
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${key} is unavailable in the browser app bundle`);
  }
  const value = result.stdout.trim();
  if (value.length === 0) throw new Error(`${key} is empty in the browser app bundle`);
  return value;
}

function macBrowserVersion(family, executablePath) {
  const bundleId = macBundleValue(executablePath, "CFBundleIdentifier");
  const allowedBundleIds = MAC_BROWSER_BUNDLES[family].map(([bundleId]) => bundleId);
  if (!allowedBundleIds.includes(bundleId)) {
    throw new Error(`unexpected bundle identifier ${bundleId}`);
  }
  const version = macBundleValue(executablePath, "CFBundleShortVersionString");
  const match = version.match(/[0-9]+(?:\.[0-9]+){1,3}/);
  if (match === null)
    throw new Error("CFBundleShortVersionString does not contain a browser version");
  return { version: match[0], majorVersion: Number(match[0].split(".")[0]) };
}

/**
 * Windows browsers' versions, from their executables' version resources, keyed by lowercased
 * path. Never by running them: Windows browsers ignore `--version` and start, opening a window
 * or a tab in the one already running. One PowerShell call reads them all.
 */
function windowsBrowserVersions(executablePaths) {
  const versions = new Map();
  if (executablePaths.length === 0) return versions;
  const list = executablePaths.map((file) => `'${file.replace(/'/g, "''")}'`).join(",");
  const output = powershell(
    `foreach ($p in @(${list})) { "$p|$((Get-Item -LiteralPath $p -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)" }`,
  );
  for (const line of (output ?? "").split(/\r?\n/)) {
    const split = line.lastIndexOf("|");
    const version = line.slice(split + 1).trim();
    if (split > 0 && version) versions.set(line.slice(0, split).toLowerCase(), version);
  }
  return versions;
}

function discoverBrowserState(candidates = executableCandidates()) {
  const seen = new Set();
  const failures = [];
  const cacheFile = path.join(dataRoot(), "version-cache.json");
  const cache = readJson(cacheFile, {});
  let changed = false;
  // Read on the first browser missing from the cache, for every installed candidate at once.
  let windowsVersions;
  const windowsVersion = (canonicalPath) => {
    windowsVersions ??= windowsBrowserVersions([
      ...new Set(
        candidates.flatMap(([, , , executablePath]) => {
          try {
            return [fs.realpathSync(executablePath)];
          } catch {
            return [];
          }
        }),
      ),
    ]);
    return windowsVersions.get(canonicalPath.toLowerCase()) ?? null;
  };
  const reject = (family, stage, error) => {
    failures.push({
      family,
      stage,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  };
  const browsers = candidates.flatMap(
    ([family, launchStrategy, playwrightChannel, executablePath, channel = "stable"]) => {
      if (!fs.existsSync(executablePath)) return [];
      let macVersion = null;
      if (process.platform === "darwin" && executablePath !== process.env.SQUIRE_MANAGED_CHROMIUM) {
        try {
          macVersion = macBrowserVersion(family, executablePath);
        } catch (error) {
          return reject(family, "bundle_metadata", error);
        }
      }
      let canonicalPath;
      let stat;
      try {
        canonicalPath = fs.realpathSync(executablePath);
        stat = fs.statSync(canonicalPath);
        if (!stat.isFile()) throw new Error("browser executable is not a file");
      } catch (error) {
        return reject(family, "executable", error);
      }
      const key = `${family}:${canonicalPath}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const identity = {
        size: stat.size,
        modifiedNs: Math.trunc(stat.mtimeMs * 1_000_000),
        fileId: `${stat.dev}:${stat.ino}`,
      };
      const cacheKey = crypto
        .createHash("sha256")
        .update(JSON.stringify({ family, canonicalPath, identity }))
        .digest("hex");
      let version = cache[cacheKey]?.version;
      let majorVersion = cache[cacheKey]?.majorVersion;
      if (version === undefined || majorVersion === undefined) {
        if (macVersion !== null) {
          ({ version, majorVersion } = macVersion);
        } else {
          let text;
          if (process.platform === "win32") {
            text = windowsVersion(canonicalPath);
            if (text === null) {
              return reject(
                family,
                "version",
                new Error("the browser executable has no readable file version"),
              );
            }
          } else {
            const versionProcess = spawnSync(canonicalPath, ["--version"], {
              encoding: "utf8",
              timeout: 2_000,
              maxBuffer: 16 * 1024,
            });
            if (versionProcess.error !== undefined) {
              return reject(family, "version", versionProcess.error);
            }
            text = `${versionProcess.stdout ?? ""} ${versionProcess.stderr ?? ""}`.trim();
          }
          const match = text.match(/[0-9]+(?:\.[0-9]+){1,3}/);
          if (match === null) {
            return reject(
              family,
              "version",
              new Error("browser version command returned no version"),
            );
          }
          version = match[0];
          const chromium = family === "brave" ? text.match(/Chromium[^0-9]*([0-9]+)/i) : null;
          majorVersion = Number(chromium?.[1] ?? version.split(".")[0]);
        }
        cache[cacheKey] = { version, majorVersion };
        changed = true;
      }
      return [
        {
          family,
          channel,
          executablePath,
          canonicalPath,
          version,
          majorVersion,
          launchStrategy,
          playwrightChannel,
          identity,
        },
      ];
    },
  );
  if (changed) writeJson(cacheFile, cache);
  return { browsers, failures };
}

function discoverBrowsers(candidates) {
  return discoverBrowserState(candidates).browsers;
}

function probeError(browser, error, failureStage) {
  return new BrowserError(
    "browser_probe_failed",
    `browser ${failureStage === "cleanup" ? "probe cleanup" : "capability probe"} failed: ${error.message}`,
    {
      family: browser.family,
      version: browser.version,
      launchStrategy: browser.launchStrategy,
      failureStage,
      errorCategory: error.name ?? "Error",
    },
  );
}

async function probeBrowser(browser, hostDeadline) {
  const probeBudget = Math.min(BROWSER_STARTUP_MS, hostDeadline - Date.now() - RESPONSE_RESERVE_MS);
  if (probeBudget <= 0) {
    throw deadlineError("the host deadline leaves no capability probe budget", "insufficient");
  }
  const probeDeadline = Date.now() + probeBudget;
  const key = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        family: browser.family,
        canonicalPath: browser.canonicalPath,
        identity: browser.identity,
        version: browser.version,
        playwrightVersion: PLAYWRIGHT_VERSION,
      }),
    )
    .digest("hex");
  const cacheFile = path.join(dataRoot(), "probe-cache.json");
  const cache = readJson(cacheFile, {});
  if (cache[key]?.success === true) {
    return;
  }
  const probeRoot = path.join(dataRoot(), "probes", crypto.randomBytes(12).toString("hex"));
  privateDirectory(probeRoot);
  const { chromium } = require("playwright-core");
  let context;
  try {
    context = await Promise.race([
      chromium.launchPersistentContext(
        path.join(probeRoot, "browser-data"),
        launchOptions(
          browser,
          true,
          { width: 800, height: 600 },
          path.join(probeRoot, "downloads"),
          probeBudget,
        ),
      ),
      rejectAfter(probeBudget, new Error("probe launch timed out")),
    ]);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("data:text/html,<title>Squire Probe</title><button>Ready</button>", {
      timeout: Math.max(1, probeDeadline - Date.now()),
    });
    if ((await page.title()) !== "Squire Probe") {
      throw new Error("title verification failed");
    }
    await page.getByRole("button", { name: "Ready" }).count();
    await page.locator("body").ariaSnapshot({
      timeout: Math.max(1, probeDeadline - Date.now()),
    });
    await page.screenshot({
      type: "png",
      timeout: Math.max(1, probeDeadline - Date.now()),
    });
    cache[key] = { success: true, checkedAt: new Date().toISOString() };
    writeJson(cacheFile, cache);
  } catch (error) {
    throw probeError(browser, error, "capability_probe");
  } finally {
    if (context !== undefined) {
      await Promise.race([
        context.close().catch(() => undefined),
        sleep(Math.max(1, Math.min(2_000, probeDeadline - Date.now()))),
      ]);
    }
    try {
      fs.rmSync(probeRoot, { recursive: true, force: true });
    } catch (error) {
      throw probeError(browser, error, "cleanup");
    }
  }
}

function browserNotFoundError(
  requested,
  discoveredBrowsers,
  discoveryFailures = [],
  probeFailures = [],
) {
  const discoveredFamilies = [...new Set(discoveredBrowsers.map((browser) => browser.family))];
  const failedFamilies = [...new Set(discoveryFailures.map((failure) => failure.family))];
  const details = {
    requestedFamily: requested,
    discoveredFamilies,
    supportedFamilies: FAMILIES,
    platform: process.platform,
    discoveryFailures: discoveryFailures.map(
      ({ family, stage, reason }) => `${family}:${stage}:${reason}`,
    ),
    probeFailures,
  };
  const discoveredNames = discoveredFamilies.map((family) => BROWSER_LABELS[family]).join(", ");
  const failedNames = failedFamilies.map((family) => BROWSER_LABELS[family]).join(", ");

  if (requested === "auto") {
    if (discoveredNames.length === 0) {
      return new BrowserError(
        failedNames.length === 0 && !termuxPrefix
          ? "browser_install_required"
          : "browser_not_found",
        failedNames.length === 0
          ? termuxPrefix
            ? "No supported browser installation was found. Install Chromium in Termux with `pkg install x11-repo && pkg install chromium` and try again."
            : "No supported browser installation was found. Install Google Chrome, Microsoft Edge, Brave, or Chromium and try again."
          : `Found ${failedNames}, but Squire could not validate the installation. See discoveryFailures for the exact failed check.`,
        details,
      );
    }
    return new BrowserError(
      "browser_not_found",
      `Detected ${discoveredNames}, but none passed the browser capability probe. See probeFailures for the exact failure.`,
      details,
    );
  }

  const requestedFailed = failedFamilies.includes(requested);
  const message = [
    requestedFailed
      ? `Found ${BROWSER_LABELS[requested]}, but Squire could not validate the installation.`
      : `${BROWSER_LABELS[requested]} is not installed or usable.`,
  ];
  message.push(
    discoveredNames.length === 0
      ? "No other supported browser was detected."
      : `Detected supported browsers: ${discoveredNames}.`,
  );
  if (requested === "chromium") {
    message.push(
      "browser=chromium selects the Chromium application specifically; it does not match Google Chrome, Microsoft Edge, or Brave.",
    );
  }
  message.push("Use browser=auto to select an installed supported browser.");
  return new BrowserError("browser_not_found", message.join(" "), details);
}

async function selectBrowser(requested, hostDeadline) {
  if (requested !== "auto" && !FAMILIES.includes(requested)) {
    throw invalid("browser", `must be one of auto, ${FAMILIES.join(", ")}`);
  }
  const { browsers: allDiscovered, failures } = discoverBrowserState();
  const discovered = allDiscovered.filter((browser) =>
    requested === "auto" ? true : browser.family === requested,
  );
  const probeFailures = [];
  for (const browser of discovered) {
    try {
      await probeBrowser(browser, hostDeadline);
      return browser;
    } catch (error) {
      if (error.code === "host_deadline_exceeded" || requested !== "auto") throw error;
      probeFailures.push(
        `${browser.family}:${error.details?.failureStage ?? "capability_probe"}:${error.message}`,
      );
    }
  }
  throw browserNotFoundError(requested, allDiscovered, failures, probeFailures);
}

function allowedUrl(value) {
  if (typeof value !== "string" || value.length > 8_192) return false;
  if (value === "about:blank") return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizeOperationError(error, profile, action, timeoutMs, pageClosed = false) {
  if (error instanceof BrowserError) return error;
  if (error?.name === "TimeoutError") {
    const lines = String(error.message ?? "")
      .split("\n")
      .map((line) => line.trim());
    const reason = lines
      .reverse()
      .find((line) =>
        /intercepts pointer events|not visible|not stable|outside of the viewport|not enabled/i.test(
          line,
        ),
      );
    if (
      reason &&
      [
        "click",
        "double_click",
        "click_and_wait",
        "click_and_inspect",
        "click_and_capture_response",
      ].includes(action)
    ) {
      return new BrowserError(
        "click_blocked",
        `${action} could not reach its target: ${reason.slice(0, 320)}`,
        { profile, action, timeoutMs, reason: reason.slice(0, 320) },
      );
    }
    return new BrowserError("operation_timeout", `${action} timed out after ${timeoutMs}ms`, {
      profile,
      action,
      timeoutMs,
    });
  }
  const message = String(error?.message ?? error);
  if (pageClosed || error?.name === "TargetClosedError") {
    return new BrowserError("page_closed", "the target page is no longer available", {
      profile,
      action,
      errorCategory: error?.name ?? "Error",
    });
  }
  let code = "browser_action_failed";
  if (["goto", "back", "forward", "reload", "new_tab"].includes(action)) {
    code = "navigation_failed";
  } else if (["inspect_page", "inspect_element"].includes(action)) {
    code = "inspection_failed";
  } else if (["evaluate_page", "evaluate_element"].includes(action)) {
    code = "javascript_evaluation_failed";
  } else if (action.startsWith("screenshot_")) {
    code = "screenshot_failed";
  } else if (
    [
      "click",
      "double_click",
      "click_at",
      "drag",
      "wheel_at",
      "fill",
      "type",
      "press",
      "key",
      "select_option",
      "check",
      "uncheck",
      "hover",
      "focus",
      "scroll",
    ].includes(action)
  ) {
    code = "interaction_failed";
  }
  return new BrowserError(code, `${action} failed: ${message}`, {
    profile,
    action,
    errorCategory: error?.name ?? "Error",
  });
}

async function acquireOwnedLock(file, deadline, profile, purpose) {
  privateDirectory(path.dirname(file));
  const helper = process.env.SQUIRE_BROWSER_LOCK_HELPER;
  if (typeof helper !== "string" || helper.length === 0) {
    throw new BrowserError("browser_internal_error", "kernel lock helper is unavailable", {
      profile,
      purpose,
    });
  }
  const remaining = deadline - Date.now() - RESPONSE_RESERVE_MS;
  if (remaining <= 0) {
    throw new BrowserError("profile_busy", `${purpose} is busy`, { profile, purpose });
  }

  const child = spawn(helper, ["--internal-lock", file], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdin.on("error", () => undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new BrowserError("profile_busy", `${purpose} is busy`, { profile, purpose })),
      remaining,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!settled && stdout.split(/\r?\n/, 1)[0] === "locked") {
        settled = true;
        clearTimeout(timer);
        resolve({ child, file });
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once("error", (error) =>
      fail(
        new BrowserError(
          "browser_internal_error",
          `failed to start kernel lock helper: ${error.message}`,
          {
            profile,
            purpose,
          },
        ),
      ),
    );
    child.once("exit", (code) => {
      if (!settled) {
        fail(
          new BrowserError(
            "browser_internal_error",
            "kernel lock helper exited before acquiring the lock",
            {
              profile,
              purpose,
              exitCode: code,
              stderr: truncateUtf8(stderr.trim(), 1024),
            },
          ),
        );
      }
    });
  });
}

async function releaseOwnedLock(lock) {
  const child = lock.child;
  if (child.exitCode !== null) return;
  child.stdin.end();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function withOwnedLock(file, deadline, profile, purpose, run) {
  const lock = await acquireOwnedLock(file, deadline, profile, purpose);
  try {
    return await run();
  } finally {
    await releaseOwnedLock(lock);
  }
}

function lifecycleLockFile(profile) {
  return path.join(dataRoot(), "profile-locks", `${profile}.lock`);
}

function withProfileLock(profile, deadline, run) {
  return withOwnedLock(lifecycleLockFile(profile), deadline, profile, "profile lifecycle", run);
}

function stateLockFile(root, name) {
  const ownerRoot = path.dirname(path.dirname(root));
  return path.join(ownerRoot, "state-locks", `${path.basename(root)}-${name}.lock`);
}

const { graphicalHost, NO_WINDOW_MESSAGE } = require("./browser-window.cjs");

class ProfileDaemon {
  constructor(owner, profile, root, metadata, limits, onStopped = () => undefined, session, view) {
    this.session = session;
    this.view = view;
    this.downloadTasks = new Set();
    this.activeDownloads = new Set();
    this.downloadFrames = new Set();
    this.pageDownloadTracking = new WeakMap();
    this.owner = owner;
    this.profile = profile;
    this.root = root;
    this.metadata = metadata;
    this.limits = limits;
    this.context = undefined;
    this.pages = new Map();
    this.pageIds = new WeakMap();
    this.runId = crypto.randomBytes(6).toString("hex");
    this.nextPage = 1;
    this.onStopped = onStopped;
    this.closing = false;
    this.stopPromise = undefined;
    this.lastUsed = Date.now();
    this.externalOperations = 0;
    this.dialogPlans = new Map();
    this.signIns = new Map();
    this.closedSignIns = new Set();
    this.signInShutdown = undefined;
    this.downloadsFile = path.join(root, "downloads.json");
    this.screenshotsFile = path.join(root, "screenshots.json");
    this.reservedDownloadBytes = 0;
    this.browserProcesses = [];
  }

  async recoverInterruptedDownloads() {
    await withOwnedLock(
      stateLockFile(this.root, "downloads"),
      Date.now() + DOWNLOAD_METADATA_LOCK_WAIT_MS,
      this.profile,
      "download metadata",
      async () => {
        const downloads = readJson(this.downloadsFile, []);
        let changed = false;
        for (const record of downloads) {
          if (record.state !== "in_progress") continue;
          fs.rmSync(path.join(this.root, "downloads", `.${record.id}.partial`), { force: true });
          record.state = "failed";
          record.error = "download_interrupted";
          record.errorDetails = {};
          changed = true;
        }
        if (changed) writeJson(this.downloadsFile, downloads);
      },
    );
  }

  async start() {
    const { chromium } = require("playwright-core");
    const browser = this.metadata.browser;
    for (const name of ["downloads", "download-staging", "screenshots"]) {
      privateDirectory(path.join(this.root, name));
    }
    await this.recoverInterruptedDownloads();
    const launch = async () => {
      if (this.session?.private) {
        const lease = await privateBrowsers.acquire(this.metadata);
        this.releasePrivate = lease.release;
        this.browserProcesses = lease.processes;
        return lease.context;
      }
      privateDirectory(path.join(this.root, "browser-data"));
      return chromium.launchPersistentContext(
        path.join(this.root, "browser-data"),
        launchOptions(
          browser,
          this.metadata.headless,
          this.metadata.viewport,
          path.join(this.root, "download-staging"),
          BROWSER_STARTUP_MS,
        ),
      );
    };
    this.context = await launch().catch((error) => {
      const message = error.message.toLowerCase();
      if (message.includes("sandbox")) {
        throw new BrowserError(
          "browser_sandbox_unavailable",
          `browser sandbox is unavailable: ${error.message}`,
          {
            family: browser.family,
            version: browser.version,
            platform: process.platform,
            failedPrerequisite: "chromium_sandbox",
          },
        );
      }
      if (message.includes("policy") || message.includes("managed")) {
        throw new BrowserError(
          "browser_blocked_by_policy",
          `browser launch was blocked by policy: ${error.message}`,
          {
            family: browser.family,
            version: browser.version,
            policyCategory: "enterprise_policy",
          },
        );
      }
      throw new BrowserError("browser_launch_failed", `browser launch failed: ${error.message}`, {
        family: browser.family,
        version: browser.version,
        launchStrategy: browser.launchStrategy,
        errorCategory: error.name ?? "Error",
      });
    });
    {
      this.oversizedDownloads = new Set();
      const browserCDP = await this.context.browser().newBrowserCDPSession();
      const downloads = new Map();
      browserCDP.on("Browser.downloadWillBegin", (event) => {
        if (this.downloadFrames.has(event.frameId)) downloads.set(event.guid, event.url);
      });
      browserCDP.on("Browser.downloadProgress", (event) => {
        if (
          downloads.has(event.guid) &&
          Math.max(event.totalBytes, event.receivedBytes) > MAX_DOWNLOAD_BYTES
        ) {
          this.oversizedDownloads.add(downloads.get(event.guid));
          browserCDP
            .send("Browser.cancelDownload", {
              guid: event.guid,
              ...(this.browserContextId ? { browserContextId: this.browserContextId } : {}),
            })
            .catch(() => this.stop());
        }
        if (event.state !== "inProgress") downloads.delete(event.guid);
      });
      // A persistent profile runs in the browser's default context, which CDP
      // addresses by leaving browserContextId out, as Playwright does. Its own
      // id resolves in desktop Chrome but not in Termux's Chromium ("Failed to
      // find browser context"). A private session's context is a created one,
      // which needs its id.
      let browserContextId;
      if (this.session?.private) {
        const targetCDP = await this.context.newCDPSession(await this.context.newPage());
        try {
          const target = await targetCDP.send("Target.getTargetInfo");
          browserContextId = target.targetInfo.browserContextId;
        } finally {
          await targetCDP.detach();
        }
      }
      this.downloadCDP = browserCDP;
      this.browserContextId = browserContextId;
      await browserCDP.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: path.join(this.root, "download-staging"),
        eventsEnabled: true,
        ...(browserContextId ? { browserContextId } : {}),
      });
    }
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !allowedUrl(request.url())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    this.context.on("page", (page) => {
      this.registerPage(page);
      if (this.ready) this.trackDownloadFrames(page).catch(() => {});
      if (this.session) {
        const origin = this.creatingOrigin;
        page
          .opener()
          .then((opener) => this.session.observe(page, opener, origin))
          .catch(() => {});
      }
      // Plugin tabs are attached at the invoking action, not from a
      // context-level page event which carries no conversation scope.
      this.applyViewportToPage(page).catch(() => undefined);
    });
    this.context.on("close", () => {
      if (!this.closing) {
        process.stderr.write(`browser context closed unexpectedly profile=${this.profile}\n`);
      }
      this.stop();
    });
    // Persistent profile data survives restarts, but runtime tab topology does
    // not. Chromium may create an initial page for a persistent context; close
    // every launch-created page, leaving exactly one fresh about:blank page.
    // That page opens first: on Windows and Linux a browser with a window quits
    // when its last one closes, ending it before its process is recorded.
    for (const page of this.context.pages()) this.registerPage(page);
    const initialPage = await this.context.newPage();
    this.registerPage(initialPage);
    const launched = [...this.pages.values()].filter((page) => page !== initialPage);
    await Promise.all(launched.map((page) => page.close().catch(() => undefined)));
    this.ready = true;
    if (this.session) {
      // A shared session opens its own tabs; its first one takes this page over
      // (newTab), so no stray blank tab stays behind.
      this.placeholder = initialPage;
    } else {
      await this.applyViewportToPage(initialPage);
      await this.trackDownloadFrames(initialPage);
    }
    this.idleTimer = setInterval(() => {
      // Shared tab expiry owns page lifetime. Retire its empty runtime only
      // after the registry has closed idle tabs, and never during a download.
      const pagesAllowShutdown = !this.session || this.pages.size === 0;
      if (
        pagesAllowShutdown &&
        !this.session?.keepOpen &&
        this.downloadTasks.size === 0 &&
        this.externalOperations === 0 &&
        Date.now() - this.lastUsed >= IDLE_EVICTION_MS
      ) {
        this.stop();
      }
    }, 60_000).unref();
  }

  registerPage(page) {
    if (this.pageIds.has(page)) return this.pageIds.get(page);
    if (this.pages.size === MAX_PAGES) {
      page.close().catch(() => undefined);
      return undefined;
    }
    const id = `p${this.runId}_${this.nextPage}`;
    this.nextPage += 1;
    this.pages.set(id, page);
    this.pageIds.set(page, id);
    page.on("close", () => {
      this.pages.delete(id);
      this.dialogPlans.delete(id);
      if (this.signIns.delete(id)) {
        this.closedSignIns.add(id);
        if (this.closedSignIns.size > 128)
          this.closedSignIns.delete(this.closedSignIns.values().next().value);
      }
    });
    page.on("popup", (popup) => {
      this.registerPage(popup);
      (this.session ?? this.view)?.observe(popup, page);
      popup.setViewportSize(page.viewportSize() ?? this.currentViewport()).catch(() => undefined);
    });
    page.on("crash", () => {
      process.stderr.write(
        `browser page crashed profile=${this.profile} page=${id} url=${page.url().slice(0, 1024)}\n`,
      );
    });
    page.on("dialog", (dialog) => {
      const plan = this.dialogPlans.get(id);
      this.dialogPlans.delete(id);
      const prompt = dialog.type() === "prompt" ? plan?.value : undefined;
      const task = plan?.response === "accept" ? dialog.accept(prompt) : dialog.dismiss();
      task.catch(() => undefined);
    });
    page.on("download", (download) => {
      this.activeDownloads.add(download);
      this.lastUsed = Date.now();
      const capture = () => this.captureDownload(download, page);
      const task = (this.session ?? this.view)?.download(page, capture) ?? capture();
      this.downloadTasks.add(task);
      task
        .catch((error) =>
          process.stderr.write(`download capture failed: ${error.code ?? "unknown"}\n`),
        )
        .finally(() => {
          this.downloadTasks.delete(task);
          this.activeDownloads.delete(download);
          this.lastUsed = Date.now();
        });
    });
    return id;
  }

  page(id) {
    if (id === undefined) throw invalid("page", "is required");
    if (!PAGE_PATTERN.test(id)) throw invalid("page", "is not a valid runtime page handle");
    const page = this.pages.get(id);
    if (page === undefined) throw invalid("page", `unknown page ${id}`);
    return [id, page];
  }

  async locator(page, selector, pageId, frameUrl) {
    const frameFilter =
      frameUrl === undefined
        ? undefined
        : stringArg({ frame: frameUrl }, "frame", undefined, { allowEmpty: false });
    const frames = candidateFrames(page, frameFilter);
    if (frames.length === 0) throw invalid("frame", "no frame matches the URL substring");
    if (frameFilter !== undefined && frames.length !== 1) {
      throw invalid("frame", "URL substring matches multiple frames; use a more specific value");
    }

    const matches = [];
    for (const frame of frames) {
      let locator;
      try {
        locator = frame.locator(selector);
        const count = await locator.count();
        if (count > 0) matches.push({ locator, count, url: frame.url() });
      } catch (error) {
        throw invalid(
          "selector",
          `invalid Playwright selector: ${truncateUtf8(error.message, 512)}`,
        );
      }
      // Prefer the main document unless a specific frame was requested.
      if (matches.length > 0 && frame === page.mainFrame() && frameFilter === undefined) break;
    }
    const matchCount = matches.reduce((total, match) => total + match.count, 0);
    if (matchCount === 1) return matches[0].locator.first();
    if (matchCount === 0) {
      throw new BrowserError("element_not_found", "selector matched no elements", {
        profile: this.profile,
        page: pageId,
        selector,
      });
    }
    throw new BrowserError("element_ambiguous", "selector matched multiple elements", {
      profile: this.profile,
      page: pageId,
      selector,
      matchCount,
      frames: matches.map((match) => match.url).slice(0, 8),
    });
  }

  async snapshot(pageId, page, args, timeoutMs, selector = undefined) {
    const maxBytes = numberArg(args, "max_bytes", DEFAULT_CONTENT_BYTES, 1, MAX_CONTENT_BYTES);
    const depth = boundedIntegerArg(args, "depth", DEFAULT_INSPECT_DEPTH, 1, 16);
    const boxes = booleanArg(args, "boxes", DEFAULT_INSPECT_BOXES);
    const rawSnapshot =
      selector === undefined
        ? await page.ariaSnapshot({ mode: "ai", depth, boxes, timeout: timeoutMs })
        : await (
            await this.locator(page, selector, pageId, args.frame)
          ).ariaSnapshot({
            mode: "ai",
            depth,
            boxes,
            timeout: timeoutMs,
          });
    const refs = [
      ...new Set(
        [...rawSnapshot.matchAll(/\[ref=((?:f[0-9]+)*e[0-9]+)\]/g)].map((match) => match[1]),
      ),
    ];
    const selectors = new Map(
      await Promise.all(
        refs.map(async (ref) => {
          try {
            const locator = page.locator(`aria-ref=${ref}`);
            if ((await locator.count()) !== 1) return [ref, null];
            const candidates = await locator.evaluate((element) => {
              const candidates = [];
              if (element.id.length > 0) candidates.push(`#${CSS.escape(element.id)}`);
              for (const attribute of [
                "data-testid",
                "data-test",
                "data-cy",
                "name",
                "aria-label",
              ]) {
                const value = element.getAttribute(attribute);
                if (value !== null) {
                  candidates.push(`${element.localName}[${attribute}=${JSON.stringify(value)}]`);
                }
              }
              const parts = [];
              for (
                let current = element;
                current?.nodeType === Node.ELEMENT_NODE;
                current = current.parentElement
              ) {
                const siblings = [...(current.parentElement?.children ?? [])].filter(
                  (child) => child.localName === current.localName,
                );
                const position =
                  siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
                parts.unshift(`${current.localName}${position}`);
              }
              candidates.push(parts.join(" > "));
              return candidates;
            });
            for (const selector of candidates) {
              try {
                await this.locator(page, selector, pageId);
                return [ref, selector];
              } catch {}
            }
            return [ref, null];
          } catch {
            return [ref, null];
          }
        }),
      ),
    );
    const snapshot = rawSnapshot.replace(/\s+\[ref=((?:f[0-9]+)*e[0-9]+)\]/g, (_match, ref) => {
      const replacement = selectors.get(ref);
      return replacement ? ` [selector=${JSON.stringify(replacement)}]` : "";
    });
    const bytes = Buffer.from(snapshot);
    const content = truncateUtf8(snapshot, maxBytes);
    return {
      profile: this.profile,
      page: pageId,
      url: page.url().slice(0, 4_096),
      title: (await page.title()).slice(0, 1_024),
      contentType: "playwright-aria-yaml",
      contentTrust: "untrusted-web",
      contentBytes: Buffer.byteLength(content),
      totalContentBytes: bytes.length,
      truncated: bytes.length > maxBytes,
      browser: {
        family: this.metadata.browser.family,
        version: this.metadata.browser.version,
      },
      content,
    };
  }

  async listTabs() {
    const tabs = await Promise.all(
      [...this.pages].map(async ([id, page]) => ({
        page: id,
        title: (await page.title()).slice(0, 1_024),
        url: page.url().slice(0, 4_096),
      })),
    );
    return { profile: this.profile, tabs };
  }

  async execute(request) {
    const { action, args, timeoutMs } = request;
    const useDialogPlan =
      typeof args.page === "string" &&
      !["accept_next_dialog", "dismiss_next_dialog"].includes(action) &&
      this.dialogPlans.has(args.page);
    let result;
    try {
      if (action === "list_tabs") result = this.listTabs();
      else if (action === "resize") result = this.resizeViewport(args);
      else if (["inspect_page", "inspect_element"].includes(action)) {
        const [id, page] = this.page(args.page);
        const selector =
          action === "inspect_element"
            ? stringArg(args, "selector", undefined, { allowEmpty: false })
            : undefined;
        result = this.snapshot(id, page, args, timeoutMs, selector);
      } else if (action === "new_tab") result = this.newTab(args, timeoutMs, request.scope);
      else if (action === "close_tab") result = this.closeTab(args);
      else if (NAVIGATION_ACTIONS.includes(action)) {
        result = this.navigate(action, args, timeoutMs);
      } else if (INTERACTION_ACTIONS.includes(action)) {
        result = this.interact(action, args, timeoutMs);
      } else if (DIALOG_ACTIONS.includes(action)) {
        result = this.armDialog(action, args);
      } else if (action.startsWith("wait_for_")) result = this.waitFor(action, args, timeoutMs);
      else if (action === "read_console") result = this.readConsole(args);
      else if (action === "clear_console") result = this.clearConsole(args);
      else if (action === "sign_in_start") {
        const [id, page] = this.page(args.page);
        const site = stringArg(args, "site", undefined, { allowEmpty: false });
        const loginUrl = stringArg(args, "login_url", undefined, { allowEmpty: false });
        if (!allowedUrl(loginUrl) || !loginUrl.startsWith("https://"))
          throw invalid("login_url", "must be an HTTPS URL");
        clearTimeout(this.signInShutdown);
        const handoff = new SignInHandoff(page, {
          plugin: request.pluginName || request.owner,
          pluginIcon: request.pluginIcon,
          action: request.invocationAction,
          site,
          loginUrl,
          onCancelled: () => this.scheduleSignInShutdown("cancelled"),
        });
        await handoff.start();
        this.signIns.set(id, handoff);
        result = { state: handoff.state };
      } else if (action === "sign_in_state" || action === "sign_in_finish") {
        const id = stringArg(args, "page", undefined, { allowEmpty: false });
        if (action === "sign_in_state" && this.closedSignIns.has(id)) {
          result = { state: "closed" };
        } else {
          this.page(id);
          const handoff = this.signIns.get(id);
          if (!handoff) throw invalid("page", "has no active sign-in request");
          if (action === "sign_in_finish") {
            await handoff.finish(args.state);
            this.scheduleSignInShutdown(args.state);
          }
          result = { state: handoff.state };
        }
      } else if (action === "evaluate_page") result = this.evaluatePage(args);
      else if (action === "evaluate_element") result = this.evaluateElement(args);
      else if (action === "export_cookies") result = this.exportCookies(args);
      else if (action.startsWith("screenshot_")) result = this.screenshot(action, args, timeoutMs);
      else throw invalid("action", `unknown browser action ${action}`);
      return await result;
    } finally {
      if (useDialogPlan && this.dialogPlans.has(args.page)) this.dialogPlans.delete(args.page);
    }
  }

  trackDownloadFrames(page) {
    if (this.pageDownloadTracking.has(page)) return this.pageDownloadTracking.get(page);
    const task = (async () => {
      const cdp = await this.context.newCDPSession(page);
      const frames = new Set();
      const remember = (frame) => {
        frames.add(frame.id);
        this.downloadFrames.add(frame.id);
      };
      cdp.on("Page.frameAttached", (event) => remember({ id: event.frameId }));
      cdp.on("Page.frameNavigated", (event) => remember(event.frame));
      page.once("close", () => {
        for (const frame of frames) this.downloadFrames.delete(frame);
        cdp.detach().catch(() => {});
      });
      await cdp.send("Page.enable");
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const walk = (tree) => {
        remember(tree.frame);
        for (const child of tree.childFrames ?? []) walk(child);
      };
      walk(frameTree);
    })();
    this.pageDownloadTracking.set(page, task);
    return task;
  }

  async newTab(args, timeout, scope) {
    if (this.pages.size >= MAX_PAGES) throw pageCapacityError(this.profile);
    const url = stringArg(args, "url", "about:blank", { allowEmpty: false });
    if (!allowedUrl(url)) throw invalid("url", "must use http, https, or about:blank");
    let page;
    const placeholder = this.placeholder;
    this.placeholder = undefined;
    if (placeholder && !placeholder.isClosed() && !this.session?.source(placeholder)) {
      // The page kept open at start (see start()) becomes this tab.
      page = placeholder;
    } else {
      this.creatingOrigin = args.origin ?? "agent";
      try {
        page = await this.context.newPage();
      } finally {
        this.creatingOrigin = undefined;
      }
    }
    const id = this.pageIds.get(page) ?? this.registerPage(page);
    this.session?.observe(page, undefined, args.origin ?? "agent");
    this.view?.observe(page, undefined, args.origin, scope);
    if (id === undefined) {
      await page.close().catch(() => undefined);
      throw pageCapacityError(this.profile);
    }
    try {
      await this.applyViewportToPage(page);
      await this.trackDownloadFrames(page);
      if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return this.pageResult(page, id);
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  async closeTab(args) {
    const [id, page] = this.page(args.page);
    await page.close();
    return { profile: this.profile, page: id, closed: true };
  }

  async navigate(action, args, timeout) {
    const [id, page] = this.page(args.page);
    if (action === "goto") {
      const url = stringArg(args, "url", undefined, { allowEmpty: false });
      if (!allowedUrl(url)) throw invalid("url", "must use http, https, or about:blank");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } else {
      await page[{ back: "goBack", forward: "goForward", reload: "reload" }[action]]({ timeout });
    }
    return this.pageResult(page, id);
  }

  async pageResult(page, id, extra = {}) {
    return {
      profile: this.profile,
      page: id,
      url: page.url().slice(0, 4_096),
      title: (await page.title()).slice(0, 1_024),
      ...extra,
    };
  }

  async actionResult(page, id, selector, extra = {}) {
    let url = "";
    let title = "";
    try {
      url = page.url().slice(0, 4_096);
      if (!page.isClosed()) title = (await page.title()).slice(0, 1_024);
    } catch {}
    return { profile: this.profile, page: id, selector, title, url, ...extra };
  }

  async click(page, locator, timeout, force = false) {
    let initiatedDownload;
    const listener = (download) => {
      initiatedDownload = download;
    };
    page.on("download", listener);
    try {
      await locator.click({ timeout, force });
    } finally {
      page.off("download", listener);
    }
    return initiatedDownload !== undefined;
  }

  currentViewport() {
    const viewport = this.metadata.viewport;
    if (
      viewport === null ||
      typeof viewport !== "object" ||
      !Number.isInteger(viewport.width) ||
      !Number.isInteger(viewport.height)
    ) {
      throw new BrowserError(
        "profile_schema_unsupported",
        "profile viewport is missing or malformed",
        {
          profile: this.profile,
        },
      );
    }
    return viewport;
  }

  async applyViewportToPage(page) {
    if (page.isClosed()) return;
    await page.setViewportSize(this.currentViewport());
  }

  async resizeViewport(args) {
    const width = boundedIntegerArg(args, "width", undefined, 320, 3840);
    const height = boundedIntegerArg(args, "height", undefined, 240, 2160);
    const viewport = { width, height };
    if (this.session) {
      await this.page(args.page)[1].setViewportSize(viewport);
      return { width, height };
    }
    for (const page of this.pages.values()) {
      try {
        await page.setViewportSize(viewport);
        await this.view?.refresh(page);
      } catch (error) {
        if (page.isClosed()) continue;
        throw error;
      }
    }
    const persisted = readJson(path.join(this.root, "profile.json"), null);
    if (persisted === null) {
      throw new BrowserError("profile_not_found", "browser profile does not exist", {
        profile: this.profile,
      });
    }
    persisted.viewport = viewport;
    writeJson(path.join(this.root, "profile.json"), persisted);
    this.metadata.viewport = viewport;
    return { profile: this.profile, width, height };
  }

  async interact(action, args, timeout) {
    const [id, page] = this.page(args.page);
    if (action === "key") {
      const key = stringArg(args, "key", undefined, { allowEmpty: false });
      await page.keyboard.press(key);
      return {};
    }
    if (action === "click_at") {
      const { x, y } = pointerPoint(page, args, "x", "y");
      const button =
        args.button === undefined ? "left" : choiceArg(args, "button", ["left", "right", "middle"]);
      const clickCount = boundedIntegerArg(args, "click_count", 1, 1, 3);
      await withPointerModifiers(page, pointerModifiers(args), () =>
        page.mouse.click(x, y, { button, clickCount }),
      );
      return {};
    }
    if (action === "drag") {
      const from = pointerPoint(page, args, "from_x", "from_y");
      const to = pointerPoint(page, args, "to_x", "to_y");
      const steps = boundedIntegerArg(args, "steps", 20, 1, 120);
      const button =
        args.button === undefined ? "left" : choiceArg(args, "button", ["left", "right", "middle"]);
      await withPointerModifiers(page, pointerModifiers(args), async () => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down({ button });
        try {
          await page.mouse.move(to.x, to.y, { steps });
        } finally {
          await page.mouse.up({ button });
        }
      });
      return {};
    }
    if (action === "wheel_at") {
      const { x, y } = pointerPoint(page, args, "x", "y");
      const deltaX = wheelDelta(args, "delta_x");
      const deltaY = wheelDelta(args, "delta_y");
      if (deltaX === 0 && deltaY === 0) {
        throw invalid("delta_x/delta_y", "at least one nonzero wheel delta is required");
      }
      await withPointerModifiers(page, pointerModifiers(args), async () => {
        await page.mouse.move(x, y);
        await page.mouse.wheel(deltaX, deltaY);
      });
      return {};
    }
    if (action === "scroll") {
      const amount = boundedIntegerArg(args, "amount", undefined, -100_000, 100_000);
      await page.mouse.wheel(0, amount);
      return {};
    }
    if (action === "scroll_to_element") {
      const selector = stringArg(args, "selector", undefined, { allowEmpty: false });
      const locator = await this.locator(page, selector, id, args.frame);
      await locator.scrollIntoViewIfNeeded({ timeout });
      return {};
    }
    if (action === "upload") {
      const selector = stringArg(args, "selector", undefined, { allowEmpty: false });
      const filePath = stringArg(args, "path", undefined, { allowEmpty: false });
      if (!path.isAbsolute(filePath)) throw invalid("path", "must be an absolute file path");
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        throw invalid("path", `upload source is not accessible: ${error.message}`);
      }
      if (!stat.isFile()) throw invalid("path", "upload source must be a file");
      if (stat.size > MAX_UPLOAD_BYTES) {
        throw new BrowserError("upload_too_large", "upload source exceeds the maximum size", {
          profile: this.profile,
          page: id,
          selector,
          bytes: stat.size,
          maximumBytes: MAX_UPLOAD_BYTES,
        });
      }
      const locator = await this.locator(page, selector, id, args.frame);
      await locator.setInputFiles(filePath, { timeout });
      return {};
    }
    if (action === "fill_form") {
      const encoded = stringArg(args, "fields", undefined, { allowEmpty: false });
      let value;
      try {
        value = JSON.parse(encoded);
      } catch {
        throw invalid(
          "fields",
          "must be a JSON object mapping Playwright selectors to string values",
        );
      }
      if (value?.constructor !== Object) {
        throw invalid(
          "fields",
          "must be a JSON object mapping Playwright selectors to string values",
        );
      }
      const fields = Object.entries(value);
      if (fields.length === 0 || fields.length > 32) {
        throw invalid("fields", "must contain between 1 and 32 selector/value entries");
      }
      if (
        fields.some(
          ([selector, fieldValue]) => selector.length === 0 || fieldValue?.constructor !== String,
        )
      ) {
        throw invalid("fields", "selectors must be non-empty and values must be strings");
      }
      for (const [selector, value] of fields) {
        await (await this.locator(page, selector, id, args.frame)).fill(value, { timeout });
      }
      return {};
    }

    const selector = stringArg(args, "selector", undefined, { allowEmpty: false });
    const locator = await this.locator(page, selector, id, args.frame);

    if (
      ["click", "click_and_wait", "click_and_inspect", "click_and_capture_response"].includes(
        action,
      )
    ) {
      const force = booleanArg(args, "force", false);
      const waitState =
        action === "click_and_wait"
          ? choiceArg(args, "wait", ["load", "domcontentloaded", "networkidle"])
          : undefined;
      if (action === "click_and_inspect") {
        numberArg(args, "max_bytes", DEFAULT_CONTENT_BYTES, 1, MAX_CONTENT_BYTES);
        boundedIntegerArg(args, "depth", DEFAULT_INSPECT_DEPTH, 1, 16);
        booleanArg(args, "boxes", DEFAULT_INSPECT_BOXES);
      }
      if (action === "click_and_capture_response") {
        const substring = stringArg(args, "url_substring", undefined, { allowEmpty: false });
        const maxBytes = numberArg(args, "max_bytes", DEFAULT_CONTENT_BYTES, 1, MAX_CONTENT_BYTES);
        const [response, downloadStarted] = await Promise.all([
          page.waitForResponse((response) => response.url().includes(substring), { timeout }),
          this.click(page, locator, timeout, force),
        ]);
        const method = response.request().method();
        const status = response.status();
        const headers = await response.allHeaders();
        const contentLengthHeader = headers["content-length"];
        const contentLength = Number(
          contentLengthHeader ??
            (method === "HEAD" || [204, 304].includes(status) ? 0 : Number.NaN),
        );
        const contentEncoding = headers["content-encoding"];
        if (
          !Number.isSafeInteger(contentLength) ||
          contentLength < 0 ||
          contentLength > MAX_CONTENT_BYTES ||
          (contentEncoding !== undefined && contentEncoding !== "identity")
        ) {
          throw new BrowserError(
            "response_body_unbounded",
            "response body cannot be read within the browser output bound",
            {
              profile: this.profile,
              page: id,
              url: response.url().slice(0, 4_096),
              contentLength: contentLengthHeader,
              contentEncoding,
              maximumBytes: MAX_CONTENT_BYTES,
            },
          );
        }
        const body = await response.text();
        const content = truncateUtf8(body, maxBytes);
        const contentBytes = Buffer.byteLength(content);
        const totalContentBytes = Buffer.byteLength(body);
        return this.actionResult(page, id, selector, {
          downloadStarted,
          response: {
            url: response.url().slice(0, 4_096),
            method,
            status,
            content,
            contentBytes,
            totalContentBytes,
            truncated: contentBytes < totalContentBytes,
          },
        });
      }

      const [, downloadStarted] = await Promise.all([
        action === "click_and_wait"
          ? page.waitForNavigation({ waitUntil: waitState, timeout })
          : undefined,
        this.click(page, locator, timeout, force),
      ]);
      if (action === "click_and_inspect") {
        const snapshot = await this.snapshot(id, page, args, timeout);
        return { ...snapshot, selector, downloadStarted };
      }
      return this.actionResult(page, id, selector, { downloadStarted });
    }

    if (action === "select_combobox") {
      const option = stringArg(args, "option", undefined, { allowEmpty: false });
      const details = { profile: this.profile, page: id, selector, option };
      if (await locator.evaluate((element) => element.localName === "select")) {
        const selected = await locator.selectOption({ label: option }, { timeout });
        if (selected.length === 0) {
          throw new BrowserError("option_not_found", "combobox option was not found", details);
        }
        return {};
      }
      await locator.click({ timeout });
      const choices = [];
      const frames = candidateFrames(page, args.frame);
      for (const frame of frames) {
        const choice = frame.getByRole("option", { name: option, exact: true });
        const count = await choice.count();
        if (count > 0) choices.push({ choice, count, url: frame.url() });
        if (count > 0 && frame === page.mainFrame() && args.frame === undefined) break;
      }
      const matchCount = choices.reduce((total, choice) => total + choice.count, 0);
      if (matchCount === 0) {
        throw new BrowserError("option_not_found", "combobox option was not found", details);
      }
      if (matchCount > 1) {
        throw new BrowserError("option_ambiguous", "combobox option matched multiple elements", {
          ...details,
          matchCount,
          frames: choices.map((choice) => choice.url).slice(0, 8),
        });
      }
      await choices[0].choice.first().click({ timeout });
      return {};
    }

    const [method, argument] = {
      double_click: ["dblclick"],
      fill: ["fill", "value"],
      type: ["pressSequentially", "value"],
      press: ["press", "key"],
      select_option: ["selectOption", "value"],
      check: ["check"],
      uncheck: ["uncheck"],
      hover: ["hover"],
      focus: ["focus"],
    }[action];
    const values =
      argument === undefined
        ? []
        : [stringArg(args, argument, undefined, { allowEmpty: action !== "press" })];
    await locator[method](...values, {
      timeout,
      ...(action === "double_click" ? { force: booleanArg(args, "force", false) } : {}),
    });
    return {};
  }

  async armDialog(action, args) {
    const [id] = this.page(args.page);
    this.dialogPlans.delete(id);
    const response = action === "accept_next_dialog" ? "accept" : "dismiss";
    const value = response === "accept" ? stringArg(args, "value", "") : undefined;
    this.dialogPlans.set(id, { response, value });
    return {};
  }

  selectorError(selector, error) {
    const message = String(error?.message ?? error);
    if (error?.name === "TimeoutError") throw error;
    if (/invalid|parse|syntax|unexpected|strict|undeclared|unknown engine/i.test(message)) {
      throw invalid("selector", `invalid Playwright selector: ${truncateUtf8(message, 512)}`);
    }
    throw error;
  }

  async waitForSelectorAcrossFrames(page, selector, state, timeout, frameUrl) {
    const deadline = Date.now() + timeout;
    const disappearing = state === "detached" || state === "hidden";
    for (;;) {
      const frames = candidateFrames(page, frameUrl);
      if (frames.length === 0) throw invalid("frame", "no frame matches the URL substring");
      if (frameUrl !== undefined && frames.length !== 1) {
        throw invalid("frame", "URL substring matches multiple frames; use a more specific value");
      }
      const remaining = Math.max(1, deadline - Date.now());
      const slice = Math.min(remaining, 1_000);
      const locators = frames.map((frame) => frame.locator(selector).first());
      try {
        if (disappearing) {
          await Promise.all(locators.map((locator) => locator.waitFor({ state, timeout: slice })));
          if (page.frames().length !== frames.length) continue;
          return;
        }
        await Promise.any(locators.map((locator) => locator.waitFor({ state, timeout: slice })));
        return;
      } catch (error) {
        if (error instanceof AggregateError) {
          const actionable = error.errors.find((candidate) => candidate?.name !== "TimeoutError");
          if (actionable !== undefined) throw this.selectorError(selector, actionable);
        } else if (error?.name !== "TimeoutError") {
          throw this.selectorError(selector, error);
        }
        if (Date.now() >= deadline) {
          const timeoutError = new Error(`Timeout ${timeout}ms exceeded.`);
          timeoutError.name = "TimeoutError";
          throw timeoutError;
        }
      }
    }
  }

  async waitFor(action, args, timeout) {
    const [id, page] = this.page(args.page);
    try {
      if (action === "wait_for_text") {
        const text = stringArg(args, "text", undefined, { allowEmpty: false });
        await page.getByText(text, { exact: false }).first().waitFor({ timeout });
      } else if (action === "wait_for_selector") {
        const selector = stringArg(args, "selector", undefined, { allowEmpty: false });
        const state = choiceArg({ state: args.state ?? "visible" }, "state", SELECTOR_WAIT_STATES);
        await this.waitForSelectorAcrossFrames(page, selector, state, timeout, args.frame);
      } else if (action === "wait_for_url") {
        const substring = stringArg(args, "substring", undefined, { allowEmpty: false });
        await page.waitForURL((url) => url.href.includes(substring), { timeout });
      } else {
        const state = {
          wait_for_load: "load",
          wait_for_dom_content_loaded: "domcontentloaded",
          wait_for_network_idle: "networkidle",
        }[action];
        await page.waitForLoadState(state, { timeout });
      }
      return { profile: this.profile, page: id, status: "satisfied" };
    } catch (error) {
      if (error.name === "TimeoutError")
        return { profile: this.profile, page: id, status: "pending" };
      throw error;
    }
  }

  async readConsole(args) {
    const [id, page] = this.page(args.page);
    const minimum = choiceArg({ level: args.level ?? "info" }, "level", CONSOLE_LEVELS);
    const threshold = CONSOLE_LEVELS.indexOf(minimum);
    const consoleMessages = (await page.consoleMessages())
      .map((message) => {
        const type = message.type();
        const level = consoleLevel(type);
        const location = message.location();
        const source = location.url
          ? `${location.url}:${location.lineNumber}:${location.columnNumber}`
          : undefined;
        return {
          level,
          type,
          text: truncateUtf8(message.text(), 4 * 1024),
          source,
        };
      })
      .filter((message) => CONSOLE_LEVELS.indexOf(message.level) <= threshold);
    const pageErrors = (await page.pageErrors()).map((error) => ({
      level: "error",
      type: "pageerror",
      text: truncateUtf8(error.stack ?? error.message ?? String(error), 4 * 1024),
    }));
    return { profile: this.profile, page: id, messages: [...consoleMessages, ...pageErrors] };
  }

  async clearConsole(args) {
    const [id, page] = this.page(args.page);
    await Promise.all([page.clearConsoleMessages(), page.clearPageErrors()]);
    return { profile: this.profile, page: id, cleared: true };
  }

  evaluationResult(id, selector, value, args) {
    const text = evaluationText(value);
    const totalContentBytes = Buffer.byteLength(text);
    const content = truncateUtf8(
      text,
      numberArg(args, "max_bytes", DEFAULT_CONTENT_BYTES, 1, MAX_CONTENT_BYTES),
    );
    return {
      profile: this.profile,
      page: id,
      selector,
      content,
      contentBytes: Buffer.byteLength(content),
      totalContentBytes,
      truncated: Buffer.byteLength(content) < totalContentBytes,
    };
  }

  /**
   * The running profile's cookies, including HttpOnly ones, optionally only
   * those a request to `urls` would send. Ownership already confines a
   * Plugin to its own profiles, and the agent-facing Browser Plugin does not
   * declare this action, so cookies reach Plugin code, never the model.
   */
  async exportCookies(args) {
    const urls = args.urls ?? [];
    if (!Array.isArray(urls) || urls.length > 16)
      throw invalid("urls", "must be a list of at most 16 URLs");
    for (const url of urls) {
      if (!allowedUrl(url) || url === "about:blank")
        throw invalid("urls", "must contain only http or https URLs");
    }
    const cookies = await this.context.cookies(urls.length > 0 ? urls : undefined);
    return {
      profile: this.profile,
      cookies: cookies.map(
        ({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({
          name,
          value,
          domain,
          path,
          expires,
          httpOnly,
          secure,
          sameSite,
        }),
      ),
    };
  }

  async evaluatePage(args) {
    const [id, page] = this.page(args.page);
    const script = stringArg(args, "script", undefined, { allowEmpty: false });
    return this.evaluationResult(id, null, await page.evaluate(script), args);
  }

  async evaluateElement(args) {
    const [id, page] = this.page(args.page);
    const selector = stringArg(args, "selector", undefined, { allowEmpty: false });
    const source = stringArg(args, "function", undefined, { allowEmpty: false });
    const locator = await this.locator(page, selector, id, args.frame);
    return this.evaluationResult(
      id,
      selector,
      await evaluateElementFunction(locator, source),
      args,
    );
  }

  checkStorage(additionalBytes = 0, reservedBytes = this.reservedDownloadBytes) {
    const profileBytes = profileStorageBytes(this.root) + reservedBytes + additionalBytes;
    if (profileBytes > this.limits.profileStorageBytes) {
      throw profileStorageError(
        "profile storage would exceed the maximum size",
        this.profile,
        profileBytes,
        this.limits.profileStorageBytes,
      );
    }
    const ownerBytes =
      supervisorOwnerStorage({
        ownerDir: path.dirname(path.dirname(this.root)),
      }) + additionalBytes;
    if (ownerBytes > this.limits.ownerStorageBytes) {
      throw ownerStorageError(this.owner, ownerBytes, this.limits.ownerStorageBytes);
    }
    return profileBytes;
  }

  async screenshot(action, args, timeout) {
    const [id, page] = this.page(args.page);
    const selector =
      action === "screenshot_element"
        ? stringArg(args, "selector", undefined, { allowEmpty: false })
        : null;
    const bytes =
      action === "screenshot_element"
        ? await (
            await this.locator(page, selector, id, args.frame)
          ).screenshot({ type: "png", timeout })
        : await page.screenshot({
            type: "png",
            timeout,
            fullPage: action === "screenshot_full_page",
          });
    if (bytes.length > MAX_SCREENSHOT_BYTES) {
      throw new BrowserError("screenshot_too_large", "screenshot exceeds the maximum size", {
        bytes: bytes.length,
        maximumBytes: MAX_SCREENSHOT_BYTES,
      });
    }
    this.checkStorage(bytes.length);
    const directory = path.join(this.root, "screenshots");
    privateDirectory(directory);
    const screenshotId = `s${crypto.randomBytes(8).toString("hex")}`;
    const filename = `${screenshotId}.png`;
    const file = path.join(directory, filename);
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    try {
      this.checkStorage();
      const screenshotRecord = {
        id: screenshotId,
        filename,
        mimeType: "image/png",
        bytes: bytes.length,
        createdAt: new Date().toISOString(),
      };
      await withOwnedLock(
        stateLockFile(this.root, "screenshots"),
        Date.now() + DEFAULT_OPERATION_TIMEOUT_MS,
        this.profile,
        "screenshot metadata",
        async () => {
          const screenshots = readJson(this.screenshotsFile, []);
          screenshots.push(screenshotRecord);
          writeJson(this.screenshotsFile, screenshots);
        },
      );
      return {
        profile: this.profile,
        page: id,
        screenshotId,
        selector,
        mimeType: "image/png",
        bytes: bytes.length,
      };
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
  }

  async captureDownload(download, page) {
    const source = (this.session ?? this.view)?.source(page);
    const record = await withOwnedLock(
      stateLockFile(this.root, "downloads"),
      Date.now() + DOWNLOAD_METADATA_LOCK_WAIT_MS,
      this.profile,
      "download metadata",
      async () => {
        const downloads = readJson(this.downloadsFile, []);
        const id = `d${crypto.randomBytes(16).toString("hex")}`;
        const next = {
          id,
          ...(source ? { tab: source, context: this.profile } : {}),
          filename: safeFilename(download.suggestedFilename()),
          bytes: 0,
          state: "in_progress",
          createdAt: new Date().toISOString(),
        };
        downloads.push(next);
        writeJson(this.downloadsFile, downloads);
        return next;
      },
    );
    const partial = path.join(this.root, "downloads", `.${record.id}.partial`);
    let descriptor;
    let reserved = false;
    let outcome;
    try {
      const profileBytes = profileStorageBytes(this.root);
      if (
        profileBytes + this.reservedDownloadBytes + MAX_DOWNLOAD_BYTES >
        this.limits.profileStorageBytes
      ) {
        await download.cancel();
        throw profileStorageError(
          "profile has insufficient download quota",
          this.profile,
          profileBytes,
          this.limits.profileStorageBytes,
        );
      }
      this.reservedDownloadBytes += MAX_DOWNLOAD_BYTES;
      reserved = true;
      const stream = await download.createReadStream();
      if (stream === null)
        throw new Error((await download.failure()) ?? "download stream is unavailable");
      descriptor = fs.openSync(partial, "wx", 0o600);
      let transferred = 0;
      for await (const chunk of stream) {
        transferred += chunk.length;
        if (transferred > MAX_DOWNLOAD_BYTES) {
          await download.cancel();
          throw new BrowserError("download_too_large", "download exceeds the maximum size", {
            downloadId: record.id,
            bytes: transferred,
            maximumBytes: MAX_DOWNLOAD_BYTES,
          });
        }
        fs.writeSync(descriptor, chunk);
      }
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const finalProfileBytes = this.checkStorage(0, 0);
      const parsed = path.parse(record.filename);
      let destination;
      for (let index = 1; index < 10_000; index += 1) {
        const name = index === 1 ? record.filename : `${parsed.name} (${index})${parsed.ext}`;
        const candidate = path.join(this.root, "downloads", name);
        try {
          fs.linkSync(partial, candidate);
          destination = candidate;
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      if (destination === undefined) {
        throw profileStorageError(
          "download filename collision limit reached",
          this.profile,
          finalProfileBytes,
          this.limits.profileStorageBytes,
        );
      }
      fs.unlinkSync(partial);
      outcome = {
        filename: path.basename(destination),
        bytes: transferred,
        state: "complete",
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(partial, { force: true });
      outcome = {
        state: "failed",
        error: this.oversizedDownloads?.has(download.url())
          ? "download_too_large"
          : (error.code ?? error.message),
        errorDetails: error.details ?? {},
      };
    } finally {
      if (reserved) this.reservedDownloadBytes -= MAX_DOWNLOAD_BYTES;
    }
    return withOwnedLock(
      stateLockFile(this.root, "downloads"),
      Date.now() + DOWNLOAD_METADATA_LOCK_WAIT_MS,
      this.profile,
      "download metadata",
      async () => {
        const downloads = readJson(this.downloadsFile, []);
        const current = downloads.find((item) => item.id === record.id);
        if (current === undefined) {
          throw new BrowserError("download_state_lost", "download metadata record disappeared", {
            downloadId: record.id,
          });
        }
        Object.assign(current, outcome);
        writeJson(this.downloadsFile, downloads);
        return current;
      },
    );
  }

  scheduleSignInShutdown(state) {
    clearTimeout(this.signInShutdown);
    // Completion should not delay the original action. Keep the final screen
    // briefly visible before releasing the browser, especially on a remote UI.
    this.signInShutdown = setTimeout(
      () => this.stop().catch(() => {}),
      state === "signed_in" ? 5_000 : 15_000,
    ).unref();
  }

  async stop() {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.closing = true;
    clearInterval(this.idleTimer);
    clearTimeout(this.signInShutdown);
    this.stopPromise = (async () => {
      // Persistent Chromium may wait for downloads before closing. Cancel
      // transfers first; if close stalls, terminate it before draining writers.
      await Promise.race([
        Promise.allSettled([...this.activeDownloads].map((download) => download.cancel())),
        sleep(1000),
      ]);
      // A force-killed browser can leave CDP detach unanswered. Teardown must
      // still finish and release the owner's other resources.
      await Promise.race([this.downloadCDP?.detach().catch(() => {}), sleep(1000)]);
      if (this.releasePrivate) await this.releasePrivate();
      else {
        if (this.context !== undefined)
          await Promise.race([this.context.close().catch(() => undefined), sleep(5_000)]);
        killRecordedBrowserProcesses(this.browserProcesses);
      }
      await Promise.allSettled(this.downloadTasks);
      fs.rmSync(path.join(this.root, "runtime.json"), { force: true });
      this.onStopped();
    })();
    return this.stopPromise;
  }
}

function profileStorageError(message, profile, bytes, maximumBytes) {
  return new BrowserError("profile_storage_exceeded", message, {
    profile,
    bytes,
    maximumBytes,
  });
}

function ownerStorageError(owner, bytes, maximum) {
  return new BrowserError(
    "owner_storage_exceeded",
    "browser owner storage exceeds the maximum size",
    {
      owner,
      current: bytes,
      maximum,
    },
  );
}

function pageCapacityError(profile) {
  return new BrowserError("page_capacity_exceeded", "profile page capacity is exhausted", {
    profile,
    maximumPages: MAX_PAGES,
  });
}

function safeFilename(value) {
  const basename = value
    .split(/[\\/]/)
    .at(-1)
    .normalize("NFC")
    .replaceAll("\0", "")
    .replace(/[\u0001-\u001f\u007f]/g, "")
    .trim()
    .replace(/[ .]+$/g, "");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const usable =
    basename.length === 0 || basename === "." || basename === ".." || reserved.test(basename)
      ? "download"
      : basename;
  const bytes = Buffer.from(usable);
  if (bytes.length <= 180) {
    return usable;
  }
  const extension = path.extname(usable);
  const extensionBytes = Buffer.byteLength(extension) <= 32 ? Buffer.byteLength(extension) : 0;
  const prefix = bytes
    .subarray(0, 180 - extensionBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
  return `${prefix}${extensionBytes === 0 ? "" : extension}`;
}

function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

// Android has no /bin or /usr/bin; Termux installs procps under its prefix.
const PS = termuxPrefix ? path.join(termuxPrefix, "bin", "ps") : "/bin/ps";
const PGREP = termuxPrefix ? path.join(termuxPrefix, "bin", "pgrep") : "/usr/bin/pgrep";

/**
 * Runs a short PowerShell script and returns its trimmed output, or null when it fails. A cold
 * PowerShell start alone can take a few seconds on a busy machine, so the timeout is generous.
 */
function powershell(script, maxBuffer = 16 * 1024) {
  // UTF-8 output, so paths outside the console's code page read back intact.
  const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer,
      windowsHide: true,
    },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

/** PowerShell that binds `$p` to the Win32_Process for `pid`, exiting 1 when there is none. */
function win32Process(pid) {
  return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if (-not $p) { exit 1 }`;
}

function processExecutable(pid) {
  if (process.platform === "win32") {
    return powershell(`${win32Process(pid)}; $p.ExecutablePath`) || null;
  }
  const result = spawnSync(PS, ["-p", String(pid), "-o", "comm="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sameExecutable(pid, expected) {
  const actual = processExecutable(pid);
  if (actual === null) return false;
  if (process.platform === "win32") return actual.toLowerCase() === expected.toLowerCase();
  try {
    return fs.realpathSync(actual) === fs.realpathSync(expected);
  } catch {
    return actual === expected;
  }
}

/**
 * A process's start time and executable, recorded so a later cleanup can tell the browser it
 * started from an unrelated process that reused its PID. On Windows this must match what
 * Squire's server reads (`system_process` in browser.rs): Unix seconds, `|`, the executable path.
 */
function processIdentity(pid) {
  if (process.platform === "win32") {
    return (
      powershell(
        `${win32Process(pid)}; "$([DateTimeOffset]::new($p.CreationDate).ToUnixTimeSeconds())|$($p.ExecutablePath)"`,
      ) || null
    );
  }
  const result = spawnSync(PS, ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function directChildPids(pid) {
  if (process.platform === "win32") {
    const output = powershell(
      `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(pid)}' | Select-Object -ExpandProperty ProcessId) -join [Environment]::NewLine`,
      64 * 1024,
    );
    if (!output) return [];
    return output
      .split(/\s+/)
      .map(Number)
      .filter((child) => Number.isSafeInteger(child) && child > 0);
  }
  const result = spawnSync(PGREP, ["-P", String(pid)], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout.trim().split(/\s+/).map(Number).filter(Number.isSafeInteger);
}

function descendantPids(pid) {
  return directChildPids(pid).flatMap((child) => [...descendantPids(child), child]);
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function signalProcessTree(pid, signal) {
  for (const child of descendantPids(pid)) signalProcess(child, signal);
  signalProcess(pid, signal);
}

function requireProfile(profile) {
  const request = REQUEST_CONTEXT.getStore();
  if (request?.sharedSession?.private) {
    const metadata = SUPERVISOR_PROFILES.get(profileRoot(profile))?.daemon?.metadata;
    if (metadata) return metadata;
    throw new BrowserError("profile_not_running", "Private context is no longer running.");
  }
  const metadata = readJson(path.join(profileRoot(profile), "profile.json"), null);
  if (metadata === null) {
    throw new BrowserError(
      "profile_not_found",
      "browser profile does not exist; use browser.create_profile first",
      { profile },
    );
  }
  if (metadata.profile !== profile) {
    throw new BrowserError(
      "profile_name_alias",
      "profile name aliases an existing profile with different casing or filesystem spelling",
      { profile, existingProfile: metadata.profile },
    );
  }
  if (metadata.schemaVersion > 1) {
    throw new BrowserError(
      "profile_schema_unsupported",
      "profile schema is newer than this plugin",
      {
        profile,
        schemaVersion: metadata.schemaVersion,
        maximumSupportedVersion: 1,
      },
    );
  }
  if (
    metadata.viewport === null ||
    typeof metadata.viewport !== "object" ||
    !Number.isInteger(metadata.viewport.width) ||
    !Number.isInteger(metadata.viewport.height)
  ) {
    throw new BrowserError(
      "profile_schema_unsupported",
      "profile viewport is missing or malformed",
      {
        profile,
      },
    );
  }
  return metadata;
}

function validateProfileStoragePath(profile) {
  const root = profileRoot(profile);
  if (!fs.existsSync(root)) return root;
  const profilesRoot = fs.realpathSync(path.dirname(root));
  const canonicalRoot = fs.realpathSync(root);
  if (
    fs.lstatSync(root).isSymbolicLink() ||
    !canonicalRoot.startsWith(`${profilesRoot}${path.sep}`)
  ) {
    throw invalid("profile", "profile storage path is not contained");
  }
  return canonicalRoot;
}

async function createProfile(profile, args, hostDeadline) {
  return withProfileLock(profile, hostDeadline, async () => {
    const root = validateProfileStoragePath(profile);
    const metadataFile = path.join(root, "profile.json");
    if (readJson(metadataFile, null) !== null) {
      throw new BrowserError("profile_exists", "browser profile already exists", { profile });
    }
    const requestedBrowser = choiceArg({ browser: args.browser ?? "auto" }, "browser", [
      "auto",
      ...FAMILIES,
    ]);
    // A window by default only where one can open (Termux has no display).
    const headless = booleanArg(args, "headless", !graphicalHost());
    const width = boundedIntegerArg(args, "width", DEFAULT_VIEWPORT_WIDTH, 320, 3840);
    const height = boundedIntegerArg(args, "height", DEFAULT_VIEWPORT_HEIGHT, 240, 2160);
    const browser = args.executable
      ? await selectExecutable(args.executable, hostDeadline)
      : await selectBrowser(requestedBrowser, hostDeadline);
    if (args.executable && requestedBrowser !== "auto" && browser.family !== requestedBrowser)
      throw invalid("executable", "does not belong to the requested browser family");
    const metadata = {
      schemaVersion: 1,
      profile,
      ...(args.executable ? { executable: args.executable } : {}),
      browser,
      playwrightVersion: PLAYWRIGHT_VERSION,
      headless,
      viewport: { width, height },
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };
    writeJson(metadataFile, metadata);
    return {
      profile,
      created: true,
      browserFamily: browser.family,
      browserVersion: browser.version,
      headless,
      width,
      height,
    };
  });
}

async function prepareExistingProfile(profile, hostDeadline, profileStorageLimit) {
  const root = validateProfileStoragePath(profile);
  const metadataFile = path.join(root, "profile.json");
  const existing = requireProfile(profile);
  // The browser is closed here, so caches that have outgrown their budget can go.
  trimBrowserCaches(root);
  const profileBytes = profileStorageBytes(root);
  if (profileBytes > profileStorageLimit) {
    throw profileStorageError(
      "profile storage exceeds the maximum size",
      profile,
      profileBytes,
      profileStorageLimit,
    );
  }
  let current = discoverBrowsers().find(
    (browser) =>
      browser.family === existing.browser.family &&
      browser.canonicalPath === existing.browser.canonicalPath,
  );
  if (current === undefined) {
    throw new BrowserError(
      "profile_browser_missing",
      "the profile browser is no longer installed",
      {
        profile,
        family: existing.browser.family,
        lastExecutablePath: existing.browser.canonicalPath,
      },
    );
  }
  if (existing.executable) current = { ...current, launchStrategy: "executable-path" };
  if (
    JSON.stringify(current.identity) !== JSON.stringify(existing.browser.identity) ||
    current.version !== existing.browser.version ||
    current.launchStrategy !== existing.browser.launchStrategy ||
    current.playwrightChannel !== existing.browser.playwrightChannel
  ) {
    try {
      await probeBrowser(current, hostDeadline);
    } catch (error) {
      throw new BrowserError(
        "browser_incompatible",
        "the updated profile browser failed its capability probe",
        {
          family: current.family,
          previousVersion: existing.browser.version,
          currentVersion: current.version,
          playwrightVersion: PLAYWRIGHT_VERSION,
          failureStage: error.details?.failureStage ?? "capability_probe",
        },
      );
    }
    existing.browser = current;
    writeJson(metadataFile, existing);
  }
  return existing;
}

function touchProfile(root) {
  const file = path.join(root, "profile.json");
  const metadata = readJson(file, null);
  if (metadata !== null) {
    metadata.lastUsed = new Date().toISOString();
    writeJson(file, metadata);
  }
}

function listDownloads(profile) {
  const root = profileRoot(profile);
  return { profile, downloads: readJson(path.join(root, "downloads.json"), []) };
}

function listScreenshots(profile) {
  return {
    profile,
    screenshots: readJson(path.join(profileRoot(profile), "screenshots.json"), []),
  };
}

function canonicalFile(file) {
  return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
}

function screenshotRecord(profile, id) {
  if (!SCREENSHOT_PATTERN.test(id ?? "")) {
    throw invalid("id", "must be a screenshot id returned by screenshot actions");
  }
  const root = profileRoot(profile);
  const screenshots = readJson(path.join(root, "screenshots.json"), []);
  const record = screenshots.find((item) => item.id === id);
  if (record === undefined) {
    throw new BrowserError("screenshot_not_found", "screenshot does not exist", {
      screenshotId: id,
    });
  }
  return { root, screenshots, record };
}

function screenshotById(profile, id) {
  const { root, screenshots, record } = screenshotRecord(profile, id);
  try {
    const screenshotsRoot = fs.realpathSync(path.join(root, "screenshots"));
    const source = fs.realpathSync(path.join(screenshotsRoot, record.filename));
    if (!source.startsWith(`${screenshotsRoot}${path.sep}`)) {
      throw new BrowserError(
        "screenshot_source_invalid",
        "private screenshot source escaped its profile",
        {
          screenshotId: id,
        },
      );
    }
    return { root, record, source, screenshots };
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    if (error.code === "ENOENT") {
      throw new BrowserError("screenshot_source_missing", "private screenshot file is missing", {
        screenshotId: id,
      });
    }
    throw error;
  }
}

async function exportScreenshot(profile, args, deadline = Date.now() + 30_000) {
  return withProfileLock(profile, deadline, async () => {
    requireProfile(profile);
    const id = stringArg(args, "id", undefined, { allowEmpty: false });
    const destination = stringArg(args, "destination", undefined, { allowEmpty: false });
    if (!path.isAbsolute(destination))
      throw invalid("destination", "must be an absolute file path");
    if (/[\\/]$/.test(destination)) {
      throw invalid("destination", "must include the destination filename, not only a directory");
    }
    const parent = fs.statSync(path.dirname(destination), { throwIfNoEntry: false });
    if (parent === undefined || !parent.isDirectory()) {
      throw invalid("destination", "parent directory must already exist");
    }
    const canonicalDestination = canonicalFile(destination);
    if (fs.existsSync(canonicalDestination)) {
      throw new BrowserError(
        "screenshot_destination_exists",
        "screenshot destination already exists",
        {
          screenshotId: id,
          destination: canonicalDestination,
        },
      );
    }
    const { source, record } = screenshotById(profile, id);
    const temporary = path.join(
      path.dirname(canonicalDestination),
      `.${path.basename(canonicalDestination)}.${crypto.randomBytes(8).toString("hex")}.partial`,
    );
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      if (
        fs.statSync(temporary).size !== record.bytes ||
        fileSha256(temporary) !== fileSha256(source)
      ) {
        throw new Error("exported screenshot content did not match private source");
      }
      try {
        fs.linkSync(temporary, canonicalDestination);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new BrowserError(
            "screenshot_destination_exists",
            "screenshot destination already exists",
            {
              screenshotId: id,
              destination: canonicalDestination,
            },
          );
        }
        throw error;
      }
      fs.unlinkSync(temporary);
      return { profile, screenshotId: id, destination: canonicalDestination };
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  });
}

async function deleteScreenshot(profile, args, deadline = Date.now() + 30_000) {
  return withProfileLock(profile, deadline, async () => {
    requireProfile(profile);
    return withOwnedLock(
      stateLockFile(profileRoot(profile), "screenshots"),
      deadline,
      profile,
      "screenshot metadata",
      async () => {
        const id = stringArg(args, "id", undefined, { allowEmpty: false });
        const { root, screenshots, record } = screenshotRecord(profile, id);
        const screenshotsRoot = fs.realpathSync(path.join(root, "screenshots"));
        const candidate = path.join(screenshotsRoot, record.filename);
        let source = null;
        try {
          source = fs.realpathSync(candidate);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (source !== null && !source.startsWith(`${screenshotsRoot}${path.sep}`)) {
          throw new BrowserError(
            "screenshot_source_invalid",
            "private screenshot source escaped its profile",
            {
              screenshotId: id,
            },
          );
        }
        if (source !== null) fs.rmSync(source, { force: true });
        writeJson(
          path.join(root, "screenshots.json"),
          screenshots.filter((item) => item.id !== record.id),
        );
        return { profile, screenshotId: id, deleted: true };
      },
    );
  });
}

function resetDownloadMove(record, downloadsFile, downloads) {
  record.state = "complete";
  for (const key of ["destination", "moveBytes", "moveSha256"]) delete record[key];
  writeJson(downloadsFile, downloads);
}

function downloadMoveError(id, message, failureStage, destination, destinationCommitted = false) {
  return new BrowserError("download_move_failed", message, {
    downloadId: id,
    failureStage,
    destination,
    destinationCommitted,
  });
}

function downloadDestinationExists(id, destination, suffix = "") {
  return new BrowserError(
    "download_destination_exists",
    `download destination already exists${suffix}`,
    {
      downloadId: id,
      destination,
    },
  );
}

function movedDownload(profile, id, destination) {
  return { profile, downloadId: id, destination, state: "moved" };
}

function moveDownloadLocked(profile, args) {
  const id = args.id;
  const destination = args.destination;
  if (!/^d(?:[0-9]+|[a-f0-9]{32})$/.test(id ?? "")) {
    throw invalid("id", "must be a download ID returned by list_downloads");
  }
  if (typeof destination !== "string" || destination.length === 0) {
    throw invalid("destination", "is required");
  }
  if (!path.isAbsolute(destination)) {
    throw invalid("destination", "must be an absolute file path");
  }
  if (/[\\/]$/.test(destination)) {
    throw invalid("destination", "must include the destination filename, not only a directory");
  }
  const destinationParent = path.dirname(destination);
  const parentStat = fs.statSync(destinationParent, { throwIfNoEntry: false });
  if (parentStat === undefined || !parentStat.isDirectory()) {
    throw invalid("destination", "parent directory must already exist");
  }
  const requestedDestination = canonicalFile(destination);

  const root = profileRoot(profile);
  const downloadsFile = path.join(root, "downloads.json");
  const downloads = readJson(downloadsFile, []);
  const record = downloads.find((download) => download.id === id);
  if (record === undefined) {
    throw invalid("id", `unknown download ${id}`);
  }
  const downloadsRoot = fs.realpathSync(path.join(root, "downloads"));
  const sourcePath = path.join(downloadsRoot, record.filename);

  const resolveSource = () => {
    try {
      const source = fs.realpathSync(sourcePath);
      if (!source.startsWith(`${downloadsRoot}${path.sep}`)) {
        throw new Error("private download source escaped its profile");
      }
      return source;
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw downloadMoveError(
        id,
        `private download source is unavailable: ${error.message}`,
        "source_validation",
        record.destination ?? destination,
        record.state === "moved",
      );
    }
  };

  if (record.state === "moved") {
    if (requestedDestination !== record.destination) {
      throw invalid("destination", `download was already moved to ${record.destination}`);
    }
    if (record.cleanupPending === true) {
      const source = resolveSource();
      if (source !== null) {
        try {
          fs.unlinkSync(source);
        } catch (error) {
          throw downloadMoveError(
            id,
            `download source cleanup failed: ${error.message}`,
            "source_cleanup",
            record.destination,
            true,
          );
        }
      }
      record.cleanupPending = false;
      writeJson(downloadsFile, downloads);
    }
    return movedDownload(profile, id, record.destination);
  }

  if (record.state !== "complete" && record.state !== "moving") {
    throw new BrowserError("download_not_ready", "download is not complete", {
      downloadId: id,
      state: record.state,
    });
  }

  let canonicalDestination;
  if (record.state === "moving") {
    canonicalDestination = record.destination;
    if (requestedDestination !== canonicalDestination) {
      throw invalid("destination", "must match the in-progress download move destination");
    }
  } else {
    canonicalDestination = canonicalFile(destination);
    if (fs.existsSync(canonicalDestination)) {
      throw downloadDestinationExists(id, canonicalDestination);
    }
    const source = resolveSource();
    if (source === null) {
      throw downloadMoveError(
        id,
        "private download source is unavailable",
        "source_validation",
        canonicalDestination,
      );
    }
    record.state = "moving";
    record.destination = canonicalDestination;
    record.moveBytes = fs.statSync(source).size;
    record.moveSha256 = fileSha256(source);
    writeJson(downloadsFile, downloads);
  }

  let source = resolveSource();
  let committed = fs.existsSync(canonicalDestination);
  if (committed) {
    const destinationMatches =
      fs.statSync(canonicalDestination).size === record.moveBytes &&
      fileSha256(canonicalDestination) === record.moveSha256;
    if (!destinationMatches) {
      if (source !== null && record.state === "moving")
        resetDownloadMove(record, downloadsFile, downloads);
      throw downloadDestinationExists(id, canonicalDestination, " with different content");
    }
  } else if (source === null) {
    throw downloadMoveError(
      id,
      "private download source is unavailable",
      "source_validation",
      canonicalDestination,
    );
  }

  const temporary = path.join(
    path.dirname(canonicalDestination),
    `.${path.basename(canonicalDestination)}.${crypto.randomBytes(8).toString("hex")}.partial`,
  );
  try {
    if (!committed) {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      const temporaryMatches =
        fs.statSync(temporary).size === record.moveBytes &&
        fileSha256(temporary) === record.moveSha256;
      if (!temporaryMatches) {
        throw new Error("copied download content did not match source");
      }
      try {
        fs.linkSync(temporary, canonicalDestination);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw downloadDestinationExists(id, canonicalDestination);
        }
        throw error;
      }
      committed = true;
      fs.unlinkSync(temporary);
    }

    record.state = "moved";
    record.cleanupPending = source !== null;
    delete record.moveBytes;
    delete record.moveSha256;
    writeJson(downloadsFile, downloads);

    if (source !== null) {
      try {
        fs.unlinkSync(source);
        source = null;
        record.cleanupPending = false;
        writeJson(downloadsFile, downloads);
      } catch (error) {
        throw downloadMoveError(
          id,
          `download source cleanup failed: ${error.message}`,
          "source_cleanup",
          canonicalDestination,
          true,
        );
      }
    }
    return movedDownload(profile, id, canonicalDestination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!committed && record.state === "moving")
      resetDownloadMove(record, downloadsFile, downloads);
    if (error instanceof BrowserError) throw error;
    throw downloadMoveError(
      id,
      `download move failed: ${error.message}`,
      committed ? "source_cleanup" : "destination_commit",
      canonicalDestination,
      committed,
    );
  }
}

async function moveDownload(profile, args, deadline = Date.now() + 30_000) {
  return withProfileLock(profile, deadline, async () => {
    requireProfile(profile);
    return withOwnedLock(
      stateLockFile(profileRoot(profile), "downloads"),
      deadline,
      profile,
      "download metadata",
      async () => moveDownloadLocked(profile, args),
    );
  });
}

const SUPERVISOR_PROFILES = new Map();
const SUPERVISOR_REQUESTS = new Map();
let SUPERVISOR_LIFECYCLE = Promise.resolve();

function supervisorLifecycle(run) {
  const task = SUPERVISOR_LIFECYCLE.then(run, run);
  SUPERVISOR_LIFECYCLE = task.catch(() => undefined);
  return task;
}

function supervisorBarrier(entry, run) {
  const dependencies = [entry.barrier, ...entry.pageTails.values()].map((task) =>
    task.catch(() => undefined),
  );
  const task = Promise.all(dependencies).then(run);
  entry.barrier = task.catch(() => undefined);
  return task;
}

function supervisorPage(entry, page, run) {
  const queued = entry.pageQueued.get(page) ?? 0;
  if (queued >= MAX_QUEUE) {
    throw new BrowserError("daemon_busy", "page operation queue is full", {
      profile: entry.profile,
      page,
      queued,
      maximumQueued: MAX_QUEUE,
    });
  }
  entry.pageQueued.set(page, queued + 1);
  const previous = entry.pageTails.get(page) ?? Promise.resolve();
  const task = Promise.all([
    entry.barrier.catch(() => undefined),
    previous.catch(() => undefined),
  ]).then(run);
  const settled = task.catch(() => undefined);
  entry.pageTails.set(page, settled);
  return task.finally(() => {
    const remaining = (entry.pageQueued.get(page) ?? 1) - 1;
    if (remaining <= 0) entry.pageQueued.delete(page);
    else entry.pageQueued.set(page, remaining);
    if (entry.pageTails.get(page) === settled) entry.pageTails.delete(page);
  });
}

function ensureSupervisorRequestActive(request) {
  if (SUPERVISOR_REQUESTS.get(request.id)?.cancelled) {
    throw new BrowserError("invocation_cancelled", "invocation cancelled");
  }
}

async function supervisorTracked(request, entry, run) {
  const control = SUPERVISOR_REQUESTS.get(request.id);
  if (control?.cancelled) {
    throw new BrowserError("invocation_cancelled", "invocation cancelled");
  }
  if (entry?.removed === true) {
    throw new BrowserError("profile_closing", "profile is closing", { profile: entry.profile });
  }
  if (entry?.daemon !== undefined) entry.daemon.externalOperations += 1;
  if (control !== undefined) {
    control.phase = "active";
    control.entry = entry;
    control.startedAt = Date.now();
  }
  let outcome = "failed";
  try {
    const result = await run();
    outcome = "ok";
    return result;
  } finally {
    if (control?.cancelled && entry !== undefined) {
      entry.abandonedOperation = {
        action: request.action,
        startedAt: new Date(control.startedAt).toISOString(),
        outcome,
      };
    }
    if (entry?.daemon !== undefined)
      entry.daemon.externalOperations = Math.max(0, entry.daemon.externalOperations - 1);
    if (control !== undefined) control.phase = "done";
  }
}

function supervisorCancel(id) {
  const control = SUPERVISOR_REQUESTS.get(id);
  if (control === undefined) return;
  control.cancelled = true;
  if (control.phase === "active" && control.entry !== undefined) {
    control.entry.abandonedOperation = {
      action: control.action,
      startedAt: new Date(control.startedAt).toISOString(),
      outcome: "in_progress",
    };
  }
}

function supervisorOwnerRunning(owner) {
  return [...SUPERVISOR_PROFILES.values()].filter((entry) => entry.owner === owner).length;
}

function supervisorOwnerStorage(request) {
  return ownerStorageBytes(request.ownerDir);
}

function supervisorProfileDirectoryCount(request) {
  try {
    return fs
      .readdirSync(path.join(request.ownerDir, "profiles"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          PROFILE_PATTERN.test(entry.name) &&
          entry.name !== "." &&
          entry.name !== "..",
      ).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function supervisorCreateProfile(request) {
  return supervisorLifecycle(async () => {
    ensureSupervisorRequestActive(request);
    const limits = request.limits;
    const current = supervisorProfileDirectoryCount(request);
    if (current >= limits.maxProfilesPerOwner) {
      throw new BrowserError("owner_profile_limit_exceeded", "browser profile limit is exhausted", {
        owner: request.owner,
        current,
        maximum: limits.maxProfilesPerOwner,
      });
    }
    const bytes = supervisorOwnerStorage(request);
    if (bytes >= limits.ownerStorageBytes) {
      throw new BrowserError("owner_storage_exceeded", "browser owner storage limit is exhausted", {
        owner: request.owner,
        current: bytes,
        maximum: limits.ownerStorageBytes,
      });
    }
    return createProfile(request.profile, request.args, Date.now() + 30_000);
  });
}

async function supervisorStartProfile(request) {
  return supervisorLifecycle(async () => {
    ensureSupervisorRequestActive(request);
    const key = request.profileDir;
    const existing = SUPERVISOR_PROFILES.get(key);
    const requestedHeadless =
      request.args.headless === "auto" ? !graphicalHost() : request.args.headless;
    if (existing !== undefined && existing.daemon !== undefined && !existing.daemon.closing) {
      const view = existing.viewSession;
      let page = view
        ? [...existing.daemon.pages].find(([, value]) =>
            sharedBrowser.tabs.pages.get(value)?.scopes.has(request.scope),
          )?.[0]
        : existing.daemon.pages.keys().next().value;
      if (page === undefined && !request.sharedSession) {
        const created = await existing.daemon.context.newPage();
        page = existing.daemon.pageIds.get(created) ?? existing.daemon.registerPage(created);
        // A new conversation gets its own viewable page. Registering at
        // context-level creation would leak it to an unrelated prior scope.
        if (view) view.observe(created, undefined, undefined, request.scope);
      }
      return {
        page,
        headless: existing.headless,
        headlessApplied: requestedHeadless === undefined || requestedHeadless === existing.headless,
        abandonedOperation: existing.abandonedOperation,
      };
    }

    const limits = request.limits;
    const ownerRunning = supervisorOwnerRunning(request.owner);
    const maximumRunning = request.sharedSession
      ? MAX_SHARED_CONTEXTS
      : limits.maxRunningProfilesPerOwner;
    if (ownerRunning >= maximumRunning) {
      throw new BrowserError(
        "owner_running_limit_exceeded",
        "browser owner running-profile limit is exhausted",
        {
          owner: request.owner,
          running: ownerRunning,
          maximum: maximumRunning,
        },
      );
    }
    const active = SUPERVISOR_PROFILES.size;
    if (active >= limits.maxActiveProfiles) {
      throw new BrowserError("profile_capacity_exceeded", "browser profile capacity is exhausted", {
        activeProfiles: active,
        maximumActiveProfiles: limits.maxActiveProfiles,
      });
    }

    return withProfileLock(request.profile, Date.now() + 30_000, async () => {
      const persisted = request.sharedSession?.private
        ? {
            browser: await selectExecutable(request.sharedSession.executable, Date.now() + 30_000),
            headless: request.sharedSession.headless,
            viewport: { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT },
          }
        : await prepareExistingProfile(
            request.profile,
            Date.now() + 30_000,
            request.limits.profileStorageBytes,
          );
      ensureSupervisorRequestActive(request);
      const headless = booleanArg({ headless: requestedHeadless }, "headless", persisted.headless);
      // Fail with the reason, not Chromium's launch error, when no window can open.
      if (!headless && !graphicalHost())
        throw new BrowserError("window_unavailable", NO_WINDOW_MESSAGE);
      const runtimeMetadata = { ...persisted, headless };
      // Browser roots are direct children of the supervisor. Recording the
      // whole descendant tree here can accidentally capture renderer or lock-
      // helper processes belonging to another concurrently active profile.
      const before = new Set(directChildPids(process.pid));
      const entry = {
        owner: request.owner,
        profile: request.profile,
        key,
        daemon: undefined,
        headless,
        pageTails: new Map(),
        pageQueued: new Map(),
        barrier: Promise.resolve(),
        abandonedOperation: undefined,
        browserProcesses: [],
        removed: false,
      };
      const viewSession =
        request.sharedSession ??
        sharedBrowser.profileView(request, new BrowserRuntime({ root: key }));
      viewSession.headless = headless;
      entry.viewSession = request.sharedSession ? undefined : viewSession;
      const daemon = new ProfileDaemon(
        request.owner,
        request.profile,
        request.profileDir,
        runtimeMetadata,
        request.limits,
        () => {
          if (SUPERVISOR_PROFILES.get(key) === entry) SUPERVISOR_PROFILES.delete(key);
          viewSession.closed();
          supervisorWrite({
            event: "profile_stopped",
            owner: request.owner,
            profile: request.profile,
          });
        },
        request.sharedSession,
        request.sharedSession ? undefined : viewSession,
      );
      entry.daemon = daemon;
      SUPERVISOR_PROFILES.set(key, entry);
      try {
        await daemon.start();
        entry.browserProcesses = request.sharedSession?.private
          ? daemon.browserProcesses
          : recordNewBrowserProcesses(before);
        daemon.browserProcesses = entry.browserProcesses;
        if (entry.browserProcesses.length === 0) {
          await daemon.stop();
          throw new BrowserError(
            "browser_process_identity_unavailable",
            "browser started but its process identity could not be recorded safely",
            { profile: request.profile },
          );
        }
        supervisorWrite({
          event: "profile_started",
          owner: request.owner,
          profile: request.profile,
          processes: entry.browserProcesses,
        });
      } catch (error) {
        SUPERVISOR_PROFILES.delete(key);
        await daemon.stop().catch(() => undefined);
        throw error;
      }
      const page = daemon.pages.keys().next().value;
      if (entry.viewSession && page !== undefined)
        entry.viewSession.observe(daemon.pages.get(page), undefined, undefined, request.scope);
      return {
        page,
        headless,
        headlessApplied: true,
        abandonedOperation: entry.abandonedOperation,
      };
    });
  });
}

async function supervisorStopProfile(request, deleting = false) {
  return supervisorLifecycle(async () => {
    ensureSupervisorRequestActive(request);
    return withProfileLock(request.profile, Date.now() + 30_000, async () => {
      requireProfile(request.profile);
      const key = request.profileDir;
      const entry = SUPERVISOR_PROFILES.get(key);
      if (entry !== undefined) {
        await supervisorBarrier(entry, async () => {
          entry.removed = true;
          await entry.daemon.stop();
        });
        SUPERVISOR_PROFILES.delete(key);
      }
      if (deleting) {
        fs.rmSync(request.profileDir, { recursive: true, force: true });
        return { profile: request.profile, deleted: true };
      }
      touchProfile(request.profileDir);
      return { profile: request.profile, stopped: true };
    });
  });
}

async function supervisorListProfiles(request) {
  const profilesRoot = path.join(request.ownerDir, "profiles");
  const profiles = [];
  try {
    for (const profile of fs.readdirSync(profilesRoot).sort()) {
      if (!PROFILE_PATTERN.test(profile) || profile === "." || profile === "..") continue;
      const root = path.join(profilesRoot, profile);
      const metadata = readJson(path.join(root, "profile.json"), null);
      if (metadata === null) continue;
      const entry = SUPERVISOR_PROFILES.get(root);
      if (
        metadata.viewport === null ||
        typeof metadata.viewport !== "object" ||
        !Number.isInteger(metadata.viewport.width) ||
        !Number.isInteger(metadata.viewport.height)
      ) {
        continue;
      }
      profiles.push({
        profile,
        state: entry === undefined || entry.daemon?.closing ? "idle" : "running",
        browserFamily: metadata.browser.family,
        browserVersion: metadata.browser.version,
        headless: entry?.headless ?? metadata.headless,
        width: metadata.viewport.width,
        height: metadata.viewport.height,
        pages: entry?.daemon?.pages.size ?? 0,
        bytes: directoryBytes(root),
        lastUsed: metadata.lastUsed,
        abandonedOperation: entry?.abandonedOperation,
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { profiles };
}

async function supervisorExecuteRunning(request) {
  const entry = SUPERVISOR_PROFILES.get(request.profileDir);
  if (entry === undefined || entry.daemon === undefined || entry.daemon.closing) {
    throw new BrowserError(
      "profile_not_running",
      "browser profile is not running; use browser.start_profile before page actions",
      { profile: request.profile },
    );
  }
  const timeoutMs = boundedIntegerArg(
    request.args,
    "timeout_ms",
    DEFAULT_OPERATION_TIMEOUT_MS,
    1,
    LONG_OPERATION_ACTIONS.has(request.action)
      ? LONG_OPERATION_TIMEOUT_MAX_MS
      : OPERATION_TIMEOUT_MAX_MS,
  );
  const execute = async () => {
    const pageId = request.args.page;
    if (pageId && entry.pendingActions?.has(pageId) && request.action !== "close_tab") {
      throw new BrowserError(
        "operation_in_progress",
        "The previous timed-out action is still running in this tab. Wait for it to finish or close the tab explicitly.",
        { profile: request.profile, page: pageId },
      );
    }
    const result = await supervisorTracked(request, entry, async () => {
      try {
        if (typeof request.args.page === "string")
          await entry.daemon.trackDownloadFrames(entry.daemon.page(request.args.page)[1]);
        const running = entry.daemon.execute({
          action: request.action,
          args: request.args,
          timeoutMs,
          owner: request.owner,
          invocationAction: request.invocationAction,
          pluginName: request.pluginName,
          pluginIcon: request.pluginIcon,
          scope: request.scope,
        });
        const watchdogError = new BrowserError(
          "operation_timeout",
          "browser action exceeded its watchdog deadline",
          { profile: request.profile, action: request.action, timeoutMs, stillRunning: true },
        );
        try {
          return await Promise.race([
            running,
            rejectAfter(timeoutMs + OPERATION_WATCHDOG_GRACE_MS, watchdogError),
          ]);
        } catch (error) {
          if (error === watchdogError && pageId !== undefined) {
            // A Playwright operation can outlive the watchdog. Keep the tab,
            // but don't allow another action to race the unfinished mutation.
            const pending = running.then(
              () => undefined,
              () => undefined,
            );
            entry.pendingActions ??= new Map();
            entry.pendingActions.set(pageId, pending);
            pending.then(() => {
              if (entry.pendingActions?.get(pageId) === pending)
                entry.pendingActions.delete(pageId);
            });
          }
          throw error;
        }
      } catch (error) {
        const pageId = typeof request.args.page === "string" ? request.args.page : undefined;
        const page = pageId === undefined ? undefined : entry.daemon.pages.get(pageId);
        const normalized = normalizeOperationError(
          error,
          request.profile,
          request.action,
          timeoutMs,
          pageId !== undefined && (page === undefined || page.isClosed()),
        );
        // Ordinary Playwright timeouts have already cancelled the action.
        // A watchdog timeout leaves the tab alive and prevents further actions
        // on that tab until the outstanding operation settles.
        throw normalized;
      }
    });
    entry.daemon.lastUsed = Date.now();
    if (!entry.removed) touchProfile(request.profileDir);
    if (request.action.startsWith("screenshot_")) {
      const contentDir = request.stagingDir;
      if (typeof contentDir !== "string" || contentDir.length === 0) {
        throw new BrowserError("browser_internal_error", "staging directory is required");
      }
      privateDirectory(contentDir);
      const screenshot = screenshotById(request.profile, result.screenshotId);
      const destination = path.join(contentDir, `${result.screenshotId}.png`);
      fs.copyFileSync(screenshot.source, destination, fs.constants.COPYFILE_EXCL);
      return {
        ...result,
        attachmentPath: destination,
        mimeType: screenshot.record.mimeType ?? "image/png",
      };
    }
    return result;
  };

  // Profile-level actions: they act on the whole browser context, not one tab.
  if (
    ["list_tabs", "new_tab", "export_cookies"].includes(request.action) ||
    (request.action === "resize" && !request.sharedSession)
  ) {
    return supervisorBarrier(entry, execute);
  }
  const page = request.args.page;
  if (typeof page !== "string") throw invalid("page", "is required");
  return supervisorPage(entry, page, execute);
}

async function supervisorStorageAction(request) {
  if (request.action === "list_downloads") {
    requireProfile(request.profile);
    return listDownloads(request.profile);
  }
  if (request.action === "move_download") {
    return moveDownload(request.profile, request.args, Date.now() + 30_000);
  }
  if (request.action === "list_screenshots") {
    requireProfile(request.profile);
    return listScreenshots(request.profile);
  }
  if (request.action === "export_screenshot") {
    return exportScreenshot(request.profile, request.args, Date.now() + 30_000);
  }
  if (request.action === "delete_screenshot") {
    return deleteScreenshot(request.profile, request.args, Date.now() + 30_000);
  }
  return undefined;
}

async function supervisorAction(request) {
  if (!SUPPORTED_ACTIONS.has(request.action)) {
    throw invalid("action", `unknown browser action ${request.action}`);
  }
  if (request.action === "list_profiles") return supervisorListProfiles(request);
  profileName({ profile: request.profile });
  if (request.action === "create_profile") return supervisorCreateProfile(request);
  if (request.action === "start_profile") return supervisorStartProfile(request);
  if (request.action === "stop_profile") return supervisorStopProfile(request, false);
  if (request.action === "delete_profile") return supervisorStopProfile(request, true);
  const storage = await supervisorStorageAction(request);
  if (storage !== undefined) return storage;
  return supervisorExecuteRunning(request);
}

function killRecordedBrowserProcesses(records) {
  for (const record of records ?? []) {
    if (record.identity === null || processIdentity(record.pid) !== record.identity) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], {
        timeout: 5_000,
        windowsHide: true,
      });
    } else {
      try {
        signalProcessTree(record.pid, "SIGKILL");
      } catch {}
    }
  }
}

async function supervisorHardKillEntry(entry) {
  entry.removed = true;
  if (!entry.daemon?.releasePrivate) killRecordedBrowserProcesses(entry.browserProcesses);
  if (entry.daemon !== undefined) await entry.daemon.stop().catch(() => undefined);
}

async function supervisorRemoveOwner(owner) {
  const controls = [...SUPERVISOR_REQUESTS.values()].filter((control) => control.owner === owner);
  for (const control of controls) {
    control.cancelled = true;
    if (control.phase === "active" && control.entry !== undefined) {
      control.entry.abandonedOperation = {
        action: control.action,
        startedAt: new Date(control.startedAt).toISOString(),
        outcome: "in_progress",
      };
    }
  }
  for (const [key, entry] of [...SUPERVISOR_PROFILES]) {
    if (entry.owner !== owner) continue;
    await supervisorHardKillEntry(entry);
    SUPERVISOR_PROFILES.delete(key);
  }
  await Promise.allSettled(controls.map((control) => control.task));
  // An operation that was starting a profile may have published it while
  // cancellation was draining. Discard those contexts before acknowledging.
  for (const [key, entry] of [...SUPERVISOR_PROFILES]) {
    if (entry.owner !== owner) continue;
    await supervisorHardKillEntry(entry);
    SUPERVISOR_PROFILES.delete(key);
  }
}

function supervisorWrite(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const MAX_SHARED_CONTEXTS = 4;

async function selectExecutable(executable, deadline) {
  const browser = discoverBrowsers().find(
    (item) => item.executablePath === executable || item.canonicalPath === executable,
  );
  if (!browser)
    throw new BrowserError("browser_not_found", "Choose an installed compatible browser.");
  const selected = { ...browser, launchStrategy: "executable-path" };
  await probeBrowser(selected, deadline);
  return selected;
}

function recordNewBrowserProcesses(before) {
  const lockHelper = process.env.SQUIRE_BROWSER_LOCK_HELPER;
  return directChildPids(process.pid)
    .filter((pid) => !before.has(pid) && (!lockHelper || !sameExecutable(pid, lockHelper)))
    .map((pid) => ({ pid, identity: processIdentity(pid) }))
    .filter((record) => typeof record.identity === "string");
}

const privateBrowsers = new (require("./browser-private.cjs").PrivateBrowsers)(async (metadata) => {
  const { chromium } = require("playwright-core");
  const before = new Set(directChildPids(process.pid));
  const browser = await chromium.launch(
    launchOptions(
      metadata.browser,
      metadata.headless,
      metadata.viewport,
      undefined,
      BROWSER_STARTUP_MS,
    ),
  );
  const processes = recordNewBrowserProcesses(before);
  if (!processes.length) {
    await browser.close();
    throw new BrowserError(
      "browser_process_identity_unavailable",
      "Browser process identity could not be verified.",
    );
  }
  return {
    browser,
    processes,
    close: async () => {
      await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
      killRecordedBrowserProcesses(processes);
    },
  };
});

class BrowserRuntime {
  constructor(session) {
    this.session = session;
  }
  request(request, action, args = {}) {
    return {
      ...request,
      kind: "action",
      shared: false,
      sharedSession: this.session,
      profile: this.session.profile,
      profileDir: this.session.root,
      action,
      args,
    };
  }
  entry() {
    return SUPERVISOR_PROFILES.get(this.session.root);
  }
  isOpen() {
    return Boolean(this.entry()?.daemon && !this.entry().daemon.closing);
  }
  firstPage() {
    return this.entry()?.daemon.pages.values().next().value;
  }
  async newTab(request, args, origin = "agent") {
    const result = await this.execute(request, "new_tab", { ...args, origin });
    return this.entry().daemon.page(result.page)[1];
  }
  execute(request, action, args, page) {
    if (page) args = { ...args, page: this.entry()?.daemon.pageIds.get(page) };
    const low = this.request(request, action, args);
    return REQUEST_CONTEXT.run(low, () => supervisorAction(low));
  }
  viewport() {
    return this.entry()?.daemon.currentViewport();
  }
  touch() {
    const daemon = this.entry()?.daemon;
    if (daemon) daemon.lastUsed = Date.now();
  }
  holdViewer() {
    const daemon = this.entry()?.daemon;
    if (!daemon) throw new Error("Browser runtime ended.");
    daemon.externalOperations++;
    return () => {
      daemon.externalOperations = Math.max(0, daemon.externalOperations - 1);
      daemon.lastUsed = Date.now();
    };
  }
  async close() {
    await this.entry()?.daemon.stop();
  }
}

let managedChromiumRefreshed = false;
const sharedBrowser = new (require("./browser-shared.cjs").SharedBrowser)({
  open: async (request, session) => {
    const runtime = new BrowserRuntime(session);
    if (!session.private && !fs.existsSync(path.join(session.root, "profile.json"))) {
      await runtime.execute(request, "create_profile", {
        headless: session.headless,
        executable: session.executable,
      });
    }
    await runtime.execute(request, "start_profile", { headless: session.headless });
    return runtime;
  },
  artifact: (request, session, action, args) =>
    new BrowserRuntime(session).execute(request, action, args),
  admit: ensureSupervisorRequestActive,
  canonical: canonicalSuccess,
  collection: (key, items, args) => boundedStructuredCollection({}, key, items, args),
  browsers: discoverBrowsers,
  label: browserLabel,
  graphical: graphicalHost,
  event: supervisorWrite,
  read: readJson,
  error: (code, message) => new BrowserError(code, message),
  write: writeJson,
});

async function supervisorMain() {
  // Detect installed browsers before serving, so no Settings read waits on it.
  try {
    sharedBrowser.browsers();
  } catch {
    // Detection failures surface on the requests that need a browser.
  }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (Number.isSafeInteger(request.cancel)) {
      supervisorCancel(request.cancel);
      return;
    }
    if (request.control === "remove_owner") {
      supervisorRemoveOwner(request.owner)
        .then(() =>
          supervisorWrite({ id: request.id, ok: true, output: { structuredContent: {} } }),
        )
        .catch((error) =>
          supervisorWrite({ id: request.id, ok: false, error: formatError(error) }),
        );
      return;
    }
    if (!Number.isSafeInteger(request.id)) return;
    if (request.kind === "viewer") {
      sharedBrowser.viewer
        .request(request)
        .then((output) =>
          supervisorWrite({ id: request.id, ok: true, output: { structuredContent: output } }),
        )
        .catch((error) =>
          supervisorWrite({
            id: request.id,
            ok: false,
            error:
              error?.code === "too_many_browser_viewers"
                ? error.code
                : "browser_viewer_unavailable",
          }),
        );
      return;
    }
    const control = {
      id: request.id,
      action: request.action,
      cancelled: false,
      owner: request.owner,
      phase: "queued",
      entry: undefined,
      startedAt: undefined,
    };
    SUPERVISOR_REQUESTS.set(request.id, control);
    const task = REQUEST_CONTEXT.run(request, async () => {
      try {
        if (control.cancelled)
          throw new BrowserError("invocation_cancelled", "invocation cancelled");
        if (request.kind !== undefined && !["action", "settings"].includes(request.kind))
          throw invalid("kind", "unknown browser request type");
        if (request.kind !== "settings" && !SUPPORTED_ACTIONS.has(request.action))
          throw invalid("action", "unknown browser action");
        let output;
        if (request.refreshBrowsers === true && !managedChromiumRefreshed) {
          sharedBrowser.browsers(true);
          managedChromiumRefreshed = true;
        }
        if (request.kind === "settings" || request.shared) {
          output = await sharedBrowser.invoke(request);
        } else {
          output = canonicalSuccess(request.action, await supervisorAction(request), request.args);
        }
        supervisorWrite({ id: request.id, ok: true, output });
      } catch (error) {
        supervisorWrite({
          id: request.id,
          ok: false,
          error:
            request.kind === "settings"
              ? { code: error.code ?? "browser_unavailable", message: error.message }
              : formatError(error),
          code: error.code ?? "browser_internal_error",
        });
      } finally {
        SUPERVISOR_REQUESTS.delete(request.id);
      }
    });
    control.task = task;
  });
  await new Promise((resolve) => lines.once("close", resolve));
  await sharedBrowser.shutdown();
  await Promise.allSettled([...SUPERVISOR_PROFILES.values()].map((entry) => entry.daemon.stop()));
}

async function main() {
  try {
    if (process.argv[2] !== "supervisor") {
      throw invalid("mode", "must be supervisor");
    }
    await supervisorMain();
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

main();
