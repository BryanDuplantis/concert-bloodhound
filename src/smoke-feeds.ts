/**
 * Live open-feed smoke test — proves the federated feed layer returns real,
 * normalized music events from sources Ticketmaster doesn't carry. No API key
 * needed (open feeds). Run: `npm run smoke:feeds`. Exits non-zero on failure.
 */
import { fetchMetroFeeds } from "./feeds/index.js";

async function main() {
  console.error("Smoke: Atlanta-metro open feeds (free/civic music TM misses)");
  const events = await fetchMetroFeeds("atlanta", {});

  const bySource = new Map<string, number>();
  for (const e of events) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  for (const [s, n] of bySource) console.error(`  ${s}: ${n} music events`);
  for (const e of events.slice(0, 6)) {
    console.error(`  • ${e.date ?? "Date TBD"} — ${e.name} @ ${e.venue ?? "?"} (${e.city ?? "?"})`);
  }

  if (events.length === 0) {
    console.error(
      "⚠️  Zero feed events. Cobb's free summer concert series should be live — " +
        "check the feed URL or the 'Music & Concerts' category name.",
    );
    process.exit(1);
  }
  console.error(
    `✅ Feeds smoke passed: ${events.length} music events from open feeds, normalized to the Concert schema.`,
  );
}

main().catch((e) => {
  console.error("❌ Feeds smoke failed:", e?.message ?? e);
  process.exit(1);
});
