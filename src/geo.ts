/**
 * City → latitude/longitude resolution. PURE: no network, no I/O — this keeps
 * the "only ticketmaster.ts touches the network" invariant intact.
 *
 * Why this exists: Ticketmaster Discovery's `city` param is a text match, not a
 * geospatial one, so `radius` has nothing to anchor to and the search misses the
 * surrounding metro (e.g. an "Atlanta" city search omits Cobb County venues like
 * Cobb Energy PAC and Mable House). Resolving the city to a metro centroid and
 * searching `latlong` + `radius` instead returns true metro coverage.
 *
 * Coverage is a curated set of major US metros. Anything not in the table falls
 * back to the old `city` text match (never worse than before), and the calling
 * assistant can always pass an explicit `latlong` for any city — the same
 * division of labor already used for relative dates (the assistant resolves the
 * natural language; the server takes structured params).
 */

export interface MetroPoint {
  /** "lat,long" — the exact string Ticketmaster's `latlong` param expects. */
  latlong: string;
  /** Human label for summaries, e.g. "Atlanta, GA". */
  label: string;
}

/** Downtown/centroid coordinates for major US metros. */
const METROS: Record<string, MetroPoint> = {
  "atlanta": { latlong: "33.749,-84.388", label: "Atlanta, GA" },
  "austin": { latlong: "30.2672,-97.7431", label: "Austin, TX" },
  "baltimore": { latlong: "39.2904,-76.6122", label: "Baltimore, MD" },
  "boston": { latlong: "42.3601,-71.0589", label: "Boston, MA" },
  "charlotte": { latlong: "35.2271,-80.8431", label: "Charlotte, NC" },
  "chicago": { latlong: "41.8781,-87.6298", label: "Chicago, IL" },
  "cincinnati": { latlong: "39.1031,-84.512", label: "Cincinnati, OH" },
  "cleveland": { latlong: "41.4993,-81.6944", label: "Cleveland, OH" },
  "columbus": { latlong: "39.9612,-82.9988", label: "Columbus, OH" },
  "dallas": { latlong: "32.7767,-96.797", label: "Dallas, TX" },
  "denver": { latlong: "39.7392,-104.9903", label: "Denver, CO" },
  "detroit": { latlong: "42.3314,-83.0458", label: "Detroit, MI" },
  "houston": { latlong: "29.7604,-95.3698", label: "Houston, TX" },
  "indianapolis": { latlong: "39.7684,-86.1581", label: "Indianapolis, IN" },
  "kansas city": { latlong: "39.0997,-94.5786", label: "Kansas City, MO" },
  "las vegas": { latlong: "36.1699,-115.1398", label: "Las Vegas, NV" },
  "los angeles": { latlong: "34.0522,-118.2437", label: "Los Angeles, CA" },
  "louisville": { latlong: "38.2527,-85.7585", label: "Louisville, KY" },
  "memphis": { latlong: "35.1495,-90.049", label: "Memphis, TN" },
  "miami": { latlong: "25.7617,-80.1918", label: "Miami, FL" },
  "milwaukee": { latlong: "43.0389,-87.9065", label: "Milwaukee, WI" },
  "minneapolis": { latlong: "44.9778,-93.265", label: "Minneapolis, MN" },
  "nashville": { latlong: "36.1627,-86.7816", label: "Nashville, TN" },
  "new orleans": { latlong: "29.9511,-90.0715", label: "New Orleans, LA" },
  "new york": { latlong: "40.7128,-74.006", label: "New York, NY" },
  "oakland": { latlong: "37.8044,-122.2712", label: "Oakland, CA" },
  "orlando": { latlong: "28.5383,-81.3792", label: "Orlando, FL" },
  "philadelphia": { latlong: "39.9526,-75.1652", label: "Philadelphia, PA" },
  "phoenix": { latlong: "33.4484,-112.074", label: "Phoenix, AZ" },
  "pittsburgh": { latlong: "40.4406,-79.9959", label: "Pittsburgh, PA" },
  "portland": { latlong: "45.5152,-122.6784", label: "Portland, OR" },
  "raleigh": { latlong: "35.7796,-78.6382", label: "Raleigh, NC" },
  "sacramento": { latlong: "38.5816,-121.4944", label: "Sacramento, CA" },
  "salt lake city": { latlong: "40.7608,-111.891", label: "Salt Lake City, UT" },
  "san antonio": { latlong: "29.4241,-98.4936", label: "San Antonio, TX" },
  "san diego": { latlong: "32.7157,-117.1611", label: "San Diego, CA" },
  "san francisco": { latlong: "37.7749,-122.4194", label: "San Francisco, CA" },
  "san jose": { latlong: "37.3382,-121.8863", label: "San Jose, CA" },
  "seattle": { latlong: "47.6062,-122.3321", label: "Seattle, WA" },
  "st louis": { latlong: "38.627,-90.1994", label: "St. Louis, MO" },
  "tampa": { latlong: "27.9506,-82.4572", label: "Tampa, FL" },
  "washington": { latlong: "38.9072,-77.0369", label: "Washington, DC" },
};

/** Common shorthands → canonical table key. */
const ALIASES: Record<string, string> = {
  "atl": "atlanta",
  "nyc": "new york",
  "new york city": "new york",
  "la": "los angeles",
  "sf": "san francisco",
  "dc": "washington",
  "washington dc": "washington",
  "nola": "new orleans",
  "vegas": "las vegas",
  "philly": "philadelphia",
  "saint louis": "st louis",
  "kc": "kansas city",
};

/** lowercase, strip periods, collapse whitespace — "Washington D.C." → "washington dc". */
function normalize(city: string): string {
  return city.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/** True if `s` is already a "lat,long" pair we can pass straight through. */
export function isLatLong(s: string): boolean {
  return /^-?\d{1,3}(\.\d+)?,\s*-?\d{1,3}(\.\d+)?$/.test(s.trim());
}

/**
 * Resolve a city name to a metro centroid, or null if it isn't in the table.
 * Null is the signal to fall back to Ticketmaster's `city` text match.
 */
export function resolveLatLong(city: string | undefined): MetroPoint | null {
  if (!city) return null;
  const key = normalize(city);
  const canonical = ALIASES[key] ?? key;
  return METROS[canonical] ?? null;
}
