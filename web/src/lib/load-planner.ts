/**
 * Suggesting loads from a pile of orders.
 *
 * **What this is:** geographic grouping. It puts drops that are near each
 * other on the same truck and sequences them so the driver is not criss-
 * crossing the country, which is the tedious part of planning a day and the
 * part a computer is genuinely better at.
 *
 * **What this is not: route optimisation.** When no road geometry is supplied
 * every distance here is a great-circle line — it knows nothing about roads,
 * ferries, one-way systems, the M50 at eight in the morning, or that Dublin to
 * Holyhead is a sailing and not a drive. Pass a `geometry.leg` accessor
 * (Google Routes, via a server action) and sequencing, route length and the
 * quoted drive time switch to the road network; clustering stays geographic
 * because a cluster centroid is not a real place to route from. Either way the
 * output is a **proposal a dispatcher reviews**, never something that should
 * dispatch itself — road distances still assume a car, not a 4.6 m trailer.
 *
 * The honest framing matters because the failure mode is quiet: a plausible-
 * looking route that costs an extra two hours does not announce itself.
 *
 * Everything below is pure. No I/O, no clock, no Supabase — so it can be
 * reasoned about and tested, and so the caller decides what to persist.
 */

import { haversineMeters } from "./format";
import { customsRegime, type CountryCode, type CustomsRegime } from "./regions";
import type { LatLng, Order, RouteLeg, Truck } from "./types";

/**
 * Road geometry, injected by the caller.
 *
 * `leg(from, to)` returns the road distance and drive time between two located
 * points, or `null` to fall back to a straight line for that pair (unknown
 * pair, no route, provider unconfigured). The planner never calls a network —
 * the caller resolves a matrix once and hands in a pure lookup.
 */
export interface PlannerGeometry {
  leg?: (from: LatLng, to: LatLng) => RouteLeg | null;
}

export interface PlannerOptions {
  /**
   * How far apart two drops may be and still share a truck, measured from the
   * running centre of the cluster.
   */
  maxRadiusKm: number;
  /** Hard cap on drops per load. */
  maxStops: number;
  /**
   * Keep each customs regime on its own load.
   *
   * On by default, and it is not fussiness: a GB export needs declarations and
   * a CMR covering the whole consignment, and a Northern Ireland movement is a
   * different territory again under the Windsor Framework. Mixing them means
   * one truck carrying two paperwork regimes, which is how a driver ends up
   * stopped at a port.
   */
  separateCustomsRegimes: boolean;
}

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  maxRadiusKm: 25,
  maxStops: 8,
  separateCustomsRegimes: true,
};

export interface ProposedLoad {
  /** Orders in the sequence the driver should run them. */
  stops: Order[];
  /** Suggested truck, or null when there are not enough to go round. */
  truck: Truck | null;
  regime: CustomsRegime;
  countries: CountryCode[];
  /** Centre of the drops — what the cluster was grown around. */
  centre: LatLng;
  /**
   * Depot → stops → depot, in metres. Road distance when `geometry.leg`
   * covered every leg; otherwise straight-line. See the caveat above.
   */
  routeMeters: number;
  /**
   * Depot → stops → depot drive time, in seconds, when road geometry covered
   * **every** leg of this run. `null` the moment one leg fell back to a
   * straight line — a mix of real and guessed minutes is worse than no figure.
   */
  routeSeconds: number | null;
  /** Furthest any drop sits from the cluster centre, in metres. */
  spreadMeters: number;
}

export type SkipReason =
  | "no_coordinates"
  | "not_pending"
  | "already_on_load";

export interface SkippedOrder {
  order: Order;
  reason: SkipReason;
}

export interface PlanResult {
  loads: ProposedLoad[];
  skipped: SkippedOrder[];
  /** Loads with no truck available, counted separately — the plan still holds. */
  unTrucked: number;
}

export const SKIP_MESSAGE: Record<SkipReason, string> = {
  no_coordinates:
    "no coordinates — geocode it first, or place it by hand with Fix address",
  not_pending: "not pending",
  already_on_load: "already on a load",
};

/* --- geometry --------------------------------------------------------------- */

function centroid(points: LatLng[]): LatLng {
  // Fine at this scale. A spherical mean would matter near the poles or across
  // the antimeridian; a fleet working Ireland to central Europe is neither.
  const lat = points.reduce((n, p) => n + p.lat, 0) / points.length;
  const lng = points.reduce((n, p) => n + p.lng, 0) / points.length;
  return { lat, lng };
}

/** Orders with a coordinate, narrowed so the rest of the file can rely on it. */
type Located = Order & { delivery_location: LatLng };

function isLocated(order: Order): order is Located {
  return order.delivery_location !== null;
}

/* --- geometry helpers ------------------------------------------------------ */

/** Road metres between two points, or the straight line where road is unknown. */
type Metres = (a: LatLng, b: LatLng) => number;

function metresFrom(geometry: PlannerGeometry): Metres {
  const leg = geometry.leg;
  if (!leg) return haversineMeters;
  return (a, b) => leg(a, b)?.distanceMeters ?? haversineMeters(a, b);
}

/* --- sequencing ------------------------------------------------------------- */

/**
 * Nearest-neighbour from the depot.
 *
 * Not optimal — nearest-neighbour never is, and on a bad day it is 25% worse
 * than the best tour. It is chosen anyway because it is *explicable*: a
 * dispatcher can look at the sequence and see why each stop follows the last,
 * and can drag it around in the edit dialog if they disagree. An opaque
 * optimiser that produces a marginally shorter tour nobody trusts is worse
 * than a transparent one they will actually use.
 *
 * `metres` is road distance when geometry was supplied, so "nearest" means
 * nearest on the network, not as the crow flies.
 */
function sequence(stops: Located[], depot: LatLng, metres: Metres): Located[] {
  const remaining = [...stops];
  const ordered: Located[] = [];
  let cursor = depot;

  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = metres(cursor, remaining[i].delivery_location);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    const [next] = remaining.splice(best, 1);
    ordered.push(next);
    cursor = next.delivery_location;
  }

  return ordered;
}

/**
 * Depot → stops → depot. Metres always; seconds only when road geometry
 * covered every leg, so the drive-time quote is never a real/guessed mix.
 */
function routeStats(
  stops: Located[],
  depot: LatLng,
  geometry: PlannerGeometry,
): { meters: number; seconds: number | null } {
  const leg = geometry.leg;
  let meters = 0;
  let seconds = 0;
  let fullyRouted = leg !== undefined;
  let cursor = depot;

  const step = (from: LatLng, to: LatLng) => {
    const routed = leg?.(from, to) ?? null;
    if (routed) {
      meters += routed.distanceMeters;
      seconds += routed.durationSeconds;
    } else {
      meters += haversineMeters(from, to);
      fullyRouted = false;
    }
  };

  for (const stop of stops) {
    step(cursor, stop.delivery_location);
    cursor = stop.delivery_location;
  }
  // Back to the depot: a plan that ignores the return leg makes a far-flung
  // cluster look cheaper than it is.
  step(cursor, depot);

  return { meters: Math.round(meters), seconds: fullyRouted ? Math.round(seconds) : null };
}

/* --- clustering ------------------------------------------------------------- */

/**
 * Grows clusters outward-in.
 *
 * The seed is always the drop **furthest from the depot**, because the far
 * ones are what constrain a day. Seeding from the nearest instead tends to
 * fill the first truck with easy local drops and leave a scatter of remote
 * ones that cannot be combined with anything.
 */
function cluster(
  orders: Located[],
  depot: LatLng,
  options: PlannerOptions,
  metres: Metres,
): Located[][] {
  const remaining = [...orders].sort(
    (a, b) =>
      metres(depot, b.delivery_location) - metres(depot, a.delivery_location),
  );

  const radiusMeters = options.maxRadiusKm * 1000;
  const clusters: Located[][] = [];

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const group = [seed];
    let centre = seed.delivery_location;

    // Re-scan after every addition: the centre moves, so an order that was out
    // of range a moment ago can come into it. Cheap at the scale of one day's
    // orders, and it produces noticeably tighter groups than a single pass.
    let grew = true;
    while (grew && group.length < options.maxStops) {
      grew = false;
      let best = -1;
      let bestDistance = Infinity;

      for (let i = 0; i < remaining.length; i += 1) {
        const d = haversineMeters(centre, remaining[i].delivery_location);
        if (d <= radiusMeters && d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }

      if (best >= 0) {
        const [taken] = remaining.splice(best, 1);
        group.push(taken);
        centre = centroid(group.map((o) => o.delivery_location));
        grew = true;
      }
    }

    clusters.push(group);
  }

  return clusters;
}

/* --- the plan --------------------------------------------------------------- */

export function planLoads({
  orders,
  trucks,
  depot,
  originCountry,
  onLoadOrderIds,
  options = DEFAULT_PLANNER_OPTIONS,
  geometry = {},
}: {
  orders: Order[];
  /** Candidate trucks; only `available` ones are used. */
  trucks: Truck[];
  depot: LatLng;
  originCountry: CountryCode;
  /** Order ids already committed to a load, so they are never double-booked. */
  onLoadOrderIds: Set<string>;
  options?: PlannerOptions;
  /** Road distance/time lookup. Omit for straight-line planning. */
  geometry?: PlannerGeometry;
}): PlanResult {
  const metres = metresFrom(geometry);
  const skipped: SkippedOrder[] = [];
  const usable: Located[] = [];

  for (const order of orders) {
    if (onLoadOrderIds.has(order.id)) {
      skipped.push({ order, reason: "already_on_load" });
    } else if (order.status !== "pending") {
      skipped.push({ order, reason: "not_pending" });
    } else if (!isLocated(order)) {
      // Never guessed at. An order placed at the centre of its county would
      // cluster convincingly and send a driver to the wrong town.
      skipped.push({ order, reason: "no_coordinates" });
    } else {
      usable.push(order);
    }
  }

  // Split by paperwork before geography, not after: a cluster that straddles a
  // customs boundary cannot simply be cut in half afterwards without leaving
  // both halves badly shaped.
  const groups = new Map<string, Located[]>();
  for (const order of usable) {
    const regime = customsRegime(originCountry, order.delivery_country);
    const key = options.separateCustomsRegimes ? regime : "all";
    const bucket = groups.get(key);
    if (bucket) bucket.push(order);
    else groups.set(key, [order]);
  }

  const proposals: ProposedLoad[] = [];

  for (const group of groups.values()) {
    for (const members of cluster(group, depot, options, metres)) {
      const stops = sequence(members, depot, metres);
      const points = stops.map((s) => s.delivery_location);
      const centre = centroid(points);
      const countries = [...new Set(stops.map((s) => s.delivery_country))];

      // The regime of the load is the strictest one in it. With
      // `separateCustomsRegimes` on there is only ever one; with it off, this
      // is what stops a single GB drop being reported as a domestic run.
      const regime = countries
        .map((c) => customsRegime(originCountry, c))
        .sort()
        .at(-1) as CustomsRegime;

      const route = routeStats(stops, depot, geometry);

      proposals.push({
        stops,
        truck: null,
        regime,
        countries,
        centre,
        routeMeters: route.meters,
        routeSeconds: route.seconds,
        spreadMeters: Math.max(...points.map((p) => haversineMeters(centre, p))),
      });
    }
  }

  // Longest run first — the load that most needs a truck gets one.
  proposals.sort((a, b) => b.routeMeters - a.routeMeters);

  const pool = trucks.filter((t) => t.availability === "available");
  let unTrucked = 0;
  proposals.forEach((proposal, i) => {
    // No capacity check is possible: `orders` carries no weight or volume, so
    // there is nothing to compare `trucks.capacity_kg` against. Matching by
    // size here would be theatre. Assignment is order-of-need only, and the
    // dispatcher confirms the truck.
    if (i < pool.length) proposal.truck = pool[i];
    else unTrucked += 1;
  });

  return { loads: proposals, skipped, unTrucked };
}
