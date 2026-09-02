import { timingSafeEqual } from "node:crypto";

import { revalidatePath } from "next/cache";

import { createServiceClient } from "@/lib/supabase/service";
import {
  cacheSourceForPrecision,
  geocodeCacheKey,
  isStrongCacheHit,
  lookupGeocodeCache,
  saveGeocodeCache,
} from "@/lib/geocoding/cache";
import { geocodeAddress, geocodingConfigured } from "@/lib/geocoding/google";
import {
  firstError,
  readCrmBody,
  validateCrmOrders,
  type NormalisedCrmOrder,
  type ParsedCrmOrder,
} from "@/lib/crm/payload";
import type { LatLng } from "@/lib/types";

/**
 * CRM ingestion webhook.
 *
 * A processed order arrives here from the CRM connector (a standalone service
 * that talks to the CRM on one side and this endpoint on the other). The
 * contract — body shape, field rules, auth — lives in `lib/crm/payload.ts`.
 *
 * Uses the service-role Supabase client because there is no user session on a
 * webhook. That client bypasses RLS, so this file must never grow a code path
 * that echoes arbitrary rows back to the caller.
 *
 * Behaviour, mirroring the CSV importer it replaces:
 *   - new `crm_order_id`            → inserted as a pending order
 *   - existing, still pending       → updated in place
 *   - existing, on a load / dispatched → update skipped (won't rewrite a stop
 *                                        under a driver)
 *   - `"cancelled": true`           → the pending order is removed; refused once
 *                                     it is on a load or delivered
 *   - address resolves (supplied coords, geocode cache, or Google when
 *     configured) → coordinates stored; otherwise the order queues for the
 *     dispatcher's Geocode action, exactly as a failed CSV import row does.
 */

// Orders are written on every request — nothing to cache, nothing to prerender.
export const dynamic = "force-dynamic";

/**
 * How many *fresh* Google geocodes one request will run. The cache and any
 * supplied coordinates are free and uncapped; only live lookups count. A large
 * CRM backfill would otherwise blow the ack budget — the rest simply queue.
 */
const GEOCODE_BUDGET_PER_REQUEST = 20;

type Outcome =
  | "created"
  | "updated"
  | "cancelled"
  | "skipped"
  | "rejected"
  | "unauthorized"
  | "bad_request";

interface DeliveryRecord {
  crm_order_id: string | null;
  action: "upsert" | "cancel";
  outcome: Outcome;
  reason: string | null;
  payload?: unknown;
}

/**
 * Records what arrived, so "no orders yet" is diagnosable. Never allowed to
 * fail the request — a logging problem must not make the connector retry an
 * order that was actually stored.
 */
async function logDeliveries(rows: DeliveryRecord[]): Promise<void> {
  if (rows.length === 0) return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  try {
    const supabase = createServiceClient();
    await supabase.from("crm_webhook_deliveries").insert(
      rows.map((r) => ({
        crm_order_id: r.crm_order_id,
        action: r.action,
        outcome: r.outcome,
        reason: r.reason,
        // Only keep the payload when something went wrong — a stored order is
        // already in `orders`, and the payload carries customer personal data.
        payload:
          r.outcome === "created" ||
          r.outcome === "updated" ||
          r.outcome === "cancelled"
            ? null
            : (r.payload ?? null),
      })),
    );
  } catch {
    // Deliberately swallowed. See above.
  }
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="balkania-crm"' },
  });
}

/** Constant-time compare, so a wrong token cannot be found byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

export async function POST(request: Request) {
  const secret = process.env.CRM_WEBHOOK_SECRET;
  const token = bearerToken(request);

  // Refuse rather than accept when unconfigured — an open order-intake endpoint
  // is worse than a broken one.
  if (!secret || !token || !safeEqual(token, secret)) {
    // A request that carried a token but failed is a real mismatch worth
    // logging. A bare probe with no Authorization header is not.
    if (token) {
      await logDeliveries([
        {
          crm_order_id: null,
          action: "upsert",
          outcome: "unauthorized",
          reason: secret
            ? "Bearer token did not match CRM_WEBHOOK_SECRET"
            : "CRM_WEBHOOK_SECRET is not set on this deployment",
        },
      ]);
    }
    return unauthorized();
  }

  const raw = await request.text();
  let payload: unknown = null;
  try {
    payload = raw === "" ? null : JSON.parse(raw);
  } catch {
    payload = null;
  }

  const inputs = payload === null ? null : readCrmBody(payload);
  if (!inputs) {
    await logDeliveries([
      {
        crm_order_id: null,
        action: "upsert",
        outcome: "bad_request",
        reason:
          'Body was empty, not valid JSON, or not a recognised shape (expected { "orders": [...] }, a bare array, or one order object)',
      },
    ]);
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (inputs.length === 0) {
    return Response.json(
      { received: 0, created: 0, updated: 0, cancelled: 0, skipped: [], rejected: [] },
      { status: 200 },
    );
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    // 503 on purpose: the orders are real and unstored, so the connector should
    // retry rather than treat them as delivered.
    return Response.json({ error: "database not configured" }, { status: 503 });
  }

  const supabase = createServiceClient();
  const parsed = validateCrmOrders(inputs);

  const log: DeliveryRecord[] = [];
  const rejected: { crm_order_id: string | null; reason: string }[] = [];
  const skipped: { crm_order_id: string; reason: string }[] = [];
  let created = 0;
  let updated = 0;
  let cancelledCount = 0;
  let queuedForGeocoding = 0;

  // Everything that passed validation, by reference.
  const valid = parsed.filter((p): p is ParsedCrmOrder & { order: NormalisedCrmOrder } =>
    p.order !== null,
  );

  for (const p of parsed) {
    if (p.order === null) {
      const reason = firstError(p.issues) ?? "failed validation";
      rejected.push({ crm_order_id: p.crmOrderId, reason });
      log.push({
        crm_order_id: p.crmOrderId,
        action: p.raw.cancelled ? "cancel" : "upsert",
        outcome: "rejected",
        reason,
        payload: p.raw,
      });
    }
  }

  // One lookup for every reference in the batch.
  const refs = [...new Set(valid.map((p) => p.order.crmOrderId))];
  const { data: existingRows, error: lookupError } = await supabase
    .from("orders")
    .select("id, crm_order_id, status, delivery_address, delivery_postcode, delivery_country")
    .in("crm_order_id", refs);
  if (lookupError) {
    await logDeliveries(log);
    return Response.json({ error: lookupError.message }, { status: 500 });
  }

  const existingByRef = new Map((existingRows ?? []).map((r) => [r.crm_order_id, r]));
  const existingIds = (existingRows ?? []).map((r) => r.id);

  let onLoad = new Set<string>();
  if (existingIds.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .from("load_items")
      .select("order_id")
      .in("order_id", existingIds);
    if (itemsError) {
      await logDeliveries(log);
      return Response.json({ error: itemsError.message }, { status: 500 });
    }
    onLoad = new Set((items ?? []).map((i) => i.order_id as string));
  }

  let geocodeBudget = GEOCODE_BUDGET_PER_REQUEST;

  /**
   * Resolves a delivery location without ever storing a coarse one. Supplied
   * coordinates win; then a strong cache hit; then a live geocode when one is
   * configured and the per-request budget allows; then a weak cache hit as a
   * last resort. `null` means the order queues for the dispatcher's Geocode
   * action — a wrong pin is worse than none.
   */
  async function resolveLocation(
    o: NormalisedCrmOrder,
  ): Promise<{ point: LatLng | null; note: string }> {
    if (o.location) return { point: o.location, note: "coordinates supplied" };

    const cached = await lookupGeocodeCache(
      supabase,
      o.deliveryCountry,
      o.deliveryPostcode,
      o.deliveryAddress,
    );
    if (cached && isStrongCacheHit(cached.source)) {
      return {
        point: cached.point,
        note: `saved ${cached.source === "manual" ? "manual fix" : "location"}`,
      };
    }

    if (geocodingConfigured() && geocodeBudget > 0) {
      geocodeBudget -= 1;
      const hit = await geocodeAddress(
        o.deliveryAddress,
        o.deliveryCountry,
        o.deliveryPostcode,
      );
      if (hit.point) {
        const source = cacheSourceForPrecision(hit.precision);
        if (source) {
          await saveGeocodeCache(supabase, {
            countryCode: o.deliveryCountry,
            postcode: o.deliveryPostcode,
            address: o.deliveryAddress,
            point: hit.point,
            source,
            formatted: hit.formatted,
          });
        }
        return {
          point: hit.point,
          note: hit.matchedBy === "eircode" ? "geocoded via Eircode" : "geocoded",
        };
      }
    }

    if (cached) return { point: cached.point, note: "saved approximate location" };
    return { point: null, note: "queued for geocoding" };
  }

  async function writeLocation(orderId: string, o: NormalisedCrmOrder): Promise<string> {
    const { point, note } = await resolveLocation(o);
    if (!point) {
      queuedForGeocoding += 1;
      return note;
    }
    await supabase.rpc("set_order_location", {
      p_order_id: orderId,
      p_lat: point.lat,
      p_lng: point.lng,
    });
    return note;
  }

  for (const { order: o, issues } of valid) {
    const existing = existingByRef.get(o.crmOrderId);
    const warnings = issues
      .filter((i) => i.severity === "warning")
      .map((i) => i.message);
    const warnSuffix = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";

    /* --- cancellation --- */
    if (o.cancelled) {
      if (!existing) {
        skipped.push({ crm_order_id: o.crmOrderId, reason: "no order with this reference" });
        log.push({
          crm_order_id: o.crmOrderId,
          action: "cancel",
          outcome: "skipped",
          reason: "no order with this reference",
        });
        continue;
      }
      if (onLoad.has(existing.id) || existing.status === "delivered") {
        const reason =
          existing.status === "delivered"
            ? "already delivered — cannot cancel"
            : "on a load — cancel it from the dispatch board";
        skipped.push({ crm_order_id: o.crmOrderId, reason });
        log.push({
          crm_order_id: o.crmOrderId,
          action: "cancel",
          outcome: "skipped",
          reason,
        });
        continue;
      }
      const { error } = await supabase.from("orders").delete().eq("id", existing.id);
      if (error) {
        await logDeliveries(log);
        return Response.json({ error: error.message }, { status: 500 });
      }
      cancelledCount += 1;
      log.push({
        crm_order_id: o.crmOrderId,
        action: "cancel",
        outcome: "cancelled",
        reason: null,
      });
      continue;
    }

    /* --- new order --- */
    if (!existing) {
      const { data: inserted, error } = await supabase
        .from("orders")
        .insert({
          crm_order_id: o.crmOrderId,
          customer_name: o.customerName,
          customer_phone: o.customerPhone,
          delivery_address: o.deliveryAddress,
          status: "pending",
          delivery_country: o.deliveryCountry,
          delivery_postcode: o.deliveryPostcode,
          promised_at: o.promisedAt,
          promised_window_end: o.promisedWindowEnd,
          notifications_opt_out: o.notificationsOptOut,
          opted_out_at: o.notificationsOptOut ? new Date().toISOString() : null,
          crm_vehicle: o.vehicle,
          delivery_city: o.city,
        })
        .select("id")
        .single();
      if (error || !inserted) {
        await logDeliveries(log);
        return Response.json(
          { error: error?.message ?? "insert failed" },
          { status: 500 },
        );
      }
      const note = await writeLocation(inserted.id, o);
      created += 1;
      log.push({
        crm_order_id: o.crmOrderId,
        action: "upsert",
        outcome: "created",
        reason: `${note}${warnSuffix}` || null,
      });
      continue;
    }

    /* --- existing order --- */
    if (onLoad.has(existing.id) || existing.status !== "pending") {
      const reason = onLoad.has(existing.id)
        ? "already on a load — update ignored, edit it from the dispatch board"
        : `already ${existing.status} — update ignored`;
      skipped.push({ crm_order_id: o.crmOrderId, reason });
      log.push({
        crm_order_id: o.crmOrderId,
        action: "upsert",
        outcome: "skipped",
        reason,
      });
      continue;
    }

    const { error } = await supabase
      .from("orders")
      .update({
        customer_name: o.customerName,
        customer_phone: o.customerPhone,
        delivery_address: o.deliveryAddress,
        delivery_country: o.deliveryCountry,
        delivery_postcode: o.deliveryPostcode,
        promised_at: o.promisedAt,
        promised_window_end: o.promisedWindowEnd,
        notifications_opt_out: o.notificationsOptOut,
        opted_out_at: o.notificationsOptOut
          ? new Date().toISOString()
          : null,
        crm_vehicle: o.vehicle,
        delivery_city: o.city,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) {
      await logDeliveries(log);
      return Response.json({ error: error.message }, { status: 500 });
    }

    // Re-resolve only when the address actually changed. If it changed and
    // nothing resolves, the old pin no longer describes this order — clear it
    // so the queue shows it as needing a location rather than showing a stale
    // one. An unchanged address keeps whatever coordinate it had (including a
    // manual fix).
    const addressChanged =
      addressKey(o.deliveryCountry, o.deliveryPostcode, o.deliveryAddress) !==
      addressKey(
        existing.delivery_country,
        existing.delivery_postcode,
        existing.delivery_address,
      );

    let note = "unchanged";
    if (o.location || addressChanged) {
      const { point } = await resolveLocation(o);
      if (point) {
        await supabase.rpc("set_order_location", {
          p_order_id: existing.id,
          p_lat: point.lat,
          p_lng: point.lng,
        });
        note = o.location ? "coordinates supplied" : "re-geocoded";
      } else if (addressChanged) {
        await supabase
          .from("orders")
          .update({ delivery_location: null })
          .eq("id", existing.id);
        queuedForGeocoding += 1;
        note = "address changed — queued for geocoding";
      }
    }

    updated += 1;
    log.push({
      crm_order_id: o.crmOrderId,
      action: "upsert",
      outcome: "updated",
      reason: `${note}${warnSuffix}` || null,
    });
  }

  await logDeliveries(log);

  if (created + updated + cancelledCount > 0) {
    revalidatePath("/orders-queue");
    revalidatePath("/live-fleet-map");
    revalidatePath("/");
  }

  return Response.json(
    {
      received: inputs.length,
      created,
      updated,
      cancelled: cancelledCount,
      queuedForGeocoding,
      skipped,
      rejected,
    },
    { status: 200 },
  );
}

/** A stable key for "is this the same address" — reuses the geocode-cache key
 *  where it can, falling back to a normalised string when there is no postcode. */
function addressKey(
  countryCode: string,
  postcode: string | null,
  address: string,
): string {
  return (
    geocodeCacheKey(countryCode, postcode, address) ??
    `${countryCode}|${(postcode ?? "").toUpperCase()}|${address.trim().toLowerCase().replace(/\s+/g, " ")}`
  );
}

/** The connector pings this after registering the endpoint. */
export async function GET() {
  return Response.json({ ok: true, endpoint: "crm-ingestion" });
}
