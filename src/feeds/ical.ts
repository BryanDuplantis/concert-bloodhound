/**
 * Minimal iCal (RFC 5545) reader for the open feeds we consume. Deliberately
 * small: the feeds we use are pre-expanded (no RRULE — verified), so there is no
 * recurrence expansion, and we keep each event's local wall-clock date/time as
 * listed (no timezone conversion — "the concert is on this local date at this
 * local time" is exactly what we want to surface).
 *
 * Network I/O lives here and in ticketmaster.ts only — no other module fetches.
 */

export interface ICalEvent {
  summary: string | null;
  date: string | null; // YYYY-MM-DD (local)
  time: string | null; // HH:MM:SS (local) or null for all-day
  allDay: boolean;
  endDate: string | null;
  location: string | null;
  url: string | null;
  categories: string[];
  description: string | null;
}

const UA = "concert-bloodhound/0.1 (+https://github.com/BryanDuplantis/concert-bloodhound)";

export async function fetchICalText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "text/calendar", "User-Agent": UA } });
  if (!res.ok) throw new Error(`iCal fetch returned HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Unescape an iCal TEXT value (\\ \, \; \n) then decode common HTML entities.
 *  Order matters: some producers HTML-encode then iCal-escape the trailing ';'
 *  (e.g. "&#39\;"), so the iCal unescape must run first to expose "&#39;". */
export function unescapeText(value: string): string {
  let s = value.replace(/\\([\\,;])/g, "$1").replace(/\\[nN]/g, "\n");
  s = s
    .replace(/&#(\d+);?/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
  return s.trim();
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** RFC 5545 line unfolding: a CRLF (or LF) followed by a space/tab continues. */
function unfold(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "");
}

interface Prop {
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): { name: string; prop: Prop } | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const segs = left.split(";");
  const name = (segs[0] ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const p of segs.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, prop: { params, value } };
}

/** "20260527T183000" / "20260401" → date + (optional) time + all-day flag. */
function parseDateTime(value: string, params: Record<string, string>) {
  const v = value.trim().replace(/Z$/, "");
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return { date: null as string | null, time: null as string | null, allDay: false };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const dateOnly = params.VALUE === "DATE" || !m[4];
  const time = dateOnly ? null : `${m[4]}:${m[5]}:${m[6]}`;
  return { date, time, allDay: dateOnly };
}

/** Split a CATEGORIES value on unescaped commas. */
function splitCategories(value: string): string[] {
  return value
    .split(/(?<!\\),/)
    .map((s) => unescapeText(s))
    .filter(Boolean);
}

function toEvent(p: Record<string, Prop>): ICalEvent {
  const dt = p.DTSTART
    ? parseDateTime(p.DTSTART.value, p.DTSTART.params)
    : { date: null, time: null, allDay: false };
  const end = p.DTEND ? parseDateTime(p.DTEND.value, p.DTEND.params) : { date: null };
  return {
    summary: p.SUMMARY ? unescapeText(p.SUMMARY.value) : null,
    date: dt.date,
    time: dt.time,
    allDay: dt.allDay,
    endDate: end.date ?? null,
    location: p.LOCATION ? unescapeText(p.LOCATION.value) : null,
    url: p.URL ? p.URL.value.trim() : null,
    categories: p.CATEGORIES ? splitCategories(p.CATEGORIES.value) : [],
    description: p.DESCRIPTION ? unescapeText(p.DESCRIPTION.value) : null,
  };
}

/** Parse an iCalendar document into its VEVENTs. */
export function parseICal(text: string): ICalEvent[] {
  const lines = unfold(text).split(/\r?\n/);
  const events: ICalEvent[] = [];
  let cur: Record<string, Prop> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) events.push(toEvent(cur));
      cur = null;
      continue;
    }
    if (!cur) continue;
    const parsed = parseLine(line);
    if (parsed && !(parsed.name in cur)) cur[parsed.name] = parsed.prop;
  }
  return events;
}

/** Parse a "Venue, Street, City, ST, ZIP" iCal LOCATION into parts. Returns
 *  nulls for anything it can't confidently extract — never guesses. */
export function parseLocation(loc: string | null): {
  venue: string | null;
  city: string | null;
  region: string | null;
} {
  if (!loc) return { venue: null, city: null, region: null };
  const parts = loc.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { venue: null, city: null, region: null };
  const venue = parts[0] ?? null;
  let region: string | null = null;
  let city: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[A-Z]{2}$/.test(parts[i] ?? "")) {
      region = parts[i] ?? null;
      city = i - 1 >= 1 ? (parts[i - 1] ?? null) : null; // index 0 is the venue, not the city
      break;
    }
  }
  return { venue, city, region };
}
