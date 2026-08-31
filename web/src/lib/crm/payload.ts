/**
 * The CRM ingestion contract — the JSON `POST /api/webhooks/crm` accepts, and
 * its validation.
 *
 * Deliberately mirrors `lib/orders-import.ts` (the CSV importer) field for
 * field: same required set, same per-country postcode rules from `regions.ts`,
 * same treatment of an address that cannot be placed on a map (flag, never
 * drop). The two intake paths converge on one order shape rather than
 * diverging.
 *
 * Pure — no I/O, no clock, nothing server-only — so it can be unit-tested and
 * so the route stays a thin transport shell around it.
 *
 * ---------------------------------------------------------------------------
 * Request body
 * ---------------------------------------------------------------------------
 * Bearer auth: `Authorization: Bearer <CRM_WEBHOOK_SECRET>`.
 * Content-Type: application/json. One of:
 *
 *   { "orders": [ <order>, ... ] }      ← preferred, batches cleanly
 *   [ <order>, ... ]                    ← bare array
 *   <order>                             ← a single order object
 *
 * <order>:
 *   {
 *     "crm_order_id":          "CRM-24301",              // required, unique
 *     "customer_name":         "Kelly's Wholesale",      // required
 *     "customer_phone":        "+353 87 123 4567",       // optional, E.164
 *     "address_line_1":        "Unit 12, Ballymount Ind. Est.", // required
 *     "address_line_2":        "Walkinstown, Dublin 12", // optional
 *     "delivery_postcode":     "D12 AB34",               // required
 *     "delivery_country":      "IE",                     // optional, default IE
 *     "latitude":              53.319,                   // optional, with lng
 *     "longitude":             -6.335,                   // optional, with lat
 *     "promised_at":           "2026-09-01T14:00:00Z",   // optional, ISO 8601
 *     "promised_window_end":   "2026-09-01T16:00:00Z",   // optional, ISO 8601
 *     "notifications_opt_out": false,                    // optional, default false
 *     "cancelled":             false                     // optional; true removes
 *   }                                                    //   a still-pending order
 *
 * Errors block a single order; warnings do not. Unknown country or a missing
 * required field is an error. A malformed postcode, a phone with no country
 * code, or out-of-range coordinates is a warning — the order still lands, with
 * the flag, because postal data is messy and dropping it is worse.
 */

import {
  COUNTRIES,
  HOME_COUNTRY,
  country,
  looksTransposed,
  normalisePostcode,
  type CountryCode,
} from "@/lib/regions";

/** One order object as it arrives — every field `unknown` until validated. */
export interface CrmOrderInput {
  crm_order_id?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  address_line_1?: unknown;
  address_line_2?: unknown;
  delivery_postcode?: unknown;
  delivery_country?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  promised_at?: unknown;
  promised_window_end?: unknown;
  notifications_opt_out?: unknown;
  cancelled?: unknown;
}

export interface CrmIssue {
  field: string;
  message: string;
  /** Warnings still land the order; errors do not. */
  severity: "error" | "warning";
}

/** A validated order, in the app's own vocabulary. */
export interface NormalisedCrmOrder {
  crmOrderId: string;
  /** true ⇒ the sender wants this order removed, not created/updated. */
  cancelled: boolean;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryCountry: CountryCode;
  deliveryPostcode: string | null;
  location: { lat: number; lng: number } | null;
  promisedAt: string | null;
  promisedWindowEnd: string | null;
  notificationsOptOut: boolean;
}

export interface ParsedCrmOrder {
  raw: CrmOrderInput;
  crmOrderId: string | null;
  issues: CrmIssue[];
  /** null when a hard error blocks the order. */
  order: NormalisedCrmOrder | null;
}

/* --- body envelope -------------------------------------------------------- */

/**
 * Pulls the order list out of whatever envelope the sender used, or null when
 * the body is not a recognised shape at all.
 */
export function readCrmBody(payload: unknown): CrmOrderInput[] | null {
  if (Array.isArray(payload)) return payload as CrmOrderInput[];
  if (payload !== null && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as CrmOrderInput[];
    // A single order object, sent unwrapped.
    if ("crm_order_id" in obj) return [obj as CrmOrderInput];
  }
  return null;
}

/* --- scalar coercion ----------------------------------------------------- */

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

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ISO 8601 → canonical ISO string. `{ ok: false }` when present but unparseable. */
function asIsoDate(v: unknown): { ok: boolean; value: string | null } {
  const s = asString(v);
  if (s === "") return { ok: true, value: null };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false, value: null };
  return { ok: true, value: d.toISOString() };
}

/* --- validation -------------------------------------------------------- */

/**
 * Validates a batch. Duplicate `crm_order_id` values *within one payload* are
 * an error on the later occurrence — the same rule the CSV importer applies to
 * a spreadsheet.
 */
export function validateCrmOrders(inputs: CrmOrderInput[]): ParsedCrmOrder[] {
  const seen = new Set<string>();
  return inputs.map((raw) => {
    const parsed = parseCrmOrder(raw);
    const ref = parsed.crmOrderId;
    if (ref !== null) {
      if (seen.has(ref)) {
        parsed.issues.push({
          field: "crm_order_id",
          message: `Duplicate of an earlier order in the same payload (${ref})`,
          severity: "error",
        });
        parsed.order = null;
      } else {
        seen.add(ref);
      }
    }
    return parsed;
  });
}

/** Validates one order object in isolation. */
export function parseCrmOrder(raw: CrmOrderInput): ParsedCrmOrder {
  const issues: CrmIssue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ field, message, severity: "error" });
  const warn = (field: string, message: string) =>
    issues.push({ field, message, severity: "warning" });

  const crmOrderId = asString(raw.crm_order_id);
  if (crmOrderId === "") {
    err("crm_order_id", "crm_order_id is required");
  }

  const cancelled = asBool(raw.cancelled) === true;

  // --- country (needed for postcode + phone checks below) ---
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

  // A cancellation only needs to name the order. Everything else is skipped —
  // the CRM may not even resend the full body to cancel.
  if (cancelled) {
    const blocked = issues.some((i) => i.severity === "error");
    return {
      raw,
      crmOrderId: crmOrderId === "" ? null : crmOrderId,
      issues,
      order: blocked
        ? null
        : {
            crmOrderId,
            cancelled: true,
            customerName: asString(raw.customer_name),
            customerPhone: asString(raw.customer_phone),
            deliveryAddress: joinAddress(raw),
            deliveryCountry,
            deliveryPostcode: normalisePostcode(
              deliveryCountry,
              asString(raw.delivery_postcode),
            ),
            location: null,
            promisedAt: null,
            promisedWindowEnd: null,
            notificationsOptOut: false,
          },
    };
  }

  const customerName = asString(raw.customer_name);
  if (customerName === "") err("customer_name", "customer_name is required");

  const addressLine1 = asString(raw.address_line_1);
  if (addressLine1 === "") err("address_line_1", "address_line_1 is required");

  const rawPostcode = asString(raw.delivery_postcode);
  if (rawPostcode === "") err("delivery_postcode", "delivery_postcode is required");

  // --- postcode: canonical form, shape is a warning only ---
  const deliveryPostcode = normalisePostcode(deliveryCountry, rawPostcode);
  if (deliveryPostcode !== null && COUNTRIES[deliveryCountry]) {
    const spec = country(deliveryCountry);
    if (!spec.postcodePattern.test(deliveryPostcode)) {
      warn(
        "delivery_postcode",
        `Does not match the ${spec.postcodeLabel} format (e.g. ${spec.postcodeExample})`,
      );
    }
  }

  // --- phone: optional, but flag an order that can never be alerted ---
  const customerPhone = asString(raw.customer_phone);
  if (customerPhone === "") {
    warn(
      "customer_phone",
      "No phone — this customer will not receive any of the three alerts",
    );
  } else if (!customerPhone.replace(/[\s()-]/g, "").startsWith("+")) {
    warn(
      "customer_phone",
      `No country code — alerts may fail. Expected ${country(deliveryCountry).dialPrefix}…`,
    );
  }

  // --- coordinates: both or neither, in range, not transposed ---
  let location: { lat: number; lng: number } | null = null;
  const lat = asNumber(raw.latitude);
  const lng = asNumber(raw.longitude);
  if (raw.latitude != null || raw.longitude != null) {
    if (lat === null || lng === null) {
      warn("latitude", "latitude and longitude must be supplied together");
    } else if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      warn("latitude", "Coordinates are out of range — ignored, address will be geocoded");
    } else if (looksTransposed({ lat, lng }, deliveryCountry)) {
      warn(
        "latitude",
        "latitude and longitude look swapped for the delivery country — ignored, address will be geocoded",
      );
    } else {
      location = { lat, lng };
    }
  }

  // --- promised time ---
  const promised = asIsoDate(raw.promised_at);
  if (!promised.ok) warn("promised_at", "Not a valid ISO 8601 timestamp — ignored");
  const promisedEnd = asIsoDate(raw.promised_window_end);
  if (!promisedEnd.ok)
    warn("promised_window_end", "Not a valid ISO 8601 timestamp — ignored");

  // --- opt-out ---
  const optOut = asBool(raw.notifications_opt_out);
  if (raw.notifications_opt_out != null && optOut === null) {
    warn(
      "notifications_opt_out",
      `Could not read "${asString(raw.notifications_opt_out)}" — treated as not opted out`,
    );
  }

  const blocked = issues.some((i) => i.severity === "error");

  return {
    raw,
    crmOrderId: crmOrderId === "" ? null : crmOrderId,
    issues,
    order: blocked
      ? null
      : {
          crmOrderId,
          cancelled: false,
          customerName,
          customerPhone,
          deliveryAddress: joinAddress(raw),
          deliveryCountry,
          deliveryPostcode,
          location,
          promisedAt: promised.value,
          promisedWindowEnd: promisedEnd.value,
          notificationsOptOut: optOut ?? false,
        },
  };
}

/**
 * The schema stores one address string; the CRM holds it across two lines.
 * Join with ", ", dropping a blank line 2 — identical to the CSV importer.
 */
function joinAddress(raw: CrmOrderInput): string {
  return [asString(raw.address_line_1), asString(raw.address_line_2)]
    .filter(Boolean)
    .join(", ");
}

export function firstError(issues: CrmIssue[]): string | null {
  return issues.find((i) => i.severity === "error")?.message ?? null;
}
