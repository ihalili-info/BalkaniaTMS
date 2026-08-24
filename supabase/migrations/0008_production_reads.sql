-- Everything the app needs to read real data instead of fixtures.

-- ===========================================================================
-- 1. A promised delivery time
-- ===========================================================================
--
-- The Analytics page showed an "on-time rate". Nothing in the schema could
-- produce it: orders had a `created_at` and load_items a `delivered_at`, but
-- no promise to measure against. A percentage with no denominator is worse
-- than a blank, so the column comes first and the metric follows it.
--
-- Nullable, because the CRM may not supply one. Anything without a promise is
-- excluded from the rate rather than counted as on time.

ALTER TABLE orders
  ADD COLUMN promised_at TIMESTAMPTZ,
  -- Some customers give a window rather than a time.
  ADD COLUMN promised_window_end TIMESTAMPTZ;

CREATE INDEX idx_orders_promised_at ON orders (promised_at)
  WHERE promised_at IS NOT NULL;

COMMENT ON COLUMN orders.promised_at IS
  'What the customer was told. On-time performance is measured against this; '
  'orders without it are excluded from the rate, never assumed on time.';

-- ===========================================================================
-- 2. Coordinates the API layer can actually read
-- ===========================================================================
--
-- PostgREST serialises GEOGRAPHY as WKB hex, which the browser cannot use.
-- These views expose plain lat/lng alongside the rest of the row.
--
-- `security_invoker = true` is load-bearing: without it a view runs with its
-- owner's rights and silently bypasses the RLS on the underlying table, which
-- would hand every authenticated user the whole fleet regardless of policy.

CREATE VIEW trucks_geo WITH (security_invoker = true) AS
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
  ST_X(t.current_location::geometry) AS lng
FROM trucks t;

CREATE VIEW orders_geo WITH (security_invoker = true) AS
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
  ST_X(o.delivery_location::geometry) AS lng
FROM orders o;

COMMENT ON VIEW trucks_geo IS
  'trucks with lat/lng instead of WKB. security_invoker keeps RLS in force.';
COMMENT ON VIEW orders_geo IS
  'orders with lat/lng instead of WKB. security_invoker keeps RLS in force.';

-- ===========================================================================
-- 3. Writing a position without touching PostGIS from TypeScript
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.set_order_location(
  p_order_id UUID,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION
)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE orders
     SET delivery_location = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
         updated_at = NOW()
   WHERE id = p_order_id;
$$;

COMMENT ON FUNCTION public.set_order_location IS
  'Note the argument order: ST_MakePoint takes (lng, lat). Reversing them is '
  'the single most common way to put a delivery in the sea.';

-- ===========================================================================
-- 4. Analytics, aggregated in the database
-- ===========================================================================
--
-- One round trip rather than pulling every row to the browser to count it.

CREATE OR REPLACE FUNCTION public.analytics_daily(p_days INT DEFAULT 14)
RETURNS TABLE (
  day DATE,
  deliveries BIGINT,
  on_time BIGINT,
  measurable BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH days AS (
    SELECT generate_series(
      (CURRENT_DATE - (p_days - 1) * INTERVAL '1 day')::date,
      CURRENT_DATE,
      INTERVAL '1 day'
    )::date AS day
  )
  SELECT
    d.day,
    COUNT(li.id) AS deliveries,
    -- Only orders that carried a promise can be judged against one.
    COUNT(*) FILTER (
      WHERE o.promised_at IS NOT NULL
        AND li.delivered_at <= COALESCE(o.promised_window_end, o.promised_at)
    ) AS on_time,
    COUNT(*) FILTER (WHERE o.promised_at IS NOT NULL) AS measurable
  FROM days d
  LEFT JOIN load_items li
    ON li.delivered_at IS NOT NULL
   AND li.delivered_at::date = d.day
  LEFT JOIN orders o ON o.id = li.order_id
  GROUP BY d.day
  ORDER BY d.day;
$$;

CREATE OR REPLACE FUNCTION public.analytics_alerts(p_days INT DEFAULT 14)
RETURNS TABLE (type TEXT, sent BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT n.type, COUNT(*)
  FROM notifications n
  WHERE n.sent_at >= NOW() - (p_days || ' days')::interval
  GROUP BY n.type
  ORDER BY n.type;
$$;

-- Destination country is the honest unit here: the schema records where a load
-- goes, not a named "corridor", and inventing one would be decoration.
CREATE OR REPLACE FUNCTION public.analytics_destinations(p_days INT DEFAULT 14)
RETURNS TABLE (
  country CHAR(2),
  deliveries BIGINT,
  on_time BIGINT,
  measurable BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    o.delivery_country,
    COUNT(li.id),
    COUNT(*) FILTER (
      WHERE o.promised_at IS NOT NULL
        AND li.delivered_at <= COALESCE(o.promised_window_end, o.promised_at)
    ),
    COUNT(*) FILTER (WHERE o.promised_at IS NOT NULL)
  FROM load_items li
  JOIN orders o ON o.id = li.order_id
  WHERE li.delivered_at IS NOT NULL
    AND li.delivered_at >= NOW() - (p_days || ' days')::interval
  GROUP BY o.delivery_country
  ORDER BY 2 DESC;
$$;

-- Minutes between the proximity alert firing and the stop completing. This is
-- the number that says whether the geofence radius is set sensibly.
CREATE OR REPLACE FUNCTION public.analytics_alert_lead_minutes(p_days INT DEFAULT 14)
RETURNS DOUBLE PRECISION
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT AVG(EXTRACT(EPOCH FROM (li.delivered_at - n.sent_at)) / 60.0)
  FROM notifications n
  JOIN load_items li ON li.id = n.load_item_id
  WHERE n.type = 'proximity_alert'
    AND li.delivered_at IS NOT NULL
    AND li.delivered_at > n.sent_at
    AND li.delivered_at >= NOW() - (p_days || ' days')::interval;
$$;
