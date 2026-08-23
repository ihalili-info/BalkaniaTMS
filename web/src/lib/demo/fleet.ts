/**
 * Demo fixtures — the only data source in the app until Supabase is wired up.
 *
 * The operation is Ireland-based, running domestic work plus cross-border into
 * Northern Ireland, Great Britain and mainland Europe. Country is always an
 * explicit code (see `lib/regions.ts`), never assumed, so the fixtures already
 * exercise the customs and vehicle-limit paths the real expansion will need.
 *
 * Shapes match `src/lib/types.ts` (and therefore the migrations) exactly, so
 * swapping this module for real queries is a per-page import change, not a
 * rewrite. Distances use the same haversine the geofence check approximates,
 * and every timestamp is anchored to `DEMO_NOW` rather than `Date.now()` so
 * server and client render identical strings.
 */

import { haversineMeters } from "../format";
import { customsRegime, type CountryCode } from "../regions";
import type {
  Driver,
  DutyStatus,
  LatLng,
  Load,
  LoadItem,
  LoadStatus,
  LoadView,
  NotificationType,
  Order,
  OrderStatus,
  Stop,
  Truck,
} from "../types";

/** Fixed clock for the fixtures. Real code should use `new Date()`. */
export const DEMO_NOW = new Date("2026-08-23T09:12:00.000Z");

/** Geofence radius from the architecture doc: alert inside 5 km. */
export const GEOFENCE_RADIUS_M = 5_000;

const minsAgo = (m: number) =>
  new Date(DEMO_NOW.getTime() - m * 60_000).toISOString();

const H = 3_600;

export const CITIES = {
  dublin: { lat: 53.3498, lng: -6.2603 },
  cork: { lat: 51.8985, lng: -8.4756 },
  limerick: { lat: 52.6638, lng: -8.6267 },
  galway: { lat: 53.2707, lng: -9.0568 },
  waterford: { lat: 52.2593, lng: -7.1101 },
  drogheda: { lat: 53.7179, lng: -6.3561 },
  dundalk: { lat: 54.0019, lng: -6.4058 },
  athlone: { lat: 53.4239, lng: -7.9407 },
  sligo: { lat: 54.2766, lng: -8.4761 },
  kilkenny: { lat: 52.6541, lng: -7.2448 },
  wexford: { lat: 52.3369, lng: -6.4633 },
  tralee: { lat: 52.2713, lng: -9.7016 },
  belfast: { lat: 54.5973, lng: -5.9301 },
  derry: { lat: 54.9966, lng: -7.3086 },
  rosslare: { lat: 52.2506, lng: -6.3378 },
  holyhead: { lat: 53.309, lng: -4.633 },
} satisfies Record<string, LatLng>;

/** Which jurisdiction each place sits in — drives the customs derivation. */
export const CITY_COUNTRY: Record<keyof typeof CITIES, CountryCode> = {
  dublin: "IE",
  cork: "IE",
  limerick: "IE",
  galway: "IE",
  waterford: "IE",
  drogheda: "IE",
  dundalk: "IE",
  athlone: "IE",
  sligo: "IE",
  kilkenny: "IE",
  wexford: "IE",
  tralee: "IE",
  belfast: "XI",
  derry: "XI",
  rosslare: "IE",
  holyhead: "GB",
};

/** Home terminal — origin of every load. */
export const DEPOT = {
  name: "Ballymount Terminal, Dublin 12",
  country: "IE" as CountryCode,
  lat: 53.3195,
  lng: -6.352,
};

const nudge = (p: LatLng, dLat: number, dLng: number): LatLng => ({
  lat: +(p.lat + dLat).toFixed(4),
  lng: +(p.lng + dLng).toFixed(4),
});

/* --- drivers ---------------------------------------------------------------
   Duty counters are the Reg. 561/2006 figures a tachograph sync would write. */

type DriverSeed = {
  id: string;
  name: string;
  phone: string;
  country: CountryCode;
  card: string;
  cpcMonths: number;
  status: DutyStatus;
  sinceBreakH: number;
  todayH: number;
  weekH: number;
  extendedDays?: number;
};

const driverSeeds: DriverSeed[] = [
  {
    id: "drv-01",
    name: "Declan Murphy",
    phone: "+353 87 412 6690",
    country: "IE",
    card: "IE-DC-004182-33",
    cpcMonths: 19,
    status: "driving",
    sinceBreakH: 4.1, // break falls due within the half hour — shows the warning
    todayH: 6.2,
    weekH: 38.5,
  },
  {
    id: "drv-02",
    name: "Aoife Byrne",
    phone: "+353 86 330 5518",
    country: "IE",
    card: "IE-DC-007744-08",
    cpcMonths: 31,
    status: "driving",
    sinceBreakH: 1.4,
    todayH: 3.1,
    weekH: 22.0,
  },
  {
    id: "drv-03",
    name: "Tomasz Kowalski",
    phone: "+353 83 118 2047",
    country: "PL",
    card: "PL-DC-991205-61",
    cpcMonths: 2, // CPC lapses inside the quarter — dispatch needs the warning
    status: "driving",
    sinceBreakH: 2.6,
    todayH: 8.9, // on a 10h extension, close to the ceiling
    weekH: 49.5,
    extendedDays: 1,
  },
  {
    id: "drv-04",
    name: "Ciara Walsh",
    phone: "+353 85 907 3364",
    country: "IE",
    card: "IE-DC-005530-72",
    cpcMonths: 26,
    status: "available",
    sinceBreakH: 0,
    todayH: 0,
    weekH: 17.25,
  },
  {
    id: "drv-05",
    name: "Pádraig Nolan",
    phone: "+353 87 664 1129",
    country: "IE",
    card: "IE-DC-002917-45",
    cpcMonths: 11,
    status: "break",
    sinceBreakH: 0,
    todayH: 4.6,
    weekH: 44.0,
    extendedDays: 2, // both weekly extensions spent — capped at 9h
  },
  {
    id: "drv-06",
    name: "Seán Ó Braonáin",
    phone: "+353 86 225 8890",
    country: "IE",
    card: "IE-DC-008801-19",
    cpcMonths: 40,
    status: "off_duty",
    sinceBreakH: 0,
    todayH: 0,
    weekH: 31.75,
  },
];

const addMonths = (from: Date, months: number) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

export const drivers: Driver[] = driverSeeds.map((d) => ({
  id: d.id,
  full_name: d.name,
  phone: d.phone,
  home_country: d.country,
  tachograph_card_no: d.card,
  cpc_expires_on: addMonths(DEMO_NOW, d.cpcMonths),
  driving_licence_no: null,
  duty_status: d.status,
  driving_seconds_since_break: Math.round(d.sinceBreakH * H),
  driving_seconds_today: Math.round(d.todayH * H),
  extended_days_this_week: d.extendedDays ?? 0,
  driving_seconds_this_week: Math.round(d.weekH * H),
  duty_synced_at: minsAgo(3),
}));

const driverById = new Map(drivers.map((d) => [d.id, d]));

/* --- trucks --------------------------------------------------------------- */

type TruckSeed = {
  id: string;
  plate: string;
  device: string;
  label: string;
  makeModel: string;
  kg: number;
  gross: number;
  m3: number;
  pallets: number;
  heightM: number;
  lengthM: number;
  euro: number;
  features: string[];
  adrClasses?: string[];
  at: LatLng | null;
  fixAgeMin: number;
  availability?: Truck["availability"];
  note?: string;
  outForDays?: number;
};

const truckSeeds: TruckSeed[] = [
  {
    id: "trk-01",
    plate: "231-D-45102",
    device: "GPS-IE-1041",
    label: "Reefer 1",
    makeModel: "Scania R 450 + Chereau reefer",
    kg: 24_500,
    gross: 44_000,
    m3: 86,
    pallets: 33,
    // Legal in IE/UK, over the 4.00 m limit almost everywhere on the continent.
    heightM: 4.62,
    lengthM: 16.5,
    euro: 6,
    features: ["reefer", "atp", "temp_logger", "tail_lift"],
    at: nudge(CITIES.cork, 0.032, 0.019),
    fixAgeMin: 1,
  },
  {
    id: "trk-02",
    plate: "241-D-11876",
    device: "GPS-IE-1042",
    label: "Curtain 2",
    makeModel: "Volvo FH 460 + Schmitz curtainsider",
    kg: 24_000,
    gross: 44_000,
    m3: 90,
    pallets: 34,
    heightM: 4.0,
    lengthM: 16.5,
    euro: 6,
    features: ["curtainside", "pallet_truck"],
    at: nudge(CITIES.galway, 0.09, 0.52),
    fixAgeMin: 2,
  },
  {
    id: "trk-03",
    plate: "222-LH-8840",
    device: "GPS-IE-2210",
    label: "Continental 3",
    makeModel: "Mercedes-Benz Actros 1851",
    kg: 24_000,
    gross: 40_000,
    m3: 92,
    pallets: 34,
    heightM: 4.0,
    lengthM: 16.5,
    euro: 6,
    features: ["curtainside", "two_drivers", "adr", "cmr_ready"],
    adrClasses: ["3", "8", "9"],
    at: nudge(CITIES.dublin, 0.24, -0.043),
    fixAgeMin: 3,
  },
  {
    id: "trk-04",
    plate: "232-D-30914",
    device: "GPS-IE-1043",
    label: "Box 4",
    makeModel: "DAF CF 290 rigid",
    kg: 11_000,
    gross: 18_000,
    m3: 52,
    pallets: 20,
    heightM: 3.9,
    lengthM: 10.2,
    euro: 6,
    features: ["box_body", "tail_lift"],
    at: DEPOT,
    fixAgeMin: 6,
  },
  {
    id: "trk-05",
    plate: "241-MH-2277",
    device: "GPS-IE-3307",
    label: "Reefer 5",
    makeModel: "Renault T High 480 + Krone reefer",
    kg: 23_000,
    gross: 44_000,
    m3: 80,
    pallets: 32,
    heightM: 4.55,
    lengthM: 16.5,
    euro: 6,
    features: ["reefer", "atp", "temp_logger"],
    at: nudge(CITIES.belfast, -0.31, -0.28),
    fixAgeMin: 2,
  },
  {
    // Out on both axes at once: flagged for service AND its tracker is quiet.
    id: "trk-06",
    plate: "212-C-6633",
    device: "GPS-IE-1044",
    label: "Rigid 6",
    makeModel: "Iveco Eurocargo 120E",
    kg: 7_200,
    gross: 12_000,
    m3: 38,
    pallets: 16,
    heightM: 3.8,
    lengthM: 9.4,
    euro: 5,
    features: ["box_body", "tail_lift", "crane"],
    at: null,
    fixAgeMin: 214,
    availability: "maintenance",
    note: "DOE test and tacho calibration booked at Ballymount",
    outForDays: 3,
  },
];

export const trucks: Truck[] = truckSeeds.map((t) => ({
  id: t.id,
  license_plate: t.plate,
  gps_device_id: t.device,
  current_location: t.at,
  location_updated_at: minsAgo(t.fixAgeMin),
  label: t.label,
  make_model: t.makeModel,
  capacity_kg: t.kg,
  capacity_m3: t.m3,
  pallet_slots: t.pallets,
  features: t.features,
  availability: t.availability ?? "available",
  availability_note: t.note ?? null,
  unavailable_until:
    t.outForDays === undefined
      ? null
      : new Date(
          DEMO_NOW.getTime() + t.outForDays * 24 * 60 * 60_000,
        ).toISOString(),
  details_updated_at: minsAgo(t.availability ? 45 : 2_880),
  gross_weight_kg: t.gross,
  height_m: t.heightM,
  length_m: t.lengthM,
  euro_emission_class: t.euro,
  adr_classes: t.adrClasses ?? [],
}));

/* --- orders --------------------------------------------------------------- */

type OrderSeed = {
  crm: string;
  customer: string;
  phone: string;
  address: string;
  postcode: string | null;
  country: CountryCode;
  at: LatLng | null;
  status: OrderStatus;
  ageMin: number;
  optedOut?: boolean;
};

const orderSeeds: OrderSeed[] = [
  // LOAD-1042 · Munster run
  { crm: "CRM-24188", customer: "Cork Harbour Supplies", phone: "+353 21 431 8802", address: "Unit 4, Little Island Business Park, Cork", postcode: "T45 KX21", country: "IE", at: CITIES.cork, status: "en_route", ageMin: 340 },
  { crm: "CRM-24191", customer: "Lee Valley Foods", phone: "+353 87 220 4417", address: "Kinsale Road Industrial Estate, Cork", postcode: "T12 R6VE", country: "IE", at: nudge(CITIES.cork, 0.021, -0.014), status: "en_route", ageMin: 336 },
  { crm: "CRM-24193", customer: "Blarney Wholesale", phone: "+353 86 771 0093", address: "Station Road, Blarney, Co. Cork", postcode: "T23 HW67", country: "IE", at: nudge(CITIES.cork, 0.09, -0.06), status: "delivered", ageMin: 334 },
  { crm: "CRM-24196", customer: "Mallow Agri Stores", phone: "+353 22 421 7788", address: "Bridge Street, Mallow, Co. Cork", postcode: "P51 NX02", country: "IE", at: nudge(CITIES.cork, 0.24, 0.02), status: "en_route", ageMin: 330 },

  // LOAD-1041 · Connacht run
  { crm: "CRM-24175", customer: "Atlantic Seafoods", phone: "+353 91 755 2210", address: "Ballybrit Business Park, Galway", postcode: "H91 T2YF", country: "IE", at: CITIES.galway, status: "delivered", ageMin: 420 },
  { crm: "CRM-24179", customer: "Shannon Freight Services", phone: "+353 61 470 3318", address: "Raheen Business Park, Limerick", postcode: "V94 XD27", country: "IE", at: CITIES.limerick, status: "en_route", ageMin: 412 },
  { crm: "CRM-24182", customer: "Midlands Builders Providers", phone: "+353 90 649 8114", address: "Monksland, Athlone, Co. Roscommon", postcode: "N37 KP89", country: "IE", at: CITIES.athlone, status: "assigned", ageMin: 405 },

  // LOAD-1040 · Northern Ireland — Windsor Framework
  { crm: "CRM-24160", customer: "Lagan Retail Group", phone: "+44 28 9032 7741", address: "Duncrue Industrial Estate, Belfast", postcode: "BT3 9BP", country: "XI", at: CITIES.belfast, status: "delivered", ageMin: 640 },
  { crm: "CRM-24163", customer: "Antrim Cold Store", phone: "+44 28 9446 2205", address: "Junction One Business Park, Antrim", postcode: "BT41 4LZ", country: "XI", at: nudge(CITIES.belfast, 0.16, -0.28), status: "en_route", ageMin: 634 },
  { crm: "CRM-24168", customer: "Foyle Provisions", phone: "+44 28 7134 6690", address: "Springtown Industrial Estate, Derry", postcode: "BT48 0LY", country: "XI", at: CITIES.derry, status: "assigned", ageMin: 628 },

  // LOAD-1043 · Leinster
  { crm: "CRM-24201", customer: "Boyne Valley Foods", phone: "+353 41 983 4412", address: "Donore Road Industrial Estate, Drogheda", postcode: "A92 KF8H", country: "IE", at: CITIES.drogheda, status: "en_route", ageMin: 210 },
  { crm: "CRM-24204", customer: "Dundalk Distribution", phone: "+353 42 933 7026", address: "Coes Road Industrial Estate, Dundalk", postcode: "A91 PW53", country: "IE", at: CITIES.dundalk, status: "en_route", ageMin: 205 },

  // LOAD-1044 · planned, GB run via Holyhead
  { crm: "CRM-24219", customer: "Anglesey Trade Supplies", phone: "+44 7700 900412", address: "Kingsland Industrial Estate, Holyhead", postcode: "LL65 2XA", country: "GB", at: CITIES.holyhead, status: "assigned", ageMin: 96 },
  { crm: "CRM-24221", customer: "Menai Building Merchants", phone: "+44 7700 900873", address: "Llangefni Industrial Estate, Anglesey", postcode: "LL77 7JA", country: "GB", at: nudge(CITIES.holyhead, -0.09, 0.31), status: "assigned", ageMin: 92 },

  // LOAD-1039 · completed, south-east
  { crm: "CRM-24101", customer: "Suir Valley Produce", phone: "+353 51 378 2204", address: "Six Cross Roads Business Park, Waterford", postcode: "X91 PK50", country: "IE", at: CITIES.waterford, status: "delivered", ageMin: 1_580 },
  { crm: "CRM-24104", customer: "Kilkenny Catering Supplies", phone: "+353 56 776 3018", address: "Purcellsinch Industrial Park, Kilkenny", postcode: "R95 X264", country: "IE", at: CITIES.kilkenny, status: "delivered", ageMin: 1_575 },
  { crm: "CRM-24107", customer: "Wexford Fresh Produce", phone: "+353 53 912 0991", address: "Whitemill Industrial Estate, Wexford", postcode: "Y35 R6C4", country: "IE", at: CITIES.wexford, status: "delivered", ageMin: 1_570 },

  // Unassigned queue
  { crm: "CRM-24226", customer: "Naas Motor Factors", phone: "+353 45 879 2205", address: "Monread Industrial Estate, Naas, Co. Kildare", postcode: "W91 YH27", country: "IE", at: nudge(CITIES.dublin, -0.14, -0.42), status: "pending", ageMin: 48 },
  // Opted out of alerts — a STOP reply must be honoured permanently.
  { crm: "CRM-24228", customer: "Swords Beverages", phone: "+353 1 890 6613", address: "Airside Business Park, Swords, Co. Dublin", postcode: "K67 D5W8", country: "IE", at: nudge(CITIES.dublin, 0.11, 0.03), status: "pending", ageMin: 41, optedOut: true },
  { crm: "CRM-24231", customer: "Liffey Retail Group", phone: "+353 87 660 9130", address: "Park West Business Park, Dublin 12", postcode: "D12 F5P2", country: "IE", at: nudge(CITIES.dublin, -0.02, -0.09), status: "pending", ageMin: 33 },
  { crm: "CRM-24233", customer: "Tralee Farm Supplies", phone: "+353 66 712 3085", address: "Monavalley Industrial Estate, Tralee", postcode: "V92 HW64", country: "IE", at: CITIES.tralee, status: "pending", ageMin: 24 },
  // Geocoding failed — the doc says flag for manual correction, never drop.
  { crm: "CRM-24236", customer: "Glenties Stone", phone: "+353 74 955 1447", address: "Townland of Meenaboll, Glenties, Co. Donegal", postcode: null, country: "IE", at: null, status: "pending", ageMin: 17 },
  { crm: "CRM-24238", customer: "Sligo Textiles", phone: "+353 71 914 7610", address: "Finisklin Business Park, Sligo", postcode: "F91 KD82", country: "IE", at: CITIES.sligo, status: "pending", ageMin: 9 },
];

export const orders: Order[] = orderSeeds.map((s, i) => ({
  id: `ord-${String(i + 1).padStart(2, "0")}`,
  crm_order_id: s.crm,
  customer_name: s.customer,
  customer_phone: s.phone,
  delivery_address: s.address,
  delivery_location: s.at,
  status: s.status,
  created_at: minsAgo(s.ageMin),
  updated_at: minsAgo(Math.max(1, Math.round(s.ageMin / 4))),
  delivery_country: s.country,
  delivery_postcode: s.postcode,
  notifications_opt_out: s.optedOut ?? false,
  opted_out_at: s.optedOut ? minsAgo(Math.round(s.ageMin / 2)) : null,
}));

const byCrm = new Map(orders.map((o) => [o.crm_order_id, o]));

const orderFor = (crm: string): Order => {
  const found = byCrm.get(crm);
  if (!found) throw new Error(`demo fixture references unknown order ${crm}`);
  return found;
};

/* --- loads ---------------------------------------------------------------- */

type LoadSeed = {
  ref: string;
  truckId: string;
  driverId: string;
  status: LoadStatus;
  ageMin: number;
  cmr?: string;
  /** NI only: goods at risk of onward EU movement take the red lane. */
  atRisk?: boolean;
  stops: { crm: string; deliveredAgoMin?: number }[];
};

const loadSeeds: LoadSeed[] = [
  {
    ref: "LOAD-1042",
    truckId: "trk-01",
    driverId: "drv-01",
    status: "active",
    ageMin: 300,
    stops: [
      { crm: "CRM-24193", deliveredAgoMin: 52 },
      { crm: "CRM-24191" },
      { crm: "CRM-24188" },
      { crm: "CRM-24196" },
    ],
  },
  {
    ref: "LOAD-1041",
    truckId: "trk-02",
    driverId: "drv-02",
    status: "active",
    ageMin: 390,
    stops: [
      { crm: "CRM-24175", deliveredAgoMin: 118 },
      { crm: "CRM-24179" },
      { crm: "CRM-24182" },
    ],
  },
  {
    ref: "LOAD-1040",
    truckId: "trk-05",
    driverId: "drv-03",
    status: "active",
    ageMin: 600,
    cmr: "CMR-IE-0084412",
    stops: [
      { crm: "CRM-24160", deliveredAgoMin: 164 },
      { crm: "CRM-24163" },
      { crm: "CRM-24168" },
    ],
  },
  {
    ref: "LOAD-1043",
    truckId: "trk-03",
    driverId: "drv-05",
    status: "active",
    ageMin: 190,
    stops: [{ crm: "CRM-24201" }, { crm: "CRM-24204" }],
  },
  {
    ref: "LOAD-1044",
    truckId: "trk-04",
    driverId: "drv-04",
    status: "planned",
    ageMin: 80,
    cmr: "CMR-IE-0084419",
    stops: [{ crm: "CRM-24219" }, { crm: "CRM-24221" }],
  },
  {
    ref: "LOAD-1039",
    truckId: "trk-06",
    driverId: "drv-06",
    status: "completed",
    ageMin: 1_560,
    stops: [
      { crm: "CRM-24101", deliveredAgoMin: 1_320 },
      { crm: "CRM-24104", deliveredAgoMin: 1_240 },
      { crm: "CRM-24107", deliveredAgoMin: 1_180 },
    ],
  },
];

const truckById = new Map(trucks.map((t) => [t.id, t]));

/**
 * Which alerts have fired for a stop. Mirrors the real trigger rules rather
 * than hard-coding a list: dispatch on departure, proximity inside the
 * geofence, delivery on completion — and nothing at all for a customer who
 * has opted out, which is the ePrivacy rule the sender must honour.
 */
function notificationsFor(
  loadStatus: LoadStatus,
  delivered: boolean,
  distance_m: number | null,
  optedOut: boolean,
): NotificationType[] {
  if (optedOut) return [];
  const sent: NotificationType[] = [];
  if (loadStatus !== "planned") sent.push("dispatch_confirmation");
  if (delivered) {
    sent.push("proximity_alert", "delivery_complete");
  } else if (distance_m !== null && distance_m <= GEOFENCE_RADIUS_M) {
    sent.push("proximity_alert");
  }
  return sent;
}

export const loads: LoadView[] = loadSeeds.map((seed, li) => {
  const truck = truckById.get(seed.truckId) ?? null;
  const driver = driverById.get(seed.driverId) ?? null;

  const stops: Stop[] = seed.stops.map((s, si) => {
    const order = orderFor(s.crm);
    const item: LoadItem = {
      id: `li-${li + 1}-${si + 1}`,
      load_id: `load-${li + 1}`,
      order_id: order.id,
      stop_sequence: si + 1,
      delivered_at:
        s.deliveredAgoMin === undefined ? null : minsAgo(s.deliveredAgoMin),
    };
    const distance_m =
      truck?.current_location && order.delivery_location
        ? haversineMeters(truck.current_location, order.delivery_location)
        : null;
    return {
      ...item,
      order,
      distance_m,
      notifications: notificationsFor(
        seed.status,
        item.delivered_at !== null,
        distance_m,
        order.notifications_opt_out,
      ),
    };
  });

  const destination_countries = [
    ...new Set(stops.map((s) => s.order.delivery_country)),
  ];

  // The most demanding regime on the load is the one that governs it — a
  // trailer with one GB drop is a GB customs movement, whatever else is on it.
  const RANK: Record<string, number> = {
    domestic: 0,
    intra_eu: 1,
    windsor_green: 2,
    windsor_red: 3,
    gb_import: 4,
    third_country: 5,
  };
  const regime = destination_countries
    .map((c) => customsRegime(DEPOT.country, c, seed.atRisk))
    .sort((a, b) => RANK[b] - RANK[a])[0];

  const load: Load = {
    id: `load-${li + 1}`,
    truck_id: seed.truckId,
    status: seed.status,
    created_at: minsAgo(seed.ageMin),
    driver_id: seed.driverId,
    origin_country: DEPOT.country,
    cmr_number: seed.cmr ?? null,
  };

  return {
    ...load,
    reference: seed.ref,
    truck,
    driver,
    customs_regime: regime,
    destination_countries,
    stops,
  };
});

/* --- derived selectors ----------------------------------------------------- */

export const activeLoads = loads.filter((l) => l.status === "active");
export const plannedLoads = loads.filter((l) => l.status === "planned");

const assignedOrderIds = new Set(
  loads.flatMap((l) => l.stops.map((s) => s.order_id)),
);

/** Orders the CRM has pushed that no dispatcher has placed on a load yet. */
export const unassignedOrders = orders.filter(
  (o) => !assignedOrderIds.has(o.id),
);

/** `order.id` → the reference of the load it sits on, for cross-linking. */
export const loadRefByOrderId: Record<string, string> = Object.fromEntries(
  loads.flatMap((l) => l.stops.map((s) => [s.order_id, l.reference])),
);

/** Geocoding failures — the doc requires these be flagged, not dropped. */
export const ungeocodedOrders = orders.filter(
  (o) => o.delivery_location === null,
);

/** Customers who have opted out of alerts — nothing may be sent to them. */
export const optedOutOrders = orders.filter((o) => o.notifications_opt_out);

export function loadForTruck(truckId: string): LoadView | undefined {
  return loads.find((l) => l.truck_id === truckId && l.status === "active");
}

export function loadForDriver(driverId: string): LoadView | undefined {
  return loads.find(
    (l) => l.driver_id === driverId && l.status !== "completed",
  );
}

export function nextStop(load: LoadView): Stop | undefined {
  return load.stops.find((s) => s.delivered_at === null);
}

export function loadProgress(load: LoadView): { done: number; total: number } {
  return {
    done: load.stops.filter((s) => s.delivered_at !== null).length,
    total: load.stops.length,
  };
}

/* --- alert log -------------------------------------------------------------
   The `notifications` rows, flattened with the joins the event feed needs. */

export interface AlertEvent {
  id: string;
  type: NotificationType;
  sent_at: string;
  load_reference: string;
  license_plate: string | null;
  order: Order;
}

function sentAt(load: LoadView, stop: Stop, type: NotificationType): string {
  switch (type) {
    case "dispatch_confirmation":
      return load.created_at;
    case "delivery_complete":
      return stop.delivered_at ?? load.created_at;
    case "proximity_alert":
      // Roughly one alert-radius of driving before the stop was reached; for
      // stops still running, scaled off how close the truck is right now.
      return stop.delivered_at
        ? new Date(new Date(stop.delivered_at).getTime() - 22 * 60_000).toISOString()
        : minsAgo(Math.round((stop.distance_m ?? 0) / 1000) + 3);
  }
}

export const alertLog: AlertEvent[] = loads
  .flatMap((load) =>
    load.stops.flatMap((stop) =>
      stop.notifications.map((type) => ({
        id: `ntf-${stop.id}-${type}`,
        type,
        sent_at: sentAt(load, stop, type),
        load_reference: load.reference,
        license_plate: load.truck?.license_plate ?? null,
        order: stop.order,
      })),
    ),
  )
  .sort((a, b) => b.sent_at.localeCompare(a.sent_at));

/** Alerts sent since midnight UTC on the demo day. */
export const alertsToday = alertLog.filter(
  (a) => a.sent_at >= DEMO_NOW.toISOString().slice(0, 10),
);

/** Stops currently inside the 5 km geofence and not yet delivered. */
export const stopsInGeofence = activeLoads.flatMap((l) =>
  l.stops.filter(
    (s) =>
      s.delivered_at === null &&
      s.distance_m !== null &&
      s.distance_m <= GEOFENCE_RADIUS_M,
  ),
);
