"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { CountryCode } from "@/lib/regions";
import type { LatLng, Order, Truck } from "@/lib/types";
import {
  GEOCODE_MESSAGE,
  geocodeAddress,
  geocodingConfigured,
} from "@/lib/geocoding/google";

/**
 * Writes.
 *
 * Server actions are public HTTP endpoints, so each one re-checks the session
 * rather than trusting that the page rendered for someone allowed to be there.
 * RLS is the backstop underneath: a caller who gets past these still has to
 * satisfy the policies in migration 0004.
 */

/**
 * How many addresses one call will resolve.
 *
 * Bounded by the server action's wall clock, not by Google's quota — each
 * lookup is a round trip, and an unbounded batch would time out mid-run with
 * some rows written and no report of which.
 */
const GEOCODE_BATCH_LIMIT = 60;

export interface WriteResult {
  ok: boolean;
  message: string | null;
}

async function requireSession() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in.");
  return user;
}

/* --- trucks ----------------------------------------------------------------- */

/** Fields a dispatcher owns. The telematics columns are deliberately absent. */
const TRUCK_FIELDS = [
  "label",
  "make_model",
  "capacity_kg",
  "capacity_m3",
  "pallet_slots",
  "features",
  "availability",
  "availability_note",
  "unavailable_until",
  "gross_weight_kg",
  "height_m",
  "length_m",
  "euro_emission_class",
  "adr_classes",
] as const;

export async function updateTruck(
  id: string,
  patch: Partial<Truck>,
): Promise<WriteResult> {
  try {
    await requireSession();
    const supabase = await createClient();

    // Allow-list. Without it a crafted call could set `current_location` or
    // `location_updated_at`, making a stale GPS fix look fresh on the map —
    // exactly the ownership split migration 0002 exists to protect.
    const update: Record<string, unknown> = {};
    for (const key of TRUCK_FIELDS) {
      if (key in patch) update[key] = patch[key];
    }
    if (Object.keys(update).length === 0) {
      return { ok: true, message: null };
    }
    update.details_updated_at = new Date().toISOString();

    const { error } = await supabase.from("trucks").update(update).eq("id", id);
    if (error) return { ok: false, message: error.message };

    revalidatePath("/fleet");
    revalidatePath("/live-fleet-map");
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* --- orders ------------------------------------------------------------------ */

export async function importOrders(orders: Order[]): Promise<WriteResult> {
  try {
    await requireSession();
    const supabase = await createClient();

    // `id` is left to the database default — the CSV path invents `imp-…`
    // placeholders that are not UUIDs.
    const rows = orders.map((o) => ({
      crm_order_id: o.crm_order_id,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      delivery_address: o.delivery_address,
      status: o.status,
      delivery_country: o.delivery_country,
      delivery_postcode: o.delivery_postcode,
      notifications_opt_out: o.notifications_opt_out,
      opted_out_at: o.opted_out_at,
    }));

    const { data, error } = await supabase
      .from("orders")
      .insert(rows)
      .select("id, crm_order_id");

    if (error) return { ok: false, message: error.message };

    // Coordinates go through the RPC, because PostgREST cannot write a
    // GEOGRAPHY column directly.
    const byRef = new Map((data ?? []).map((r) => [r.crm_order_id, r.id]));
    for (const o of orders) {
      const id = byRef.get(o.crm_order_id);
      if (!id || !o.delivery_location) continue;
      await supabase.rpc("set_order_location", {
        p_order_id: id,
        p_lat: o.delivery_location.lat,
        p_lng: o.delivery_location.lng,
      });
    }

    revalidatePath("/orders-queue");
    return { ok: true, message: `Imported ${rows.length} orders.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function fixOrderAddress(
  orderId: string,
  patch: {
    delivery_address: string;
    delivery_postcode: string | null;
    delivery_country: CountryCode;
    delivery_location: LatLng;
  },
): Promise<WriteResult> {
  try {
    await requireSession();
    const supabase = await createClient();

    const { error } = await supabase
      .from("orders")
      .update({
        delivery_address: patch.delivery_address,
        delivery_postcode: patch.delivery_postcode,
        delivery_country: patch.delivery_country,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    if (error) return { ok: false, message: error.message };

    const { error: geoError } = await supabase.rpc("set_order_location", {
      p_order_id: orderId,
      p_lat: patch.delivery_location.lat,
      p_lng: patch.delivery_location.lng,
    });
    if (geoError) return { ok: false, message: geoError.message };

    revalidatePath("/orders-queue");
    revalidatePath("/live-fleet-map");
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* --- drivers ----------------------------------------------------------------- */

export interface DriverInput {
  full_name: string;
  phone: string | null;
  home_country: CountryCode;
  tachograph_card_no: string | null;
  cpc_expires_on: string | null;
  driving_licence_no: string | null;
  /** The truck this driver normally runs. null = none. */
  assigned_truck_id: string | null;
}

/**
 * Fields a dispatcher owns.
 *
 * The Reg. 561/2006 duty counters are deliberately absent. They are written by
 * the tachograph sync and nothing else: a hand-typed "hours driven today" would
 * look identical to a real reading while carrying none of its authority, and
 * the tachograph is the legal record.
 */
function driverFields(input: DriverInput) {
  return {
    full_name: input.full_name.trim(),
    phone: input.phone?.trim() || null,
    home_country: input.home_country,
    tachograph_card_no: input.tachograph_card_no?.trim() || null,
    cpc_expires_on: input.cpc_expires_on || null,
    driving_licence_no: input.driving_licence_no?.trim() || null,
    // `assigned_at` is stamped by a trigger, not here — see migration 0011.
    // Doing it in the app would make an unchanged pairing look freshly set on
    // every unrelated edit.
    assigned_truck_id: input.assigned_truck_id || null,
  };
}

export async function createDriver(input: DriverInput): Promise<WriteResult> {
  try {
    await requireSession();
    if (input.full_name.trim() === "") {
      return { ok: false, message: "A driver needs a name." };
    }
    const supabase = await createClient();
    const { error } = await supabase.from("drivers").insert(driverFields(input));
    if (error) {
      // The tachograph card is UNIQUE — two drivers cannot share one, and the
      // duplicate is worth naming rather than showing a raw constraint error.
      return {
        ok: false,
        message: error.message.includes("tachograph_card_no")
          ? "That tachograph card number is already assigned to another driver."
          : error.message,
      };
    }
    revalidatePath("/fleet");
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function updateDriver(
  id: string,
  input: DriverInput,
): Promise<WriteResult> {
  try {
    await requireSession();
    if (input.full_name.trim() === "") {
      return { ok: false, message: "A driver needs a name." };
    }
    const supabase = await createClient();
    const { error } = await supabase
      .from("drivers")
      .update(driverFields(input))
      .eq("id", id);
    if (error) {
      return {
        ok: false,
        message: error.message.includes("tachograph_card_no")
          ? "That tachograph card number is already assigned to another driver."
          : error.message,
      };
    }
    revalidatePath("/fleet");
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* --- loads ------------------------------------------------------------------- */

export interface CreateLoadInput {
  truckId: string;
  driverId: string | null;
  /** Order ids in the sequence they are to be delivered. */
  orderIds: string[];
  cmrNumber: string | null;
}

/**
 * Creates a load from unassigned orders.
 *
 * Order matters literally: the array index becomes `stop_sequence`, which is
 * what the driver's route follows and what the geofence engine walks. It is
 * not a set.
 *
 * Orders move to `assigned` here, which is the first of the three points the
 * architecture doc says owns `orders.status` — the other two being the
 * dispatch alert and `delivered_at`.
 */
export async function createLoad(
  input: CreateLoadInput,
): Promise<WriteResult & { loadId: string | null }> {
  try {
    await requireSession();

    if (input.orderIds.length === 0) {
      return { ok: false, message: "Pick at least one order.", loadId: null };
    }

    const supabase = await createClient();

    // Refuse a truck the dispatcher has taken out of service. The UI filters
    // these out, but a stale page could still post one.
    const { data: truck, error: truckError } = await supabase
      .from("trucks")
      .select("id, license_plate, availability")
      .eq("id", input.truckId)
      .maybeSingle();

    if (truckError) return { ok: false, message: truckError.message, loadId: null };
    if (!truck) return { ok: false, message: "That truck no longer exists.", loadId: null };
    if (truck.availability !== "available") {
      return {
        ok: false,
        message: `${truck.license_plate} is marked ${truck.availability} and cannot be given work.`,
        loadId: null,
      };
    }

    // Guard against two dispatchers planning the same order into two loads.
    const { data: alreadyOn, error: clashError } = await supabase
      .from("load_items")
      .select("order_id")
      .in("order_id", input.orderIds);

    if (clashError) return { ok: false, message: clashError.message, loadId: null };
    if (alreadyOn && alreadyOn.length > 0) {
      return {
        ok: false,
        message: `${alreadyOn.length} of those orders are already on a load. Refresh and try again.`,
        loadId: null,
      };
    }

    const { data: load, error: loadError } = await supabase
      .from("loads")
      .insert({
        truck_id: input.truckId,
        driver_id: input.driverId,
        status: "planned",
        cmr_number: input.cmrNumber,
      })
      .select("id")
      .single();

    if (loadError || !load) {
      return { ok: false, message: loadError?.message ?? "Could not create the load.", loadId: null };
    }

    const { error: itemsError } = await supabase.from("load_items").insert(
      input.orderIds.map((orderId, index) => ({
        load_id: load.id,
        order_id: orderId,
        stop_sequence: index + 1,
      })),
    );

    if (itemsError) {
      // Roll back rather than leave a load with no stops on the board.
      await supabase.from("loads").delete().eq("id", load.id);
      return { ok: false, message: itemsError.message, loadId: null };
    }

    const { error: statusError } = await supabase
      .from("orders")
      .update({ status: "assigned", updated_at: new Date().toISOString() })
      .in("id", input.orderIds);

    if (statusError) {
      return { ok: false, message: statusError.message, loadId: load.id };
    }

    revalidatePath("/active-loads");
    revalidatePath("/orders-queue");
    revalidatePath("/live-fleet-map");
    return { ok: true, message: null, loadId: load.id };
  } catch (e) {
    return { ok: false, message: (e as Error).message, loadId: null };
  }
}

/** Moves a planned load onto the road. */
export async function startLoad(loadId: string): Promise<WriteResult> {
  try {
    await requireSession();
    const supabase = await createClient();

    const { error } = await supabase
      .from("loads")
      .update({ status: "active" })
      .eq("id", loadId);
    if (error) return { ok: false, message: error.message };

    // `en_route` is owned by the dispatch alert in the architecture doc, but
    // nothing sends those yet; setting it here keeps the board truthful and is
    // the line to revisit when the alert engine lands.
    const { data: items } = await supabase
      .from("load_items")
      .select("order_id")
      .eq("load_id", loadId);

    if (items && items.length > 0) {
      await supabase
        .from("orders")
        .update({ status: "en_route", updated_at: new Date().toISOString() })
        .in("id", items.map((i) => i.order_id));
    }

    revalidatePath("/active-loads");
    revalidatePath("/orders-queue");
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* --- editing and removing a load --------------------------------------------- */

export interface EditLoadInput {
  truckId: string;
  driverId: string | null;
  cmrNumber: string | null;
  /** Order ids in their new sequence. Delivered stops must all still be present. */
  orderIds: string[];
}

export async function updateLoad(
  loadId: string,
  input: EditLoadInput,
): Promise<WriteResult> {
  try {
    await requireSession();
    const supabase = await createClient();

    const { data: existing, error: readError } = await supabase
      .from("load_items")
      .select("id, order_id, delivered_at")
      .eq("load_id", loadId);
    if (readError) return { ok: false, message: readError.message };

    const delivered = (existing ?? []).filter((i) => i.delivered_at !== null);
    const keeping = new Set(input.orderIds);

    // A delivered stop is a record of something that happened. Dropping it
    // would erase the delivery and orphan its notification rows — the evidence
    // that a customer was told.
    const droppedDelivered = delivered.filter((i) => !keeping.has(i.order_id));
    if (droppedDelivered.length > 0) {
      return {
        ok: false,
        message: `${droppedDelivered.length} of those stops have already been delivered and cannot be removed.`,
      };
    }
    if (input.orderIds.length === 0) {
      return { ok: false, message: "A load needs at least one stop." };
    }

    // Orders being added must not already sit on another load.
    const currentOrderIds = new Set((existing ?? []).map((i) => i.order_id));
    const added = input.orderIds.filter((id) => !currentOrderIds.has(id));
    if (added.length > 0) {
      const { data: clash } = await supabase
        .from("load_items")
        .select("order_id")
        .in("order_id", added);
      if (clash && clash.length > 0) {
        return {
          ok: false,
          message: `${clash.length} of those orders are already on another load.`,
        };
      }
    }

    const { error: loadError } = await supabase
      .from("loads")
      .update({
        truck_id: input.truckId,
        driver_id: input.driverId,
        cmr_number: input.cmrNumber,
      })
      .eq("id", loadId);
    if (loadError) return { ok: false, message: loadError.message };

    // Removed stops: delete the item and put the order back in the queue.
    const removed = (existing ?? []).filter((i) => !keeping.has(i.order_id));
    if (removed.length > 0) {
      await supabase
        .from("load_items")
        .delete()
        .in("id", removed.map((i) => i.id));
      await supabase
        .from("orders")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .in("id", removed.map((i) => i.order_id));
    }

    // Resequence everything that remains, and insert anything new.
    const byOrder = new Map((existing ?? []).map((i) => [i.order_id, i]));
    for (const [index, orderId] of input.orderIds.entries()) {
      const item = byOrder.get(orderId);
      if (item) {
        await supabase
          .from("load_items")
          .update({ stop_sequence: index + 1 })
          .eq("id", item.id);
      } else {
        await supabase.from("load_items").insert({
          load_id: loadId,
          order_id: orderId,
          stop_sequence: index + 1,
        });
        await supabase
          .from("orders")
          .update({ status: "assigned", updated_at: new Date().toISOString() })
          .eq("id", orderId);
      }
    }

    revalidatePath("/active-loads");
    revalidatePath("/orders-queue");
    revalidatePath("/live-fleet-map");
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Removes a load and returns its orders to the queue.
 *
 * Refused once anything has actually happened on it. `load_items` cascades
 * from `loads`, and `notifications` cascades from `load_items`, so deleting a
 * load that has delivered stops or sent alerts would silently destroy the
 * record that a delivery was made and that a customer was told. That is
 * evidence, not clutter.
 */
export async function deleteLoad(loadId: string): Promise<WriteResult> {
  try {
    await requireSession();
    const supabase = await createClient();

    const { data: items, error } = await supabase
      .from("load_items")
      .select("id, order_id, delivered_at")
      .eq("load_id", loadId);
    if (error) return { ok: false, message: error.message };

    const delivered = (items ?? []).filter((i) => i.delivered_at !== null);
    if (delivered.length > 0) {
      return {
        ok: false,
        message: `This load has ${delivered.length} delivered stop${delivered.length === 1 ? "" : "s"}. Deleting it would erase that delivery history — complete the load instead.`,
      };
    }

    const stopIds = (items ?? []).map((i) => i.id);
    if (stopIds.length > 0) {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .in("load_item_id", stopIds);
      if ((count ?? 0) > 0) {
        return {
          ok: false,
          message: `${count} customer alert${count === 1 ? " has" : "s have"} already been sent for this load. Deleting it would destroy the record of those messages.`,
        };
      }
    }

    // Back to the queue, so the work is not lost with the plan.
    const orderIds = (items ?? []).map((i) => i.order_id);
    if (orderIds.length > 0) {
      await supabase
        .from("orders")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .in("id", orderIds);
    }

    const { error: deleteError } = await supabase
      .from("loads")
      .delete()
      .eq("id", loadId);
    if (deleteError) return { ok: false, message: deleteError.message };

    revalidatePath("/active-loads");
    revalidatePath("/orders-queue");
    revalidatePath("/live-fleet-map");
    return {
      ok: true,
      message: `Load deleted. ${orderIds.length} order${orderIds.length === 1 ? "" : "s"} returned to the queue.`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* --- deleting orders --------------------------------------------------------- */

export interface DeleteOrdersResult extends WriteResult {
  deleted: number;
  /** Orders left alone, with the reason, so nothing disappears silently. */
  blocked: { id: string; reason: string }[];
}

/**
 * Removes orders from the queue permanently.
 *
 * **The FK would happily do more than asked.** `load_items.order_id` is
 * `ON DELETE CASCADE`, and `notifications.load_item_id` cascades from *that* —
 * so a plain `DELETE FROM orders` takes the stop and every alert ever sent for
 * it with it. That is the record of a delivery having happened and of a
 * customer having been told about it, and it is not ours to erase as a side
 * effect of tidying a queue.
 *
 * So only an order that is **pending and on no load** is deletable. Anything
 * else comes back in `blocked` with the reason; the caller shows that before
 * asking for confirmation, so a partial delete is a stated outcome rather than
 * a surprise. Take the order off its load first if you really mean it — that
 * path already refuses to drop a delivered stop.
 */
export async function deleteOrders(ids: string[]): Promise<DeleteOrdersResult> {
  const empty = { deleted: 0, blocked: [] as { id: string; reason: string }[] };
  try {
    await requireSession();
    if (ids.length === 0) {
      return { ok: false, message: "Nothing selected.", ...empty };
    }

    const supabase = await createClient();

    const { data: orders, error: readError } = await supabase
      .from("orders")
      .select("id, crm_order_id, status")
      .in("id", ids);
    if (readError) return { ok: false, message: readError.message, ...empty };

    // One query rather than one per order: which of these are on a load at all.
    const { data: items, error: itemError } = await supabase
      .from("load_items")
      .select("order_id")
      .in("order_id", ids);
    if (itemError) return { ok: false, message: itemError.message, ...empty };

    const onALoad = new Set((items ?? []).map((i) => i.order_id as string));

    const blocked: { id: string; reason: string }[] = [];
    const deletable: string[] = [];

    for (const order of orders ?? []) {
      const label = order.crm_order_id ?? order.id;
      if (order.status === "delivered") {
        blocked.push({ id: label, reason: "already delivered" });
      } else if (onALoad.has(order.id)) {
        blocked.push({ id: label, reason: "on a load — remove it from the load first" });
      } else {
        deletable.push(order.id);
      }
    }

    if (deletable.length === 0) {
      return {
        ok: false,
        message: "Nothing here can be deleted.",
        deleted: 0,
        blocked,
      };
    }

    const { error } = await supabase.from("orders").delete().in("id", deletable);
    if (error) return { ok: false, message: error.message, deleted: 0, blocked };

    revalidatePath("/orders-queue");
    revalidatePath("/active-loads");

    return {
      ok: true,
      message:
        blocked.length === 0
          ? `${deletable.length} order${deletable.length === 1 ? "" : "s"} deleted.`
          : `${deletable.length} deleted, ${blocked.length} kept.`,
      deleted: deletable.length,
      blocked,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message, ...empty };
  }
}

/* --- geocoding --------------------------------------------------------------- */

export interface GeocodeLine {
  orderId: string;
  reference: string;
  outcome: "located" | "failed";
  detail: string;
}

export interface GeocodeBatchResult extends WriteResult {
  located: number;
  lines: GeocodeLine[];
}

/**
 * Resolves delivery addresses to coordinates.
 *
 * Capped and sequential. Google's per-second limit is generous but real, and a
 * server action has a wall-clock budget — firing eighty parallel requests is
 * the reliable way to turn a working batch into a partial one with no record
 * of where it stopped. One at a time, reported per row, is slower and always
 * legible.
 *
 * Coarse matches are **not** written. `lib/geocoding/google.ts` explains why at
 * length; the short version is that a town-centre coordinate is invisible once
 * stored and fires customer alerts from the wrong place.
 */
export async function geocodeOrders(ids: string[]): Promise<GeocodeBatchResult> {
  const empty = { located: 0, lines: [] as GeocodeLine[] };
  try {
    await requireSession();
    if (!geocodingConfigured()) {
      return { ok: false, message: GEOCODE_MESSAGE.not_configured, ...empty };
    }
    if (ids.length === 0) {
      return { ok: false, message: "Nothing selected.", ...empty };
    }

    const capped = ids.slice(0, GEOCODE_BATCH_LIMIT);
    const supabase = await createClient();

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, crm_order_id, delivery_address, delivery_postcode, delivery_country")
      .in("id", capped);
    if (error) return { ok: false, message: error.message, ...empty };

    const lines: GeocodeLine[] = [];
    let located = 0;

    for (const order of orders ?? []) {
      const result = await geocodeAddress(
        order.delivery_address,
        order.delivery_country,
        order.delivery_postcode,
      );

      if (!result.point) {
        lines.push({
          orderId: order.id,
          reference: order.crm_order_id,
          outcome: "failed",
          detail: GEOCODE_MESSAGE[result.failure ?? "no_result"],
        });
        continue;
      }

      const { error: writeError } = await supabase.rpc("set_order_location", {
        p_order_id: order.id,
        p_lat: result.point.lat,
        p_lng: result.point.lng,
      });

      if (writeError) {
        lines.push({
          orderId: order.id,
          reference: order.crm_order_id,
          outcome: "failed",
          detail: writeError.message,
        });
        continue;
      }

      located += 1;
      lines.push({
        orderId: order.id,
        reference: order.crm_order_id,
        outcome: "located",
        // The normalised address is shown back deliberately: a match that
        // silently landed on the wrong Station Road is only catchable by
        // reading what Google actually resolved to.
        detail: `${result.formatted ?? "matched"}${result.partial ? " · partial match — check it" : ""}`,
      });
    }

    revalidatePath("/orders-queue");
    revalidatePath("/live-fleet-map");

    return {
      ok: true,
      message:
        ids.length > capped.length
          ? `${located} of ${capped.length} located. ${ids.length - capped.length} were left for a second run — batches are capped at ${GEOCODE_BATCH_LIMIT}.`
          : null,
      located,
      lines,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message, ...empty };
  }
}

/* --- committing an auto-plan -------------------------------------------------- */

export interface CommitPlanResult extends WriteResult {
  created: number;
}

/**
 * Turns accepted proposals from the planner into real loads.
 *
 * Each one goes through `createLoad`, not a bulk insert, so an auto-planned
 * load is subject to exactly the same checks as one built by hand — the order
 * must still be unassigned, the truck must still exist. Nothing about being
 * machine-generated earns it a shortcut.
 *
 * Partial success is reported rather than rolled back: if the fourth load
 * fails because someone else grabbed an order thirty seconds ago, the three
 * that worked are real and undoing them would be the surprising outcome.
 */
export async function commitPlan(
  plan: { truckId: string; orderIds: string[]; cmrNumber: string | null }[],
): Promise<CommitPlanResult> {
  try {
    await requireSession();
    if (plan.length === 0) {
      return { ok: false, message: "Nothing to create.", created: 0 };
    }

    let created = 0;
    const failures: string[] = [];

    for (const proposal of plan) {
      const result = await createLoad({
        truckId: proposal.truckId,
        driverId: null,
        orderIds: proposal.orderIds,
        cmrNumber: proposal.cmrNumber,
      });
      if (result.ok) created += 1;
      else failures.push(result.message ?? "unknown error");
    }

    revalidatePath("/orders-queue");
    revalidatePath("/active-loads");

    return {
      ok: created > 0,
      created,
      message:
        failures.length === 0
          ? `${created} load${created === 1 ? "" : "s"} created as planned.`
          : `${created} created, ${failures.length} failed: ${failures[0]}`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message, created: 0 };
  }
}
