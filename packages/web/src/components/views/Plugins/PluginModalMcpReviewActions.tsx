import { For, If } from "retend";

import type { DesktopMcpCandidateAction } from "@/platform/desktopClient";
import { pluralize } from "@/utils/misc";

import classes from "./Plugins.module.css";

/** Use the server hostname as the label, falling back to the stdio command for non-URLs. */
function serverLabel(connection: string): string {
  try {
    return new URL(connection).host;
  } catch {
    return connection;
  }
}

function actionTitle(action: DesktopMcpCandidateAction): string {
  return action.title || action.name;
}

interface PluginModalMcpReviewActionsProps {
  actions: DesktopMcpCandidateAction[];
  connection: string;
}

export function PluginModalMcpReviewActions(props: PluginModalMcpReviewActionsProps) {
  const { actions, connection } = props;
  const subtitle = `${pluralize(actions.length, "action", "actions")} available from ${serverLabel(connection)}.`;

  return (
    <section class={classes.mcpReviewActions} aria-labelledby="mcp-review-actions-heading">
      <div class={classes.mcpReviewActionsHeading}>
        <h2 id="mcp-review-actions-heading" title="Actions">
          Actions
        </h2>
        <p title={subtitle}>{subtitle}</p>
      </div>

      {If(actions.length === 0, {
        true: () => (
          <p class={classes.mcpReviewNote} title="This server didn't report any actions.">
            This server didn't report any actions.
          </p>
        ),
        false: () => (
          <ul class={classes.mcpReviewActionList}>
            {For(actions, (action) => (
              <PluginModalMcpReviewActionRow action={action} />
            ))}
          </ul>
        ),
      })}
    </section>
  );
}

interface PluginModalMcpReviewActionRowProps {
  action: DesktopMcpCandidateAction;
}

function PluginModalMcpReviewActionRow(props: PluginModalMcpReviewActionRowProps) {
  const { action } = props;
  const title = actionTitle(action);
  const description = action.description || "No description provided.";

  return (
    <li class={classes.mcpReviewAction}>
      <span class={classes.mcpReviewActionTitle} title={title}>
        {title}
      </span>
      <span class={classes.mcpReviewActionDescription} title={description}>
        {description}
      </span>
    </li>
  );
}
