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
