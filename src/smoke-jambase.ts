/**
 * Live JamBase v3 smoke test. Exercises the real client end-to-end against the
 * Atlanta metro and asserts at least one real, dated event comes back — the
 * positive signal that the v1→v3 migration actually works (not just that tsc
 * compiled). Exits non-zero on failure.
 * Run: `npm run smoke:jambase` (loads JAMBASE_API_KEY via --env-file=.env).
 */
import { searchEvents, jambaseMetroId, JamBaseError } from "./jambase.js";
import { formatResults } from "./format.js";

async function main() {
  const geoMetroId = jambaseMetroId("atlanta");
  if (!geoMetroId) {
    console.error("FAIL: no JamBase geoMetroId mapped for 'atlanta'.");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const events = await searchEvents({ geoMetroId, eventDateFrom: today });
  const dated = events.filter((e) => e.date);

  console.log(
    formatResults(
      dated.slice(0, 5),
      `JamBase Atlanta — ${dated.length} dated upcoming events (showing up to 5):`,
    ),
  );

  if (dated.length === 0) {
    console.error("\nFAIL: JamBase returned no dated Atlanta events.");
    process.exit(1);
  }
  console.log(`\nPASS: ${dated.length} dated Atlanta events from JamBase v3.`);
}

main().catch((e) => {
  const msg = e instanceof JamBaseError ? e.message : (e?.message ?? String(e));
  console.error("JamBase smoke failed:", msg);
  process.exit(1);
});
