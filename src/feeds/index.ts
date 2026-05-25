/**
 * Federated open-feed layer. Fetches a metro's open calendar feeds on demand,
 * filters to music events, and normalizes them to the shared Concert schema —
 * closing the long-tail coverage hole (free civic/indie shows) Ticketmaster
 * structurally misses, without leaving the stateless MCP model.
 *
 * Resilience: a dead feed degrades (logged + skipped via Promise.allSettled),
 * it never breaks the search. An in-memory TTL cache makes repeat calls cheap
 * within the long-lived stdio server.
 */
import type { Concert } from "../types.js";
import { safeUrl } from "../types.js";
import { fetchICalText, parseICal, parseLocation, type ICalEvent } from "./ical.js";
import { sourcesForMetro, type FeedSource } from "./registry.js";

interface CacheEntry {
  at: number;
  events: ICalEvent[];
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, CacheEntry>();

async function loadICal(url: string): Promise<ICalEvent[]> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.events;
  const events = parseICal(await fetchICalText(url));
  cache.set(url, { at: Date.now(), events });
  return events;
}

function matchesMusic(ev: ICalEvent, wanted: string[]): boolean {
  const want = wanted.map((c) => c.toLowerCase());
  return ev.categories.some((c) => want.includes(c.toLowerCase()));
}

function inWindow(date: string | null, start?: string, end?: string): boolean {
  if (!date) return false;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

function toConcert(ev: ICalEvent, src: FeedSource): Concert {
  const { venue, city, region } = parseLocation(ev.location);
  return {
    name: ev.summary ?? "Untitled event",
    artists: ev.summary ? [ev.summary] : [],
    date: ev.date,
    dateTBD: ev.date == null,
    time: ev.time,
    venue,
    city,
    region,
    genre: null, // feeds carry no reliable per-event genre — don't invent one
    priceMin: null, // iCal carries no price field — never assert a number
    priceMax: null,
    currency: null,
    availability: "Availability unknown",
    url: safeUrl(ev.url),
    ageRestriction: null,
    source: src.name,
  };
}

/**
 * Fetch + normalize all music events from a metro's open feeds, optionally
 * bounded to a [start, end] date window (YYYY-MM-DD). Returns [] for metros
 * with no registered feeds (no network performed).
 */
export async function fetchMetroFeeds(
  metro: string,
  window: { start?: string; end?: string } = {},
): Promise<Concert[]> {
  const sources = sourcesForMetro(metro);
  if (sources.length === 0) return [];

  const settled = await Promise.allSettled(
    sources.map(async (src) => {
      const events = await loadICal(src.url);
      return events
        .filter((e) => matchesMusic(e, src.musicCategories))
        .filter((e) => inWindow(e.date, window.start, window.end))
        .map((e) => toConcert(e, src));
    }),
  );

  const out: Concert[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      out.push(...r.value);
    } else {
      const src = sources[i];
      console.error(
        `Feed "${src?.name ?? "unknown"}" failed: ${(r.reason as Error)?.message ?? r.reason}`,
      );
    }
  });
  return out;
}
