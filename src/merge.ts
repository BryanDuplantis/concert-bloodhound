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
 * Fold a name to a comparable form: strip accents, unify the typographic
 * variants sources disagree on (curly vs straight apostrophes, dash forms),
 * lowercase, collapse whitespace.
 *
 * This is canonicalization, NOT fuzzy matching — it only reconciles different
 * encodings of the same characters, so distinct acts ("Eagles" vs "Eagles of
 * Death Metal") still hash apart. That distinction is load-bearing: fuzzy artist
 * matching is deliberately rejected (see CLAUDE.md), but Ticketmaster writing
 * "Nocturne's Kiss" (U+0027) while JamBase writes "Nocturne’s Kiss" (U+2019) is
 * one name in two encodings, and leaked a live dupe until this folded them.
 */
export function canonical(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining accents: "Cafe\u0301" -> "cafe"
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'") // curly/modifier apostrophes -> '
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-") // hyphen/en/em dash forms -> -
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does a feed event's venue answer a user's venue query?
 *
 * Unlike `mergeConcerts` — which refuses venue comparison because two SOURCES
 * format the same room irreconcilably — the query here is a human's typed name.
 * Matching a person's "Red Light Cafe" against a feed's "Red Light Café" is
 * intent resolution, not source reconciliation, so containment either way is
 * appropriate. The 3-char floor keeps a stray short query from matching broadly.
 */
export function venueMatches(eventVenue: string | null, query: string): boolean {
  if (!eventVenue) return false;
  const v = canonical(eventVenue);
  const q = canonical(query);
  if (!v || q.length < 3) return false;
  return v === q || v.includes(q) || q.includes(v);
}

/**
 * Is `a` a strictly better copy of the same show than `b`? More populated fields
 * wins; on a tie the longer name wins, which is how a support act survives — the
 * partner row reads "Austin Meade with Cole Barnhill" where the native row reads
 * "Austin Meade". Strict, so an exact tie leaves the incumbent in place.
 */
function moreComplete(a: Concert, b: Concert): boolean {
  const filled = (c: Concert) =>
    [c.date, c.time, c.venue, c.city, c.region, c.genre, c.priceMin, c.priceMax, c.currency, c.url, c.ageRestriction]
      .filter((v) => v != null).length;
  const fa = filled(a);
  const fb = filled(b);
  return fa !== fb ? fa > fb : a.name.length > b.name.length;
}

/**
 * Collapse duplicate rows WITHIN a single source's own list.
 *
 * Ticketmaster's catalog can carry one show twice when a venue also sells through
 * a ticketing partner: Eddie's Attic surfaces as a `link.dice.fm` row AND a native
 * `ticketmaster.com` row, same artist, date, time, and venue, differing only by
 * event id and link. Two rows, one show.
 *
 * Identity here is artist + date + **time**, and the time is load-bearing —
 * unlike the cross-source key below, which omits it. A single source listing the
 * same artist twice on one date at different times is usually two real shows, not
 * a duplicate: Eddie's Attic runs a separate, separately-ticketed early and late
 * show most nights. Keying on artist+date alone would collapse a double-header
 * into one row and hide a show the user could have bought a ticket to — trading
 * this bug for a worse one at the very venue that exposes it. Two rows sharing an
 * unknown (null) time still collapse; a venue running two shows publishes times.
 *
 * The surviving row is the most complete copy, held at the first occurrence's
 * position so result order stays stable. NOT handled: a relocation pair (the same
 * show relisted at a new venue under a second event id, differing times) — by time
 * alone that is indistinguishable from a double-header, separable only by TM's
 * "Moved to/from" name text. No live specimen exists to build against; see BACKLOG.
 */
export function dedupeWithinSource(concerts: Concert[]): Concert[] {
  const key = (c: Concert) => `${canonical(c.artists[0] ?? c.name)}|${c.date ?? ""}|${c.time ?? ""}`;
  const best = new Map<string, Concert>();
  const order: string[] = [];
  for (const c of concerts) {
    const k = key(c);
    const held = best.get(k);
    if (!held) {
      best.set(k, c);
      order.push(k);
    } else if (moreComplete(c, held)) {
      best.set(k, c);
    }
  }
  return order.map((k) => best.get(k)!);
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
 *
 * Only dedups extra-against-primary — duplicates WITHIN one source's own list are
 * `dedupeWithinSource`'s job, on a deliberately different (time-aware) key. Run it
 * on each list before merging; this function assumes its inputs are self-consistent.
 */
export function mergeConcerts(primary: Concert[], extra: Concert[]): Concert[] {
  const key = (c: Concert) => `${canonical(c.artists[0] ?? c.name)}|${c.date ?? ""}`;
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
