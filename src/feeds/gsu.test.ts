/**
 * Offline guard for the GSU Localist normalizer. The load-bearing parts:
 * client-side verification of GSU's own music tag (correctness never depends
 * on the server honoring `type[]`), per-date instance dedup, valid-empty
 * (out-of-semester) vs structural drift (no events array), and ticket_cost
 * riding as description text, never parsed into price fields. Fixture values
 * are verbatim from the live API (2026-07-17). Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cityRegionFromAddress, hasMusicTag, parseGsuEvents, type LocalistEvent } from "./gsu.js";
import type { FeedSource } from "./registry.js";

const SRC: FeedSource = {
  id: "gsu-localist",
  name: "Georgia State University",
  metro: "atlanta",
  type: "localist",
  url: "https://calendar.gsu.edu/api/2/events",
};

const MUSIC_FILTERS = {
  event_fine_arts_events: [{ name: "Music Concerts", id: 52620491419918 }],
};

function ev(overrides: Partial<LocalistEvent>): { event: LocalistEvent } {
  return {
    event: {
      title: "Bela Fleck: My Bluegrass Heart",
      location_name: "Rialto Center for the Arts",
      address: "80 Forsyth Street, Atlanta, GA ",
      ticket_cost: "$50, $60, $70, $90",
      ticket_url: "https://rialto.gsu.edu/bela-fleck/",
      localist_url: "https://calendar.gsu.edu/event/bela-fleck-my-bluegrass-heart",
      description_text: "Over the past half-century, Béla Fleck has expanded the banjo.",
      event_instances: [
        {
          event_instance: { id: 52862179613215, start: "2026-09-17T20:00:00-04:00", all_day: false },
        },
      ],
      filters: MUSIC_FILTERS,
      ...overrides,
    },
  };
}

test("hasMusicTag: publisher's own label decides; untagged campus events are dropped", () => {
  assert.equal(hasMusicTag(ev({}).event), true);
  assert.equal(hasMusicTag(ev({ filters: {} }).event), false);
  assert.equal(
    hasMusicTag(ev({ filters: { event_fine_arts_events: [{ name: "Theatre" }] } }).event),
    false,
  );
});

test("cityRegionFromAddress: trailing City, ST parses; anything else stays null, never guessed", () => {
  assert.deepEqual(cityRegionFromAddress("80 Forsyth Street, Atlanta, GA "), {
    city: "Atlanta",
    region: "GA",
  });
  assert.deepEqual(cityRegionFromAddress(undefined), { city: null, region: null });
  assert.deepEqual(cityRegionFromAddress("Kopleff Recital Hall"), { city: null, region: null });
});

test("normalizes a tagged timed event; ticket_cost rides in description, price fields stay null", () => {
  const { concerts, horizon } = parseGsuEvents([{ events: [ev({})] }], SRC);
  assert.equal(concerts.length, 1);
  const c = concerts[0]!;
  assert.equal(c.date, "2026-09-17");
  assert.equal(c.time, "20:00:00");
  assert.equal(c.venue, "Rialto Center for the Arts");
  assert.equal(c.city, "Atlanta");
  assert.equal(c.region, "GA");
  assert.equal(c.genre, null);
  assert.equal(c.priceMin, null);
  assert.equal(c.priceMax, null);
  assert.match(c.description ?? "", /Tickets: \$50, \$60, \$70, \$90/);
  assert.equal(c.url, "https://rialto.gsu.edu/bela-fleck/");
  assert.equal(horizon, "2026-09-17");
});

test("untagged events are excluded even if the server returned them unfiltered", () => {
  const rows = [ev({}), ev({ title: "GSU Recruiter Roundtable", filters: {} })];
  const { concerts } = parseGsuEvents([{ events: rows }], SRC);
  assert.deepEqual(
    concerts.map((c) => c.name),
    ["Bela Fleck: My Bluegrass Heart"],
  );
});

test("repeated per-date event objects dedupe on instance id", () => {
  const twice = [ev({}), ev({})];
  const { concerts } = parseGsuEvents([{ events: twice }], SRC);
  assert.equal(concerts.length, 1);
});

test("all_day instance gets a date but no time; undated event is dropped as noise", () => {
  const rows = [
    ev({
      title: "Holiday Gala",
      event_instances: [
        { event_instance: { id: 1, start: "2026-12-06T00:00:00-05:00", all_day: true } },
      ],
    }),
    ev({ title: "Undated", event_instances: [] }),
  ];
  const { concerts } = parseGsuEvents([{ events: rows }], SRC);
  assert.equal(concerts.length, 1);
  assert.equal(concerts[0]!.date, "2026-12-06");
  assert.equal(concerts[0]!.time, null);
});

test("window trims client-side but horizon reflects the full fetch", () => {
  const rows = [
    ev({}),
    ev({
      title: "29th Annual Holiday Gala",
      event_instances: [
        { event_instance: { id: 2, start: "2026-12-06T19:00:00-05:00", all_day: false } },
      ],
    }),
  ];
  const { concerts, horizon } = parseGsuEvents([{ events: rows }], SRC, {
    start: "2026-09-01",
    end: "2026-09-30",
  });
  assert.deepEqual(
    concerts.map((c) => c.name),
    ["Bela Fleck: My Bluegrass Heart"],
  );
  assert.equal(horizon, "2026-12-06");
});

test("empty events array is VALID (out-of-semester), not drift; missing array throws", () => {
  const empty = parseGsuEvents([{ events: [] }], SRC);
  assert.deepEqual(empty, { concerts: [], horizon: null });
  assert.throws(() => parseGsuEvents([{} as never], SRC), /structural drift/);
});
