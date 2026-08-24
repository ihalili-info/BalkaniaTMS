import type { LatLng } from "./types";

/** Metres between two WGS-84 points — the client-side twin of `ST_Distance`. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export function formatDistance(meters: number | null): string {
  if (meters === null) return "—";
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

/**
 * Coarse drive-time estimate from straight-line distance, at an assumed
 * 45 km/h regional average. Explicitly an estimate: the architecture doc keeps
 * real routing/ETA as a v2 item, and this must not be used to fire alerts.
 */
export function estimateMinutes(meters: number | null): number | null {
  if (meters === null) return null;
  return Math.max(1, Math.round((meters / 1000 / 45) * 60));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
];

/** "4 min ago" / "in 2 hours", relative to an explicit `now`. */
export function relativeTime(iso: string, now: Date): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let delta = (new Date(iso).getTime() - now.getTime()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) < size) return rtf.format(Math.round(delta), unit);
    delta /= size;
  }
  return rtf.format(Math.round(delta), "week");
}

export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** With the year — for expiries and anything more than a few months out. */
export function formatDateFull(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function formatCoords(point: LatLng | null): string {
  if (!point) return "no fix";
  return `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
}
