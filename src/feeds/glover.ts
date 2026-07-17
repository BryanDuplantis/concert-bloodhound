import { XMLParser } from "fast-xml-parser";
import type { Concert } from "../types.js";
import { safeUrl, sanitizeConcert } from "../types.js";
import type { FeedFetchResult, FeedSource } from "./registry.js";

/**
 * Glover Park Concert Series (Marietta Square) — Tier-2 static civic source.
 *
 * mariettaga.gov publishes the season as one CivicEngage page holding a single
 * lineup `<table>` (recon 2026-07-17: 6 rows, Apr–Sep, every row a music act).
 * Rows are anchored on the `data-th` cell attributes ("Concert Date",
 * "Performers / Genre"), which CivicEngage emits for responsive rendering —
 * more stable than the surrounding markup. Dates carry a full year ("April 24,
 * 2026"), unlike Freshtix, but months appear in page style ("Sept"), so the
 * month parser accepts unambiguous name prefixes.
 *
 * The page states show time once, in prose, for the whole season ("All
 * concerts are free and begin at 8 p.m."). That is the publisher's own
 * statement, so it's read from the page per fetch — never hardcoded; if the
 * sentence disappears, time honestly reverts to null.
 *
 * Per the feed-layer standing rule: `genre: null` always. The page's own
 * "Performers / Genre" label text ("70s Smooth Rock") is free prose, not a
 * canonical vocabulary — it rides along verbatim in `description`.
 */

const VENUE = "Glover Park";
const CITY = "Marietta";
const REGION = "GA";

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "April" / "Aug" / "Sept." -> month number, or null. Prefix match needs ≥3
 * chars — every 3-letter English month prefix is unambiguous. */
export function monthFromToken(raw: string): number | null {
  const tok = raw.trim().toLowerCase().replace(/\.$/, "");
  if (tok.length < 3) return null;
  const hits = MONTH_NAMES.filter((m) => m.startsWith(tok));
  return hits.length === 1 ? MONTH_NAMES.indexOf(hits[0]!) + 1 : null;
}

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
  // Accessibility-only spans (hidden "Facebook Social Network" link labels,
  // class ae-compliance-indent / display:none) are invisible on the page but
  // WOULD leak into a naive tag-strip and corrupt the artist name — remove
  // the elements, not just the tags.
  const visible = s.replace(
    /<span[^>]*(?:display:\s*none|ae-compliance-indent)[^>]*>[\s\S]*?<\/span>/gi,
    " ",
  );
  return decodeEntities(visible.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** "April 24, 2026" (month possibly abbreviated) -> YYYY-MM-DD, or null. */
export function parseGloverDate(raw: string): string | null {
  const m = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(stripHtml(raw));
  if (!m) return null;
  const month = monthFromToken(m[1]!);
  if (!month) return null;
  const day = parseInt(m[2]!, 10);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The season-wide show time from the page's own prose ("begin at 8 p.m."),
 * or null when the page no longer says so.
 */
export function parseGloverSeasonTime(html: string): string | null {
  const m = /begins?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i.exec(html);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 1 || h > 12 || min > 59) return null;
  if (h === 12) h = 0;
  if (m[3]!.toLowerCase() === "p") h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

export interface GloverRow {
  date: string;
  artist: string;
  /** The page's own genre label after the slash, or null. */
  genreText: string | null;
}

const ROW_RE =
  /data-th="Concert Date">([\s\S]*?)<\/td>[\s\S]*?data-th="Performers \/ Genre">([\s\S]*?)<\/td>/g;

/** Parse lineup rows. Rows with an unparseable date are dropped, never guessed. */
export function parseGloverRows(html: string): GloverRow[] {
  const out: GloverRow[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const date = parseGloverDate(m[1] ?? "");
    if (!date) continue;
    const cell = stripHtml(m[2] ?? "");
    if (!cell) continue;
    // "Yacht Rock Schooners / 70s Smooth Rock" — the label after the LAST
    // slash is the page's genre text; an artist name may itself contain one.
    const slash = cell.lastIndexOf(" / ");
    const artist = (slash === -1 ? cell : cell.slice(0, slash)).trim();
    const genreText = slash === -1 ? null : cell.slice(slash + 3).trim() || null;
    if (!artist) continue;
    out.push({ date, artist, genreText });
  }
  return out;
}

function inWindow(date: string, start?: string, end?: string): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

/**
 * Fetch + normalize the Glover Park season page into windowed Concerts.
 * Throws on a zero-row parse of a 200 — the structural-drift alarm (Freshtix
 * pattern): the series page always lists its season, so an empty parse means
 * the CivicEngage markup moved, not "no concerts"; a silent [] would read as
 * confirmed dark. `fetchMetroFeedsDetailed` catches and logs it.
 */
export async function fetchGloverConcerts(
  src: FeedSource,
  window: { start?: string; end?: string } = {},
): Promise<FeedFetchResult> {
  const res = await fetch(src.url, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`Glover Park feed HTTP ${res.status}`);
  const html = await res.text();
  const rows = parseGloverRows(html);
  if (rows.length === 0) {
    throw new Error("Glover Park feed structural drift: 0 lineup rows parsed from a 200 response");
  }
  const time = parseGloverSeasonTime(html);
  const all: Concert[] = rows.map((r) => ({
    name: r.artist,
    artists: [r.artist],
    date: r.date,
    dateTBD: false,
    time,
    venue: VENUE,
    city: CITY,
    region: REGION,
    genre: null, // STANDING RULE: the feed layer never infers genre
    priceMin: null,
    priceMax: null,
    currency: null,
    availability: "Availability unknown",
    url: safeUrl(src.url), // no per-event page exists; the series page IS the listing
    ageRestriction: null,
    description: r.genreText,
    source: src.name,
  }));
  const horizon = all.reduce((max, c) => (c.date! > max ? c.date! : max), all[0]!.date!);
  const concerts = all
    .filter((c) => inWindow(c.date!, window.start, window.end))
    .map(sanitizeConcert);
  return { concerts, horizon };
}
