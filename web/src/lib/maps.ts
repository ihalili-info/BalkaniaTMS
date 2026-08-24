/**
 * Google Maps basemap configuration.
 *
 * **This key reaches the browser.** The Maps JavaScript API is loaded by the
 * client and authenticates with the key in the script URL — there is no way to
 * proxy it server-side. That is normal and Google expects it, but it means the
 * key must be:
 *
 * 1. **Restricted by HTTP referrer** in Google Cloud Console → Credentials →
 *    (key) → Application restrictions, to `tms.balkania.ie/*` and
 *    `localhost:*`. Without that, anyone who views source can spend the
 *    account's Maps quota.
 * 2. **Restricted by API** to *Maps JavaScript API* only.
 * 3. **A different key from the server-side geocoding key.** `GEOCODING_API_KEY`
 *    stays server-only and is never sent to a browser — this module
 *    deliberately does not fall back to it, because publishing a key that also
 *    authorises Geocoding, Routes or Places turns a map into a billing hole.
 *
 * Absent a key the Live Fleet Map falls back to the schematic projection,
 * which is still to scale — it just has no road network.
 */

/** Where the map opens before it has anything to fit — the Ballymount depot. */
export const MAP_DEFAULT_ZOOM = 7;

export function googleMapsKey(): string | null {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  return key ? key : null;
}

let pending: Promise<typeof google.maps> | null = null;

/**
 * Loads the Maps JavaScript API once per page.
 *
 * Deliberately hand-rolled rather than pulling in a loader package: the whole
 * job is one `<script>` tag and a callback, and the promise cache below is the
 * only state involved.
 */
export function loadGoogleMaps(apiKey: string): Promise<typeof google.maps> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps can only load in a browser"));
  }
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    const callback = "__balkaniaMapsReady";
    (window as unknown as Record<string, unknown>)[callback] = () => {
      resolve(window.google.maps);
    };

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: apiKey,
      // `geometry` gives spherical distance; markers are the classic overlay
      // type, which needs no cloud-configured Map ID.
      libraries: "geometry",
      callback,
      loading: "async",
      v: "weekly",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      // Reset so a later mount can retry — a transient network failure should
      // not permanently disable the map for the session.
      pending = null;
      reject(new Error("Google Maps failed to load"));
    };
    document.head.appendChild(script);
  });

  return pending;
}

/**
 * Reads a design-system colour so the overlays match the rest of the app.
 *
 * Google's objects take colour strings, not CSS variables, so the token has to
 * be resolved before it is handed over.
 */
export function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === "" ? fallback : value;
}
