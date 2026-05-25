/**
 * Unit tests for the pure city→latlong resolver. No network — runs offline via
 * `npm test` (node --test). These guard the behavior the live smoke can't:
 * alias/normalization handling and the null (city-text fallback) path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLatLong, isLatLong } from "./geo.js";

test("resolves a known metro to its centroid + label", () => {
  const atl = resolveLatLong("Atlanta");
  assert.equal(atl?.latlong, "33.749,-84.388");
  assert.equal(atl?.label, "Atlanta, GA");
});

test("is case-, whitespace-, and punctuation-insensitive", () => {
  assert.equal(resolveLatLong("  ATLANTA ")?.latlong, "33.749,-84.388");
  assert.equal(resolveLatLong("new   york")?.label, "New York, NY");
  assert.equal(resolveLatLong("Washington D.C.")?.label, "Washington, DC");
});

test("resolves common aliases", () => {
  assert.equal(resolveLatLong("ATL")?.label, "Atlanta, GA");
  assert.equal(resolveLatLong("nyc")?.label, "New York, NY");
  assert.equal(resolveLatLong("LA")?.label, "Los Angeles, CA");
  assert.equal(resolveLatLong("SF")?.label, "San Francisco, CA");
  assert.equal(resolveLatLong("dc")?.label, "Washington, DC");
  assert.equal(resolveLatLong("saint louis")?.label, "St. Louis, MO");
});

test("returns null for unknown / empty input (city-text fallback path)", () => {
  assert.equal(resolveLatLong("Boise"), null);
  assert.equal(resolveLatLong("Tbilisi"), null);
  assert.equal(resolveLatLong(undefined), null);
  assert.equal(resolveLatLong(""), null);
});

test("isLatLong accepts valid coord pairs, rejects junk", () => {
  assert.ok(isLatLong("33.749,-84.388"));
  assert.ok(isLatLong("40.7128, -74.0060")); // space after comma tolerated
  assert.ok(isLatLong("47,-122")); // integer coords
  assert.ok(!isLatLong("Atlanta"));
  assert.ok(!isLatLong("33.749")); // missing longitude
  assert.ok(!isLatLong("33.749,")); // trailing comma, no longitude
  assert.ok(!isLatLong("abc,def"));
});
