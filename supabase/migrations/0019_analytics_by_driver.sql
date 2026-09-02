-- Analytics: which drivers ran which work in the window.
--
-- Everything needed already exists — `loads.driver_id` (0003) and delivered
-- `load_items`. A "run" is one load the driver completed at least one drop on;
-- "drops" is the stop count. Same on-time rule as the rest of Analytics: only
-- stops that carried a promised time count toward the denominator.
--
-- Loads with no driver assigned collapse into a single NULL row the UI labels
-- "Unassigned" — the work still happened and the count would be dishonest
-- without it.

CREATE OR REPLACE FUNCTION public.analytics_by_driver(p_days INT DEFAULT 14)
RETURNS TABLE (
  driver_id UUID,
  full_name TEXT,
  runs BIGINT,
  drops BIGINT,
  on_time BIGINT,
  measurable BIGINT,
  last_delivery_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    d.id,
    d.full_name,
    COUNT(DISTINCT l.id) AS runs,
    COUNT(li.id) AS drops,
    COUNT(*) FILTER (
      WHERE o.promised_at IS NOT NULL
        AND li.delivered_at <= COALESCE(o.promised_window_end, o.promised_at)
    ) AS on_time,
    COUNT(*) FILTER (WHERE o.promised_at IS NOT NULL) AS measurable,
    MAX(li.delivered_at) AS last_delivery_at
  FROM load_items li
  JOIN loads l ON l.id = li.load_id
  JOIN orders o ON o.id = li.order_id
  LEFT JOIN drivers d ON d.id = l.driver_id
  WHERE li.delivered_at IS NOT NULL
    AND li.delivered_at >= NOW() - (p_days || ' days')::interval
  GROUP BY d.id, d.full_name
  ORDER BY drops DESC, runs DESC;
$$;
