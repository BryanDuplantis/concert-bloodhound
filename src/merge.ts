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
 * Shift a YYYY-MM-DD by whole days. Anchored at UTC noon so the arithmetic can't
 * be dragged across a date boundary by a DST-shifted local midnight.
 */
function shiftDay(day: string, n: number): string {
  const t = new Date(`${day}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * The Ticketmaster query bounds, paired with `applyDateWindow` below. One
 * invariant across the three of them: **fetch generously in UTC, trim precisely
 * in local.** TM filters server-side on a UTC instant, but a Concert's `date` is
 * the event's LOCAL date — the two disagree by the venue's offset, so any bound
 * tight enough to be exact in UTC is wrong in local time. Keep these together;
 * widening a bound without the trim leaks, tightening one without the other drops
 * real shows.
 *
 * `toEnd` deliberately overshoots by a day. Its old exact-looking
 * `${end}T23:59:59Z` silently omitted late shows on the window's LAST local day:
 * a 20:00 EDT show is 00:00 UTC the NEXT day, past the bound, so TM never
 * returned it. Live specimen — John Berry at Eddie's Attic 2026-07-25 plays 18:00
 * AND 20:00; with `endDate: "2026-07-25"` only the 18:00 show came back, and
 * nothing signalled the other was missing. A false absence on the last day of
 * every dated window. +1 day covers every real-world UTC offset (the westernmost,
 * UTC-12, puts a local 23:59 at D+1 11:59Z); `applyDateWindow` then drops whatever
 * the pad over-fetched. Safe against the result cap because TM sorts date,asc —
 * the extra day's events sort last and only fill leftover slots.
 *
 * `toStart` is deliberately NOT padded, and the asymmetry is real. For US venues
 * (every negative offset) a UTC midnight start is already EARLIER than local
 * midnight, so it over-fetches the previous local evening — a leak the trim
 * handles, not an omission. Padding it would cost real results: earlier events
 * sort FIRST under date,asc, so they'd consume slots and then be trimmed away.
 * Latent gap: a positive-offset venue (UTC+14 reached via explicit latlong or
 * countryCode) can have an early show on the start date fall before this bound —
 * the mirror of the bug fixed above, unreachable through the US-only metro table.
 */
export const toStart = (d?: string): string | undefined => (d ? `${d}T00:00:00Z` : undefined);
export const toEnd = (d?: string): string | undefined =>
  d ? `${shiftDay(d, 1)}T23:59:59Z` : undefined;

/**
 * Trim results to a [start, end] window by each event's own LOCAL date — the
 * authoritative field, and the half of the invariant above that makes the padded
 * UTC bounds safe. JamBase/feeds already filter by local date, so it's a no-op for
 * them. Undated events are dropped when a window is set — a dated search shouldn't
 * surface an event we can't place in the window. No bounds → unchanged.
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
 * Ticketmaster's catch-all classifications. These are present values that carry no
 * genre — a field wearing the costume of data — so scoring them as "populated" lets
 * an empty row tie a real one. Only ever used to RANK duplicate copies of one show;
 * never to blank a surfaced value. If every copy says "Other", "Other" is what TM
 * knows and what we show.
 */
const CATCH_ALL_GENRES = new Set(["other", "undefined", "unknown", "miscellaneous"]);
const informativeGenre = (c: Concert): string | null =>
  c.genre && !CATCH_ALL_GENRES.has(canonical(c.genre)) ? c.genre : null;

/**
 * An ancillary PRODUCT sold alongside the show, not the show itself.
 *
 * Ticketmaster lists these as separate events sharing the concert's artist, date
 * and time, and labels them nothing: live 2026-07-17 the Eagles returned 16 rows =
 * 8 shows x 2, every one a `"Eagles Live at Sphere"` / `"Eagles - Suite
 * Reservation"` pair at 20:30, both `type=Undefined`. The NAME is the only tell TM
 * gives, so matching it is a heuristic — used ONLY to rank duplicate copies of one
 * show, never to drop a row. If a show's only listing is a suite, that is what TM
 * is selling and it still ships.
 *
 * Needed because the length tiebreak below reads longer-name-as-richer, which is
 * true for a support act ("Austin Meade with Cole Barnhill") and false here:
 * "Eagles - Suite Reservation" is longer than "Eagles Live at Sphere" and is the
 * worse answer — a premium package standing in for the concert, on all 8 dates.
 */
const ANCILLARY_PRODUCT = /\b(suite reservation|vip package|hotel package|parking|meet (and|&) greet)\b/i;
const isAncillary = (c: Concert): boolean => ANCILLARY_PRODUCT.test(c.name);

/**
 * Is `a` a strictly better copy of the same show than `b`? More populated fields
 * wins; on a tie the longer name wins, which is how a support act survives — the
 * partner row reads "Austin Meade with Cole Barnhill" where the native row reads
 * "Austin Meade". Strict, so an exact tie leaves the incumbent in place.
 *
 * Genre is scored through `informativeGenre`, not raw nullness. TM's duplicate
 * listings of one show routinely disagree — John Berry 2026-07-25 came back as
 * "Other" on one event id and "Country" on two others — and counting "Other" as
 * populated made those tie, so first-seen won and the catch-all was what shipped.
 * Both values are TM's own data for the same event; preferring the specific one
 * invents nothing.
 */
function moreComplete(a: Concert, b: Concert): boolean {
  // The show beats an ancillary product outright, before any field counting: a
  // suite row can be strictly more populated than the concert and still be the
  // wrong answer to "when are the Eagles playing?".
  const aAnc = isAncillary(a);
  const bAnc = isAncillary(b);
  if (aAnc !== bAnc) return !aAnc;
  const filled = (c: Concert) =>
    [c.date, c.time, c.venue, c.city, c.region, informativeGenre(c), c.priceMin, c.priceMax, c.currency, c.url, c.ageRestriction]
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
 * Does a feed event's title name this artist?
 *
 * For FEED ROWS ONLY. Ticketmaster and JamBase filter by artist server-side
 * (`keyword` / `artistName`), so running this over their results would
 * re-implement their matching rule client-side and could turn a hit they meant
 * to return into a false absence (PM-47). Feeds have no server-side filter —
 * this fills that gap and nothing else.
 *
 * Feeds carry no performer field: both normalizers copy the post title into
 * `artists` (`feeds/index.ts` summary, `feeds/redlight.ts` title), so the only
 * thing to match against is a marketing headline. Containment is a deliberate
 * product call (2026-07-17): a tribute IS a match ("Sade vs Prince JAM"), a
 * presenter IS a match ("Keena Graham presents…"), and a performer buried after
 * "w/" is worth the false positives that come with it.
 *
 * Unlike `venueMatches`, this is ONE-directional — the title must contain the
 * query, never the reverse. There both sides are a room's name, so containment
 * either way is symmetric; here the sides are a performer name and a sentence,
 * and `query.includes(title)` would let a short title ("Hex") match any query
 * containing it. The 3-char floor keeps a stray short query from matching the
 * whole calendar.
 *
 * The row this returns is honest on its own — `artists` holds the full title, so
 * it never claims Prince is performing. The claim lives in the CALLER's summary
 * line, which must not promise "{artist} concerts" over a match this loose.
 */
export function artistMatches(c: Concert, query: string): boolean {
  const q = canonical(query);
  if (q.length < 3) return false;
  return [...c.artists, c.name].some((a) => a && canonical(a).includes(q));
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
 * the city). Tradeoff: a same-artist/same-day pair split across sources (a free
 * in-store + an evening ticketed show; an early and a late set) collapses to the
 * Ticketmaster copy.
 *
 * That tradeoff was accepted on the premise that such pairs are RARE, and 2026-07-16
 * weakened the premise: double-headers turn out to be routine at listening rooms
 * (Eddie's Attic books an early and a late set most nights — John Berry, 2026-07-25,
 * 18:00 and 20:00). It still holds TODAY only because TM carries both sets, so the
 * JamBase copies dedup away harmlessly. It would BITE the day TM carries one set and
 * JamBase the other: the second show vanishes. Adding time to this key is NOT the
 * fix — sources disagree on time formatting and JamBase omits it entirely for some
 * events, which is exactly why the key excludes it. Revisit if a split-coverage
 * double-header is ever observed; tracked in BACKLOG.
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
