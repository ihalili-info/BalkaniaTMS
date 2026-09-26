import { selectInChunks } from "@/lib/data/in-chunks";
import { createClient } from "@/lib/supabase/server";

/**
 * What has gone wrong between the CRM and the TMS that a dispatcher can act on
 * — the CRM Errors page.
 *
 * This is deliberately **not** the Integrations diagnostics. That card is for
 * an admin working out whether the CRM connector is wired up (bad token, wrong
 * URL, malformed body). This is for the person at the board: *which orders
 * never reached us and what is missing on each*, which orders arrived but
 * cannot be put on a map, and which cancellations need doing by hand. Each item
 * names something to do; anything that is only "interesting" stays on the
 * admin card.
 *
 * Everything here is read through the caller's session and RLS — the
 * `crm_webhook_deliveries` policy already lets any authenticated user read the
 * log (migration 0015). The raw `payload` column is **never selected**: it
 * holds a customer's name, phone and address, and the reason plus the order
 * reference is all a dispatcher needs.
 */

/** How far back the log is read. Older failures are noise, not a to-do list. */
export const CRM_ERRORS_WINDOW_DAYS = 7;

/** PostgREST truncates at 1000 rows silently; stay under it and say so. */
const READ_LIMIT = 1000;

export interface CrmOrderIssue {
  /** The CRM's own order reference — what the dispatcher searches the CRM for. */
  ref: string;
  /** The endpoint's wording, unaltered. */
  reason: string;
  /** Plain-English version of `reason`. */
  what: string;
  lastSeen: string;
  /** How many times the CRM has pushed it in the window, all failing. */
  attempts: number;
}

export interface UnlocatedOrder {
  id: string;
  crm_order_id: string;
  customer_name: string;
  delivery_address: string;
  delivery_postcode: string | null;
  created_at: string;
}

export interface CrmErrors {
  windowDays: number;
  /** Pushes the CRM made that we refused, one row per order, still not in the TMS. */
  rejected: CrmOrderIssue[];
  /** The same, grouped by what is wrong — "14 orders have no delivery address". */
  rejectedByCause: { what: string; count: number }[];
  /** CRM cancellations we could not apply because the order is on a load. */
  cancellations: CrmOrderIssue[];
  /** Arrived, but the address would not geocode — cannot be routed or shown on a map. */
  unlocated: UnlocatedOrder[];
  unlocatedTotal: number;
  /** True when a read hit its row cap, so a list may be missing its oldest items. */
  truncated: boolean;
}

/* --- wording ------------------------------------------------------------------ */

/** CRM payload field → what a person calls it. */
const FIELD_LABEL: Record<string, string> = {
  address_line_1: "delivery address",
  address_line_2: "address line 2",
  delivery_postcode: "postcode / Eircode",
  delivery_country: "delivery country",
  delivery_city: "town / city",
  customer_name: "customer name",
  customer_phone: "customer phone",
  crm_order_id: "order reference",
};

/**
 * The endpoint's validation message, said the way a dispatcher would.
 *
 * `"address_line_1 is required"` → `"No delivery address on the order"`. Only
 * the shapes the importer actually produces are translated; anything else is
 * passed through unchanged rather than paraphrased into something wrong.
 */
export function describeRejection(reason: string): string {
  const required = /^([a-z0-9_]+) is required\b/i.exec(reason.trim());
  if (required) {
    const label =
      FIELD_LABEL[required[1]] ?? required[1].replace(/_/g, " ").toLowerCase();
    return `No ${label} on the order`;
  }
  return reason;
}

/* --- reads -------------------------------------------------------------------- */

export async function getCrmErrors(): Promise<CrmErrors> {
  const supabase = await createClient();
  const since = new Date(
    Date.now() - CRM_ERRORS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [rejectedLog, cancelLog, unlocated] = await Promise.all([
    supabase
      .from("crm_webhook_deliveries")
      .select("crm_order_id, reason, received_at")
      .eq("outcome", "rejected")
      .not("crm_order_id", "is", null)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(READ_LIMIT),
    supabase
      .from("crm_webhook_deliveries")
      .select("crm_order_id, reason, received_at")
      .eq("action", "cancel")
      .eq("outcome", "skipped")
      // The only skip a dispatcher has to act on: the CRM says this order is
      // cancelled, but it is already on a load, so only a person can undo it.
      // "Already delivered" and "no such order" are not to-dos.
      .ilike("reason", "on a load%")
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(READ_LIMIT),
    supabase
      .from("orders_geo")
      .select(
        "id, crm_order_id, customer_name, delivery_address, delivery_postcode, created_at",
        { count: "exact" },
      )
      .eq("status", "pending")
      .is("lat", null)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  for (const r of [rejectedLog, cancelLog, unlocated]) {
    if (r.error) throw new Error(`Could not load CRM errors: ${r.error.message}`);
  }

  /* --- rejected: latest per reference, minus anything that has since arrived */

  type LogRow = { crm_order_id: string; reason: string | null; received_at: string };
  const collapse = (rows: LogRow[]): CrmOrderIssue[] => {
    const byRef = new Map<string, CrmOrderIssue>();
    // Newest first, so the first row seen for a reference is its latest.
    for (const row of rows) {
      const seen = byRef.get(row.crm_order_id);
      if (seen) {
        seen.attempts += 1;
        continue;
      }
      const reason = row.reason ?? "failed validation";
      byRef.set(row.crm_order_id, {
        ref: row.crm_order_id,
        reason,
        what: describeRejection(reason),
        lastSeen: row.received_at,
        attempts: 1,
      });
    }
    return [...byRef.values()];
  };

  const rejectedAll = collapse((rejectedLog.data ?? []) as LogRow[]);

  // A rejection stops being a problem the moment the order exists — the CRM
  // fixed it and pushed again, or someone imported it by CSV. Without this the
  // list would keep every order that was ever rejected once.
  const arrived = await selectInChunks<{ crm_order_id: string }>(
    rejectedAll.map((i) => i.ref),
    (batch) =>
      supabase.from("orders").select("crm_order_id").in("crm_order_id", batch),
  );
  if (arrived.error) {
    throw new Error(`Could not load CRM errors: ${arrived.error.message}`);
  }
  const inTms = new Set((arrived.data ?? []).map((o) => o.crm_order_id));
  const rejected = rejectedAll.filter((i) => !inTms.has(i.ref));

  const causes = new Map<string, number>();
  for (const i of rejected) causes.set(i.what, (causes.get(i.what) ?? 0) + 1);

  return {
    windowDays: CRM_ERRORS_WINDOW_DAYS,
    rejected,
    rejectedByCause: [...causes.entries()]
      .map(([what, count]) => ({ what, count }))
      .sort((a, b) => b.count - a.count),
    cancellations: collapse((cancelLog.data ?? []) as LogRow[]),
    unlocated: (unlocated.data ?? []) as UnlocatedOrder[],
    unlocatedTotal: unlocated.count ?? unlocated.data?.length ?? 0,
    truncated:
      (rejectedLog.data?.length ?? 0) >= READ_LIMIT ||
      (cancelLog.data?.length ?? 0) >= READ_LIMIT,
  };
}
