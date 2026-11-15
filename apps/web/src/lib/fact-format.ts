/**
 * Turns verified fact values and check records into display text. Pure: no data loading, so it can
 * be tested on its own and shared by every page type. Nothing here adds a fact; it only formats one.
 */

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAMES: Record<(typeof DAYS)[number], string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:00" -> "2:00 PM". Anything that isn't HH:MM is returned as is. */
export function formatTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-11-20" -> "Nov 20, 2026". */
export function formatDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** How a check was made, as it reads after "Checked {date}". */
export function formatMethod(method: string): string {
  switch (method) {
    case "phone_call": return "by phone";
    case "website": return "on the shop's website";
    case "site_visit": return "in person";
    case "owner_submitted": return "by the owner";
    default: return `by ${method.replace(/_/g, " ")}`;
  }
}

type Day = { open: string; close: string } | null;

/**
 * Opening hours as one line, joining runs of days with the same hours: "Mon–Fri 9:00 AM–5:00 PM,
 * Sat closed". A day missing from the value was not checked and is left out, never shown as closed.
 */
export function formatHours(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as Partial<Record<(typeof DAYS)[number], Day>>;
  const text = (d: Day) => (d ? `${formatTime(d.open)}–${formatTime(d.close)}` : "closed");
  const runs: { from: string; to: string; text: string; next: number }[] = [];
  DAYS.forEach((day, i) => {
    if (!(day in v)) return;
    const t = text(v[day] ?? null);
    const last = runs[runs.length - 1];
    if (last && last.text === t && last.next === i) {
      last.to = day;
      last.next = i + 1;
    } else runs.push({ from: day, to: day, text: t, next: i + 1 });
  });
  return runs
    .map((r) => `${DAY_NAMES[r.from as keyof typeof DAY_NAMES]}${r.from === r.to ? "" : `–${DAY_NAMES[r.to as keyof typeof DAY_NAMES]}`} ${r.text}`)
    .join(", ");
}

/** A fact value as text, by its declared type. */
export function formatValue(type: string, value: unknown): string {
  switch (type) {
    case "boolean": return value === true ? "Yes" : value === false ? "No" : String(value);
    case "time": return typeof value === "string" ? formatTime(value) : String(value);
    case "hours": return formatHours(value);
    case "number": return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
    default: return String(value);
  }
}

/** "Checked Nov 20, 2026 by phone" */
export const checkLine = (c: { checkedAt: string; method: string }) => `Checked ${formatDate(c.checkedAt)} ${formatMethod(c.method)}`;

/** The most recent of a set of checks (facts or core-field checks), or null. */
export function latestCheck(checks: { checkedAt: string; method: string }[]): { checkedAt: string; method: string } | null {
  let best: { checkedAt: string; method: string } | null = null;
  for (const c of checks) if (!best || c.checkedAt > best.checkedAt) best = c;
  return best;
}
