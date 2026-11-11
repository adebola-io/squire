import { Cell, If, onConnected } from "retend";

import classes from "./LoadMore.module.css";

interface LoadMoreProps {
  hasMore: Cell<boolean>;
  loading: Cell<boolean>;
  onLoad: () => void;
  /** Button label when idle. */
  label: string;
  /** Button label while loading. */
  loadingLabel: string;
}

/**
 * Load the next page when the sentinel enters view. The button provides a manual loading
 * action.
 */
export function LoadMore(props: LoadMoreProps) {
  const { hasMore, loading, onLoad, label, loadingLabel } = props;
  const sentinel = Cell.source<HTMLElement | null>(null);
  const text = Cell.derived(() => {
    return loading.get() ? loadingLabel : label;
  });

  onConnected(sentinel, (element) => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => {
        return entry.isIntersecting;
      });
      if (visible) {
        onLoad();
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });

  return If(hasMore, () => {
    return (
      <div ref={sentinel} class={classes.loadMore} aria-busy={loading}>
        <button
          type="button"
          class={classes.loadMoreButton}
          disabled={loading}
          onClick={onLoad}
          title={text}
        >
          {text}
        </button>
      </div>
    );
  });
}
