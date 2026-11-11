import { Await, Cell, For, If } from "retend";
import { Button, Icon } from "squire-ui";

import { AddWorkspaceButton } from "@/components/views/Workspaces/AddWorkspaceButton";
import { useWorkspaceState } from "@/scopes/WorkspaceScope";
import { pathBasename } from "@/utils/misc";

import classes from "./Onboarding.module.css";

interface StepProps {
  next: () => void;
}

const COUNT_WORDS = ["No folders", "One is", "Two are", "Three are", "Four are", "Five are"];

/** "Three are set up already.", or null when there are none. */
function setUpAlready(count: number) {
  if (count === 0) return null;
  const words = COUNT_WORDS[count] ?? `${count} are`;
  return `${words} set up already.`;
}

export function WorkspaceContent(props: StepProps) {
  const { next } = props;
  const { roots, error, busyPath, removeRoot, revalidate } = useWorkspaceState();
  const busy = Cell.derived(() => busyPath.get() !== null);
  const summary = Cell.derivedAsync(async (get) => setUpAlready((await get(roots)).length));
  const empty = Cell.derivedAsync(async (get) => (await get(roots)).length === 0);
  return (
    <>
      <h1>Workspaces</h1>
      <p>
        Squire reads and edits inside these folders, and nothing outside them.
        {If(summary, (text) => ` ${text}`)}
      </p>
      {If(error, (text) => (
        <p class={classes.error} role="alert">
          {text}
        </p>
      ))}
      <Await fallback={<p role="status">Loading workspaces…</p>}>
        {If(empty, {
          true: () => (
            <div class={classes.emptyRoots}>
              <Icon name="folder" aria-hidden="true" />
              <p>
                No folders yet. Add the folders you want Squire to work in, such as a project or
                your home folder. You can also do this later in Settings.
              </p>
            </div>
          ),
          false: () => (
            <ul class={classes.roots}>
              {For(roots, (root) => (
                <li>
                  <Icon name="folder" aria-hidden="true" />
                  <strong>{pathBasename(root.path)}</strong>
                  <span title={root.path}>{root.path}</span>
                  <button
                    type="button"
                    disabled={busy}
                    title={`Remove ${pathBasename(root.path)}`}
                    aria-label={`Remove ${pathBasename(root.path)}`}
                    onClick={() => void removeRoot(root)}
                  >
                    <Icon name="trash" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ),
        })}
      </Await>
      {If(roots.error, () => (
        <Button variant="outline" onClick={revalidate}>
          Retry loading folders
        </Button>
      ))}
      <AddWorkspaceButton class={classes.addFolder} showIcon label="Add a folder" />
      <div class={classes.actions}>
        <Button variant="outline" onClick={next}>
          Skip
        </Button>
        <Button onClick={next}>Done</Button>
      </div>
    </>
  );
}
