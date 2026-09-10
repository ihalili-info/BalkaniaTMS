import "server-only";

/**
 * The shared cache of traffic-unaware routed legs (migration 0021).
 *
 * **Why this exists.** The auto-planner buys a road matrix per proposed group.
 * A group of eight drops plus the depot is 81 elements, and a 60-order
 * selection is around eight such groups — so opening the auto-plan dialog cost
 * roughly 650 HERE matrix elements before the dispatcher touched a control,
 * and it cost that again on the next refresh. The only thing holding those
 * legs was a module-level object in one browser tab.
 *
 * **Why there is no TTL.** `routeMatrix` is deliberately traffic-unaware — a
 * plan is built well before the truck rolls — so what is stored here is the
 * road distance and free-flow drive time between two fixed coordinates. That
 * is a property of the road network, not of the moment, and it does not drift
 * the way `routed_eta_cache` does. Correcting an address moves the coordinate
 * and therefore the key, so a fixed address never reads a stale leg.
 *
 * **Best-effort, in both directions.** Every function here swallows its own
 * errors. A cache miss costs a HERE call, which is the old behaviour; a failed
 * write costs the next plan a HERE call. Neither may break auto-plan.
 */

import { createClient } from "@/lib/supabase/server";
import { coordKey } from "@/lib/format";
import type { LatLng, RouteLeg } from "@/lib/types";

/**
 * How many distinct coordinates one read filters on.
 *
 * PostgREST puts `in` lists in the URL, so an unbounded one runs into
 * request-line limits. A full auto-plan selection is capped at
 * `GEOCODE_BATCH_LIMIT` orders plus the depot, well inside this.
 */
const MAX_KEYS = 400;

/**
 * Rows per page.
 *
 * The filter below is a cross-product, so 61 coordinates can match a few
 * thousand rows once the cache has filled up — comfortably past PostgREST's
 * default 1000-row ceiling. Hitting that ceiling would not give a *wrong*
 * answer, just a silently truncated one, and the missing legs would be re-
 * bought from HERE every single time. That is the exact failure this table
 * exists to stop, so the read pages rather than trusting one shot.
 */
const PAGE = 1000;

/** The cache key for one direction of one leg. */
export const legKey = (from: LatLng, to: LatLng) =>
  `${coordKey(from)}|${coordKey(to)}`;

export interface CachedLeg {
  fromKey: string;
  toKey: string;
  leg: RouteLeg;
}

/**
 * Legs already known for `profile`, keyed `"{fromKey}|{toKey}"`.
 *
 * Takes the pairs the caller actually wants rather than a bounding query,
 * because the planner asks about a handful of specific groups and a
 * `from_key IN (...) AND to_key IN (...)` cross-product would drag back every
 * combination between them.
 */
export async function readLegCache(
  pairs: { from: LatLng; to: LatLng }[],
  profile: string,
): Promise<Map<string, RouteLeg>> {
  const found = new Map<string, RouteLeg>();
  if (pairs.length === 0) return found;

  const fromKeys = new Set<string>();
  const toKeys = new Set<string>();
  const wanted = new Set<string>();
  for (const p of pairs) {
    const f = coordKey(p.from);
    const t = coordKey(p.to);
    fromKeys.add(f);
    toKeys.add(t);
    wanted.add(`${f}|${t}`);
  }

  try {
    const supabase = await createClient();
    const from = [...fromKeys].slice(0, MAX_KEYS);
    const to = [...toKeys].slice(0, MAX_KEYS);

    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("route_leg_cache")
        .select("from_key, to_key, distance_m, duration_s")
        .eq("profile", profile)
        // A cross-product, not a list of pairs — so this can return legs
        // nobody asked about. `wanted` drops them; the alternative is one
        // query per pair, which defeats the point.
        .in("from_key", from)
        .in("to_key", to)
        // A stable sort, so paging cannot skip or repeat a row.
        .order("from_key", { ascending: true })
        .order("to_key", { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (error) break;
      const rows = data ?? [];
      for (const row of rows) {
        const key = `${row.from_key}|${row.to_key}`;
        if (!wanted.has(key)) continue;
        found.set(key, {
          distanceMeters: Number(row.distance_m),
          durationSeconds: Number(row.duration_s),
        });
      }
      // A short page is the last one. Stop early once every pair asked about
      // is accounted for, which is the common case long before the rows run
      // out.
      if (rows.length < PAGE || found.size === wanted.size) break;
    }
  } catch {
    // See the module note: a miss is always safe.
  }

  return found;
}

/**
 * Saves freshly routed legs.
 *
 * `upsert` rather than insert: two dispatchers planning overlapping selections
 * at the same time will race on the same pair, and the second one losing the
 * whole batch would be a worse outcome than it overwriting an identical row.
 */
export async function writeLegCache(
  legs: CachedLeg[],
  profile: string,
): Promise<void> {
  if (legs.length === 0) return;

  try {
    const supabase = await createClient();
    await supabase.from("route_leg_cache").upsert(
      legs.map((l) => ({
        from_key: l.fromKey,
        to_key: l.toKey,
        profile,
        distance_m: l.leg.distanceMeters,
        duration_s: Math.round(l.leg.durationSeconds),
        computed_at: new Date().toISOString(),
      })),
      { onConflict: "from_key,to_key,profile" },
    );
  } catch {
    // Best-effort. The legs are already in the plan the dispatcher is looking
    // at; failing to save them costs the next plan a routing call, nothing
    // more.
  }
}
