import type { SupabaseClient } from "@supabase/supabase-js";

import { haversineMeters } from "@/lib/format";
import { settleStopDelivered } from "@/lib/data/stop-delivery";
import {
  GEOFENCE_ARRIVAL_RADIUS_M,
  GEOFENCE_MIN_DWELL_SECONDS,
} from "@/lib/fleet-selectors";

export interface GeofenceOutcome {
  /** load_item ids whose `delivered_at` this fix stamped. */
  autoDelivered: string[];
  /** True when auto-delivering the last stop completed a load. */
  loadCompleted: boolean;
}

const EMPTY: GeofenceOutcome = { autoDelivered: [], loadCompleted: false };

/**
 * One GPS fix, evaluated against the truck's active load.
 *
 * Called from the webhook after a *newer* position has been stored. For each
 * undelivered stop it keeps the truck's `stop_visits` row (migration 0014):
 *
 *   inside the ring, no open visit   → open one
 *   inside the ring, open visit      → extend `last_seen_at` / `min_distance_m`
 *   outside the ring, open visit     → close it; and if the truck had dwelled
 *                                      at least `GEOFENCE_MIN_DWELL_SECONDS`,
 *                                      stamp `delivered_at` via
 *                                      `settleStopDelivered` (`auto_delivered`)
 *
 * "Arrived, stayed, left" is the delivery signal — a drive-past never dwells,
 * and a truck that parks at its final drop and never leaves the ring is left
 * for the dispatcher's manual button (documented).
 *
 * All side effects go through `supabase` (the service-role client on the
 * webhook path). Never throws: a geofence hiccup must not make Verizon retry a
 * fix that was already stored.
 */
export async function evaluateGeofence(
  supabase: SupabaseClient,
  fix: { truckId: string; lat: number; lng: number; at: string },
): Promise<GeofenceOutcome> {
  try {
    const { data: loadRows } = await supabase
      .from("loads")
      .select("id, load_items(id, order_id, delivered_at)")
      .eq("truck_id", fix.truckId)
      .eq("status", "active")
      .limit(1);

    const load = loadRows?.[0] as
      | { id: string; load_items: { id: string; order_id: string; delivered_at: string | null }[] }
      | undefined;
    if (!load) return EMPTY;

    const undelivered = (load.load_items ?? []).filter(
      (li) => li.delivered_at === null,
    );
    if (undelivered.length === 0) return EMPTY;

    const { data: locs } = await supabase
      .from("orders_geo")
      .select("id, lat, lng")
      .in(
        "id",
        undelivered.map((li) => li.order_id),
      );
    const locById = new Map(
      (locs ?? [])
        .filter((r) => r.lat !== null && r.lng !== null)
        .map((r) => [r.id, { lat: r.lat as number, lng: r.lng as number }]),
    );

    const { data: openVisits } = await supabase
      .from("stop_visits")
      .select("id, load_item_id, entered_at, last_seen_at, min_distance_m")
      .in(
        "load_item_id",
        undelivered.map((li) => li.id),
      )
      .is("exited_at", null);
    const openByItem = new Map(
      (openVisits ?? []).map((v) => [v.load_item_id, v]),
    );

    const here = { lat: fix.lat, lng: fix.lng };
    const outcome: GeofenceOutcome = { autoDelivered: [], loadCompleted: false };

    for (const li of undelivered) {
      const loc = locById.get(li.order_id);
      if (!loc) continue;

      const dist = haversineMeters(here, loc);
      const inside = dist <= GEOFENCE_ARRIVAL_RADIUS_M;
      const open = openByItem.get(li.id);

      if (inside && open) {
        await supabase
          .from("stop_visits")
          .update({
            last_seen_at: fix.at,
            min_distance_m: Math.min(Number(open.min_distance_m), dist),
          })
          .eq("id", open.id);
      } else if (inside && !open) {
        // The partial unique index stops a retried fix opening a second row.
        await supabase.from("stop_visits").insert({
          load_item_id: li.id,
          truck_id: fix.truckId,
          entered_at: fix.at,
          last_seen_at: fix.at,
          min_distance_m: dist,
        });
      } else if (!inside && open) {
        const dwellMs =
          new Date(open.last_seen_at).getTime() -
          new Date(open.entered_at).getTime();
        const auto = dwellMs >= GEOFENCE_MIN_DWELL_SECONDS * 1000;

        await supabase
          .from("stop_visits")
          .update({ exited_at: fix.at, auto_delivered: auto })
          .eq("id", open.id);

        if (auto) {
          const settled = await settleStopDelivered(
            supabase,
            { id: li.id, load_id: load.id, order_id: li.order_id },
            // Delivered when they were confirmed on site, not at the later fix
            // that revealed they had gone.
            open.last_seen_at,
          );
          if (settled.ok) {
            outcome.autoDelivered.push(li.id);
            if (settled.loadCompleted) outcome.loadCompleted = true;
          }
        }
      }
    }

    return outcome;
  } catch (e) {
    console.error("geofence evaluation failed", e);
    return EMPTY;
  }
}
