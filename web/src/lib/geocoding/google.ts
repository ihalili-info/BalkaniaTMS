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
 *
 * **Ireland is a special case worth exploiting.** An Eircode identifies a
 * single building — it is not a district like a UK outward code or a French
 * CP. Rural Irish addresses ("the second bungalow past the church, Kilcolman")
 * are hopeless as a string and pin-sharp as an Eircode, so when the order
 * carries a well-formed Eircode we try it *on its own* first and only fall
 * back to the address string if that misses.
 */

import { country, countryForPoint, isInCountry } from "@/lib/regions";
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
  /**
   * Which query produced the result — an Eircode lookup or the address string.
   * Shown back so a dispatcher can see *why* a rural order suddenly resolved.
   */
  matchedBy: "eircode" | "address" | null;
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

/** A single graded Google lookup — one set of query params, one verdict. */
interface RawMatch {
  point: LatLng | null;
  failure: GeocodeFailure | null;
  formatted: string | null;
  precision: LocationType | null;
  partial: boolean;
}

const NO_MATCH: RawMatch = {
  point: null,
  failure: null,
  formatted: null,
  precision: null,
  partial: false,
};

/**
 * One request to Google, graded against the precision and country rules.
 *
 * `failure` is set for a hard stop (quota, denied, network, nothing found);
 * `point` is null with no failure when Google answered but the match was too
 * coarse or landed in the wrong country — the caller may then try another
 * query before giving up.
 */
async function runGeocode(
  params: URLSearchParams,
  countryCode: CountryCode,
): Promise<RawMatch> {
  let body: { status?: string; results?: GoogleResult[] };
  try {
    const response = await fetch(`${ENDPOINT}?${params}`, {
      // Addresses are corrected by hand; a cached miss would survive the fix.
      cache: "no-store",
    });
    body = await response.json();
  } catch {
    return { ...NO_MATCH, failure: "network" };
  }

  const status = body.status ?? "UNKNOWN_ERROR";
  if (status === "ZERO_RESULTS") return { ...NO_MATCH, failure: "no_result" };
  if (status === "OVER_QUERY_LIMIT") return { ...NO_MATCH, failure: "quota" };
  if (status === "REQUEST_DENIED") return { ...NO_MATCH, failure: "denied" };

  const result = body.results?.[0];
  const lat = result?.geometry?.location?.lat;
  const lng = result?.geometry?.location?.lng;
  if (status !== "OK" || typeof lat !== "number" || typeof lng !== "number") {
    return { ...NO_MATCH, failure: "no_result" };
  }

  const precision = (result?.geometry?.location_type ?? null) as LocationType | null;
  const formatted = result?.formatted_address ?? null;
  const partial = result?.partial_match === true;
  const point: LatLng = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };

  if (!precision || !ACCEPTED.includes(precision)) {
    return { ...NO_MATCH, failure: null, formatted, precision, partial };
  }

  // A second, independent check. The component filter should already have kept
  // us in-country, but a bounding-box test costs nothing and catches the case
  // where Google satisfies the filter with something implausible.
  if (!isInCountry(point, countryCode)) {
    const landedIn = countryForPoint(point);
    return {
      ...NO_MATCH,
      failure: null,
      formatted: landedIn
        ? `${formatted ?? "match"} — looks like ${country(landedIn).name}`
        : formatted,
      precision,
      partial,
    };
  }

  return { point, failure: null, formatted, precision, partial };
}

/**
 * A well-formed Eircode, compacted and upper-cased ("D02XY45"), or null.
 * Uses the same shape check as the rest of the app (`regions.ts`), so the two
 * never drift apart. Shared with the geocode cache, which keys Irish addresses
 * on it.
 */
export function compactEircode(postcode: string | null): string | null {
  if (!postcode) return null;
  const compact = postcode.replace(/\s+/g, "").toUpperCase();
  if (compact.length !== 7) return null;
  if (!country("IE").postcodePattern.test(compact)) return null;
  return compact;
}

/** The same Eircode in its canonical "D02 XY45" spacing, for a Google query. */
function normaliseEircode(postcode: string | null): string | null {
  const compact = compactEircode(postcode);
  return compact ? `${compact.slice(0, 3)} ${compact.slice(3)}` : null;
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
 *
 * Three passes: (1) the Eircode alone, Ireland only; (2) the address string
 * with `country` + `postal_code` component filters; (3) — only if pass 2 finds
 * nothing — the address string with the postcode folded in as free text and
 * just the `country` filter, because Google's `postal_code` component is a hard
 * AND and returns ZERO_RESULTS on a slightly-off postcode where the same
 * postcode as text would have matched. The in-country bounding-box check still
 * applies to pass 3's result.
 */
export async function geocodeAddress(
  address: string,
  countryCode: CountryCode,
  postcode: string | null,
): Promise<GeocodeOutcome> {
  const empty: GeocodeOutcome = {
    point: null,
    failure: null,
    formatted: null,
    precision: null,
    partial: false,
    matchedBy: null,
  };

  const key = process.env.GEOCODING_API_KEY?.trim();
  if (!key) return { ...empty, failure: "not_configured" };

  const trimmedAddress = address.trim();
  const eircode = countryCode === "IE" ? normaliseEircode(postcode) : null;

  if (trimmedAddress === "" && !eircode) {
    return { ...empty, failure: "no_result" };
  }

  // --- pass 1: the Eircode alone (Ireland only) --------------------------
  // An Eircode is a building, not a district, so querying it on its own is
  // the most precise lookup available for an Irish order — and it sidesteps a
  // messy rural address string entirely. Only accepted when it comes back
  // ROOFTOP/interpolated and in-country; otherwise we fall through.
  if (eircode) {
    const params = new URLSearchParams({
      address: eircode,
      components: `country:${countryCode}`,
      key,
    });
    const hit = await runGeocode(params, countryCode);
    // A hard infrastructure failure is worth surfacing now rather than
    // masking it with a second attempt that will fail the same way.
    if (hit.failure === "quota" || hit.failure === "denied" || hit.failure === "network") {
      return { ...empty, failure: hit.failure };
    }
    if (hit.point) {
      return {
        point: hit.point,
        failure: null,
        formatted: hit.formatted,
        precision: hit.precision,
        partial: hit.partial,
        matchedBy: "eircode",
      };
    }
  }

  // --- pass 2: the address string, postcode as a constraint -------------
  if (trimmedAddress === "") {
    return { ...empty, failure: "no_result" };
  }

  const trimmedPostcode = postcode?.trim() ?? "";

  const params = new URLSearchParams({
    address: trimmedAddress,
    components: trimmedPostcode
      ? `country:${countryCode}|postal_code:${trimmedPostcode}`
      : `country:${countryCode}`,
    key,
  });

  let hit = await runGeocode(params, countryCode);

  // --- pass 3: postcode folded into the string, not a component ----------
  // Google's `postal_code` component filter is a hard AND and is unreliable
  // outside the US — a slightly-off or unusual postcode makes it return
  // ZERO_RESULTS when the address plus postcode as free text would have
  // matched. Only retried when pass 2 found *nothing* and a postcode was in
  // play, so it can never downgrade a result pass 2 already had.
  if (hit.failure === "no_result" && trimmedPostcode) {
    const looser = new URLSearchParams({
      address: `${trimmedAddress}, ${trimmedPostcode}`,
      components: `country:${countryCode}`,
      key,
    });
    const retry = await runGeocode(looser, countryCode);
    if (retry.point || retry.failure === null) hit = retry;
  }

  if (hit.failure) {
    return { ...empty, failure: hit.failure };
  }
  if (!hit.point) {
    // Google answered but the match was unusable. Distinguish the two reasons
    // the same way the old code did, so the message is still specific.
    if (hit.precision && !ACCEPTED.includes(hit.precision)) {
      return {
        ...empty,
        failure: "too_coarse",
        formatted: hit.formatted,
        precision: hit.precision,
        partial: hit.partial,
      };
    }
    return {
      ...empty,
      failure: "wrong_country",
      formatted: hit.formatted,
      precision: hit.precision,
      partial: hit.partial,
    };
  }

  return {
    point: hit.point,
    failure: null,
    formatted: hit.formatted,
    precision: hit.precision,
    partial: hit.partial,
    matchedBy: "address",
  };
}
