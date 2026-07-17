import { XMLParser } from "fast-xml-parser";
import type { Concert } from "../types.js";
import { safeUrl, sanitizeConcert } from "../types.js";
import type { FeedFetchResult, FeedSource } from "./registry.js";

/**
 * The EARL (Atlanta) Freshtix calendar HTML open-feed source.
 *
 * Freshtix (badearl.freshtix.com) publishes no RSS/iCal — only a server-
 * rendered "Upcoming Events" list page, grouped under day headers that carry
 * NO YEAR ("Friday July 17th"). Recon 2026-07-17: single page, no pagination
 * in list view (62 day headers spanning Jul-Nov 2026, already in forward-
 * chronological order); one nested `<ol id="ft-event-list">` per day `<li>`;
 * the page's own JSON-LD is Organization-only, nothing per-event to lean on
 * instead. The page 403s a bare/urllib UA and 200s a browser UA (PM-37
 * mechanism A, confirmed live 2026-07-17) — fetchFreshtixConcerts sends a
 * real browser User-Agent.
 *
 * Per the feed-layer standing rule (CLAUDE.md): this source never infers
 * genre — emitted concerts carry `genre: null` and gate out under a genre
 * filter.
 */

const VENUE = "The EARL";
const CITY = "Atlanta";
const REGION = "GA";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Reused for entity decoding only (htmlEntities covers named + numeric refs,
// e.g. titles carrying "&amp;") — mirrors redlight.ts's use of the same lib
// for the same problem, just on an already tag-stripped fragment instead of
// a full RSS document.
const entityParser = new XMLParser({
  ignoreAttributes: true,
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
});

function decodeEntities(s: string): string {
  const parsed = entityParser.parse(`<t>${s}</t>`);
  return parsed?.t != null ? String(parsed.t) : s;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * "8:30pm" / "8:00 PM" -> "20:30:00", or null on anything that doesn't
 * cleanly parse — never invent a time. The `ft-event-when` div carries only
 * a single clock time (no separate door/set time), so this IS the show time.
 */
export function parseFreshtixTime(raw: string): string | null {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(raw.trim());
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  const pm = m[3]!.toLowerCase() === "pm";
  if (h === 12) h = 0;
  if (pm) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

/**
 * "$16.00 - $18.00" / "$16.00" -> {min, max}. Absent or unparseable -> both
 * null — never invent a price (mirrors ticketmaster.ts's own-nothing rule).
 */
export function parseFreshtixPrice(raw: string | undefined): {
  min: number | null;
  max: number | null;
} {
  if (!raw) return { min: null, max: null };
  const nums = [...raw.matchAll(/\$([\d,]+(?:\.\d{2})?)/g)].map((m) =>
    Number(m[1]!.replace(/,/g, "")),
  );
  if (nums.length === 0) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

interface DayGroup {
  month: number;
  day: number;
  block: string;
}

const DAY_RE =
  /<h2[^>]*>\s*<strong>[^<]*<\/strong>\s*([A-Za-z]+)\s+(\d{1,2})\w*\s*<\/h2>\s*<ol id="ft-event-list">([\s\S]*?)<\/ol>/g;
const EVENT_RE =
  /<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>\s*<\/h3>\s*<div class="ft-event-when">([\s\S]*?)<\/div>([\s\S]*?)(?=<li|$)/g;
const PRICE_RE = /<div class="ft-event-price-range">([\s\S]*?)<\/div>/;

/** Parse the raw calendar HTML into day groups (month/day, no year, in document order). */
export function parseFreshtixDays(html: string): DayGroup[] {
  const out: DayGroup[] = [];
  for (const m of html.matchAll(DAY_RE)) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (!month) continue; // unrecognized month token -> drop the day, never guess
    out.push({ month, day: parseInt(m[2]!, 10), block: m[3]! });
  }
  return out;
}

/**
 * Assign a year to each day group by walking document order and bumping the
 * year whenever the month goes backwards relative to the prior group (Dec ->
 * Jan rollover) — the page carries no year anywhere, but "Upcoming Events" is
 * always forward-chronological, so a month decrease is the only rollover
 * signal available. `reference` anchors the FIRST group: if its month is
 * already behind the reference month, the whole list must start next year
 * (e.g. fetched in December, first listed show is a January date).
 */
export function assignYears(
  days: DayGroup[],
  reference: Date,
): (DayGroup & { year: number })[] {
  let year = reference.getFullYear();
  if (days.length > 0 && days[0]!.month < reference.getMonth() + 1) year += 1;
  let prevMonth: number | null = null;
  return days.map((d) => {
    if (prevMonth !== null && d.month < prevMonth) year += 1;
    prevMonth = d.month;
    return { ...d, year };
  });
}

function eventsFromDay(day: DayGroup & { year: number }, src: FeedSource): Concert[] {
  const date = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  const out: Concert[] = [];
  for (const m of day.block.matchAll(EVENT_RE)) {
    const title = stripHtml(m[2] ?? "");
    if (!title) continue; // no bare title to invent one for
    const priceBlock = PRICE_RE.exec(m[4] ?? "");
    const { min, max } = parseFreshtixPrice(priceBlock?.[1]);
    out.push({
      name: title,
      artists: [title], // single listing; the title is the bill (mirrors redlight/Cobb)
      date,
      dateTBD: false,
      time: parseFreshtixTime(m[3] ?? ""),
      venue: VENUE,
      city: CITY,
      region: REGION,
      genre: null, // STANDING RULE: the feed layer never infers genre
      priceMin: min,
      priceMax: max,
      currency: min != null || max != null ? "USD" : null,
      availability: "Availability unknown",
      // href attribute values are HTML-escaped too ("&amp;" between utm_ query
      // params) — decode before safeUrl, or the link renders with a literal
      // "&amp;" instead of "&".
      url: safeUrl(decodeEntities(m[1] ?? "")),
      ageRestriction: null,
      // No extra prose to surface — the block past the price div is only a
      // "Find Tickets" button (recon 2026-07-17); nothing else to pass through.
      description: null,
      source: src.name,
    });
  }
  return out;
}

function inWindow(date: string, start?: string, end?: string): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

/**
 * Fetch + normalize The EARL's Freshtix calendar into windowed Concerts.
 * Throws on a zero-day or zero-event parse — the structural-drift alarm from
 * the Phase-3 open-feed pattern: a genuine dark stretch at a working touring
 * venue is implausible, so an empty parse of a 200 response almost certainly
 * means the page markup changed under these regexes, and a silent []
 * would read as "confirmed no shows" instead of "coverage broke" (the exact
 * PM-39-shaped gap this source exists to close — see the filed backlog task).
 * `fetchMetroFeeds` catches this via `Promise.allSettled` and logs it; other
 * sources are unaffected.
 *
 * Returns a `horizon` alongside the windowed concerts — the latest date in the
 * FULL unfiltered parse, i.e. how far this page's own listing actually reaches.
 * Freshtix has no rolling-window cap the way Red Light's "latest 20 posts" RSS
 * does (it's one page of everything currently on sale), but the horizon is
 * still real: past it, absence is "not yet on sale," not "confirmed dark."
 */
export async function fetchFreshtixConcerts(
  src: FeedSource,
  window: { start?: string; end?: string } = {},
  now: Date = new Date(),
): Promise<FeedFetchResult> {
  const res = await fetch(src.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`Freshtix feed HTTP ${res.status}`);
  const html = await res.text();
  const days = assignYears(parseFreshtixDays(html), now);
  if (days.length === 0) {
    throw new Error("Freshtix feed structural drift: 0 day headers parsed from a 200 response");
  }
  const all = days.flatMap((d) => eventsFromDay(d, src));
  if (all.length === 0) {
    throw new Error("Freshtix feed structural drift: day headers parsed but 0 events extracted");
  }
  const horizon = all.reduce((max, c) => (c.date! > max ? c.date! : max), all[0]!.date!);
  const concerts = all
    .filter((c) => inWindow(c.date!, window.start, window.end))
    .map(sanitizeConcert);
  return { concerts, horizon };
}
