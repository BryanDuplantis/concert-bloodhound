import { XMLParser } from "fast-xml-parser";
import type { Concert } from "../types.js";
import { safeUrl, sanitizeConcert } from "../types.js";
import type { FeedFetchResult, FeedSource } from "./registry.js";
import { monthFromToken } from "./glover.js";

/**
 * City of Kennesaw concert series — Tier-2 static civic source.
 *
 * The city's own `/concert-series/` page is client-rendered ("Loading…"), so
 * the HTML route the source map filed is a dead end — but the site is
 * WordPress with an open REST API, and each season is announced as a news
 * post whose lineup uses one house format per act (recon 2026-07-17, live in
 * both 2026 posts):
 *
 *   <p>March 28 – Night Ranger<br/>Night Ranger takes the stage with…</p>
 *
 * Two series exist, distinguished by post title: "First Friday Concert
 * Series" (Downtown Kennesaw) and the "Kennesaw Concert Series" at the
 * United Bankshares Amphitheater at Depot Park. A series post matching
 * neither venue signal is SKIPPED — a venue is never guessed.
 *
 * Lineup lines carry no year; the season year is the four-digit year the
 * post's own TITLE states ("…for 2026 Season"), falling back to the post's
 * publish year. Prior seasons' posts still parse — their events fall out of
 * any forward-looking window naturally, and windowing is the caller's job.
 *
 * The prose after the <br> is the city's own per-act blurb — it rides along
 * as `description` (sanitizeConcert caps it). Times appear only as prose
 * ranges ("5:00 p.m." gates etc.), so `time` stays null — never guessed.
 */

const REGION = "GA";
const CITY = "Kennesaw";

interface WpPost {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

const entityParser = new XMLParser({
  ignoreAttributes: true,
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
});

function decodeEntities(s: string): string {
  const parsed = entityParser.parse(`<t>${s}</t>`);
  return parsed?.t != null ? String(parsed.t) : s;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Title-keyed venue routing — the only two series the city runs. */
export function venueForPost(title: string): string | null {
  if (/first friday/i.test(title)) return "Downtown Kennesaw";
  if (/depot park/i.test(title)) return "United Bankshares Amphitheater at Depot Park";
  return null;
}

/** Season year: the title's own four-digit year, else the post's publish year. */
export function seasonYear(title: string, postDate: string | undefined): number | null {
  const t = /\b(20\d{2})\b/.exec(title);
  if (t) return parseInt(t[1]!, 10);
  const d = /^(\d{4})-/.exec(postDate ?? "");
  return d ? parseInt(d[1]!, 10) : null;
}

export interface KennesawAct {
  date: string;
  artist: string;
  description: string | null;
}

// One act per <p>: "Month D – Artist" before the first <br>, blurb after.
const ACT_P_RE = /<p>([\s\S]*?)<\/p>/g;
const LINEUP_RE = /^([A-Za-z]+)\.?\s+(\d{1,2})\s*[–—-]\s*(.+)$/;

/** Extract lineup acts from one post's rendered content. */
export function parseKennesawActs(contentHtml: string, year: number): KennesawAct[] {
  const out: KennesawAct[] = [];
  for (const p of contentHtml.matchAll(ACT_P_RE)) {
    const [head, ...rest] = p[1]!.split(/<br\s*\/?>/i);
    const m = LINEUP_RE.exec(stripHtml(head ?? ""));
    if (!m) continue;
    const month = monthFromToken(m[1]!);
    if (!month) continue;
    const day = parseInt(m[2]!, 10);
    if (day < 1 || day > 31) continue;
    const artist = m[3]!.trim();
    if (!artist) continue;
    const blurb = stripHtml(rest.join(" "));
    out.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      artist,
      description: blurb || null,
    });
  }
  return out;
}

function inWindow(date: string, start?: string, end?: string): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

/**
 * Fetch + normalize Kennesaw's concert-series news posts into windowed
 * Concerts. Throws when a 200 yields no series posts or no acts at all —
 * the structural-drift alarm: the announcement posts are permanent, so an
 * empty parse means the search endpoint or the house lineup format moved,
 * and a silent [] would read as "Kennesaw runs no concerts."
 */
export async function fetchKennesawConcerts(
  src: FeedSource,
  window: { start?: string; end?: string } = {},
): Promise<FeedFetchResult> {
  const res = await fetch(src.url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Kennesaw feed HTTP ${res.status}`);
  const posts = (await res.json()) as WpPost[];
  if (!Array.isArray(posts)) throw new Error("Kennesaw feed: response is not a post array");

  const all: Concert[] = [];
  for (const post of posts) {
    const title = stripHtml(post.title?.rendered ?? "");
    if (!/concert series/i.test(title)) continue;
    const venue = venueForPost(title);
    if (!venue) continue;
    const year = seasonYear(title, post.date);
    if (!year) continue;
    const link = safeUrl(post.link);
    for (const act of parseKennesawActs(post.content?.rendered ?? "", year)) {
      all.push({
        name: act.artist,
        artists: [act.artist],
        date: act.date,
        dateTBD: false,
        time: null,
        venue,
        city: CITY,
        region: REGION,
        genre: null, // STANDING RULE: the feed layer never infers genre
        priceMin: null,
        priceMax: null,
        currency: null,
        availability: "Availability unknown",
        url: link,
        ageRestriction: null,
        description: act.description,
        source: src.name,
      });
    }
  }
  if (all.length === 0) {
    throw new Error("Kennesaw feed structural drift: 0 acts parsed from a 200 response");
  }
  const horizon = all.reduce((max, c) => (c.date! > max ? c.date! : max), all[0]!.date!);
  const concerts = all
    .filter((c) => inWindow(c.date!, window.start, window.end))
    .map(sanitizeConcert);
  return { concerts, horizon };
}
