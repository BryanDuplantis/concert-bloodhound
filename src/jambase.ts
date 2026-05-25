import type { Concert } from "./types.js";
import { safeUrl } from "./types.js";

// JamBase Data API v3 (the self-service Data Platform). The v1→v3 migration
// changed THREE things at once: the origin (api.data.jambase.com, not
// www.jambase.com/jb-api), Bearer-token auth (not an `apikey` query param), and
// the key format. All three verified live 2026-05-25 — a correct request returns
// real Atlanta events incl. the free Atlanta Jazz Festival that Ticketmaster's
// catalog misses (the exact coverage hole this second source exists to close).
const BASE = "https://api.data.jambase.com/v3";
const UA = "concert-bloodhound/0.1";

/** Errors we can explain to the user without leaking internals. */
export class JamBaseError extends Error {}

/** Strip the api key out of any string before it can be logged or surfaced. */
function redact(s: string, key: string): string {
  return key ? s.split(key).join("***") : s;
}

function apiKey(): string {
  const key = process.env.JAMBASE_API_KEY;
  if (!key) {
    throw new JamBaseError(
      "JAMBASE_API_KEY is not set. Copy .env.example to .env and add your JamBase key.",
    );
  }
  return key;
}

/**
 * geo.ts metro key → JamBase geoMetroId. JamBase queries events by its own geo
 * id, not lat/long, so a resolved metro must map to one. Curated like
 * feeds/registry.ts — only metros verified against a live response belong here.
 * Find a new id via `GET /geographies/metros?metroHasUpcomingEvents=true` and
 * read the `identifier` field (e.g. "Atlanta Area" → "jambase:10").
 */
const JAMBASE_METROS: Record<string, string> = {
  atlanta: "jambase:10",
};

/** Resolve a geo.ts metro key to a JamBase geoMetroId, or null if unmapped. */
export function jambaseMetroId(metroKey: string | undefined): string | null {
  if (!metroKey) return null;
  return JAMBASE_METROS[metroKey] ?? null;
}

/**
 * Raw GET against /v3/<path>. The key is attached here as a Bearer token and must
 * never be logged. Handles JamBase's two distinct error shapes: the API envelope
 * ({ success:false, errors:[{code,message}] }) for parameter errors, and the
 * RFC-7807 problem+json ({ status, title, detail }) returned on a 401.
 */
export async function jbGet(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<any> {
  const key = apiKey();
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": UA,
      },
    });
  } catch (e) {
    throw new JamBaseError(`Network error reaching JamBase: ${redact((e as Error).message, key)}`);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new JamBaseError(`JamBase returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok || data?.success === false) {
    // Envelope error → errors[].message; auth/RFC-7807 error → detail/title.
    const msg =
      data?.errors?.[0]?.message ?? data?.detail ?? data?.title ?? `HTTP ${res.status}`;
    throw new JamBaseError(`JamBase: ${redact(String(msg), key)}`);
  }
  return data;
}

/** Pull the events array from the v3 envelope. */
export function extractEvents(data: any): any[] {
  return data?.events ?? data?.data ?? [];
}

export interface JamBaseSearchParams {
  /** JamBase geoMetroId, e.g. "jambase:10" (Atlanta). Required. */
  geoMetroId: string;
  eventDateFrom?: string; // YYYY-MM-DD
  eventDateTo?: string; // YYYY-MM-DD
  page?: number;
  /** Optional genre filter, matched against the headliner's tags (see headlinerMatchesGenre). */
  genre?: string;
}

/** Split a genre string into comparable tokens: lowercased, alphanumeric runs. */
function genreTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * The TOP-BILLED act's first genre tag that matches the request, or null. JamBase
 * tags genre per performer as hyphenated slugs ("hip-hop-rap",
 * "rhythm-and-blues-soul"), often several per act. A slug matches when every
 * requested token is present in it — so "hip-hop" and "rap" both match
 * "hip-hop-rap", but "rap" does NOT match "trap". We consider only the headliner's
 * tags (the genre we display) and never guess: an act with no tags never matches,
 * so under a genre filter it's omitted rather than mislabeled. Returning the
 * matched slug lets the caller display the tag that actually matched the search
 * (the headliner's *first* tag is often a different genre). Known gaps: taxonomy
 * mismatches (a "R&B" request won't reach "rhythm-and-blues-soul"), page-1 only.
 */
export function matchedGenreSlug(e: any, genre: string): string | null {
  const want = genreTokens(genre);
  if (want.size === 0) return null;
  const slugs: unknown = e?.performer?.[0]?.genre;
  if (!Array.isArray(slugs)) return null;
  for (const slug of slugs) {
    const have = genreTokens(String(slug));
    if ([...want].every((t) => have.has(t))) return String(slug); // want ⊆ have
  }
  return null;
}

/** Whether the headliner matches the requested genre (empty request = no filter). */
export function headlinerMatchesGenre(e: any, genre: string): boolean {
  return genreTokens(genre).size === 0 || matchedGenreSlug(e, genre) !== null;
}

// ---------------------------------------------------------------------------
// Normalization (schema.org JSON-LD → our Concert contract). Every field path
// below was verified against a live v3 response on 2026-05-25.
// ---------------------------------------------------------------------------

function mapEventStatus(status?: string): string {
  if (!status) return "Availability unknown";
  const s = String(status).toLowerCase();
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("postpone")) return "Postponed";
  if (s.includes("reschedule")) return "Rescheduled";
  if (s.includes("scheduled")) return "Scheduled";
  return "Availability unknown";
}

/** addressRegion is an object; prefer the 2-letter "GA" so it matches TM's stateCode. */
function regionOf(addr: any): string | null {
  const r = addr?.addressRegion;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") return r.alternateName ?? r.name ?? r.identifier ?? null;
  return null;
}

function asPositive(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
}

/** "hip-hop-rap" → "Hip Hop Rap". Formatting of real data, never invention. */
function prettyGenre(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export function normalizeJamBaseEvent(e: any): Concert {
  const loc = e?.location ?? {};
  const addr = loc?.address ?? {};
  const performers: any[] = e?.performer ?? [];
  const performerNames = performers.map((p) => p?.name).filter(Boolean) as string[];

  // Festivals carry sprawling lineups where the event NAME ("Atlanta Jazz
  // Festival") is the right headline; concerts read best as their bill
  // ("mgk, Wiz Khalifa"). Emptying artists makes the formatter fall back to name.
  const isFestival = e?.["@type"] === "Festival";
  const artists = isFestival ? [] : performerNames;

  // startDate is a bare date ("2026-05-23", festivals) or a LOCAL ISO datetime
  // ("2026-05-29T19:00:00", concerts — no zone). Split on "T".
  const start: unknown = e?.startDate;
  let date: string | null = null;
  let time: string | null = null;
  if (typeof start === "string" && start) {
    const [d, t] = start.split("T");
    date = d ?? null;
    time = t ? t.slice(0, 8) : null;
  }

  // Genre comes from the TOP-BILLED act only (performer[0] is rank 1 / headliner).
  // We deliberately do NOT scan down to opening acts: tagging a festival with an
  // opener's genre is closer to inventing than surfacing. Empty → "not listed".
  const topGenre = Array.isArray(performers[0]?.genre) ? performers[0].genre[0] : null;
  const genre = topGenre ? prettyGenre(String(topGenre)) : null;

  // JamBase's Data API offers carry a ticketing link but an empty
  // priceSpecification — no price on this tier. Read defensively (null in
  // practice) so we never assert a number the feed didn't give; for free events
  // (e.g. the Jazz Festival) offers is empty anyway. The clean JamBase event page
  // (e.url) is the canonical link and pairs with the "Powered by JamBase" footer.
  const offer = (e?.offers ?? [])[0] ?? null;
  const priceMin = asPositive(offer?.priceSpecification?.price ?? offer?.price ?? offer?.lowPrice);
  const priceMax = asPositive(offer?.priceSpecification?.maxPrice ?? offer?.highPrice);
  const currency =
    priceMin != null || priceMax != null
      ? (offer?.priceSpecification?.priceCurrency ?? offer?.priceCurrency ?? null)
      : null;

  return {
    name: e?.name ?? performerNames[0] ?? "Untitled event",
    artists,
    date,
    dateTBD: date == null,
    time,
    venue: loc?.name ?? null,
    city: addr?.addressLocality ?? null,
    region: regionOf(addr),
    genre,
    priceMin,
    priceMax,
    currency,
    availability: mapEventStatus(e?.eventStatus),
    url: safeUrl(e?.url ?? offer?.url),
    ageRestriction: null,
    source: "JamBase",
  };
}

/**
 * Search a metro's upcoming music events on JamBase v3. Returns one page (40
 * events, date-ascending) — plenty to augment Ticketmaster; page through via
 * `page` if a wider window is ever needed. Bounded by [eventDateFrom,
 * eventDateTo] when supplied; otherwise JamBase defaults to the upcoming window.
 */
export async function searchEvents(p: JamBaseSearchParams): Promise<Concert[]> {
  const data = await jbGet("events", {
    geoMetroId: p.geoMetroId,
    eventDateFrom: p.eventDateFrom,
    eventDateTo: p.eventDateTo,
    page: p.page,
  });
  const events = extractEvents(data);
  if (p.genre) {
    const want = p.genre;
    // Keep only events whose headliner is tagged with the requested genre, and
    // relabel each with the tag that MATCHED — so a "rock" search doesn't show a
    // result as "Metal"/"Folk" just because that's the headliner's first tag.
    return events.flatMap((e) => {
      const slug = matchedGenreSlug(e, want);
      return slug ? [{ ...normalizeJamBaseEvent(e), genre: prettyGenre(slug) }] : [];
    });
  }
  return events.map(normalizeJamBaseEvent);
}
