import { AsyncCell, Cell, If } from "retend";
import { Icon } from "squire-ui";

import { updateProvider } from "@/platform/desktopClient";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { useLiveValue } from "@/utils/fieldValue";

import classes from "./Providers.module.css";

interface ProviderTitleProps {
  /** Initial provider record. */
  initial: DesktopProviderProfile;
  /** Current provider record. */
  profile: AsyncCell<DesktopProviderProfile | null>;
}

/**
 * Editable provider title. Save on Enter or blur, restore on Escape, and preserve focus while
 * saving.
 */
export function ProviderTitle(props: ProviderTitleProps) {
  const { initial, profile } = props;
  const { refreshProviders } = useChat();
  // Latest name reported by the server: the display fallback and the rename baseline.
  const savedName = Cell.source(initial.displayName);
  // Null while the field follows the saved name, a string while it holds unsaved typing.
  const draft = Cell.source<string | null>(null);
  const rename = Cell.task(async (name: string) => {
    const current = (await profile.get()) ?? initial;
    // Update only the name; omitted credential fields preserve saved values.
    await updateProvider(current.id, {
      displayName: name,
      kind: current.kind,
      baseUrl: current.baseUrl,
    });
    savedName.set(name);
    refreshProviders();
  });
  const value = Cell.derived(() => {
    return draft.get() ?? savedName.get();
  });
  const inputRef = useLiveValue(value);

  const commit = () => {
    const next = (draft.get() ?? savedName.get()).trim();
    if (next === "" || next === savedName.get()) {
      draft.set(null);
      return;
    }
    if (!rename.pending.get()) {
      void rename.runWith(next);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      commit();
      return;
    }
    if (event.key === "Escape") {
      draft.set(null);
    }
  };
  const onBlur = () => {
    commit();
  };
  // Follow a name saved elsewhere until the field is edited, and retire the draft once the
  // server holds the typed name.
  profile.listen(async (current) => {
    const latest = await current;
    if (latest !== null) savedName.set(latest.displayName);
  });
  savedName.listen((name) => {
    const typed = draft.peek();
    if (typed !== null && typed.trim() === name) draft.set(null);
  });

  return (
    <div class={classes.titleBlock}>
      <label class={classes.titleField} title="Rename provider">
        <input
          ref={inputRef}
          class={classes.titleInput}
          value={value}
          aria-label="Provider name"
          aria-busy={rename.pending}
          onInput={(event) => {
            draft.set((event.currentTarget as HTMLInputElement).value);
          }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        <Icon name="edit" class={classes.titleEditIcon} aria-hidden="true" />
      </label>
      {If(rename.error, (error) => {
        return (
          <p class={classes.error} role="alert">
            {error.message}
          </p>
        );
      })}
    </div>
  );
}
