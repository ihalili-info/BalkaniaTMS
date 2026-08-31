-- Geofence arrival tracking.
--
-- Until now the GPS webhook (0006 / 0013) only ever overwrote
-- `trucks.current_location` with the latest fix: no history, and no check of
-- whether that fix put the truck at one of its own stops. Nothing recorded
-- that a truck reached a customer, and `load_items.delivered_at` could only be
-- set by hand.
--
-- `stop_visits` is the arrival record. On each *stored* fix the webhook checks
-- the position against the active load's undelivered stops and:
--   * opens a visit row when the truck comes inside the arrival ring,
--   * extends it (`last_seen_at`, `min_distance_m`) while it stays,
--   * closes it (`exited_at`) when it leaves — and if it had dwelled long
--     enough, stamps `load_items.delivered_at` itself (`auto_delivered = TRUE`),
--     cascading to `orders.status` and `loads.status` exactly as the manual
--     "Mark delivered" button does.
--
-- It does NOT send customer messages. The geofence-driven SMS alerts
-- (dispatch / proximity / delivery-complete) are still a separate, unbuilt
-- piece — see "Messaging: who may be sent what" in the architecture doc.

CREATE TABLE stop_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_item_id UUID NOT NULL REFERENCES load_items(id) ON DELETE CASCADE,
  -- The truck that made the visit. SET NULL rather than CASCADE: a visit is
  -- history and outlives a truck being removed from the fleet.
  truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  -- The most recent fix still inside the ring. Dwell is
  -- `last_seen_at - entered_at`; an auto-delivery stamps `delivered_at` with
  -- this value, not the later fix that revealed the truck had already gone.
  last_seen_at TIMESTAMPTZ NOT NULL,
  -- NULL while the truck is still inside the ring.
  exited_at TIMESTAMPTZ,
  -- Closest the truck got to the stop, in metres — a rough confidence signal
  -- when the delivery point is only a GEOMETRIC_CENTER geocode.
  min_distance_m DOUBLE PRECISION NOT NULL,
  -- Did closing this visit stamp `load_items.delivered_at`.
  auto_delivered BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- At most one *open* visit per stop. A truck that leaves and comes back gets a
-- second row; a duplicate or out-of-order webhook delivery cannot open a
-- second one.
CREATE UNIQUE INDEX idx_stop_visits_open
  ON stop_visits (load_item_id)
  WHERE exited_at IS NULL;

CREATE INDEX idx_stop_visits_load_item ON stop_visits (load_item_id);

ALTER TABLE stop_visits ENABLE ROW LEVEL SECURITY;

-- Operational data, same posture as `load_items`: the team reads it, and the
-- manual "Mark delivered" path closes an open visit. The normal writer is the
-- GPS webhook on the service-role key, which bypasses RLS entirely.
CREATE POLICY stop_visits_authenticated ON stop_visits
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

COMMENT ON TABLE stop_visits IS
  'One row per contiguous period a truck spent inside a stop''s arrival ring. '
  'Written by the GPS webhook; may auto-stamp load_items.delivered_at on exit.';
