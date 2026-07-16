/**
 * Unit tests for the pure merge/dedup/sort helpers — the Ticketmaster↔feed
 * integration point. Deterministic proof (the live smoke can't reliably show
 * the merge, since TM often has sooner events that fill the top slots).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDateWindow, applyMaxPrice, byDateAsc, canonical, mergeConcerts, venueMatches } from "./merge.js";
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

test("venueMatches resolves a typed query against feed venue formatting", () => {
  assert.ok(venueMatches("Red Light Café", "Red Light Cafe")); // the false-absence bug
  assert.ok(venueMatches("Red Light Café", "red light cafe"));
  assert.ok(venueMatches("Red Light Café", "Red Light")); // partial typed name
  assert.ok(!venueMatches("Red Light Café", "Eddie's Attic"));
  assert.ok(!venueMatches(null, "Red Light Cafe"));
  assert.ok(!venueMatches("Red Light Café", "ab")); // under the 3-char floor
});
