-- Shared cache for routed ETAs (Google Routes `computeRoutes`, traffic-aware).
--
-- Active Loads and the Live Fleet Map ask Google for the road drive-time from
-- each active truck to its next undelivered stop. That call is the expensive
-- traffic-aware Routes tier, and it was throttled only by a `Map` held in the
-- module scope of `lib/data/fleet.ts`.
--
-- A process-local cache is close to no cache at all on Vercel. Every serverless
-- instance keeps its own copy, a cold start starts empty, and the board is
-- rendered far more often than anyone opens it: with `<Link>` prefetching, one
-- dispatcher opening any page caused a full server render of every sibling nav
-- route, Active Loads and the Live Fleet Map among them. Production logs showed
-- ~870 renders a day of those two routes against a handful of real visits, each
-- one able to miss the local cache and bill Google again.
--
-- So the throttle moves here, where every instance shares it. The TTL is
-- unchanged and lives in the application (`ROUTED_ETA_TTL_MS`); this table only
-- records when a leg was computed, and the reader decides what still counts as
-- fresh.
--
-- This is a cache, not a record. Nothing reads it for history, a miss is always
-- safe (the app just asks Google, or falls back to straight-line maths), and it
-- may be truncated at any time.

CREATE TABLE routed_eta_cache (
  -- Where the leg was routed from. CASCADE because a leg from a truck that no
  -- longer exists can never be reused.
  truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  -- The stop it was routed to. Same reasoning; a removed stop's ETA is dead.
  load_item_id UUID NOT NULL REFERENCES load_items(id) ON DELETE CASCADE,

  -- Google's answer, stored exactly as `RouteLeg` carries it.
  distance_m DOUBLE PRECISION NOT NULL,
  duration_s INTEGER NOT NULL,

  -- The truck position the leg was computed from. Not used to invalidate —
  -- the TTL does that — but without it a suspicious ETA cannot be explained
  -- after the fact, because `trucks.current_location` has since moved on.
  from_lat DOUBLE PRECISION NOT NULL,
  from_lng DOUBLE PRECISION NOT NULL,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One live leg per truck/stop pair. A re-route overwrites rather than
  -- accumulating, so the table stays the size of the active board.
  PRIMARY KEY (truck_id, load_item_id)
);

-- For the staleness sweep. Reads filter on `computed_at` too, but they are
-- already narrowed to the handful of pairs on the board.
CREATE INDEX idx_routed_eta_cache_computed_at ON routed_eta_cache (computed_at);

ALTER TABLE routed_eta_cache ENABLE ROW LEVEL SECURITY;

-- Operational data with no per-user ownership, same posture as `stop_visits`
-- and the rest of the dispatch board: both staff roles read and write it. The
-- writer here is a page render on the user's own session, not the service key.
-- See the Security Advisor note in the architecture doc for why the
-- `rls_policy_always_true` lint is expected on this family of tables.
CREATE POLICY routed_eta_cache_authenticated ON routed_eta_cache
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

COMMENT ON TABLE routed_eta_cache IS
  'Cache of traffic-aware Google Routes legs (truck -> next stop), shared across serverless instances. Freshness is decided by the reader against ROUTED_ETA_TTL_MS. Safe to truncate.';

COMMENT ON COLUMN routed_eta_cache.from_lat IS
  'Truck position the leg was computed from — diagnostic only, not an invalidation key.';
