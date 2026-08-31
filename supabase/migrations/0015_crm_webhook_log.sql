-- A record of what the CRM ingestion webhook actually receives.
--
-- Same rationale as gps_webhook_deliveries (migration 0009): without a log the
-- endpoint is a black box, and "no orders coming through" has several causes
-- that look identical from the app —
--
--   1. the CRM connector has never called (not deployed / wrong URL)
--   2. it calls but the Bearer token is wrong             -> 401 unauthorized
--   3. it calls but the orders fail validation            -> rejected
--   4. it calls, orders land, but without coordinates     -> queued for geocoding
--
-- Each of those needs a different fix, and guessing between them wastes a day.

CREATE TABLE crm_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The order reference from the CRM, when the payload carried one.
  crm_order_id TEXT,

  -- What the sender asked for: create/update an order, or cancel one.
  action TEXT NOT NULL DEFAULT 'upsert'
    CHECK (action IN ('upsert', 'cancel')),

  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'created', 'updated', 'cancelled',
      'skipped', 'rejected', 'unauthorized', 'bad_request'
    )
  ),
  -- Why, in the same words the endpoint returns.
  reason TEXT,

  -- Kept only when something went wrong, and that is deliberate. A stored order
  -- is already in `orders`; a failed one is undiagnosable without seeing what
  -- arrived. The CRM payload carries a customer name, phone and delivery
  -- address, so this is personal data and falls under the same retention
  -- window as notifications.
  payload JSONB
);

CREATE INDEX idx_crm_deliveries_received ON crm_webhook_deliveries (received_at DESC);
CREATE INDEX idx_crm_deliveries_outcome ON crm_webhook_deliveries (outcome, received_at DESC);

COMMENT ON TABLE crm_webhook_deliveries IS
  'Append-only log of CRM ingestion pushes to /api/webhooks/crm. Diagnostic '
  'only — never a source of truth for an order. Contains customer personal '
  'data in failed payloads; purge on the configured retention window.';

-- ===========================================================================
-- RLS
-- ===========================================================================

ALTER TABLE crm_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Readable by the team so a dispatcher can see the feed is alive. Writes come
-- only from the webhook, which uses the service role and bypasses RLS — there
-- is no user session on an inbound push.
CREATE POLICY crm_deliveries_read ON crm_webhook_deliveries
  FOR SELECT TO authenticated USING (TRUE);
