import type { SupabaseClient } from "@supabase/supabase-js";

import type { LoadStatus } from "@/lib/types";

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

  const sync = await syncLoadCompletion(supabase, item.load_id);
  if (!sync.ok) {
    return { ok: false, message: sync.message, loadCompleted: false };
  }

  return {
    ok: true,
    message: null,
    loadCompleted: sync.changed && sync.status === "completed",
  };
}

export interface LoadCompletionResult {
  ok: boolean;
  message: string | null;
  /** The load's status after the call, or null if the load was gone. */
  status: LoadStatus | null;
  /** True when this call moved the load between `active` and `completed`. */
  changed: boolean;
  /**
   * True when the load *should* have reverted `completed` → `active` because a
   * stop is outstanding, but its truck or driver is already on another active
   * load (the clash `startLoad` refuses). The load is left `completed`.
   */
  reopenBlocked: boolean;
}

/**
 * Reconcile `loads.status` with whether every stop is delivered.
 *
 * The single place that decides "this load is finished" / "this load is not
 * finished any more". Idempotent, and safe to call from anywhere that changes
 * the delivered/undelivered set of a load's stops — a stop delivered
 * (`settleStopDelivered`), a stop un-delivered (`undeliverStop`), or a stop
 * added to / removed from the load (`updateLoad`):
 *
 *   every stop delivered, load `active`     → `completed`
 *   a stop outstanding, load `completed`    → `active`, unless the truck or
 *                                             driver is on another active load
 *
 * Nothing in Postgres derives this, so a load whose last write raced or whose
 * outstanding stop was edited away would otherwise sit in the wrong state
 * forever. Every write is guarded on the `status` it expects, so two concurrent
 * callers cannot double-apply.
 */
export async function syncLoadCompletion(
  supabase: SupabaseClient,
  loadId: string,
): Promise<LoadCompletionResult> {
  const { data: load, error: loadError } = await supabase
    .from("loads")
    .select("id, status, truck_id, driver_id")
    .eq("id", loadId)
    .maybeSingle();
  if (loadError) {
    return {
      ok: false,
      message: loadError.message,
      status: null,
      changed: false,
      reopenBlocked: false,
    };
  }
  if (!load) {
    return {
      ok: true,
      message: null,
      status: null,
      changed: false,
      reopenBlocked: false,
    };
  }

  const { data: items, error: itemsError } = await supabase
    .from("load_items")
    .select("delivered_at")
    .eq("load_id", loadId);
  if (itemsError) {
    return {
      ok: false,
      message: itemsError.message,
      status: load.status,
      changed: false,
      reopenBlocked: false,
    };
  }

  const rows = items ?? [];
  const allDelivered =
    rows.length > 0 && rows.every((s) => s.delivered_at !== null);

  if (allDelivered && load.status === "active") {
    const { data: updated, error } = await supabase
      .from("loads")
      .update({ status: "completed" })
      .eq("id", loadId)
      .eq("status", "active")
      .select("id");
    if (error) {
      return {
        ok: false,
        message: error.message,
        status: load.status,
        changed: false,
        reopenBlocked: false,
      };
    }
    const changed = (updated ?? []).length > 0;
    return {
      ok: true,
      message: null,
      status: changed ? "completed" : load.status,
      changed,
      reopenBlocked: false,
    };
  }

  if (!allDelivered && load.status === "completed") {
    // Don't reopen a load onto a truck or driver that is already running
    // another active load — the same clash `startLoad` refuses.
    let reopenBlocked = false;
    for (const [col, value] of [
      ["truck_id", load.truck_id],
      ["driver_id", load.driver_id],
    ] as const) {
      if (!value) continue;
      const { data: clash, error: clashError } = await supabase
        .from("loads")
        .select("id")
        .eq(col, value)
        .eq("status", "active")
        .neq("id", loadId)
        .limit(1);
      if (clashError) {
        return {
          ok: false,
          message: clashError.message,
          status: load.status,
          changed: false,
          reopenBlocked: false,
        };
      }
      if (clash && clash.length > 0) reopenBlocked = true;
    }
    if (reopenBlocked) {
      return {
        ok: true,
        message: null,
        status: "completed",
        changed: false,
        reopenBlocked: true,
      };
    }
    const { data: updated, error } = await supabase
      .from("loads")
      .update({ status: "active" })
      .eq("id", loadId)
      .eq("status", "completed")
      .select("id");
    if (error) {
      return {
        ok: false,
        message: error.message,
        status: load.status,
        changed: false,
        reopenBlocked: false,
      };
    }
    const changed = (updated ?? []).length > 0;
    return {
      ok: true,
      message: null,
      status: changed ? "active" : load.status,
      changed,
      reopenBlocked: false,
    };
  }

  return {
    ok: true,
    message: null,
    status: load.status,
    changed: false,
    reopenBlocked: false,
  };
}
