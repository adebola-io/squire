import { Cell, onSetup, type SourceCell } from "retend";
import { useDocumentVisibility, useResizeObserver } from "retend-utils/hooks";

import {
  browserSocketUrl,
  closeBrowserTab,
  type BrowserScopeKind,
  type BrowserTab,
} from "@/platform/browserViewer";

export interface BrowserViewerProps {
  kind: BrowserScopeKind;
  id: string;
  tabs: SourceCell<BrowserTab[]>;
  error: Cell<string | null>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onViewportChange?: (size: Size) => void;
}

const TAB_CLOSED_CODE = 4404;
// The hidden text field always holds this one invisible character. Soft keyboards
// (Gboard reports Backspace as keyCode 229) then still produce a deletion to forward.
const SENTINEL = "\u200b";
// Keys forwarded as key presses. Everything that types a character arrives as
// text instead, so IMEs, dead keys and AltGr compose before anything is sent.
const FORWARDED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

type ViewState = "connecting" | "live" | "reconnecting" | "offline";
type Size = { width: number; height: number };
interface PendingFrame {
  jpeg: Blob;
  size: Size;
  generation: number;
}
interface PointerPacket extends Size {
  x: number;
  y: number;
}
interface WheelPacket extends PointerPacket {
  dx: number;
  dy: number;
}

const sameSize = (a: Size | null, b: Size) =>
  a !== null && a.width === b.width && a.height === b.height;
const isSize = (value: unknown): value is Size =>
  typeof value === "object" &&
  value !== null &&
  "width" in value &&
  "height" in value &&
  typeof value.width === "number" &&
  typeof value.height === "number" &&
  Number.isInteger(value.width) &&
  Number.isInteger(value.height) &&
  value.width > 0 &&
  value.height > 0 &&
  value.width <= 3840 &&
  value.height <= 3840;

const PRESETS: Record<string, Size> = {
  desktop: { width: 1280, height: 720 },
  laptop: { width: 1120, height: 630 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
};

export function useBrowserViewer(props: BrowserViewerProps) {
  const visible = useDocumentVisibility();
  const stage = Cell.source<HTMLDivElement | null>(null);
  const picture = Cell.source<HTMLCanvasElement | null>(null);
  const keyboard = Cell.source<HTMLTextAreaElement | null>(null);
  const selected = Cell.source(props.tabs.get()[0]?.tab ?? "");
  const state = Cell.source<ViewState>("connecting");
  // Avoid flashing a full-screen loading scrim during fast local tab changes.
  const connectionStatusVisible = Cell.source(false);
  const status = Cell.source<string | null>(null);
  const overview = Cell.source(false);
  const zoom = Cell.source(false);
  const hasFrame = Cell.source(false);
  const viewport = Cell.source<Size>(props.tabs.get()[0]?.viewport ?? PRESETS.laptop);
  // Tab metadata is available before any stream starts. Retain the latest
  // reported dimensions independently for each tab, including after resizing.
  const knownViewports = new Map(
    props.tabs
      .get()
      .filter((item) => item.viewport)
      .map((item) => [item.tab, item.viewport!] as const),
  );
  const availableWidth = Cell.source(0);
  const availableHeight = Cell.source(0);
  // Decode outside the visible canvas; never blank the last painted frame.
  let pendingFrame: PendingFrame | null = null;
  let paintedViewport: Size | null = null;
  let requiredFrameSize: Size | null = null;
  let painting = false;
  let socket: WebSocket | null = null;
  let retry: number | undefined;
  let connectionStatusTimer: number | undefined;
  let firstFrameTimer: number | undefined;
  let generation = 0;
  let disposed = false;
  let touchY = 0;
  let touchX = 0;
  let connectingAttempts = 0;
  let bufferedWheel: WheelPacket | null = null;
  let wheelTimer: number | undefined;
  let composing = false;

  const tab = Cell.derived(
    () => props.tabs.get().find((item) => item.tab === selected.get()) ?? null,
  );
  const currentSize = Cell.derived(() => {
    const size = viewport.get();
    return String(size.width) + " × " + String(size.height);
  });
  const viewportChanged = Cell.derived(() => {
    const base = tab.get()?.defaultViewport;
    const size = viewport.get();
    return (
      base !== null &&
      base !== undefined &&
      (base.width !== size.width || base.height !== size.height)
    );
  });
  const viewScale = Cell.derived(() => {
    const size = viewport.get();
    const width = availableWidth.get();
    const height = availableHeight.get();
    if (width <= 0 || height <= 0) return 0;
    const fit = Math.min(1, width / size.width, height / size.height);
    return fit * (zoom.get() ? 1.8 : 1);
  });
  const surfaceWidth = Cell.derived(() => `${viewport.get().width * viewScale.get()}px`);
  const surfaceHeight = Cell.derived(() => `${viewport.get().height * viewScale.get()}px`);
  const canInput = Cell.derived(() => state.get() === "live" && hasFrame.get());
  const cannotInput = Cell.derived(() => !canInput.get());
  const viewportFor = (id: string) =>
    knownViewports.get(id) ??
    props.tabs.get().find((item) => item.tab === id)?.viewport ??
    PRESETS.laptop;
  const updateViewport = (size: Size, id = selected.get()) => {
    if (size.width < 1 || size.height < 1) return;
    knownViewports.set(id, size);
    if (selected.get() !== id) return;
    const previous = viewport.get();
    if (sameSize(previous, size)) return;
    // A metadata/resize update must not stretch an old JPEG to new geometry.
    if (hasFrame.get() && !sameSize(paintedViewport, size)) {
      requiredFrameSize = size;
      hasFrame.set(false);
    }
    viewport.set(size);
    props.onViewportChange?.(size);
  };

  const paintFrames = async () => {
    if (painting) return;
    painting = true;
    try {
      while (pendingFrame && !disposed) {
        const next = pendingFrame;
        pendingFrame = null;
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(next.jpeg);
        } catch {
          // An incomplete or invalid JPEG must not clear the last good frame.
          continue;
        }
        try {
          // A newer JPEG supersedes this one, including across tab changes.
          if (
            next.generation !== generation ||
            pendingFrame ||
            (requiredFrameSize && !sameSize(requiredFrameSize, next.size))
          )
            continue;
          const canvas = picture.get();
          if (!canvas) {
            pendingFrame = next;
            break;
          }
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) continue;
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          context.drawImage(bitmap, 0, 0);
          paintedViewport = next.size;
          requiredFrameSize = null;
          updateViewport(next.size);
          hasFrame.set(true);
          window.clearTimeout(connectionStatusTimer);
          window.clearTimeout(firstFrameTimer);
          connectionStatusTimer = undefined;
          firstFrameTimer = undefined;
          connectionStatusVisible.set(false);
          state.set("live");
          connectingAttempts = 0;
        } finally {
          bitmap.close();
        }
      }
    } finally {
      painting = false;
    }
  };
  picture.listen((canvas) => {
    if (canvas && pendingFrame) void paintFrames();
  });

  const clearTransport = () => {
    window.clearTimeout(retry);
    window.clearTimeout(connectionStatusTimer);
    window.clearTimeout(firstFrameTimer);
    retry = undefined;
    connectionStatusTimer = undefined;
    firstFrameTimer = undefined;
    if (socket !== null) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
      socket = null;
    }
  };

  const send = (input: Record<string, unknown>) => {
    if (socket?.readyState !== WebSocket.OPEN || state.get() !== "live") return;
    socket.send(JSON.stringify(input));
  };
  // Line breaks become Enter presses; the server accepts at most 4096 characters per text event.
  const sendText = (text: string) => {
    text.split(/\r\n|\r|\n/).forEach((line, index) => {
      if (index > 0) send({ type: "key", key: "Enter" });
      for (let start = 0; start < line.length; start += 4096)
        send({ type: "text", text: line.slice(start, start + 4096) });
    });
  };
  const resetField = (field: HTMLTextAreaElement) => {
    field.value = SENTINEL;
    field.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const fieldText = (field: HTMLTextAreaElement) => field.value.split(SENTINEL).join("");
  keyboard.listen((field) => {
    if (field) resetField(field);
  });

  const connect = (tabId: string) => {
    if (!visible.get()) {
      state.set("reconnecting");
      return;
    }
    generation += 1;
    const turn = generation;
    clearTransport();
    if (tabId === "") {
      props.onClose();
      return;
    }
    state.set(connectingAttempts === 0 ? "connecting" : "reconnecting");
    connectionStatusVisible.set(false);
    connectionStatusTimer = window.setTimeout(() => {
      if (!disposed && turn === generation && state.get() !== "live")
        connectionStatusVisible.set(true);
    }, 300);
    const ws = new WebSocket(browserSocketUrl(props.kind, props.id, tabId));
    ws.binaryType = "arraybuffer";
    socket = ws;
    // A successful handshake is not proof that Chromium is sending frames.
    // Retry instead of leaving the connecting overlay visible indefinitely.
    firstFrameTimer = window.setTimeout(() => {
      if (!disposed && turn === generation && state.get() !== "live") ws.close();
    }, 8000);
    ws.onmessage = (event) => {
      if (disposed || turn !== generation) return;
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.event === "input_error") {
            status.set(message.message ?? "Browser input was rejected.");
          } else if (message.event === "input_result") {
            status.set(null);
            if (isSize(message.result?.viewport)) {
              // Resize acknowledgement and frame delivery are independent.
              // Do not blank a new frame if it has already arrived.
              const next = message.result.viewport;
              if (!sameSize(paintedViewport, next)) {
                requiredFrameSize = next;
                hasFrame.set(false);
                if (pendingFrame && !sameSize(pendingFrame.size, next)) pendingFrame = null;
              }
              updateViewport(next);
              void props.onRefresh();
            }
            // Native mobile keyboard entry, without changing the remote viewport.
            if (message.result?.focus && window.matchMedia("(pointer: coarse)").matches)
              keyboard.get()?.focus();
          }
        } catch {
          /* Only the server's structured events are accepted. */
        }
        return;
      }
      const bytes = event.data;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength <= 8) return;
      const view = new DataView(bytes);
      const size = { width: view.getUint32(0), height: view.getUint32(4) };
      if (!isSize(size) || (requiredFrameSize && !sameSize(requiredFrameSize, size))) return;
      pendingFrame = {
        jpeg: new Blob([bytes.slice(8)], { type: "image/jpeg" }),
        size,
        generation: turn,
      };
      void paintFrames();
    };
    const disconnected = (event: CloseEvent) => {
      if (disposed || turn !== generation) return;
      // An intentionally closed tab is not a lost network connection. The
      // membership update can race this close frame, so refresh immediately.
      if (event.code === TAB_CLOSED_CODE) {
        void props.onRefresh();
        return;
      }
      if (props.tabs.get().every((entry) => entry.tab !== tabId)) {
        void props.onRefresh();
        return;
      }
      connectingAttempts += 1;
      if (connectingAttempts > 5) {
        connectionStatusVisible.set(true);
        state.set("offline");
        return;
      }
      state.set("reconnecting");
      retry = window.setTimeout(() => connect(tabId), 1200 * Math.min(connectingAttempts, 4));
    };
    ws.onclose = disconnected;
    ws.onerror = () => ws.close();
  };

  const changeTab = (id: string) => {
    if (selected.get() === id) return;
    selected.set(id);
    connectingAttempts = 0;
    zoom.set(false);
    overview.set(false);
    status.set(null);
    pendingFrame = null;
    paintedViewport = null;
    requiredFrameSize = null;
    hasFrame.set(false);
    updateViewport(viewportFor(id), id);
    connect(id);
  };

  const coordinate = (clientX: number, clientY: number) => {
    const image = picture.get();
    if (!image) return null;
    const r = image.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const size = viewport.get();
    const x = ((clientX - r.left) * size.width) / r.width;
    const y = ((clientY - r.top) * size.height) / r.height;
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
    return { x, y, width: size.width, height: size.height };
  };
  const click = (event: MouseEvent) => {
    const point = coordinate(event.clientX, event.clientY);
    if (!point) return;
    send({ type: "click", ...point });
    // Desktop typing also goes through the hidden field, where IMEs and dead keys compose.
    if (!window.matchMedia("(pointer: coarse)").matches)
      keyboard.get()?.focus({ preventScroll: true });
  };
  const flushWheel = () => {
    wheelTimer = undefined;
    const latest = bufferedWheel;
    bufferedWheel = null;
    if (latest) send({ type: "wheel", ...latest });
  };
  const queueWheel = (coords: PointerPacket, dx: number, dy: number) => {
    const compatible =
      bufferedWheel?.width === coords.width && bufferedWheel?.height === coords.height;
    const limit = (n: number) => Math.max(-3000, Math.min(3000, n));
    bufferedWheel = {
      ...coords,
      dx: limit((compatible ? bufferedWheel!.dx : 0) + dx),
      dy: limit((compatible ? bufferedWheel!.dy : 0) + dy),
    };
    if (wheelTimer === undefined) wheelTimer = window.setTimeout(flushWheel, 16);
  };
  const wheel = (event: WheelEvent) => {
    if (zoom.get() || !canInput.get()) return;
    const rect = picture.get()?.getBoundingClientRect();
    if (!rect) return;
    const point = coordinate(
      Math.max(rect.left, Math.min(event.clientX, rect.right - 1)),
      Math.max(rect.top, Math.min(event.clientY, rect.bottom - 1)),
    );
    if (!point) return;
    event.preventDefault();
    queueWheel(point, event.deltaX, event.deltaY);
  };
  const touchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) {
      touchX = touch.clientX;
      touchY = touch.clientY;
    }
  };
  const touchMove = (event: TouchEvent) => {
    const count = event.touches.length;
    if ((zoom.get() && count !== 2) || (!zoom.get() && count !== 1)) return;
    const point = event.touches[0];
    if (!point) return;
    const x = point.clientX,
      y = point.clientY;
    const dx = (touchX - x) * 1.7,
      dy = (touchY - y) * 1.7;
    touchX = x;
    touchY = y;
    const rect = picture.get()?.getBoundingClientRect();
    if (!rect) return;
    const coords = coordinate(
      Math.max(rect.left, Math.min(x, rect.right - 1)),
      Math.max(rect.top, Math.min(y, rect.bottom - 1)),
    );
    if (!coords || !canInput.get()) return;
    event.preventDefault();
    queueWheel(coords, dx, dy);
  };
  // Windows reports AltGr as Ctrl+Alt, but AltGr keys type characters (@, €, { on many layouts).
  const isShortcut = (event: KeyboardEvent) =>
    event.metaKey || (event.ctrlKey && !event.getModifierState("AltGraph"));
  // Used only while the stage itself has focus, e.g. after keyboard navigation.
  const keyDown = (event: KeyboardEvent) => {
    if (!canInput.get() || event.isComposing || isShortcut(event)) return;
    if (event.key.length === 1) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    } else if (FORWARDED_KEYS.has(event.key)) {
      event.preventDefault();
      send({ type: "key", key: event.key });
    }
  };
  const fieldKeyDown = (event: KeyboardEvent) => {
    // keyCode 229: an IME or soft keyboard owns this key; its result arrives as input.
    if (!canInput.get() || event.isComposing || event.keyCode === 229 || isShortcut(event)) return;
    if (!FORWARDED_KEYS.has(event.key)) return;
    event.preventDefault();
    send({ type: "key", key: event.key });
  };
  const fieldInput = (event: Event) => {
    const field = event.currentTarget as HTMLTextAreaElement;
    const input = event as InputEvent;
    // Gboard composes nearly every word. Clearing the field mid-composition
    // desynchronizes it and repeats letters, so wait for compositionend.
    if (composing || input.isComposing) return;
    if (input.inputType === "deleteContentBackward") send({ type: "key", key: "Backspace" });
    else if (input.inputType === "deleteContentForward") send({ type: "key", key: "Delete" });
    else if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph")
      send({ type: "key", key: "Enter" });
    else sendText(fieldText(field));
    resetField(field);
  };
  const fieldCompositionStart = () => {
    composing = true;
  };
  const fieldCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    const field = event.currentTarget as HTMLTextAreaElement;
    // Reading the field (not event.data) keeps this idempotent with Firefox's
    // trailing input event, which then finds only the sentinel.
    sendText(fieldText(field));
    resetField(field);
  };
  const chooseSize = (value: string) => {
    if (value === "fit" || value === "zoom") {
      zoom.set(value === "zoom");
      return;
    }
    if (value === "reset") {
      const base = tab.get()?.defaultViewport;
      if (base) send({ type: "resize", ...base });
    } else if (value === "match") {
      const area = stage.get();
      if (!area) return;
      send({
        type: "resize",
        width: Math.max(240, Math.min(3840, area.clientWidth)),
        height: Math.max(240, Math.min(3840, area.clientHeight)),
      });
    } else if (PRESETS[value]) {
      send({ type: "resize", ...PRESETS[value] });
    }
  };
  const closing = Cell.task(async (id: string) => {
    await closeBrowserTab(props.kind, props.id, id);
    // Update the tab strip immediately; a subsequent refresh reconciles popups.
    props.tabs.set(props.tabs.get().filter((entry) => entry.tab !== id));
    await props.onRefresh();
  });
  const remove = (id: string) => closing.runWith(id);
  const detachError = Cell.derived(() => closing.error.get()?.message ?? null);

  const refresh = () => {
    connectingAttempts = 0;
    connect(selected.get());
  };
  const showKeyboard = () => keyboard.get()?.focus();

  visible.listen((isVisible) => {
    if (!isVisible) {
      generation += 1;
      clearTransport();
      state.set("reconnecting");
    } else if (selected.get() !== "") {
      // Background/foreground never activates a native headed browser window.
      connect(selected.get());
    }
  });
  props.tabs.listen((latest) => {
    if (disposed) return;
    const ids = new Set(latest.map((item) => item.tab));
    for (const id of knownViewports.keys()) if (!ids.has(id)) knownViewports.delete(id);
    for (const item of latest) {
      if (item.viewport) {
        knownViewports.set(item.tab, item.viewport);
        if (item.tab === selected.get()) updateViewport(item.viewport);
      }
    }
    if (latest.length && !ids.has(selected.get())) {
      changeTab(latest[0].tab);
    } else if (!latest.length) {
      clearTransport();
      selected.set("");
      props.onClose();
    }
  });
  onSetup(() => {
    // Viewing a stream never activates the separate native browser window.
    connect(selected.get());

    return () => {
      disposed = true;
      generation += 1;
      clearTransport();
      window.clearTimeout(wheelTimer);
      wheelTimer = undefined;
      bufferedWheel = null;
      pendingFrame = null;
      paintedViewport = null;
      requiredFrameSize = null;
    };
  });

  useResizeObserver([stage], () => {
    const element = stage.get();
    if (element !== null) {
      availableWidth.set(element.clientWidth);
      availableHeight.set(element.clientHeight);
    }
  });

  return {
    stage,
    picture,
    keyboard,
    selected,
    state,
    connectionStatusVisible,
    status,
    overview,
    zoom,
    hasFrame,
    viewport,
    tab,
    currentSize,
    viewportChanged,
    surfaceWidth,
    surfaceHeight,
    canInput,
    cannotInput,
    connect,
    changeTab,
    click,
    wheel,
    touchStart,
    touchMove,
    keyDown,
    fieldKeyDown,
    fieldInput,
    fieldCompositionStart,
    fieldCompositionEnd,
    chooseSize,
    remove,
    refresh,
    send,
    detachError,
    showKeyboard,
  };
}
