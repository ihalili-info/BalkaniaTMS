-- 0013: the GPS device ESN, as a fallback join key for the push feed.
--
-- The Reveal GPS webhook matches an incoming fix to a truck on
-- `trucks.gps_device_id` = Reveal's **Vehicle Number**. Verizon's own webhook
-- guide calls `vehicle.esn` "mandatory ... use as your join key" and warns that
-- the Vehicle Number is *not* populated automatically — someone has to set it
-- per vehicle in Reveal. So a fleet that has not done that work would have
-- every fix land as "no matching truck".
--
-- Rather than switch the primary key (the pull API `/cmd/v1/vehicles` and
-- "Sync from Reveal" both key on Vehicle Number), this adds the ESN as a
-- second key the webhook can fall back to: match on Number, then on ESN.
--
-- Nullable, and NOT unique. The list response that "Sync from Reveal" reads
-- does not reliably carry the ESN (its fields are undocumented), so many rows
-- will have it blank; and a device swapped between tractors could briefly
-- collide. The webhook tolerates a miss — it just reports the fix unmatched.

ALTER TABLE trucks
  ADD COLUMN IF NOT EXISTS gps_esn TEXT;

COMMENT ON COLUMN trucks.gps_esn IS
  'Reveal device ESN. Fallback join key for the GPS webhook when a fix carries '
  'no Vehicle Number. Dispatcher- or sync-populated, like gps_device_id.';

CREATE INDEX IF NOT EXISTS idx_trucks_gps_esn
  ON trucks (gps_esn)
  WHERE gps_esn IS NOT NULL;

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
  t.gps_esn
FROM trucks t;
