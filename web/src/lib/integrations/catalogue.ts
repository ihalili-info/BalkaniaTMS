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
    id: "geotab",
    name: "Geotab",
    purpose:
      "A second telematics option for truck positions, in case the fleet ever needs a provider besides Reveal. No truck is wired to it — today every truck comes from Reveal, and `trucks` has no column for which provider a given truck belongs to.",
    icon: "radar",
    status: "not_built",
    envVars: [
      "GEOTAB_SERVER",
      "GEOTAB_DATABASE",
      "GEOTAB_USERNAME",
      "GEOTAB_PASSWORD",
    ],
    secrets: ["GEOTAB_PASSWORD"],
    endpoint: "POST https://<server>/apiv1 (JSON-RPC, method: Authenticate)",
    note: "MyGeotab has no API-key concept — it authenticates as a MyGeotab user (database + username + password), returning a session id. Geotab's own service-account guidance is to create a dedicated, non-personal login scoped to the lowest security clearance the integration needs (View Only is usually enough for reading positions), rather than reusing a dispatcher's own account. No route or client exists yet.",
    fields: [
      {
        key: "server",
        label: "MyGeotab server",
        kind: "text",
        placeholder: "my.geotab.com",
        help: "Authenticate first against my.geotab.com; the response's `path` names the actual server that database lives on, which belongs here afterwards — Geotab databases are not all on the same host.",
      },
      {
        key: "database",
        label: "Database name",
        kind: "text",
        placeholder: "e.g. balkania_tms",
        help: "The MyGeotab company database — an internal identifier, not a display name. Not a secret.",
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
    envVars: ["SENT_DM_API_KEY"],
    secrets: ["SENT_DM_API_KEY"],
    endpoint: "POST https://api.sent.dm/v3/messages",
    note: "Header-key auth only — `x-api-key: <SENT_DM_API_KEY>`, no sender-profile header and nothing else. Delivery-status receipts are not consumed, so there is no webhook secret.",
    fields: [
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
      {
        key: "template_route_link",
        label: "Driver route template",
        kind: "text",
        help: "Sent template id. Takes one variable, `routeURL` — the single navigation link sent to the driver.",
        placeholder: "c7f9c11f-baad-45f0-b30f-16a3c6005528",
      },
      {
        key: "template_dispatch_confirmation",
        label: "Dispatch confirmation template",
        kind: "text",
        help: "Sent when a load's stop moves to en route — \"loaded and on its way\".",
        placeholder: "fb169e73-5313-43d8-aef5-6dc41ed7bf37",
      },
      {
        key: "template_proximity",
        label: "Proximity alert template",
        kind: "text",
        help: "Sent when the truck enters the 5 km geofence around a stop.",
        placeholder: "41767c8f-db37-4155-b39b-0dab9f467bd9",
      },
      {
        key: "template_delivery_complete",
        label: "Delivery complete template",
        kind: "text",
        help: "Sent once a stop's delivered_at is set.",
        placeholder: "8c42ada4-eceb-45bb-8a80-0d2672aaa2e1",
      },
    ],
  },
  {
    id: "shortio",
    name: "Short.io link shortener",
    purpose:
      "Shortens the navigation URL in a driver route SMS. A multi-stop Google Maps link is ~500 characters and fragments the message — a dropped fragment leaves the driver with a dead link. Optional: without it the full URL is sent.",
    icon: "link",
    status: "not_configured",
    envVars: ["SHORTIO_API_KEY", "SHORTIO_DOMAIN"],
    secrets: ["SHORTIO_API_KEY"],
    endpoint: "POST https://api.short.io/links",
    note: "Auth is the raw API key in the `Authorization` header (not Bearer). `SHORTIO_DOMAIN` is the short domain links are created under — a custom domain or the plan's `*.short.gy` subdomain — and must already exist in the account. Every route link is shortened; re-shortening a URL already in the account returns the existing link without spending quota, so resends are free. Run Test connections after setting it — the driver SMS still carrying the long URL means one of the two values is wrong.",
    fields: [],
  },
  {
    id: "crm",
    name: "CRM ingestion",
    purpose:
      "Receives processed orders from the CRM connector, geocodes the delivery address, and keeps still-pending orders in step with updates and cancellations.",
    icon: "cloud_download",
    status: "not_configured",
    envVars: ["CRM_WEBHOOK_SECRET"],
    secrets: ["CRM_WEBHOOK_SECRET"],
    endpoint: "POST /api/webhooks/crm",
    note: "Bearer auth: the connector sends `Authorization: Bearer CRM_WEBHOOK_SECRET`. Body is `{ \"orders\": [...] }` (or a bare array / single object) using the same fields as the CSV importer — see the contract in lib/crm/payload.ts. An existing order is updated in place only while it is still pending; once it is on a load, updates and cancellations are reported, not applied. The CSV import on the Orders Queue stays for one-off spreadsheets.",
    fields: [
      {
        key: "enabled",
        label: "Accept CRM pushes",
        kind: "toggle",
        help: "A soft switch for the operator's own reference — the route authenticates on CRM_WEBHOOK_SECRET regardless. Turn off while the connector is being reconfigured.",
      },
    ],
  },
  {
    id: "geocoding",
    name: "Geocoding",
    purpose: "Turns street addresses into GEOGRAPHY(POINT, 4326).",
    icon: "location_on",
    status: "not_configured",
    envVars: ["HERE_API_KEY"],
    secrets: ["HERE_API_KEY"],
    endpoint: "GET geocode.search.hereapi.com/v1/geocode",
    note: "Matches coarser than a street are refused, not stored — a town-centre point sits inside the 5 km geofence and would fire the customer alert while the driver is streets away. Refused addresses go to the manual Fix address path. For Irish orders a well-formed Eircode is queried on its own first: an Eircode is a single building, unlike a UK outward code, which is what resolves rural townland addresses.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "select",
        options: [
          { value: "none", label: "None — manual coordinates only" },
          { value: "here", label: "HERE Geocoding & Search" },
        ],
        help: "With none set, addresses are placed by hand from the Orders Queue.",
      },
    ],
  },
  {
    id: "routing",
    name: "Routing & ETA",
    purpose:
      "Road distance and drive time for auto-plan sequencing and live truck ETAs. Falls back to straight-line maths when absent.",
    icon: "route",
    status: "not_configured",
    envVars: ["HERE_API_KEY"],
    secrets: ["HERE_API_KEY"],
    endpoint: "router.hereapi.com/v8/routes · matrix.router.hereapi.com/v8/matrix",
    note: "HGV routing: transportMode=truck, with the vehicle's gross weight, height, length and ADR class, so a route respects the 4.0 m bridge and the weight limit. The live ETA uses the actual truck; auto-plan runs before a truck is assigned and uses a fleet default. This does NOT extend to the driver's phone — Waze, Google Maps and Apple Maps all route cars, which is why the warning still appears at every navigation handoff. Same key as Geocoding, but they are separate services on it: Test connections checks each one.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "select",
        options: [
          { value: "none", label: "None — straight-line distance only" },
          { value: "here", label: "HERE Routing & Matrix Routing" },
        ],
        help: "With none set, auto-plan and ETAs use great-circle distance at a flat 45 km/h.",
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
  geotab: { server: "", database: "" },
  sent: {
    default_channel: "auto",
    retention_days: 90,
    // Seeded with the templates already created in the Sent dashboard, so the
    // integration works before anyone opens this card — override here if a
    // template gets recreated with a new id.
    template_route_link: "c7f9c11f-baad-45f0-b30f-16a3c6005528",
    template_dispatch_confirmation: "fb169e73-5313-43d8-aef5-6dc41ed7bf37",
    template_proximity: "41767c8f-db37-4155-b39b-0dab9f467bd9",
    template_delivery_complete: "8c42ada4-eceb-45bb-8a80-0d2672aaa2e1",
  },
  crm: { enabled: false },
  shortio: {},
  geocoding: { provider: "none" },
  routing: { provider: "none" },
  tachograph: { provider: "" },
  customs: { eori_number: "", ukims_authorisation: "" },
  supabase: {},
};

export function connector(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
