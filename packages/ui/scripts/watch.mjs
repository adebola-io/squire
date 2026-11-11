import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fileURLToPath(new URL("../src/", import.meta.url));

let pending = false;
let running = false;
let timer;
let child;

function rebuild() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  console.log("[squire-ui] Rebuilding after source change...");
  child = spawn("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  child.on("error", (error) => {
    console.error("[squire-ui] Could not start build:", error);
  });
  child.on("close", (code) => {
    if (code !== 0) console.error(`[squire-ui] Build exited with code ${code}`);
    running = false;
    child = undefined;
    if (pending) {
      pending = false;
      rebuild();
    }
  });
}

const watcher = watch(source, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 150);
});

function stop() {
  clearTimeout(timer);
  watcher.close();
  child?.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("[squire-ui] Watching source for changes.");
