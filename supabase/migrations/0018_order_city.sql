-- Delivery town/city on an order, and an Analytics breakdown by it.
--
-- `orders` has never carried a structured settlement name — only the free-text
-- `delivery_address`, the postcode, and the country. Parsing a city out of the
-- address string is unreliable and deriving one from a postcode is IE/GB-only
-- and approximate, so the honest move is a real column the CRM bridge fills
-- (the same pattern as `crm_vehicle` in 0016). Orders without one land in an
-- "Unknown" bucket rather than being guessed at.

ALTER TABLE orders ADD COLUMN delivery_city TEXT;

COMMENT ON COLUMN orders.delivery_city IS
  'Delivery town/city, free text, from the source CRM (or CSV import). Used '
  'for the Analytics "by city" breakdown; NULL is reported as "Unknown", '
  'never inferred from the address.';

CREATE INDEX idx_orders_delivery_city ON orders (delivery_city)
  WHERE delivery_city IS NOT NULL;

-- orders_geo has an explicit column list; re-declare it with the new column
-- appended (CREATE OR REPLACE only permits additions at the end).
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
  o.crm_vehicle,
  o.delivery_city
FROM orders o;

-- ===========================================================================
-- analytics_by_city — the same shape as analytics_destinations (0008), one
-- level finer. Case- and whitespace-folded so "DUBLIN" / "dublin" / " Dublin"
-- collapse to one row; country is carried so "Newry, XI" and a hypothetical
-- "Newry, IE" stay distinct and the UI can label them.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.analytics_by_city(p_days INT DEFAULT 14)
RETURNS TABLE (
  city TEXT,
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
    COALESCE(NULLIF(INITCAP(TRIM(o.delivery_city)), ''), 'Unknown') AS city,
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
  GROUP BY 1, o.delivery_country
  ORDER BY 3 DESC, 1;
$$;
