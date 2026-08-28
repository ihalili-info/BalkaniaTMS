/**
 * Country registry.
 *
 * The operation is Ireland-based and expanding into the rest of the EU and the
 * UK, so no screen hard-codes Ireland. Anything that varies by jurisdiction —
 * dial prefix, postcode name and shape, vehicle weight and height limits,
 * customs position — is a row in this table, and adding a country is an entry
 * here rather than a code change.
 *
 * `XI` (Northern Ireland) is not an ISO 3166-1 country, but it is the real
 * EORI/VAT prefix used for NI, and under the Windsor Framework NI is its own
 * customs territory. Treating it as `GB` would produce the wrong paperwork.
 */

export type CountryCode = string;

/** Which trade bloc a territory sits in, for deriving the customs position. */
export type Bloc = "eu" | "uk" | "ni" | "efta" | "other";

export interface Country {
  code: CountryCode;
  name: string;
  bloc: Bloc;
  /** E.164 prefix, for formatting and validating customer phone numbers. */
  dialPrefix: string;
  /** What this country calls its postcode — Eircode, Postcode, CP, PLZ… */
  postcodeLabel: string;
  /** Loose shape check only; authoritative validation is the postal API's job. */
  postcodePattern: RegExp;
  postcodeExample: string;
  /** Max gross combination weight for a 5+ axle articulated unit, kg. */
  maxGrossWeightKg: number;
  /** Max vehicle height, m. Ireland and the UK allow far more than the EU. */
  maxHeightM: number;
  /** Max articulated combination length, m (Directive 96/53/EC Annex I). */
  maxLengthM: number;
  /**
   * Rough bounding box [minLat, minLng, maxLat, maxLng].
   *
   * Generous on purpose — this is a sanity check on a hand-entered coordinate,
   * not a border. It exists to catch the two mistakes people actually make:
   * a transposed lat/lng, and a coordinate pasted for the wrong place.
   */
  bbox: [number, number, number, number];
}

export const COUNTRIES: Record<CountryCode, Country> = {
  IE: {
    code: "IE",
    name: "Ireland",
    bloc: "eu",
    dialPrefix: "+353",
    postcodeLabel: "Eircode",
    // Routing key is a letter then two chars that are digits or, for Dublin 6
    // West, "W" ("D6W"). Space is optional and may be doubled in pasted data.
    postcodePattern: /^[A-Z]\d[\dW]\s*[A-Z0-9]{4}$/i,
    postcodeExample: "D02 XY45",
    maxGrossWeightKg: 44_000,
    // No general height limit in law, but 4.65 m is the practical bridge
    // clearance standard vehicles are built and routed to.
    maxHeightM: 4.65,
    maxLengthM: 18.75,
    bbox: [51.3, -10.8, 55.5, -5.3],
  },
  XI: {
    code: "XI",
    name: "Northern Ireland",
    bloc: "ni",
    dialPrefix: "+44",
    postcodeLabel: "Postcode",
    postcodePattern: /^BT\d{1,2}\s?\d[A-Z]{2}$/i,
    postcodeExample: "BT1 5GS",
    maxGrossWeightKg: 44_000,
    maxHeightM: 4.95,
    maxLengthM: 18.75,
    bbox: [53.9, -8.3, 55.4, -5.3],
  },
  GB: {
    code: "GB",
    name: "Great Britain",
    bloc: "uk",
    dialPrefix: "+44",
    postcodeLabel: "Postcode",
    postcodePattern: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
    postcodeExample: "LL65 1DQ",
    maxGrossWeightKg: 44_000,
    maxHeightM: 4.95,
    maxLengthM: 18.75,
    bbox: [49.8, -8.3, 61.0, 1.9],
  },
  FR: {
    code: "FR",
    name: "France",
    bloc: "eu",
    dialPrefix: "+33",
    postcodeLabel: "Code postal",
    postcodePattern: /^\d{5}$/,
    postcodeExample: "50100",
    maxGrossWeightKg: 44_000,
    maxHeightM: 4.0,
    maxLengthM: 16.5,
    bbox: [41.2, -5.3, 51.2, 9.7],
  },
  NL: {
    code: "NL",
    name: "Netherlands",
    bloc: "eu",
    dialPrefix: "+31",
    postcodeLabel: "Postcode",
    postcodePattern: /^\d{4}\s?[A-Z]{2}$/i,
    postcodeExample: "3011 AA",
    maxGrossWeightKg: 50_000,
    maxHeightM: 4.0,
    maxLengthM: 18.75,
    bbox: [50.6, 3.2, 53.7, 7.3],
  },
  DE: {
    code: "DE",
    name: "Germany",
    bloc: "eu",
    dialPrefix: "+49",
    postcodeLabel: "PLZ",
    postcodePattern: /^\d{5}$/,
    postcodeExample: "40210",
    maxGrossWeightKg: 40_000,
    maxHeightM: 4.0,
    maxLengthM: 16.5,
    bbox: [47.1, 5.7, 55.2, 15.2],
  },
  BE: {
    code: "BE",
    name: "Belgium",
    bloc: "eu",
    dialPrefix: "+32",
    postcodeLabel: "Postcode",
    postcodePattern: /^\d{4}$/,
    postcodeExample: "2000",
    maxGrossWeightKg: 44_000,
    maxHeightM: 4.0,
    maxLengthM: 18.75,
    bbox: [49.4, 2.4, 51.7, 6.5],
  },
};

export const HOME_COUNTRY: CountryCode = "IE";

export function country(code: CountryCode): Country {
  return (
    COUNTRIES[code] ?? {
      code,
      name: code,
      bloc: "other",
      dialPrefix: "",
      postcodeLabel: "Postcode",
      postcodePattern: /.*/,
      postcodeExample: "",
      maxGrossWeightKg: 40_000,
      maxHeightM: 4.0,
      maxLengthM: 16.5,
      bbox: [-90, -180, 90, 180],
    }
  );
}

/* --- postcodes ------------------------------------------------------------- */

/**
 * Countries whose postcode is a head plus a fixed-length tail, and that tail
 * length. Everything else (numeric codes: FR, DE, BE) is a single run.
 */
const POSTCODE_TAIL: Record<string, number> = { IE: 4, GB: 3, XI: 3, NL: 2 };

/**
 * Canonical postcode form, for storage and display.
 *
 * People type Eircodes and UK postcodes with the space in a random place or
 * missing entirely — `"N39HX56"`, `"n39 hx56"`, `"N39  HX56"` are one code.
 * This collapses them to one representation so the Orders Queue does not show
 * three spellings of the same place, and so the geocode cache keys them
 * together.
 *
 * An unrecognised shape is trimmed and upper-cased but never dropped — a
 * strange postcode is still worth more than none.
 */
export function normalisePostcode(
  code: CountryCode,
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (compact === "") return null;

  const tail = POSTCODE_TAIL[code];
  if (tail && compact.length > tail) {
    return `${compact.slice(0, -tail)} ${compact.slice(-tail)}`;
  }
  return compact;
}

/* --- coordinate sanity ------------------------------------------------------ */

export function isInCountry(point: LatLngLike, code: CountryCode): boolean {
  const [minLat, minLng, maxLat, maxLng] = country(code).bbox;
  return (
    point.lat >= minLat &&
    point.lat <= maxLat &&
    point.lng >= minLng &&
    point.lng <= maxLng
  );
}

/**
 * True when the point is wrong for the country but its mirror image is right —
 * i.e. lat and lng were entered the wrong way round. Easily the most common
 * hand-entry mistake, and silently plotting a stop in the Atlantic is worse
 * than refusing it.
 */
export function looksTransposed(
  point: LatLngLike,
  code: CountryCode,
): boolean {
  return (
    !isInCountry(point, code) &&
    isInCountry({ lat: point.lng, lng: point.lat }, code)
  );
}

/** Which known country a point falls in, if any — for "did you mean XI?". */
export function countryForPoint(point: LatLngLike): CountryCode | null {
  // Northern Ireland sits inside the GB box too, so check it first.
  const order = ["XI", ...Object.keys(COUNTRIES).filter((c) => c !== "XI")];
  return order.find((code) => isInCountry(point, code)) ?? null;
}

type LatLngLike = { lat: number; lng: number };

/* --- customs ---------------------------------------------------------------- */

export type CustomsRegime =
  | "domestic"
  | "intra_eu"
  | "windsor_green"
  | "windsor_red"
  | "gb_import"
  | "third_country";

export const CUSTOMS_REGIME: Record<
  CustomsRegime,
  { label: string; short: string; detail: string; paperwork: string[] }
> = {
  domestic: {
    label: "Domestic",
    short: "Domestic",
    detail: "Single customs territory — no declaration, no CMR.",
    paperwork: [],
  },
  intra_eu: {
    label: "Intra-EU",
    short: "Intra-EU",
    detail:
      "Free circulation inside the single market. No customs declaration, but international carriage by road needs a CMR note.",
    paperwork: ["CMR consignment note"],
  },
  windsor_green: {
    label: "Windsor — green lane",
    short: "NI green",
    detail:
      "Goods staying in Northern Ireland. Simplified movement under the Windsor Framework via the UK Internal Market Scheme.",
    paperwork: ["UKIMS authorisation", "Simplified movement information"],
  },
  windsor_red: {
    label: "Windsor — red lane",
    short: "NI red",
    detail:
      "Goods at risk of moving onward into the EU. Full customs declaration and EU tariff treatment apply.",
    paperwork: ["Full customs declaration", "CMR consignment note"],
  },
  gb_import: {
    label: "GB import/export",
    short: "GB customs",
    detail:
      "A full third-country border since Brexit. Export declaration on leaving, import declaration and safety-and-security data on arrival.",
    paperwork: [
      "Export declaration",
      "Import declaration",
      "Safety & security (ENS)",
      "CMR consignment note",
    ],
  },
  third_country: {
    label: "Third country",
    short: "Third country",
    detail: "Outside the EU customs union — full declarations both ways.",
    paperwork: ["Export declaration", "Import declaration", "CMR consignment note"],
  },
};

/**
 * Customs position for a movement. `atRiskOfOnwardEuMovement` only matters for
 * Northern Ireland, where it is what separates the green lane from the red.
 */
export function customsRegime(
  origin: CountryCode,
  destination: CountryCode,
  atRiskOfOnwardEuMovement = false,
): CustomsRegime {
  if (origin === destination) return "domestic";

  const from = country(origin).bloc;
  const to = country(destination).bloc;

  if (to === "ni") {
    return atRiskOfOnwardEuMovement ? "windsor_red" : "windsor_green";
  }
  if (to === "uk" || from === "uk") return "gb_import";
  if (from === "eu" && to === "eu") return "intra_eu";
  return "third_country";
}

/** International carriage by road requires a CMR note; a domestic run does not. */
export function requiresCmr(regime: CustomsRegime): boolean {
  return CUSTOMS_REGIME[regime].paperwork.some((p) => p.startsWith("CMR"));
}

/**
 * Whether a vehicle is street-legal in a country. A 4.65 m Irish trailer is
 * over the limit almost everywhere on the continent — worth catching before
 * the load leaves, not at a French weighbridge.
 */
export function vehicleBreaches(
  truck: { gross_weight_kg: number | null; height_m: number | null; length_m: number | null },
  destination: CountryCode,
): string[] {
  const limits = country(destination);
  const problems: string[] = [];
  if (truck.gross_weight_kg && truck.gross_weight_kg > limits.maxGrossWeightKg) {
    problems.push(
      `${(truck.gross_weight_kg / 1000).toFixed(1)} t exceeds the ${(limits.maxGrossWeightKg / 1000).toFixed(0)} t limit in ${limits.name}`,
    );
  }
  if (truck.height_m && truck.height_m > limits.maxHeightM) {
    problems.push(
      `${truck.height_m.toFixed(2)} m exceeds the ${limits.maxHeightM.toFixed(2)} m height limit in ${limits.name}`,
    );
  }
  if (truck.length_m && truck.length_m > limits.maxLengthM) {
    problems.push(
      `${truck.length_m.toFixed(2)} m exceeds the ${limits.maxLengthM.toFixed(2)} m length limit in ${limits.name}`,
    );
  }
  return problems;
}
