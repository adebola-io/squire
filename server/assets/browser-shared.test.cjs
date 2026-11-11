"use strict";
// Which browser Browser sessions use, through the Settings actions people use to choose it.
// Run with: node --test server/assets/*.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { SharedBrowser } = require("./browser-shared.cjs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function setup(t) {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), "squire-browser-settings-"));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  const read = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const shared = new SharedBrowser({
    read,
    write,
    // Installed in this order, as discovery lists them: Chrome first.
    browsers: () => [
      { executablePath: CHROME, family: "chrome" },
      { executablePath: EDGE, family: "edge" },
    ],
    label: (browser) => browser.family,
    graphical: () => true,
    admit: () => {},
    error: (code, message) => Object.assign(new Error(message), { code }),
    event: () => {},
  });
  clearInterval(shared.timer);
  const profileFile = path.join(owner, "profiles", "authenticated", "profile.json");
  const settings = (action, args = {}) =>
    shared.settings({ kind: "settings", action, args, ownerDir: owner });
  return {
    settings,
    selected: async () => (await settings("read")).structuredContent.selected,
    createProfileWith: (executable) =>
      write(profileFile, { browser: { family: "edge", executablePath: executable } }),
    removeProfile: () => fs.rmSync(path.dirname(profileFile), { recursive: true, force: true }),
    profileExists: () => fs.existsSync(profileFile),
  };
}

test("a new install uses the first installed browser", async (t) => {
  const browser = setup(t);
  assert.equal(await browser.selected(), CHROME);
});

test("Settings shows the browser the saved-login profile really uses", async (t) => {
  const browser = setup(t);
  browser.createProfileWith(EDGE);
  assert.equal(await browser.selected(), EDGE);
});

test("choosing the browser already in use keeps the profile and saves the choice", async (t) => {
  const browser = setup(t);
  browser.createProfileWith(EDGE);
  await browser.settings("select", { executable: EDGE });
  assert.ok(browser.profileExists(), "no logins are cleared");
  browser.removeProfile();
  assert.equal(await browser.selected(), EDGE);
});

test("switching browsers asks first, then starts a fresh profile", async (t) => {
  const browser = setup(t);
  browser.createProfileWith(EDGE);
  await assert.rejects(browser.settings("select", { executable: CHROME }), {
    code: "confirmation_required",
  });
  assert.ok(browser.profileExists());
  await browser.settings("select", { executable: CHROME, confirm: true });
  assert.ok(!browser.profileExists());
  assert.equal(await browser.selected(), CHROME);
});
