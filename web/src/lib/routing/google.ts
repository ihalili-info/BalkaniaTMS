import "server-only";

/**
 * Google Routes API — road distance and drive time between points.
 *
 * Server-only, same reasoning as the geocoder: this authorises billable calls
 * with `ROUTING_API_KEY` (falling back to `GEOCODING_API_KEY` — the same Google
 * Cloud project, the same "server-side, no HTTP referrer restriction" rule).
 * The key must never reach a browser.
 *
 * **What this replaces.** Everywhere else in the app, distance between two
 * points is `haversineMeters` — a straight line. That is fine for a rough
 * cluster but wrong for anything a dispatcher acts on: two drops either side of
 * an estuary are "adjacent" on a straight line and forty minutes apart on the
 * road, and Dublin → Holyhead is a sailing, not a drive. This module answers
 * with the road network and, for a single leg, live traffic.
 *
 * **What it still does not know.** `travelMode` is `DRIVE` — a car. Google
 * Routes has no HGV profile, so it does not apply the 4.0 m bridge, the weight
 * limit, or the ADR restriction. `truckRoutingWarning()` in
 * `lib/navigation-links.ts` already states this at every point of handoff and
 * must keep doing so. A routed number is strictly better than a straight line
 * and still not a truck-legal route.
 *
 * **Failing soft.** Every function degrades to a `failure` code rather than
 * throwing, and every caller is expected to fall back to `haversineMeters`.
 * An unconfigured deployment, a spent quota or a network blip must never break
 * auto-plan or the load list — it just drops back to straight-line maths with
 * the UI saying so.
 *
 * Checked against the Routes API reference (`routes.googleapis.com`,
 * `computeRoutes` and `computeRouteMatrix`), August 2026. Plain `fetch` — one
 * JSON body each way, no runtime dependency.
 */

import type { LatLng, RouteLeg } from "@/lib/types";

const MATRIX_ENDPOINT =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const ROUTE_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * Google's cap on a single matrix request is 625 elements
 * (origins × destinations) when traffic is not considered. We tile larger
 * problems into blocks under this limit.
 */
export const MAX_MATRIX_ELEMENTS = 625;

export type RoutingFailure =
  | "not_configured"
  | "no_route"
  | "quota"
  | "denied"
  | "invalid_request"
  | "network"
  | "bad_response";

export const ROUTING_MESSAGE: Record<RoutingFailure, string> = {
  not_configured:
    "ROUTING_API_KEY (or GEOCODING_API_KEY) is not set — falling back to straight-line distance.",
  no_route: "Google could not find a road route between these points.",
  quota: "Google's Routes quota or rate limit was hit. Falling back to straight-line distance.",
  denied:
    "Google refused the Routes request — the key is not enabled for the Routes API, or is referrer-restricted. A server-side key must have no referrer restriction.",
  invalid_request:
    "Google rejected the Routes request (HTTP 400). Check that the Routes API is enabled on the key's project; see the server log for the exact reason.",
  network: "Could not reach Google Routes.",
  bad_response: "Google Routes returned something unparseable.",
};

export function routingConfigured(): boolean {
  return Boolean(routingKey());
}

function routingKey(): string | null {
  return (
    process.env.ROUTING_API_KEY?.trim() ||
    process.env.GEOCODING_API_KEY?.trim() ||
    null
  );
}

export type { RouteLeg };

function point(p: LatLng) {
  return {
    waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } },
  };
}

/** `"1234s"` → `1234`. The Routes API serialises every duration this way. */
function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Turns a failed HTTP response into a `RoutingFailure`, logging the body so the
 * exact Google error (which never reaches the UI) is in the server log.
 */
async function classifyHttp(
  endpoint: string,
  response: Response,
): Promise<RoutingFailure> {
  const body = await response.text().catch(() => "");
  console.error(
    `[routing] ${endpoint} → ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
  );
  if (response.status === 429) return "quota";
  if (response.status === 403 || response.status === 401) return "denied";
  if (response.status === 400) return "invalid_request";
  return "bad_response";
}

/* --- single leg (live ETA) ------------------------------------------------- */

/**
 * One origin → one destination, optionally traffic-aware.
 *
 * This is the call behind a truck's ETA to its next stop. `trafficAware` uses
 * live conditions and departs "now"; leave it off for anything that is not a
 * live position (it costs more and the number is only meaningful right now).
 */
export async function routeLeg(
  from: LatLng,
  to: LatLng,
  { trafficAware = false }: { trafficAware?: boolean } = {},
): Promise<{ leg: RouteLeg | null; failure: RoutingFailure | null }> {
  const key = routingKey();
  if (!key) return { leg: null, failure: "not_configured" };

  const body: Record<string, unknown> = {
    origin: point(from),
    destination: point(to),
    travelMode: "DRIVE",
    routingPreference: trafficAware ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
    // Ferries are part of a real answer for this fleet (Dublin–Holyhead), so
    // they are allowed; nothing else is avoided.
    routeModifiers: { avoidFerries: false },
  };
  if (trafficAware) body.departureTime = new Date().toISOString();

  let response: Response;
  try {
    response = await fetch(ROUTE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { leg: null, failure: "network" };
  }

  if (!response.ok) {
    return { leg: null, failure: await classifyHttp("computeRoutes", response) };
  }

  let payload: { routes?: { distanceMeters?: number; duration?: string }[] };
  try {
    payload = await response.json();
  } catch {
    return { leg: null, failure: "bad_response" };
  }

  const route = payload.routes?.[0];
  const durationSeconds = parseDuration(route?.duration);
  const distanceMeters = route?.distanceMeters;
  if (typeof distanceMeters !== "number" || durationSeconds === null) {
    return { leg: null, failure: "no_route" };
  }

  return { leg: { distanceMeters, durationSeconds }, failure: null };
}

/* --- matrix (planning) --------------------------------------------------- */

interface MatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  distanceMeters?: number;
  duration?: string;
  condition?: string;
  status?: { code?: number };
}

/**
 * Full origins × destinations matrix of road legs.
 *
 * `matrix[i][j]` is the leg from `origins[i]` to `destinations[j]`, or `null`
 * where Google found no route (an island with no ferry, a bad coordinate).
 * Traffic is deliberately **not** considered — a plan is built minutes or
 * hours before the truck rolls, so "now" traffic would be noise, and
 * traffic-unaware requests get the far larger 625-element budget.
 *
 * Larger problems are tiled into blocks of at most `MAX_MATRIX_ELEMENTS`. The
 * blocks run sequentially: a day's orders is a handful of requests, and firing
 * them in parallel is how a working batch becomes a rate-limited partial one.
 */
export async function routeMatrix(
  origins: LatLng[],
  destinations: LatLng[],
): Promise<{
  matrix: (RouteLeg | null)[][];
  failure: RoutingFailure | null;
}> {
  const key = routingKey();
  if (!key) return { matrix: [], failure: "not_configured" };
  if (origins.length === 0 || destinations.length === 0) {
    return { matrix: origins.map(() => []), failure: null };
  }

  const matrix: (RouteLeg | null)[][] = origins.map(() =>
    destinations.map(() => null),
  );

  // How many origin rows we can send per request while staying under the
  // element cap for the full destination list.
  const rowsPerBlock = Math.max(
    1,
    Math.floor(MAX_MATRIX_ELEMENTS / destinations.length),
  );

  for (let start = 0; start < origins.length; start += rowsPerBlock) {
    const block = origins.slice(start, start + rowsPerBlock);

    let response: Response;
    try {
      response = await fetch(MATRIX_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "originIndex,destinationIndex,distanceMeters,duration,condition,status",
        },
        body: JSON.stringify({
          // computeRouteMatrix takes no top-level routeModifiers — that field
          // lives inside each origin. Ferries are allowed by default, which is
          // what this fleet wants, so nothing extra is needed.
          origins: block.map(point),
          destinations: destinations.map(point),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
        }),
        cache: "no-store",
      });
    } catch {
      return { matrix, failure: "network" };
    }

    if (!response.ok) {
      return { matrix, failure: await classifyHttp("computeRouteMatrix", response) };
    }

    let elements: MatrixElement[];
    try {
      elements = await response.json();
    } catch {
      return { matrix, failure: "bad_response" };
    }
    if (!Array.isArray(elements)) {
      return { matrix, failure: "bad_response" };
    }

    for (const el of elements) {
      // Elements come back in arbitrary order — trust the indices, not position.
      if (typeof el.originIndex !== "number" || typeof el.destinationIndex !== "number") {
        continue;
      }
      const i = start + el.originIndex;
      const j = el.destinationIndex;
      if (i >= origins.length || j >= destinations.length) continue;

      const duration = parseDuration(el.duration);
      if (
        el.condition === "ROUTE_EXISTS" &&
        typeof el.distanceMeters === "number" &&
        duration !== null &&
        (el.status?.code ?? 0) === 0
      ) {
        matrix[i][j] = {
          distanceMeters: el.distanceMeters,
          durationSeconds: duration,
        };
      }
    }
  }

  return { matrix, failure: null };
}

/**
 * Cheapest possible live check for an Integrations "test connection" button.
 *
 * There is no free endpoint on the Routes API, so this is a real 1×1 matrix
 * request — a fraction of a cent — between two points a few hundred metres
 * apart. It proves the key is enabled for Routes and not referrer-locked,
 * which is the whole question.
 */
export async function verifyRoutingConnection(): Promise<{
  ok: boolean;
  failure: RoutingFailure | null;
}> {
  const key = routingKey();
  if (!key) return { ok: false, failure: "not_configured" };
  const { failure } = await routeLeg(
    { lat: 53.3498, lng: -6.2603 },
    { lat: 53.3438, lng: -6.2546 },
  );
  return { ok: failure === null, failure };
}
