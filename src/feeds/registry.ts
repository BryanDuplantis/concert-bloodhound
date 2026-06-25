/**
 * Open-feed source registry. Each source is a publicly published calendar feed
 * (iCal/JSON/RSS) keyed to a metro. The `metro` key matches a canonical key in
 * geo.ts, so a search that resolves to that metro picks up its feeds.
 *
 * Build-order spec + provenance: docs/atlanta-source-map.md.
 */

export type FeedType = "ical" | "rss";

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
];

export function sourcesForMetro(metro: string): FeedSource[] {
  return FEED_SOURCES.filter((s) => s.metro === metro);
}
