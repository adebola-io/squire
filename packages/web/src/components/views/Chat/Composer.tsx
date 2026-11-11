import { Textarea } from "innate-ui";
import { Cell, If, onSetup, type SourceCell } from "retend";
import { Icon } from "squire-ui";

import { BrowserResource } from "@/components/browser/BrowserResource";
import type { AttachmentInput } from "@/platform/desktopClient";
import { useBrowserPresence } from "@/scopes/BrowserPresenceScope";
import { useChat } from "@/scopes/ChatScope";

import { BackgroundJobs } from "./BackgroundJobs";
import { ComposerAttachments, AttachmentChooser } from "./ComposerAttachments";

import classes from "./Chat.module.css";

/** Session-storage prefix for a conversation's unsent draft. */
const DRAFT_PREFIX = "chat-draft:";

interface ImageDimensions {
  width: number;
  height: number;
}

/** Read the original image's dimensions before sending, so transcript tiles can reserve space. */
async function imageDimensions(file: File): Promise<ImageDimensions | null> {
  if (!file.type.startsWith("image/")) return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      image.onload = () =>
        resolve(
          image.naturalWidth > 0 && image.naturalHeight > 0
            ? { width: image.naturalWidth, height: image.naturalHeight }
            : null,
        );
      image.onerror = () => resolve(null);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface PendingSend {
  key: string;
  draftKey: string;
  draft: string;
  attachments: AttachmentInput[];
}

/** Composer draft state and keyboard/submit handlers. */
function useComposerInput() {
  const { send, selectedId, snapshot, busy, acceptedMessageKey } = useChat();
  // Conversation the composer is drafting for. Drafts are stored per conversation, so switching
  // chats shows that conversation's own text instead of copying one draft between them.
  const owner = Cell.derived(() => {
    return selectedId.get() ?? "new";
  });
  const drafts = new Map<string, SourceCell<string>>();
  const draftFor = (key: string) => {
    const existing = drafts.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = Cell.source(sessionStorage.getItem(DRAFT_PREFIX + key) ?? "");
    // Persist every change so a reload restores each draft to its own conversation.
    created.listen((text) => {
      if (text === "") {
        sessionStorage.removeItem(DRAFT_PREFIX + key);
      } else {
        sessionStorage.setItem(DRAFT_PREFIX + key, text);
      }
    });
    drafts.set(key, created);
    return created;
  };
  const draft = Cell.derived(() => {
    return draftFor(owner.get()).get();
  });
  const setDraft = (text: string) => {
    draftFor(owner.get()).set(text);
  };
  const attachments = Cell.source<AttachmentInput[]>([]);
  // Attachments belong to the composer, not to a conversation, so leave them behind.
  selectedId.listen(() => {
    attachments.set([]);
  });
  // The submission awaiting acknowledgement. It stays until the HTTP request succeeds or an
  // event carrying its key arrives, so a failed send leaves the composer intact.
  let pending: PendingSend | null = null;
  const clearSubmitted = (record: PendingSend) => {
    if (pending !== record) return;
    pending = null;
    const draftCell = draftFor(record.draftKey);
    const typed = draftCell.get();
    if (typed === record.draft) {
      draftCell.set("");
    } else if (record.draft !== "" && typed.startsWith(record.draft)) {
      draftCell.set(typed.slice(record.draft.length).trimStart());
    }
    const current = attachments.get();
    attachments.set(
      current === record.attachments
        ? []
        : current.filter((attachment) => !record.attachments.includes(attachment)),
    );
  };
  acceptedMessageKey.listen((key) => {
    const record = pending;
    if (key !== null && record !== null && key === record.key) {
      clearSubmitted(record);
    }
  });
  const upload = Cell.task(async (files: File[]) => {
    const conversationId = selectedId.get();
    const existing = attachments.get();
    const size = files.reduce((total, file) => {
      return total + file.size;
    }, 0);
    const existingSize = existing.reduce((total, file) => {
      return total + file.data.length * 0.75;
    }, 0);
    if (
      existing.length + files.length > 16 ||
      files.some((file) => {
        return file.size > 16 * 1024 * 1024;
      }) ||
      size + existingSize > 32 * 1024 * 1024
    ) {
      throw new Error("Attach up to 16 files, 16 MiB per file and 32 MiB total.");
    }
    const loaded = await Promise.all(
      files.map(async (file): Promise<AttachmentInput> => {
        const [data, dimensions] = await Promise.all([
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
            reader.readAsDataURL(file);
          }),
          imageDimensions(file),
        ]);
        return {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data,
          ...dimensions,
        };
      }),
    );
    if (selectedId.get() === conversationId) {
      attachments.set([...existing, ...loaded]);
    }
  });
  const hasDraft = Cell.derived(() => {
    return draft.get().trim() !== "" || attachments.get().length > 0;
  });

  const submit = async (event: SubmitEvent | undefined) => {
    if (!event) {
      return;
    }
    const submittedKey = owner.get();
    const submittedDraft = draft.get();
    const text = submittedDraft.trim();
    const submittedAttachments = attachments.get();
    if (text === "" && submittedAttachments.length === 0) {
      return;
    }
    // Ignore Enter while a send is pending so the current draft is not lost.
    if (
      upload.pending.get() ||
      busy.get() ||
      (selectedId.get() !== null && snapshot.get()?.conversation.id !== selectedId.get())
    ) {
      return;
    }
    // Retrying the same unchanged submission reuses its key, so a Message the server already
    // stored is returned instead of duplicated.
    let key: string = crypto.randomUUID();
    if (
      pending !== null &&
      pending.draftKey === submittedKey &&
      pending.draft === submittedDraft &&
      pending.attachments === submittedAttachments
    ) {
      key = pending.key;
    }
    const record: PendingSend = {
      key,
      draftKey: submittedKey,
      draft: submittedDraft,
      attachments: submittedAttachments,
    };
    pending = record;
    const sent = await send(text, submittedAttachments, key);
    if (sent) {
      clearSubmitted(record);
    }
  };

  const trackDraft = (event: Event) => {
    setDraft((event.currentTarget as HTMLTextAreaElement).value);
  };

  const sendOnEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    // Enter sends; Shift+Enter keeps the textarea's newline.
    event.preventDefault();
    const textarea = event.currentTarget as HTMLTextAreaElement;
    textarea.form?.requestSubmit();
  };

  return { draft, setDraft, hasDraft, submit, trackDraft, sendOnEnter, attachments, upload };
}

/**
 * Extract dragged text from the first URI, image/link target, or plain-text payload, in that
 * order.
 */
const droppedText = (transfer: DataTransfer): string | null => {
  const uriEntry = transfer
    .getData("text/uri-list")
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .find((line) => {
      return line !== "" && !line.startsWith("#");
    });
  const markup = transfer.getData("text/html").match(/<(img|a)[^>]+?(?:src|href)="([^"]+)"/i);
  return uriEntry ?? markup?.[2] ?? (transfer.getData("text/plain").trim() || null);
};

/** Composer input and attachment controls. */
function useComposerForm() {
  const { stop, busy, sending, snapshot, error, selectedId } = useChat();
  // Choose a placeholder for the current chat state.
  const placeholder = Cell.derived(() => {
    return selectedId.get() === null ? "How can I help you today?" : "Reply to Squire…";
  });
  const { draft, setDraft, hasDraft, submit, trackDraft, sendOnEnter, attachments, upload } =
    useComposerInput();
  // A route can select the next chat before its snapshot arrives. Keep typing available,
  // but don't send using the previous conversation's model or show its execution controls.
  const conversationReady = Cell.derived(() => {
    const id = selectedId.get();
    return id === null || snapshot.get()?.conversation.id === id;
  });
  const disabled = Cell.derived(() => {
    return busy.get() || upload.pending.get() || !conversationReady.get();
  });
  const inputRef = Cell.source<HTMLTextAreaElement | null>(null);
  const compacting = Cell.derived(() => {
    return snapshot.get()?.live?.kind === "compacting";
  });
  const isRunning = Cell.derived(() => {
    if (!conversationReady.get()) return false;
    const current = snapshot.get();
    return (
      current?.conversation.executionStatus === "running" ||
      compacting.get() ||
      (busy.get() && current?.live?.kind === "thinking")
    );
  });
  // Show Stop during execution when the draft is empty; otherwise show Send to queue a
  // follow-up. Also allow Stop while a send waits for compaction.
  const showsStop = Cell.derived(() =>
    !conversationReady.get()
      ? false
      : sending.get() && selectedId.get() !== null
        ? true
        : isRunning.get() && (busy.get() || !hasDraft.get()),
  );
  // The first home-screen send has no conversation to stop. Keep Send visible and disabled
  // until it completes.
  const sendingFirst = Cell.derived(() => {
    return sending.get() && selectedId.get() === null;
  });

  const onFiles = (files: File[]) => {
    if (files.length === 0 || upload.pending.get()) {
      return;
    }
    dropError.set(null);
    void upload.runWith(files);
  };

  // Error for a drop without files or usable text.
  const dropError = Cell.source<string | null>(null);
  const attachError = Cell.derived(() => {
    return upload.error.get()?.message ?? dropError.get();
  });

  // Track nested drag events to prevent the drop highlight from flickering over child elements.
  const dragging = Cell.source(false);
  let dragDepth = 0;

  // Leave drops handled by another surface, such as the plugin dropzone, to that surface.
  const claimed = (event: DragEvent) => {
    return event.defaultPrevented;
  };

  // Accept HTML and URI drag types because browsers may represent dragged images without file
  // payloads.
  const looksDroppable = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (types === undefined || types.length === 0) {
      return true;
    }
    return ["Files", "text/uri-list", "text/html", "text/plain"].some((flavor) => {
      return Array.prototype.includes.call(types, flavor);
    });
  };
  // Prevent file navigation and allow the composer to receive the drop.
  const onWindowDragOver = (event: DragEvent) => {
    if (claimed(event) || !looksDroppable(event)) {
      return;
    }
    event.preventDefault();
    if (event.type === "dragenter") {
      dragDepth += 1;
      dragging.set(true);
    } else if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const onWindowDragLeave = (event: DragEvent) => {
    if (event.relatedTarget === null) {
      // A null related target indicates the drag left the window.
      dragDepth = 0;
      dragging.set(false);
      return;
    }
    if (dragDepth === 0) {
      return;
    }
    dragDepth -= 1;
    if (dragDepth === 0) {
      dragging.set(false);
    }
  };
  // Handle file drops at window level and paste inside the composer. Prefer file payloads, then
  // insert dragged links or text. Preserve native text drops inside other inputs.
  const onWindowDrop = (event: DragEvent) => {
    if (claimed(event)) {
      return;
    }
    dragDepth = 0;
    dragging.set(false);
    const transfer = event.dataTransfer;
    if (transfer === null) {
      return;
    }
    const files = transfer.files.length
      ? Array.from(transfer.files)
      : Array.from(transfer.items ?? [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
    if (files.length > 0) {
      event.preventDefault();
      onFiles(files);
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]") !== null
    ) {
      return;
    }
    const text = droppedText(transfer);
    if (text === null) {
      if (Array.prototype.includes.call(transfer.types ?? [], "Files")) {
        event.preventDefault();
        dropError.set("That drop didn't contain any files to attach.");
      }
      return;
    }
    event.preventDefault();
    dropError.set(null);
    const current = draft.get();
    setDraft(current === "" ? text : `${current.replace(/\s+$/, "")}\n${text}`);
    const input = inputRef.get();
    if (input !== null) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };
  // Attach pasted files. Prevent default only for file-only payloads so mixed text pastes
  // retain native behavior.
  const onPaste = (event: ClipboardEvent) => {
    const files = event.clipboardData?.files;
    if (files === undefined || files.length === 0) {
      return;
    }
    if (event.clipboardData?.getData("text/plain") === "") {
      event.preventDefault();
    }
    onFiles(Array.from(files));
  };
  // Focus the composer synchronously on printable keydown outside other inputs and dialogs.
  // Preserve Enter, modified shortcuts and existing editable targets.
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable], [role="dialog"]') !== null
    ) {
      return;
    }
    const input = inputRef.get();
    if (input === null || document.activeElement === input) {
      return;
    }
    input.focus();
  };
  // Register window handlers after all referenced callbacks are initialized.
  onSetup(() => {
    const listening = new AbortController();
    const options = { signal: listening.signal };
    window.addEventListener("dragenter", onWindowDragOver, options);
    window.addEventListener("dragover", onWindowDragOver, options);
    window.addEventListener("dragleave", onWindowDragLeave, options);
    window.addEventListener("drop", onWindowDrop, options);
    window.addEventListener("keydown", onWindowKeyDown, options);
    return () => {
      listening.abort();
    };
  });
  return {
    stop,
    busy,
    error,
    draft,
    submit,
    trackDraft,
    sendOnEnter,
    attachments,
    upload,
    disabled,
    inputRef,
    showsStop,
    sendingFirst,
    compacting,
    onFiles,
    dragging,
    onPaste,
    attachError,
    placeholder,
  };
}

const errorLine = (message: string) => {
  return (
    <p class={classes.composerError} role="alert" title={message}>
      {message}
    </p>
  );
};

/** Keep send/stop state rendering separate from the persistent composer layout. */
interface ComposerSendProps {
  form: ReturnType<typeof useComposerForm>;
}

function ComposerSend(props: ComposerSendProps) {
  const { form } = props;
  return (
    <span class={classes.composerSend}>
      {If(form.showsStop, {
        true: () => (
          <span class={classes.stopLoader}>
            <button
              type="button"
              class={[classes.sendButton, classes.stopButton]}
              onClick={form.stop}
              title="Stop"
            >
              <Icon name="stop" aria-hidden="true" />
            </button>
          </span>
        ),
        false: () =>
          If(form.sendingFirst, {
            true: () => (
              <span class={classes.stopLoader}>
                <button type="submit" class={classes.sendButton} disabled title="Sending…">
                  <Icon name="arrow" aria-hidden="true" />
                </button>
              </span>
            ),
            false: () => (
              <button
                type="submit"
                class={classes.sendButton}
                disabled={form.disabled}
                title="Send"
              >
                <Icon name="arrow" aria-hidden="true" />
              </button>
            ),
          }),
      })}
    </span>
  );
}

/**
 * One composer remains mounted across the home introduction and conversations. Its per-chat
 * drafts, attachments, input node and event listeners survive transcript changes.
 */
export function Composer() {
  const { selectedId } = useChat();
  const presence = useBrowserPresence();
  const selectedBrowserId = Cell.derived(() => {
    const id = selectedId.get();
    return id !== null && presence.get().conversations.includes(id) ? id : null;
  });
  const form = useComposerForm();
  const { draft, upload, disabled, compacting } = form;
  const entrance = "true";
  return (
    <form
      class={classes.composer}
      data-entrance={entrance}
      data-dragging={form.dragging}
      onPaste={form.onPaste}
      onSubmit--prevent={form.submit}
      aria-busy={form.busy}
    >
      {If(form.error, errorLine)}
      <div class={classes.composerIndicators}>
        <BackgroundJobs />
        <div class={classes.composerResource}>
          {If(selectedBrowserId, (id) => (
            <BrowserResource kind="conversation" id={id} />
          ))}
        </div>
      </div>
      {If(form.attachError, errorLine)}
      {If(compacting, () => {
        return (
          <p class={classes.composerStatus} role="status">
            Summarizing earlier messages so this chat fits the model…
          </p>
        );
      })}
      {/* Place attachments above the composer. */}
      <ComposerAttachments
        attachments={form.attachments}
        disabled={disabled}
        reading={upload.pending}
      />
      <div class={classes.composerField}>
        <Textarea
          ref={form.inputRef}
          class={classes.composerInput}
          name="message"
          value={draft}
          rows={1}
          placeholder={form.placeholder}
          aria-label="Message Squire"
          autoFocus
          onInput={form.trackDraft}
          onKeyDown={form.sendOnEnter}
        />
        <ComposerSend form={form} />
      </div>
      <AttachmentChooser disabled={disabled} onFiles={form.onFiles} />
    </form>
  );
}
