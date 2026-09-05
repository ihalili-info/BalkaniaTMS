import { timingSafeEqual } from "node:crypto";

import { revalidatePath } from "next/cache";

import { createServiceClient } from "@/lib/supabase/service";
import {
  firstError,
  readInvoiceBody,
  validateInvoices,
  type NormalisedInvoice,
  type ParsedInvoice,
} from "@/lib/invoices/payload";

/**
 * Invoice ingestion webhook.
 *
 * The sales invoice a driver presents at the door arrives here from the same
 * connector service that feeds `/api/webhooks/crm`. The contract — body shape,
 * field rules, auth — lives in `lib/invoices/payload.ts`.
 *
 * Uses the service-role Supabase client because there is no user session on a
 * webhook. That client bypasses RLS, so this file must never grow a code path
 * that echoes arbitrary rows back to the caller.
 *
 * Behaviour:
 *   - new `crm_invoice_id`      → inserted, with its lines and VAT summary
 *   - existing                  → replaced in place (header updated, lines and
 *                                 VAT totals deleted and re-inserted, because
 *                                 the ERP re-sends the whole document)
 *   - `"voided": true`          → marked `voided_at`, never deleted; an invoice
 *                                 is a six-year financial record and one may
 *                                 already have been signed for
 *   - `crm_order_id` matches an order → linked; otherwise the invoice lands
 *                                 unmatched and is re-resolved on a later push
 *
 * A separate secret from the order feed (`INVOICE_WEBHOOK_SECRET`) so the two
 * can be rotated independently.
 */

// Invoices are written on every request — nothing to cache, nothing to prerender.
export const dynamic = "force-dynamic";

type Outcome =
  | "created"
  | "updated"
  | "voided"
  | "skipped"
  | "rejected"
  | "unauthorized"
  | "bad_request";

interface DeliveryRecord {
  crm_invoice_id: string | null;
  action: "upsert" | "void";
  outcome: Outcome;
  reason: string | null;
  payload?: unknown;
}

/**
 * Records what arrived, so "no invoices yet" is diagnosable. Never allowed to
 * fail the request — a logging problem must not make the connector retry an
 * invoice that was actually stored.
 */
async function logDeliveries(rows: DeliveryRecord[]): Promise<void> {
  if (rows.length === 0) return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  try {
    const supabase = createServiceClient();
    await supabase.from("invoice_webhook_deliveries").insert(
      rows.map((r) => ({
        crm_invoice_id: r.crm_invoice_id,
        action: r.action,
        outcome: r.outcome,
        reason: r.reason,
        // Only keep the payload when something went wrong — a stored invoice is
        // already in `invoices`, and the payload carries customer personal data
        // and line-level pricing.
        payload:
          r.outcome === "created" || r.outcome === "updated" || r.outcome === "voided"
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
    headers: { "WWW-Authenticate": 'Bearer realm="balkania-invoices"' },
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

/** The header columns, shared by insert and update so they cannot drift. */
function headerRow(o: NormalisedInvoice, orderId: string | null) {
  return {
    crm_invoice_id: o.crmInvoiceId,
    invoice_no: o.invoiceNo,
    invoice_date: o.invoiceDate,
    crm_order_id: o.crmOrderId,
    order_id: orderId,
    customer_name: o.customerName,
    customer_account_no: o.customerAccountNo,
    customer_email: o.customerEmail,
    customer_phone: o.customerPhone,
    delivery_address: o.deliveryAddress,
    delivery_city: o.deliveryCity,
    delivery_postcode: o.deliveryPostcode,
    delivery_country: o.deliveryCountry,
    opening_time: o.openingTime,
    closing_time: o.closingTime,
    sales_rep: o.salesRep,
    previous_balance: o.previousBalance,
    current_balance: o.currentBalance,
    currency: o.currency,
    case_count: o.caseCount,
    piece_count: o.pieceCount,
    sub_total: o.subTotal,
    discount_total: o.discountTotal,
    vat_total: o.vatTotal,
    grand_total: o.grandTotal,
    totals_mismatch: o.totalsMismatch,
    payment_terms: o.paymentTerms,
    bank_details: o.bankDetails,
  };
}

export async function POST(request: Request) {
  const secret = process.env.INVOICE_WEBHOOK_SECRET;
  const token = bearerToken(request);

  // Refuse rather than accept when unconfigured — an open invoice-intake
  // endpoint is worse than a broken one.
  if (!secret || !token || !safeEqual(token, secret)) {
    // A request that carried a token but failed is a real mismatch worth
    // logging. A bare probe with no Authorization header is not.
    if (token) {
      await logDeliveries([
        {
          crm_invoice_id: null,
          action: "upsert",
          outcome: "unauthorized",
          reason: secret
            ? "Bearer token did not match INVOICE_WEBHOOK_SECRET"
            : "INVOICE_WEBHOOK_SECRET is not set on this deployment",
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

  const inputs = payload === null ? null : readInvoiceBody(payload);
  if (!inputs) {
    await logDeliveries([
      {
        crm_invoice_id: null,
        action: "upsert",
        outcome: "bad_request",
        reason:
          'Body was empty, not valid JSON, or not a recognised shape (expected { "invoices": [...] }, a bare array, or one invoice object)',
      },
    ]);
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (inputs.length === 0) {
    return Response.json(
      { received: 0, created: 0, updated: 0, voided: 0, skipped: [], rejected: [] },
      { status: 200 },
    );
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    // 503 on purpose: the invoices are real and unstored, so the connector
    // should retry rather than treat them as delivered.
    return Response.json({ error: "database not configured" }, { status: 503 });
  }

  const supabase = createServiceClient();
  const parsed = validateInvoices(inputs);

  const log: DeliveryRecord[] = [];
  const rejected: { crm_invoice_id: string | null; reason: string }[] = [];
  const skipped: { crm_invoice_id: string; reason: string }[] = [];
  let created = 0;
  let updated = 0;
  let voidedCount = 0;
  let unmatched = 0;

  const valid = parsed.filter(
    (p): p is ParsedInvoice & { invoice: NormalisedInvoice } => p.invoice !== null,
  );

  for (const p of parsed) {
    if (p.invoice === null) {
      const reason = firstError(p.issues) ?? "failed validation";
      rejected.push({ crm_invoice_id: p.crmInvoiceId, reason });
      log.push({
        crm_invoice_id: p.crmInvoiceId,
        action: p.raw.voided ? "void" : "upsert",
        outcome: "rejected",
        reason,
        payload: p.raw,
      });
    }
  }

  // One lookup for every invoice reference in the batch.
  const refs = [...new Set(valid.map((p) => p.invoice.crmInvoiceId))];
  const { data: existingRows, error: lookupError } = await supabase
    .from("invoices")
    .select("id, crm_invoice_id, voided_at")
    .in("crm_invoice_id", refs);
  if (lookupError) {
    await logDeliveries(log);
    return Response.json({ error: lookupError.message }, { status: 500 });
  }
  const existingByRef = new Map((existingRows ?? []).map((r) => [r.crm_invoice_id, r]));

  // And one for every order reference, so an invoice links to its delivery.
  const orderRefs = [
    ...new Set(valid.map((p) => p.invoice.crmOrderId).filter((r): r is string => r !== null)),
  ];
  const orderIdByRef = new Map<string, string>();
  if (orderRefs.length > 0) {
    const { data: orderRows, error: orderError } = await supabase
      .from("orders")
      .select("id, crm_order_id")
      .in("crm_order_id", orderRefs);
    if (orderError) {
      await logDeliveries(log);
      return Response.json({ error: orderError.message }, { status: 500 });
    }
    for (const row of orderRows ?? []) {
      orderIdByRef.set(row.crm_order_id as string, row.id as string);
    }
  }

  /** Lines and the VAT summary, written fresh. Returns an error message or null. */
  async function writeChildren(
    invoiceId: string,
    o: NormalisedInvoice,
  ): Promise<string | null> {
    // The ERP re-sends the whole document, so the stored lines are replaced
    // rather than merged — a line the ERP dropped must not survive here.
    const { error: clearLines } = await supabase
      .from("invoice_lines")
      .delete()
      .eq("invoice_id", invoiceId);
    if (clearLines) return clearLines.message;

    const { error: clearVat } = await supabase
      .from("invoice_vat_totals")
      .delete()
      .eq("invoice_id", invoiceId);
    if (clearVat) return clearVat.message;

    if (o.lines.length > 0) {
      const { error } = await supabase.from("invoice_lines").insert(
        o.lines.map((line) => ({
          invoice_id: invoiceId,
          line_no: line.lineNo,
          product_code: line.productCode,
          description: line.description,
          unit: line.unit,
          quantity: line.quantity,
          unit_price: line.unitPrice,
          case_price: line.casePrice,
          discount_pct: line.discountPct,
          vat_code: line.vatCode,
          vat_rate: line.vatRate,
          amount_inc_vat: line.amountIncVat,
        })),
      );
      if (error) return error.message;
    }

    if (o.vatTotals.length > 0) {
      const { error } = await supabase.from("invoice_vat_totals").insert(
        o.vatTotals.map((v) => ({
          invoice_id: invoiceId,
          vat_code: v.vatCode,
          vat_rate: v.vatRate,
          net_amount: v.netAmount,
          vat_amount: v.vatAmount,
        })),
      );
      if (error) return error.message;
    }

    return null;
  }

  for (const { invoice: o, issues } of valid) {
    const existing = existingByRef.get(o.crmInvoiceId);
    const warnings = issues.filter((i) => i.severity === "warning").map((i) => i.message);
    const warnSuffix = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";

    /* --- void --- */
    if (o.voided) {
      if (!existing) {
        skipped.push({
          crm_invoice_id: o.crmInvoiceId,
          reason: "no invoice with this reference",
        });
        log.push({
          crm_invoice_id: o.crmInvoiceId,
          action: "void",
          outcome: "skipped",
          reason: "no invoice with this reference",
        });
        continue;
      }
      if (existing.voided_at !== null) {
        skipped.push({ crm_invoice_id: o.crmInvoiceId, reason: "already voided" });
        log.push({
          crm_invoice_id: o.crmInvoiceId,
          action: "void",
          outcome: "skipped",
          reason: "already voided",
        });
        continue;
      }
      const { error } = await supabase
        .from("invoices")
        .update({ voided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) {
        await logDeliveries(log);
        return Response.json({ error: error.message }, { status: 500 });
      }
      voidedCount += 1;
      log.push({
        crm_invoice_id: o.crmInvoiceId,
        action: "void",
        outcome: "voided",
        reason: null,
      });
      continue;
    }

    const orderId = o.crmOrderId ? (orderIdByRef.get(o.crmOrderId) ?? null) : null;
    if (o.crmOrderId !== null && orderId === null) unmatched += 1;
    const matchNote =
      o.crmOrderId === null
        ? "no order reference"
        : orderId === null
          ? `no order matching ${o.crmOrderId} yet — will link when it arrives`
          : "linked to its delivery";

    /* --- new invoice --- */
    if (!existing) {
      const { data: inserted, error } = await supabase
        .from("invoices")
        .insert(headerRow(o, orderId))
        .select("id")
        .single();
      if (error || !inserted) {
        await logDeliveries(log);
        return Response.json({ error: error?.message ?? "insert failed" }, { status: 500 });
      }
      const childError = await writeChildren(inserted.id, o);
      if (childError) {
        await logDeliveries(log);
        return Response.json({ error: childError }, { status: 500 });
      }
      created += 1;
      log.push({
        crm_invoice_id: o.crmInvoiceId,
        action: "upsert",
        outcome: "created",
        reason: `${matchNote}${warnSuffix}`,
      });
      continue;
    }

    /* --- existing invoice: the ERP re-sent the document --- */
    const { error } = await supabase
      .from("invoices")
      .update({
        ...headerRow(o, orderId),
        // A re-issued invoice is live again. The ERP re-sending a document it
        // previously voided is it changing its mind, and the stored row should
        // say what the ERP currently says.
        voided_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) {
      await logDeliveries(log);
      return Response.json({ error: error.message }, { status: 500 });
    }
    const childError = await writeChildren(existing.id, o);
    if (childError) {
      await logDeliveries(log);
      return Response.json({ error: childError }, { status: 500 });
    }
    updated += 1;
    log.push({
      crm_invoice_id: o.crmInvoiceId,
      action: "upsert",
      outcome: "updated",
      reason: `${matchNote}${warnSuffix}`,
    });
  }

  await logDeliveries(log);

  if (created + updated + voidedCount > 0) {
    revalidatePath("/active-loads");
    revalidatePath("/orders-queue");
    revalidatePath("/integration-settings");
  }

  return Response.json(
    {
      received: inputs.length,
      created,
      updated,
      voided: voidedCount,
      unmatched,
      skipped,
      rejected,
    },
    { status: 200 },
  );
}

/** The connector pings this after registering the endpoint. */
export async function GET() {
  return Response.json({ ok: true, endpoint: "invoice-ingestion" });
}
