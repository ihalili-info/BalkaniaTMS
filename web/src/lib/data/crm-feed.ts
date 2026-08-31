import { createClient } from "@/lib/supabase/server";

/** Diagnostic view of the CRM ingestion webhook (`/api/webhooks/crm`). */

export interface CrmDelivery {
  id: string;
  received_at: string;
  crm_order_id: string | null;
  action: "upsert" | "cancel";
  outcome:
    | "created"
    | "updated"
    | "cancelled"
    | "skipped"
    | "rejected"
    | "unauthorized"
    | "bad_request";
  reason: string | null;
}

export interface CrmFeedHealth {
  /** Null when the endpoint has never been called at all. */
  lastDelivery: string | null;
  totals: Record<string, number>;
  recent: CrmDelivery[];
  ordersTotal: number;
  ordersLocated: number;
  /** Pending orders with no coordinate — waiting on the Geocode action. */
  ordersAwaitingGeocode: number;
  /** Whether the connector toggle on the CRM card is on. */
  enabled: boolean;
  /** Plain-English next step, derived from what the log actually shows. */
  diagnosis: string;
}

export async function getCrmFeedHealth(enabled: boolean): Promise<CrmFeedHealth> {
  const supabase = await createClient();

  const [{ data: recent }, { data: orders }] = await Promise.all([
    supabase
      .from("crm_webhook_deliveries")
      .select("id, received_at, crm_order_id, action, outcome, reason")
      .order("received_at", { ascending: false })
      .limit(50),
    supabase.from("orders_geo").select("id, status, lat"),
  ]);

  const rows = (recent ?? []) as CrmDelivery[];
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;

  const ordersTotal = orders?.length ?? 0;
  const ordersLocated = (orders ?? []).filter((o) => o.lat !== null).length;
  const ordersAwaitingGeocode = (orders ?? []).filter(
    (o) => o.lat === null && o.status === "pending",
  ).length;

  const landed = (totals.created ?? 0) + (totals.updated ?? 0);

  let diagnosis: string;
  if (rows.length === 0) {
    diagnosis = enabled
      ? "The route is live but nothing has called it yet. Point the CRM connector at https://tms.balkania.ie/api/webhooks/crm with an Authorization: Bearer CRM_WEBHOOK_SECRET header."
      : "Nothing has called this endpoint, and the connector toggle below is off. Turn it on once the CRM connector is deployed and pointed at /api/webhooks/crm.";
  } else if (
    (totals.unauthorized ?? 0) > 0 &&
    landed === 0 &&
    (totals.cancelled ?? 0) === 0
  ) {
    diagnosis =
      "Calls are arriving with a Bearer token that does not match CRM_WEBHOOK_SECRET in Vercel. Check the value against what the connector is sending, then redeploy.";
  } else if ((totals.bad_request ?? 0) > 0 && landed === 0) {
    diagnosis =
      'Calls are arriving but the body is not a recognised shape — see the reasons below. Expected { "orders": [...] }, a bare array, or a single order object.';
  } else if ((totals.rejected ?? 0) > 0 && landed === 0) {
    diagnosis =
      "Orders are arriving but every one fails validation — see the reasons below. A missing required field or an unknown country blocks the order; a bad postcode only warns.";
  } else if (ordersAwaitingGeocode > 0) {
    diagnosis = `The feed is working. ${ordersAwaitingGeocode} order${
      ordersAwaitingGeocode === 1 ? "" : "s"
    } landed without a coordinate and ${
      ordersAwaitingGeocode === 1 ? "is" : "are"
    } waiting on the Geocode action in the Orders Queue.`;
  } else if (landed > 0) {
    diagnosis = "The feed is working. Orders are being stored.";
  } else {
    diagnosis = "Calls are arriving but no orders have been created or updated yet.";
  }

  return {
    lastDelivery: rows[0]?.received_at ?? null,
    totals,
    recent: rows.slice(0, 12),
    ordersTotal,
    ordersLocated,
    ordersAwaitingGeocode,
    enabled,
    diagnosis,
  };
}
