-- The GPS webhook subscription handshake.
--
-- Verizon's GPS Push Service does not start sending positions when the
-- endpoint is submitted. It first POSTs a subscription confirmation carrying a
-- `SubscribeURL`, and the subscription is only live once that URL has been
-- fetched. Unconfirmed submissions expire after three days.
--
-- Two new outcomes so the log can tell that story, and a place to keep the
-- URL in case the automatic confirmation fails and a human has to open it.

ALTER TABLE gps_webhook_deliveries
  DROP CONSTRAINT IF EXISTS gps_webhook_deliveries_outcome_check;

ALTER TABLE gps_webhook_deliveries
  ADD CONSTRAINT gps_webhook_deliveries_outcome_check
  CHECK (outcome IN (
    'stored',
    'skipped',
    'rejected',
    'unauthorized',
    'bad_request',
    'subscription_confirmed',
    'subscription_pending'
  ));

ALTER TABLE gps_webhook_deliveries
  -- Kept so the handshake can be completed by hand if the automatic fetch
  -- fails. It is a one-shot credential from Verizon, not a lasting secret,
  -- but it is still the key to the subscription — do not paste it around.
  ADD COLUMN IF NOT EXISTS subscribe_url TEXT;

COMMENT ON COLUMN gps_webhook_deliveries.subscribe_url IS
  'SubscribeURL from a subscription confirmation message. Fetching it is what '
  'activates the feed. Retained only so a failed auto-confirm can be finished '
  'manually before the three-day window closes.';
