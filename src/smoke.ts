/**
 * Direct API smoke test — proves the Ticketmaster integration returns real,
 * dated events. Run: `npm run smoke` (loads .env via node --env-file).
 * Exits non-zero on any failure so it can't masquerade as success.
 */
import { searchEvents } from "./ticketmaster.js";
import { formatResults } from "./format.js";

const day = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  if (!process.env.TICKETMASTER_API_KEY) {
    console.error("TICKETMASTER_API_KEY not set. Run: npm run smoke (needs .env).");
    process.exit(2);
  }
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  console.error(`Smoke: concerts in New York, ${day(now)} → ${day(in30)}`);

  const concerts = await searchEvents({
    city: "New York",
    startDateTime: `${day(now)}T00:00:00Z`,
    endDateTime: `${day(in30)}T23:59:59Z`,
    size: 5,
  });

  console.log(formatResults(concerts.slice(0, 3), `Found ${concerts.length} concert(s):`));

  if (concerts.length === 0) {
    console.error("⚠️  Zero results — unexpected for NYC. Check the API key or quota.");
    process.exit(1);
  }
  console.error(`✅ Smoke passed: ${concerts.length} real events returned.`);
}

main().catch((e) => {
  console.error("❌ Smoke failed:", e?.message ?? e);
  process.exit(1);
});
