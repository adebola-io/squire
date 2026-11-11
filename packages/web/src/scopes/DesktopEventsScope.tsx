import { createScope, onSetup, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";

import {
  DesktopEvent,
  parseDesktopMessage,
  type ConnectionOpenedEvent,
  type DesktopMessage,
  type DesktopMessageOf,
} from "@/platform/desktopEvents";

interface DesktopEventsState {
  target: EventTarget;
}

interface DesktopEventsProviderProps {
  children: JSX.Children;
}

const DesktopEventsScope = createScope<DesktopEventsState>();

const desktopEventsUrl = () => {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/desktop/events`;
};

export function DesktopEventsProvider(props: DesktopEventsProviderProps) {
  const { children } = props;
  const target = new EventTarget();

  onSetup(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    const reconnect = () => {
      if (!closed) window.setTimeout(connect, 1000);
    };
    const connect = () => {
      const events = new WebSocket(desktopEventsUrl());
      socket = events;
      events.addEventListener("open", () => {
        const opened: ConnectionOpenedEvent = { type: "connection.opened" };
        target.dispatchEvent(new DesktopEvent(opened));
      });
      events.addEventListener("message", (event) => {
        let message: DesktopMessage;
        try {
          message = parseDesktopMessage(JSON.parse(event.data));
        } catch (error) {
          console.error("Dropping malformed desktop event:", error, event.data);
          return;
        }
        target.dispatchEvent(new DesktopEvent(message));
      });
      events.addEventListener("close", () => {
        if (closed) return;
        reconnect();
      });
      events.addEventListener("error", () => {
        events.close();
      });
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  });

  return <DesktopEventsScope.Provider value={{ target }}>{children}</DesktopEventsScope.Provider>;
}

function useDesktopEvents() {
  return useScopeContext(DesktopEventsScope);
}

export function onDesktopEvent<Type extends DesktopMessage["type"]>(
  type: Type,
  handler: (message: DesktopMessageOf<Type>) => void,
) {
  const { target } = useDesktopEvents();
  onSetup(() => {
    const listener = (event: Event) => {
      // Sound by construction: this listener was registered under exactly
      // `type`, and only DesktopEvents are dispatched on this target.
      if (event instanceof DesktopEvent) handler(event.message as DesktopMessageOf<Type>);
    };
    target.addEventListener(type, listener);
    return () => {
      target.removeEventListener(type, listener);
    };
  });
}
