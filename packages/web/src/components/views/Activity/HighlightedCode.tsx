import { highlightCode } from "@squire/markdown/highlight";
import { Cell } from "retend";

interface HighlightedCodeProps {
  source: string;
}

/** Prepared-markup cache lifetime. */
const PREPARED_MS = 10_000;
const prepared = new Map<string, string>();

/** Cache highlighted markup briefly so a prepared view can render it synchronously. */
export async function prepareHighlightedCode(sources: Iterable<string>): Promise<void> {
  await Promise.all(
    [...new Set(sources)].map(async (source) => {
      if (prepared.has(source)) return;
      const html = await highlightCode(source);
      prepared.set(source, html);
      window.setTimeout(() => {
        if (prepared.get(source) === html) prepared.delete(source);
      }, PREPARED_MS);
    }),
  );
}

/** Prepare escaped syntax markup before mounting the code view. */
export function HighlightedCode(props: HighlightedCodeProps) {
  const { source } = props;
  const html = prepared.get(source) ?? Cell.derivedAsync(async () => highlightCode(source));
  return <pre tabIndex={0} aria-label="Tool code" dangerouslySetInnerHTML={{ __html: html }} />;
}
