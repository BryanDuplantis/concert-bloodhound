/**
 * JamBase discovery probe — confirms the live response shape so src/jambase.ts's
 * normalizer can be finalized. Base + auth are already locked; this needs an
 * ACTIVE key. ALL output is key-redacted (the API echoes the apikey in errors).
 * Run: `npm run smoke:jambase`. Exploratory; removed once the normalizer is final.
 */
const day = (d: Date) => d.toISOString().slice(0, 10);
const KEY = process.env.JAMBASE_API_KEY ?? "";
const BASE = "https://www.jambase.com/jb-api/v3/events";
const redact = (s: string) => (KEY ? s.split(KEY).join("***") : s);

async function main() {
  if (!KEY) {
    console.error("JAMBASE_API_KEY not set.");
    process.exit(2);
  }
  const now = new Date();
  const in3 = new Date(now.getTime() + 3 * 86_400_000);
  const url = `${BASE}?apikey=${KEY}&geoCityName=Atlanta&eventDateFrom=${day(now)}&eventDateTo=${day(in3)}&perPage=3`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(`HTTP ${res.status} non-JSON: ${redact(text.slice(0, 200))}`);
    return;
  }

  console.error(`HTTP ${res.status} | success=${data?.success} | envelopeKeys=[${Object.keys(data).join(",")}]`);
  if (data?.success === false) {
    console.log("ERROR:", redact(JSON.stringify(data.errors)));
    return;
  }

  const events = data?.events ?? data?.data ?? data?.results ?? [];
  console.error(`events=${events.length} | pagination=${JSON.stringify(data.pagination ?? data.meta ?? "n/a")}`);
  console.log("\n=== RAW FIRST EVENT (key-redacted) ===");
  console.log(events[0] ? redact(JSON.stringify(events[0], null, 2)).slice(0, 4500) : "(0 events returned)");
}

main().catch((e) => {
  console.error("Discovery failed:", redact(String(e?.message ?? e)));
  process.exit(1);
});
