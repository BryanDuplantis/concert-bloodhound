/**
 * Offline guard for the Freshtix (The EARL) parser. Covers the two things
 * this source invents nothing about (time, price) plus the one genuinely
 * hard problem the page hands us: no year on any day header, so `assignYears`
 * carries the whole correctness burden for every date this source emits.
 * Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFreshtixTime,
  parseFreshtixPrice,
  parseFreshtixDays,
  assignYears,
  fetchFreshtixConcerts,
} from "./freshtix.js";
import type { FeedSource } from "./registry.js";

const SRC: FeedSource = {
  id: "earl-freshtix",
  name: "The EARL (Freshtix)",
  metro: "atlanta",
  type: "html",
  url: "https://badearl.freshtix.com/",
};

// ----- time -----

test("parseFreshtixTime: 12h clock -> HH:MM:SS", () => {
  assert.equal(parseFreshtixTime("8:30pm"), "20:30:00");
  assert.equal(parseFreshtixTime(" 8:00 PM "), "20:00:00");
  assert.equal(parseFreshtixTime("12:00pm"), "12:00:00"); // noon
  assert.equal(parseFreshtixTime("12:00am"), "00:00:00"); // midnight
  assert.equal(parseFreshtixTime("7:05am"), "07:05:00");
});

test("parseFreshtixTime: ADVERSARIAL — unparseable input returns null, never a guess", () => {
  assert.equal(parseFreshtixTime(""), null);
  assert.equal(parseFreshtixTime("Doors at 7"), null);
  assert.equal(parseFreshtixTime("13:00pm"), null); // not a real 12h hour
  assert.equal(parseFreshtixTime("TBD"), null);
});

// ----- price -----

test("parseFreshtixPrice: range and single-value forms", () => {
  assert.deepEqual(parseFreshtixPrice("$16.00\n- $18.00"), { min: 16, max: 18 });
  assert.deepEqual(parseFreshtixPrice("$15.00"), { min: 15, max: 15 });
  assert.deepEqual(parseFreshtixPrice("$1,250.00"), { min: 1250, max: 1250 }); // comma thousands
});

test("parseFreshtixPrice: absent/unparseable -> both null, never invented", () => {
  assert.deepEqual(parseFreshtixPrice(undefined), { min: null, max: null });
  assert.deepEqual(parseFreshtixPrice("Free"), { min: null, max: null });
});

// ----- year inference (the hard part — no year anywhere on the page) -----

test("assignYears: same-year run keeps the reference year throughout", () => {
  const days = [
    { month: 7, day: 17, block: "" },
    { month: 7, day: 18, block: "" },
    { month: 11, day: 20, block: "" },
  ];
  const out = assignYears(days, new Date("2026-07-17T12:00:00"));
  assert.deepEqual(out.map((d) => d.year), [2026, 2026, 2026]);
});

test("assignYears: Dec -> Jan rollover mid-list bumps the year", () => {
  const days = [
    { month: 12, day: 20, block: "" },
    { month: 12, day: 31, block: "" },
    { month: 1, day: 5, block: "" }, // rolls into next year
    { month: 1, day: 20, block: "" },
  ];
  const out = assignYears(days, new Date("2026-12-01T12:00:00"));
  assert.deepEqual(out.map((d) => d.year), [2026, 2026, 2027, 2027]);
});

test("assignYears: fetched in December, list STARTS with a January show — starts next year, not this one", () => {
  const days = [{ month: 1, day: 5, block: "" }];
  const out = assignYears(days, new Date("2026-12-15T12:00:00"));
  assert.equal(out[0]!.year, 2027);
});

test("assignYears: empty list is a no-op", () => {
  assert.deepEqual(assignYears([], new Date("2026-07-17T12:00:00")), []);
});

// ----- full HTML parse (captured shape, 2026-07-17 recon) -----

const HTML_FIXTURE = `
<div class="row" id="list-view">
  <ol id="ft-date-list">
    <li>
      <h2><strong>Friday</strong> July 17th</h2>
      <ol id="ft-event-list">
        <li style="margin: 1em 0 1em 0;">
          <div class="row">
            <div class="col-xs-12">
              <h3><a href="https://badearl.freshtix.com/events/solid-state-radio-skin-jobs-bad-spell-the-earl?utm_campaign=Freshtix&amp;utm_medium=Freshtix&amp;utm_source=Freshtix">Solid State Radio / Skin Jobs / Bad Spell</a></h3>
              <div class="ft-event-when"> 8:30pm </div>
              <div class="ft-event-where"> The EARL </div>
              <div class="ft-event-price-range"> $16.00 - $18.00 </div>
              <a class="ft-button" href="/events/solid-state-radio-skin-jobs-bad-spell-the-earl">Find Tickets</a>
            </div>
          </div>
        </li>
      </ol>
    </li>
    <li>
      <h2><strong>Saturday</strong> July 18th</h2>
      <ol id="ft-event-list">
        <li style="margin: 1em 0 1em 0;">
          <div class="row">
            <div class="col-xs-12">
              <h3><a href="https://badearl.freshtix.com/events/psychic-death-the-earl">Psychic Death &amp; Friends</a></h3>
              <div class="ft-event-when"> 8:30pm </div>
              <div class="ft-event-where"> The EARL </div>
              <div class="ft-event-price-range"> $15.00 </div>
              <a class="ft-button" href="/events/psychic-death-the-earl">Find Tickets</a>
            </div>
          </div>
        </li>
      </ol>
    </li>
  </ol>
</div>`;

test("parseFreshtixDays: extracts month/day + per-day block, in document order", () => {
  const days = parseFreshtixDays(HTML_FIXTURE);
  assert.equal(days.length, 2);
  assert.deepEqual(
    days.map((d) => [d.month, d.day]),
    [
      [7, 17],
      [7, 18],
    ],
  );
});

test("fetchFreshtixConcerts (via a fetch stub): decodes entities in title AND url, parses time/price, never invents genre", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(HTML_FIXTURE, { status: 200 })) as typeof fetch;
  try {
    const concerts = await fetchFreshtixConcerts(SRC, {}, new Date("2026-07-17T12:00:00"));
    assert.equal(concerts.length, 2);

    const first = concerts[0]!;
    assert.equal(first.name, "Solid State Radio / Skin Jobs / Bad Spell");
    assert.equal(first.date, "2026-07-17");
    assert.equal(first.time, "20:30:00");
    assert.equal(first.venue, "The EARL");
    assert.equal(first.priceMin, 16);
    assert.equal(first.priceMax, 18);
    assert.equal(first.genre, null); // STANDING RULE — feed layer never infers genre
    assert.equal(first.source, "The EARL (Freshtix)");
    // href entities decoded: a literal "&amp;" must not survive into the link
    assert.ok(first.url!.includes("utm_medium=Freshtix&utm_source"));
    assert.ok(!first.url!.includes("&amp;"));

    const second = concerts[1]!;
    assert.equal(second.name, "Psychic Death & Friends"); // title entity decoded too
    assert.equal(second.priceMin, 15);
    assert.equal(second.priceMax, 15);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchFreshtixConcerts: ADVERSARIAL — structural drift (0 day headers) throws rather than returning []", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html><body>totally different markup</body></html>", {
      status: 200,
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchFreshtixConcerts(SRC, {}, new Date("2026-07-17T12:00:00")),
      /structural drift/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchFreshtixConcerts: window filtering excludes out-of-range dates", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(HTML_FIXTURE, { status: 200 })) as typeof fetch;
  try {
    const concerts = await fetchFreshtixConcerts(
      SRC,
      { start: "2026-07-18", end: "2026-07-18" },
      new Date("2026-07-17T12:00:00"),
    );
    assert.equal(concerts.length, 1);
    assert.equal(concerts[0]!.date, "2026-07-18");
  } finally {
    globalThis.fetch = realFetch;
  }
});
