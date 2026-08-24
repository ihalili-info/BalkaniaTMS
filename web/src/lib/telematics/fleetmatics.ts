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

/**
 * Verified against the live EU tenant on 2026-08-23:
 *   GET https://fim.api.eu.fleetmatics.com/token  ->  200, RS256 JWT
 *   the same call on the `us` host           ->  400 Invalid Login
 * so the environment segment for this account is `eu`.
 */

/* --- token ------------------------------------------------------------------
   `GET /token` with Basic auth returns the token as **plain text**, not JSON.

   Verizon's docs say tokens last 20 minutes. Against the live EU tenant they
   are RS256 JWTs with a 24-hour `exp`, so the documentation is stale. Rather
   than trust either number, the expiry is read from the token itself and the
   documented 20 minutes is kept only as the fallback for a token we cannot
   decode. Refreshing early costs one cheap call; refreshing late costs 401s on
   real position lookups. */

let cached: { token: string; expiresAt: number } | null = null;

/** Fallback only, for a token that is not a decodable JWT. */
const ASSUMED_TTL_MS = 20 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Reads `exp` from a JWT without verifying it — we are the holder, not the verifier. */
function expiryFromJwt(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function getToken(config: FleetmaticsConfig): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const basic = Buffer.from(
    `${config.username}:${config.password}`,
  ).toString("base64");

  const response = await fetch(`${apiBase(config.environment)}/token`, {
    method: "GET",
    headers: {
      // The app id is deliberately absent here — the Token API is the one call
      // that does not take it. Every RAD call afterwards does, and fails 401
      // with "Required Header Parameter Missing: atmosphere_app_id" without it.
      Authorization: `Basic ${basic}`,
      // The Quick Start Guide says application/json here; the sample-code page
      // says text/plain. Tested against the live EU tenant: both return the
      // same bare JWT, never JSON-wrapped. text/plain matches what arrives.
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

  const exp = expiryFromJwt(token);
  cached = {
    token,
    expiresAt: (exp ?? now + ASSUMED_TTL_MS) - REFRESH_MARGIN_MS,
  };
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

/* --- fleet sync: pulling the vehicle list ------------------------------------ */

/**
 * Reveal's vehicle list, from the Customer Meta Data API.
 *
 * `GET /cmd/v1/vehicles` — confirmed to exist on this account by probing
 * (a bogus path returns 404, this returns 401 asking for the app id).
 *
 * The exact response field names are **not publicly documented**, so this is
 * deliberately tolerant: it tries the plausible spellings and hands back the
 * raw record alongside, so the mapping can be confirmed against a real payload
 * instead of assumed. Nothing is written until a human has seen the preview.
 */

export interface RevealVehicle {
  /** The identifier everything keys on. Stored as `trucks.gps_device_id`. */
  vehicleNumber: string;
  name: string | null;
  registration: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
  /** The untouched record, so an unexpected shape is visible rather than lost. */
  raw: Record<string, unknown>;
}

/** Case-insensitive lookup across several candidate keys. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), v]),
  );
  for (const name of names) {
    const hit = lower.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (hit !== undefined && hit !== null && hit !== "") return hit;
  }
  return undefined;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : null;

export function normaliseVehicle(
  row: Record<string, unknown>,
): RevealVehicle | null {
  const vehicleNumber = str(
    pick(row, "VehicleNumber", "Number", "vehicle_number", "VehicleNo", "Id"),
  );
  // Without the Vehicle Number there is nothing for the GPS webhook to match,
  // so the record is useless to us rather than partially useful.
  if (!vehicleNumber) return null;

  const yearRaw = pick(row, "Year", "ModelYear");

  return {
    vehicleNumber,
    name: str(pick(row, "Name", "VehicleName", "Label", "DisplayName")),
    registration: str(
      pick(row, "RegistrationNumber", "Registration", "LicensePlate", "Plate", "Tag"),
    ),
    make: str(pick(row, "Make", "Manufacturer")),
    model: str(pick(row, "Model")),
    year:
      typeof yearRaw === "number"
        ? yearRaw
        : typeof yearRaw === "string" && /^\d{4}$/.test(yearRaw)
          ? Number(yearRaw)
          : null,
    vin: str(pick(row, "VIN", "Vin", "ChassisNumber")),
    raw: row,
  };
}

export interface VehicleFetchResult {
  vehicles: RevealVehicle[];
  /** Records Reveal returned that had no usable Vehicle Number. */
  unusable: number;
  /** First raw record, so an unfamiliar shape can be inspected. */
  sample: Record<string, unknown> | null;
}

export async function fetchVehicles(
  config: FleetmaticsConfig,
): Promise<VehicleFetchResult> {
  const token = await getToken(config);
  const response = await fetch(
    `${apiBase(config.environment)}/cmd/v1/vehicles`,
    {
      headers: {
        Authorization: authHeader(config, token),
        Accept: "application/json",
      },
      cache: "no-store",
    },
  );

  if (response.status === 401) {
    invalidateToken();
    const body = await response.text();
    throw new Error(
      body.includes("atmosphere_app_id")
        ? "Reveal rejected the request: no App ID. Set FLEETMATICS_APP_ID from the developer portal."
        : `Reveal rejected the token (401): ${body.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Reveal vehicle list failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload: unknown = await response.json();

  // Accept a bare array or a wrapped collection — both shapes are common and
  // the docs do not say which this endpoint uses.
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { Vehicles?: unknown[] })?.Vehicles)
      ? (payload as { Vehicles: unknown[] }).Vehicles
      : Array.isArray((payload as { items?: unknown[] })?.items)
        ? (payload as { items: unknown[] }).items
        : [];

  const records = rows.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
  const vehicles = records
    .map(normaliseVehicle)
    .filter((v): v is RevealVehicle => v !== null);

  return {
    vehicles,
    unusable: records.length - vehicles.length,
    sample: records[0] ?? null,
  };
}
