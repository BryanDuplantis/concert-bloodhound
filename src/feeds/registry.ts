/**
 * Open-feed source registry. Each source is a publicly published calendar feed
 * (iCal/JSON/RSS) keyed to a metro. The `metro` key matches a canonical key in
 * geo.ts, so a search that resolves to that metro picks up its feeds.
 *
 * Build-order spec + provenance: docs/atlanta-source-map.md.
 */
import type { Concert } from "../types.js";

export type FeedType = "ical" | "rss" | "html" | "wp-json" | "localist";

export interface FeedSource {
  /** Stable id (logging, dedup of sources). */
  id: string;
  /** Human attribution label — becomes Concert.source. */
  name: string;
  /** Canonical metro key (matches geo.ts table key, e.g. "atlanta"). */
  metro: string;
  type: FeedType;
  url: string;
  /**
   * iCal only: keep only events whose CATEGORIES intersect these
   * (case-insensitive). The honest music filter — we surface only what the
   * publisher itself categorized as music, never a keyword guess. RSS sources
   * (single-venue concert feeds) carry no categories and omit this.
   */
  musicCategories?: string[];
}

export const FEED_SOURCES: FeedSource[] = [
  {
    id: "cobb-travel",
    name: "Cobb Travel & Tourism",
    metro: "atlanta",
    type: "ical",
    url: "https://travelcobb.org/events/list/?shortcode=24f53d40&hide_subsequent_recurrences=1&ical=1",
    musicCategories: ["Music & Concerts"],
  },
  {
    // Single-venue indie music venue (Squarespace RSS). Closes long-tail shows
    // TM misses. Event date lives only in the URL slug — see redlight.ts.
    id: "redlight",
    name: "Red Light Café",
    metro: "atlanta",
    type: "rss",
    url: "https://redlightcafe.com/events?format=rss",
  },
  {
    // Single-venue indie/metal room selling via Freshtix, outside TM's
    // catalog and JamBase's coverage. No RSS/iCal — server-rendered HTML
    // list page, no year on its day headers. See freshtix.ts.
    id: "earl-freshtix",
    name: "The EARL (Freshtix)",
    metro: "atlanta",
    type: "html",
    url: "https://badearl.freshtix.com/",
  },
  {
    // Tier-2 static civic page: one CivicEngage lineup table per season,
    // 6 free Friday shows Apr–Sep on the Marietta Square. See glover.ts.
    id: "glover-park",
    name: "Glover Park Concert Series",
    metro: "atlanta",
    type: "html",
    url: "https://www.mariettaga.gov/192/Glover-Park-Concert-Series",
  },
  {
    // Fall-gated university source, opened 2026-07-17. Server-side filter on
    // GSU's OWN "Music Concerts" fine-arts category (fails loud — an unknown
    // filter id 400s), verified client-side per event. Kopleff recitals +
    // Rialto Center headliners (Béla Fleck, Take 6, Joshua Redman) TM/JamBase
    // don't fully carry. Empty is VALID out of semester — see gsu.ts. (KSU's
    // Localist instance: killed 2026-07-17, zero music in a full fall window.)
    id: "gsu-localist",
    name: "Georgia State University",
    metro: "atlanta",
    type: "localist",
    url: "https://calendar.gsu.edu/api/2/events",
  },
  {
    // Tier-2 civic source via the city's open WordPress REST API — the
    // /concert-series/ page itself is client-rendered and unparseable.
    // Covers BOTH city series (First Friday downtown + Depot Park
    // amphitheater), routed by post title. See kennesaw.ts.
    id: "kennesaw-news",
    name: "City of Kennesaw",
    metro: "atlanta",
    type: "wp-json",
    url: "https://www.kennesaw-ga.gov/wp-json/wp/v2/posts?search=concert%20series&per_page=10",
  },
];

/**
 * A source's own fetch, unfiltered by any caller's date window: the concerts it
 * actually returned, plus the LATEST date among them ("horizon" — null if the
 * source returned nothing dated). A rolling-window source (RSS "latest N posts",
 * a single HTML calendar page) has a real horizon short of "forever"; a search
 * that asks past it must not read the gap as "the venue went dark" — it's the
 * feed's own reach ending, not a confirmed absence of shows.
 */
export interface FeedFetchResult {
  concerts: Concert[];
  horizon: string | null;
}

export function sourcesForMetro(metro: string): FeedSource[] {
  return FEED_SOURCES.filter((s) => s.metro === metro);
}

/**
 * Every metro we hold feeds for. Lets an artist search with no location named
 * cover the feed layer without hardcoding a metro key — "where is this artist
 * playing?" is a nationwide question, and feeds are the one source that can't
 * answer it directly (JamBase takes a bare `artistName`; feeds are metro-keyed
 * and have no artist filter at all, so each metro is a separate fetch + a
 * client-side match).
 *
 * Fine while this is one metro / two sources. If the registry grows to dozens,
 * an unscoped artist search becomes a fan-out of full-calendar fetches — cap it
 * or drop the nationwide feed leg then, rather than letting it creep.
 */
export function feedMetros(): string[] {
  return [...new Set(FEED_SOURCES.map((s) => s.metro))];
}
