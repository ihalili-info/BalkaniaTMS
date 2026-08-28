import { haversineMeters } from "@/lib/format";
import { routeLeg, routingConfigured } from "@/lib/routing/google";
import { createClient } from "@/lib/supabase/server";
import { customsRegime, HOME_COUNTRY, type CountryCode } from "@/lib/regions";
import type {
  Driver,
  LatLng,
  LoadView,
  NotificationType,
  Order,
  Stop,
  Truck,
} from "@/lib/types";

/**
 * Real reads, replacing the demo fixtures.
 *
 * Server-only by construction — `lib/supabase/server` imports `next/headers`,
 * which is a build error inside a client component.
 *
 * Returns exactly the view-model shapes the pages already render, so switching
 * a page over was an import change rather than a rewrite. Coordinates come
 * from the `*_geo` views (migration 0008) because PostgREST serialises
 * GEOGRAPHY as WKB hex, which is useless in a browser.
 *
 * Every function tolerates an empty database. A new deployment has no trucks,
 * no drivers and no loads, and the screens have to say so rather than break.
 */

type GeoRow = { lat: number | null; lng: number | null };

const point = (row: GeoRow): LatLng | null =>
  row.lat === null || row.lng === null ? null : { lat: row.lat, lng: row.lng };

/* --- trucks ----------------------------------------------------------------- */

export async function getTrucks(): Promise<Truck[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trucks_geo")
    .select("*")
    .order("license_plate");

  if (error) throw new Error(`Could not load trucks: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    license_plate: row.license_plate,
    gps_device_id: row.gps_device_id,
    current_location: point(row),
    location_updated_at: row.location_updated_at,
    label: row.label,
    make_model: row.make_model,
    capacity_kg: row.capacity_kg,
    capacity_m3: row.capacity_m3 === null ? null : Number(row.capacity_m3),
    pallet_slots: row.pallet_slots,
    features: row.features ?? [],
    availability: row.availability,
    availability_note: row.availability_note,
    unavailable_until: row.unavailable_until,
    details_updated_at: row.details_updated_at,
    gross_weight_kg: row.gross_weight_kg,
    height_m: row.height_m === null ? null : Number(row.height_m),
    length_m: row.length_m === null ? null : Number(row.length_m),
    euro_emission_class: row.euro_emission_class,
    adr_classes: row.adr_classes ?? [],
    gps_sequence_id: row.gps_sequence_id,
    last_known_address: row.last_known_address,
  }));
}

/* --- drivers ---------------------------------------------------------------- */

export async function getDrivers(): Promise<Driver[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("drivers")
    .select("*")
    .order("full_name");

  if (error) throw new Error(`Could not load drivers: ${error.message}`);
  return (data ?? []) as Driver[];
}

/* --- orders ----------------------------------------------------------------- */

/** Shape of a row from the `orders_geo` view. */
interface OrderGeoRow extends GeoRow {
  id: string;
  crm_order_id: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  status: Order["status"];
  created_at: string;
  updated_at: string;
  delivery_country: CountryCode | null;
  delivery_postcode: string | null;
  notifications_opt_out: boolean;
  opted_out_at: string | null;
}

function toOrder(row: OrderGeoRow): Order {
  return {
    id: row.id,
    crm_order_id: row.crm_order_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    delivery_address: row.delivery_address,
    delivery_location: point(row),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    delivery_country: row.delivery_country ?? HOME_COUNTRY,
    delivery_postcode: row.delivery_postcode,
    notifications_opt_out: row.notifications_opt_out,
    opted_out_at: row.opted_out_at,
  };
}

export async function getOrders(): Promise<Order[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("orders_geo")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Could not load orders: ${error.message}`);
  return (data ?? []).map(toOrder);
}

/* --- loads ------------------------------------------------------------------ */

/** Which regime governs a load — the most demanding of its destinations. */
const REGIME_RANK: Record<string, number> = {
  domestic: 0,
  intra_eu: 1,
  windsor_green: 2,
  windsor_red: 3,
  gb_import: 4,
  third_country: 5,
};

/**
 * Loads with their stops, truck, driver and per-stop distances.
 *
 * One query with nested selects rather than a query per load — a dispatch
 * board with twenty loads would otherwise make sixty round trips.
 *
 * `routedEtas` adds a real road drive-time for each active load's next stop —
 * one Google Routes call apiece. Off by default because `getLoads()` runs in
 * the dashboard layout on every navigation; only Active Loads and the Live
 * Fleet Map, which actually show an ETA, ask for it.
 */
export async function getLoads(
  { routedEtas = false }: { routedEtas?: boolean } = {},
): Promise<LoadView[]> {
  const supabase = await createClient();

  const [{ data: loadRows, error }, trucks, drivers, orders] = await Promise.all(
    [
      supabase
        .from("loads")
        .select(
          "id, truck_id, status, created_at, driver_id, origin_country, cmr_number, load_items(id, load_id, order_id, stop_sequence, delivered_at)",
        )
        .order("created_at", { ascending: false }),
      getTrucks(),
      getDrivers(),
      getOrders(),
    ],
  );

  if (error) throw new Error(`Could not load loads: ${error.message}`);

  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // Which alerts have fired, so the UI does not have to guess.
  const stopIds = (loadRows ?? []).flatMap((l) =>
    (l.load_items ?? []).map((i: { id: string }) => i.id),
  );
  const sentByStop = new Map<string, NotificationType[]>();
  if (stopIds.length > 0) {
    const { data: notes } = await supabase
      .from("notifications")
      .select("load_item_id, type")
      .in("load_item_id", stopIds);
    for (const n of notes ?? []) {
      const list = sentByStop.get(n.load_item_id) ?? [];
      list.push(n.type as NotificationType);
      sentByStop.set(n.load_item_id, list);
    }
  }

  const views: LoadView[] = (loadRows ?? []).map((row) => {
    const truck = truckById.get(row.truck_id ?? "") ?? null;
    const driver = driverById.get(row.driver_id ?? "") ?? null;

    const stops: Stop[] = (row.load_items ?? [])
      .map((item: {
        id: string;
        load_id: string;
        order_id: string;
        stop_sequence: number;
        delivered_at: string | null;
      }): Stop | null => {
        const order = orderById.get(item.order_id);
        if (!order) return null;
        const distance_m =
          truck?.current_location && order.delivery_location
            ? haversineMeters(truck.current_location, order.delivery_location)
            : null;
        return {
          ...item,
          order,
          distance_m,
          // Filled in below for the next stop of an active load only.
          drive_seconds: null,
          eta_source: "straight_line",
          notifications: sentByStop.get(item.id) ?? [],
        };
      })
      .filter((s): s is Stop => s !== null)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);

    const destination_countries = [
      ...new Set(stops.map((s) => s.order.delivery_country)),
    ];

    const customs_regime =
      destination_countries
        .map((c) => customsRegime(row.origin_country ?? HOME_COUNTRY, c))
        .sort((a, b) => REGIME_RANK[b] - REGIME_RANK[a])[0] ?? "domestic";

    return {
      id: row.id,
      truck_id: row.truck_id,
      status: row.status,
      created_at: row.created_at,
      driver_id: row.driver_id,
      origin_country: row.origin_country ?? HOME_COUNTRY,
      cmr_number: row.cmr_number,
      // Human reference. Derived from the id until the schema carries one.
      reference: `LOAD-${row.id.slice(0, 8).toUpperCase()}`,
      truck,
      driver,
      customs_regime,
      destination_countries,
      stops,
    };
  });

  if (routedEtas) await attachRoutedEtas(views);
  return views;
}

/**
 * Replaces the straight-line ETA with a real road drive-time for the one stop
 * that matters: the next undelivered stop of each *active* load, from where its
 * truck is right now.
 *
 * Deliberately narrow. Routing every stop of every load would be a Google call
 * per stop on every board render; the only ETA a dispatcher acts on is the
 * next one, and only while the truck is actually moving. Planned loads and
 * downstream stops keep the `estimateMinutes()` figure, clearly labelled.
 *
 * Traffic-aware, because this is a live position. Fails soft — any error just
 * leaves `eta_source: "straight_line"`.
 *
 * `distance_m` is left alone — it stays the straight-line figure the Live Fleet
 * Map draws its 5 km ring from. Only `drive_seconds` is added.
 */
async function attachRoutedEtas(views: LoadView[]): Promise<void> {
  if (!routingConfigured()) return;

  const targets = views
    .filter((v) => v.status === "active" && v.truck?.current_location)
    .map((v) => ({
      from: v.truck!.current_location!,
      stop: v.stops.find(
        (s) => s.delivered_at === null && s.order.delivery_location,
      ),
    }))
    .filter((t): t is { from: LatLng; stop: Stop } => t.stop !== undefined);

  await Promise.all(
    targets.map(async ({ from, stop }) => {
      const { leg } = await routeLeg(from, stop.order.delivery_location!, {
        trafficAware: true,
      });
      if (leg) {
        stop.drive_seconds = leg.durationSeconds;
        stop.eta_source = "routed";
      }
    }),
  );
}

/* --- pure selectors ---------------------------------------------------------
   Re-exported so server callers need one import; the definitions live in
   `lib/fleet-selectors` because client components need them too and cannot
   pull in the server Supabase client. */

export {
  GEOFENCE_RADIUS_M,
  APPROACH_ETA_MINUTES,
  activeOf,
  plannedOf,
  loadRefByOrderId,
  loadForTruck,
  loadForDriver,
  nextStop,
  loadProgress,
  stopsInGeofence,
  stopEtaMinutes,
  isApproaching,
} from "../fleet-selectors";

/* --- alert log --------------------------------------------------------------- */

export interface AlertEvent {
  id: string;
  type: NotificationType;
  sent_at: string;
  load_reference: string;
  license_plate: string | null;
  order: Order;
}

export async function getRecentAlerts(
  loads: LoadView[],
  limit = 20,
): Promise<AlertEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("id, load_item_id, type, sent_at")
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (error) return [];

  const stopIndex = new Map(
    loads.flatMap((l) => l.stops.map((s) => [s.id, { load: l, stop: s }])),
  );

  return (data ?? []).flatMap((n) => {
    const found = stopIndex.get(n.load_item_id);
    if (!found) return [];
    return [
      {
        id: n.id,
        type: n.type as NotificationType,
        sent_at: n.sent_at,
        load_reference: found.load.reference,
        license_plate: found.load.truck?.license_plate ?? null,
        order: found.stop.order,
      },
    ];
  });
}
