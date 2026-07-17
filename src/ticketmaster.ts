import type { Concert } from "./types.js";
import { safeUrl, sanitizeConcert, sanitizeText } from "./types.js";
// Pure helper into an I/O client — the network invariant only forbids the reverse
// (merge.ts imports nothing but types.js, so no cycle).
import { canonical } from "./merge.js";

const BASE = "https://app.ticketmaster.com/discovery/v2";

/** Errors we can explain to the user without leaking internals. */
export class TicketmasterError extends Error {}

export interface SearchParams {
  keyword?: string;
  city?: string;
  /** "lat,long" centroid for a geospatial (metro-wide) search; pairs with radius. */
  latlong?: string;
  stateCode?: string;
  countryCode?: string;
  classificationName?: string;
  segmentName?: string;
  startDateTime?: string;
  endDateTime?: string;
  venueId?: string;
  /** TM attraction (artist) id — the entity route; see findAttractions. */
  attractionId?: string;
  radius?: number;
  unit?: "miles" | "km";
  sort?: string;
  size?: number;
}

export interface VenueMatch {
  id: string;
  name: string;
  city: string | null;
}

/** A Ticketmaster attraction = an artist/act entity, the thing `keyword` only gropes at. */
export interface AttractionMatch {
  id: string;
  name: string;
  /** TM's own genre label for the act, or null. Display/ranking only — never a filter. */
  genre: string | null;
  /** Count TM reports as upcoming; 0 means querying its events is a wasted call. */
  upcoming: number;
}

function apiKey(): string {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) {
    throw new TicketmasterError(
      "TICKETMASTER_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
  return key;
}

/** Strip the api key out of any string before it can be logged or surfaced. */
function redact(s: string, key: string): string {
  return key ? s.split(key).join("***") : s;
}

/**
 * Single chokepoint for Discovery API calls. The api key is attached here and
 * never logged — callers must not print the returned URL or the key.
 */
async function tmFetch(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<any> {
  const key = apiKey();
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("apikey", key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new TicketmasterError(
      `Network error reaching Ticketmaster: ${redact((e as Error).message, key)}`,
    );
  }

  if (res.status === 401) {
    throw new TicketmasterError(
      "Ticketmaster rejected the API key (401). Check TICKETMASTER_API_KEY.",
    );
  }
  if (res.status === 429) {
    throw new TicketmasterError(
      "Ticketmaster rate limit reached (429). Wait a moment and try again.",
    );
  }
  if (!res.ok) {
    // Redact before surfacing: TM's Discovery API can echo the apikey back in
    // some error envelopes (e.g. malformed-request 400s). Log the full body to
    // stderr for debugging; never let it reach the chat surface.
    const body = await res.text().catch(() => "");
    console.error(`Ticketmaster HTTP ${res.status}: ${redact(body.slice(0, 500), key)}`);
    throw new TicketmasterError(`Ticketmaster returned HTTP ${res.status}.`);
  }
  return res.json();
}

function mapStatus(code?: string): string {
  switch (code) {
    case "onsale":
      return "On sale";
    case "offsale":
      return "Off sale";
    case "cancelled":
      return "Cancelled";
    case "postponed":
      return "Postponed";
    case "rescheduled":
      return "Rescheduled";
    default:
      return "Availability unknown";
  }
}

/** Treat Ticketmaster's "Undefined" placeholder as a genuine absence. */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value && value !== "Undefined" ? value : null;
}

function normalizeEvent(e: any): Concert {
  const venue = e?._embedded?.venues?.[0];
  const attractions: any[] = e?._embedded?.attractions ?? [];
  const artists = attractions.map((a) => a?.name).filter(Boolean) as string[];
  const cls = e?.classifications?.[0];
  const genre = clean(cls?.genre?.name) ?? clean(cls?.segment?.name);
  const price = (e?.priceRanges ?? [])[0];
  const start = e?.dates?.start ?? {};

  return {
    name: e?.name ?? "Untitled event",
    artists: artists.length ? artists : [e?.name].filter(Boolean),
    date: start.dateTBD ? null : (start.localDate ?? null),
    dateTBD: !!start.dateTBD,
    time: start.timeTBD || start.noSpecificTime ? null : (start.localTime ?? null),
    venue: venue?.name ?? null,
    city: venue?.city?.name ?? null,
    region: venue?.state?.stateCode ?? venue?.country?.countryCode ?? null,
    genre,
    // Ticketmaster often returns 0 as a placeholder rather than a real free
    // price; treat non-positive values as absent so we never assert "$0".
    priceMin: typeof price?.min === "number" && price.min > 0 ? price.min : null,
    priceMax: typeof price?.max === "number" && price.max > 0 ? price.max : null,
    currency: price?.currency ?? null,
    availability: mapStatus(e?.dates?.status?.code),
    url: safeUrl(e?.url),
    ageRestriction: e?.ageRestrictions?.legalAgeEnforced
      ? "Age restriction enforced (details not listed)"
      : null,
    // TM's structured fields cover price/time/venue already; no extra prose
    // field is mapped here (out of scope for this pass — see BACKLOG.md).
    description: null,
    source: "Ticketmaster",
  };
}

/** Search music events. Defaults to the Music segment so we return concerts. */
export async function searchEvents(p: SearchParams): Promise<Concert[]> {
  const data = await tmFetch("events.json", {
    keyword: p.keyword,
    city: p.city,
    latlong: p.latlong,
    stateCode: p.stateCode,
    countryCode: p.countryCode ?? "US",
    classificationName: p.classificationName,
    segmentName: p.segmentName ?? "Music",
    startDateTime: p.startDateTime,
    endDateTime: p.endDateTime,
    venueId: p.venueId,
    attractionId: p.attractionId,
    radius: p.radius,
    unit: p.radius ? (p.unit ?? "miles") : undefined,
    sort: p.sort ?? "date,asc",
    size: p.size ?? 20,
  });
  const events: any[] = data?._embedded?.events ?? [];
  // Sanitize at the source boundary: attacker-influenceable event text never
  // leaves this client unhardened (mirrors the network-isolation invariant).
  return events.map(normalizeEvent).map(sanitizeConcert);
}

/**
 * Resolve an artist name to Ticketmaster ATTRACTION entities — the act itself,
 * not text that happens to appear near one.
 *
 * Why this exists: `keyword` on /events is a text search over the whole record,
 * so it matches VENUE names and cannot find the act you asked for. Verified live
 * 2026-07-17 — `keyword=Eagles` near Atlanta returned Eagles of Death Metal, a
 * Deorro show at *Atlanta Eagles Arena*, and a church event at *Eagles Landing
 * First Baptist*: three rows, zero Eagles. `attractionId=K8vZ9171ob7` returns the
 * band. The fix was never a filter over keyword's output — filtering junk leaves
 * fewer rows, not the right ones.
 *
 * **Trust the per-attraction classification, NOT the segmentName param.** Passing
 * `segmentName=Music` here still returns "Philadelphia Eagles" (NFL) and "Colorado
 * Eagles" (hockey) — the param filters loosely. Each attraction's OWN
 * `classifications[0].segment.name` is correct and is what we gate on. That is
 * reading TM's own label, the inverse of reimplementing their matcher (PM-47).
 *
 * `upcoming === 0` acts are dropped: TM says they have nothing scheduled, so an
 * event query for them is a guaranteed-empty round trip.
 *
 * Ranking is TM's relevance order, with an exact canonical name match pulled to
 * the front so "Eagles" leads with the band rather than a tribute. Ranking only —
 * the caller decides how many to keep, and tributes/side-projects are legitimate
 * results (product call 2026-07-17), not noise to be trimmed here.
 */
export async function findAttractions(
  keyword: string,
  limit = 5,
): Promise<AttractionMatch[]> {
  const data = await tmFetch("attractions.json", {
    keyword,
    segmentName: "Music", // narrows the candidate pool; provably does NOT guarantee it
    size: 20,
    sort: "relevance,desc",
  });
  const raw: any[] = data?._embedded?.attractions ?? [];
  const music = raw.filter(
    (a) => a?.classifications?.[0]?.segment?.name === "Music" && (a?.upcomingEvents?._total ?? 0) > 0,
  );
  const want = canonical(keyword);
  const scored = music.map((a) => ({
    id: String(a.id),
    name: sanitizeText(a?.name) ?? keyword,
    genre: sanitizeText(a?.classifications?.[0]?.genre?.name ?? null),
    upcoming: Number(a?.upcomingEvents?._total ?? 0),
    exact: canonical(String(a?.name ?? "")) === want,
  }));
  scored.sort((x, y) => Number(y.exact) - Number(x.exact)); // stable: TM's relevance holds within each group
  return scored.slice(0, limit).map(({ exact, ...rest }) => rest);
}

/** Resolve a venue name to its Ticketmaster id (most relevant match). */
export async function findVenue(
  keyword: string,
  city?: string,
): Promise<VenueMatch | null> {
  const data = await tmFetch("venues.json", {
    keyword,
    city,
    countryCode: "US",
    size: 5,
    sort: "relevance,desc",
  });
  const v = data?._embedded?.venues?.[0];
  if (!v?.id) return null;
  // The resolved venue name flows verbatim into the user-facing summary label —
  // harden it like any other upstream free text; fall back to the caller's keyword.
  return {
    id: v.id,
    name: sanitizeText(v.name) ?? keyword,
    city: sanitizeText(v.city?.name),
  };
}
