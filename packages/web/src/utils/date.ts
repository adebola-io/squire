import { isToday } from "date-fns";
export function formatDateRelative(dateStr: string, options?: Intl.DateTimeFormatOptions): string {
  const date = new Date(dateStr);
  const locale = navigator.languages[0];

  if (!isToday(date)) {
    return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", ...options });
  }

  return date.toLocaleString(locale, { timeStyle: "short", ...options });
}
