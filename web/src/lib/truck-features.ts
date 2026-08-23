/**
 * Catalogue of known equipment tags.
 *
 * `trucks.features` is an open `TEXT[]` — a dispatcher can add a tag that
 * isn't listed here and it will still store, filter and display (as a plain
 * chip, without an icon). This catalogue only supplies presentation and the
 * tick-list in the editor, so adding a tag never needs a migration.
 */

export interface TruckFeature {
  /** The value stored in `trucks.features`. */
  id: string;
  label: string;
  icon: string;
  /** Shown under the label in the editor when the tag needs disambiguating. */
  hint?: string;
}

export const TRUCK_FEATURES: TruckFeature[] = [
  {
    id: "reefer",
    label: "Refrigerated",
    icon: "ac_unit",
    hint: "Fridge body — temperature-controlled cargo",
  },
  {
    id: "atp",
    label: "ATP certified",
    icon: "verified",
    hint: "ATP agreement — cleared to carry perishable foodstuffs internationally",
  },
  {
    id: "temp_logger",
    label: "Temperature logging",
    icon: "thermostat",
    hint: "Records the cold chain for proof of delivery",
  },
  { id: "tail_lift", label: "Tail lift", icon: "elevator" },
  {
    id: "pallet_truck",
    label: "Onboard pallet truck",
    icon: "forklift",
  },
  { id: "crane", label: "Crane / HIAB", icon: "precision_manufacturing" },
  {
    id: "adr",
    label: "ADR certified",
    icon: "dangerous",
    hint: "Licensed for dangerous goods",
  },
  { id: "curtainside", label: "Curtainside", icon: "door_sliding" },
  { id: "box_body", label: "Box body", icon: "inventory_2" },
  {
    id: "cmr_ready",
    label: "International kit",
    icon: "public",
    hint: "Carries CMR pads, tacho printouts and customs paperwork",
  },
  {
    id: "two_drivers",
    label: "Two-driver crew",
    icon: "group",
    hint: "Cleared for long international runs",
  },
];

const BY_ID = new Map(TRUCK_FEATURES.map((f) => [f.id, f]));

/** Presentation for a tag, synthesising a fallback for unknown ones. */
export function describeFeature(id: string): TruckFeature {
  return (
    BY_ID.get(id) ?? {
      id,
      // "cold_room" -> "Cold room"
      label: id.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()),
      icon: "sell",
    }
  );
}

export function isKnownFeature(id: string): boolean {
  return BY_ID.has(id);
}

/** Normalises free-form input into a storable tag. */
export function toFeatureId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
