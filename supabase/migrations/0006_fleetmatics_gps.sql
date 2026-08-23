-- Verizon Connect Reveal (Fleetmatics) GPS feed.
--
-- The provider pushes each position to /api/webhooks/gps. Deliveries are HTTP
-- POSTs over the public internet: they retry, they duplicate, and they arrive
-- out of order. Without somewhere to record how far through the stream we are,
-- a late delivery overwrites a newer position and the truck jumps backwards on
-- the live map.

ALTER TABLE trucks
  -- Reveal's per-vehicle SequenceId, monotonic within a vehicle. The guard
  -- against replays and out-of-order deliveries.
  ADD COLUMN gps_sequence_id BIGINT,

  -- Reveal reverse-geocodes each position and includes the address in the
  -- push. Storing it costs nothing and saves a geocoding call every time a
  -- dispatcher asks "where is that truck actually".
  ADD COLUMN last_known_address TEXT;

COMMENT ON COLUMN trucks.gps_device_id IS
  'Reveal VEHICLE NUMBER — not the device serial or ESN. Verizon does not '
  'populate this field automatically when an account is created; it must be '
  'set per vehicle in Reveal before the API or webhook can identify the truck.';

COMMENT ON COLUMN trucks.gps_sequence_id IS
  'Last SequenceId accepted from the Reveal GPS push. Only apply an update '
  'whose SequenceId is greater; see isNewerFix() in lib/telematics/fleetmatics.';

-- No index needed for the webhook lookup: `gps_device_id` was declared
-- TEXT UNIQUE NOT NULL in 0001, and that constraint already carries one.
