/**
 * Offline guard for slugDate — the Red Light Café event-date extractor. The event
 * date lives ONLY in the URL slug's trailing `-mon-dd-yyyy`; <pubDate> is the post
 * publish time and must never be used as the event date. The adversarial cases
 * (no date / month-like-but-incomplete) lock the parse-or-null contract: a slug
 * that isn't a clean trailing date returns null, never a guessed date. Run via
 * `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugDate, parseRedLightItems, itemToConcert, fetchRedLightConcerts } from "./redlight.js";
import { sanitizeConcert } from "../types.js";
import type { FeedSource } from "./registry.js";

const SRC: FeedSource = {
  id: "redlight",
  name: "Red Light Café",
  metro: "atlanta",
  type: "rss",
  url: "https://redlightcafe.com/events?format=rss",
};
const link = (slug: string) => `https://redlightcafe.com/events/${slug}`;

test("slugDate: clean trailing -mon-dd-yyyy parses to YYYY-MM-DD", () => {
  assert.equal(slugDate("event-jun-27-2026"), "2026-06-27");
  assert.equal(slugDate("some-show-jan-1-2027"), "2027-01-01"); // single-digit day → zero-padded
});

test("slugDate: real live-feed slugs (captured 2026-06-25)", () => {
  assert.equal(
    slugDate("http://redlightcafe.com/events/khari-cabral-simmons-live-at-red-light-cafe-jun-27-2026"),
    "2026-06-27",
  );
  assert.equal(
    slugDate("http://redlightcafe.com/events/wednesday-jazz-jam-gordon-vernick-quartet-jun-24-2026"),
    "2026-06-24",
  );
  assert.equal(
    slugDate("http://redlightcafe.com/events/cameron-suber-quartet-jazz-jun-12-2026"),
    "2026-06-12",
  );
});

test("slugDate: ADVERSARIAL — no trailing date returns null", () => {
  assert.equal(slugDate("khari-cabral-simmons-live-at-red-light-cafe"), null);
  assert.equal(slugDate("http://redlightcafe.com/events/just-a-page"), null);
});

test("slugDate: ADVERSARIAL — plausible-but-incomplete month token returns null, NOT a guess", () => {
  assert.equal(slugDate("the-spirit-of-the-blues-june"), null); // month WORD, no -dd-yyyy
  assert.equal(slugDate("spring-tour-mar-2026"), null); // month + year, NO day
  assert.equal(slugDate("show-jun-2026"), null); // same: -mon-yyyy, missing day
  assert.equal(slugDate("event-xyz-12-2026"), null); // "xyz" is not a real month
});

test("slugDate: null/empty input returns null", () => {
  assert.equal(slugDate(null), null);
  assert.equal(slugDate(undefined), null);
  assert.equal(slugDate(""), null);
});

test("slugDate: case-insensitive month, tolerates a trailing slash", () => {
  assert.equal(slugDate("band-JUN-27-2026"), "2026-06-27");
  assert.equal(slugDate("http://redlightcafe.com/events/cameron-suber-quartet-jazz-jun-12-2026/"), "2026-06-12");
});

test("slugDate: out-of-range day returns null", () => {
  assert.equal(slugDate("event-jun-0-2026"), null);
  assert.equal(slugDate("event-jun-40-2026"), null);
});

// ----- RSS parse + item→Concert mapping -----

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Red Light Cafe</title>
  <item>
    <title>The Sammy Hanson Trio (Jazz)</title>
    <link>https://redlightcafe.com/events/the-sammy-hanson-trio-jazz-jun-23-2026</link>
  </item>
  <item>
    <title>C. Ellet&#8217;s &amp; the Quartet</title>
    <link>https://redlightcafe.com/events/c-ellets-and-the-quartet-jul-04-2026</link>
  </item>
  <item>
    <title>Red Light Running Society: Run or Walk Every SATURDAY</title>
    <link>https://redlightcafe.com/events/red-light-running-society-jun-27-2026</link>
  </item>
  <item>
    <title>Some Show With No Date In The Slug</title>
    <link>https://redlightcafe.com/events/some-show-with-no-date</link>
  </item>
</channel></rss>`;

test("parseRedLightItems: parses items, decodes entities, keeps title a string", () => {
  const items = parseRedLightItems(RSS_FIXTURE);
  assert.equal(items.length, 4);
  assert.equal(items[0]!.title, "The Sammy Hanson Trio (Jazz)");
  assert.equal(items[1]!.title, "C. Ellet’s & the Quartet"); // &#8217; and &amp; decoded
  assert.ok(items[0]!.link!.endsWith("jun-23-2026"));
});

test("itemToConcert: a dated music item → Concert with genre:null, constant venue, slug date", () => {
  const items = parseRedLightItems(RSS_FIXTURE);
  const c = itemToConcert(items[0]!, SRC)!;
  assert.ok(c, "expected a concert");
  assert.equal(c.name, "The Sammy Hanson Trio (Jazz)");
  assert.equal(c.date, "2026-06-23"); // from the slug, NOT pubDate
  assert.equal(c.time, null); // door time never invented
  assert.equal(c.venue, "Red Light Café");
  assert.equal(c.city, "Atlanta");
  assert.equal(c.region, "GA");
  assert.equal(c.genre, null); // STANDING RULE — feed layer never infers genre
  assert.equal(c.priceMin, null);
  assert.equal(c.source, "Red Light Café");
  assert.deepEqual(c.artists, ["The Sammy Hanson Trio (Jazz)"]);
});

test("itemToConcert: call B — denylisted 'Running Society' series is dropped", () => {
  const items = parseRedLightItems(RSS_FIXTURE);
  const running = items[2]!;
  assert.match(running.title!, /Running Society/); // the real live title
  assert.equal(itemToConcert(running, SRC), null); // gated out, even though it HAS a date
});

test("itemToConcert: call A — an item with no slug date is gated out (not surfaced dateless)", () => {
  const items = parseRedLightItems(RSS_FIXTURE);
  assert.equal(itemToConcert(items[3]!, SRC), null);
});

test("itemToConcert: empty/HTML-only title → null; HTML tags stripped from title", () => {
  assert.equal(itemToConcert({ title: "   ", link: link("x-jun-1-2026") }, SRC), null);
  const c = itemToConcert({ title: "<b>Live</b> Jazz", link: link("live-jazz-jun-1-2026") }, SRC)!;
  assert.equal(c.name, "Live Jazz"); // tags stripped, whitespace handled by sanitize chain
});

test("itemToConcert + sanitizeConcert: control chars in title are hardened at the boundary", () => {
  const NUL = String.fromCharCode(0);
  const c = sanitizeConcert(
    itemToConcert({ title: "Jazz" + NUL + "Night", link: link("jazz-night-jun-1-2026") }, SRC)!,
  );
  assert.equal(c.name, "Jazz Night"); // M3 sanitize fired
  assert.equal(c.genre, null);
});

// ----- horizon (the RSS feed's own rolling-window reach) -----

test("fetchRedLightConcerts: horizon is the latest slug date in the FULL parse, unaffected by window trimming or the date-less/denylisted drops", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(RSS_FIXTURE, { status: 200 })) as typeof fetch;
  try {
    // Fixture's latest dated, non-denylisted item is jul-04-2026; a window
    // that excludes it must still report the true horizon.
    const { concerts, horizon } = await fetchRedLightConcerts(SRC, {
      start: "2026-06-01",
      end: "2026-06-30",
    });
    assert.equal(concerts.length, 1); // only the jun-23 item survives the window
    assert.equal(horizon, "2026-07-04"); // horizon still sees the jul-04 item
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchRedLightConcerts: no dated items -> horizon is null, not a guess", async () => {
  const realFetch = globalThis.fetch;
  const NO_DATES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item><title>Some Show</title><link>https://redlightcafe.com/events/some-show</link></item>
</channel></rss>`;
  globalThis.fetch = (async () => new Response(NO_DATES, { status: 200 })) as typeof fetch;
  try {
    const { concerts, horizon } = await fetchRedLightConcerts(SRC, {});
    assert.equal(concerts.length, 0);
    assert.equal(horizon, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
