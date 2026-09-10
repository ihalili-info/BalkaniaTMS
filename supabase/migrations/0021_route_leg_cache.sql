-- Shared cache for traffic-unaware routed legs (HERE Matrix Routing v8).
--
-- The auto-planner buys a road matrix per proposed group: depot plus up to
-- `maxStops` drops, every ordered pair. A group of eight drops is 81 elements,
-- and a 60-order selection is roughly eight such groups — so simply *opening*
-- the auto-plan dialog spent ~650 matrix elements before the dispatcher
-- touched a control.
--
-- Until now the only thing holding those legs was a module-level object in the
-- browser (`legCache` in `components/auto-plan-dialog.tsx`). That survives the
-- dialog closing and nothing else: a refresh, a hard navigation or a second
-- dispatcher started from empty and re-bought the lot. Same shape of mistake
-- as the in-process `Map` that 0020 moved into `routed_eta_cache`, one layer
-- further out.
--
-- **These legs do not go stale the way an ETA does.** `routeMatrix` is
-- deliberately traffic-unaware — a plan is built well before the truck rolls —
-- so the road distance and free-flow drive time between two fixed coordinates
-- is a property of the road network, not of the moment. There is no TTL in the
-- reader. `computed_at` exists so a sweep can retire legs the road network may
-- have outgrown, and for explaining a suspicious figure after the fact.
--
-- This is a cache, not a record. Nothing reads it for history, a miss is always
-- safe (the planner asks HERE, or falls back to straight-line maths), and it
-- may be truncated at any time.

CREATE TABLE route_leg_cache (
  -- `coordKey()` from `lib/format.ts`: "lat,lng" at five decimal places, about
  -- a metre. Text rather than a geography pair because this is an exact-match
  -- cache key, never a spatial query — and because the planner already holds
  -- its legs under exactly this string.
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,

  -- Which routing shape produced the leg, from `matrixProfileKey()`.
  --
  -- Load-bearing, and the reason this is not a two-column key. `routeMatrix`
  -- picks between a region-bounded request carrying the real vehicle
  -- dimensions and a `world` request pinned to the generic `truckFast`
  -- profile, based on how far apart the points are. Those two answers differ —
  -- one avoids the 4.0 m bridge and the 7.5 t lane, the other does not — so a
  -- leg computed under one must never be served as the other.
  profile TEXT NOT NULL,

  distance_m DOUBLE PRECISION NOT NULL,
  duration_s INTEGER NOT NULL,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One leg per direction per profile. A→B and B→A are separate rows on
  -- purpose: one-way systems and motorway junctions are not symmetric, and the
  -- planner's nearest-neighbour sequencing reads both directions.
  PRIMARY KEY (from_key, to_key, profile)
);

-- For a future staleness sweep. Reads never filter on it — they are exact-key
-- lookups on the primary key.
CREATE INDEX idx_route_leg_cache_computed_at ON route_leg_cache (computed_at);

ALTER TABLE route_leg_cache ENABLE ROW LEVEL SECURITY;

-- Operational data with no per-user ownership, same posture as
-- `routed_eta_cache`, `stop_visits` and the rest of the dispatch board: both
-- staff roles read and write it. The writer is a server action running on the
-- user's own session, not the service key. See the Security Advisor note in
-- the architecture doc for why the `rls_policy_always_true` lint is expected
-- on this family of tables.
CREATE POLICY route_leg_cache_authenticated ON route_leg_cache
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

COMMENT ON TABLE route_leg_cache IS
  'Cache of traffic-unaware HERE matrix legs for the auto-planner, shared across serverless instances and sessions. No TTL: these legs are a property of the road network, not of the moment. Safe to truncate.';

COMMENT ON COLUMN route_leg_cache.profile IS
  'Routing shape that produced the leg (matrixProfileKey): bounded requests carry real vehicle dimensions, world requests use the generic truckFast profile. Never serve one as the other.';
