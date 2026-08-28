/**
 * CSV → `Order` mapping and validation.
 *
 * A stopgap until the CRM webhook exists. It intentionally lands orders in the
 * same shape the webhook will produce, so the two paths converge rather than
 * diverging: same required fields, same country handling, same treatment of an
 * address that cannot be placed on the map.
 *
 * Postcode and country rules are read from `regions.ts`, so an import of GB or
 * mainland EU orders is validated against that country's format, not Ireland's.
 */

import {
  COUNTRIES,
  HOME_COUNTRY,
  country,
  normalisePostcode,
  type CountryCode,
} from "./regions";
import type { Order } from "./types";

/* --- the column schema ------------------------------------------------------ */

export type FieldId =
  | "crm_order_id"
  | "customer_name"
  | "customer_phone"
  | "delivery_address"
  | "delivery_postcode"
  | "delivery_country"
  | "latitude"
  | "longitude"
  | "notifications_opt_out";

export interface FieldSpec {
  id: FieldId;
  label: string;
  required: boolean;
  hint: string;
  /** Lowercase header spellings seen in the wild, for auto-mapping. */
  aliases: string[];
}

export const IMPORT_FIELDS: FieldSpec[] = [
  {
    id: "crm_order_id",
    label: "Order reference",
    required: true,
    hint: "Unique per order. Used to match the CRM later.",
    aliases: ["crm_order_id", "order id", "order_id", "orderid", "order number", "order no", "reference", "ref", "crm id", "crm ref", "docket"],
  },
  {
    id: "customer_name",
    label: "Customer",
    required: true,
    hint: "Business or person receiving the delivery.",
    aliases: ["customer_name", "customer", "client", "name", "company", "consignee", "account"],
  },
  {
    id: "customer_phone",
    label: "Phone",
    required: false,
    hint: "Where the delivery alerts go, include the country code. Without one, this customer gets none of the three alerts.",
    aliases: ["customer_phone", "phone", "telephone", "tel", "mobile", "contact", "contact number", "phone number"],
  },
  {
    id: "delivery_address",
    label: "Delivery address",
    required: true,
    hint: "Street and town. Commas are fine inside quotes.",
    aliases: ["delivery_address", "address", "delivery address", "street", "address line 1", "address1", "ship to", "destination"],
  },
  {
    id: "delivery_postcode",
    label: "Postcode",
    required: true,
    hint: "Eircode, UK postcode, CP, PLZ — validated per country.",
    aliases: ["delivery_postcode", "postcode", "post code", "eircode", "zip", "zipcode", "postal code", "plz", "cp"],
  },
  {
    id: "delivery_country",
    label: "Country",
    required: false,
    hint: `Two-letter code. Defaults to ${HOME_COUNTRY} when the column is absent.`,
    aliases: ["delivery_country", "country", "country code", "iso", "destination country"],
  },
  {
    id: "latitude",
    label: "Latitude",
    required: false,
    hint: "Optional. Supply both lat and lng to skip geocoding entirely.",
    aliases: ["latitude", "lat"],
  },
  {
    id: "longitude",
    label: "Longitude",
    required: false,
    hint: "Optional. Must be paired with latitude.",
    aliases: ["longitude", "lng", "lon", "long"],
  },
  {
    id: "notifications_opt_out",
    label: "No alerts",
    required: false,
    hint: "yes / true / 1 marks a customer who has opted out.",
    aliases: ["notifications_opt_out", "opt out", "opt_out", "no alerts", "do not contact", "unsubscribed"],
  },
];

const norm = (header: string) =>
  header.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** Best-guess header → field mapping. Everything stays user-overridable. */
export function autoMap(headers: string[]): Record<FieldId, number | null> {
  const mapping = Object.fromEntries(
    IMPORT_FIELDS.map((f) => [f.id, null]),
  ) as Record<FieldId, number | null>;

  const taken = new Set<number>();

  for (const field of IMPORT_FIELDS) {
    const wanted = field.aliases.map(norm);
    const index = headers.findIndex(
      (h, i) => !taken.has(i) && wanted.includes(norm(h)),
    );
    if (index !== -1) {
      mapping[field.id] = index;
      taken.add(index);
    }
  }
  return mapping;
}

/* --- validation ------------------------------------------------------------- */

export interface RowIssue {
  field: FieldId | "row";
  message: string;
  /** Warnings still import; errors do not. */
  severity: "error" | "warning";
}

export interface ParsedRow {
  /** 1-based line number in the file, counting the header — for error copy. */
  line: number;
  values: Record<FieldId, string>;
  issues: RowIssue[];
  order: Order | null;
}

const TRUTHY = new Set(["yes", "y", "true", "1", "opted out", "opt out"]);
const FALSY = new Set(["", "no", "n", "false", "0"]);

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

export interface ImportContext {
  /** References already in the queue, so a re-import does not duplicate. */
  existingRefs: Set<string>;
  /** Fixed clock, so preview rows and fixtures agree. */
  now: Date;
}

export function validateRows(
  rows: string[][],
  mapping: Record<FieldId, number | null>,
  ctx: ImportContext,
): ParsedRow[] {
  const seenInFile = new Map<string, number>();
  const nowIso = ctx.now.toISOString();

  return rows.map((cells, i) => {
    const line = i + 2; // +1 for zero-index, +1 for the header row
    const read = (field: FieldId): string => {
      const col = mapping[field];
      return col === null ? "" : (cells[col] ?? "").trim();
    };

    const values = Object.fromEntries(
      IMPORT_FIELDS.map((f) => [f.id, read(f.id)]),
    ) as Record<FieldId, string>;

    const issues: RowIssue[] = [];

    for (const field of IMPORT_FIELDS) {
      if (field.required && values[field.id] === "") {
        issues.push({
          field: field.id,
          message: `${field.label} is required`,
          severity: "error",
        });
      }
    }

    // --- reference uniqueness, in the file and against the queue ---
    const ref = values.crm_order_id;
    if (ref !== "") {
      if (ctx.existingRefs.has(ref)) {
        issues.push({
          field: "crm_order_id",
          message: `${ref} is already in the queue`,
          severity: "error",
        });
      }
      const earlier = seenInFile.get(ref);
      if (earlier !== undefined) {
        issues.push({
          field: "crm_order_id",
          message: `Duplicate of line ${earlier}`,
          severity: "error",
        });
      } else {
        seenInFile.set(ref, line);
      }
    }

    // --- country ---
    let countryCode: CountryCode = HOME_COUNTRY;
    const rawCountry = values.delivery_country.toUpperCase();
    if (rawCountry !== "") {
      if (COUNTRIES[rawCountry]) {
        countryCode = rawCountry;
      } else {
        issues.push({
          field: "delivery_country",
          message: `Unknown country "${values.delivery_country}". Known: ${Object.keys(COUNTRIES).join(", ")}`,
          severity: "error",
        });
      }
    }

    // --- postcode: a warning, never a block. Postal data is messy, and a
    //     wrong-looking Eircode is still better than dropping the order.
    //     Stored in canonical form ("N39 HX56", not "n39hx56") so the queue
    //     shows one spelling per place and the geocode cache keys them alike. ---
    const postcode = normalisePostcode(countryCode, values.delivery_postcode);
    if (postcode !== null && COUNTRIES[countryCode]) {
      const spec = country(countryCode);
      if (!spec.postcodePattern.test(postcode)) {
        issues.push({
          field: "delivery_postcode",
          message: `Does not match the ${spec.postcodeLabel} format (e.g. ${spec.postcodeExample})`,
          severity: "warning",
        });
      }
    }

    // --- phone: optional, but silently importing one with no way to reach the
    //     customer would hide that this order can never get an alert ---
    const phone = values.customer_phone;
    if (phone === "") {
      issues.push({
        field: "customer_phone",
        message: "No phone — this customer will not receive any of the three alerts",
        severity: "warning",
      });
    } else if (!phone.replace(/[\s()-]/g, "").startsWith("+")) {
      issues.push({
        field: "customer_phone",
        message: `No country code — alerts may fail. Expected ${country(countryCode).dialPrefix}…`,
        severity: "warning",
      });
    }

    // --- coordinates: both or neither ---
    let location: { lat: number; lng: number } | null = null;
    const latRaw = values.latitude;
    const lngRaw = values.longitude;
    if (latRaw !== "" || lngRaw !== "") {
      const lat = Number.parseFloat(latRaw.replace(",", "."));
      const lng = Number.parseFloat(lngRaw.replace(",", "."));
      if (latRaw === "" || lngRaw === "") {
        issues.push({
          field: "latitude",
          message: "Latitude and longitude must be supplied together",
          severity: "warning",
        });
      } else if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        issues.push({
          field: "latitude",
          message: "Coordinates are out of range",
          severity: "warning",
        });
      } else {
        location = { lat, lng };
      }
    }

    // --- opt-out ---
    const optOut = parseBool(values.notifications_opt_out);
    if (optOut === null) {
      issues.push({
        field: "notifications_opt_out",
        message: `Could not read "${values.notifications_opt_out}" — treated as not opted out`,
        severity: "warning",
      });
    }

    const blocked = issues.some((issue) => issue.severity === "error");

    return {
      line,
      values,
      issues,
      order: blocked
        ? null
        : {
            id: `imp-${ref}`,
            crm_order_id: ref,
            customer_name: values.customer_name,
            customer_phone: phone,
            delivery_address: values.delivery_address,
            // No geocoding provider is configured, so an imported address
            // without coordinates is queued for geocoding rather than dropped —
            // the same rule the CRM ingestion path has to follow.
            delivery_location: location,
            status: "pending",
            created_at: nowIso,
            updated_at: nowIso,
            delivery_country: countryCode,
            delivery_postcode: postcode,
            notifications_opt_out: optOut ?? false,
            opted_out_at: optOut ? nowIso : null,
          },
    };
  });
}

export interface ImportSummary {
  total: number;
  ready: number;
  blocked: number;
  warnings: number;
  needGeocoding: number;
}

export function summarise(parsed: ParsedRow[]): ImportSummary {
  return {
    total: parsed.length,
    ready: parsed.filter((r) => r.order !== null).length,
    blocked: parsed.filter((r) => r.order === null).length,
    warnings: parsed.filter((r) =>
      r.issues.some((i) => i.severity === "warning"),
    ).length,
    needGeocoding: parsed.filter(
      (r) => r.order !== null && r.order.delivery_location === null,
    ).length,
  };
}

/** The header row plus one worked example, for the downloadable template. */
export function templateRows(): string[][] {
  return [
    IMPORT_FIELDS.map((f) => f.id),
    [
      "CRM-24301",
      "Kelly's Wholesale",
      "+353 87 123 4567",
      "Unit 12, Ballymount Industrial Estate, Dublin 12",
      "D12 AB34",
      "IE",
      "",
      "",
      "no",
    ],
    [
      "CRM-24302",
      "Lagan Retail Group",
      "+44 28 9032 7741",
      "Duncrue Industrial Estate, Belfast",
      "BT3 9BP",
      "XI",
      "54.6210",
      "-5.9100",
      "no",
    ],
  ];
}
