import { Cell } from "retend";
import { Icon, Toggle } from "squire-ui";

import { useWorkspaceState } from "@/scopes/WorkspaceScope";
import type { WorkspaceRoot } from "@/scopes/WorkspaceScope";
import { pathBasename } from "@/utils/misc";

import classes from "./Workspaces.module.css";

export function WorkspaceRow(props: WorkspaceRoot) {
  const { path, enabled, exists } = props;
  const { busyPath, toggleRoot, removeRoot, revealRoot } = useWorkspaceState();
  const root: WorkspaceRoot = { path, enabled, exists };
  const rootName = pathBasename(path);
  const actionIsBusy = Cell.derived(() => {
    return busyPath.get() === path;
  });

  return (
    <li class={classes.rootRow} data-missing={!exists} aria-busy={actionIsBusy}>
      <Icon name="folder" class={classes.rootIcon} aria-hidden="true" />
      <div class={classes.rootText}>
        <h2 class={classes.rootName} title={rootName}>
          {rootName}
        </h2>
        <p class={classes.rootPath} title={path}>
          {path}
        </p>
      </div>
      <div class={classes.rootActions}>
        <Toggle
          on={enabled}
          disabled={actionIsBusy}
          title={`Enable ${rootName}`}
          aria-label={`Enable ${rootName}`}
          onChange={() => {
            void toggleRoot(root);
          }}
        />
        <button
          class={classes.iconButton}
          type="button"
          disabled={actionIsBusy}
          title={`Reveal ${rootName}`}
          aria-label={`Reveal ${rootName}`}
          onClick={() => {
            void revealRoot(root);
          }}
        >
          <Icon name="eye" aria-hidden="true" />
        </button>
        <button
          class={classes.iconButton}
          type="button"
          disabled={actionIsBusy}
          title={`Remove ${rootName}`}
          aria-label={`Remove ${rootName}`}
          onClick={() => {
            void removeRoot(root);
          }}
        >
          <Icon name="trash" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
