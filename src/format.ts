import type { Concert } from "./types.js";

/** Honest price label — never invents a number the API didn't give. */
export function priceLabel(c: Concert): string {
  if (c.priceMin == null && c.priceMax == null) return "Price unavailable";
  const sym = c.currency === "USD" || !c.currency ? "$" : `${c.currency} `;
  const n = (v: number) => `${sym}${Math.round(v)}`;
  if (c.priceMin != null && c.priceMax != null) {
    return c.priceMin === c.priceMax ? n(c.priceMin) : `${n(c.priceMin)}–${n(c.priceMax)}`;
  }
  if (c.priceMax != null) return `Up to ${n(c.priceMax)}`;
  return `From ${n(c.priceMin!)}`;
}

export function dateLabel(c: Concert): string {
  if (c.dateTBD || !c.date) return "Date TBD";
  const [y, m, d] = c.date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function timeLabel(c: Concert): string {
  if (!c.time) return "Time not listed";
  const [hh, mm] = c.time.split(":").map(Number);
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

export function formatConcert(c: Concert, idx: number): string {
  const lines = [
    `${idx}. ${c.artists.length ? c.artists.join(", ") : c.name}`,
    `   Date: ${dateLabel(c)}`,
    `   Time: ${timeLabel(c)}`,
    `   Venue: ${c.venue ?? "Venue not listed"}`,
    `   City: ${[c.city, c.region].filter(Boolean).join(", ") || "Location not listed"}`,
    `   Genre: ${c.genre ?? "Genre not listed"}`,
    `   Ticket Price: ${priceLabel(c)}`,
    `   Availability: ${c.availability}`,
    `   Ticket Link: ${c.url ?? "Link not listed"}`,
  ];
  if (c.ageRestriction) lines.push(`   Age: ${c.ageRestriction}`);
  return lines.join("\n");
}

export function formatResults(concerts: Concert[], header: string): string {
  if (concerts.length === 0) return header;
  const body = concerts.map((c, i) => formatConcert(c, i + 1)).join("\n\n");
  const sources = [...new Set(concerts.map((c) => c.source))];
  const attribution = sources.length === 1 ? `Source: ${sources[0]}` : `Sources: ${sources.join(", ")}`;
  return `${header}\n\n${body}\n\n${attribution}`;
}
