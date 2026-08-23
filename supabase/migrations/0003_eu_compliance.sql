-- EU / UK regulatory model.
--
-- The operation is Ireland-based today and expanding into the rest of the EU
-- and the UK, so nothing here hard-codes Ireland. Country is a column, and the
-- rules that vary by country (weight and height limits, customs regime,
-- postcode format) live in `web/src/lib/regions.ts` keyed by these codes.
--
-- Country codes are ISO 3166-1 alpha-2 with one deliberate addition: `XI` for
-- Northern Ireland. That is not decoration — `XI` is the real EORI/VAT prefix
-- used for NI under the Windsor Framework, and NI genuinely behaves as its own
-- customs territory, distinct from `GB`.

-- ===========================================================================
-- 1. Drivers  (Reg. (EU) 165/2014, Directive 2003/59/EC)
-- ===========================================================================
--
-- Until now the panel showed a driver name that was not stored anywhere. EU
-- driving-time law makes the driver a first-class record: the limits are per
-- *driver*, tracked against a personal tachograph card, and they are what makes
-- a dispatch plan legal or illegal.

CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT,
  home_country CHAR(2) NOT NULL DEFAULT 'IE',

  -- Smart tachograph driver card. Unique across the fleet; the number on the
  -- card is what the tachograph feed reports duty against.
  tachograph_card_no TEXT UNIQUE,

  -- Driver CPC: 35 hours of periodic training every 5 years. A driver whose
  -- CPC has lapsed may not drive commercially, so dispatch has to see it.
  cpc_expires_on DATE,
  driving_licence_no TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Current duty snapshot, overwritten by each tachograph sync.
--
-- Deliberately a denormalised snapshot rather than an event log: the dispatch
-- board only ever asks "can this driver legally reach the next stop", and that
-- is a handful of counters. A full duty-event history belongs in the
-- tachograph provider's own system, which is the legal record of it anyway.
ALTER TABLE drivers
  ADD COLUMN duty_status TEXT NOT NULL DEFAULT 'off_duty'
    CHECK (duty_status IN ('driving', 'break', 'rest', 'other_work', 'available', 'off_duty')),
  -- Reg. 561/2006 Art. 7: 45 min break after 4h30 accumulated driving.
  ADD COLUMN driving_seconds_since_break INTEGER NOT NULL DEFAULT 0
    CHECK (driving_seconds_since_break >= 0),
  -- Art. 6(1): 9h daily, extendable to 10h no more than twice a week.
  ADD COLUMN driving_seconds_today INTEGER NOT NULL DEFAULT 0
    CHECK (driving_seconds_today >= 0),
  ADD COLUMN extended_days_this_week SMALLINT NOT NULL DEFAULT 0
    CHECK (extended_days_this_week BETWEEN 0 AND 2),
  -- Art. 6(2)/(3): 56h in a week, 90h across any two consecutive weeks.
  ADD COLUMN driving_seconds_this_week INTEGER NOT NULL DEFAULT 0
    CHECK (driving_seconds_this_week >= 0),
  ADD COLUMN duty_synced_at TIMESTAMPTZ;

CREATE INDEX idx_drivers_duty_synced ON drivers (duty_synced_at DESC);

-- ===========================================================================
-- 2. Loads gain a real driver, and a customs position
-- ===========================================================================

ALTER TABLE loads
  ADD COLUMN driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  ADD COLUMN origin_country CHAR(2) NOT NULL DEFAULT 'IE',
  -- CMR consignment note (Convention on the Contract for the International
  -- Carriage of Goods by Road). Required for international carriage by road,
  -- never for a purely domestic run.
  ADD COLUMN cmr_number TEXT;

CREATE INDEX idx_loads_driver ON loads (driver_id);

-- ===========================================================================
-- 3. Orders: destination country, postcode, and messaging consent
-- ===========================================================================

ALTER TABLE orders
  ADD COLUMN delivery_country CHAR(2) NOT NULL DEFAULT 'IE',
  -- Eircode in IE, postcode in GB/XI, CP/PLZ/etc. elsewhere. Free text
  -- because the format is a per-country rule, validated in the app.
  ADD COLUMN delivery_postcode TEXT,

  -- GDPR / ePrivacy (Directive 2002/58/EC).
  --
  -- The delivery alerts are transactional — performance of the contract under
  -- Art. 6(1)(b) GDPR, not marketing — so they do not need prior opt-in. But
  -- the customer can still object, and a STOP reply must be honoured
  -- immediately and permanently. Nothing may be sent when this is true.
  ADD COLUMN notifications_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN opted_out_at TIMESTAMPTZ;

CREATE INDEX idx_orders_country ON orders (delivery_country);

-- The alert query must never pick up an opted-out customer, so make that
-- cheap and hard to forget.
CREATE INDEX idx_orders_alertable ON orders (id)
  WHERE notifications_opt_out = FALSE;

-- ===========================================================================
-- 4. Trucks: weights, dimensions, emissions  (Directive 96/53/EC)
-- ===========================================================================
--
-- `capacity_kg` from 0002 is *payload*. Gross vehicle weight is the regulated
-- figure and the two are routinely confused, so both are stored explicitly.

ALTER TABLE trucks
  ADD COLUMN gross_weight_kg INTEGER
    CHECK (gross_weight_kg IS NULL OR gross_weight_kg > 0),
  -- Ireland and the UK permit 4.65 m; most of mainland Europe caps at 4.00 m.
  -- A vehicle legal at home can be illegal on the continent, so the number has
  -- to travel with the truck.
  ADD COLUMN height_m NUMERIC(3, 2)
    CHECK (height_m IS NULL OR height_m > 0),
  ADD COLUMN length_m NUMERIC(4, 2)
    CHECK (length_m IS NULL OR length_m > 0),
  -- Euro emission standard — gates access to urban low-emission zones.
  ADD COLUMN euro_emission_class SMALLINT
    CHECK (euro_emission_class IS NULL OR euro_emission_class BETWEEN 1 AND 7),
  -- Which ADR classes this unit is licensed to carry, e.g. {'3','8'}. The
  -- `adr` equipment tag says *whether*; this says *what*.
  ADD COLUMN adr_classes TEXT[] NOT NULL DEFAULT '{}';

-- Payload can never exceed gross weight.
ALTER TABLE trucks
  ADD CONSTRAINT trucks_payload_within_gross
  CHECK (
    capacity_kg IS NULL
    OR gross_weight_kg IS NULL
    OR capacity_kg <= gross_weight_kg
  );

-- ===========================================================================
-- 5. Notification retention  (GDPR Art. 5(1)(e), storage limitation)
-- ===========================================================================
--
-- `notifications` rows tie a phone number to a delivery address and a time.
-- They may not be kept indefinitely. The purge job runs on a schedule; this
-- index is what keeps it cheap.

CREATE INDEX idx_notifications_sent_at ON notifications (sent_at);

COMMENT ON TABLE notifications IS
  'Customer alert log. Personal data under GDPR — subject to the retention '
  'period configured in the admin panel. A scheduled job deletes rows older '
  'than that window; see idx_notifications_sent_at.';
