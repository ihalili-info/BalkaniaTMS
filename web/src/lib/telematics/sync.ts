"use server";

import { revalidatePath } from "next/cache";

import { requireAccess } from "@/lib/auth/guard";
import { createClient } from "@/lib/supabase/server";
import {
  fetchVehicles,
  readConfig,
  type RevealVehicle,
} from "./fleetmatics";

/**
 * Bringing the Reveal fleet into `trucks`.
 *
 * Two rules make this safe to run repeatedly:
 *
 *  · **Match on Vehicle Number**, stored in `trucks.gps_device_id`. That is
 *    the identifier the GPS webhook matches on, so a truck synced here is
 *    immediately addressable by an incoming fix.
 *  · **Never delete.** A vehicle removed in Reveal is not a truck that can be
 *    removed here — it may carry load history, notifications and driver
 *    messages. Vanished vehicles are reported, not acted on.
 *
 * Admin only: it reads provider credentials and writes fleet rows.
 */

export interface SyncPlanRow {
  vehicleNumber: string;
  plate: string;
  label: string | null;
  makeModel: string | null;
  action: "create" | "update" | "unchanged";
}

export interface SyncPlan {
  ok: boolean;
  message: string | null;
  rows: SyncPlanRow[];
  /** In our fleet but no longer in Reveal. Reported only. */
  missingFromReveal: string[];
  unusable: number;
  /** First raw record from Reveal, so the field mapping can be checked. */
  sample: Record<string, unknown> | null;
}

const EMPTY: SyncPlan = {
  ok: false,
  message: null,
  rows: [],
  missingFromReveal: [],
  unusable: 0,
  sample: null,
};

function plateFor(v: RevealVehicle): string {
  // Registration is the real plate; fall back to the name, then the number, so
  // a row always has something a dispatcher can recognise.
  return v.registration ?? v.name ?? v.vehicleNumber;
}

function makeModelFor(v: RevealVehicle): string | null {
  const parts = [v.make, v.model, v.year ? String(v.year) : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Fetches from Reveal and works out what a sync would do. Writes nothing. */
export async function planVehicleSync(): Promise<SyncPlan> {
  try {
    await requireAccess("/integration-settings");

    const config = readConfig();
    if (!config) {
      return {
        ...EMPTY,
        message:
          "Reveal is not fully configured. FLEETMATICS_APP_ID, FLEETMATICS_USERNAME and FLEETMATICS_PASSWORD are all required.",
      };
    }

    const { vehicles, unusable, sample } = await fetchVehicles(config);

    const supabase = await createClient();
    const { data: existing, error } = await supabase
      .from("trucks")
      .select("id, gps_device_id, license_plate, label, make_model");
    if (error) return { ...EMPTY, message: error.message };

    const byNumber = new Map(
      (existing ?? []).map((t) => [t.gps_device_id, t]),
    );
    const seen = new Set<string>();

    const rows: SyncPlanRow[] = vehicles.map((v) => {
      seen.add(v.vehicleNumber);
      const current = byNumber.get(v.vehicleNumber);
      const plate = plateFor(v);
      const makeModel = makeModelFor(v);

      if (!current) {
        return {
          vehicleNumber: v.vehicleNumber,
          plate,
          label: v.name,
          makeModel,
          action: "create",
        };
      }

      const changed =
        current.license_plate !== plate ||
        (current.label ?? null) !== (v.name ?? null) ||
        (current.make_model ?? null) !== makeModel;

      return {
        vehicleNumber: v.vehicleNumber,
        plate,
        label: v.name,
        makeModel,
        action: changed ? "update" : "unchanged",
      };
    });

    return {
      ok: true,
      message: null,
      rows,
      missingFromReveal: (existing ?? [])
        .map((t) => t.gps_device_id)
        .filter((n) => !seen.has(n)),
      unusable,
      sample,
    };
  } catch (e) {
    return { ...EMPTY, message: (e as Error).message };
  }
}

export interface SyncResult {
  ok: boolean;
  created: number;
  updated: number;
  message: string | null;
}

/** Applies the plan. Creates and updates only. */
export async function applyVehicleSync(): Promise<SyncResult> {
  try {
    await requireAccess("/integration-settings");

    const plan = await planVehicleSync();
    if (!plan.ok) {
      return { ok: false, created: 0, updated: 0, message: plan.message };
    }

    const supabase = await createClient();
    let created = 0;
    let updated = 0;

    for (const row of plan.rows) {
      if (row.action === "unchanged") continue;

      if (row.action === "create") {
        const { error } = await supabase.from("trucks").insert({
          license_plate: row.plate,
          gps_device_id: row.vehicleNumber,
          label: row.label,
          make_model: row.makeModel,
        });
        if (error) {
          return {
            ok: false,
            created,
            updated,
            message: `${row.vehicleNumber}: ${error.message}`,
          };
        }
        created += 1;
        continue;
      }

      // Only the fields Reveal owns. Capacity, equipment and availability are
      // dispatcher-owned and must survive a sync untouched.
      const { error } = await supabase
        .from("trucks")
        .update({
          license_plate: row.plate,
          label: row.label,
          make_model: row.makeModel,
        })
        .eq("gps_device_id", row.vehicleNumber);
      if (error) {
        return {
          ok: false,
          created,
          updated,
          message: `${row.vehicleNumber}: ${error.message}`,
        };
      }
      updated += 1;
    }

    revalidatePath("/fleet");
    revalidatePath("/live-fleet-map");
    return { ok: true, created, updated, message: null };
  } catch (e) {
    return { ok: false, created: 0, updated: 0, message: (e as Error).message };
  }
}
