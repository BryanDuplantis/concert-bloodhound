import { XMLParser } from "fast-xml-parser";
import type { Concert } from "../types.js";
import { safeUrl, sanitizeConcert } from "../types.js";
import type { FeedFetchResult, FeedSource } from "./registry.js";

/**
 * Red Light Café (Squarespace) RSS open-feed source.
 *
 * Event date lives ONLY in the event URL slug's trailing `-mon-dd-yyyy`
 * (e.g. …/khari-cabral-simmons-live-at-red-light-cafe-jun-27-2026 → 2026-06-27).
 * The RSS <pubDate> is the POST publish time, NOT the event date — never use it
 * as the event date. `slugDate` is the single source of event-date truth here.
 *
 * Per the feed-layer standing rule (CLAUDE.md): this source never infers genre —
 * emitted concerts carry `genre: null` and gate out under a genre filter.
 */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Extract the event date from a Red Light event URL as "YYYY-MM-DD", or null.
 *
 * Anchored to a trailing `-mon-dd-yyyy` at the END of the slug — no loose match,
 * no best-effort fallback, no partial dates. A slug with no clean trailing date,
 * or a plausible-but-incomplete one (a month word with no day, a month/year with
 * no day), returns null. `null` is a FIRST-CLASS return, not an error: the caller
 * gates dateless events out rather than ever surfacing them dateless or guessing.
 */
export function slugDate(url: string | null | undefined): string | null {
  if (!url) return null;
  let slug: string;
  try {
    slug = new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  } catch {
    slug = url.replace(/\/+$/, "").split("/").pop() ?? "";
  }
  const m = /-([a-z]{3})-(\d{1,2})-(\d{4})$/i.exec(slug);
  if (!m) return null;
  const mm = MONTHS[m[1]!.toLowerCase()];
  if (!mm) return null; // a 3-letter token that isn't a real month → null, not a guess
  const day = parseInt(m[2]!, 10);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${mm}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// RSS → Concert. Red Light is a single venue, so location is constant. The feed
// is well-formed RSS 2.0; fast-xml-parser (pinned) handles it and decodes the
// XML entities titles carry. parseTagValue:false keeps a numeric-looking title
// ("1000 Couches '26") a string, never a number.
// ---------------------------------------------------------------------------

const VENUE = "Red Light Café";
const CITY = "Atlanta";
const REGION = "GA";

/**
 * Title-substring content-exclusion denylist. This is NOT genre inference and
 * never becomes a classifier seam (the feed-layer standing rule forbids that) —
 * it drops specific recurring NON-concert series the venue lists in the same feed.
 *
 * "Running Society" matches the recurring "Red Light Running Society: Run or Walk
 * Every SATURDAY" run/walk series — a fitness meetup, not a concert. (The Phase-3
 * brief's call B named the substring "Run or Walk Society", which does not occur
 * in the live title; corrected to "Running Society", the actual series name, so
 * the exclusion fires instead of silently no-op'ing.)
 */
const TITLE_DENYLIST = ["Running Society"];

function isDenied(title: string): boolean {
  const t = title.toLowerCase();
  return TITLE_DENYLIST.some((d) => t.includes(d.toLowerCase()));
}

/**
 * Strip any stray HTML tags from a title (entities are already decoded by the
 * parser), then collapse whitespace and trim so the name is clean at this mapping
 * boundary — not left ragged for sanitizeConcert to fix downstream.
 */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

interface RssItem {
  title?: string;
  link?: string;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: true,
  htmlEntities: true, // RSS titles carry numeric refs (&#8217; curly apostrophe) + named HTML entities
  parseTagValue: false,
});

/** Parse the RSS document into the minimal item fields we use. */
export function parseRedLightItems(xml: string): RssItem[] {
  const doc = parser.parse(xml);
  const raw = doc?.rss?.channel?.item ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((it: any) => ({
    title: it?.title != null ? String(it.title) : undefined,
    link: it?.link != null ? String(it.link) : undefined,
  }));
}

/**
 * Map one RSS item to a Concert, or null if it must be dropped. Drops (gate out,
 * never surface): empty title; a denylisted non-concert series (call B); an event
 * whose URL slug carries no clean date (call A — `genre`/feeds never guess, and a
 * dateless concert is useless and dishonest). genre is null per the standing rule;
 * door time is fragile free text ("Doors @ 7") so `time` stays null — never invent.
 */
export function itemToConcert(item: RssItem, src: FeedSource): Concert | null {
  const title = stripHtml(item.title ?? "");
  if (!title) return null;
  if (isDenied(title)) return null; // call B: content-exclusion
  const date = slugDate(item.link);
  if (!date) return null; // call A: null-date events gate out
  return {
    name: title,
    artists: [title], // single listing; the title is the bill (mirrors Cobb summary→artists)
    date,
    dateTBD: false,
    time: null, // door time is unreliable free text; never invent
    venue: VENUE,
    city: CITY,
    region: REGION,
    genre: null, // STANDING RULE: the feed layer never infers genre
    priceMin: null,
    priceMax: null,
    currency: null,
    availability: "Availability unknown",
    url: safeUrl(item.link),
    ageRestriction: null,
    source: src.name,
  };
}

function inWindow(date: string, start?: string, end?: string): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

/**
 * Fetch + normalize Red Light Café's RSS into windowed Concerts. sanitizeConcert
 * is applied at this source-function return (the M3 boundary) — AFTER field
 * shaping, BEFORE merge/dedup — so untrusted feed text is hardened and dedup keys
 * stay consistent with the other sources.
 *
 * Returns a `horizon` alongside the windowed concerts — the latest date among
 * ALL dated items this fetch parsed, before any window filtering. The feed is a
 * Squarespace RSS capped at its ~20 most recent posts, so this horizon is a real,
 * short rolling boundary: a wide search asking past it must not read the gap as
 * the venue going dark — it's the feed's own reach ending, not a confirmed
 * absence of shows.
 */
export async function fetchRedLightConcerts(
  src: FeedSource,
  window: { start?: string; end?: string } = {},
): Promise<FeedFetchResult> {
  const res = await fetch(src.url, {
    headers: {
      "User-Agent": "concert-bloodhound/0.1",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) throw new Error(`Red Light feed HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseRedLightItems(xml)
    .map((it) => itemToConcert(it, src))
    .filter((c): c is Concert => c !== null);
  const horizon =
    items.length > 0 ? items.reduce((max, c) => (c.date! > max ? c.date! : max), items[0]!.date!) : null;
  const concerts = items
    .filter((c) => inWindow(c.date!, window.start, window.end))
    .map(sanitizeConcert);
  return { concerts, horizon };
}
