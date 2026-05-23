import type { Concert } from "./types.js";

const BASE = "https://app.ticketmaster.com/discovery/v2";

/** Errors we can explain to the user without leaking internals. */
export class TicketmasterError extends Error {}

export interface SearchParams {
  keyword?: string;
  city?: string;
  stateCode?: string;
  countryCode?: string;
  classificationName?: string;
  segmentName?: string;
  startDateTime?: string;
  endDateTime?: string;
  venueId?: string;
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

function apiKey(): string {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) {
    throw new TicketmasterError(
      "TICKETMASTER_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
  return key;
}

/**
 * Single chokepoint for Discovery API calls. The api key is attached here and
 * never logged — callers must not print the returned URL or the key.
 */
async function tmFetch(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<any> {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("apikey", apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new TicketmasterError(
      `Network error reaching Ticketmaster: ${(e as Error).message}`,
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
    const body = await res.text().catch(() => "");
    throw new TicketmasterError(
      `Ticketmaster returned HTTP ${res.status}. ${body.slice(0, 160)}`.trim(),
    );
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
    url: e?.url ?? null,
    ageRestriction: e?.ageRestrictions?.legalAgeEnforced
      ? "Age restriction enforced (details not listed)"
      : null,
    source: "Ticketmaster",
  };
}

/** Search music events. Defaults to the Music segment so we return concerts. */
export async function searchEvents(p: SearchParams): Promise<Concert[]> {
  const data = await tmFetch("events.json", {
    keyword: p.keyword,
    city: p.city,
    stateCode: p.stateCode,
    countryCode: p.countryCode ?? "US",
    classificationName: p.classificationName,
    segmentName: p.segmentName ?? "Music",
    startDateTime: p.startDateTime,
    endDateTime: p.endDateTime,
    venueId: p.venueId,
    radius: p.radius,
    unit: p.radius ? (p.unit ?? "miles") : undefined,
    sort: p.sort ?? "date,asc",
    size: p.size ?? 20,
  });
  const events: any[] = data?._embedded?.events ?? [];
  return events.map(normalizeEvent);
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
  return { id: v.id, name: v.name ?? keyword, city: v.city?.name ?? null };
}
