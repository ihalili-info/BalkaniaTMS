import "server-only";

/**
 * HERE Routing — road distance and drive time between points, on a truck.
 *
 * Server-only, same reasoning as the geocoder: this authorises billable calls
 * with `HERE_API_KEY`, and the key must never reach a browser.
 *
 * **What this replaces.** Everywhere else in the app, distance between two
 * points is `haversineMeters` — a straight line. That is fine for a rough
 * cluster but wrong for anything a dispatcher acts on: two drops either side of
 * an estuary are "adjacent" on a straight line and forty minutes apart on the
 * road, and Dublin → Holyhead is a sailing, not a drive. This module answers
 * with the road network and, for a single leg, live traffic.
 *
 * **What changed when this stopped being Google.** `transportMode=truck` with
 * the vehicle's real gross weight, height, length and ADR class — see
 * `lib/routing/vehicle.ts`. Google Routes had no HGV profile at all, so every
 * routed number in the app used to be a car's. These are not.
 *
 * That does **not** extend to the driver's phone. Waze, Google Maps and Apple
 * Maps all route cars, so `truckRoutingWarning()` in `lib/navigation-links.ts`
 * still applies at every point of handoff.
 *
 * **Failing soft.** Every function degrades to a `failure` code rather than
 * throwing, and every caller is expected to fall back to `haversineMeters`.
 * An unconfigured deployment, a spent quota or a network blip must never break
 * auto-plan or the load list — it just drops back to straight-line maths with
 * the UI saying so.
 *
 * Checked against the Routing v8 (`router.hereapi.com/v8/routes`) and Matrix
 * Routing v8 (`matrix.router.hereapi.com/v8/matrix`) references, September 2026.
 * Plain `fetch` — no runtime dependency.
 */

import { haversineMeters } from "@/lib/format";
import {
  DEFAULT_FLEET_VEHICLE,
  appendVehicleParams,
  type HereVehicle,
} from "@/lib/routing/vehicle";
import type { LatLng, RouteLeg } from "@/lib/types";

const ROUTE_ENDPOINT = "https://router.hereapi.com/v8/routes";
const MATRIX_ENDPOINT = "https://matrix.router.hereapi.com/v8/matrix";

/**
 * The margin `autoCircle` adds around the derived circle. HERE's default is
 * 10 km and its own guidance is that rural areas need the room — this fleet's
 * drops are frequently rural, so the default is kept rather than trimmed.
 */
const REGION_MARGIN_M = 10_000;

/**
 * HERE caps a *region-bounded* matrix at a 400 km diameter.
 *
 * The budget checked here is the span between the two furthest points, and the
 * margin is added to the circle's **radius** on both sides — so the region HERE
 * derives is `span + 2 × margin`. Checking the raw 400 km against the span
 * would put a 390 km group at a 410 km region and fail the request. The extra
 * 20 km below is slack for rounding and for the difference between our
 * great-circle span and HERE's own fit.
 */
const MAX_REGION_DIAMETER_M = 400_000 - 2 * REGION_MARGIN_M - 20_000;

/**
 * The profile used when a group is too spread out for a bounded region.
 *
 * A profile means predefined options: free-flow speeds, no dynamic traffic and
 * **no custom vehicle dimensions**. That is an acceptable trade here — the
 * matrix is traffic-unaware by design anyway, and the alternative for a
 * mainland-Europe group is no road routing at all.
 */
const WORLD_TRUCK_PROFILE = "truckFast";

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
    "HERE_API_KEY is not set — falling back to straight-line distance.",
  no_route: "HERE could not find a road route between these points.",
  quota: "HERE's routing quota or rate limit was hit. Falling back to straight-line distance.",
  denied:
    "HERE refused the routing request — the key is disabled, or is restricted to the wrong service or to specific domains. A server-side key must not be domain-restricted.",
  invalid_request:
    "HERE rejected the routing request as malformed (HTTP 400) — a bad coordinate or request body, not a key problem (that is a 401/403). The exact reason is in the server log.",
  network: "Could not reach HERE routing.",
  bad_response: "HERE routing returned something unparseable.",
};

export function routingConfigured(): boolean {
  return Boolean(routingKey());
}

function routingKey(): string | null {
  return process.env.HERE_API_KEY?.trim() || null;
}

export type { RouteLeg };

/** `53.3498,-6.2603` — how HERE takes a point in a query string. */
function coord(p: LatLng): string {
  return `${p.lat},${p.lng}`;
}

/**
 * Turns a failed HTTP response into a `RoutingFailure`, logging the body so the
 * exact HERE error (which never reaches the UI) is in the server log.
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

interface RouteSection {
  summary?: { length?: number; duration?: number; baseDuration?: number };
}

/**
 * One origin → one destination, optionally traffic-aware.
 *
 * This is the call behind a truck's ETA to its next stop. `trafficAware` uses
 * live conditions and departs "now"; leave it off for anything that is not a
 * live position, which sends `departureTime=any` and gets the time-independent
 * answer.
 *
 * `vehicle` defaults to the fleet's standard artic. Pass the actual truck
 * wherever one is known — that is what makes the number an HGV number.
 */
export async function routeLeg(
  from: LatLng,
  to: LatLng,
  {
    trafficAware = false,
    vehicle = DEFAULT_FLEET_VEHICLE,
  }: { trafficAware?: boolean; vehicle?: HereVehicle } = {},
): Promise<{ leg: RouteLeg | null; failure: RoutingFailure | null }> {
  const key = routingKey();
  if (!key) return { leg: null, failure: "not_configured" };

  const params = new URLSearchParams({
    transportMode: "truck",
    origin: coord(from),
    destination: coord(to),
    return: "summary",
    apiKey: key,
  });

  // `any` is HERE's explicit "ignore time and traffic". Omitting the parameter
  // entirely means "now", which is exactly what a live ETA wants.
  //
  // **The traffic-aware case deliberately sends no timestamp.** The Google
  // implementation this replaced sent `new Date().toISOString()`, and
  // production logged 1,801 rejections of it in eight days —
  // `400 Timestamp must be set to a future time` — because by the time the
  // request was processed, the clock value we generated was already in the
  // past. Every one of those silently degraded to a straight-line ETA, which
  // is the failure mode that looks like "routing just isn't configured". The
  // same deployment also logs `JWT issued at future` against Supabase, so
  // there is real clock skew here. Not sending a timestamp cannot be skewed.
  if (!trafficAware) params.set("departureTime", "any");
  // Ferries are part of a real answer for this fleet (Dublin–Holyhead), so
  // nothing is added to `avoid[features]`.
  appendVehicleParams(params, vehicle);

  let response: Response;
  try {
    response = await fetch(`${ROUTE_ENDPOINT}?${params}`, { cache: "no-store" });
  } catch {
    return { leg: null, failure: "network" };
  }

  if (!response.ok) {
    return { leg: null, failure: await classifyHttp("v8/routes", response) };
  }

  let payload: { routes?: { sections?: RouteSection[] }[] };
  try {
    payload = await response.json();
  } catch {
    return { leg: null, failure: "bad_response" };
  }

  const sections = payload.routes?.[0]?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    return { leg: null, failure: "no_route" };
  }

  // **Sum the sections — do not read `sections[0]`.** HERE splits a route at
  // every change of transport, so a sailing comes back as drive / ferry /
  // drive. Taking the first section would return the run to the port and call
  // it the journey to Birmingham.
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (const section of sections) {
    const length = section.summary?.length;
    const duration = section.summary?.duration;
    if (typeof length !== "number" || typeof duration !== "number") {
      return { leg: null, failure: "no_route" };
    }
    distanceMeters += length;
    durationSeconds += duration;
  }

  return {
    leg: { distanceMeters, durationSeconds: Math.round(durationSeconds) },
    failure: null,
  };
}

/* --- matrix (planning) --------------------------------------------------- */

interface MatrixResponse {
  matrix?: {
    numOrigins?: number;
    numDestinations?: number;
    distances?: number[];
    travelTimes?: number[];
    errorCodes?: number[];
  };
}

/**
 * The tightest region that covers every point, or null if they are too spread
 * out for a bounded request.
 *
 * HERE offers `autoCircle`, which derives the circle itself — but it will not
 * tell us in advance whether the result busts the 400 km cap, and a rejected
 * request is a wasted round trip. Measuring the span here means we can choose
 * the bounded (custom truck dimensions) or the world (generic profile) form
 * before spending the call.
 */
function fitsBoundedRegion(points: LatLng[]): boolean {
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (haversineMeters(points[i], points[j]) > MAX_REGION_DIAMETER_M) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Full origins × destinations matrix of road legs.
 *
 * `matrix[i][j]` is the leg from `origins[i]` to `destinations[j]`, or `null`
 * where HERE found no route (an island with no ferry, a bad coordinate).
 * Traffic is deliberately **not** considered — a plan is built minutes or hours
 * before the truck rolls, so "now" traffic would be noise.
 *
 * One synchronous request covers the whole matrix. Google's 625-element tiling
 * loop is gone: HERE's synchronous endpoint handles far more than an auto-plan
 * group (depot plus a dozen drops) ever asks for.
 *
 * **Two shapes, chosen by how far apart the points are.** Within 400 km the
 * request is region-bounded and carries the truck's real dimensions. Wider than
 * that, HERE requires the `world` region, which in turn requires a predefined
 * profile — a generic HGV at free-flow speed. Both are road routing on a truck;
 * only the second ignores the specific vehicle.
 */
export async function routeMatrix(
  origins: LatLng[],
  destinations: LatLng[],
  { vehicle = DEFAULT_FLEET_VEHICLE }: { vehicle?: HereVehicle } = {},
): Promise<{
  matrix: (RouteLeg | null)[][];
  failure: RoutingFailure | null;
}> {
  const key = routingKey();
  if (!key) return { matrix: [], failure: "not_configured" };
  if (origins.length === 0 || destinations.length === 0) {
    return { matrix: origins.map(() => []), failure: null };
  }

  const empty: (RouteLeg | null)[][] = origins.map(() =>
    destinations.map(() => null),
  );

  const bounded = fitsBoundedRegion([...origins, ...destinations]);

  const body: Record<string, unknown> = {
    origins: origins.map((p) => ({ lat: p.lat, lng: p.lng })),
    destinations: destinations.map((p) => ({ lat: p.lat, lng: p.lng })),
    // Distances are NOT returned by default — only travel times. Both are
    // needed: the planner sequences on time and reports distance.
    matrixAttributes: ["distances", "travelTimes"],
  };

  if (bounded) {
    body.regionDefinition = { type: "autoCircle", margin: REGION_MARGIN_M };
    body.transportMode = "truck";
    // `vehicle`, not `truck`. The `truck` object is deprecated, HERE refuses a
    // request carrying both, and the dimensions are the same centimetres and
    // kilograms the `/v8/routes` query parameters take.
    body.vehicle = {
      ...(vehicle.grossWeight !== undefined
        ? { grossWeight: vehicle.grossWeight }
        : {}),
      ...(vehicle.height !== undefined ? { height: vehicle.height } : {}),
      ...(vehicle.length !== undefined ? { length: vehicle.length } : {}),
      ...(vehicle.shippedHazardousGoods?.length
        ? { shippedHazardousGoods: vehicle.shippedHazardousGoods }
        : {}),
    };
  } else {
    // A profile forbids custom options, so the vehicle is dropped here rather
    // than sent and silently ignored.
    body.regionDefinition = { type: "world" };
    body.profile = WORLD_TRUCK_PROFILE;
  }

  let response: Response;
  try {
    response = await fetch(`${MATRIX_ENDPOINT}?async=false&apiKey=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { matrix: empty, failure: "network" };
  }

  if (!response.ok) {
    return { matrix: empty, failure: await classifyHttp("v8/matrix", response) };
  }

  let payload: MatrixResponse;
  try {
    payload = await response.json();
  } catch {
    return { matrix: empty, failure: "bad_response" };
  }

  const distances = payload.matrix?.distances;
  const travelTimes = payload.matrix?.travelTimes;
  const errorCodes = payload.matrix?.errorCodes;
  if (!Array.isArray(distances) || !Array.isArray(travelTimes)) {
    return { matrix: empty, failure: "bad_response" };
  }

  // Row-major and flat: entry (i, j) is at `i * numDestinations + j`. HERE
  // echoes the dimensions back; trust those over our own lengths in case a
  // request was clamped.
  const cols = payload.matrix?.numDestinations ?? destinations.length;
  const matrix: (RouteLeg | null)[][] = origins.map(() =>
    destinations.map(() => null),
  );

  for (let i = 0; i < origins.length; i += 1) {
    for (let j = 0; j < destinations.length; j += 1) {
      const k = i * cols + j;
      // `errorCodes` is omitted entirely when every pair routed.
      if (errorCodes && (errorCodes[k] ?? 0) !== 0) continue;
      const distanceMeters = distances[k];
      const durationSeconds = travelTimes[k];
      if (
        typeof distanceMeters !== "number" ||
        typeof durationSeconds !== "number"
      ) {
        continue;
      }
      matrix[i][j] = { distanceMeters, durationSeconds };
    }
  }

  return { matrix, failure: null };
}

/**
 * Cheapest possible live check for an Integrations "test connection" button.
 *
 * There is no free endpoint on HERE routing, so this is a real single-leg
 * request — one transaction — between two points a few hundred metres apart. It
 * proves the key is enabled for Routing and is not domain-locked, which is the
 * whole question.
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
