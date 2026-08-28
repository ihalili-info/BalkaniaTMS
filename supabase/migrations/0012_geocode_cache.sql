-- 0012: a geocode cache with a manual-override tier.
--
-- Every CSV import starts its orders with no coordinates, and every rural
-- address someone hand-places in "Fix address" has to be hand-placed again the
-- next time that customer orders. Both are wasteful: the first spends a Google
-- lookup on an address we have already resolved, the second spends a
-- dispatcher's attention on a decision they already made.
--
-- This table remembers the answer. On the next import the same address resolves
-- for free, and a point a human verified once is reused with that provenance
-- intact.
--
-- **The risk is that a cache hit is invisible.** If a stored point is wrong it
-- silently drops an order in the wrong place, and `lib/geocoding/google.ts`
-- already argues at length that a wrong coordinate is worse than none. So:
--
--   * the KEY is tight — an Eircode (a building) for Ireland, a postcode plus a
--     normalised address line elsewhere, and nothing at all without one of
--     those. A fuzzy address-string match is exactly how you serve a stale pin.
--   * `source` records how good the point is. A `manual` fix is gospel and is
--     never overwritten by a later automatic geocode; `geometric_center` is
--     weak enough that the caller still tries a fresh geocode first and only
--     falls back to the cache if that fails.
--   * the app shows "placed from a saved location" on the row, the same way it
--     shows Google's normalised address back — a bad entry is catchable by
--     reading.
--
-- It is customer personal data keyed by address, so it carries the same
-- retention posture as `orders` / `notifications`: `last_used_at` is here so a
-- cleanup job can drop entries nothing has touched in a long time. Automatic
-- entries are the ones that should age out; `manual` ones represent real human
-- knowledge and are kept until the address itself is corrected.

CREATE TABLE IF NOT EXISTS geocode_cache (
  -- Natural key. For IE: the compact uppercase Eircode ("D02XY45"). Otherwise:
  -- "<CC>:<POSTCODE>:<normalised address line>". Built by
  -- `geocodeCacheKey()` in web/src/lib/geocoding/cache.ts — keep the two in
  -- step.
  key TEXT PRIMARY KEY,

  location GEOGRAPHY(POINT, 4326) NOT NULL,

  source TEXT NOT NULL
    CHECK (source IN ('manual', 'rooftop', 'interpolated', 'geometric_center')),

  -- What the provider (or the dispatcher) said this address normalises to.
  -- Shown back on reuse so a wrong match is visible.
  formatted_address TEXT,

  -- Set only for `source = 'manual'`: who placed the pin and when. Same
  -- accountability role as `driver_messages.sent_by`.
  verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,

  hit_count INT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE geocode_cache IS
  'Resolved delivery locations, reused across imports. `manual` entries are '
  'human-verified and never overwritten by an automatic geocode.';

-- For a retention / staleness sweep: "everything not used since <date>".
CREATE INDEX IF NOT EXISTS idx_geocode_cache_last_used
  ON geocode_cache (last_used_at)
  WHERE source <> 'manual';

-- ---------------------------------------------------------------------------
-- lat/lng without the WKB, same trick as orders_geo / trucks_geo (0008).
-- security_invoker keeps RLS in force.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW geocode_cache_geo
  WITH (security_invoker = true) AS
SELECT
  gc.key,
  gc.source,
  gc.formatted_address,
  gc.verified_by,
  gc.verified_at,
  gc.hit_count,
  gc.first_seen_at,
  gc.last_used_at,
  ST_Y(gc.location::geometry) AS lat,
  ST_X(gc.location::geometry) AS lng
FROM geocode_cache gc;

COMMENT ON VIEW geocode_cache_geo IS
  'geocode_cache with lat/lng instead of WKB. security_invoker keeps RLS on.';

-- ---------------------------------------------------------------------------
-- Writing: an upsert that protects a manual pin.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_geocode_cache(
  p_key         TEXT,
  p_lat         DOUBLE PRECISION,
  p_lng         DOUBLE PRECISION,
  p_source      TEXT,
  p_formatted   TEXT DEFAULT NULL,
  p_verified_by UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO geocode_cache AS gc
    (key, location, source, formatted_address, verified_by, verified_at)
  VALUES (
    p_key,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_source,
    p_formatted,
    CASE WHEN p_source = 'manual' THEN p_verified_by END,
    CASE WHEN p_source = 'manual' THEN NOW() END
  )
  ON CONFLICT (key) DO UPDATE SET
    location          = EXCLUDED.location,
    source            = EXCLUDED.source,
    formatted_address = EXCLUDED.formatted_address,
    verified_by       = EXCLUDED.verified_by,
    verified_at       = CASE
                          WHEN EXCLUDED.source = 'manual' THEN NOW()
                          ELSE gc.verified_at
                        END,
    updated_at        = NOW()
  -- The guard: a fresh automatic geocode must not clobber a point a human
  -- verified. If the stored row is `manual` and the incoming one is not, the
  -- UPDATE matches nothing and the call is a silent no-op — which is correct.
  WHERE gc.source <> 'manual' OR EXCLUDED.source = 'manual';
END;
$$;

COMMENT ON FUNCTION public.upsert_geocode_cache IS
  'ST_MakePoint takes (lng, lat). A `manual` row is never overwritten by a '
  'non-manual upsert.';

-- Recording a reuse. Split from the read so a plain SELECT stays a SELECT.
CREATE OR REPLACE FUNCTION public.touch_geocode_cache(p_key TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE geocode_cache
     SET hit_count = hit_count + 1,
         last_used_at = NOW()
   WHERE key = p_key;
$$;

-- ---------------------------------------------------------------------------
-- RLS. Operational data — dispatchers run the imports and the fixes that fill
-- this — so the same open policy as orders / trucks / loads in 0004. A future
-- admin screen for pruning it can tighten DELETE if that ever matters.
-- ---------------------------------------------------------------------------
ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY geocode_cache_authenticated ON geocode_cache
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);
