-- Dispatcher → driver messaging.
--
-- Scope, stated plainly because it is a deliberate boundary:
--
--   **Customers receive nothing from this table.** Their entire messaging
--   surface is the three automated types in `notifications` — dispatch
--   confirmation, proximity alert, delivery complete — fired by the geofence
--   engine and guarded by UNIQUE (load_item_id, type). No dispatcher-initiated
--   customer message exists, and adding one must be a deliberate change here,
--   not a flipped enum value.
--
-- This table is for sending a driver their route: navigation deep links they
-- can open in Waze, Google Maps or Apple Maps, plus the occasional free-text
-- note. A driver is staff being given a job, not a marketing recipient, so the
-- ePrivacy opt-out rules that govern `notifications` do not apply here.

CREATE TABLE driver_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  load_id UUID NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,

  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  -- Snapshotted, not joined: the number the message actually went to, even if
  -- the driver's record changes later.
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('route_link', 'custom')),

  -- Accountability. Sending a driver somewhere is an operational instruction.
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Sent's message id and the last delivery receipt it reported.
  provider_sid TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'undelivered', 'failed')),
  failure_reason TEXT
);

CREATE INDEX idx_driver_messages_load ON driver_messages (load_id, sent_at DESC);
CREATE INDEX idx_driver_messages_driver ON driver_messages (driver_id, sent_at DESC);
-- Retention purge, same as notifications: a driver's phone number and movements
-- are personal data too (GDPR Art. 5(1)(e)).
CREATE INDEX idx_driver_messages_sent_at ON driver_messages (sent_at);

COMMENT ON TABLE driver_messages IS
  'Dispatcher-initiated SMS/WhatsApp to drivers, chiefly navigation deep links. '
  'Never used for customer messaging — customers receive only the automated '
  'types in notifications. Personal data: subject to the retention window.';

-- ===========================================================================
-- RLS
-- ===========================================================================

ALTER TABLE driver_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY driver_messages_read ON driver_messages
  FOR SELECT TO authenticated USING (TRUE);

-- Attributed to the caller — a row cannot be written under someone else's name.
CREATE POLICY driver_messages_send ON driver_messages
  FOR INSERT TO authenticated
  WITH CHECK (sent_by = auth.uid());

-- Delivery receipts arrive on a Sent status webhook with no user session, so
-- the service role updates `status`. It bypasses RLS by design.
