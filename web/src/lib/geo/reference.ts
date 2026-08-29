import type { LatLng } from "@/lib/types";
import type { CountryCode } from "@/lib/regions";

/**
 * Map reference data — not fixtures.
 *
 * The fleet map has no basemap, so without a few known places it is an empty
 * grid with dots on it. These are landmarks for orientation, nothing more:
 * they are never joined to a truck, an order or a load.
 */

export interface ReferencePlace {
  name: string;
  country: CountryCode;
  lat: number;
  lng: number;
}

/**
 * The home terminal.
 *
 * Real configuration, not demo data — it is where every load originates and it
 * anchors the map. Belongs in Integration Settings eventually; a constant is
 * honest while there is exactly one depot.
 */
export const DEPOT: ReferencePlace & { label: string } = {
  name: "Depot",
  label:
    "Sanguine House, Huntstown Business Park, Cappagh Road, Dublin 11, D11 T9TF",
  country: "IE",
  // Centroid of Huntstown Business Park, Ballycoolin (OpenStreetMap). Within
  // ~150 m of the unit; fine as a map anchor and route origin — the depot is
  // never a delivery stop, so geofence precision does not apply. Re-geocode
  // "D11 T9TF" if a rooftop point is ever needed.
  lat: 53.403717,
  lng: -6.342258,
};

/** Places worth labelling on the operating area. */
export const REFERENCE_PLACES: ReferencePlace[] = [
  { name: "Dublin", country: "IE", lat: 53.3498, lng: -6.2603 },
  { name: "Cork", country: "IE", lat: 51.8985, lng: -8.4756 },
  { name: "Limerick", country: "IE", lat: 52.6638, lng: -8.6267 },
  { name: "Galway", country: "IE", lat: 53.2707, lng: -9.0568 },
  { name: "Waterford", country: "IE", lat: 52.2593, lng: -7.1101 },
  { name: "Sligo", country: "IE", lat: 54.2766, lng: -8.4761 },
  { name: "Athlone", country: "IE", lat: 53.4239, lng: -7.9407 },
  { name: "Dundalk", country: "IE", lat: 54.0019, lng: -6.4058 },
  { name: "Wexford", country: "IE", lat: 52.3369, lng: -6.4633 },
  { name: "Tralee", country: "IE", lat: 52.2713, lng: -9.7016 },
  { name: "Rosslare", country: "IE", lat: 52.2506, lng: -6.3378 },
  { name: "Belfast", country: "XI", lat: 54.5973, lng: -5.9301 },
  { name: "Derry", country: "XI", lat: 54.9966, lng: -7.3086 },
  { name: "Holyhead", country: "GB", lat: 53.309, lng: -4.633 },
];

/** Fallback view when the fleet has no positions yet — the operating area. */
export const DEFAULT_VIEW: { centre: LatLng; radiusKm: number } = {
  centre: { lat: DEPOT.lat, lng: DEPOT.lng },
  radiusKm: 220,
};
