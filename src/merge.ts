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

/**
 * Trim results to a [start, end] window by each event's own LOCAL date — the
 * authoritative field. Ticketmaster's server-side filter is built from UTC
 * midnight (toStart/toEnd), so a late-evening local show on the day before the
 * window leaks in (an 8 PM EDT show on the 28th is 00:00 UTC on the 29th); this
 * drops it. JamBase/feeds already filter by local date, so it's a no-op for them.
 * Undated events are dropped when a window is set — a dated search shouldn't
 * surface an event we can't place in the window. No bounds → unchanged.
 * (Residual: TM can still omit a late-night show on the window's LAST local day,
 * since its UTC end cuts off before local midnight — that needs a tz-aware query,
 * tracked in BACKLOG; this helper only trims, it can't recover an omitted event.)
 */
export function applyDateWindow(concerts: Concert[], start?: string, end?: string): Concert[] {
  if (!start && !end) return concerts;
  return concerts.filter((c) => {
    if (!c.date) return false;
    if (start && c.date < start) return false;
    if (end && c.date > end) return false;
    return true;
  });
}

/** Earliest-dated first; undated events sort last. */
export function byDateAsc(a: Concert, b: Concert): number {
  if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  if (a.date) return -1;
  if (b.date) return 1;
  return 0;
}

/**
 * Merge supplementary events (JamBase, open feeds) into the primary
 * (Ticketmaster) list, dropping cross-source duplicates. The primary source wins
 * — it carries the price, availability, and ticket links the others don't.
 *
 * Identity is **artist (or title) + date**, deliberately NOT venue. A touring act
 * can't headline two rooms on the same day, so artist+date already identifies the
 * show; the venue only ever caused leaks, because each source formats the same
 * room differently and irreconcilably — "Tabernacle" vs "The Tabernacle",
 * "District - GA" (TM appends the state) vs "District Atlanta" (JamBase appends
 * the city). Tradeoff: the rare same-artist/same-day/different-venue pair split
 * across sources (e.g. a free in-store + an evening ticketed show) collapses to
 * the Ticketmaster copy — an acceptable loss for a concert finder.
 */
export function mergeConcerts(primary: Concert[], extra: Concert[]): Concert[] {
  const key = (c: Concert) => `${(c.artists[0] ?? c.name).toLowerCase().trim()}|${c.date ?? ""}`;
  const seen = new Set(primary.map(key));
  const merged = [...primary];
  for (const c of extra) {
    const k = key(c);
    if (!seen.has(k)) {
      seen.add(k); // a later extra can also dedup against an earlier one
      merged.push(c);
    }
  }
  return merged;
}
