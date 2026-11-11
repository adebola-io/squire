import { readFile, writeFile } from "node:fs/promises";

const styles = new URL("../dist/styles.css", import.meta.url);
await writeFile(styles, '@import "./components.css";\n' + (await readFile(styles, "utf8")));
