import "server-only";

/**
 * The geocode cache — read/write helpers over the `geocode_cache` table
 * (migration 0012).
 *
 * The point of the cache is to stop paying — in Google lookups and in
 * dispatcher attention — to resolve an address we have resolved before. The
 * point of *this* module is to keep the trust rules in one place:
 *
 *   * a `manual` fix is reused directly and is never overwritten by a later
 *     automatic geocode (the DB enforces the second half);
 *   * a `rooftop` / `interpolated` hit is reused directly;
 *   * a `geometric_center` hit is weak — the caller should try a fresh geocode
 *     first and only fall back to the cache if that fails;
 *   * an address with neither an Eircode (IE) nor a postcode is **not cached**.
 *     A fuzzy address-string key is how a stale pin ends up on a live order.
 */

import type { createClient } from "@/lib/supabase/server";
import { compactEircode } from "@/lib/geocoding/google";
import type { CountryCode } from "@/lib/regions";
import type { LatLng } from "@/lib/types";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export type CacheSource = "manual" | "rooftop" | "interpolated" | "geometric_center";

/** Google's `location_type` → our `source`. Unknown / refused grades → null. */
export function cacheSourceForPrecision(precision: string | null): CacheSource | null {
  switch (precision) {
    case "ROOFTOP":
      return "rooftop";
    case "RANGE_INTERPOLATED":
      return "interpolated";
    case "GEOMETRIC_CENTER":
      return "geometric_center";
    default:
      return null;
  }
}

/** A `geometric_center` hit is not trusted enough to skip a fresh geocode. */
export function isStrongCacheHit(source: CacheSource): boolean {
  return source !== "geometric_center";
}

/**
 * The lookup key, or null when this address must not be cached.
 *
 * Ireland: the Eircode, compacted — it identifies one building. Elsewhere:
 * country + postcode + a normalised address line, which together are specific
 * enough. No Eircode and no postcode → null.
 */
export function geocodeCacheKey(
  countryCode: CountryCode,
  postcode: string | null,
  address: string,
): string | null {
  if (countryCode === "IE") {
    const eircode = compactEircode(postcode);
    return eircode ? `IE:${eircode}` : null;
  }

  const pc = (postcode ?? "").replace(/\s+/g, "").toUpperCase();
  if (pc === "") return null;

  const line = normaliseAddressLine(address);
  if (line === "") return null;

  return `${countryCode}:${pc}:${line}`;
}

/** Lowercase, strip punctuation, collapse whitespace. Stable across imports. */
function normaliseAddressLine(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CachedLocation {
  point: LatLng;
  source: CacheSource;
  formatted: string | null;
}

/**
 * Looks an address up in the cache. Records the hit (`touch_geocode_cache`) so
 * a stale-entry sweep can tell what is still earning its keep — best-effort,
 * never blocks the read.
 */
export async function lookupGeocodeCache(
  supabase: ServerClient,
  countryCode: CountryCode,
  postcode: string | null,
  address: string,
): Promise<CachedLocation | null> {
  const key = geocodeCacheKey(countryCode, postcode, address);
  if (!key) return null;

  const { data, error } = await supabase
    .from("geocode_cache_geo")
    .select("lat, lng, source, formatted_address")
    .eq("key", key)
    .maybeSingle();

  if (error || !data) return null;
  if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;

  void supabase.rpc("touch_geocode_cache", { p_key: key });

  return {
    point: { lat: data.lat, lng: data.lng },
    source: data.source as CacheSource,
    formatted: data.formatted_address ?? null,
  };
}

/**
 * Writes a resolved location back to the cache. A no-op when the address is not
 * cacheable (no Eircode / postcode). The DB refuses to let a non-`manual`
 * write overwrite a `manual` row, so callers do not have to check.
 */
export async function saveGeocodeCache(
  supabase: ServerClient,
  input: {
    countryCode: CountryCode;
    postcode: string | null;
    address: string;
    point: LatLng;
    source: CacheSource;
    formatted?: string | null;
    /** Set for `source: "manual"` — the dispatcher who placed the pin. */
    verifiedBy?: string | null;
  },
): Promise<void> {
  const key = geocodeCacheKey(input.countryCode, input.postcode, input.address);
  if (!key) return;

  await supabase.rpc("upsert_geocode_cache", {
    p_key: key,
    p_lat: input.point.lat,
    p_lng: input.point.lng,
    p_source: input.source,
    p_formatted: input.formatted ?? null,
    p_verified_by: input.verifiedBy ?? null,
  });
}
