/**
 * Turn-by-turn handoff to the driver's own navigation app.
 *
 * Three targets, and they are **not** equivalent — the differences are real and
 * the UI has to say so rather than offering three buttons that imply parity:
 *
 *   · Google Maps  — the only one with a documented multi-stop URL. Up to nine
 *                    intermediate waypoints via `waypoints=`.
 *   · Apple Maps   — one destination per link. Chaining with `+to:` is
 *                    undocumented and unreliable across iOS versions, so it is
 *                    not used here.
 *   · Waze         — one destination, full stop. No waypoint parameter exists.
 *
 * The bigger caveat is that all three are **car** navigators. None of them know
 * a 4.62 m trailer cannot pass under a 4.0 m bridge, and none apply HGV weight
 * or ADR restrictions. `truckRoutingWarning()` exists so that is stated at the
 * point of handoff, not discovered at a low bridge.
 */

import { country, type CountryCode } from "./regions";
import type { LatLng, Truck } from "./types";

export type NavApp = "google" | "waze" | "apple";

export interface NavTarget {
  id: NavApp;
  label: string;
  icon: string;
  /** Whether this app can take the whole remaining route, not just one stop. */
  multiStop: boolean;
  note: string;
}

export const NAV_TARGETS: Record<NavApp, NavTarget> = {
  google: {
    id: "google",
    label: "Google Maps",
    icon: "map",
    multiStop: true,
    note: "Takes the full remaining route, up to nine intermediate stops.",
  },
  waze: {
    id: "waze",
    label: "Waze",
    icon: "navigation",
    multiStop: false,
    note: "Next stop only — Waze has no multi-stop URL.",
  },
  apple: {
    id: "apple",
    label: "Apple Maps",
    icon: "explore",
    multiStop: false,
    note: "Next stop only. Chained destinations are unreliable across iOS versions.",
  },
};

/** Google caps `waypoints` at nine intermediate points. */
export const GOOGLE_MAX_WAYPOINTS = 9;

const coord = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

export interface RouteRequest {
  /** Current truck position. Omitted means "start from wherever I am". */
  origin?: LatLng | null;
  /** Stops in delivery order. The last is the destination. */
  stops: LatLng[];
}

/**
 * Builds the deep link for one app. Returns `null` when there is nothing to
 * navigate to, so callers never render a dead button.
 */
export function navigationUrl(app: NavApp, route: RouteRequest): string | null {
  const stops = route.stops.filter(Boolean);
  if (stops.length === 0) return null;

  if (app === "google") {
    const destination = stops[stops.length - 1];
    const waypoints = stops.slice(0, -1).slice(0, GOOGLE_MAX_WAYPOINTS);
    const params = new URLSearchParams({
      api: "1",
      destination: coord(destination),
      travelmode: "driving",
    });
    if (route.origin) params.set("origin", coord(route.origin));
    if (waypoints.length > 0) {
      params.set("waypoints", waypoints.map(coord).join("|"));
    }
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  // Waze and Apple take a single destination — deliberately the *next* stop,
  // not the last, because a driver navigating straight to the final drop would
  // skip everything in between.
  const next = stops[0];

  if (app === "waze") {
    return `https://waze.com/ul?ll=${coord(next)}&navigate=yes`;
  }

  const params = new URLSearchParams({ daddr: coord(next), dirflg: "d" });
  if (route.origin) params.set("saddr", coord(route.origin));
  return `https://maps.apple.com/?${params.toString()}`;
}

/** How many stops a given app will actually receive from this route. */
export function stopsCovered(app: NavApp, stopCount: number): number {
  if (stopCount === 0) return 0;
  if (app !== "google") return 1;
  return Math.min(stopCount, GOOGLE_MAX_WAYPOINTS + 1);
}

/**
 * Why a consumer navigator may be unsafe for this vehicle.
 *
 * Checked against the destination countries, because the limits differ: a
 * 4.62 m trailer is normal in Ireland and over the limit in France.
 */
export function truckRoutingWarning(
  truck: Truck | null,
  destinations: CountryCode[],
): string | null {
  if (!truck) return null;

  const reasons: string[] = [];

  if (truck.height_m && truck.height_m > 4.0) {
    const tight = destinations
      .map(country)
      .filter((c) => truck.height_m! > c.maxHeightM)
      .map((c) => c.name);
    reasons.push(
      tight.length > 0
        ? `${truck.height_m.toFixed(2)} m high — over the limit in ${tight.join(", ")}`
        : `${truck.height_m.toFixed(2)} m high — watch low bridges`,
    );
  }

  if (truck.gross_weight_kg && truck.gross_weight_kg > 7_500) {
    reasons.push(
      `${(truck.gross_weight_kg / 1000).toFixed(0)} t gross — weight-restricted roads are not avoided`,
    );
  }

  if (truck.adr_classes.length > 0) {
    reasons.push(
      `ADR ${truck.adr_classes.join(", ")} — tunnel and hazmat restrictions are not applied`,
    );
  }

  if (reasons.length === 0) return null;

  return `These apps route for cars, not HGVs: ${reasons.join("; ")}. Check the route before departing.`;
}
