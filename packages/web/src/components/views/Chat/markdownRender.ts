import { sanitizeRichHtml } from "@squire/markdown/richHTML";
import { enrichCodeTokens, md } from "@squire/markdown/syntax";
import type { MermaidDiagram } from "@squire/markdown/types";

export {
  LOCAL_PATH_ATTRIBUTE,
  LOCAL_PATH_SELECTOR,
  CODE_BLOCK_ATTRIBUTE,
  CODE_COPY_ATTRIBUTE,
} from "@squire/markdown/syntax";

export async function prepareReplyMarkdown(source: string): Promise<void> {
  await prepareMarkdown([source], true);
}

/** Cache prepared markup for synchronous mounting. */
const CACHE_LIMIT = 300;
const cache = new Map<string, string>();

function store(key: string, html: string): string {
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

/**
 * Render code-free content synchronously; otherwise highlight first. Unknown languages render
 * as escaped text.
 */
export function renderMarkdown(source: string, interactive = false): string | Promise<string> {
  const key = (interactive ? "ui:" : "md:") + source;
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const env = { interactive };
  const tokens = md.parse(source, env);
  const finish = (diagrams: Map<string, MermaidDiagram>) => {
    const html = md.renderer.render(tokens, md.options, env);
    return store(key, !interactive ? html : sanitizeRichHtml(html, { diagrams }));
  };
  if (!tokens.some((token) => token.type === "fence" || token.type === "code_block"))
    return finish(new Map());

  return (async () => {
    const diagrams = await enrichCodeTokens(tokens, interactive);
    return finish(diagrams);
  })();
}

/** Return cached markup synchronously, or undefined if preparation is incomplete. */
export function peekMarkdown(source: string, interactive = false): string | undefined {
  const key = (interactive ? "ui:" : "md:") + source;
  return cache.get(key);
}

/** Prepare Markdown and highlighting before views mount; failures render on mount instead. */
export async function prepareMarkdown(
  sources: Iterable<string>,
  interactive = false,
): Promise<void> {
  const fresh = [...new Set(sources)].filter(
    (source) => source !== "" && peekMarkdown(source, interactive) === undefined,
  );
  await Promise.all(
    fresh.map(async (source) => {
      try {
        await renderMarkdown(source, interactive);
      } catch {
        // The view renders on mount instead.
      }
    }),
  );
}
