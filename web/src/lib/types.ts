/**
 * Row types mirroring `supabase/migrations/`. Keep these in step with the
 * migrations and with the schema section of `Project BalkaniaTMS.md`.
 *
 * PostGIS `GEOGRAPHY(POINT, 4326)` columns are modelled as `LatLng` — whatever
 * reads them (PostgREST `ST_AsGeoJSON`, an RPC, a view) is responsible for
 * handing back plain lat/lng before it reaches the UI.
 */

import type { CountryCode, CustomsRegime } from "./regions";

export type LatLng = { lat: number; lng: number };

/**
 * One road leg from the routing provider: how far by road and how long behind
 * the wheel. Distinct from `haversineMeters`, which is a straight line and
 * knows nothing about roads, ferries or traffic. Defined here (not in the
 * server-only routing client) so client components can hold one.
 */
export type RouteLeg = { distanceMeters: number; durationSeconds: number };

export type OrderStatus = "pending" | "assigned" | "en_route" | "delivered";
export type LoadStatus = "planned" | "active" | "completed";
export type NotificationType =
  | "dispatch_confirmation"
  | "proximity_alert"
  | "delivery_complete";

/**
 * Dispatcher intent, not derived state. Whether a truck is *busy* comes from
 * `loads`; this says whether it may be given work at all.
 */
export type TruckAvailability = "available" | "unavailable" | "maintenance";

export interface Truck {
  id: string;
  license_plate: string;
  /** Reveal Vehicle Number — the GPS webhook's primary join key. */
  gps_device_id: string;
  /** Reveal device ESN — the webhook's fallback join key (migration 0013). */
  gps_esn: string | null;

  /* --- owned by the telematics feed --- */
  current_location: LatLng | null;
  location_updated_at: string;

  /* --- owned by dispatchers (migration 0002) --- */
  label: string | null;
  make_model: string | null;
  capacity_kg: number | null;
  capacity_m3: number | null;
  pallet_slots: number | null;
  /** Open vocabulary. Known tags are in `lib/truck-features.ts`. */
  features: string[];
  availability: TruckAvailability;
  availability_note: string | null;
  unavailable_until: string | null;
  details_updated_at: string | null;

  /* --- weights, dimensions, emissions (migration 0003) ---
     `capacity_kg` above is payload; this is the regulated gross figure. */
  gross_weight_kg: number | null;
  height_m: number | null;
  length_m: number | null;
  euro_emission_class: number | null;
  /** ADR classes carried, e.g. ["3", "8"]. The `adr` tag says whether. */
  adr_classes: string[];

  /* --- written by the Reveal GPS feed (migration 0006) --- */
  /** Last accepted Reveal SequenceId — the replay/out-of-order guard. */
  gps_sequence_id: number | null;
  /** Reveal reverse-geocodes each fix, so this costs no geocoding call. */
  last_known_address: string | null;
}

/* --- drivers (migration 0003) --------------------------------------------- */

export type DutyStatus =
  | "driving"
  | "break"
  | "rest"
  | "other_work"
  | "available"
  | "off_duty";

export interface Driver {
  id: string;
  full_name: string;
  phone: string | null;
  home_country: CountryCode;
  /** Smart tachograph driver card — Reg. (EU) 165/2014. */
  tachograph_card_no: string | null;
  /** Driver CPC expiry — Directive 2003/59/EC. Lapsed means may not drive. */
  cpc_expires_on: string | null;
  driving_licence_no: string | null;

  /**
   * The truck this driver normally runs (migration 0011).
   *
   * A planning default, not a record of what was driven: the load's own
   * `truck_id` is what the job was actually done in. Nullable because "no
   * vehicle right now" is an ordinary state.
   */
  assigned_truck_id: string | null;
  assigned_at: string | null;

  /* Duty snapshot, overwritten by each tachograph sync (Reg. 561/2006). */
  duty_status: DutyStatus;
  driving_seconds_since_break: number;
  driving_seconds_today: number;
  extended_days_this_week: number;
  driving_seconds_this_week: number;
  duty_synced_at: string | null;
}

/**
 * The two independent facts about a truck, kept apart on purpose: a truck can
 * be booked solid *and* have a dead GPS unit, and a dispatcher needs to see
 * both. Collapsing them into one badge hides whichever loses the tie-break.
 */
export type TruckDuty = "on_load" | "available" | "unavailable" | "maintenance";
export type TruckSignal = "live" | "stale" | "no_fix";

export interface Order {
  id: string;
  crm_order_id: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_location: LatLng | null;
  status: OrderStatus;
  created_at: string;
  updated_at: string;

  /* --- destination and consent (migration 0003) --- */
  delivery_country: CountryCode;
  delivery_postcode: string | null;
  /** ePrivacy: a STOP reply. Nothing may be sent while this is true. */
  notifications_opt_out: boolean;
  opted_out_at: string | null;
}

export interface Load {
  id: string;
  truck_id: string | null;
  status: LoadStatus;
  created_at: string;

  /* --- migration 0003 --- */
  driver_id: string | null;
  origin_country: CountryCode;
  /** CMR consignment note — required for international carriage by road. */
  cmr_number: string | null;
}

export interface LoadItem {
  id: string;
  load_id: string;
  order_id: string;
  stop_sequence: number;
  delivered_at: string | null;
}

export interface NotificationLog {
  id: string;
  load_item_id: string;
  type: NotificationType;
  sent_at: string;
}

/* --- View models -----------------------------------------------------------
   Shapes the UI actually renders, i.e. the joins from the geofence query in
   the architecture doc, pre-resolved. */

export interface Stop extends LoadItem {
  order: Order;
  /** Straight-line metres from the assigned truck, as `ST_Distance` returns. */
  distance_m: number | null;
  /**
   * Road drive-time from the assigned truck to this stop, in seconds, when the
   * routing provider answered. Only ever populated for a load's *next*
   * undelivered stop — that is the only ETA a dispatcher acts on, and routing
   * every stop of every load is needless spend.
   */
  drive_seconds: number | null;
  /**
   * Where the approach figures came from. `"routed"` means `drive_seconds` and
   * a road distance are real; `"straight_line"` means everything is
   * great-circle and `estimateMinutes()` — a planning aid, never alert-grade.
   */
  eta_source: "routed" | "straight_line";
  notifications: NotificationType[];
}

export interface LoadView extends Load {
  /** Human reference shown in the UI, e.g. `LOAD-1042`. Derived, not stored. */
  reference: string;
  truck: Truck | null;
  /** Resolved from `loads.driver_id` — a real row since migration 0003. */
  driver: Driver | null;
  /** Customs position of the movement, derived from origin and destinations. */
  customs_regime: CustomsRegime;
  /** Every distinct destination country on this load. */
  destination_countries: CountryCode[];
  stops: Stop[];
}
