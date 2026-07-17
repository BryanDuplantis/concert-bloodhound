/**
 * Offline guard for the Kennesaw WP-news lineup parser. The load-bearing
 * parts: venue routing by post title (a post matching neither series is
 * skipped, never guessed), season year from the title with publish-year
 * fallback, and the house "Month D – Artist<br/>blurb" format. Fixture
 * content is verbatim from the live 2026 posts (2026-07-17). Run via
 * `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  venueForPost,
  seasonYear,
  parseKennesawActs,
  fetchKennesawConcerts,
} from "./kennesaw.js";
import type { FeedSource } from "./registry.js";

const SRC: FeedSource = {
  id: "kennesaw-news",
  name: "City of Kennesaw",
  metro: "atlanta",
  type: "wp-json",
  url: "https://www.kennesaw-ga.gov/wp-json/wp/v2/posts?search=concert%20series&per_page=10",
};

// ----- venue routing -----

test("venueForPost: the two known series route; anything else is null (skip, never guess)", () => {
  assert.equal(
    venueForPost("First Friday Concert Series Returns to Downtown Kennesaw for 2026 Season"),
    "Downtown Kennesaw",
  );
  assert.equal(
    venueForPost("2026 Kennesaw Concert Series Brings Legendary Sounds to Depot Park"),
    "United Bankshares Amphitheater at Depot Park",
  );
  assert.equal(venueForPost("Kennesaw Holly Days 2025 Holiday Events"), null);
});

// ----- season year -----

test("seasonYear: title year wins; publish year is the fallback; neither -> null", () => {
  assert.equal(seasonYear("2026 Kennesaw Concert Series", "2026-02-03T14:00:00"), 2026);
  // December announcement of next season: the title's year must beat the publish year
  assert.equal(seasonYear("Concert Series returns for 2027", "2026-12-15T09:00:00"), 2027);
  assert.equal(seasonYear("Concert Series returns", "2026-03-19T14:19:11"), 2026);
  assert.equal(seasonYear("Concert Series returns", undefined), null);
});

// ----- act parsing (verbatim house format) -----

const DEPOT_CONTENT = `
<p>From classic rock icons to throwback pop, the 2026 lineup is packed</p>
<p>March 28 &#8211; Night Ranger<br />
Night Ranger takes the stage with four decades of chart-topping hits.</p>
<p>August 22 &#8211; Rumours ATL: A Fleetwood Mac Tribute<br />
Widely praised for their authenticity and musicianship.</p>
<p>Concert Season Seats are available for $100 per seat.</p>`;

test("parseKennesawActs: extracts date/artist/blurb; prose paragraphs don't parse as acts", () => {
  const acts = parseKennesawActs(DEPOT_CONTENT, 2026);
  assert.equal(acts.length, 2);
  assert.deepEqual(acts[0], {
    date: "2026-03-28",
    artist: "Night Ranger",
    description: "Night Ranger takes the stage with four decades of chart-topping hits.",
  });
  // an artist name containing a colon survives whole
  assert.equal(acts[1]!.artist, "Rumours ATL: A Fleetwood Mac Tribute");
  assert.equal(acts[1]!.date, "2026-08-22");
});

test("parseKennesawActs: ADVERSARIAL — junk months and dates drop the line, never guess", () => {
  const acts = parseKennesawActs("<p>Smarch 5 – Ghost Band<br/>bio</p><p>May 45 – Nope</p>", 2026);
  assert.equal(acts.length, 0);
});

// ----- fetch pipeline -----

function wpFixture(): unknown[] {
  return [
    {
      date: "2026-03-19T14:19:11",
      link: "https://www.kennesaw-ga.gov/first-friday-concert-series-returns-to-downtown-kennesaw-for-2026-season/",
      title: { rendered: "First Friday Concert Series Returns to Downtown Kennesaw for 2026 Season" },
      content: {
        rendered:
          "<p>The lineup for the 2026 First Friday Concert Series is as follows:</p>" +
          "<p>October 2 &#8211; Groove Daddies<br />The Groove Daddies perform a mix of blues, rock and classic hits.</p>",
      },
    },
    {
      date: "2026-02-03T10:00:00",
      link: "https://www.kennesaw-ga.gov/2026-kennesaw-concert-series-brings-legendary-sounds-to-depot-park/",
      title: { rendered: "2026 Kennesaw Concert Series Brings Legendary Sounds to Depot Park" },
      content: { rendered: DEPOT_CONTENT },
    },
    {
      // series-adjacent post with NO venue signal — must be skipped entirely
      date: "2026-01-10T10:00:00",
      link: "https://www.kennesaw-ga.gov/concert-series-seat-sales/",
      title: { rendered: "Concert Series Season Seats On Sale" },
      content: { rendered: "<p>April 4 &#8211; Phantom Band<br />Should never appear.</p>" },
    },
  ];
}

test("fetchKennesawConcerts (fetch stub): both series parse, venues route by title, unknown-venue post skipped", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(wpFixture()), { status: 200 })) as typeof fetch;
  try {
    const { concerts, horizon } = await fetchKennesawConcerts(SRC, {});
    assert.equal(concerts.length, 3); // 1 First Friday + 2 Depot; Phantom Band skipped
    const ff = concerts.find((c) => c.name === "Groove Daddies")!;
    assert.equal(ff.venue, "Downtown Kennesaw");
    assert.equal(ff.date, "2026-10-02");
    assert.equal(ff.time, null); // times only exist as prose ranges — never guessed
    assert.equal(ff.genre, null); // STANDING RULE — feed layer never infers genre
    assert.ok(ff.url!.includes("first-friday"));
    const depot = concerts.find((c) => c.name === "Night Ranger")!;
    assert.equal(depot.venue, "United Bankshares Amphitheater at Depot Park");
    assert.equal(depot.city, "Kennesaw");
    assert.ok(depot.description!.startsWith("Night Ranger takes the stage"));
    assert.equal(horizon, "2026-10-02");
    assert.ok(!concerts.some((c) => c.name === "Phantom Band"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchKennesawConcerts: window filtering keeps horizon from the full parse", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(wpFixture()), { status: 200 })) as typeof fetch;
  try {
    const { concerts, horizon } = await fetchKennesawConcerts(SRC, {
      start: "2026-08-01",
      end: "2026-08-31",
    });
    assert.deepEqual(concerts.map((c) => c.date), ["2026-08-22"]);
    assert.equal(horizon, "2026-10-02");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchKennesawConcerts: ADVERSARIAL — structural drift (0 acts) throws rather than returning []", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ title: { rendered: "Unrelated News" }, content: { rendered: "<p>hi</p>" } }]), {
      status: 200,
    })) as typeof fetch;
  try {
    await assert.rejects(() => fetchKennesawConcerts(SRC, {}), /structural drift/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
