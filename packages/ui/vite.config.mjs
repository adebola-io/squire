import { defineConfig } from "vite";
import { retend } from "retend-web/plugins/vite";

const external = ["innate-ui", "retend", "retend-web", "retend-utils"];

export default defineConfig({
  plugins: [retend()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "components",
    },
    rollupOptions: {
      external: (id) => external.some((name) => id === name || id.startsWith(name + "/")),
    },
  },
});
