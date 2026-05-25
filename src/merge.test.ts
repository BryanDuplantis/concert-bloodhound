/**
 * Unit tests for the pure merge/dedup/sort helpers — the Ticketmaster↔feed
 * integration point. Deterministic proof (the live smoke can't reliably show
 * the merge, since TM often has sooner events that fill the top slots).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMaxPrice, byDateAsc, mergeConcerts } from "./merge.js";
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

test("byDateAsc orders earliest first, undated last", () => {
  const a = concert({ date: "2026-07-10" });
  const b = concert({ date: "2026-06-01" });
  const c = concert({ date: null });
  const sorted = [a, c, b].sort(byDateAsc);
  assert.deepEqual(sorted.map((x) => x.date), ["2026-06-01", "2026-07-10", null]);
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
