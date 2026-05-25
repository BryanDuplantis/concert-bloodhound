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
  // Attribution label for where the listing came from — "Ticketmaster" or an
  // open-feed source name (e.g. "Cobb Travel & Tourism"). A string, not an enum,
  // so new federated sources don't require a schema change.
  source: z.string(),
});

export type Concert = z.infer<typeof ConcertSchema>;

/** Shared output shape for the search tools (ZodRawShape for registerTool). */
export const resultShape = {
  summary: z.string(),
  results: z.array(ConcertSchema),
} as const;
