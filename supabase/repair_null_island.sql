-- Repairs orders stored at 0, 0 ("null island", Gulf of Guinea).
--
-- Cause: the CRM push accepted supplied latitude/longitude of 0, 0 — a blank
-- field defaulted to zero, not a location. Fixed in code (suppliedPointProblem
-- in web/src/lib/regions.ts); this cleans up what landed before the fix.
--
-- Run in the Supabase SQL editor. Step 1 is read-only; run it first and read
-- the list. Step 2 only touches orders that are still safe to change.

-- 1. What is affected -------------------------------------------------------
SELECT o.crm_order_id,
       o.customer_name,
       o.delivery_address,
       o.delivery_postcode,
       o.status,
       li.load_id,
       li.delivered_at
FROM orders o
LEFT JOIN load_items li ON li.order_id = o.id
WHERE o.delivery_location IS NOT NULL
  AND abs(ST_Y(o.delivery_location::geometry)) < 0.000001
  AND abs(ST_X(o.delivery_location::geometry)) < 0.000001
ORDER BY o.created_at DESC;

-- 2. Clear the point on undelivered orders that are on no load, so they show
--    as "needs coordinates" and Geocode in the Orders Queue resolves them from
--    the address/Eircode. Orders already on a planned or active load: use
--    "Change address" on the row (allowed until delivered), or remove them
--    from the load first and re-run this. Delivered orders are left alone —
--    the stop is the record of what happened.
UPDATE orders o
SET delivery_location = NULL,
    updated_at        = now()
WHERE o.delivery_location IS NOT NULL
  AND abs(ST_Y(o.delivery_location::geometry)) < 0.000001
  AND abs(ST_X(o.delivery_location::geometry)) < 0.000001
  AND o.status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM load_items li WHERE li.order_id = o.id);

-- 3. Any cache row at 0, 0 (the app now ignores them, but don't keep junk).
DELETE FROM geocode_cache
WHERE abs(ST_Y(location::geometry)) < 0.000001
  AND abs(ST_X(location::geometry)) < 0.000001;
