/**
 * The integration surface described in `Project BalkaniaTMS.md`, expressed as
 * data so the settings screen is a real setup checklist rather than decoration.
 *
 * Statuses here reflect the repository as it actually stands: `.env.local` is
 * unset and no webhook route handlers exist yet. Update these as each piece
 * lands — the page reads straight from this list.
 */

import type { NotificationType } from "../types";

export type ConnectorStatus =
  | "connected"
  | "configured"
  | "not_configured"
  | "not_built";

export interface Connector {
  id: string;
  name: string;
  purpose: string;
  icon: string;
  status: ConnectorStatus;
  /** Variables from `.env.example` this connector reads. */
  envVars: string[];
  /** Route this connector talks to, if it is an inbound webhook. */
  endpoint?: string;
  note?: string;
}

export const connectors: Connector[] = [
  {
    id: "supabase",
    name: "Supabase",
    purpose: "Postgres + PostGIS, realtime dashboard updates, and auth.",
    icon: "database",
    status: "not_configured",
    envVars: [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    note: "Client helpers exist; migration 0001_init.sql is written but not applied to any project.",
  },
  {
    id: "crm",
    name: "CRM ingestion",
    purpose: "Receives processed orders and geocodes the delivery address.",
    icon: "cloud_download",
    status: "not_built",
    envVars: ["CRM_WEBHOOK_SECRET"],
    endpoint: "POST /api/webhooks/crm",
    note: "Route handler not implemented. Orders that fail geocoding must be flagged, never dropped.",
  },
  {
    id: "gps",
    name: "Verizon Connect Reveal",
    purpose:
      "Truck positions, pushed per fix. Formerly Fleetmatics; portal at fim.eu.fleetmatics.com.",
    icon: "satellite_alt",
    status: "not_configured",
    envVars: [
      "FLEETMATICS_ENV",
      "FLEETMATICS_APP_ID",
      "FLEETMATICS_USERNAME",
      "FLEETMATICS_PASSWORD",
      "GPS_WEBHOOK_USER",
      "GPS_WEBHOOK_SECRET",
    ],
    endpoint: "POST /api/webhooks/gps",
    note: "Webhook route is built and Basic-auth protected. Register the endpoint in Reveal (API integrations -> SUBMIT ENDPOINTS -> GPS webhook); the username and password are ours to choose. Polling is the fallback only: there is no fleet-wide endpoint and Verizon asks for no more than one call per vehicle every 3-5 minutes.",
  },
  {
    id: "tachograph",
    name: "Tachograph",
    purpose:
      "Driver duty and driving time, read off the smart tachograph and driver cards.",
    icon: "gavel",
    status: "not_built",
    envVars: ["TACHOGRAPH_API_KEY", "TACHOGRAPH_WEBHOOK_SECRET"],
    endpoint: "POST /api/webhooks/tachograph",
    note: "Reg. (EU) 165/2014. Writes the Reg. 561/2006 counters on drivers. Still needed: Reveal's API exposes PUT Hours of Use but no way to READ tachograph duty, so driver hours cannot come from the GPS provider.",
  },
  {
    id: "customs",
    name: "Customs declarations",
    purpose:
      "Export and import declarations for GB movements, and Windsor Framework lanes for Northern Ireland.",
    icon: "public",
    status: "not_built",
    envVars: ["CUSTOMS_API_KEY", "EORI_NUMBER", "UKIMS_AUTHORISATION"],
    note: "Needed before the first GB or at-risk NI load moves. Intra-EU work needs a CMR note but no declaration.",
  },
  {
    id: "geocoding",
    name: "Geocoding",
    purpose: "Turns street addresses into GEOGRAPHY(POINT, 4326).",
    icon: "location_on",
    status: "not_configured",
    envVars: ["GEOCODING_API_KEY"],
    note: "Google Geocoding or Mapbox; no provider chosen yet.",
  },
  {
    id: "sent-sms",
    name: "Sent SMS",
    purpose: "Dispatch, proximity and delivery alerts over SMS.",
    icon: "sms",
    status: "not_configured",
    envVars: ["SENT_DM_API_KEY", "SENT_SENDER_ID"],
  },
  {
    id: "sent-whatsapp",
    name: "Sent WhatsApp",
    purpose: "The same alerts over WhatsApp Business, where the customer prefers it.",
    icon: "chat",
    status: "not_configured",
    envVars: ["SENT_DM_API_KEY", "SENT_SENDER_ID"],
  },
];

/* --- GDPR / ePrivacy -------------------------------------------------------
   The alerts carry a customer name, phone number, address and timestamp. That
   is personal data, and the settings screen is where the operator records the
   decisions the regulation requires them to have made. */

export interface PrivacySetting {
  id: string;
  label: string;
  value: string;
  basis: string;
  icon: string;
}

export const privacySettings: PrivacySetting[] = [
  {
    id: "lawful_basis",
    label: "Lawful basis for alerts",
    value: "Performance of a contract — Art. 6(1)(b)",
    basis:
      "Delivery alerts are transactional, not marketing, so no prior opt-in is required. Anything promotional would need separate consent.",
    icon: "gavel",
  },
  {
    id: "retention",
    label: "Notification retention",
    value: "90 days, then purged",
    basis:
      "Art. 5(1)(e) storage limitation. A scheduled job deletes notifications rows past the window; idx_notifications_sent_at keeps it cheap.",
    icon: "auto_delete",
  },
  {
    id: "opt_out",
    label: "Opt-out keyword",
    value: "STOP (also STOPP, ARRÊT)",
    basis:
      "A reply sets orders.notifications_opt_out and must be honoured immediately and permanently, across every future order for that number.",
    icon: "notifications_off",
  },
  {
    id: "minimisation",
    label: "Data minimisation",
    value: "Phone + address only",
    basis:
      "Art. 5(1)(c). The CRM webhook must not carry payment details, dates of birth or anything else the delivery does not need.",
    icon: "shield",
  },
  {
    id: "processors",
    label: "Processors",
    value: "Sent (sent.dm), Supabase, Vercel",
    basis:
      "Each needs a data processing agreement. Check the transfer mechanism for any processing outside the EEA.",
    icon: "handshake",
  },
  {
    id: "residency",
    label: "Data residency",
    value: "Compute in dub1 — database not yet pinned",
    basis:
      "Vercel functions are pinned to Dublin (dub1) in vercel.json; the default would have been iad1 in the US. Supabase must still be provisioned in an EU region. UK customer data may also move under the UK GDPR adequacy decision.",
    icon: "database",
  },
];

/** Copy sent to customers, one template per notification type. */
export const messageTemplates: Record<
  NotificationType,
  { trigger: string; body: string }
> = {
  dispatch_confirmation: {
    trigger: "Load assigned and marked en route",
    body: "Your order {{crm_order_id}} has been loaded and is on the way.",
  },
  proximity_alert: {
    trigger: "Truck enters the 5 km geofence around the stop",
    body: "Our driver is approximately 15 minutes away from your location.",
  },
  delivery_complete: {
    trigger: "load_items.delivered_at is set",
    body: "Order {{crm_order_id}} delivered successfully. Thank you.",
  },
};
