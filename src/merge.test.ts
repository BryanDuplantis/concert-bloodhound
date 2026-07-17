/**
 * Unit tests for the pure merge/dedup/sort helpers — the Ticketmaster↔feed
 * integration point. Deterministic proof (the live smoke can't reliably show
 * the merge, since TM often has sooner events that fill the top slots).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDateWindow,
  applyMaxPrice,
  artistMatches,
  byDateAsc,
  canonical,
  dedupeWithinSource,
  mergeConcerts,
  toEnd,
  toStart,
  venueMatches,
} from "./merge.js";
import type { Concert } from "./types.js";

function concert(p: Partial<Concert>): Concert {
  return {
    name: "Show",
    artists: [],
    date: null,
    dateTBD: false,
    time: null,
    venue: null,
    city: null,
    region: null,
    genre: null,
    priceMin: null,
    priceMax: null,
    currency: null,
    availability: "Availability unknown",
    url: null,
    ageRestriction: null,
    source: "Ticketmaster",
    ...p,
  };
}

test("mergeConcerts appends feed events Ticketmaster doesn't have", () => {
  const tm = [concert({ artists: ["Phish"], date: "2026-07-01", venue: "Fox Theatre" })];
  const feed = [
    concert({
      artists: ["Glover Park Concert Series"],
      date: "2026-07-04",
      venue: "Glover Park",
      source: "Cobb Travel & Tourism",
    }),
  ];
  const out = mergeConcerts(tm, feed);
  assert.equal(out.length, 2);
  assert.equal(out[1].source, "Cobb Travel & Tourism");
});

test("mergeConcerts drops a duplicate (same artist|date|venue, case-insensitive); primary wins", () => {
  const tm = [
    concert({ artists: ["The Atlanta Opera"], date: "2026-05-30", venue: "Cobb Energy", source: "Ticketmaster" }),
  ];
  const feed = [
    concert({ artists: ["the atlanta opera"], date: "2026-05-30", venue: "COBB ENERGY", source: "Cobb Travel & Tourism" }),
  ];
  const out = mergeConcerts(tm, feed);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "Ticketmaster");
});

test("mergeConcerts dedups same artist+date regardless of venue formatting", () => {
  // The leaks the live tests exposed: same artist + date, but each source
  // formats (or qualifies) the venue differently. All must collapse to the TM
  // copy — identity is artist+date, not the irreconcilable venue string.
  const venuePairs: Array<[string, string]> = [
    ["Tabernacle", "The Tabernacle"],
    ["Center Stage Theater", "Center Stage"],
    ["The Masquerade - Hell", "The Masquerade (Hell Stage)"],
    ["District - GA", "District Atlanta"], // TM appends state, JamBase the city
  ];
  for (const [tmVenue, jbVenue] of venuePairs) {
    const tm = [concert({ artists: ["Alex Isley"], date: "2026-05-26", venue: tmVenue, source: "Ticketmaster" })];
    const jb = [concert({ artists: ["Alex Isley"], date: "2026-05-26", venue: jbVenue, source: "JamBase" })];
    const out = mergeConcerts(tm, jb);
    assert.equal(out.length, 1, `${tmVenue} vs ${jbVenue}`);
    assert.equal(out[0].source, "Ticketmaster");
  }
});

test("mergeConcerts collapses same artist+date even at a different venue (documented tradeoff)", () => {
  // A touring act can't be two places on one day; venue strings are unreliable
  // across sources, so we intentionally dedup on artist+date alone. The TM copy
  // (with its ticket link) wins.
  const tm = [concert({ artists: ["Alex Isley"], date: "2026-05-26", venue: "Tabernacle", source: "Ticketmaster" })];
  const jb = [concert({ artists: ["Alex Isley"], date: "2026-05-26", venue: "Eddie's Attic", source: "JamBase" })];
  const out = mergeConcerts(tm, jb);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "Ticketmaster");
});

test("byDateAsc orders earliest first, undated last", () => {
  const a = concert({ date: "2026-07-10" });
  const b = concert({ date: "2026-06-01" });
  const c = concert({ date: null });
  const sorted = [a, c, b].sort(byDateAsc);
  assert.deepEqual(sorted.map((x) => x.date), ["2026-06-01", "2026-07-10", null]);
});

test("toEnd pads a day so a late local show on the last day survives TM's UTC bound", () => {
  // The live bug: John Berry 2026-07-25 20:00 EDT is 2026-07-26T00:00Z, which the
  // old `${end}T23:59:59Z` bound excluded server-side. The pad must reach past it.
  assert.equal(toEnd("2026-07-25"), "2026-07-26T23:59:59Z");
  assert.ok(new Date("2026-07-26T00:00:00Z") < new Date(toEnd("2026-07-25")!));
  // Westernmost real offset (UTC-12): a local 23:59 on the 25th is 11:59Z on the 26th.
  assert.ok(new Date("2026-07-26T11:59:59Z") < new Date(toEnd("2026-07-25")!));
  assert.equal(toEnd(undefined), undefined);
});

test("toEnd rolls over month and year boundaries", () => {
  // Pure string concat would produce "2026-07-32" / "2026-13-01" here.
  assert.equal(toEnd("2026-07-31"), "2026-08-01T23:59:59Z");
  assert.equal(toEnd("2026-12-31"), "2027-01-01T23:59:59Z");
  assert.equal(toEnd("2028-02-28"), "2028-02-29T23:59:59Z"); // leap year
  assert.equal(toEnd("2026-02-28"), "2026-03-01T23:59:59Z"); // non-leap
});

test("toStart is deliberately unpadded", () => {
  // Padding it would cost real results: earlier events sort first under date,asc,
  // consume the result cap, then get trimmed away. For US (negative) offsets a UTC
  // midnight start already precedes local midnight, so it over-fetches, never omits.
  assert.equal(toStart("2026-07-18"), "2026-07-18T00:00:00Z");
  assert.equal(toStart(undefined), undefined);
});

test("applyDateWindow trims back what toEnd's pad over-fetches", () => {
  // The two halves of the invariant, exercised together: the pad lets TM return
  // the next local day, and the trim is what keeps it out of the answer.
  const lastDayLate = concert({ date: "2026-07-25", time: "20:00:00" });
  const nextDay = concert({ date: "2026-07-26", time: "19:00:00" }); // only here because of the pad
  const out = applyDateWindow([lastDayLate, nextDay], "2026-07-18", "2026-07-25");
  assert.deepEqual(out, [lastDayLate]);
});

test("applyDateWindow drops events outside the local-date window", () => {
  const before = concert({ date: "2026-05-28" }); // the UTC-boundary leak
  const inside = concert({ date: "2026-05-30" });
  const after = concert({ date: "2026-06-01" });
  const undated = concert({ date: null });
  const out = applyDateWindow([before, inside, after, undated], "2026-05-29", "2026-05-31");
  assert.deepEqual(out, [inside]); // before/after trimmed; undated dropped in a dated search
});

test("applyDateWindow honors one-sided bounds and is a no-op with none", () => {
  const a = concert({ date: "2026-05-28" });
  const b = concert({ date: "2026-05-30" });
  assert.deepEqual(applyDateWindow([a, b], "2026-05-29", undefined), [b]); // start only
  assert.deepEqual(applyDateWindow([a, b], undefined, "2026-05-29"), [a]); // end only
  assert.deepEqual(applyDateWindow([a, b], undefined, undefined), [a, b]); // no bounds
});

test("applyMaxPrice keeps null-price events, drops over-budget", () => {
  const cheap = concert({ priceMin: 20 });
  const pricey = concert({ priceMin: 200 });
  const unknown = concert({ priceMin: null });
  const out = applyMaxPrice([cheap, pricey, unknown], 50);
  assert.equal(out.length, 2);
  assert.ok(out.includes(cheap) && out.includes(unknown));
  assert.ok(!out.includes(pricey));
});

test("canonical folds typographic variants but never distinct names", () => {
  // The live dupe: TM writes U+0027, JamBase writes U+2019 — one name, two encodings.
  assert.equal(canonical("Nocturne’s Kiss"), canonical("Nocturne's Kiss"));
  assert.equal(canonical("Red Light Café"), "red light cafe"); // accent folded
  assert.equal(canonical("The  Eastern–GA"), "the eastern-ga"); // en dash + runs of space
  // Canonicalization is not fuzzy matching: distinct acts must stay distinct.
  assert.notEqual(canonical("Eagles"), canonical("Eagles of Death Metal"));
  assert.notEqual(canonical("mgk"), canonical("Machine Gun Kelly"));
});

test("mergeConcerts dedups across an apostrophe encoding mismatch", () => {
  // Regression: this pair shipped as two rows in a live Atlanta search.
  const tm = [
    concert({ artists: ["Nocturne's Kiss"], date: "2026-07-17", venue: "The Masquerade - Altar" }),
  ];
  const jb = [
    concert({
      artists: ["Nocturne’s Kiss"],
      date: "2026-07-17",
      venue: "The Masquerade (Altar)",
      source: "JamBase",
    }),
  ];
  const out = mergeConcerts(tm, jb);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "Ticketmaster");
});

test("mergeConcerts still keeps genuinely different acts apart", () => {
  const tm = [concert({ artists: ["Eagles"], date: "2026-07-17" })];
  const jb = [concert({ artists: ["Eagles of Death Metal"], date: "2026-07-17", source: "JamBase" })];
  assert.equal(mergeConcerts(tm, jb).length, 2);
});

test("dedupeWithinSource collapses a ticketing-partner dupe (live: Eddie's Attic, DICE + TM)", () => {
  // Regression: these shipped as two rows in a live Atlanta search on 2026-07-16.
  // One show, two TM event ids — identical but for the link.
  const tm = [
    concert({
      name: "Emerson Woolf & the Wishbones",
      artists: ["Emerson Woolf & the Wishbones"],
      date: "2026-07-18",
      time: "19:00:00",
      venue: "Eddie's Attic",
      url: "https://link.dice.fm/M1eeeefeb365",
    }),
    concert({
      name: "Emerson Woolf & the Wishbones",
      artists: ["Emerson Woolf & the Wishbones"],
      date: "2026-07-18",
      time: "19:00:00",
      venue: "Eddie's Attic",
      url: "https://www.ticketmaster.com/event/Z7r9jZ1A7PxJ9",
    }),
  ];
  assert.equal(dedupeWithinSource(tm).length, 1);
});

test("dedupeWithinSource keeps the more complete copy of a partner dupe", () => {
  // The live pair: the partner row names the support act, the native row doesn't.
  // Equal field counts, so the richer name decides — losing it would drop real data.
  const partner = concert({
    name: "Austin Meade with Cole Barnhill",
    artists: ["Austin Meade"],
    date: "2026-07-21",
    time: "19:00:00",
    venue: "Eddie's Attic",
    url: "https://link.dice.fm/C727e445d5b8",
  });
  const native = concert({
    name: "Austin Meade",
    artists: ["Austin Meade"],
    date: "2026-07-21",
    time: "19:00:00",
    venue: "Eddie's Attic",
    url: "https://www.ticketmaster.com/event/Z7r9jZ1A7PNF6",
  });
  assert.equal(dedupeWithinSource([partner, native])[0].name, "Austin Meade with Cole Barnhill");
  // Order-independent: the richer row wins from either position.
  assert.equal(dedupeWithinSource([native, partner])[0].name, "Austin Meade with Cole Barnhill");
  // A populated field outranks a longer name.
  const priced = concert({ name: "X", artists: ["A"], date: "2026-07-21", time: "19:00:00", priceMin: 20 });
  const wordy = concert({ name: "X with a very long support billing", artists: ["A"], date: "2026-07-21", time: "19:00:00" });
  assert.equal(dedupeWithinSource([wordy, priced])[0].priceMin, 20);
});

test("dedupeWithinSource prefers a real genre over TM's catch-all", () => {
  // Live: TM returned John Berry 2026-07-25 18:00 three times — "Other" on one event
  // id, "Country" on two others. Counting "Other" as populated made them tie, so
  // first-seen won and the catch-all shipped. Both values are TM's own for one show.
  const catchAll = concert({ artists: ["John Berry"], date: "2026-07-25", time: "18:00:00", genre: "Other" });
  const real = concert({ artists: ["John Berry"], date: "2026-07-25", time: "18:00:00", genre: "Country" });
  assert.equal(dedupeWithinSource([catchAll, real])[0].genre, "Country");
  assert.equal(dedupeWithinSource([real, catchAll])[0].genre, "Country"); // order-independent
  // Honest floor: if every copy is a catch-all, that IS what TM knows — don't blank it.
  const both = dedupeWithinSource([catchAll, concert({ artists: ["John Berry"], date: "2026-07-25", time: "18:00:00", genre: "Undefined" })]);
  assert.equal(both.length, 1);
  assert.equal(both[0].genre, "Other");
  // A catch-all must not outrank a real genre just by carrying a longer name.
  const wordy = concert({ artists: ["A"], date: "2026-07-25", time: "19:00:00", genre: "Other", name: "A with a long billing" });
  const terse = concert({ artists: ["A"], date: "2026-07-25", time: "19:00:00", genre: "Jazz", name: "A" });
  assert.equal(dedupeWithinSource([wordy, terse])[0].genre, "Jazz");
});

test("dedupeWithinSource does NOT collapse an early/late double-header", () => {
  // The regression this key exists to prevent. Eddie's Attic runs two separate,
  // separately-ticketed shows a night; artist+date alone would hide one of them.
  const tm = [
    concert({ artists: ["Shawn Mullins"], date: "2026-07-18", time: "19:00:00", venue: "Eddie's Attic" }),
    concert({ artists: ["Shawn Mullins"], date: "2026-07-18", time: "21:30:00", venue: "Eddie's Attic" }),
  ];
  assert.equal(dedupeWithinSource(tm).length, 2);
});

test("dedupeWithinSource preserves first-seen order while swapping in the richer row", () => {
  const a = concert({ artists: ["A"], date: "2026-07-01", time: "19:00:00" });
  const dupeOfA = concert({ artists: ["A"], date: "2026-07-01", time: "19:00:00", priceMin: 25 });
  const b = concert({ artists: ["B"], date: "2026-07-02", time: "20:00:00" });
  const out = dedupeWithinSource([a, b, dupeOfA]);
  assert.deepEqual(out.map((c) => c.artists[0]), ["A", "B"]); // A holds its slot, not moved to the end
  assert.equal(out[0].priceMin, 25); // but the richer copy is the one kept
});

test("dedupeWithinSource leaves distinct acts and dates alone", () => {
  const tm = [
    concert({ artists: ["Eagles"], date: "2026-07-17", time: "20:00:00" }),
    concert({ artists: ["Eagles of Death Metal"], date: "2026-07-17", time: "20:00:00" }),
    concert({ artists: ["Eagles"], date: "2026-07-18", time: "20:00:00" }),
  ];
  assert.equal(dedupeWithinSource(tm).length, 3);
  assert.deepEqual(dedupeWithinSource([]), []);
});

test("artistMatches accepts the loose matches Bryan called in (tribute, presenter, buried)", () => {
  // Product call 2026-07-17: feeds carry the post TITLE as the artist, so all three
  // of these are intended hits. Live rows from the Red Light Café feed.
  const tribute = concert({ name: "Sade vs Prince JAM (BadAsh Allstar Team)", artists: ["Sade vs Prince JAM (BadAsh Allstar Team)"] });
  const presenter = concert({ name: "Keena Graham presents Ladies in the Round '26", artists: ["Keena Graham presents Ladies in the Round '26"] });
  const buried = concert({ name: "Wednesday Jazz Jam w/ the Gordon Vernick Quartet", artists: ["Wednesday Jazz Jam w/ the Gordon Vernick Quartet"] });
  assert.ok(artistMatches(tribute, "Prince")); // the subject, not the performer — intended
  assert.ok(artistMatches(tribute, "Sade"));
  assert.ok(artistMatches(presenter, "Keena Graham"));
  assert.ok(artistMatches(buried, "Gordon Vernick Quartet")); // the payoff of matching loosely
  assert.ok(!artistMatches(buried, "Boom! Trio"));
});

test("artistMatches is ONE-directional, unlike venueMatches", () => {
  // venueMatches allows query.includes(venue) because both sides name a room.
  // Here the sides are a performer and a sentence: a short title must NOT match a
  // long query, or "Hex & the City" swallows any query containing "hex".
  const short = concert({ name: "Hex", artists: ["Hex"] });
  assert.ok(!artistMatches(short, "Hex & the City: Wet, Hot, ATL Summer"));
  assert.ok(artistMatches(concert({ name: "Hex & the City: Wet, Hot, ATL Summer", artists: ["Hex & the City: Wet, Hot, ATL Summer"] }), "Hex"));
});

test("artistMatches folds encodings and floors short queries", () => {
  const c = concert({ name: "Nocturne’s Kiss w/ guests", artists: ["Nocturne’s Kiss w/ guests"] });
  assert.ok(artistMatches(c, "Nocturne's Kiss")); // U+0027 query vs U+2019 title
  assert.ok(artistMatches(concert({ name: "Red Light Café Sessions", artists: ["Red Light Café Sessions"] }), "red light cafe"));
  assert.ok(!artistMatches(c, "of")); // under the 3-char floor — would match half a calendar
  assert.ok(!artistMatches(concert({ name: "Boom! Trio", artists: [] }), "xy"));
  // name is checked when artists is empty (feed rows always carry both; TM may not)
  assert.ok(artistMatches(concert({ name: "Boom! Trio", artists: [] }), "Boom! Trio"));
});

test("venueMatches resolves a typed query against feed venue formatting", () => {
  assert.ok(venueMatches("Red Light Café", "Red Light Cafe")); // the false-absence bug
  assert.ok(venueMatches("Red Light Café", "red light cafe"));
  assert.ok(venueMatches("Red Light Café", "Red Light")); // partial typed name
  assert.ok(!venueMatches("Red Light Café", "Eddie's Attic"));
  assert.ok(!venueMatches(null, "Red Light Cafe"));
  assert.ok(!venueMatches("Red Light Café", "ab")); // under the 3-char floor
});
