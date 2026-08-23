import { timingSafeEqual } from "node:crypto";

import { createServiceClient } from "@/lib/supabase/service";
import {
  isNewerFix,
  normaliseGpsPush,
  type FleetmaticsGpsPush,
  type VehicleFix,
} from "@/lib/telematics/fleetmatics";

/**
 * Verizon Connect Reveal GPS webhook.
 *
 * Verizon POSTs each position here. The endpoint is registered through Reveal
 * (API integrations → SUBMIT ENDPOINTS → GPS webhook), which also takes the
 * Basic-auth username and password this route checks — they are ours to choose,
 * not issued by Verizon.
 *
 * Uses the service-role Supabase client because there is no user session on a
 * webhook. That client bypasses RLS, so this file must never grow a code path
 * that echoes arbitrary rows back to the caller.
 */

// Positions are written to the database on every request, so there is nothing
// to cache and nothing to prerender.
export const dynamic = "force-dynamic";

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    // Verizon uses Basic auth for the push; say so explicitly.
    headers: { "WWW-Authenticate": 'Basic realm="balkania-gps"' },
  });
}

/** Constant-time compare, so a wrong password cannot be found byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still burn a comparison so length is not a timing oracle.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function authorised(request: Request): boolean {
  const expectedUser = process.env.GPS_WEBHOOK_USER;
  const expectedPass = process.env.GPS_WEBHOOK_SECRET;
  // Refuse rather than accept when unconfigured — an open position endpoint is
  // worse than a broken one.
  if (!expectedUser || !expectedPass) return false;

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return safeEqual(user, expectedUser) && safeEqual(pass, expectedPass);
}

export async function POST(request: Request) {
  if (!authorised(request)) return unauthorized();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Verizon may batch. Accept either shape rather than guessing.
  const messages: FleetmaticsGpsPush[] = Array.isArray(payload)
    ? (payload as FleetmaticsGpsPush[])
    : [payload as FleetmaticsGpsPush];

  const accepted: VehicleFix[] = [];
  const rejected: { reason: string }[] = [];

  for (const message of messages) {
    const result = normaliseGpsPush(message);
    if (result.ok) accepted.push(result.fix);
    else rejected.push({ reason: result.reason });
  }

  if (accepted.length === 0) {
    // Nothing usable, but the delivery itself was fine — 200 so Verizon does
    // not retry a payload that will never parse.
    return Response.json(
      { stored: 0, rejected },
      { status: 200 },
    );
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    // 503 on purpose: the position is real and unstored, so Verizon should
    // retry rather than treat it as delivered.
    return Response.json(
      { error: "database not configured" },
      { status: 503 },
    );
  }

  const supabase = createServiceClient();
  let stored = 0;
  const skipped: string[] = [];

  for (const fix of accepted) {
    // `gps_device_id` holds Reveal's Vehicle Number.
    const { data: truck, error } = await supabase
      .from("trucks")
      .select("id, gps_sequence_id, location_updated_at")
      .eq("gps_device_id", fix.vehicleNumber)
      .maybeSingle();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!truck) {
      // A vehicle in Reveal that is not in our fleet is not an error — it is a
      // truck someone has not added yet.
      skipped.push(`${fix.vehicleNumber}: no matching truck`);
      continue;
    }

    // Deliveries retry, duplicate and arrive out of order. Without this a
    // truck occasionally jumps backwards on the live map.
    const isNewer = isNewerFix(fix, {
      sequenceId: truck.gps_sequence_id ?? null,
      recordedAt: truck.location_updated_at,
    });
    if (!isNewer) {
      skipped.push(`${fix.vehicleNumber}: stale or duplicate`);
      continue;
    }

    const { error: updateError } = await supabase
      .from("trucks")
      .update({
        // PostGIS expects lng, lat — in that order. Reversing them is the
        // single most common way to put a fleet in the sea.
        current_location: `SRID=4326;POINT(${fix.lng} ${fix.lat})`,
        location_updated_at: fix.recordedAt,
        gps_sequence_id: fix.sequenceId,
        last_known_address: fix.address,
      })
      .eq("id", truck.id);

    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 500 });
    }
    stored += 1;
  }

  return Response.json({ stored, skipped, rejected }, { status: 200 });
}

/** Reveal's endpoint form pings the URL; answer without touching the database. */
export async function GET() {
  return Response.json({ ok: true, provider: "verizon-connect-reveal" });
}
