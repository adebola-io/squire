import { Cell, If } from "retend";
import { Icon } from "squire-ui";

import classes from "./Browser.module.css";

interface Props {
  url: string;
}

// Only use the external fallback for these public sites. Arbitrary browsing
// destinations (including internal hosts) must not be sent to a favicon proxy.
const PUBLIC_FAVICON_HOSTS = new Set([
  "youtube.com",
  "github.com",
  "reddit.com",
  "tiktok.com",
  "stackoverflow.com",
]);

function faviconUrls(url: string): string[] {
  try {
    const page = new URL(url);
    if (page.protocol !== "https:" && page.protocol !== "http:") return [];
    const host = page.hostname.replace(/^www\./, "");
    const direct = page.origin + "/favicon.ico";
    return PUBLIC_FAVICON_HOSTS.has(host)
      ? [direct, "https://icons.duckduckgo.com/ip3/" + host + ".ico"]
      : [direct];
  } catch {
    return [];
  }
}

export function BrowserFavicon(props: Props) {
  const { url } = props;
  const attempt = Cell.source(0);
  const urls = faviconUrls(url);
  const src = Cell.derived(() => urls[attempt.get()] ?? "");
  const hasIcon = Cell.derived(() => src.get() !== "");
  const needsFallback = Cell.derived(() => !hasIcon.get());
  return (
    <>
      {If(hasIcon, () => (
        <img
          class={classes.favicon}
          src={src}
          alt=""
          onError={() => attempt.set(attempt.get() + 1)}
        />
      ))}
      {If(needsFallback, () => (
        <Icon name="browser" class={classes.faviconFallback} aria-hidden="true" />
      ))}
    </>
  );
}
