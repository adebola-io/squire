import { Cell, If, onConnected, type SourceCell } from "retend";
import { Button, Field, Icon, Input } from "squire-ui";

import { ICON_TYPES, iconProblem, isSvgMarkup, readDataUrl, svgBlob } from "./pluginIconSource";

import classes from "./Plugins.module.css";

interface PluginModalMcpReviewIconProps {
  /** Icon source saved with the plugin: a URL or data URI. */
  iconSrc: SourceCell<string>;
  iconFailed: SourceCell<boolean>;
  suggestedIconSrc: string | null | undefined;
}

/**
 * Resolve URL input, pasted SVG, or an uploaded file to an image source. Convert SVG and files
 * to data URIs and track validation errors.
 */
function useIconSource(props: PluginModalMcpReviewIconProps) {
  const { iconSrc, iconFailed, suggestedIconSrc } = props;
  const entry = Cell.source(suggestedIconSrc ?? "");
  const uploaded = Cell.source<string | null>(null);
  const problem = Cell.source<string | null>(null);
  const message = Cell.derived(() => {
    if (problem.get() !== null) return problem.get();
    return iconFailed.get()
      ? "This image didn't load, so Squire will show the default icon."
      : null;
  });
  // Discard image reads superseded by a newer selection.
  let attempt = 0;

  const use = (src: string, file: string | null) => {
    problem.set(null);
    iconFailed.set(false);
    uploaded.set(file);
    iconSrc.set(src);
  };
  const load = async (blob: Blob, file: string | null) => {
    const current = ++attempt;
    const issue = iconProblem(blob.type, blob.size);
    if (issue !== null) {
      problem.set(issue);
      return;
    }
    const src = await readDataUrl(blob);
    if (current === attempt) use(src, file);
  };
  const fromEntry = (text: string) => {
    if (isSvgMarkup(text)) {
      void load(svgBlob(text), null);
      return;
    }
    attempt += 1;
    use(text, null);
  };

  return {
    entry,
    uploaded,
    message,
    onEntryInput(event: Event) {
      const text = (event.currentTarget as HTMLInputElement).value;
      entry.set(text);
      fromEntry(text.trim());
    },
    onFileChange(event: Event) {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      // Reset the file input so selecting the same file fires another change event.
      input.value = "";
      if (file !== undefined) void load(file, file.name);
    },
    /** Restore the text-field source after removing the uploaded file. */
    clearUpload() {
      fromEntry(entry.get().trim());
    },
  };
}

interface UploadedIconProps {
  name: string;
  onClear: () => void;
}

/** Uploaded-file summary shown in place of the source field. */
function UploadedIcon(props: UploadedIconProps) {
  const { name, onClear } = props;
  return (
    <div class={classes.mcpReviewIconFile}>
      <Icon name="upload" aria-hidden="true" />
      <span title={name}>{name}</span>
      <button
        type="button"
        class={classes.mcpReviewIconClear}
        title="Remove uploaded icon"
        aria-label="Remove uploaded icon"
        onClick={onClear}
      >
        <Icon name="cancel" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Accept an icon URL, pasted SVG, or an image file. Store the resolved source in a hidden input
 * while keeping data URIs out of the visible field.
 */
export function PluginModalMcpReviewIcon(props: PluginModalMcpReviewIconProps) {
  const { iconSrc } = props;
  const fileRef = Cell.source<HTMLInputElement | null>(null);
  const icon = useIconSource(props);
  const invalid = Cell.derived(() => icon.message.get() !== null);

  const pickFile = () => {
    fileRef.get()?.click();
  };

  // Restrict file selection to supported icon formats.
  onConnected(fileRef, (input) => {
    input.accept = ICON_TYPES.join(",");
  });

  return (
    <Field id="mcp-plugin-icon" invalid={invalid}>
      <Field.Label>Icon</Field.Label>
      <div class={classes.mcpReviewIconSource}>
        {If(icon.uploaded, {
          true: (name) => <UploadedIcon name={name} onClear={icon.clearUpload} />,
          false: () => (
            <Input
              name="mcp-plugin-icon-entry"
              type="text"
              value={icon.entry}
              placeholder="https://example.com/icon.svg or paste <svg>"
              spellcheck={false}
              onInput={icon.onEntryInput}
            />
          ),
        })}
        <Button type="button" variant="outline" onClick={pickFile}>
          Upload
        </Button>
      </div>
      <input ref={fileRef} type="file" hidden onChange={icon.onFileChange} />
      <input type="hidden" name="mcp-plugin-icon" value={iconSrc} />
      {If(icon.message, (text) => (
        <Field.ErrorMessage>{text}</Field.ErrorMessage>
      ))}
    </Field>
  );
}
