-- The vehicle the CRM has assigned to an order.
--
-- This is the CRM's own dispatch decision, carried through for reference —
-- distinct from `loads.truck_id`, which is the plan built inside the TMS. Free
-- text (a registration, a fleet number, whatever the CRM holds); the CRM
-- bridge populates it and nothing here validates it against `trucks`.

ALTER TABLE orders ADD COLUMN crm_vehicle TEXT;

COMMENT ON COLUMN orders.crm_vehicle IS
  'Vehicle assigned to this order in the source CRM, as free text. Reference '
  'only — the TMS load plan (loads.truck_id) is authoritative for dispatch.';

-- orders_geo has an explicit column list, so it has to be re-declared to
-- surface the new column. CREATE OR REPLACE only permits *adding* columns at
-- the end, which is all this does — every consumer selects by name.
CREATE OR REPLACE VIEW orders_geo WITH (security_invoker = true) AS
SELECT
  o.id,
  o.crm_order_id,
  o.customer_name,
  o.customer_phone,
  o.delivery_address,
  o.status,
  o.created_at,
  o.updated_at,
  o.delivery_country,
  o.delivery_postcode,
  o.notifications_opt_out,
  o.opted_out_at,
  o.promised_at,
  o.promised_window_end,
  ST_Y(o.delivery_location::geometry) AS lat,
  ST_X(o.delivery_location::geometry) AS lng,
  o.crm_vehicle
FROM orders o;
