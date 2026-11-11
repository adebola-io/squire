import { Cell, For, If } from "retend";
import { Icon } from "squire-ui";

import type { ConversationJob } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { actionPluginIdFromName, formatDuration } from "./chatModel";
import { ChatToolIcon } from "./ChatToolIcon";

import classes from "./Chat.module.css";

/** Keep conversation-owned jobs visible without taking over the composer until expanded. */
export function BackgroundJobs() {
  const { selectedId, snapshot } = useChat();
  const expanded = Cell.source(false);
  const jobs = Cell.derived(() => {
    const current = snapshot.get();
    if (current === null || current.conversation.id !== selectedId.get()) return [];
    return current.jobs.filter((job) => job.state === "running");
  });
  const visible = Cell.derived(() => jobs.get().length > 0);
  const count = Cell.derived(() => jobs.get().length);
  const preview = Cell.derived(() => jobs.get().slice(0, 3));
  const summary = Cell.derived(() => {
    const amount = count.get();
    return `Background jobs, ${amount} running. ${expanded.get() ? "Collapse" : "Expand"}`;
  });
  const collapsed = Cell.derived(() => !expanded.get());

  // Each new group of jobs starts collapsed, including after switching conversations.
  selectedId.listen(() => expanded.set(false));
  visible.listen((hasJobs) => {
    if (!hasJobs) expanded.set(false);
  });

  return If(visible, () => (
    <div class={classes.backgroundJobs}>
      <section
        id="chat-background-jobs"
        class={classes.backgroundJobsPanel}
        aria-label="Background jobs"
        hidden={collapsed}
      >
        <ul class={classes.backgroundJobList}>
          {For(
            jobs,
            (job) => (
              <BackgroundJobRow job={job} />
            ),
            { key: "id" },
          )}
        </ul>
        <p class={classes.backgroundJobsNote}>
          Jobs keep running when you close this panel or switch chats.
        </p>
      </section>
      <div class={classes.backgroundJobPills}>
        <button
          type="button"
          class={classes.backgroundJobTrigger}
          aria-label={summary}
          aria-controls="chat-background-jobs"
          aria-expanded={expanded}
          onClick={() => expanded.set(!expanded.get())}
        >
          <Icon name="clock" class={classes.backgroundJobClock} aria-hidden="true" />
          <span class={classes.backgroundJobTriggerLabel}>Background jobs</span>
          <span class={classes.backgroundJobAvatars} aria-hidden="true">
            {For(
              preview,
              (job) => (
                <BackgroundJobAvatar job={job} />
              ),
              { key: "id" },
            )}
          </span>
          <span class={classes.backgroundJobCount}>{count}</span>
          <Icon name="caret" class={classes.backgroundJobCaret} aria-hidden="true" />
        </button>
      </div>
    </div>
  ));
}

interface BackgroundJobProps {
  job: ConversationJob;
}

function BackgroundJobAvatar(props: BackgroundJobProps) {
  const { job } = props;
  const plugin = job.pluginId ?? actionPluginIdFromName(job.action);
  return (
    <span class={classes.backgroundJobAvatar} title={job.label}>
      <ChatToolIcon name="plugin" pluginId={plugin} />
    </span>
  );
}

/** Keep the existing cancellation task and status reporting inside each keyed job row. */
function BackgroundJobRow(props: BackgroundJobProps) {
  const { job } = props;
  const { cancelJob, clock } = useChat();
  const cancel = Cell.task(async () => {
    await cancelJob(job.id);
  });
  const status = Cell.derived(() => {
    if (cancel.pending.get()) return "Cancelling…";
    const failure = cancel.error.get();
    if (failure !== null) return `Couldn't cancel: ${failure.message}`;
    return `Running for ${formatDuration(clock.get().getTime() - Date.parse(job.startedAt))}`;
  });
  const cancelling = Cell.derived(() => cancel.pending.get());
  const plugin = job.pluginId ?? actionPluginIdFromName(job.action);

  return (
    <li class={classes.backgroundJob}>
      <span class={classes.backgroundJobRowIcon} aria-hidden="true">
        <ChatToolIcon name="plugin" pluginId={plugin} />
      </span>
      <span class={classes.backgroundJobMain}>
        <span class={classes.backgroundJobLabel} title={job.action}>
          {job.label}
        </span>
      </span>
      <span class={classes.backgroundJobTime} title={status}>
        {status}
      </span>
      <button
        type="button"
        class={classes.backgroundJobStop}
        disabled={cancelling}
        aria-label={`Stop background job: ${job.label}`}
        title={`Stop ${job.label}`}
        onClick={() => void cancel.runWith(null)}
      >
        <Icon name="stop" aria-hidden="true" />
      </button>
    </li>
  );
}
