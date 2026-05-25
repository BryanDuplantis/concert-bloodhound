/**
 * Direct API smoke test — proves the Ticketmaster integration returns real,
 * dated events through BOTH paths: the legacy `city` text match and the new
 * `latlong` + `radius` geospatial metro search. Run: `npm run smoke`
 * (loads .env via node --env-file). Exits non-zero on any failure so it can't
 * masquerade as success.
 */
import { searchEvents } from "./ticketmaster.js";
import { resolveLatLong } from "./geo.js";
import { formatResults } from "./format.js";

const day = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  if (!process.env.TICKETMASTER_API_KEY) {
    console.error("TICKETMASTER_API_KEY not set. Run: npm run smoke (needs .env).");
    process.exit(2);
  }
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const window = {
    startDateTime: `${day(now)}T00:00:00Z`,
    endDateTime: `${day(in30)}T23:59:59Z`,
  };

  // 1) Baseline: the legacy city text match still returns events.
  console.error(`Smoke 1/2: New York via city text, ${day(now)} → ${day(in30)}`);
  const nyc = await searchEvents({ city: "New York", ...window, size: 5 });
  console.log(formatResults(nyc.slice(0, 2), `New York: ${nyc.length} concert(s):`));
  if (nyc.length === 0) {
    console.error("⚠️  Zero NYC results — unexpected. Check the API key or quota.");
    process.exit(1);
  }

  // 2) The fix: resolve a metro to its centroid and search latlong + radius.
  //    This is the path that now reaches the surrounding metro (e.g. Cobb County
  //    venues outside the Atlanta city limits) that a plain city match misses.
  const atl = resolveLatLong("Atlanta");
  if (!atl) {
    console.error("❌ Atlanta did not resolve in the metro table — geo regression.");
    process.exit(1);
  }
  console.error(`Smoke 2/2: ${atl.label} via latlong=${atl.latlong} radius=30mi`);
  const metro = await searchEvents({ latlong: atl.latlong, radius: 30, ...window, size: 12 });
  const cities = [...new Set(metro.map((c) => c.city).filter(Boolean))];
  console.log(formatResults(metro.slice(0, 2), `${atl.label} metro: ${metro.length} concert(s):`));
  console.error(`   metro venue cities seen: ${cities.join(", ") || "(none)"}`);
  if (metro.length === 0) {
    console.error("⚠️  Zero Atlanta-metro results for the geospatial search — unexpected.");
    process.exit(1);
  }

  console.error(
    `✅ Smoke passed: city text (${nyc.length}) + geospatial metro (${metro.length}) both returned real events.`,
  );
}

main().catch((e) => {
  console.error("❌ Smoke failed:", e?.message ?? e);
  process.exit(1);
});
