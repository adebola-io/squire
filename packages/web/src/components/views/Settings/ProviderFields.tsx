import { Cell, For, If, type SourceCell } from "retend";

import { Select } from "@/components/ui/Select";

import { ProviderCredentials } from "./ProviderCredentials";
import { BuiltinHint, CheckedField } from "./ProviderFieldParts";

import classes from "./Providers.module.css";

export interface ProviderFieldErrors {
  name: Cell<string | null>;
  url: Cell<string | null>;
  checkName: () => boolean;
  checkUrl: () => boolean;
}

export interface ProviderFieldState {
  displayName: SourceCell<string>;
  kind: SourceCell<string>;
  baseUrl: SourceCell<string>;
  secret: SourceCell<string>;
  header: SourceCell<string>;
}

interface ProviderFieldsProps {
  fields: ProviderFieldState;
  errors: ProviderFieldErrors;
  existing: boolean;
}

export const PROVIDER_KINDS = [
  { id: "custom", label: "Custom", url: "" },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1" },
  { id: "responses", label: "OpenAI Responses", url: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", url: "https://api.anthropic.com" },
  {
    id: "google",
    label: "Google",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  { id: "xai", label: "xAI", url: "https://api.x.ai/v1" },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com" },
  { id: "glm", label: "GLM", url: "https://api.z.ai/api/paas/v4" },
  { id: "meta", label: "Meta", url: "https://api.meta.ai/v1" },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { id: "opencode-zen", label: "OpenCode Zen", url: "https://opencode.ai/zen/v1" },
  { id: "opencode", label: "OpenCode Go", url: "https://opencode.ai/zen/go/v1" },
  { id: "chatCompletions", label: "Chat Completions", url: "" },
];

export function ProviderFields(props: ProviderFieldsProps) {
  const { fields, errors, existing } = props;
  const { displayName, kind, baseUrl } = fields;
  const kinds = PROVIDER_KINDS.map((item) => {
    const selected = Cell.derived(() => {
      return kind.get() === item.id;
    });
    return { ...item, selected };
  });

  // Autofill the default URL and new-provider name on service changes unless manually edited.
  // Existing names are edited separately.
  const chooseKind = (event: Event) => {
    const previous = PROVIDER_KINDS.find((item) => {
      return item.id === kind.get();
    });
    const value = (event.currentTarget as HTMLSelectElement).value;
    const next = PROVIDER_KINDS.find((item) => {
      return item.id === value;
    });
    if (next === undefined) {
      return;
    }
    if (baseUrl.get() === "" || baseUrl.get() === previous?.url) {
      baseUrl.set(next.url);
    }
    if (!existing && (displayName.get() === "" || displayName.get() === previous?.label)) {
      displayName.set(next.label);
    }
    kind.set(next.id);
  };

  return (
    <>
      <div class={classes.fieldGrid}>
        <label class={classes.field}>
          <span class={classes.fieldLabel}>Service</span>
          <Select class={classes.input} onChange={chooseKind}>
            {For(
              kinds,
              (item) => {
                return (
                  <option value={item.id} selected={item.selected}>
                    {item.label}
                  </option>
                );
              },
              { key: "id" },
            )}
          </Select>
        </label>
        {If(!existing, () => {
          return (
            <CheckedField
              id="provider-name"
              label="Name"
              value={displayName}
              error={errors.name}
              onCheck={errors.checkName}
              placeholder="e.g. Personal OpenAI"
            />
          );
        })}
      </div>
      {If(!existing, () => {
        return <BuiltinHint kind={kind} />;
      })}
      <CheckedField
        id="provider-url"
        label="Base URL"
        type="url"
        value={baseUrl}
        error={errors.url}
        onCheck={errors.checkUrl}
        placeholder="https://api.example.com/v1"
      />
      <ProviderCredentials fields={fields} existing={existing} />
    </>
  );
}
