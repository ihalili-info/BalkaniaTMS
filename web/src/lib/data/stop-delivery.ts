import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stamp `delivered_at` on one stop and cascade the two dependent statuses.
 *
 * Shared by the manual "Mark delivered" action (`markStopDelivered` in
 * `mutations.ts`, RLS client) and the geofence webhook (service-role client)
 * so the two paths can never drift on what "delivered" means:
 *
 *   1. `load_items.delivered_at` = the given timestamp,
 *   2. `orders.status` → `delivered`,
 *   3. `loads.status` → `completed` once every stop on the load is delivered,
 *   4. any still-open `stop_visits` row for the stop is closed.
 *
 * The caller is responsible for checking the load is `active` and the stop is
 * not already delivered, and for any `revalidatePath` afterwards.
 */
export interface SettleResult {
  ok: boolean;
  message: string | null;
  /** True when this delivery was the last outstanding stop on the load. */
  loadCompleted: boolean;
}

export async function settleStopDelivered(
  supabase: SupabaseClient,
  item: { id: string; load_id: string; order_id: string },
  deliveredAt: string,
): Promise<SettleResult> {
  const { error: stopError } = await supabase
    .from("load_items")
    .update({ delivered_at: deliveredAt })
    .eq("id", item.id)
    .is("delivered_at", null);
  if (stopError) {
    return { ok: false, message: stopError.message, loadCompleted: false };
  }

  await supabase
    .from("orders")
    .update({ status: "delivered", updated_at: deliveredAt })
    .eq("id", item.order_id);

  // A truck sitting at the stop when it is delivered would otherwise leave an
  // open visit that never closes.
  await supabase
    .from("stop_visits")
    .update({ exited_at: deliveredAt })
    .eq("load_item_id", item.id)
    .is("exited_at", null);

  const { data: siblings, error: sibError } = await supabase
    .from("load_items")
    .select("delivered_at")
    .eq("load_id", item.load_id);
  if (sibError) {
    return { ok: false, message: sibError.message, loadCompleted: false };
  }

  const allDelivered =
    (siblings ?? []).length > 0 &&
    (siblings ?? []).every((s) => s.delivered_at !== null);
  if (allDelivered) {
    await supabase
      .from("loads")
      .update({ status: "completed" })
      .eq("id", item.load_id)
      .eq("status", "active");
  }

  return { ok: true, message: null, loadCompleted: allDelivered };
}
