/**
 * Turning what a dispatcher pastes into a coordinate.
 *
 * No geocoding provider is configured (see Integration Settings), so an address
 * cannot be resolved automatically. The practical fallback is the one people
 * already use: find the place in Google Maps, copy something, paste it here.
 * "Something" is wildly inconsistent, so this accepts every shape that copy
 * step actually produces.
 *
 * When a provider is wired up this stays useful — an automatic geocode still
 * fails on rural addresses like a Donegal townland, and someone has to place
 * those by hand.
 */

import { countryForPoint, isInCountry, looksTransposed } from "./regions";
import type { CountryCode } from "./regions";
import type { LatLng } from "./types";

export type ParseFailure =
  | "empty"
  | "short_link"
  | "no_coordinates"
  | "out_of_range";

export interface ParseResult {
  point: LatLng | null;
  failure: ParseFailure | null;
  /** Where the numbers came from, shown back so the dispatcher can sanity-check. */
  source: string | null;
}

/** `53.3498` / `53,3498` (European decimal comma). */
const num = (raw: string) => Number.parseFloat(raw.replace(",", "."));

/**
 * Decimal degrees with an optional hemisphere letter — the format Google shows
 * in its own UI: `53.3498° N, 6.2603° W`. Note the W means the longitude is
 * negative even though the number is written positive.
 */
const DMS_LIKE =
  /(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NSns])\s*[, ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EWew])/;

/** A bare pair: `53.3498, -6.2603` or `53.3498 -6.2603`. */
const PAIR = /(-?\d{1,3}[.,]\d+)\s*[,;\s]\s*(-?\d{1,3}[.,]\d+)/;

export function parseCoordinates(input: string): ParseResult {
  const text = input.trim();
  if (text === "") return { point: null, failure: "empty", source: null };

  // Shortened links resolve server-side; we cannot follow them from here and
  // should say so rather than failing with "no coordinates found".
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(text)) {
    return { point: null, failure: "short_link", source: null };
  }

  const finish = (lat: number, lng: number, source: string): ParseResult => {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return { point: null, failure: "out_of_range", source };
    }
    return {
      point: { lat: +lat.toFixed(6), lng: +lng.toFixed(6) },
      failure: null,
      source,
    };
  };

  // --- hemisphere form, before the plain pair so N/W is not lost ---
  const dms = DMS_LIKE.exec(text);
  if (dms) {
    const lat = Math.abs(num(dms[1])) * (/[Ss]/.test(dms[2]) ? -1 : 1);
    const lng = Math.abs(num(dms[3])) * (/[Ww]/.test(dms[4]) ? -1 : 1);
    return finish(lat, lng, "degrees with hemisphere");
  }

  // --- URLs: the query parameters are more reliable than the path ---
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);

      // Apple Maps `?ll=`, Google `?q=` / `?query=`, Waze `?ll=`.
      for (const key of ["ll", "q", "query", "daddr", "destination"]) {
        const value = url.searchParams.get(key);
        const pair = value ? PAIR.exec(value) : null;
        if (pair) return finish(num(pair[1]), num(pair[2]), `${key}= parameter`);
      }

      // Google's `/@53.3498,-6.2603,17z` viewport segment. This is the map
      // centre, not the pin — close enough to place a stop, and flagged as
      // approximate in the UI.
      const at = /@(-?\d{1,3}[.,]\d+),(-?\d{1,3}[.,]\d+)/.exec(url.pathname);
      if (at) return finish(num(at[1]), num(at[2]), "map centre from the URL");

      // `/place/.../data=!3d53.3498!4d-6.2603` — the actual pin.
      const d3 = /!3d(-?\d{1,3}\.\d+)/.exec(text);
      const d4 = /!4d(-?\d{1,3}\.\d+)/.exec(text);
      if (d3 && d4) return finish(num(d3[1]), num(d4[1]), "pin from the URL");
    } catch {
      // Not a parseable URL — fall through to the plain-pair attempt.
    }
  }

  const pair = PAIR.exec(text);
  if (pair) return finish(num(pair[1]), num(pair[2]), "coordinate pair");

  return { point: null, failure: "no_coordinates", source: null };
}

export const PARSE_MESSAGE: Record<ParseFailure, string> = {
  empty: "Paste a coordinate or a Google Maps link.",
  short_link:
    "Short maps.app.goo.gl links cannot be resolved here. Open it, then copy the full URL or the coordinates.",
  no_coordinates:
    "No coordinates found. Right-click the place in Google Maps and copy the numbers it shows.",
  out_of_range: "Those numbers are outside the valid range for a coordinate.",
};

export type CoordinateCheck =
  | { level: "ok"; message: null }
  | { level: "transposed"; message: string; swapped: LatLng }
  | { level: "wrong_country"; message: string; suggested: CountryCode | null }
  | { level: "unknown_area"; message: string };

/**
 * Sanity-checks a point against the country the order says it is in.
 *
 * None of these block saving — a dispatcher may know better than the bounding
 * box. They exist because silently plotting a Donegal delivery in the Atlantic
 * is worse than a question.
 */
export function checkCoordinates(
  point: LatLng,
  expected: CountryCode,
): CoordinateCheck {
  if (isInCountry(point, expected)) return { level: "ok", message: null };

  if (looksTransposed(point, expected)) {
    return {
      level: "transposed",
      message:
        "Latitude and longitude look swapped — this lands in the sea, but the reverse is in the right place.",
      swapped: { lat: point.lng, lng: point.lat },
    };
  }

  const actual = countryForPoint(point);
  if (actual && actual !== expected) {
    return {
      level: "wrong_country",
      message: `That point is in ${actual}, but the order says ${expected}.`,
      suggested: actual,
    };
  }

  return {
    level: "unknown_area",
    message: `That point is outside ${expected}. Save it only if you are sure.`,
  };
}
