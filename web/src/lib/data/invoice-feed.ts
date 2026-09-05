import { createClient } from "@/lib/supabase/server";

/** Diagnostic view of the invoice ingestion webhook (`/api/webhooks/invoices`). */

export interface InvoiceDelivery {
  id: string;
  received_at: string;
  crm_invoice_id: string | null;
  action: "upsert" | "void";
  outcome:
    | "created"
    | "updated"
    | "voided"
    | "skipped"
    | "rejected"
    | "unauthorized"
    | "bad_request";
  reason: string | null;
}

export interface InvoiceFeedHealth {
  /** Null when the endpoint has never been called at all. */
  lastDelivery: string | null;
  totals: Record<string, number>;
  recent: InvoiceDelivery[];
  invoicesTotal: number;
  /**
   * Invoices with no `order_id`. These are invisible to every driver — the
   * whole point of surfacing them here is that "the phone shows nothing" is
   * otherwise diagnosed as a bug in the app.
   */
  invoicesUnmatched: number;
  /** Invoices whose lines do not sum to the ERP's own total. */
  invoicesMismatched: number;
  /** Whether the connector toggle on the invoice card is on. */
  enabled: boolean;
  /** Plain-English next step, derived from what the log actually shows. */
  diagnosis: string;
}

export async function getInvoiceFeedHealth(
  enabled: boolean,
): Promise<InvoiceFeedHealth> {
  const supabase = await createClient();

  const [{ data: recent }, { data: invoices }] = await Promise.all([
    supabase
      .from("invoice_webhook_deliveries")
      .select("id, received_at, crm_invoice_id, action, outcome, reason")
      .order("received_at", { ascending: false })
      .limit(50),
    supabase
      .from("invoices")
      .select("id, order_id, totals_mismatch")
      .is("voided_at", null),
  ]);

  const rows = (recent ?? []) as InvoiceDelivery[];
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;

  const invoicesTotal = invoices?.length ?? 0;
  const invoicesUnmatched = (invoices ?? []).filter((i) => i.order_id === null).length;
  const invoicesMismatched = (invoices ?? []).filter((i) => i.totals_mismatch).length;

  const landed = (totals.created ?? 0) + (totals.updated ?? 0);

  let diagnosis: string;
  if (rows.length === 0) {
    diagnosis = enabled
      ? "The route is live but nothing has called it yet. Point the connector at https://tms.balkania.ie/api/webhooks/invoices with an Authorization: Bearer INVOICE_WEBHOOK_SECRET header."
      : "Nothing has called this endpoint, and the connector toggle below is off. Turn it on once the connector is deployed and pointed at /api/webhooks/invoices.";
  } else if ((totals.unauthorized ?? 0) > 0 && landed === 0) {
    diagnosis =
      "Calls are arriving with a Bearer token that does not match INVOICE_WEBHOOK_SECRET in Vercel. Note this is a different secret from the order feed — check you are not sending the CRM one.";
  } else if ((totals.bad_request ?? 0) > 0 && landed === 0) {
    diagnosis =
      'Calls are arriving but the body is not a recognised shape — see the reasons below. Expected { "invoices": [...] }, a bare array, or a single invoice object.';
  } else if ((totals.rejected ?? 0) > 0 && landed === 0) {
    diagnosis =
      "Invoices are arriving but every one fails validation — see the reasons below. A missing total, an unreadable amount or an invoice with no lines blocks it; a bad postcode or a missing email only warns.";
  } else if (invoicesUnmatched > 0) {
    diagnosis = `The feed is working, but ${invoicesUnmatched} invoice${
      invoicesUnmatched === 1 ? "" : "s"
    } could not be matched to an order and ${
      invoicesUnmatched === 1 ? "is" : "are"
    } invisible to drivers. Either the order has not arrived yet — they link themselves when it does — or the crm_order_id does not match what the order feed sent.`;
  } else if (landed > 0) {
    diagnosis = "The feed is working. Invoices are being stored and matched to their deliveries.";
  } else {
    diagnosis = "Calls are arriving but no invoices have been created or updated yet.";
  }

  return {
    lastDelivery: rows[0]?.received_at ?? null,
    totals,
    recent: rows.slice(0, 12),
    invoicesTotal,
    invoicesUnmatched,
    invoicesMismatched,
    enabled,
    diagnosis,
  };
}
