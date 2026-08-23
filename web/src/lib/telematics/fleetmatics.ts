/**
 * Verizon Connect Reveal (formerly Fleetmatics) — the fleet's GPS provider.
 *
 * Two ways in, and the choice matters:
 *
 *  · **GPS webhook (push)** — Verizon POSTs each position to an endpoint we
 *    register. This is the path to use. Authentication on the inbound request
 *    is HTTP Basic with a username and password *we* choose and hand to
 *    Verizon. Registering the endpoint is not self-serve: it goes through the
 *    Reveal UI (API integrations → SUBMIT ENDPOINTS → GPS webhook) or Verizon
 *    support.
 *
 *  · **RAD REST API (pull)** — `GET /rad/v1/vehicles/{vehicleNumber}/location`.
 *    Fallback only, because of two hard limits documented by Verizon:
 *      1. there is **no fleet-wide endpoint** — it is one HTTP call per
 *         vehicle, per poll;
 *      2. Verizon recommends **not polling a vehicle more often than every
 *         3–5 minutes**.
 *    That, not Vercel Cron's one-minute floor, is the binding constraint on
 *    how fresh polled positions can be.
 *
 * Verified against Verizon's own docs (August 2026):
 *   https://fim.eu.fleetmatics.com/content/home/support/samplecode/GET_Token.htm
 *   https://fim.eu.fleetmatics.com/content/home/support/samplecode/GET_Vehicle_Location.htm
 */

/* --- configuration ---------------------------------------------------------- */

export interface FleetmaticsConfig {
  /** `eu` for this account — the FIM portal is fim.eu.fleetmatics.com. */
  environment: string;
  appId: string;
  username: string;
  password: string;
}

export function readConfig(): FleetmaticsConfig | null {
  const appId = process.env.FLEETMATICS_APP_ID;
  const username = process.env.FLEETMATICS_USERNAME;
  const password = process.env.FLEETMATICS_PASSWORD;
  if (!appId || !username || !password) return null;
  return {
    environment: process.env.FLEETMATICS_ENV ?? "eu",
    appId,
    username,
    password,
  };
}

const apiBase = (environment: string) =>
  `https://fim.api.${environment}.fleetmatics.com`;

/** Verizon's guidance, in milliseconds. Do not poll a vehicle faster. */
export const MIN_POLL_INTERVAL_MS = 3 * 60_000;

/* --- token ------------------------------------------------------------------
   `GET /token` with Basic auth returns the token as **plain text**, not JSON,
   and it expires after 20 minutes. Cached in module scope and refreshed early;
   on a serverless platform each cold instance fetches its own, which is fine —
   the alternative is a shared cache for a string that lives 20 minutes. */

let cached: { token: string; expiresAt: number } | null = null;

const TOKEN_TTL_MS = 20 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;

export async function getToken(config: FleetmaticsConfig): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const basic = Buffer.from(
    `${config.username}:${config.password}`,
  ).toString("base64");

  const response = await fetch(`${apiBase(config.environment)}/token`, {
    method: "GET",
    headers: {
      // The app id is deliberately absent here — Verizon documents the Token
      // API as the one call that does not take it.
      Authorization: `Basic ${basic}`,
      Accept: "text/plain",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Fleetmatics token request failed: ${response.status} ${response.statusText}`,
    );
  }

  const token = (await response.text()).trim();
  if (token === "") throw new Error("Fleetmatics returned an empty token");

  cached = { token, expiresAt: now + TOKEN_TTL_MS - REFRESH_MARGIN_MS };
  return token;
}

/** Clears the cache — call when a request comes back 401. */
export function invalidateToken(): void {
  cached = null;
}

function authHeader(config: FleetmaticsConfig, token: string): string {
  // Exact format from Verizon's sample code; the comma and spacing matter.
  return `Atmosphere atmosphere_app_id=${config.appId}, Bearer ${token}`;
}

/* --- pull: one vehicle at a time --------------------------------------------- */

/**
 * `vehicleNumber` is Reveal's **Vehicle Number**, not the device serial.
 * Verizon's docs warn it is not populated automatically when an account is
 * created — someone has to set it per vehicle in Reveal. It is what
 * `trucks.gps_device_id` stores.
 */
export async function fetchVehicleLocation(
  config: FleetmaticsConfig,
  vehicleNumber: string,
): Promise<unknown> {
  const token = await getToken(config);
  const url = `${apiBase(config.environment)}/rad/v1/vehicles/${encodeURIComponent(vehicleNumber)}/location`;

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader(config, token),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (response.status === 401) {
    invalidateToken();
    throw new Error("Fleetmatics rejected the token (401)");
  }
  if (!response.ok) {
    throw new Error(
      `Fleetmatics location request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

/* --- push: the GPS webhook payload ------------------------------------------- */

/**
 * The GPS Push Service message. Schema is fixed by Verizon and cannot be
 * changed on their side, so this mirrors it rather than reshaping it.
 *
 * Everything is optional in practice: a position taken with no driver signed
 * in has no `Driver`, and reverse geocoding can fail, leaving `Address` empty.
 */
export interface FleetmaticsGpsPush {
  SequenceId?: number | string;
  UpdateUTC?: string;
  DeviceTimeZoneOffset?: number;
  DisplayState?: string;
  SpeedKmph?: number;
  DirectionDegrees?: number;
  Latitude?: number;
  Longitude?: number;
  OdometerKm?: number;
  Vehicle?: {
    Number?: string;
    Name?: string;
    VIN?: string;
    ESN?: string;
  };
  Address?: {
    AddressLine1?: string;
    Locality?: string;
    PostalCode?: string;
    AdministrativeArea?: string;
    Country?: string;
  };
  Driver?: {
    DriverNumber?: string;
    DriverFirstName?: string;
    DriverLastName?: string;
  };
}

/** What the app actually stores, once a push has been validated. */
export interface VehicleFix {
  vehicleNumber: string;
  lat: number;
  lng: number;
  recordedAt: string;
  /** Monotonic per vehicle — used to discard out-of-order deliveries. */
  sequenceId: number | null;
  speedKmph: number | null;
  headingDegrees: number | null;
  odometerKm: number | null;
  displayState: string | null;
  /** Verizon reverse-geocodes for us, so this costs no geocoding call. */
  address: string | null;
  driverNumber: string | null;
}

export type NormaliseResult =
  | { ok: true; fix: VehicleFix }
  | { ok: false; reason: string };

/**
 * Validates and flattens one push message.
 *
 * Rejects rather than coerces: a position without a vehicle number cannot be
 * matched to a truck, and `0,0` in the Gulf of Guinea is the classic
 * null-island artefact of a device with no fix, not a delivery in the Atlantic.
 */
export function normaliseGpsPush(payload: FleetmaticsGpsPush): NormaliseResult {
  const vehicleNumber = payload.Vehicle?.Number?.trim();
  if (!vehicleNumber) return { ok: false, reason: "missing Vehicle.Number" };

  const { Latitude: lat, Longitude: lng } = payload;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return { ok: false, reason: "missing or non-numeric coordinates" };
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ok: false, reason: "coordinates out of range" };
  }
  if (lat === 0 && lng === 0) {
    return { ok: false, reason: "null island (0,0) — device has no fix" };
  }

  const recordedAt = parseUpdateUtc(payload.UpdateUTC);
  if (!recordedAt) return { ok: false, reason: "missing or unparseable UpdateUTC" };

  const address = [
    payload.Address?.AddressLine1,
    payload.Address?.Locality,
    payload.Address?.PostalCode,
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");

  return {
    ok: true,
    fix: {
      vehicleNumber,
      lat,
      lng,
      recordedAt,
      sequenceId: toSequence(payload.SequenceId),
      speedKmph: numberOrNull(payload.SpeedKmph),
      headingDegrees: numberOrNull(payload.DirectionDegrees),
      odometerKm: numberOrNull(payload.OdometerKm),
      displayState: payload.DisplayState?.trim() || null,
      address: address === "" ? null : address,
      driverNumber: payload.Driver?.DriverNumber?.trim() || null,
    },
  };
}

/**
 * `UpdateUTC` arrives as a string. Verizon has used a `/Date(…)/` form in
 * places as well as ISO-8601, so both are accepted; anything else is rejected
 * rather than silently becoming `now`, which would make a stale fix look fresh.
 */
function parseUpdateUtc(raw: string | undefined): string | null {
  if (!raw) return null;

  const dotNet = /^\/Date\((-?\d+)/.exec(raw);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  // A bare timestamp with no zone designator is UTC, as the field name says.
  const candidate = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSequence(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Whether an incoming fix should overwrite what is already stored.
 *
 * Webhook deliveries are HTTP POSTs over the public internet: they retry, they
 * duplicate, and they arrive out of order. Writing blindly means a truck
 * occasionally jumps backwards on the live map. `SequenceId` is the intended
 * guard; `recordedAt` is the fallback when it is absent.
 */
export function isNewerFix(
  incoming: Pick<VehicleFix, "sequenceId" | "recordedAt">,
  stored: Pick<VehicleFix, "sequenceId" | "recordedAt"> | null,
): boolean {
  if (!stored) return true;

  if (incoming.sequenceId !== null && stored.sequenceId !== null) {
    return incoming.sequenceId > stored.sequenceId;
  }
  return (
    new Date(incoming.recordedAt).getTime() >
    new Date(stored.recordedAt).getTime()
  );
}
