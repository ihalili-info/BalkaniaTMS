/**
 * A truck, expressed the way HERE's routing wants it.
 *
 * Pure — no I/O, no clock, no environment. It exists so the unit conversions
 * and the ADR mapping live in one place instead of being inlined at two call
 * sites with a chance of disagreeing.
 *
 * **This is the module that makes routed numbers HGV numbers.** Google Routes
 * had no truck profile at all, so every routed figure in the app used to be a
 * car's: it would happily send a 4.62 m trailer under a 4.0 m bridge and route
 * 44 tonnes down a 7.5 t-limited lane. HERE takes the dimensions and avoids
 * those roads.
 *
 * It still does not make the *driver's* navigation truck-legal.
 * `truckRoutingWarning()` in `lib/navigation-links.ts` covers that, and must
 * keep doing so: Waze, Google Maps and Apple Maps all route cars, whatever the
 * planner used.
 */

import type { Truck } from "@/lib/types";

/**
 * HERE's `vehicle[...]` group plus the hazardous-goods flag, already in the
 * provider's units.
 *
 * Height and length are **centimetres** — HERE's unit, not ours. Getting that
 * wrong is silent and expensive: a 4.62 m trailer sent as `462` is correct and
 * as `4.62` is a vehicle a hair under 5 cm tall, which passes under everything.
 */
export interface HereVehicle {
  /** Kilograms. */
  grossWeight?: number;
  /** Centimetres. */
  height?: number;
  /** Centimetres. */
  length?: number;
  /** HERE's hazardous-goods vocabulary, already mapped off ADR class. */
  shippedHazardousGoods?: string[];
}

/**
 * ADR class → HERE's `shippedHazardousGoods` value.
 *
 * ADR numbers classes 1–9 with lettered sub-divisions (4.1, 5.2, 6.1 …), so
 * only the leading digit is read. Class 4 (flammable solids) and class 9
 * (miscellaneous) have no distinct HERE term and fall to `other`, which still
 * makes the route hazmat-restricted — the safe direction to be wrong in.
 */
const ADR_TO_HAZARD: Record<string, string> = {
  "1": "explosive",
  "2": "gas",
  "3": "flammable",
  "5": "organic",
  "6": "poison",
  // Lower-case "a" — this is the spelling in HERE's OpenAPI enum. The docs
  // elsewhere write "radioActive"; that value is rejected.
  "7": "radioactive",
  "8": "corrosive",
};

export function hazardousGoodsFor(adrClasses: string[]): string[] {
  const mapped = new Set<string>();
  for (const raw of adrClasses) {
    const digit = raw.trim().charAt(0);
    if (digit === "") continue;
    mapped.add(ADR_TO_HAZARD[digit] ?? "other");
  }
  return [...mapped];
}

/** Metres → centimetres, rounded. Null in, undefined out — HERE omits absent. */
function cm(metres: number | null): number | undefined {
  if (metres === null || !Number.isFinite(metres) || metres <= 0) return undefined;
  return Math.round(metres * 100);
}

/**
 * The dimensions used when no specific truck is known.
 *
 * The auto-planner needs this: it groups and sequences orders *before* trucks
 * are assigned (assignment is longest-run-first, afterwards), so there is no
 * vehicle to read. These are a standard 3-axle tractor with a curtainsider at
 * the Irish/UK legal maximum — deliberately at the top of the fleet's range, so
 * a plan is built against the most restricted vehicle that might run it rather
 * than the least.
 *
 * No hazardous goods: a hazmat restriction on every route would distort every
 * plan, and ADR loads are the exception.
 */
export const DEFAULT_FLEET_VEHICLE: HereVehicle = {
  grossWeight: 44000,
  height: 465,
  length: 1650,
};

/**
 * A `Truck` row as HERE vehicle parameters.
 *
 * `capacity_kg` is deliberately not used — it is payload, and HERE wants the
 * regulated gross figure. That distinction is the same one Directive 96/53/EC
 * draws and `vehicleBreaches()` already relies on.
 *
 * Width, axle count and ADR tunnel category are omitted rather than guessed:
 * the `trucks` table does not carry them, and a wrong axle weight would send a
 * legal truck the long way round for no reason.
 */
export function vehicleForTruck(truck: Truck | null): HereVehicle {
  if (!truck) return DEFAULT_FLEET_VEHICLE;

  const hazards = hazardousGoodsFor(truck.adr_classes ?? []);

  return {
    grossWeight: truck.gross_weight_kg ?? DEFAULT_FLEET_VEHICLE.grossWeight,
    height: cm(truck.height_m) ?? DEFAULT_FLEET_VEHICLE.height,
    length: cm(truck.length_m) ?? DEFAULT_FLEET_VEHICLE.length,
    ...(hazards.length > 0 ? { shippedHazardousGoods: hazards } : {}),
  };
}

/**
 * The `vehicle[...]` query parameters for `/v8/routes`, appended in place.
 *
 * The matrix endpoint takes the same values as a nested JSON object instead,
 * which is why this is a separate step from building the vehicle itself.
 */
export function appendVehicleParams(
  params: URLSearchParams,
  vehicle: HereVehicle,
): void {
  if (vehicle.grossWeight !== undefined) {
    params.set("vehicle[grossWeight]", String(vehicle.grossWeight));
  }
  if (vehicle.height !== undefined) {
    params.set("vehicle[height]", String(vehicle.height));
  }
  if (vehicle.length !== undefined) {
    params.set("vehicle[length]", String(vehicle.length));
  }
  if (vehicle.shippedHazardousGoods?.length) {
    // Nested under `vehicle[...]` like the dimensions, not a top-level param.
    params.set(
      "vehicle[shippedHazardousGoods]",
      vehicle.shippedHazardousGoods.join(","),
    );
  }
}

/**
 * A stable identity for the vehicle a routed leg was computed for.
 *
 * Used as part of the `route_leg_cache` key (migration 0021). A cached leg is
 * only reusable for a vehicle that would have been routed the same way, and
 * the dimensions are exactly what decides that — a 4.65 m trailer and a 4.00 m
 * one get different answers at the same bridge.
 *
 * Sorted hazard classes, because `hazardousGoodsFor()` builds them from a Set
 * and two identical trucks must not key differently on iteration order.
 */
export function vehicleProfileKey(vehicle: HereVehicle): string {
  const hazards = [...(vehicle.shippedHazardousGoods ?? [])].sort().join("+");
  return [
    vehicle.grossWeight ?? "-",
    vehicle.height ?? "-",
    vehicle.length ?? "-",
    hazards === "" ? "-" : hazards,
  ].join(":");
}
