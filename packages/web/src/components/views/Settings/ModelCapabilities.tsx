import { Textarea } from "innate-ui";
import { Cell, If, type SourceCell } from "retend";
import { Icon } from "squire-ui";

import classes from "./Providers.module.css";

/** Parse token counts with optional separators; return NaN for invalid input. */
export function parseTokens(text: string) {
  const digits = text.replace(/[,\s_]/g, "");
  if (!/^\d+$/.test(digits)) {
    return Number.NaN;
  }
  return Number(digits);
}

/** Format a token count with US thousands separators. */
export function groupTokens(count: number) {
  return count.toLocaleString("en-US");
}

interface TokenFieldProps {
  label: string;
  value: SourceCell<string>;
  min: number;
  /** Field error set on blur and revalidated on submit. */
  error: SourceCell<string | null>;
}

/** Format token counts with separators and validate on blur. */
function TokenField(props: TokenFieldProps) {
  const { label, value, min, error } = props;
  const errorId = `token-error-${crypto.randomUUID()}`;
  const invalid = Cell.derived(() => {
    return error.get() !== null;
  });

  const check = () => {
    const count = parseTokens(value.get());
    if (Number.isNaN(count)) {
      error.set(`${label} must be a whole number of tokens.`);
      return;
    }
    if (count < min) {
      error.set(`${label} must be at least ${groupTokens(min)} tokens.`);
      return;
    }
    error.set(null);
    value.set(groupTokens(count));
  };

  return (
    <label class={classes.field}>
      <span class={classes.fieldLabel}>{label}</span>
      <span class={classes.inputFrame} data-invalid={invalid}>
        <input
          inputmode="numeric"
          required
          value={value}
          aria-invalid={invalid}
          aria-describedby={errorId}
          onInput={(event) => {
            value.set((event.currentTarget as HTMLInputElement).value);
          }}
          onBlur={check}
        />
        <span class={classes.inputUnit}>tokens</span>
      </span>
      <span id={errorId} class={classes.fieldError} role="alert">
        {If(error, (message) => {
          return message;
        })}
      </span>
    </label>
  );
}

export interface ModelCapabilityFields {
  contextWindow: SourceCell<string>;
  maxOutput: SourceCell<string>;
  options: SourceCell<string>;
  contextError: SourceCell<string | null>;
  outputError: SourceCell<string | null>;
  optionsError: SourceCell<string | null>;
}

interface ModelCapabilitiesProps {
  fields: ModelCapabilityFields;
}

/** Model token limits and advanced provider options. */
export function ModelCapabilities(props: ModelCapabilitiesProps) {
  const { fields } = props;
  const { contextWindow, maxOutput, options } = fields;
  const showAdvanced = Cell.source(false);
  const optionsInvalid = Cell.derived(() => {
    return fields.optionsError.get() !== null;
  });

  const checkOptions = () => {
    const text = options.get().trim();
    if (text === "") {
      fields.optionsError.set(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      fields.optionsError.set(isObject ? null : "Provider options must be a JSON object.");
    } catch {
      fields.optionsError.set("Provider options must be valid JSON.");
    }
  };

  return (
    <>
      <section class={classes.section}>
        <header class={classes.sectionHeader}>
          <h3>Limits</h3>
          <p>From the model catalog. Change them for a custom deployment.</p>
        </header>
        <div class={classes.fieldGrid}>
          <TokenField
            label="Context window"
            value={contextWindow}
            min={2}
            error={fields.contextError}
          />
          <TokenField
            label="Longest response"
            value={maxOutput}
            min={1}
            error={fields.outputError}
          />
        </div>
      </section>
      <button
        type="button"
        class={classes.disclosure}
        aria-expanded={showAdvanced}
        onClick={() => {
          showAdvanced.set(!showAdvanced.get());
        }}
      >
        <Icon name="caret" aria-hidden="true" />
        Advanced
      </button>
      {If(showAdvanced, () => {
        return (
          <section class={classes.section}>
            <header class={classes.sectionHeader}>
              <h3>Provider options</h3>
              <p>JSON sent with each request, such as reasoning_effort.</p>
            </header>
            <Textarea
              class={[classes.input, classes.codeInput]}
              rows={5}
              value={options}
              placeholder='{ "reasoning_effort": "high" }'
              aria-label="Provider options"
              aria-invalid={optionsInvalid}
              onInput={(event) => {
                options.set((event.currentTarget as HTMLTextAreaElement).value);
              }}
              onBlur={checkOptions}
            />
            <span class={classes.fieldError} role="alert">
              {If(fields.optionsError, (message) => {
                return message;
              })}
            </span>
          </section>
        );
      })}
    </>
  );
}
