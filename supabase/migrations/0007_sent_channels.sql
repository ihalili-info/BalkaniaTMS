-- Sent (sent.dm) supports RCS alongside SMS and WhatsApp.
--
-- `driver_messages.channel` was written against a two-channel provider. Widen
-- it rather than leaving a constraint that rejects a channel the provider can
-- actually deliver on.

ALTER TABLE driver_messages
  DROP CONSTRAINT IF EXISTS driver_messages_channel_check;

ALTER TABLE driver_messages
  ADD CONSTRAINT driver_messages_channel_check
  CHECK (channel IN ('sms', 'whatsapp', 'rcs'));

-- Sent returns a message_id on a 202; `provider_sid` is where it goes.
COMMENT ON COLUMN driver_messages.provider_sid IS
  'Sent message_id from the 202 response. Delivery receipts arrive on the '
  'status webhook and update `status`.';

COMMENT ON COLUMN driver_messages.channel IS
  'The channel actually used. NULL-equivalent "auto" is not stored: when the '
  'send omits `channel`, Sent chooses one and the receipt reports which.';
