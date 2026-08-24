import type { LoadView, Stop } from "./types";

/**
 * Pure selectors over already-fetched rows.
 *
 * Kept apart from `lib/data/fleet.ts` on purpose: that module imports the
 * server Supabase client, which imports `next/headers`, which cannot be
 * bundled into a client component. The live map is a client component and
 * needs these, so they live where both sides can reach them.
 */

/** Geofence radius. Matches the alert rule in the architecture doc. */
export const GEOFENCE_RADIUS_M = 5_000;

export function activeOf(loads: LoadView[]): LoadView[] {
  return loads.filter((l) => l.status === "active");
}

export function plannedOf(loads: LoadView[]): LoadView[] {
  return loads.filter((l) => l.status === "planned");
}

export function loadRefByOrderId(loads: LoadView[]): Record<string, string> {
  return Object.fromEntries(
    loads.flatMap((l) => l.stops.map((s) => [s.order_id, l.reference])),
  );
}

export function loadForTruck(
  loads: LoadView[],
  truckId: string,
): LoadView | undefined {
  return loads.find((l) => l.truck_id === truckId && l.status === "active");
}

export function loadForDriver(
  loads: LoadView[],
  driverId: string,
): LoadView | undefined {
  return loads.find((l) => l.driver_id === driverId && l.status !== "completed");
}

export function nextStop(load: LoadView): Stop | undefined {
  return load.stops.find((s) => s.delivered_at === null);
}

export function loadProgress(load: LoadView): { done: number; total: number } {
  return {
    done: load.stops.filter((s) => s.delivered_at !== null).length,
    total: load.stops.length,
  };
}

export function stopsInGeofence(loads: LoadView[]): Stop[] {
  return activeOf(loads).flatMap((l) =>
    l.stops.filter(
      (s) =>
        s.delivered_at === null &&
        s.distance_m !== null &&
        s.distance_m <= GEOFENCE_RADIUS_M,
    ),
  );
}
