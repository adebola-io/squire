"use strict";
// What browser storage counts against Squire's limits, and how caches stay bounded.
// Run with: node --test server/assets/*.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  ownerStorageBytes,
  profileStorageBytes,
  trimBrowserCaches,
} = require("./browser-storage.cjs");
const { launchOptions } = require("./browser-launch.cjs");

function owner(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squire-browser-storage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (relative, bytes) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes));
  };
  return { dir, write, profile: path.join(dir, "profiles", "authenticated") };
}

test("browser caches do not count, logins and site data do", (t) => {
  const { dir, write, profile } = owner(t);
  write("profiles/authenticated/browser-data/Default/Cookies", 100);
  write("profiles/authenticated/browser-data/Default/Local Storage/leveldb/000003.log", 20);
  write("profiles/authenticated/browser-data/Default/Cache/Cache_Data/data_1", 5000);
  write("profiles/authenticated/browser-data/Default/Code Cache/js/index", 3000);
  write("profiles/authenticated/browser-data/GraphiteDawnCache/data_0", 700);
  write("profiles/authenticated/download-staging/partial", 900);
  assert.equal(profileStorageBytes(profile), 120);
  // Staged downloads count toward the owner, which reserves room for them.
  assert.equal(ownerStorageBytes(dir), 1020);
});

test("a file or folder that only shares a cache's name still counts", (t) => {
  const { dir, write, profile } = owner(t);
  write("profiles/authenticated/downloads/Cache", 2048);
  write("profiles/authenticated/screenshots/GPUCache/shot.png", 512);
  write("profiles/authenticated/browser-data/Default/IndexedDB/Code Cache", 64);
  write("private-artifacts/private-1/Cache", 256);
  write("legacy/ShaderCache", 128);
  assert.equal(profileStorageBytes(profile), 2048 + 512 + 64);
  assert.equal(ownerStorageBytes(dir), 2048 + 512 + 64 + 256 + 128);
});

test("caches past their budget are cleared, and nothing else is", (t) => {
  const { write, profile } = owner(t);
  write("profiles/authenticated/browser-data/Default/Cookies", 100);
  write("profiles/authenticated/browser-data/Default/Cache/Cache_Data/data_1", 600);
  write("profiles/authenticated/browser-data/Default/Code Cache/js/index", 500);
  const cache = path.join(profile, "browser-data", "Default", "Cache");
  const cookies = path.join(profile, "browser-data", "Default", "Cookies");

  assert.equal(trimBrowserCaches(profile, 2000), 0, "under budget: kept");
  assert.ok(fs.existsSync(cache));

  assert.equal(trimBrowserCaches(profile, 1000), 1100, "over budget: cleared");
  assert.ok(!fs.existsSync(cache));
  assert.ok(!fs.existsSync(path.join(profile, "browser-data", "Default", "Code Cache")));
  assert.equal(fs.statSync(cookies).size, 100, "logins are untouched");
});

test("the browser starts with its page cache capped", () => {
  const browser = { launchStrategy: "executable-path", canonicalPath: "/usr/bin/chromium" };
  for (const headless of [true, false]) {
    const { args } = launchOptions(browser, headless, { width: 800, height: 600 }, "/tmp/d");
    const flag = args.find((arg) => arg.startsWith("--disk-cache-size="));
    assert.ok(flag, "the page cache has a cap");
    assert.ok(Number(flag.split("=")[1]) > 0);
  }
});
