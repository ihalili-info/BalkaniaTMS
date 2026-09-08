/**
 * HERE Maps API for JavaScript — the browser side.
 *
 * Where the key comes from is `maps.server.ts`; this module only loads the SDK
 * and hands back the global `H` namespace.
 *
 * **This key reaches the browser.** The Maps API for JavaScript is loaded by
 * the client and authenticates with the key it is given — there is no way to
 * proxy it server-side. That is normal and HERE expects it, but it means the
 * key must be:
 *
 * 1. **Domain-restricted** in the HERE project settings to `tms.balkania.ie`
 *    and `localhost`. Without that, anyone who views source can spend the
 *    account's map quota.
 * 2. **Restricted to the Maps API for JavaScript** only.
 * 3. **A different key from `HERE_API_KEY`.** That one stays server-only and is
 *    never sent to a browser — this module deliberately does not fall back to
 *    it, because publishing a key that also authorises Geocoding and Routing
 *    turns a map into a billing hole.
 *
 * Absent a key the Live Fleet Map falls back to the schematic projection,
 * which is still to scale — it just has no road network.
 */

/** Where the map opens before it has anything to fit — the Dublin 11 depot. */
export const MAP_DEFAULT_ZOOM = 7;

/**
 * Pinned to a full four-part version rather than the floating `3.2`.
 *
 * HERE's own production guidance: the floating alias is repointed when they
 * ship, so a page that works today can break on a morning nobody deployed
 * anything. Bump this deliberately.
 */
const SDK_VERSION = "3.2.0.0";
const SDK_BASE = `https://js.api.here.com/v3/${SDK_VERSION}`;

/**
 * Order matters. Each file attaches to the global `H` created by the one
 * before it, so these cannot be fired off in parallel — `mapsjs-service.js`
 * evaluated before `mapsjs-core.js` throws on an undefined namespace.
 */
const SDK_SCRIPTS = [
  "mapsjs-core.js",
  "mapsjs-service.js",
  "mapsjs-mapevents.js",
  "mapsjs-ui.js",
] as const;

/**
 * The HERE namespace, as loaded onto `window.H`.
 *
 * Typed loosely on purpose. The SDK ships no types of its own, and the
 * community `@types/heremaps` package tracks the 3.1 line — depending on it
 * would buy compile-time names that may not match the 3.2 runtime, which is
 * worse than no types at all. The two canvases that consume this are the only
 * callers, both are small, and both are exercised by `next build`.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type HereNamespace = any;

let pending: Promise<HereNamespace> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(src)));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => reject(new Error(src)));
    document.head.appendChild(script);
  });
}

function loadStylesheet(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Loads the HERE Maps SDK once per page.
 *
 * Deliberately hand-rolled rather than pulling in the npm package: the whole
 * job is four `<script>` tags in order plus a stylesheet, and keeping it on the
 * CDN keeps a large map SDK out of the app bundle for every route that never
 * shows a map.
 */
export function loadHereMaps(): Promise<HereNamespace> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("HERE Maps can only load in a browser"));
  }
  const existing = (window as unknown as { H?: HereNamespace }).H;
  if (existing) return Promise.resolve(existing);
  if (pending) return pending;

  pending = (async () => {
    // The UI stylesheet is only needed for the zoom/scale controls, so it is
    // fire-and-forget — a map with unstyled controls still works.
    loadStylesheet(`${SDK_BASE}/mapsjs-ui.css`);
    for (const file of SDK_SCRIPTS) {
      await loadScript(`${SDK_BASE}/${file}`);
    }
    const H = (window as unknown as { H?: HereNamespace }).H;
    if (!H) throw new Error("HERE Maps loaded but did not define H");
    return H;
  })().catch((error) => {
    // Reset so a later mount can retry — a transient network failure should
    // not permanently disable the map for the session.
    pending = null;
    throw error;
  });

  return pending;
}

/**
 * Reads a design-system colour so the overlays match the rest of the app.
 *
 * HERE's style objects take colour strings, not CSS variables, so the token has
 * to be resolved before it is handed over.
 */
export function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value === "" ? fallback : value;
}
