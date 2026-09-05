/**
 * The invoice ingestion contract — the JSON `POST /api/webhooks/invoices`
 * accepts, and its validation.
 *
 * Deliberately mirrors `lib/crm/payload.ts` (the order feed) in shape and in
 * posture: same envelope handling, same `errors block / warnings don't` rule,
 * same per-country postcode rules from `regions.ts`. The two feeds come from
 * the same ERP and should fail in the same recognisable ways.
 *
 * Pure — no I/O, no clock, nothing server-only — so it can be unit-tested and
 * so the route stays a thin transport shell around it.
 *
 * ---------------------------------------------------------------------------
 * Money is carried as STRINGS, not numbers
 * ---------------------------------------------------------------------------
 * Every monetary field keeps the ERP's exact decimal text and hands it to
 * Postgres NUMERIC unchanged. Parsing "1234.56" into a JS float and
 * re-serialising it can produce 1234.5599999999999, and an invoice that renders
 * one total on the driver's phone and a different one on the customer's copy is
 * a document nobody can sign. Numbers are only ever derived for *comparison*
 * (see `totalsMismatch`), never for storage.
 *
 * ---------------------------------------------------------------------------
 * Request body
 * ---------------------------------------------------------------------------
 * Bearer auth: `Authorization: Bearer <INVOICE_WEBHOOK_SECRET>`.
 * Content-Type: application/json. One of:
 *
 *   { "invoices": [ <invoice>, ... ] }   ← preferred, batches cleanly
 *   [ <invoice>, ... ]                   ← bare array
 *   <invoice>                            ← a single invoice object
 *
 * <invoice>:
 *   {
 *     "crm_invoice_id":   "B-0216022",            // required, unique, the ERP's key
 *     "invoice_no":       "B-0216022",            // required, as printed
 *     "invoice_date":     "2026-09-02",           // required, ISO date
 *     "crm_order_id":     "CRM-24301",            // optional — links to the delivery
 *     "customer_name":    "Anita Market - Wexford",  // required
 *     "customer_account_no": "ANI001",            // optional
 *     "customer_email":   "accounts@anita.ie",    // optional — no email, no PoD sent
 *     "customer_phone":   "089 2403306",          // optional
 *     "address_line_1":   "Unit 1A, Chelsea House",   // required
 *     "address_line_2":   "Distillery Road, Wexford", // optional
 *     "delivery_city":    "Wexford",              // optional
 *     "delivery_postcode":"Y35KC98",              // optional
 *     "delivery_country": "IE",                   // optional, default IE
 *     "opening_time":     "09:00",                // optional, free text
 *     "closing_time":     "20:00",                // optional, free text
 *     "sales_rep":        "HADI",                 // optional
 *     "previous_balance": "0.00",                 // optional
 *     "current_balance":  "581.74",               // optional
 *     "currency":         "EUR",                  // optional, default EUR
 *     "case_count":       28,                     // optional
 *     "piece_count":      353,                    // optional
 *     "sub_total":        "568.41",               // required
 *     "discount_total":   "0.00",                 // optional, default 0
 *     "vat_total":        "13.33",                // required
 *     "grand_total":      "581.74",               // required
 *     "payment_terms":    "...",                  // optional, as printed
 *     "bank_details":     "...",                  // optional, as printed
 *     "voided":           false,                  // optional; true withdraws it
 *     "lines": [ <line>, ... ],                   // required, at least one
 *     "vat_totals": [ <vatTotal>, ... ]           // optional, the summary block
 *   }
 *
 * <line>:
 *   {
 *     "line_no": 1, "product_code": "17485", "description": "ARGETA CHICKEN…",
 *     "unit": "BOX", "quantity": "3", "unit_price": "1.043",
 *     "case_price": "14.60", "discount_pct": "0.00",
 *     "vat_code": "Z", "vat_rate": "0.0", "amount_inc_vat": "43.80"
 *   }
 *
 * <vatTotal>:
 *   { "vat_code": "S", "vat_rate": "23.0", "net_amount": "57.90",
 *     "vat_amount": "13.33" }
 *
 * Errors block a single invoice; warnings do not. A missing required field,
 * an unreadable total or an invoice with no lines is an error. A malformed
 * postcode, a missing email, an unmatched order reference or totals that do not
 * add up are warnings — the invoice still lands, flagged, because a dispatcher
 * who can see the problem before the driver leaves is the point.
 */

import {
  COUNTRIES,
  HOME_COUNTRY,
  country,
  normalisePostcode,
  type CountryCode,
} from "@/lib/regions";

/* --- inputs --------------------------------------------------------------- */

export interface InvoiceLineInput {
  line_no?: unknown;
  product_code?: unknown;
  description?: unknown;
  unit?: unknown;
  quantity?: unknown;
  unit_price?: unknown;
  case_price?: unknown;
  discount_pct?: unknown;
  vat_code?: unknown;
  vat_rate?: unknown;
  amount_inc_vat?: unknown;
}

export interface InvoiceVatTotalInput {
  vat_code?: unknown;
  vat_rate?: unknown;
  net_amount?: unknown;
  vat_amount?: unknown;
}

/** One invoice object as it arrives — every field `unknown` until validated. */
export interface InvoiceInput {
  crm_invoice_id?: unknown;
  invoice_no?: unknown;
  invoice_date?: unknown;
  crm_order_id?: unknown;
  customer_name?: unknown;
  customer_account_no?: unknown;
  customer_email?: unknown;
  customer_phone?: unknown;
  address_line_1?: unknown;
  address_line_2?: unknown;
  delivery_city?: unknown;
  delivery_postcode?: unknown;
  delivery_country?: unknown;
  opening_time?: unknown;
  closing_time?: unknown;
  sales_rep?: unknown;
  previous_balance?: unknown;
  current_balance?: unknown;
  currency?: unknown;
  case_count?: unknown;
  piece_count?: unknown;
  sub_total?: unknown;
  discount_total?: unknown;
  vat_total?: unknown;
  grand_total?: unknown;
  payment_terms?: unknown;
  bank_details?: unknown;
  voided?: unknown;
  lines?: unknown;
  vat_totals?: unknown;
}

export interface InvoiceIssue {
  field: string;
  message: string;
  /** Warnings still land the invoice; errors do not. */
  severity: "error" | "warning";
}

/* --- normalised output ---------------------------------------------------- */

export interface NormalisedInvoiceLine {
  lineNo: number;
  productCode: string | null;
  description: string;
  unit: string | null;
  quantity: string;
  unitPrice: string | null;
  casePrice: string | null;
  discountPct: string | null;
  vatCode: string | null;
  vatRate: string | null;
  amountIncVat: string;
}

export interface NormalisedVatTotal {
  vatCode: string;
  vatRate: string;
  netAmount: string;
  vatAmount: string;
}

/** A validated invoice, in the app's own vocabulary. Money stays textual. */
export interface NormalisedInvoice {
  crmInvoiceId: string;
  /** true ⇒ the ERP has withdrawn this invoice, not issued/updated it. */
  voided: boolean;
  invoiceNo: string;
  invoiceDate: string;
  crmOrderId: string | null;

  customerName: string;
  customerAccountNo: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  deliveryAddress: string;
  deliveryCity: string | null;
  deliveryPostcode: string | null;
  deliveryCountry: CountryCode;
  openingTime: string | null;
  closingTime: string | null;
  salesRep: string | null;

  previousBalance: string | null;
  currentBalance: string | null;

  currency: string;
  caseCount: number | null;
  pieceCount: number | null;
  subTotal: string;
  discountTotal: string;
  vatTotal: string;
  grandTotal: string;
  /** The ERP's lines do not sum to the ERP's own grand total. Reported only. */
  totalsMismatch: boolean;

  paymentTerms: string | null;
  bankDetails: string | null;

  lines: NormalisedInvoiceLine[];
  vatTotals: NormalisedVatTotal[];
}

export interface ParsedInvoice {
  raw: InvoiceInput;
  crmInvoiceId: string | null;
  issues: InvoiceIssue[];
  /** null when a hard error blocks the invoice. */
  invoice: NormalisedInvoice | null;
}

/* --- body envelope -------------------------------------------------------- */

/**
 * Pulls the invoice list out of whatever envelope the sender used, or null when
 * the body is not a recognised shape at all.
 */
export function readInvoiceBody(payload: unknown): InvoiceInput[] | null {
  if (Array.isArray(payload)) return payload as InvoiceInput[];
  if (payload !== null && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.invoices)) return obj.invoices as InvoiceInput[];
    // A single invoice object, sent unwrapped.
    if ("crm_invoice_id" in obj) return [obj as InvoiceInput];
  }
  return null;
}

/* --- scalar coercion ------------------------------------------------------ */
/* Local to this module, matching how `crm/payload.ts` and `orders-import.ts`
   each own theirs — the accepted spellings differ per source and sharing them
   would couple three intake paths together for thirty lines. */

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

const TRUTHY = new Set(["yes", "y", "true", "1"]);
const FALSY = new Set(["", "no", "n", "false", "0"]);

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
  const s = String(v ?? "").trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return null;
}

function asInteger(v: unknown): number | null {
  const s = asString(v);
  if (s === "") return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * A monetary or decimal value, kept as canonical decimal TEXT.
 *
 * Accepts a JSON number or a string. A single comma is read as a decimal
 * separator (the ERP exports from a European locale), matching `asNumber` in
 * the order feed. Thousands separators are deliberately NOT stripped: "1,234"
 * is genuinely ambiguous between 1234 and 1.234, and guessing on an invoice
 * line is how a customer gets billed a thousand times over.
 */
function asDecimal(v: unknown): { ok: boolean; value: string | null } {
  if (typeof v === "number") {
    return Number.isFinite(v) ? { ok: true, value: String(v) } : { ok: false, value: null };
  }
  const s = asString(v);
  if (s === "") return { ok: true, value: null };
  const normalised = s.includes(".") ? s : s.replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalised)) return { ok: false, value: null };
  return { ok: true, value: normalised };
}

/** ISO date (YYYY-MM-DD) → canonical date string. */
function asIsoDateOnly(v: unknown): { ok: boolean; value: string | null } {
  const s = asString(v);
  if (s === "") return { ok: true, value: null };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false, value: null };
  return { ok: true, value: d.toISOString().slice(0, 10) };
}

/** Decimal text → integer cents, for comparison only. Never for storage. */
function toCents(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/* --- validation ----------------------------------------------------------- */

/**
 * Validates a batch. Duplicate `crm_invoice_id` values *within one payload* are
 * an error on the later occurrence — the same rule the order feed applies.
 */
export function validateInvoices(inputs: InvoiceInput[]): ParsedInvoice[] {
  const seen = new Set<string>();
  return inputs.map((raw) => {
    const parsed = parseInvoice(raw);
    const ref = parsed.crmInvoiceId;
    if (ref !== null) {
      if (seen.has(ref)) {
        parsed.issues.push({
          field: "crm_invoice_id",
          message: `Duplicate of an earlier invoice in the same payload (${ref})`,
          severity: "error",
        });
        parsed.invoice = null;
      } else {
        seen.add(ref);
      }
    }
    return parsed;
  });
}

/** Validates one invoice object in isolation. */
export function parseInvoice(raw: InvoiceInput): ParsedInvoice {
  const issues: InvoiceIssue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ field, message, severity: "error" });
  const warn = (field: string, message: string) =>
    issues.push({ field, message, severity: "warning" });

  const crmInvoiceId = asString(raw.crm_invoice_id);
  if (crmInvoiceId === "") err("crm_invoice_id", "crm_invoice_id is required");

  const voided = asBool(raw.voided) === true;

  // A void only needs to name the invoice. The ERP may not resend the body.
  if (voided) {
    const blocked = issues.some((i) => i.severity === "error");
    return {
      raw,
      crmInvoiceId: crmInvoiceId === "" ? null : crmInvoiceId,
      issues,
      invoice: blocked ? null : voidedInvoice(crmInvoiceId, raw),
    };
  }

  const invoiceNo = asString(raw.invoice_no);
  if (invoiceNo === "") err("invoice_no", "invoice_no is required");

  const invoiceDate = asIsoDateOnly(raw.invoice_date);
  if (!invoiceDate.ok) {
    err("invoice_date", "invoice_date is not a valid date");
  } else if (invoiceDate.value === null) {
    err("invoice_date", "invoice_date is required");
  }

  const customerName = asString(raw.customer_name);
  if (customerName === "") err("customer_name", "customer_name is required");

  const addressLine1 = asString(raw.address_line_1);
  if (addressLine1 === "") err("address_line_1", "address_line_1 is required");

  // --- country (needed for the postcode check) ---
  let deliveryCountry: CountryCode = HOME_COUNTRY;
  const rawCountry = asString(raw.delivery_country).toUpperCase();
  if (rawCountry !== "") {
    if (COUNTRIES[rawCountry]) {
      deliveryCountry = rawCountry;
    } else {
      err(
        "delivery_country",
        `Unknown country "${rawCountry}". Known: ${Object.keys(COUNTRIES).join(", ")}`,
      );
    }
  }

  const deliveryPostcode = normalisePostcode(
    deliveryCountry,
    asString(raw.delivery_postcode),
  );
  if (deliveryPostcode !== null && COUNTRIES[deliveryCountry]) {
    const spec = country(deliveryCountry);
    if (!spec.postcodePattern.test(deliveryPostcode)) {
      warn(
        "delivery_postcode",
        `Does not match the ${spec.postcodeLabel} format (e.g. ${spec.postcodeExample})`,
      );
    }
  }

  // --- the delivery this invoice belongs to ---
  const crmOrderId = asString(raw.crm_order_id) || null;
  if (crmOrderId === null) {
    warn(
      "crm_order_id",
      "No crm_order_id — this invoice cannot be matched to a delivery, so no driver will see it",
    );
  }

  // --- where the signed PDF goes ---
  const customerEmail = asString(raw.customer_email) || null;
  if (customerEmail === null) {
    warn(
      "customer_email",
      "No customer_email — the signed delivery receipt cannot be emailed",
    );
  } else if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(customerEmail)) {
    warn("customer_email", `"${customerEmail}" does not look like an email address`);
  }

  // --- totals, required and textual ---
  const subTotal = requireDecimal(raw.sub_total, "sub_total", err);
  const vatTotal = requireDecimal(raw.vat_total, "vat_total", err);
  const grandTotal = requireDecimal(raw.grand_total, "grand_total", err);

  const discount = asDecimal(raw.discount_total);
  if (!discount.ok) warn("discount_total", "Not a valid amount — treated as 0.00");
  const discountTotal = discount.value ?? "0";

  const previous = asDecimal(raw.previous_balance);
  if (!previous.ok) warn("previous_balance", "Not a valid amount — ignored");
  const current = asDecimal(raw.current_balance);
  if (!current.ok) warn("current_balance", "Not a valid amount — ignored");

  // --- lines ---
  const { lines, lineIssues } = parseLines(raw.lines);
  issues.push(...lineIssues);
  if (lines.length === 0 && !lineIssues.some((i) => i.severity === "error")) {
    err("lines", "An invoice must carry at least one line");
  }

  const vatTotals = parseVatTotals(raw.vat_totals);

  // --- do the ERP's own numbers agree with each other? ---
  //
  // Reported, never corrected. A tolerance of one cent absorbs the ERP's own
  // per-line rounding; anything larger is a real export problem and the
  // dispatcher should see it before the driver leaves.
  let totalsMismatch = false;
  const grandCents = toCents(grandTotal);
  if (grandCents !== null && lines.length > 0) {
    const summed = lines.reduce((total, line) => {
      const cents = toCents(line.amountIncVat);
      return cents === null ? total : total + cents;
    }, 0);
    if (Math.abs(summed - grandCents) > 1) {
      totalsMismatch = true;
      warn(
        "grand_total",
        `Lines sum to ${(summed / 100).toFixed(2)} but grand_total is ${grandTotal} — stored as sent, not corrected`,
      );
    }
  }

  const blocked = issues.some((i) => i.severity === "error");

  return {
    raw,
    crmInvoiceId: crmInvoiceId === "" ? null : crmInvoiceId,
    issues,
    invoice: blocked
      ? null
      : {
          crmInvoiceId,
          voided: false,
          invoiceNo,
          invoiceDate: invoiceDate.value!,
          crmOrderId,
          customerName,
          customerAccountNo: asString(raw.customer_account_no) || null,
          customerEmail,
          customerPhone: asString(raw.customer_phone) || null,
          deliveryAddress: joinAddress(raw),
          deliveryCity: asString(raw.delivery_city) || null,
          deliveryPostcode,
          deliveryCountry,
          openingTime: asString(raw.opening_time) || null,
          closingTime: asString(raw.closing_time) || null,
          salesRep: asString(raw.sales_rep) || null,
          previousBalance: previous.value,
          currentBalance: current.value,
          currency: (asString(raw.currency) || "EUR").toUpperCase().slice(0, 3),
          caseCount: asInteger(raw.case_count),
          pieceCount: asInteger(raw.piece_count),
          subTotal: subTotal ?? "0",
          discountTotal,
          vatTotal: vatTotal ?? "0",
          grandTotal: grandTotal ?? "0",
          totalsMismatch,
          paymentTerms: asString(raw.payment_terms) || null,
          bankDetails: asString(raw.bank_details) || null,
          lines,
          vatTotals,
        },
  };
}

/* --- pieces --------------------------------------------------------------- */

function requireDecimal(
  value: unknown,
  field: string,
  err: (field: string, message: string) => void,
): string | null {
  const parsed = asDecimal(value);
  if (!parsed.ok) {
    err(field, `${field} is not a valid amount`);
    return null;
  }
  if (parsed.value === null) {
    err(field, `${field} is required`);
    return null;
  }
  return parsed.value;
}

function parseLines(value: unknown): {
  lines: NormalisedInvoiceLine[];
  lineIssues: InvoiceIssue[];
} {
  const lineIssues: InvoiceIssue[] = [];
  if (value == null) {
    lineIssues.push({
      field: "lines",
      message: "lines is required",
      severity: "error",
    });
    return { lines: [], lineIssues };
  }
  if (!Array.isArray(value)) {
    lineIssues.push({
      field: "lines",
      message: "lines must be an array",
      severity: "error",
    });
    return { lines: [], lineIssues };
  }

  const lines: NormalisedInvoiceLine[] = [];
  const seenLineNos = new Set<number>();

  (value as InvoiceLineInput[]).forEach((raw, index) => {
    const field = `lines[${index}]`;
    // Falls back to position when the ERP does not number its lines. The
    // sequence is what the PDF prints and what a partial delivery references,
    // so it has to exist either way.
    const lineNo = asInteger(raw.line_no) ?? index + 1;
    if (seenLineNos.has(lineNo)) {
      lineIssues.push({
        field: `${field}.line_no`,
        message: `Duplicate line_no ${lineNo}`,
        severity: "error",
      });
      return;
    }
    seenLineNos.add(lineNo);

    const description = asString(raw.description);
    if (description === "") {
      lineIssues.push({
        field: `${field}.description`,
        message: "description is required",
        severity: "error",
      });
      return;
    }

    const quantity = asDecimal(raw.quantity);
    if (!quantity.ok || quantity.value === null) {
      lineIssues.push({
        field: `${field}.quantity`,
        message: "quantity is required and must be a number",
        severity: "error",
      });
      return;
    }

    const amount = asDecimal(raw.amount_inc_vat);
    if (!amount.ok || amount.value === null) {
      lineIssues.push({
        field: `${field}.amount_inc_vat`,
        message: "amount_inc_vat is required and must be an amount",
        severity: "error",
      });
      return;
    }

    const vatCode = asString(raw.vat_code) || null;
    if (vatCode === null) {
      lineIssues.push({
        field: `${field}.vat_code`,
        message: "No vat_code — the VAT summary block cannot group this line",
        severity: "warning",
      });
    }

    lines.push({
      lineNo,
      productCode: asString(raw.product_code) || null,
      description,
      unit: asString(raw.unit) || null,
      quantity: quantity.value,
      unitPrice: asDecimal(raw.unit_price).value,
      casePrice: asDecimal(raw.case_price).value,
      discountPct: asDecimal(raw.discount_pct).value,
      vatCode,
      vatRate: asDecimal(raw.vat_rate).value,
      amountIncVat: amount.value,
    });
  });

  return { lines, lineIssues };
}

/**
 * The VAT summary block. Optional and never blocking — it is a restatement of
 * the lines, so a missing one costs the PDF a section, not the delivery.
 */
function parseVatTotals(value: unknown): NormalisedVatTotal[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const totals: NormalisedVatTotal[] = [];

  for (const raw of value as InvoiceVatTotalInput[]) {
    const vatCode = asString(raw.vat_code);
    const vatRate = asDecimal(raw.vat_rate).value;
    const netAmount = asDecimal(raw.net_amount).value;
    const vatAmount = asDecimal(raw.vat_amount).value;
    if (vatCode === "" || vatRate === null || netAmount === null || vatAmount === null) {
      continue;
    }
    // The table is keyed on (invoice_id, vat_code); a repeated code would be a
    // conflicting upsert rather than a second row.
    if (seen.has(vatCode)) continue;
    seen.add(vatCode);
    totals.push({ vatCode, vatRate, netAmount, vatAmount });
  }

  return totals;
}

/** A void carries only the reference; everything else is left empty. */
function voidedInvoice(crmInvoiceId: string, raw: InvoiceInput): NormalisedInvoice {
  return {
    crmInvoiceId,
    voided: true,
    invoiceNo: asString(raw.invoice_no),
    invoiceDate: asIsoDateOnly(raw.invoice_date).value ?? "",
    crmOrderId: asString(raw.crm_order_id) || null,
    customerName: asString(raw.customer_name),
    customerAccountNo: null,
    customerEmail: null,
    customerPhone: null,
    deliveryAddress: "",
    deliveryCity: null,
    deliveryPostcode: null,
    deliveryCountry: HOME_COUNTRY,
    openingTime: null,
    closingTime: null,
    salesRep: null,
    previousBalance: null,
    currentBalance: null,
    currency: "EUR",
    caseCount: null,
    pieceCount: null,
    subTotal: "0",
    discountTotal: "0",
    vatTotal: "0",
    grandTotal: "0",
    totalsMismatch: false,
    paymentTerms: null,
    bankDetails: null,
    lines: [],
    vatTotals: [],
  };
}

/**
 * The schema stores one address string; the ERP holds it across two lines.
 * Join with ", ", dropping a blank line 2 — identical to the order feed.
 */
function joinAddress(raw: InvoiceInput): string {
  return [asString(raw.address_line_1), asString(raw.address_line_2)]
    .filter(Boolean)
    .join(", ");
}

export function firstError(issues: InvoiceIssue[]): string | null {
  return issues.find((i) => i.severity === "error")?.message ?? null;
}
