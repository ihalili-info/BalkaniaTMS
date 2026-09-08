import "server-only";

/**
 * Where the HERE Maps browser key comes from.
 *
 * Server-only so the lookup itself never ships to the client — the *value*
 * still does, unavoidably, as a prop. Two names are accepted and the
 * difference matters on Vercel:
 *
 * - `NEXT_PUBLIC_HERE_MAPS_API_KEY` is inlined by the compiler, so changing it
 *   in Vercel does nothing until the next deploy.
 * - `HERE_MAPS_API_KEY` is read at request time, so it takes effect on save.
 *
 * Either way the key reaches the browser: the Maps API for JavaScript
 * authenticates in the page and cannot be proxied. The unprefixed name is
 * therefore *not* a private one here, and picking it does not make the key
 * secret — it only avoids the rebuild.
 *
 * `HERE_API_KEY` is deliberately not consulted. That one is used server-side
 * for geocoding and routing; publishing it in page source would turn a basemap
 * into an open tab on the account's billing. Keep them as two separate keys in
 * the HERE project settings, and restrict this one to the **Maps API for
 * JavaScript** and to the app's domains (`tms.balkania.ie`, `localhost`).
 */

/** Checked in order. Named here so the UI can tell the user what it looked for. */
export const MAPS_KEY_VARS = [
  "NEXT_PUBLIC_HERE_MAPS_API_KEY",
  "HERE_MAPS_API_KEY",
] as const;

export function hereMapsKey(): string | null {
  const key =
    process.env.NEXT_PUBLIC_HERE_MAPS_API_KEY?.trim() ||
    process.env.HERE_MAPS_API_KEY?.trim();
  return key ? key : null;
}
