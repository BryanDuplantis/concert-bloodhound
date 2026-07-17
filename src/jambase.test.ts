/**
 * Offline guard for normalizeJamBaseEvent. Fixtures mirror the live v3 shapes
 * observed 2026-05-25 (a free festival, a paid concert). Locks the tricky
 * branches — festival-name headline, date-only vs ISO datetime, empty offers →
 * null price, headliner-only genre, GA region — so a future shape drift is caught
 * without a network call. Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeJamBaseEvent,
  headlinerMatchesGenre,
  resolveGenreSlug,
  headlinerCarriesSlug,
} from "./jambase.js";

// Free festival: date-only startDate, empty offers, top performer has no genre.
const festival = {
  "@type": "Festival",
  name: "Atlanta Jazz Festival",
  url: "https://www.jambase.com/festival/atlanta-jazz-festival-2026",
  eventStatus: "scheduled",
  startDate: "2026-05-23",
  endDate: "2026-05-25",
  location: {
    name: "Piedmont Park",
    address: {
      addressLocality: "Atlanta",
      addressRegion: { identifier: "US-GA", name: "Georgia", alternateName: "GA" },
    },
  },
  offers: [],
  performer: [
    { name: "Buddy Red", genre: [], "x-isHeadliner": false },
    { name: "Nate Smith (Drummer)", genre: ["indie", "jazz"], "x-isHeadliner": false },
  ],
};

// Paid concert: ISO local datetime, headliner carries genre, offer is a bare
// ticketing link with an empty priceSpecification (no price on this API tier).
const concert = {
  "@type": "Concert",
  name: "mgk at Lakewood Amphitheatre",
  url: "https://www.jambase.com/show/mgk-lakewood",
  eventStatus: "scheduled",
  startDate: "2026-05-29T19:00:00",
  location: {
    name: "Lakewood Amphitheatre",
    address: {
      addressLocality: "Atlanta",
      addressRegion: { name: "Georgia", alternateName: "GA" },
    },
  },
  offers: [{ url: "https://ticketmaster.example/affiliate", priceSpecification: {} }],
  performer: [
    { name: "mgk", genre: ["hip-hop-rap", "pop"], "x-isHeadliner": true },
    { name: "Wiz Khalifa", genre: ["hip-hop-rap"], "x-isHeadliner": false },
  ],
};

test("festival: event name headlines (artists emptied), date-only, GA region", () => {
  const c = normalizeJamBaseEvent(festival);
  assert.equal(c.name, "Atlanta Jazz Festival");
  assert.deepEqual(c.artists, []); // festival → name is the headline, not the bill
  assert.equal(c.date, "2026-05-23");
  assert.equal(c.time, null);
  assert.equal(c.dateTBD, false);
  assert.equal(c.region, "GA"); // prefers alternateName, matching TM's stateCode
  assert.equal(c.venue, "Piedmont Park");
  assert.equal(c.availability, "Scheduled");
  assert.equal(c.source, "JamBase");
});

test("festival: empty offers → null price; non-headliner genre is NOT borrowed", () => {
  const c = normalizeJamBaseEvent(festival);
  assert.equal(c.priceMin, null);
  assert.equal(c.priceMax, null);
  assert.equal(c.currency, null);
  assert.equal(c.genre, null); // top act (Buddy Red) has no genre; we don't scan down
  assert.equal(c.url, "https://www.jambase.com/festival/atlanta-jazz-festival-2026");
});

test("concert: artist lineup, ISO datetime split, headliner genre, link prefers event page", () => {
  const c = normalizeJamBaseEvent(concert);
  assert.deepEqual(c.artists, ["mgk", "Wiz Khalifa"]);
  assert.equal(c.date, "2026-05-29");
  assert.equal(c.time, "19:00:00");
  assert.equal(c.genre, "Hip Hop Rap"); // from the headliner, slug prettified
  assert.equal(c.priceMin, null); // empty priceSpecification → never assert a number
  assert.equal(c.url, "https://www.jambase.com/show/mgk-lakewood"); // e.url over affiliate offer
});

test("headlinerMatchesGenre: token-subset match on the headliner's tags only", () => {
  // mgk headliner tags ["hip-hop-rap","pop"]; festival top act has none.
  assert.equal(headlinerMatchesGenre(concert, "hip-hop"), true); // {hip,hop} ⊆ {hip,hop,rap}
  assert.equal(headlinerMatchesGenre(concert, "rap"), true); // matches a tag token
  assert.equal(headlinerMatchesGenre(concert, "pop"), true); // matches the 2nd slug
  assert.equal(headlinerMatchesGenre(concert, "jazz"), false); // not in headliner's tags
  assert.equal(headlinerMatchesGenre(festival, "jazz"), false); // top act (Buddy Red) has no genre → never guess
  assert.equal(headlinerMatchesGenre({ performer: [{ genre: ["trap"] }] }, "rap"), false); // "rap" ⊄ "trap"
  assert.equal(headlinerMatchesGenre(concert, ""), true); // empty request → no constraint
});

test("resolveGenreSlug: exact vocabulary hit wins before subset — 'blues' is Blues, never R&B/Soul", () => {
  assert.equal(resolveGenreSlug("blues"), "blues");
  assert.equal(resolveGenreSlug("Jazz"), "jazz");
  assert.equal(resolveGenreSlug("EDM"), "edm");
});

test("resolveGenreSlug: display-name tokens bridge the taxonomy gap — 'R&B' reaches rhythm-and-blues-soul", () => {
  assert.equal(resolveGenreSlug("R&B"), "rhythm-and-blues-soul");
  assert.equal(resolveGenreSlug("soul"), "rhythm-and-blues-soul");
  assert.equal(resolveGenreSlug("rap"), "hip-hop-rap");
  assert.equal(resolveGenreSlug("hip hop"), "hip-hop-rap");
  assert.equal(resolveGenreSlug("country"), "country-music");
});

test("resolveGenreSlug: no unique fit → null (withhold the param, fall back to client-side)", () => {
  assert.equal(resolveGenreSlug("zydeco"), null); // not in the vocabulary
  assert.equal(resolveGenreSlug("indie rock"), null); // spans two entries, no single fit
  assert.equal(resolveGenreSlug(""), null);
  assert.equal(resolveGenreSlug("  /  "), null); // no tokens at all
});

test("headlinerCarriesSlug: exact slug on the top-billed act only — never an opener's", () => {
  assert.equal(headlinerCarriesSlug(concert, "hip-hop-rap"), true);
  assert.equal(headlinerCarriesSlug(concert, "rap"), false); // exact match, not tokens
  assert.equal(headlinerCarriesSlug(festival, "jazz"), false); // opener has jazz; headliner has none
  assert.equal(headlinerCarriesSlug({}, "jazz"), false);
});
