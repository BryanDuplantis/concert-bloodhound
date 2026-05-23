import type { Concert } from "./types.js";

// The JamBase Data API v3 is served from the WordPress REST namespace
// (data.jambase.com is only the SPA marketing/docs site). Auth is an `apikey`
// query param — NOT a Bearer header. Both confirmed empirically (the docs are
// SPA-rendered and unreadable by fetch).
const BASE = "https://www.jambase.com/jb-api/v3";

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
 * Raw GET against /v3/<path>. The key is attached here as a Bearer token and
 * must never be logged. Exported so the discovery harness can probe param
 * variants directly (JamBase's docs are SPA-walled, so the exact param names
 * and response paths are confirmed empirically — see src/jambase-discovery.ts).
 */
export async function jbGet(
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
    throw new JamBaseError(`Network error reaching JamBase: ${redact((e as Error).message, key)}`);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new JamBaseError(`JamBase returned a non-JSON response (HTTP ${res.status}).`);
  }

  // JamBase error envelope: { success: false, errors: [{ code, message }] }.
  // Error messages echo the api key (e.g. api_key_inactive) — always redact.
  if (!res.ok || data?.success === false) {
    const msg = data?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new JamBaseError(`JamBase: ${redact(String(msg), key)}`);
  }
  return data;
}

/** Pull the events array regardless of which envelope key JamBase uses. */
export function extractEvents(data: any): any[] {
  return data?.events ?? data?._embedded?.events ?? data?.data ?? [];
}

export interface JamBaseSearchParams {
  city?: string;
  stateCode?: string;
  latitude?: number;
  longitude?: number;
  radiusMiles?: number;
  eventDateFrom?: string; // YYYY-MM-DD
  eventDateTo?: string;
  artistName?: string;
  perPage?: number;
}

// ---------------------------------------------------------------------------
// Normalization (schema.org-style JSON → our Concert contract).
// Written defensively with fallbacks; the exact field paths are verified against
// a live response by the discovery harness before this provider is wired in.
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

function regionOf(addr: any): string | null {
  if (!addr) return null;
  const r = addr.addressRegion;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") return r.identifier ?? r.name ?? null;
  return typeof addr.addressCountry === "string" ? addr.addressCountry : null;
}

function asPositive(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
}

export function normalizeJamBaseEvent(e: any): Concert {
  const loc = e?.location ?? e?.venue ?? {};
  const addr = loc?.address ?? {};
  const performers: any[] = e?.performer ?? e?.performers ?? [];
  const artists = performers.map((p) => p?.name).filter(Boolean) as string[];
  const offer = (e?.offers ?? [])[0] ?? null;

  const start: unknown = e?.startDate ?? e?.datetime ?? e?.date;
  let date: string | null = null;
  let time: string | null = null;
  if (typeof start === "string") {
    const [d, t] = start.split("T");
    date = d ?? null;
    time = t ? t.slice(0, 8) : null;
  }

  const genreRaw = performers[0]?.genre ?? e?.["x-headlinerGenres"] ?? e?.genre;
  const genre = Array.isArray(genreRaw) ? (genreRaw[0] ?? null) : typeof genreRaw === "string" ? genreRaw : null;

  return {
    name: e?.name ?? artists[0] ?? "Untitled event",
    artists: artists.length ? artists : [e?.name].filter(Boolean),
    date,
    dateTBD: false,
    time,
    venue: loc?.name ?? null,
    city: addr?.addressLocality ?? null,
    region: regionOf(addr),
    genre: genre && genre !== "Undefined" ? genre : null,
    priceMin: asPositive(offer?.price ?? offer?.lowPrice),
    priceMax: asPositive(offer?.highPrice),
    currency: offer?.priceCurrency ?? null,
    availability: mapEventStatus(e?.eventStatus),
    url: offer?.url ?? e?.url ?? null,
    ageRestriction: null,
    source: "JamBase",
  };
}

/** Search music events. Param names are best-effort pending the live probe. */
export async function searchEvents(p: JamBaseSearchParams): Promise<Concert[]> {
  const data = await jbGet("events", {
    geoCityName: p.city,
    geoStateIso: p.stateCode,
    eventDateFrom: p.eventDateFrom,
    eventDateTo: p.eventDateTo,
    artistName: p.artistName,
    perPage: p.perPage ?? 25,
  });
  return extractEvents(data).map(normalizeJamBaseEvent);
}
