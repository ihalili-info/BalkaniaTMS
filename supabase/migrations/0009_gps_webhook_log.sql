-- A record of what the GPS webhook actually receives.
--
-- Without this the endpoint is a black box. "No fixes yet" has at least four
-- causes that look identical from the app:
--
--   1. Verizon has never called (endpoint not registered with them)
--   2. Verizon calls but the credentials are wrong  -> 401
--   3. Verizon calls with positions for Vehicle Numbers we do not have
--   4. Verizon calls but the fixes fail validation (no number, 0,0, bad time)
--
-- Each of those needs a different fix, and guessing between them wastes a day.

CREATE TABLE gps_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  /** Reveal Vehicle Number, when the payload carried one. */
  vehicle_number TEXT,

  outcome TEXT NOT NULL CHECK (
    outcome IN ('stored', 'skipped', 'rejected', 'unauthorized', 'bad_request')
  ),
  /** Why, in the same words the endpoint returns. */
  reason TEXT,

  -- Kept only when something went wrong, and that is deliberate. A stored fix
  -- needs no copy — the position is already on the truck row. A failed one is
  -- undiagnosable without seeing what actually arrived.
  --
  -- Reveal's payload can carry a driver's name, so this is personal data and
  -- falls under the same retention window as notifications.
  payload JSONB
);

CREATE INDEX idx_gps_deliveries_received ON gps_webhook_deliveries (received_at DESC);
CREATE INDEX idx_gps_deliveries_outcome ON gps_webhook_deliveries (outcome, received_at DESC);

COMMENT ON TABLE gps_webhook_deliveries IS
  'Append-only log of Verizon Connect Reveal GPS pushes. Diagnostic only — '
  'never a source of truth for position. Contains personal data (driver name '
  'in failed payloads); purge on the configured retention window.';

-- ===========================================================================
-- RLS
-- ===========================================================================

ALTER TABLE gps_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Readable by the team so a dispatcher can see the feed is alive. Writes come
-- only from the webhook, which uses the service role and bypasses RLS — there
-- is no user session on an inbound push.
CREATE POLICY gps_deliveries_read ON gps_webhook_deliveries
  FOR SELECT TO authenticated USING (TRUE);
