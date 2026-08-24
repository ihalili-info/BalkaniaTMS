-- 0011: the driver's assigned vehicle.
--
-- Until now the only link between a driver and a truck was `loads` — the pair
-- existed for the duration of one job and nowhere else. That is fine for
-- history and wrong for planning: in a fleet this size a driver keeps the same
-- unit day after day, and a dispatcher planning a load already knows which
-- truck comes with which name. Without this column that knowledge lived in
-- somebody's head.
--
-- Deliberately NOT unique. Double-shifting a tractor (day driver, night
-- driver) is normal haulage practice, and a unique index here would make the
-- second assignment fail with a constraint error rather than let dispatch
-- decide. The UI surfaces who else is on the truck instead.
--
-- ON DELETE SET NULL: retiring a truck must not delete the driver, and a
-- driver with no vehicle is a perfectly ordinary state (agency, holiday,
-- between units).

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS assigned_truck_id UUID
    REFERENCES trucks(id) ON DELETE SET NULL,
  -- Stamped by the dispatcher edit, like `trucks.details_updated_at`. Keeps
  -- "who changed the pairing and when" answerable without an audit table.
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

COMMENT ON COLUMN drivers.assigned_truck_id IS
  'The truck this driver normally runs. Planning default only — the load''s own truck_id is what the job was actually done in.';

-- Both directions are queried: "which truck does this driver have" on the
-- Drivers tab, and "who runs this truck" on the Trucks tab.
CREATE INDEX IF NOT EXISTS idx_drivers_assigned_truck
  ON drivers (assigned_truck_id)
  WHERE assigned_truck_id IS NOT NULL;

-- Keep the timestamp honest without asking the app to remember: it should
-- move when the pairing changes and stay put when anything else on the row is
-- edited.
CREATE OR REPLACE FUNCTION stamp_driver_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_truck_id IS DISTINCT FROM OLD.assigned_truck_id THEN
    NEW.assigned_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS drivers_stamp_assignment ON drivers;
CREATE TRIGGER drivers_stamp_assignment
  BEFORE UPDATE ON drivers
  FOR EACH ROW
  EXECUTE FUNCTION stamp_driver_assignment();
