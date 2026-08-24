/**
 * The integration catalogue, and which parts of it are editable in the app.
 *
 * **The boundary that matters: secrets never go in the database.**
 *
 * `integration_settings.config` holds identifiers, endpoints, toggles and
 * tuning — things it is fine to read back, log, or leak in a screenshot. API
 * keys and passwords stay in environment variables, where they are encrypted
 * at rest by the platform, never returned by PostgREST, and never one RLS
 * mistake away from a browser. The app shows whether each secret is *set*, and
 * nothing more.
 *
 * So: an admin can configure the integrations here. They cannot type a
 * password into a web form that writes it to a table.
 */

export type FieldKind = "text" | "number" | "select" | "toggle";

export interface ConnectorField {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  suffix?: string;
}

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
  /** Baseline when nothing has been configured; refined at runtime. */
  status: ConnectorStatus;
  /** Environment variables this connector reads. */
  envVars: string[];
  /**
   * The subset of `envVars` that are genuine secrets. These are never
   * editable and never displayed — only "set" or "not set".
   */
  secrets: string[];
  endpoint?: string;
  note?: string;
  /** Editable, non-secret settings stored in `integration_settings.config`. */
  fields: ConnectorField[];
}

export const CONNECTORS: Connector[] = [
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
    secrets: ["SUPABASE_SERVICE_ROLE_KEY"],
    note: "Connection details are environment-only — changing them here could lock the app out of its own database.",
    fields: [],
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
    secrets: ["FLEETMATICS_PASSWORD", "GPS_WEBHOOK_SECRET"],
    endpoint: "POST /api/webhooks/gps",
    note: "The username and password below are the Reveal INTEGRATION USER from Verizon — not your developer-portal login. Mixing them up is the usual cause of a 401 on the token call. The webhook Basic-auth pair is separate again, and ours to choose.",
    fields: [
      {
        key: "environment",
        label: "API environment",
        kind: "select",
        help: "The segment in fim.api.<env>.fleetmatics.com. Verified as `eu` for this account.",
        options: [
          { value: "eu", label: "EU — fim.api.eu.fleetmatics.com" },
          { value: "us", label: "US — fim.api.us.fleetmatics.com" },
        ],
      },
      {
        key: "app_id",
        label: "Atmosphere App ID",
        kind: "text",
        help: "Developer portal → profile icon → My Apps → your app. Sent as atmosphere_app_id on every data call; without it they return 401. An identifier, not a secret.",
        placeholder: "fleetmatics-p-eu-XXXXXXXX",
      },
      {
        key: "poll_interval_minutes",
        label: "Fallback poll interval",
        kind: "number",
        min: 3,
        max: 60,
        suffix: "min",
        help: "Only used if the push webhook is off. Verizon asks for no more than one call per vehicle every 3–5 minutes, and there is no fleet-wide endpoint — so this costs one call per truck per cycle.",
      },
      {
        key: "push_enabled",
        label: "Use the push webhook",
        kind: "toggle",
        help: "Strongly preferred over polling. Turn off only while debugging.",
      },
    ],
  },
  {
    id: "sent",
    name: "Sent (sent.dm)",
    purpose:
      "Customer alerts over SMS, WhatsApp and RCS through one API, with provider-side channel fallback.",
    icon: "sms",
    status: "not_configured",
    envVars: ["SENT_DM_API_KEY", "SENT_PROFILE_ID", "SENT_WEBHOOK_SECRET"],
    secrets: ["SENT_DM_API_KEY", "SENT_WEBHOOK_SECRET"],
    endpoint: "POST https://api.sent.dm/v3/messages",
    fields: [
      {
        key: "profile_id",
        label: "Sender profile",
        kind: "text",
        help: "Sent as x-profile-id. Only needed for organisation-level keys. Not yet verified against the v3 docs.",
        placeholder: "prof_…",
      },
      {
        key: "default_channel",
        label: "Delivery channel",
        kind: "select",
        help: "Auto omits `channel`, which is what enables cross-channel fallback — one message, one charge. Pinning removes the fallback.",
        options: [
          { value: "auto", label: "Auto — Sent picks, with fallback" },
          { value: "sms", label: "SMS only" },
          { value: "whatsapp", label: "WhatsApp only" },
          { value: "rcs", label: "RCS only" },
        ],
      },
      {
        key: "retention_days",
        label: "Message retention",
        kind: "number",
        min: 7,
        max: 730,
        suffix: "days",
        help: "GDPR Art. 5(1)(e). Notification and driver-message rows are purged past this window.",
      },
    ],
  },
  {
    id: "crm",
    name: "CRM ingestion",
    purpose: "Receives processed orders and geocodes the delivery address.",
    icon: "cloud_download",
    status: "not_built",
    envVars: ["CRM_WEBHOOK_SECRET"],
    secrets: ["CRM_WEBHOOK_SECRET"],
    endpoint: "POST /api/webhooks/crm",
    note: "Route handler not implemented — orders arrive by CSV import until it is.",
    fields: [
      {
        key: "enabled",
        label: "Accept CRM pushes",
        kind: "toggle",
        help: "Leave off until the route exists.",
      },
    ],
  },
  {
    id: "geocoding",
    name: "Geocoding",
    purpose: "Turns street addresses into GEOGRAPHY(POINT, 4326).",
    icon: "location_on",
    status: "not_configured",
    envVars: ["GEOCODING_API_KEY"],
    secrets: ["GEOCODING_API_KEY"],
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "select",
        options: [
          { value: "none", label: "None — manual coordinates only" },
          { value: "google", label: "Google Geocoding" },
          { value: "mapbox", label: "Mapbox" },
        ],
        help: "With none set, addresses are placed by hand from the Orders Queue.",
      },
    ],
  },
  {
    id: "tachograph",
    name: "Tachograph",
    purpose:
      "Driver duty and driving time, read off the smart tachograph and driver cards.",
    icon: "gavel",
    status: "not_built",
    envVars: ["TACHOGRAPH_API_KEY", "TACHOGRAPH_WEBHOOK_SECRET"],
    secrets: ["TACHOGRAPH_API_KEY", "TACHOGRAPH_WEBHOOK_SECRET"],
    endpoint: "POST /api/webhooks/tachograph",
    note: "Reveal cannot supply this — its API offers PUT Hours of Use but no way to read duty. A separate provider is required.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "text",
        placeholder: "Not chosen",
        help: "Whoever supplies the Reg. 561/2006 counters on `drivers`.",
      },
    ],
  },
  {
    id: "customs",
    name: "Customs declarations",
    purpose:
      "Export and import declarations for GB movements, and Windsor Framework lanes for Northern Ireland.",
    icon: "public",
    status: "not_built",
    envVars: ["CUSTOMS_API_KEY"],
    secrets: ["CUSTOMS_API_KEY"],
    fields: [
      {
        key: "eori_number",
        label: "EORI number",
        kind: "text",
        placeholder: "IE1234567A",
        help: "Economic Operators Registration and Identification. A public trading identifier, not a secret.",
      },
      {
        key: "ukims_authorisation",
        label: "UKIMS authorisation",
        kind: "text",
        placeholder: "XIUKIM…",
        help: "UK Internal Market Scheme — what puts an NI movement in the green lane.",
      },
    ],
  },
];

/** Defaults applied when a connector has never been saved. */
export const DEFAULT_CONFIG: Record<string, Record<string, string | number | boolean>> = {
  gps: {
    environment: "eu",
    app_id: "",
    poll_interval_minutes: 5,
    push_enabled: true,
  },
  sent: { profile_id: "", default_channel: "auto", retention_days: 90 },
  crm: { enabled: false },
  geocoding: { provider: "none" },
  tachograph: { provider: "" },
  customs: { eori_number: "", ukims_authorisation: "" },
  supabase: {},
};

export function connector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
