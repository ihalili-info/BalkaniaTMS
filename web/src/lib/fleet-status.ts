/**
 * Truck status derivation. Pure functions over row data — no fixtures — so
 * these keep working unchanged once the rows come from Supabase.
 */

import type { Truck, TruckDuty, TruckSignal } from "./types";

/** A fix older than this is shown as stale rather than live. */
export const STALE_FIX_MINUTES = 15;

export function truckSignal(truck: Truck, now: Date): TruckSignal {
  if (truck.current_location === null) return "no_fix";
  const ageMin =
    (now.getTime() - new Date(truck.location_updated_at).getTime()) / 60_000;
  return ageMin <= STALE_FIX_MINUTES ? "live" : "stale";
}

/**
 * `hasActiveLoad` is passed in rather than looked up: duty is a join between
 * `trucks.availability` and `loads`, and the caller already has the loads.
 */
export function truckDuty(truck: Truck, hasActiveLoad: boolean): TruckDuty {
  if (truck.availability === "maintenance") return "maintenance";
  if (truck.availability === "unavailable") return "unavailable";
  return hasActiveLoad ? "on_load" : "available";
}

/**
 * Whether the load planner may offer this truck. Being on a load is not a
 * blocker in itself — a dispatcher can queue the next run — but an explicit
 * unavailable/maintenance flag is.
 */
export function canAcceptLoad(truck: Truck): boolean {
  return truck.availability === "available";
}

/** Human summary of why a truck is out, for tooltips and list rows. */
export function unavailabilityReason(truck: Truck): string | null {
  if (truck.availability === "available") return null;
  const base =
    truck.availability === "maintenance" ? "In maintenance" : "Unavailable";
  return truck.availability_note ? `${base} — ${truck.availability_note}` : base;
}
