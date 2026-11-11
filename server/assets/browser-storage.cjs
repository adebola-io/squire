"use strict";
// How much browser storage counts against Squire's limits, and keeping the caches it does not
// count bounded.
//
// A used profile is mostly cache: fetched pages, compiled scripts and GPU shaders, which the
// browser rebuilds on its own (one real profile held 950 MB of cache beside 10 MB of logins and
// site data). The storage limits apply to everything else: logins, site storage, screenshots and
// downloads. Caches are bounded separately: Chrome caps its page cache (`--disk-cache-size` in
// browser-launch.cjs) and manages the others itself, and a profile whose caches still pass
// CACHE_BUDGET_BYTES has them cleared before its browser starts.
const fs = require("node:fs");
const path = require("node:path");

const CACHE_BUDGET_BYTES = 1024 * 1024 * 1024;

/**
 * Cache directories inside a profile, by exact path under its browser data directory. Only
 * these, never another file or folder that happens to share a name, go uncounted.
 */
const BROWSER_CACHE_PATHS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "GPUPersistentCache",
  "GraphiteDawnCache",
  "GrShaderCache",
  "ShaderCache",
  "component_crx_cache",
  "extensions_crx_cache",
];

/** Bytes under `directory`, leaving out the absolute paths in `skip`. */
function directoryBytes(directory, skip = new Set()) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  return entries.reduce((total, entry) => {
    const file = path.join(directory, entry.name);
    if (skip.has(file)) return total;
    return (
      total +
      (entry.isDirectory()
        ? directoryBytes(file, skip)
        : (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0))
    );
  }, 0);
}

/** The browser's cache directories in the profile stored at `root`. */
function browserCachePaths(root) {
  return BROWSER_CACHE_PATHS.map((cache) => path.join(root, "browser-data", ...cache.split("/")));
}

/** A profile's storage as its limit counts it: all but staged downloads and browser caches. */
function profileStorageBytes(root) {
  return directoryBytes(
    root,
    new Set([path.join(root, "download-staging"), ...browserCachePaths(root)]),
  );
}

/** An owner's storage as its limit counts it: all its profiles' and artifacts' but caches. */
function ownerStorageBytes(ownerDir) {
  const profiles = path.join(ownerDir, "profiles");
  let roots = [];
  try {
    roots = fs
      .readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(profiles, entry.name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return (
    directoryBytes(profiles, new Set(roots.flatMap(browserCachePaths))) +
    directoryBytes(path.join(ownerDir, "private-artifacts")) +
    directoryBytes(path.join(ownerDir, "legacy"))
  );
}

/**
 * Clears the profile's browser caches when together they pass `budget`. Call it only while the
 * profile's browser is closed; the browser rebuilds them as it needs them. Returns the bytes
 * cleared.
 */
function trimBrowserCaches(root, budget = CACHE_BUDGET_BYTES) {
  const caches = browserCachePaths(root);
  const bytes = caches.reduce((total, cache) => total + directoryBytes(cache), 0);
  if (bytes <= budget) return 0;
  for (const cache of caches) fs.rmSync(cache, { recursive: true, force: true });
  return bytes;
}

module.exports = {
  CACHE_BUDGET_BYTES,
  directoryBytes,
  profileStorageBytes,
  ownerStorageBytes,
  trimBrowserCaches,
};
