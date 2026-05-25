/**
 * Unit tests for the iCal reader — hermetic (no network), runs via `npm test`.
 * The fixture is inlined so the test has no filesystem/dist path dependency. It
 * exercises the genuinely tricky parts: line folding, TEXT unescaping + HTML
 * entity decode, VALUE=DATE vs TZID datetime, category splitting, and the
 * "Venue, …, City, ST, ZIP" location parse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseICal, parseLocation, unescapeText } from "./ical.js";

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "SUMMARY:Mable House Summer Concert: C. Ellet&#39;s Jazz Trio",
  "DTSTART;TZID=America/New_York:20260710T193000",
  "DTEND;TZID=America/New_York:20260710T213000",
  "LOCATION:Mable House Amphitheatre\\, 5239 Floyd Rd SW\\, Mableton\\, GA\\, 30126",
  "URL:https://travelcobb.org/event/mable-house-summer-concert/",
  "CATEGORIES:Music & Concerts,Community Events",
  "DESCRIPTION:An evening of live jazz under the stars at the historic Mable Ho",
  " use Amphitheatre.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Art Blooms at Smith-Gilbert Gardens",
  "DTSTART;VALUE=DATE:20260601",
  "DTEND;VALUE=DATE:20260630",
  "LOCATION:Smith-Gilbert Gardens\\, 2382 Pine Mountain Rd.\\, Kennesaw\\, GA\\, 30152",
  "CATEGORIES:Arts & Theater,Community Events",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "SUMMARY:Glover Park Concert Series",
  "DTSTART;TZID=America/New_York:20260612T200000",
  "CATEGORIES:Music & Concerts",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("parses datetime and all-day DTSTART forms", () => {
  const evs = parseICal(SAMPLE);
  assert.equal(evs.length, 3);
  assert.equal(evs[0].date, "2026-07-10");
  assert.equal(evs[0].time, "19:30:00");
  assert.equal(evs[0].allDay, false);
  assert.equal(evs[1].date, "2026-06-01");
  assert.equal(evs[1].time, null);
  assert.equal(evs[1].allDay, true);
});

test("unescapes iCal text and decodes HTML entities", () => {
  const evs = parseICal(SAMPLE);
  assert.equal(evs[0].summary, "Mable House Summer Concert: C. Ellet's Jazz Trio");
});

test("unfolds folded continuation lines", () => {
  const evs = parseICal(SAMPLE);
  assert.match(evs[0].description ?? "", /historic Mable House Amphitheatre\./);
});

test("splits categories on unescaped commas", () => {
  const evs = parseICal(SAMPLE);
  assert.deepEqual(evs[0].categories, ["Music & Concerts", "Community Events"]);
  assert.deepEqual(evs[2].categories, ["Music & Concerts"]);
});

test("parseLocation extracts venue, city, region", () => {
  const evs = parseICal(SAMPLE);
  const loc = parseLocation(evs[0].location);
  assert.equal(loc.venue, "Mable House Amphitheatre");
  assert.equal(loc.city, "Mableton");
  assert.equal(loc.region, "GA");
});

test("parseLocation returns nulls it can't extract (never guesses)", () => {
  assert.deepEqual(parseLocation(null), { venue: null, city: null, region: null });
  assert.deepEqual(parseLocation("Some Hall"), { venue: "Some Hall", city: null, region: null });
});

test("unescapeText handles backslash escapes", () => {
  assert.equal(unescapeText("A\\, B\\; C"), "A, B; C");
});
