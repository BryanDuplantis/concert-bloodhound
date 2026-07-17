/**
 * Offline guard for the Glover Park (Marietta) season-table parser. The two
 * genuinely tricky parts this source hands us: hidden accessibility spans
 * inside the performer cell (which a naive tag-strip would leak into the
 * artist name), and the season-wide show time living only in page prose.
 * Fixture markup is verbatim from the live CivicEngage page (2026-07-17).
 * Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthFromToken,
  parseGloverDate,
  parseGloverSeasonTime,
  parseGloverRows,
  fetchGloverConcerts,
} from "./glover.js";
import type { FeedSource } from "./registry.js";

const SRC: FeedSource = {
  id: "glover-park",
  name: "Glover Park Concert Series",
  metro: "atlanta",
  type: "html",
  url: "https://www.mariettaga.gov/192/Glover-Park-Concert-Series",
};

// ----- months / dates -----

test("monthFromToken: full names, page-style abbreviations, and 'Sept'", () => {
  assert.equal(monthFromToken("April"), 4);
  assert.equal(monthFromToken("Aug"), 8);
  assert.equal(monthFromToken("Sept"), 9);
  assert.equal(monthFromToken("Sept."), 9);
  assert.equal(monthFromToken("sePtEmBer"), 9);
});

test("monthFromToken: ADVERSARIAL — ambiguous or junk tokens return null, never a guess", () => {
  assert.equal(monthFromToken("Ju"), null); // too short AND ambiguous
  assert.equal(monthFromToken("Ma"), null); // too short (March/May)
  assert.equal(monthFromToken("Smarch"), null);
  assert.equal(monthFromToken(""), null);
});

test("parseGloverDate: page formats -> YYYY-MM-DD", () => {
  assert.equal(parseGloverDate("April 24, 2026"), "2026-04-24");
  assert.equal(parseGloverDate("Aug 28, 2026"), "2026-08-28");
  assert.equal(parseGloverDate("Sept 25, 2026"), "2026-09-25");
});

test("parseGloverDate: ADVERSARIAL — yearless or malformed dates return null", () => {
  assert.equal(parseGloverDate("April 24"), null); // no year — never assume one
  assert.equal(parseGloverDate("April 32, 2026"), null);
  assert.equal(parseGloverDate("TBD"), null);
});

// ----- season time from prose -----

test("parseGloverSeasonTime: reads the page's own blanket statement", () => {
  assert.equal(parseGloverSeasonTime("All concerts are free and begin at 8 p.m."), "20:00:00");
  assert.equal(parseGloverSeasonTime("concerts begin at 7:30 pm sharp"), "19:30:00");
});

test("parseGloverSeasonTime: ADVERSARIAL — absent statement -> null, never a hardcoded 8pm", () => {
  assert.equal(parseGloverSeasonTime("Concerts start in the evening."), null);
  assert.equal(parseGloverSeasonTime(""), null);
});

// ----- rows (verbatim live markup, incl. the hidden-span trap) -----

const HTML_FIXTURE = `
<p>The concerts are free but tables can be reserved.</p>
<p>All concerts are free and begin at 8 p.m.</p>
<table>
  <thead><tr>
    <th scope="col" id="c1">Concert Date<br></th>
    <th scope="col" id="c2">Tables Go on Sale<br></th>
    <th scope="col" id="c3">Performers / Genre<br></th>
  </tr></thead>
  <tbody>
    <tr class="textContent">
      <td headers="c1" data-th="Concert Date">April 24, 2026</td>
      <td headers="c2" data-th="Tables Go on Sale"><strong>April 1, 2026</strong></td>
      <td headers="c3" data-th="Performers / Genre"><a href="http://example.com" tabindex="-1" role="presentation" aria-hidden="true"></a><h3 role="presentation" class="startContainer endContainer"><a href="https://www.facebook.com/YachtRockSchooner/ ">Yacht Rock Schooners</a> / 70s Smooth Rock&nbsp;</h3></td>
    </tr>
    <tr class="alt textContent">
      <td headers="c1" data-th="Concert Date">July 31, 2026</td>
      <td headers="c2" data-th="Tables Go on Sale"><strong>July 1, 2026</strong></td>
      <td headers="c3" data-th="Performers / Genre"><h3 class="startContainer endContainer"><a href="https://www.facebook.com/chuckmartinandthelineup/"><span style="display: none;" class="ae-compliance-indent"> Facebook Social Network </span></a><a href="https://7bridgesband.com/">Seven Bridges</a> / Eagles Tribute Band</h3></td>
    </tr>
    <tr class="textContent">
      <td headers="c1" data-th="Concert Date">Sept 25, 2026</td>
      <td headers="c2" data-th="Tables Go on Sale"><strong>Sept 1, 2026</strong></td>
      <td headers="c3" data-th="Performers / Genre"><h3><a href="https://example.com">Nashville Nation</a> / Modern Country Hits</h3></td>
    </tr>
  </tbody>
</table>`;

test("parseGloverRows: dates, artists, and genre text — hidden a11y spans never leak into the artist", () => {
  const rows = parseGloverRows(HTML_FIXTURE);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    date: "2026-04-24",
    artist: "Yacht Rock Schooners",
    genreText: "70s Smooth Rock",
  });
  // the "Facebook Social Network" hidden-span trap
  assert.equal(rows[1]!.artist, "Seven Bridges");
  assert.equal(rows[1]!.genreText, "Eagles Tribute Band");
  assert.equal(rows[2]!.date, "2026-09-25");
});

// ----- fetch pipeline -----

test("fetchGloverConcerts (fetch stub): season time applied, genre null, description carries the page's genre text", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(HTML_FIXTURE, { status: 200 })) as typeof fetch;
  try {
    const { concerts, horizon } = await fetchGloverConcerts(SRC, {});
    assert.equal(concerts.length, 3);
    const c = concerts[0]!;
    assert.equal(c.name, "Yacht Rock Schooners");
    assert.equal(c.time, "20:00:00"); // from the page's own prose, not a hardcode
    assert.equal(c.venue, "Glover Park");
    assert.equal(c.city, "Marietta");
    assert.equal(c.genre, null); // STANDING RULE — feed layer never infers genre
    assert.equal(c.description, "70s Smooth Rock");
    assert.equal(c.source, "Glover Park Concert Series");
    assert.equal(horizon, "2026-09-25");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchGloverConcerts: window filtering", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(HTML_FIXTURE, { status: 200 })) as typeof fetch;
  try {
    const { concerts, horizon } = await fetchGloverConcerts(SRC, { start: "2026-07-17" });
    assert.deepEqual(
      concerts.map((c) => c.date),
      ["2026-07-31", "2026-09-25"],
    );
    assert.equal(horizon, "2026-09-25"); // horizon reflects the FULL parse, not the window
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchGloverConcerts: ADVERSARIAL — structural drift (0 rows) throws rather than returning []", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html><body>page redesigned</body></html>", { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => fetchGloverConcerts(SRC, {}), /structural drift/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
