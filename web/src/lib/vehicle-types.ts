import type { VehicleType } from "@/lib/types";

/**
 * The vehicle types a fleet unit can be declared as.
 *
 * The table and most of the UI still say "truck" — it is the generic word for
 * a fleet unit here — so this is the one place that says which kind. Adding a
 * type is a value in `VehicleType`, the CHECK in migration 0022, and a row here.
 */
export const VEHICLE_TYPES: {
  value: VehicleType;
  label: string;
  /** Material Symbols name. */
  icon: string;
  hint: string;
}[] = [
  {
    value: "truck",
    label: "Truck",
    icon: "local_shipping",
    hint: "HGV — routed with its own weight and height, defaulting to a 44 t artic",
  },
  {
    value: "van",
    label: "Van",
    icon: "airport_shuttle",
    hint: "Light commercial — defaults to 3.5 t and van-sized dimensions when none are set",
  },
];

export const vehicleTypeLabel = (type: VehicleType): string =>
  VEHICLE_TYPES.find((t) => t.value === type)?.label ?? "Truck";

export const vehicleTypeIcon = (type: VehicleType): string =>
  VEHICLE_TYPES.find((t) => t.value === type)?.icon ?? "local_shipping";

/** Narrows an untrusted string (a form value, a crafted action call). */
export const isVehicleType = (value: unknown): value is VehicleType =>
  value === "truck" || value === "van";
