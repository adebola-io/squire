import { Cell, For, If } from "retend";

import type { RemoteAccessModel } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

const shortClock = (at: number) =>
  new Date(at).toLocaleTimeString(navigator.languages[0], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

interface SectionProps {
  remote: RemoteAccessModel;
}

/** Remote Access connection events, newest first. */
export function Events(props: SectionProps) {
  const { remote } = props;
  const events = Cell.derivedAsync(async (get) =>
    (await get(remote.status)).events.map((event, index) => ({
      ...event,
      key: `${event.at}:${index}`,
      time: shortClock(event.at),
    })),
  );
  const hasEvents = Cell.derivedAsync(async (get) => (await get(events)).length > 0);

  return (
    <section class={classes.diagnosticsSection}>
      <h3 class={classes.label}>Events</h3>
      {If(hasEvents, {
        true: () => (
          <ul class={classes.events}>
            {For(
              events,
              (event) => (
                <li class={classes.event} data-tone={event.tone}>
                  <time>{event.time}</time>
                  <span>{event.text}</span>
                </li>
              ),
              { key: "key" },
            )}
          </ul>
        ),
        false: () => <p class={classes.note}>Nothing yet.</p>,
      })}
    </section>
  );
}
