-- Dispatcher-owned truck attributes.
--
-- Split of ownership after this migration:
--   * the telematics feed owns `current_location` and `location_updated_at`
--   * dispatchers own everything added here, stamped with `details_updated_at`
--
-- Keeping the two timestamps apart matters: a dispatcher flipping a truck to
-- "unavailable" must not make a stale GPS fix look fresh on the live map.

-- 1. Disambiguate the existing timestamp. It has only ever meant "last GPS
--    fix"; the name stopped being obvious once rows had two kinds of edit.
ALTER TABLE trucks RENAME COLUMN updated_at TO location_updated_at;

-- 2. Identity and capacity.
ALTER TABLE trucks
  ADD COLUMN label TEXT,
  ADD COLUMN make_model TEXT,
  ADD COLUMN capacity_kg INTEGER
    CHECK (capacity_kg IS NULL OR capacity_kg > 0),
  ADD COLUMN capacity_m3 NUMERIC(6, 2)
    CHECK (capacity_m3 IS NULL OR capacity_m3 > 0),
  ADD COLUMN pallet_slots SMALLINT
    CHECK (pallet_slots IS NULL OR pallet_slots > 0);

-- 3. Equipment tags — reefer, tail lift, ADR and so on.
--
--    Deliberately an open TEXT[] rather than a lookup table or an enum: the
--    admin panel ships a catalogue of known tags (labels + icons) but must
--    accept one-off tags a dispatcher invents without a migration. The GIN
--    index makes `features @> ARRAY['reefer']` cheap when matching a load's
--    requirements against the fleet.
ALTER TABLE trucks
  ADD COLUMN features TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_trucks_features ON trucks USING GIN (features);

-- 4. Availability — a dispatcher's intent, not a derived state.
--
--    "Is this truck on a load right now" is already answerable from `loads`,
--    so it is NOT duplicated here. This column answers the different question
--    "may this truck be given work at all", which nothing else records.
ALTER TABLE trucks
  ADD COLUMN availability TEXT NOT NULL DEFAULT 'available'
    CHECK (availability IN ('available', 'unavailable', 'maintenance')),
  ADD COLUMN availability_note TEXT,
  ADD COLUMN unavailable_until TIMESTAMPTZ,
  ADD COLUMN details_updated_at TIMESTAMPTZ DEFAULT NOW();

-- Partial index: the load planner only ever asks for the assignable ones.
CREATE INDEX idx_trucks_assignable ON trucks (id)
  WHERE availability = 'available';

-- A truck cannot be scheduled back into service before it leaves it.
ALTER TABLE trucks
  ADD CONSTRAINT trucks_unavailable_until_requires_reason
  CHECK (unavailable_until IS NULL OR availability <> 'available');
