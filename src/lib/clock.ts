/**
 * Times of day for the app. A 12-hour clock writes the hour after midnight as "12:02 AM", which reads
 * like noon, so that hour shows as "00:02 AM"; noon stays "12:02 PM", and 24-hour locales are untouched.
 */
const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** `t` in `fmt`, with the midnight hour as 00 on a 12-hour clock. */
export function formatTime(fmt: Intl.DateTimeFormat, t: number | Date): string {
  const d = new Date(t);
  if (d.getHours() !== 0) return fmt.format(d);
  return fmt
    .formatToParts(d)
    .map((p) => (p.type === "hour" && p.value === "12" ? "00" : p.value))
    .join("");
}

const clockFmt = new Intl.DateTimeFormat(undefined, CLOCK);
/** A time of day: "9:03 AM", "00:02 AM", "12:02 PM" (or "09:03" in 24-hour locales). */
export const clock = (t: number | Date) => formatTime(clockFmt, t);
