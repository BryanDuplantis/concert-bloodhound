/**
 * Pure result-shaping helpers for the search tools. No I/O — kept out of
 * index.ts (which boots the stdio server on import) so they can be unit-tested.
 */
import type { Concert } from "./types.js";

/**
 * Drop events whose listed minimum exceeds the budget. Events with no listed
 * price are kept (we can't confirm they're over budget) and flagged downstream
 * — honoring the spec's "don't invent, don't silently exclude" rule.
 */
export function applyMaxPrice(concerts: Concert[], maxPrice?: number): Concert[] {
  if (maxPrice == null) return concerts;
  return concerts.filter((c) => c.priceMin == null || c.priceMin <= maxPrice);
}

/** Earliest-dated first; undated events sort last. */
export function byDateAsc(a: Concert, b: Concert): number {
  if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  if (a.date) return -1;
  if (b.date) return 1;
  return 0;
}

/**
 * Merge feed events into the primary (Ticketmaster) list, dropping duplicates by
 * artist/title + date + venue. The primary source wins (it carries price,
 * availability, and ticket links the open feeds don't).
 */
export function mergeConcerts(primary: Concert[], extra: Concert[]): Concert[] {
  const key = (c: Concert) =>
    `${(c.artists[0] ?? c.name).toLowerCase().trim()}|${c.date ?? ""}|${(c.venue ?? "").toLowerCase().trim()}`;
  const seen = new Set(primary.map(key));
  const merged = [...primary];
  for (const c of extra) {
    const k = key(c);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(c);
    }
  }
  return merged;
}
