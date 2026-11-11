/** Shared rich-reply accent palette for sanitization and charts. */
export const RICH_TONES = [
  "ui-blue",
  "ui-green",
  "ui-teal",
  "ui-violet",
  "ui-amber",
  "ui-orange",
  "ui-rose",
  "ui-cyan",
  "ui-indigo",
  "ui-lime",
  "ui-pink",
] as const;

/** Cycle categorical colors after all eleven are used. */
export const CHART_COLORS = [
  "var(--ui-blue)",
  "var(--ui-orange)",
  "var(--ui-teal)",
  "var(--ui-violet)",
  "var(--ui-lime)",
  "var(--ui-rose)",
  "var(--ui-cyan)",
  "var(--ui-amber)",
  "var(--ui-indigo)",
  "var(--ui-green)",
  "var(--ui-pink)",
] as const;
