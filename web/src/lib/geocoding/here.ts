import "server-only";

/**
 * HERE Geocoding & Search — address → coordinate.
 *
 * Server-only, and on purpose: this uses `HERE_API_KEY`, which must never reach
 * a browser. It is a different key from the basemap one (`maps.server.ts`
 * explains why) precisely so that this one can stay private and authorise
 * billable lookups.
 *
 * **The point that decides everything here is precision.** A geocode is not
 * pass/fail — a geocoder will happily answer "Ballymount, Dublin" with the
 * centre of Ballymount and report success. Storing that gives an order
 * coordinates that *look* real: it clusters convincingly in the planner and it
 * sits inside a 5 km geofence, so the proximity alert fires while the driver is
 * still streets away from a customer who was told they were close. A wrong
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
 * carries a well-formed Eircode we try it *on its own* first and only fall back
 * to the address string if that misses. HERE documents postal-code-only address
 * lookup for Ireland specifically, which is what makes that pass work.
 *
 * Checked against the Geocoding & Search v7 reference
 * (`geocode.search.hereapi.com/v1/geocode`), September 2026. Plain `fetch` —
 * no runtime dependency.
 */

import {
  alpha3ForCountry,
  country,
  countryForPoint,
  isInCountry,
} from "@/lib/regions";
import type { CountryCode } from "@/lib/regions";
import type { LatLng } from "@/lib/types";

const ENDPOINT = "https://geocode.search.hereapi.com/v1/geocode";

/**
 * Our own precision grades, not the provider's.
 *
 * HERE reports precision across two fields (`resultType` and, for addresses,
 * `houseNumberType`); this collapses them into the grades the rest of the app
 * reasons about, so nothing downstream — the geocode cache above all — has to
 * know a provider's vocabulary.
 *
 * `area` is the one we refuse. It is a town, county or postcode-district
 * centroid; see the header.
 */
export type GeocodePrecision =
  | "rooftop"
  | "interpolated"
  | "street"
  | "postal_point"
  | "area";

const ACCEPTED: GeocodePrecision[] = [
  "rooftop",
  "interpolated",
  // A street's geometry. Coarse, but it is the right street — good enough for
  // a 5 km geofence and for clustering.
  "street",
  // An Eircode. Accepted only for Ireland — see `gradeResult`.
  "postal_point",
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
  /** HERE's normalised address, shown back so a bad match is obvious. */
  formatted: string | null;
  precision: GeocodePrecision | null;
  /**
   * The query matched only loosely — HERE scored it below the confidence bar,
   * which is its equivalent of a partial match.
   */
  partial: boolean;
  /**
   * Which query produced the result — an Eircode lookup or the address string.
   * Shown back so a dispatcher can see *why* a rural order suddenly resolved.
   */
  matchedBy: "eircode" | "address" | null;
}

export const GEOCODE_MESSAGE: Record<GeocodeFailure, string> = {
  not_configured: "HERE_API_KEY is not set on this deployment.",
  no_result: "HERE found no match for this address.",
  too_coarse:
    "Only matched to a town or district, not a street. Place it by hand — a town-centre point would sit inside the 5 km geofence and fire the customer alert early.",
  wrong_country:
    "The match landed outside the delivery country. Check the address and country column.",
  quota: "HERE's quota or rate limit was hit. Try again shortly.",
  denied:
    "HERE refused the request — usually the key is disabled, or restricted to the wrong service or to the wrong domains. A server-side key must not be domain-restricted.",
  network: "Could not reach HERE.",
};

export function geocodingConfigured(): boolean {
  return Boolean(process.env.HERE_API_KEY?.trim());
}

/**
 * Below this, HERE considered the query only loosely satisfied. Not a refusal
 * — a flag, the same way Google's `partial_match` was treated: the dispatcher
 * sees the normalised address and decides.
 */
const PARTIAL_SCORE = 0.75;

interface HereItem {
  title?: string;
  resultType?: string;
  houseNumberType?: string;
  address?: { label?: string };
  position?: { lat?: number; lng?: number };
  scoring?: { queryScore?: number };
}

/** A single graded HERE lookup — one set of query params, one verdict. */
interface RawMatch {
  point: LatLng | null;
  failure: GeocodeFailure | null;
  formatted: string | null;
  precision: GeocodePrecision | null;
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
 * HERE's two precision fields → one grade.
 *
 * `postalCodePoint` is the interesting one. In Ireland it *is* a building,
 * because an Eircode is unique to an address — that is the whole reason the
 * Eircode pass below is worth making. Anywhere else a postcode is a district
 * (a UK outward code covers thousands of homes), so the same result type is
 * refused. This is the one place the country changes what a grade means.
 */
function gradeResult(
  item: HereItem,
  countryCode: CountryCode,
): GeocodePrecision {
  switch (item.resultType) {
    case "houseNumber":
      // PA (point address) and MPA (micro point address) are surveyed
      // building points. `interpolated` is guessed along an address range —
      // still street-accurate, which is the bar.
      return item.houseNumberType === "interpolated" ? "interpolated" : "rooftop";
    case "street":
      return "street";
    case "postalCodePoint":
      return countryCode === "IE" ? "postal_point" : "area";
    default:
      // locality, administrativeArea, addressBlock, place, intersection.
      return "area";
  }
}

/**
 * One request to HERE, graded against the precision and country rules.
 *
 * `failure` is set for a hard stop (quota, denied, network, nothing found);
 * `point` is null with no failure when HERE answered but the match was too
 * coarse or landed in the wrong country — the caller may then try another
 * query before giving up.
 */
async function runGeocode(
  params: URLSearchParams,
  countryCode: CountryCode,
): Promise<RawMatch> {
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${params}`, {
      // Addresses are corrected by hand; a cached miss would survive the fix.
      cache: "no-store",
    });
  } catch {
    return { ...NO_MATCH, failure: "network" };
  }

  if (!response.ok) {
    if (response.status === 429) return { ...NO_MATCH, failure: "quota" };
    if (response.status === 401 || response.status === 403) {
      return { ...NO_MATCH, failure: "denied" };
    }
    const body = await response.text().catch(() => "");
    console.error(
      `[geocoding] ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
    return { ...NO_MATCH, failure: "no_result" };
  }

  let body: { items?: HereItem[] };
  try {
    body = await response.json();
  } catch {
    return { ...NO_MATCH, failure: "network" };
  }

  const item = body.items?.[0];
  const lat = item?.position?.lat;
  const lng = item?.position?.lng;
  if (!item || typeof lat !== "number" || typeof lng !== "number") {
    return { ...NO_MATCH, failure: "no_result" };
  }

  const precision = gradeResult(item, countryCode);
  const formatted = item.address?.label ?? item.title ?? null;
  const score = item.scoring?.queryScore;
  const partial = typeof score === "number" && score < PARTIAL_SCORE;
  const point: LatLng = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };

  if (!ACCEPTED.includes(precision)) {
    return { ...NO_MATCH, failure: null, formatted, precision, partial };
  }

  // A second, independent check. The `in=countryCode:` filter should already
  // have kept us in-country, but a bounding-box test costs nothing and catches
  // the case where HERE satisfies the filter with something implausible.
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

/** The same Eircode in its canonical "D02 XY45" spacing, for a HERE query. */
function normaliseEircode(postcode: string | null): string | null {
  const compact = compactEircode(postcode);
  return compact ? `${compact.slice(0, 3)} ${compact.slice(3)}` : null;
}

/**
 * One address.
 *
 * `in=countryCode:` is used rather than appending the country to the string:
 * HERE treats it as a hard constraint and a string as a hint, and "Station
 * Road" without the constraint resolves to any of several countries. It wants
 * ISO alpha-3, which is why `alpha3ForCountry()` exists — note that `XI` maps
 * to `GBR` there, because Northern Ireland is a customs territory and not a
 * geocoding one.
 *
 * Two passes: (1) the Eircode alone, Ireland only; (2) the address string with
 * the postcode folded in. Unlike Google's geocoder there is no `postal_code`
 * component filter behaving as a hard AND, so there is no third, looser pass
 * to work around it — the postcode is simply part of the query text.
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

  const key = process.env.HERE_API_KEY?.trim();
  if (!key) return { ...empty, failure: "not_configured" };

  const alpha3 = alpha3ForCountry(countryCode);
  const trimmedAddress = address.trim();
  const eircode = countryCode === "IE" ? normaliseEircode(postcode) : null;

  if (trimmedAddress === "" && !eircode) {
    return { ...empty, failure: "no_result" };
  }

  /** Every query carries the same country constraint and a single result. */
  const query = (q: string) => {
    const params = new URLSearchParams({ q, limit: "1", apiKey: key });
    if (alpha3) params.set("in", `countryCode:${alpha3}`);
    return params;
  };

  // --- pass 1: the Eircode alone (Ireland only) --------------------------
  // An Eircode is a building, not a district, so querying it on its own is the
  // most precise lookup available for an Irish order — and it sidesteps a messy
  // rural address string entirely. Only accepted when it comes back at street
  // precision or better and in-country; otherwise we fall through.
  if (eircode) {
    const hit = await runGeocode(query(eircode), countryCode);
    // A hard infrastructure failure is worth surfacing now rather than masking
    // it with a second attempt that will fail the same way.
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

  // --- pass 2: the address string, postcode folded in --------------------
  if (trimmedAddress === "") {
    return { ...empty, failure: "no_result" };
  }

  const trimmedPostcode = postcode?.trim() ?? "";
  const hit = await runGeocode(
    query(trimmedPostcode ? `${trimmedAddress}, ${trimmedPostcode}` : trimmedAddress),
    countryCode,
  );

  if (hit.failure) {
    return { ...empty, failure: hit.failure };
  }
  if (!hit.point) {
    // HERE answered but the match was unusable. Distinguish the two reasons so
    // the message stays specific.
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

/**
 * Cheapest possible live check for an Integrations "test connection" button.
 *
 * There is no free endpoint, so this is a real one-result geocode of a fixed,
 * unambiguous address — one transaction. It proves the key is enabled for
 * Geocoding & Search and is not domain-restricted, which is the whole question.
 */
export async function verifyGeocodingConnection(): Promise<{
  ok: boolean;
  failure: GeocodeFailure | null;
}> {
  const key = process.env.HERE_API_KEY?.trim();
  if (!key) return { ok: false, failure: "not_configured" };

  const result = await geocodeAddress("Cappagh Road, Dublin 11", "IE", "D11 T9TF");
  // Only an infrastructure failure says the connection is bad. A coarse or
  // absent match would still prove the key works, which is what is being asked.
  const broken: GeocodeFailure[] = ["not_configured", "quota", "denied", "network"];
  if (result.failure && broken.includes(result.failure)) {
    return { ok: false, failure: result.failure };
  }
  return { ok: true, failure: null };
}
