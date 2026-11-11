import type { DesktopSettingsValues } from "@/platform/desktopClient";

export type SettingKey =
  | `ports.${keyof DesktopSettingsValues["ports"]}`
  | `limits.${keyof DesktopSettingsValues["limits"]}`;

export interface SettingField {
  key: SettingKey;
  label: string;
  hint: string;
  kind: "text" | "url" | "number" | "toggle";
  min?: number;
  max?: number;
  /** Converts the user-facing unit to the persisted integer unit. */
  scale?: number;
  unit?: string;
}

export interface SettingGroup {
  heading: string;
  fields: readonly SettingField[];
}

export interface SettingsPageDefinition {
  title: string;
  subtitle?: string;
  groups: readonly SettingGroup[];
}

export const PAGES = {
  network: {
    title: "Network",
    subtitle: "How Squire connects with other applications.",
    groups: [
      {
        heading: "Server",
        fields: [
          {
            key: "ports.web",
            label: "Local web port",
            hint: "The loopback port for the passwordless Squire interface.",
            kind: "number",
            min: 1,
            max: 65535,
          },
        ],
      },
    ],
  },
  privacy: {
    title: "Security & data",
    groups: [
      {
        heading: "Connection history",
        fields: [
          {
            key: "limits.connectionPayloadRetentionDays",
            label: "Payload retention",
            hint: "Remove old connection payloads after this many days.",
            kind: "number",
            min: 1,
            unit: "days",
          },
        ],
      },
    ],
  },
  advanced: {
    title: "Advanced",
    groups: [
      {
        heading: "Execution",
        fields: [
          {
            key: "limits.commandTimeoutMs",
            label: "Command timeout",
            hint: "Time allowed for a command to complete.",
            kind: "number",
            scale: 1000,
            unit: "seconds",
          },
          {
            key: "limits.actionMaxRuntimeMs",
            label: "Plugin action timeout",
            hint: "Maximum runtime of an individual plugin action.",
            kind: "number",
            scale: 60000,
            unit: "minutes",
          },
          {
            key: "limits.commandOutputLimitBytes",
            label: "Command output limit",
            hint: "Maximum output captured from a command.",
            kind: "number",
            scale: 1000,
            unit: "kB",
          },
        ],
      },
      {
        heading: "Files & search",
        fields: [
          {
            key: "limits.maxFileSizeBytes",
            label: "Maximum file size",
            hint: "Largest file a tool can process.",
            kind: "number",
            scale: 1000,
            unit: "kB",
          },
          {
            key: "limits.maxReadFileSizeBytes",
            label: "Read size limit",
            hint: "Maximum file content a tool can read.",
            kind: "number",
            scale: 1000,
            unit: "kB",
          },
          {
            key: "limits.maxSearchLineLength",
            label: "Search line length",
            hint: "Maximum characters shown per matching line.",
            kind: "number",
            min: 1,
            unit: "chars",
          },
          {
            key: "limits.treeMaxResults",
            label: "Directory results",
            hint: "Maximum entries returned by a directory tree query.",
            kind: "number",
            min: 1,
            unit: "entries",
          },
        ],
      },
    ],
  },
} as const satisfies Record<string, SettingsPageDefinition>;

export type SettingsKind = keyof typeof PAGES;
export type DraftValues = Record<SettingKey, string | boolean>;

export function fieldsOf(definition: SettingsPageDefinition): SettingField[] {
  return definition.groups.flatMap((group) => [...group.fields]);
}

export function displayValue(field: SettingField, value: string | number | boolean): string {
  if (field.kind === "number" && field.scale !== undefined) {
    return String(Number(value) / field.scale);
  }
  return String(value);
}

/** Read nested settings through field paths without a separate flattened schema. */
export function settingValue(
  settings: DesktopSettingsValues,
  key: SettingKey,
): string | number | boolean {
  const [section, field] = key.split(".") as [keyof DesktopSettingsValues, string];
  const group = settings[section];
  return (group as unknown as Record<string, string | number | boolean>)[field];
}

export function makeDraft(
  settings: DesktopSettingsValues,
  definition: SettingsPageDefinition,
): DraftValues {
  const values = {} as DraftValues;
  for (const field of fieldsOf(definition)) {
    const saved = settingValue(settings, field.key);
    values[field.key] = typeof saved === "boolean" ? saved : displayValue(field, saved);
  }
  return values;
}

/**
 * Native constraints validate input ranges and required values. Check integer storage precision
 * after unit conversion.
 */
export function fieldError(field: SettingField, value: string | boolean): string | null {
  if (field.kind !== "number") return null;
  const stored = Number(value) * (field.scale ?? 1);
  if (!Number.isSafeInteger(stored)) return "Enter a number with a supported precision.";
  if (stored < 1) return "Enter a value greater than zero.";
  return null;
}

interface DraftChangesResult {
  changes: Partial<DesktopSettingsValues>;
  errors: Record<string, string>;
}

export function draftChanges(
  definition: SettingsPageDefinition,
  saved: DesktopSettingsValues,
  draft: DraftValues,
): DraftChangesResult {
  const changes: Partial<DesktopSettingsValues> = {};
  const errors: Record<string, string> = {};
  const baseline = makeDraft(saved, definition);
  for (const field of fieldsOf(definition)) {
    const current = draft[field.key];
    const problem = fieldError(field, current);
    if (problem !== null) {
      errors[field.key] = problem;
      continue;
    }
    if (String(current) === String(baseline[field.key])) {
      continue;
    }
    const value =
      field.kind === "number" ? Math.round(Number(current) * (field.scale ?? 1)) : current;
    const [section, property] = field.key.split(".");
    if (property !== undefined) {
      const sectionChanges = (changes as Record<string, Record<string, unknown>>)[section] ?? {};
      sectionChanges[property] = value;
      (changes as Record<string, Record<string, unknown>>)[section] = sectionChanges;
    } else {
      Object.assign(changes, { [section]: value });
    }
  }
  return { changes, errors };
}
