"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { CountryCode } from "@/lib/regions";
import type { LatLng, Order, Truck } from "@/lib/types";

/**
 * Writes.
 *
 * Server actions are public HTTP endpoints, so each one re-checks the session
 * rather than trusting that the page rendered for someone allowed to be there.
 * RLS is the backstop underneath: a caller who gets past these still has to
 * satisfy the policies in migration 0004.
 */

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
