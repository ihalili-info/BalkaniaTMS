import "server-only";

/**
 * Where the Google Maps browser key comes from.
 *
 * Server-only so the lookup itself never ships to the client — the *value*
 * still does, unavoidably, as a prop. Two names are accepted and the
 * difference matters on Vercel:
 *
 * - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is inlined by the compiler, so changing
 *   it in Vercel does nothing until the next deploy.
 * - `GOOGLE_MAPS_API_KEY` is read at request time, so it takes effect on save.
 *
 * Either way the key reaches the browser: the Maps JavaScript API
 * authenticates in the page and cannot be proxied. The unprefixed name is
 * therefore *not* a private one here, and picking it does not make the key
 * secret — it only avoids the rebuild.
 *
 * `GEOCODING_API_KEY` is deliberately not consulted. It is used server-side
 * for address lookups and may well authorise Geocoding, Places or Routes;
 * publishing it in page source would turn a basemap into an open tab on the
 * account's billing. Whichever name is used, restrict the key in Google Cloud
 * Console to the **Maps JavaScript API** and to HTTP referrers
 * (`tms.balkania.ie/*`, `localhost:*`).
 */

/** Checked in order. Named here so the UI can tell the user what it looked for. */
export const MAPS_KEY_VARS = [
  "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_API_KEY",
] as const;

export function googleMapsKey(): string | null {
  const key =
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ||
    process.env.GOOGLE_MAPS_API_KEY?.trim();
  return key ? key : null;
}
