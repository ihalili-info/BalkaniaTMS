import "server-only";

/**
 * Google Geocoding — address → coordinate.
 *
 * Server-only, and on purpose: this uses `GEOCODING_API_KEY`, which must never
 * reach a browser. It is a different key from the basemap one (`maps.server.ts`
 * explains why) precisely so that this one can stay private and authorise
 * billable lookups.
 *
 * **The point that decides everything here is precision.** A geocode is not
 * pass/fail — Google will happily answer "Ballymount, Dublin" with the centre
 * of Ballymount and report success. Storing that gives an order coordinates
 * that *look* real: it clusters convincingly in the planner and it sits inside
 * a 5 km geofence, so the proximity alert fires while the driver is still
 * streets away from a customer who was told they were close. A wrong
 * coordinate is worse than no coordinate, because no coordinate is visible and
 * a wrong one is not.
 *
 * So results coarser than a street are refused and sent to the manual
 * "Fix address" path instead of being written.
 */

import { countryForPoint, country, isInCountry } from "@/lib/regions";
import type { CountryCode } from "@/lib/regions";
import type { LatLng } from "@/lib/types";

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * Google's own precision grades.
 *
 * `APPROXIMATE` is a town, county or postcode district centroid. It is the one
 * we refuse — see the header.
 */
type LocationType =
  | "ROOFTOP"
  | "RANGE_INTERPOLATED"
  | "GEOMETRIC_CENTER"
  | "APPROXIMATE";

const ACCEPTED: LocationType[] = [
  "ROOFTOP",
  "RANGE_INTERPOLATED",
  // A street's geometric centre. Coarse, but it is the right street — good
  // enough for a 5 km geofence and for clustering.
  "GEOMETRIC_CENTER",
];

export type GeocodeFailure =
  | "not_configured"
  | "no_result"
  | "too_coarse"
  | "wrong_country"
  | "quota"
  | "denied"
  | "network";

export interface GeocodeOutcome {
  point: LatLng | null;
  failure: GeocodeFailure | null;
  /** Google's normalised address, shown back so a bad match is obvious. */
  formatted: string | null;
  precision: LocationType | null;
  /** Google flagged the match as partial — the address was not fully matched. */
  partial: boolean;
}

export const GEOCODE_MESSAGE: Record<GeocodeFailure, string> = {
  not_configured: "GEOCODING_API_KEY is not set on this deployment.",
  no_result: "Google found no match for this address.",
  too_coarse:
    "Only matched to a town or district, not a street. Place it by hand — a town-centre point would sit inside the 5 km geofence and fire the customer alert early.",
  wrong_country:
    "The match landed outside the delivery country. Check the address and country column.",
  quota: "Google's quota or rate limit was hit. Try again shortly.",
  denied:
    "Google refused the request — usually the key is restricted to the wrong API or to HTTP referrers. A server-side key must have no referrer restriction.",
  network: "Could not reach Google.",
};

export function geocodingConfigured(): boolean {
  return Boolean(process.env.GEOCODING_API_KEY?.trim());
}

interface GoogleResult {
  formatted_address?: string;
  partial_match?: boolean;
  geometry?: {
    location?: { lat?: number; lng?: number };
    location_type?: string;
  };
}

/**
 * One address.
 *
 * `components` is used rather than appending the country to the string:
 * Google treats a component filter as a constraint and a string as a hint, and
 * "Station Road" without the constraint resolves to any of several countries.
 * The postcode is passed the same way when present — for Ireland an Eircode
 * pins a single building, which turns an otherwise hopeless rural townland
 * address into a rooftop match.
 */
export async function geocodeAddress(
  address: string,
  countryCode: CountryCode,
  postcode: string | null,
): Promise<GeocodeOutcome> {
  const empty = { point: null, formatted: null, precision: null, partial: false };

  const key = process.env.GEOCODING_API_KEY?.trim();
  if (!key) return { ...empty, failure: "not_configured" };
  if (address.trim() === "") return { ...empty, failure: "no_result" };

  const components = [`country:${countryCode}`];
  if (postcode && postcode.trim() !== "") {
    components.push(`postal_code:${postcode.trim()}`);
  }

  const params = new URLSearchParams({
    address: address.trim(),
    components: components.join("|"),
    key,
  });

  let body: { status?: string; results?: GoogleResult[] };
  try {
    const response = await fetch(`${ENDPOINT}?${params}`, {
      // Addresses are corrected by hand; a cached miss would survive the fix.
      cache: "no-store",
    });
    body = await response.json();
  } catch {
    return { ...empty, failure: "network" };
  }

  const status = body.status ?? "UNKNOWN_ERROR";
  if (status === "ZERO_RESULTS") return { ...empty, failure: "no_result" };
  if (status === "OVER_QUERY_LIMIT") return { ...empty, failure: "quota" };
  if (status === "REQUEST_DENIED") return { ...empty, failure: "denied" };

  const result = body.results?.[0];
  const lat = result?.geometry?.location?.lat;
  const lng = result?.geometry?.location?.lng;
  if (status !== "OK" || typeof lat !== "number" || typeof lng !== "number") {
    return { ...empty, failure: "no_result" };
  }

  const precision = (result?.geometry?.location_type ?? null) as LocationType | null;
  const formatted = result?.formatted_address ?? null;
  const partial = result?.partial_match === true;
  const point: LatLng = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };

  if (!precision || !ACCEPTED.includes(precision)) {
    return { point: null, failure: "too_coarse", formatted, precision, partial };
  }

  // A second, independent check. The component filter should already have kept
  // us in-country, but a bounding-box test costs nothing and catches the case
  // where Google satisfies the filter with something implausible.
  if (!isInCountry(point, countryCode)) {
    const landedIn = countryForPoint(point);
    return {
      point: null,
      failure: "wrong_country",
      formatted: landedIn
        ? `${formatted ?? "match"} — looks like ${country(landedIn).name}`
        : formatted,
      precision,
      partial,
    };
  }

  return { point, failure: null, formatted, precision, partial };
}
