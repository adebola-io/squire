import { retend } from "retend-web/plugins/vite";
import { defineConfig } from "vite";

const devPort = Number(process.env.SQUIRE_DEV_WEB_PORT ?? 4295);
const devBackend = process.env.SQUIRE_DEV_BACKEND ?? "http://127.0.0.1:4296";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  plugins: [retend()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
    proxy: {
      "/desktop": { target: devBackend, ws: true },
      "/attachments": devBackend,
    },
  },
  envPrefix: ["VITE_"],
});
