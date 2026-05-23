import { z } from "zod";

/**
 * Normalized concert record — the typed output contract for every tool.
 * Zod here plays the role Pydantic plays in the Python stack: nothing leaves
 * the server unless it conforms. Fields the API didn't provide are `null`,
 * never guessed. Downstream formatters render those nulls as "not listed".
 */
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
  source: z.literal("Ticketmaster"),
});

export type Concert = z.infer<typeof ConcertSchema>;

/** Shared output shape for the search tools (ZodRawShape for registerTool). */
export const resultShape = {
  summary: z.string(),
  results: z.array(ConcertSchema),
} as const;
