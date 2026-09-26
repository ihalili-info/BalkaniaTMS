-- 0023: WhatsApp is the only messaging channel.
--
-- Sent (sent.dm) is gone; messages now go out over Meta's WhatsApp Business
-- Cloud API directly, and SMS / RCS are no longer used. Two things follow in
-- the database.
--
-- 1. `driver_messages.channel` accepts only 'whatsapp' from now on. The earlier
--    CHECK (0005, widened in 0007) allowed 'sms' and 'rcs'; rows written under
--    it are history and stay readable, so the new constraint is NOT VALID —
--    enforced for every INSERT and UPDATE from here, never re-checked against
--    the rows already there. (Run VALIDATE CONSTRAINT later only if those rows
--    are ever purged or rewritten.)
--
-- 2. The 'sent' connector's saved settings are dead config. Its template ids
--    were Sent-dashboard uuids; WhatsApp templates are addressed by name and
--    live under the 'whatsapp' connector. Delete the stale row rather than
--    leave a settings record for an integration that no longer exists.

ALTER TABLE driver_messages
  DROP CONSTRAINT IF EXISTS driver_messages_channel_check;

ALTER TABLE driver_messages
  ADD CONSTRAINT driver_messages_channel_whatsapp_only
  CHECK (channel = 'whatsapp') NOT VALID;

COMMENT ON COLUMN driver_messages.channel IS
  'Always whatsapp for new rows (0023). Older rows may say sms or rcs from the '
  'Sent era; they are history.';

COMMENT ON COLUMN driver_messages.provider_sid IS
  'WhatsApp message id (wamid.…) from the Cloud API response. Accepted-by-Meta, '
  'not delivered: receipts arrive on a status webhook that is not consumed, so '
  '`status` is set at send time only.';

DELETE FROM integration_settings WHERE connector_id = 'sent';
