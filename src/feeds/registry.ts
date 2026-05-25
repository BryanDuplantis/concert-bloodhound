/**
 * Open-feed source registry. Each source is a publicly published calendar feed
 * (iCal/JSON/RSS) keyed to a metro. The `metro` key matches a canonical key in
 * geo.ts, so a search that resolves to that metro picks up its feeds.
 *
 * Build-order spec + provenance: docs/atlanta-source-map.md.
 */

export type FeedType = "ical";

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
   * Keep only events whose iCal CATEGORIES intersect these (case-insensitive).
   * This is the honest music filter — we only surface what the publisher itself
   * categorized as music, never a keyword guess.
   */
  musicCategories: string[];
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
];

export function sourcesForMetro(metro: string): FeedSource[] {
  return FEED_SOURCES.filter((s) => s.metro === metro);
}
