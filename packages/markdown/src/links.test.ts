// Local-file links through the same pipeline the chat uses: markdown-it, then the reply sanitizer.
// What the click handler reads is `data-local-path`, so each case checks that it survives with the
// right path and that the `file:` href names the same file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeRichHtml } from "./richHTML";
import { classifyLink, fileHref, md } from "./syntax";

function renderLink(source: string) {
  const env = { interactive: true };
  const html = sanitizeRichHtml(md.renderer.render(md.parse(source, env), md.options, env));
  const anchor = /<a\b[^>]*>/.exec(html)?.[0] ?? "";
  const attribute = (name: string) => {
    const value = new RegExp(`\\s${name}="([^"]*)"`).exec(anchor)?.[1];
    return value?.replace(/&amp;/g, "&");
  };
  return { href: attribute("href"), path: attribute("data-local-path") };
}

const cases: [source: string, path: string][] = [
  ["[a](/Users/ada/notes.md)", "/Users/ada/notes.md"],
  ["[a](C:/Users/Ada/report.txt)", "C:/Users/Ada/report.txt"],
  ["[a](C:\\Users\\Ada\\report.txt)", "C:\\Users\\Ada\\report.txt"],
  ["[a](<C:\\Users\\Ada\\My Report.txt>)", "C:\\Users\\Ada\\My Report.txt"],
  ["[a](C:/Users/Ada/src/main.rs#L12)", "C:/Users/Ada/src/main.rs"],
  ["[a](file:///C:/Users/Ada/report.txt)", "C:/Users/Ada/report.txt"],
  // `\\` is Markdown's escape for one backslash, so these differ in the source but not the share.
  ["[a](\\\\server\\share\\notes.md)", "\\\\server\\share\\notes.md"],
  ["[a](\\\\\\\\server\\share\\notes.md)", "\\\\server\\share\\notes.md"],
  ["[a](file://server/share/report.md)", "\\\\server\\share\\report.md"],
  ["[a](file:////server/share/report.md)", "\\\\server\\share\\report.md"],
];

for (const [source, path] of cases) {
  test(`${source} opens ${path}`, () => {
    const link = renderLink(source);
    assert.equal(link.path, path);
    assert.equal(link.href, fileHref(path));
    // The href names the same file when copied or opened outside Squire.
    assert.deepEqual(classifyLink(link.href ?? ""), {
      kind: "local",
      path: path.replace(/\\/g, path.startsWith("\\\\") ? "\\" : "/"),
    });
  });
}

test("file names keep # and ? in their file: URL", () => {
  const href = fileHref("C:/Users/Ada/name#v2?.md");
  assert.equal(href, "file:///C:/Users/Ada/name%23v2%3F.md");
  assert.equal(new URL(href).pathname, "/C:/Users/Ada/name%23v2%3F.md");
  assert.deepEqual(classifyLink(href), { kind: "local", path: "C:/Users/Ada/name#v2?.md" });
});

test("URL schemes and app routes stay what they are", () => {
  assert.deepEqual(classifyLink("mailto:a@b.c"), { kind: "scheme" });
  assert.deepEqual(classifyLink("vscode:extension/x"), { kind: "scheme" });
  assert.deepEqual(classifyLink("/settings"), { kind: "app" });
  assert.deepEqual(classifyLink("\\notes.md"), { kind: "unresolved" });
});
