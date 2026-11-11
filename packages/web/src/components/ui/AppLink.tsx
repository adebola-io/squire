import type { JSX } from "retend/jsx-runtime";
import { useRouter } from "retend/router";

type NativeAnchorProps = JSX.IntrinsicElements["a"];

interface AppLinkProps extends Omit<NativeAnchorProps, "href" | "onClick"> {
  /** An in-app path, such as `/chat/123`. */
  href: string;
  /** Callback before client-side navigation handles the click. */
  onNavigate?: () => void;
}

/**
 * Use native links with client-side navigation for unmodified clicks. Preserve URLs and browser
 * behavior for copying links and opening tabs.
 */
export function AppLink(props: AppLinkProps) {
  const { href, onNavigate, children, ...anchorProps } = props;
  const router = useRouter();

  const follow = (event: MouseEvent) => {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (event.defaultPrevented || event.button !== 0 || modified) {
      return;
    }
    // Intercept plain clicks to avoid a full reload. Preserve modified-click browser behavior.
    event.preventDefault();
    onNavigate?.();
    void router.navigate(href);
  };

  return (
    <a {...anchorProps} href={href} onClick={follow}>
      {children}
    </a>
  );
}
