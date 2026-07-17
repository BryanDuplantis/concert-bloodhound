import type { Concert } from "../types.js";
import { safeUrl, sanitizeConcert } from "../types.js";
import type { FeedFetchResult, FeedSource } from "./registry.js";

/**
 * Georgia State University Localist calendar — fall-gated source, opened
 * 2026-07-17 when the fall semester's music listings appeared (probed live;
 * the "dead in summer" finding from 2026-05-25 had expired early).
 *
 * The filed prescription — client-side venue-name match on Kopleff, because
 * `venue_id` filtering is broken on the v2 API — is superseded: GSU tags its
 * own events with a fine-arts category ("Music Concerts",
 * `event_fine_arts_events` id below), and `type[]=<id>` filters SERVER-side.
 * That is the Cobb pattern one rung better: the publisher's own music label,
 * no keyword guess, no classifier — and it fails LOUD, since Localist 400s
 * an unknown filter id ("Unknown event filter") rather than silently
 * returning the unfiltered campus firehose. It also beats the venue route on
 * precision: venue-scoped listings include recruiting events ("Music Major
 * for a Day") that GSU itself does NOT tag as music concerts.
 *
 * Belt to that suspender: every returned event is still verified client-side
 * to carry a music fine-arts tag (reading the publisher's own label — the
 * inverse of PM-47), so correctness never depends on the server honoring the
 * filter param.
 *
 * UNLIKE Freshtix/Kennesaw, an empty result is VALID here, not structural
 * drift — a university calendar is legitimately empty out of semester (the
 * exact reason this source was fall-gated). The loud failures are the HTTP
 * 400 above and a response without an `events` array.
 */

/** GSU's own "Music Concerts" fine-arts category (filters.event_fine_arts_events). */
const MUSIC_FILTER_ID = "52620491419918";
const PER_PAGE = 100;
const MAX_PAGES = 3;
/** Fetch horizon: one year out — past any published semester. */
const FETCH_DAYS = 365;

interface LocalistInstance {
  event_instance?: { id?: number; start?: string; all_day?: boolean };
}

export interface LocalistEvent {
  title?: string;
  location_name?: string;
  address?: string;
  ticket_cost?: string | null;
  ticket_url?: string | null;
  localist_url?: string | null;
  description_text?: string | null;
  event_instances?: LocalistInstance[];
  filters?: { event_fine_arts_events?: { name?: string; id?: number }[] };
}

interface LocalistPage {
  events?: { event?: LocalistEvent }[];
  page?: { total?: number };
}

/** The publisher's own label check — trust GSU's tag, never our own keyword guess. */
export function hasMusicTag(ev: LocalistEvent): boolean {
  return (ev.filters?.event_fine_arts_events ?? []).some((f) =>
    (f.name ?? "").toLowerCase().includes("music"),
  );
}

/** Trailing "…, City, ST " from a US street address; null/null when absent. */
export function cityRegionFromAddress(address: string | undefined): {
  city: string | null;
  region: string | null;
} {
  const m = /,\s*([^,]+),\s*([A-Z]{2})\b\s*$/.exec(address ?? "");
  return m ? { city: m[1]!.trim(), region: m[2]! } : { city: null, region: null };
}

function toConcert(ev: LocalistEvent, src: FeedSource): Concert | null {
  const inst = ev.event_instances?.[0]?.event_instance;
  const start = inst?.start ?? "";
  const date = /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : null;
  if (!date) return null; // a concert you can't date is noise (Red Light rule)
  const time = !inst?.all_day && /T\d{2}:\d{2}:\d{2}/.test(start) ? start.slice(11, 19) : null;
  const { city, region } = cityRegionFromAddress(ev.address);
  const title = ev.title ?? "Untitled event";
  // ticket_cost is multi-tier free text ("$50, $60, $70, $90") — surfaced as
  // the source's own words in the description, never parsed into priceMin/Max.
  const description =
    [ev.ticket_cost ? `Tickets: ${ev.ticket_cost}` : null, ev.description_text || null]
      .filter(Boolean)
      .join("\n") || null;
  return {
    name: title,
    artists: [title],
    date,
    dateTBD: false,
    time,
    venue: ev.location_name || null,
    city,
    region,
    genre: null, // STANDING RULE: the feed layer never infers genre
    priceMin: null,
    priceMax: null,
    currency: null,
    availability: "Availability unknown",
    url: safeUrl(ev.ticket_url) ?? safeUrl(ev.localist_url),
    ageRestriction: null,
    description,
    source: src.name,
  };
}

/**
 * Normalize one fetched page-set. The API repeats a multi-date event once per
 * date (each copy carrying that date's instance), so rows dedupe on instance
 * id. Pure — the unit-testable half of the fetcher.
 */
export function parseGsuEvents(
  pages: LocalistPage[],
  src: FeedSource,
  window: { start?: string; end?: string } = {},
): FeedFetchResult {
  const seen = new Set<number | string>();
  const all: Concert[] = [];
  for (const page of pages) {
    if (!Array.isArray(page.events)) {
      throw new Error("GSU feed structural drift: response has no events array");
    }
    for (const wrapper of page.events) {
      const ev = wrapper.event;
      if (!ev || !hasMusicTag(ev)) continue;
      const key = ev.event_instances?.[0]?.event_instance?.id ?? `${ev.title}|${ev.localist_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = toConcert(ev, src);
      if (c) all.push(c);
    }
  }
  const horizon = all.reduce<string | null>(
    (max, c) => (c.date != null && (max == null || c.date > max) ? c.date : max),
    null,
  );
  const concerts = all
    .filter((c) => {
      if (window.start && c.date! < window.start) return false;
      if (window.end && c.date! > window.end) return false;
      return true;
    })
    .map(sanitizeConcert);
  return { concerts, horizon };
}

function pageUrl(base: string, start: string, end: string, page: number): string {
  const u = new URL(base);
  u.searchParams.set("start", start);
  u.searchParams.set("end", end);
  u.searchParams.set("pp", String(PER_PAGE));
  u.searchParams.set("page", String(page));
  u.searchParams.append("type[]", MUSIC_FILTER_ID);
  return u.toString();
}

/**
 * Fetch a fixed year-ahead window (so `horizon` reflects the calendar's own
 * published reach, per the FeedFetchResult contract) and trim to the caller's
 * window client-side.
 */
export async function fetchGsuConcerts(
  src: FeedSource,
  window: { start?: string; end?: string } = {},
): Promise<FeedFetchResult> {
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + FETCH_DAYS * 86400_000).toISOString().slice(0, 10);

  const pages: LocalistPage[] = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const res = await fetch(pageUrl(src.url, start, end, p), {
      headers: { Accept: "application/json" },
    });
    // A vanished/renamed category id is a 400 ("Unknown event filter") — the
    // designed loud failure, never a silent unfiltered result.
    if (!res.ok) throw new Error(`GSU feed HTTP ${res.status}`);
    const page = (await res.json()) as LocalistPage;
    pages.push(page);
    if (p >= (page.page?.total ?? 1)) break;
  }
  return parseGsuEvents(pages, src, window);
}
