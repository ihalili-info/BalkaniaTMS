-- 0022: vehicle type — a truck or a van.
--
-- The table is still `trucks` (it is the fleet, and renaming it would touch
-- every FK, view and policy for no gain), but a Ford Transit is not an HGV and
-- the TMS should not treat it as one. `vehicle_type` is what lets it declare
-- which it is:
--
--   * routing: a van that has no dimensions recorded falls back to van-sized
--     defaults (3.5 t / 2.7 m / 6 m) rather than the 44 t artic the HGV
--     default assumes — see `lib/routing/vehicle.ts`;
--   * the UI: an icon and badge on the fleet cards and the map.
--
-- Dispatcher-owned, like the rest of the truck details: Reveal does not say
-- whether a vehicle is a van, so "Sync from Reveal" never writes it. Existing
-- rows are HGVs by default, which is what the fleet was modelled as until now.
--
-- NOT NULL with a default, so no row is ever untyped and the backfill is the
-- default itself. A CHECK rather than an enum: adding a third type later
-- ("car", "trailer") is a one-line CHECK change, not an ALTER TYPE.

ALTER TABLE trucks
  ADD COLUMN IF NOT EXISTS vehicle_type TEXT NOT NULL DEFAULT 'truck';

ALTER TABLE trucks
  DROP CONSTRAINT IF EXISTS trucks_vehicle_type_check;
ALTER TABLE trucks
  ADD CONSTRAINT trucks_vehicle_type_check
  CHECK (vehicle_type IN ('truck', 'van'));

COMMENT ON COLUMN trucks.vehicle_type IS
  'truck (HGV) or van. Dispatcher-owned; drives routing defaults and UI. Not written by the Reveal sync.';

-- Expose it through the lat/lng view. CREATE OR REPLACE keeps the existing
-- column order and appends the new one at the end.
CREATE OR REPLACE VIEW trucks_geo
  WITH (security_invoker = true) AS
SELECT
  t.id,
  t.license_plate,
  t.gps_device_id,
  t.location_updated_at,
  t.label,
  t.make_model,
  t.capacity_kg,
  t.capacity_m3,
  t.pallet_slots,
  t.features,
  t.availability,
  t.availability_note,
  t.unavailable_until,
  t.details_updated_at,
  t.gross_weight_kg,
  t.height_m,
  t.length_m,
  t.euro_emission_class,
  t.adr_classes,
  t.gps_sequence_id,
  t.last_known_address,
  ST_Y(t.current_location::geometry) AS lat,
  ST_X(t.current_location::geometry) AS lng,
  t.gps_esn,
  t.vehicle_type
FROM trucks t;
