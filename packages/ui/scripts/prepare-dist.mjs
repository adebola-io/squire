import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "src");
const output = resolve(root, "dist");

// Copy standalone assets and styles before Vite bundles the JavaScript and
// extracts component styles into a single CSS file.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(source, "assets"), join(output, "assets"), { recursive: true });

async function copyStyles(directory, relative = "") {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const next = join(relative, item.name);
    if (item.isDirectory()) {
      if (item.name !== "assets") await copyStyles(join(directory, item.name), next);
      continue;
    }
    if (!item.isFile() || !item.name.endsWith(".css")) continue;
    const destination = join(output, next);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(directory, item.name), destination);
  }
}

await copyStyles(source);
