"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

import {
  fetchVehicleLocation,
  isNewerFix,
  normaliseGpsPush,
  readConfig,
  type FleetmaticsGpsPush,
} from "./fleetmatics";

/**
 * Manual position poll — the RAD fallback.
 *
 * The push webhook is the intended path. This exists because a webhook that is
 * submitted but not yet confirmed leaves the map blank with nothing a
 * dispatcher can do about it, and because "where is that truck right now" is a
 * question worth being able to force an answer to.
 *
 * Costs one HTTP call per truck: Verizon has no fleet-wide location endpoint.
 * They also ask for no more than one call per vehicle every 3–5 minutes, so
 * this is a button rather than a timer.
 */

export interface PollLine {
  plate: string;
  vehicleNumber: string;
  outcome: "updated" | "unchanged" | "failed";
  detail: string;
}

export interface PollResult {
  ok: boolean;
  message: string | null;
  updated: number;
  lines: PollLine[];
}

export async function syncGpsNow(): Promise<PollResult> {
  const empty: PollResult = { ok: false, message: null, updated: 0, lines: [] };

  const user = await getCurrentUser();
  if (!user) return { ...empty, message: "Not signed in." };

  const config = readConfig();
  if (!config) {
    return {
      ...empty,
      message:
        "Reveal is not fully configured — FLEETMATICS_APP_ID, FLEETMATICS_USERNAME and FLEETMATICS_PASSWORD are all required. The push webhook does not need them; this manual poll does.",
    };
  }

  const supabase = await createClient();
  const { data: trucks, error } = await supabase
    .from("trucks")
    .select("id, license_plate, gps_device_id, gps_sequence_id, location_updated_at");

  if (error) return { ...empty, message: error.message };
  if (!trucks || trucks.length === 0) {
    return { ...empty, message: "No trucks yet — sync the fleet from Reveal first." };
  }

  const lines: PollLine[] = [];
  let updated = 0;

  for (const truck of trucks) {
    const base = {
      plate: truck.license_plate,
      vehicleNumber: truck.gps_device_id,
    };

    try {
      const raw = await fetchVehicleLocation(config, truck.gps_device_id);

      // The RAD location response is close to the push payload but need not
      // echo the vehicle number, so it is supplied from what we asked for.
      const asPush = {
        ...(raw as FleetmaticsGpsPush),
        Vehicle: {
          ...((raw as FleetmaticsGpsPush).Vehicle ?? {}),
          Number: truck.gps_device_id,
        },
      };

      const result = normaliseGpsPush(asPush);
      if (!result.ok) {
        lines.push({ ...base, outcome: "failed", detail: result.reason });
        continue;
      }

      // Same guard as the webhook: never move a truck backwards.
      if (
        !isNewerFix(result.fix, {
          sequenceId: truck.gps_sequence_id ?? null,
          recordedAt: truck.location_updated_at,
        })
      ) {
        lines.push({
          ...base,
          outcome: "unchanged",
          detail: "no newer fix than the one already stored",
        });
        continue;
      }

      const { error: writeError } = await supabase
        .from("trucks")
        .update({
          // PostGIS takes lng, lat — in that order.
          current_location: `SRID=4326;POINT(${result.fix.lng} ${result.fix.lat})`,
          location_updated_at: result.fix.recordedAt,
          gps_sequence_id: result.fix.sequenceId,
          last_known_address: result.fix.address,
        })
        .eq("id", truck.id);

      if (writeError) {
        lines.push({ ...base, outcome: "failed", detail: writeError.message });
        continue;
      }

      updated += 1;
      lines.push({
        ...base,
        outcome: "updated",
        detail: result.fix.address ?? `${result.fix.lat}, ${result.fix.lng}`,
      });
    } catch (e) {
      lines.push({ ...base, outcome: "failed", detail: (e as Error).message });
    }
  }

  revalidatePath("/active-loads");
  revalidatePath("/live-fleet-map");
  revalidatePath("/fleet");

  return { ok: true, message: null, updated, lines };
}
