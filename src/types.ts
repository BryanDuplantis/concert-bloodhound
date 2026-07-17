import { z } from "zod";

/**
 * Normalized concert record — the typed output contract for every tool.
 * Zod here plays the role Pydantic plays in the Python stack: nothing leaves
 * the server unless it conforms. Fields the API didn't provide are `null`,
 * never guessed. Downstream formatters render those nulls as "not listed".
 */
/**
 * Validate that a URL is https (or http) before surfacing it. Rejects
 * javascript:, data:, and any other non-http scheme that could be dangerous
 * if a downstream surface renders the link as clickable.
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export const ConcertSchema = z.object({
  name: z.string(),
  artists: z.array(z.string()),
  date: z.string().nullable(), // "YYYY-MM-DD" or null
  dateTBD: z.boolean(),
  time: z.string().nullable(), // "HH:MM:SS" (local) or null
  venue: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(), // state code, falling back to country code
  genre: z.string().nullable(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  currency: z.string().nullable(),
  availability: z.string(), // mapped from the event's on-sale status
  url: z.string().nullable(),
  ageRestriction: z.string().nullable(),
  // Raw free-text event description, HTML-stripped and length-capped, when the
  // source provides one (RSS/iCal only — Ticketmaster/JamBase/Freshtix carry no
  // extra prose beyond their own structured fields). Never parsed for
  // price/time/genre — that extraction was tried and deferred as fragile
  // (multi-tier pricing, inconsistent door-time phrasing); this passes the
  // source's own words through unmodified so a reader can see them instead.
  description: z.string().nullable(),
  // Attribution label for where the listing came from — "Ticketmaster" or an
  // open-feed source name (e.g. "Cobb Travel & Tourism"). A string, not an enum,
  // so new federated sources don't require a schema change.
  source: z.string(),
});

export type Concert = z.infer<typeof ConcertSchema>;

/**
 * Longest a legitimate concert/venue/artist/genre string ever runs. Real names
 * never approach this; the cap exists to defang a wall-of-text prompt-injection
 * payload smuggled through an attacker-influenceable upstream field, not to trim
 * real data. A capped field gets a trailing ellipsis so the truncation is visible.
 */
const MAX_FIELD = 256;

/**
 * Descriptions run much longer than a name/venue/genre — a venue's RSS blurb
 * or an iCal event summary is prose, not a label. Capped separately and much
 * higher than MAX_FIELD so the load-bearing first lines (price, door time)
 * survive; still bounded against the same prompt-injection wall-of-text risk.
 */
const MAX_DESCRIPTION = 600;

/**
 * Harden one untrusted free-text field before it enters the LLM context. Zod
 * guarantees these fields are strings of the right SHAPE; this guards their
 * CONTENT — upstream event names, artists, venues and genres are attacker-
 * influenceable free text (M3, see BACKLOG.md). Strips C0/C1 control characters
 * (NUL, ESC, and the newlines/carriage-returns used to fake message boundaries or
 * pull terminal tricks) by replacing them with a space, collapses the resulting
 * whitespace, trims, and caps length. A field that was entirely control chars or
 * whitespace collapses to null — surfaced downstream as "not listed", never an
 * empty string. This is formatting of real data, never invention.
 */
export function sanitizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const stripped = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > MAX_FIELD
    ? collapsed.slice(0, MAX_FIELD - 1).trimEnd() + "…"
    : collapsed;
}

/**
 * Same hardening as sanitizeText (control-char strip, length cap, empty ->
 * null) but preserves newlines instead of collapsing them — a description's
 * line breaks are structure (show time / price / door time on their own
 * lines), not incidental whitespace, so collapsing them would run those
 * pieces together illegibly. Collapses runs of 3+ blank lines to one and
 * trims trailing spaces per line, but never joins two lines into one.
 */
export function sanitizeDescription(value: string | null | undefined): string | null {
  if (value == null) return null;
  const stripped = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, " ");
  const perLine = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());
  const collapsed = perLine.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > MAX_DESCRIPTION
    ? collapsed.slice(0, MAX_DESCRIPTION - 1).trimEnd() + "…"
    : collapsed;
}

/**
 * Apply sanitizeText to every attacker-influenceable free-text field of a
 * normalized Concert. Applied once at each source client's output boundary (the
 * analog of the network invariant: nothing leaves a source unsanitized), so the
 * Concert contract itself only ever carries clean content. Deliberately NOT
 * touched: `url` (already scheme-guarded by safeUrl), `availability` and `source`
 * (controlled vocabulary / our own literals, never upstream text), `ageRestriction`
 * (our literal or null), and the typed non-text fields. `name` is non-nullable, so
 * a field that sanitizes to null falls back to the same "Untitled event" the
 * normalizers use; empty artist strings are dropped rather than kept blank.
 * `description` runs through sanitizeDescription, not sanitizeText — it's the
 * one field where line breaks are structure, not noise (see sanitizeDescription).
 */
export function sanitizeConcert(c: Concert): Concert {
  return {
    ...c,
    name: sanitizeText(c.name) ?? "Untitled event",
    artists: c.artists.map(sanitizeText).filter((s): s is string => s !== null),
    description: sanitizeDescription(c.description),
    venue: sanitizeText(c.venue),
    city: sanitizeText(c.city),
    region: sanitizeText(c.region),
    genre: sanitizeText(c.genre),
    currency: sanitizeText(c.currency),
  };
}

/** Shared output shape for the search tools (ZodRawShape for registerTool). */
export const resultShape = {
  summary: z.string(),
  results: z.array(ConcertSchema),
} as const;
