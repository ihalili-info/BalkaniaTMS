-- Sales invoices, as issued by the CRM/ERP.
--
-- THE TMS NEVER COMPUTES MONEY. Every figure here is stored exactly as the ERP
-- sent it: unit prices, discounts, VAT rates, line amounts and totals. There is
-- deliberately no CHECK asserting that the lines sum to the totals, and no
-- trigger that recalculates anything. If the ERP's own totals disagree with the
-- sum of its own lines we store both and *report* the disagreement
-- (`invoices.totals_mismatch`) — the same posture the CRM order webhook takes
-- with an address that will not geocode: flag, never correct. A dispatcher
-- seeing a warning chip before the driver leaves is worth more than a silently
-- "fixed" invoice that disagrees with the customer's copy.
--
-- Money is NUMERIC, never DOUBLE PRECISION. A float cannot represent 0.10, and
-- an invoice that renders as 1234.56 in one place and 1234.5599999 in another
-- is a document nobody can sign.
--
-- This migration is the read-only half of the driver Bills feature: invoices
-- arrive from the CRM and dispatchers can see what is actually on the truck.
-- Driver logins, per-driver isolation and signature capture come in 0021/0022.
-- Policies here therefore use the existing `USING (TRUE)` idiom; 0021 flips the
-- whole access model in one reviewable file rather than spreading it over two.

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The ERP's own identity for this document. UNIQUE: a re-push of the same
  -- invoice updates in place rather than creating a second one.
  crm_invoice_id TEXT UNIQUE NOT NULL,
  -- What is printed on the paper — "B-0216022". Not assumed unique across
  -- years or document series, so it is not the key.
  invoice_no TEXT NOT NULL,
  invoice_date DATE NOT NULL,

  -- Link to the delivery. NULLABLE ON PURPOSE: an invoice can arrive before its
  -- order does, because picking runs ahead of dispatch. `crm_order_id` is kept
  -- raw so an unmatched invoice queues visibly instead of being dropped, and is
  -- re-resolved when the matching order lands.
  crm_order_id TEXT,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,

  -- The header block, as printed. A SNAPSHOT, not a join: the invoice must
  -- render the customer as they were when it was issued, even if the order's
  -- address is corrected afterwards.
  customer_name TEXT NOT NULL,
  customer_account_no TEXT,
  -- Where the signed PDF goes. May be NULL — an invoice with no email is not an
  -- error, it is a send that gets recorded as 'skipped' with a reason.
  customer_email TEXT,
  customer_phone TEXT,
  delivery_address TEXT NOT NULL,
  delivery_city TEXT,
  delivery_postcode TEXT,
  delivery_country CHAR(2) NOT NULL DEFAULT 'IE',
  -- Free text, as printed: "09:00", "Closed Mondays". Never parsed.
  opening_time TEXT,
  closing_time TEXT,
  sales_rep TEXT,

  -- Account position, as printed. Reference only — the TMS never acts on it and
  -- must never appear to be a ledger.
  previous_balance NUMERIC(12,2),
  current_balance NUMERIC(12,2),

  -- Totals, as printed.
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  case_count INTEGER,
  piece_count INTEGER,
  sub_total NUMERIC(12,2) NOT NULL,
  discount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_total NUMERIC(12,2) NOT NULL,
  grand_total NUMERIC(12,2) NOT NULL,

  -- TRUE when the lines do not add up to the totals the ERP sent. Computed once
  -- at ingest and never acted on: it drives a warning chip on the dispatcher's
  -- view so a bad export is visible before a driver takes it to a door.
  totals_mismatch BOOLEAN NOT NULL DEFAULT FALSE,

  -- Terms and bank details as printed, so the PDF is a faithful reproduction
  -- rather than a re-typed approximation that could differ from the paper.
  payment_terms TEXT,
  bank_details TEXT,

  -- The ERP withdrew this invoice. MARKED, NEVER DELETED — unlike a cancelled
  -- order (which the CRM feed removes outright), an invoice is a financial
  -- record with a six-year retention obligation, and one may already have been
  -- signed for. A voided invoice stays out of the driver's list and out of the
  -- dispatcher's default view, but it stays.
  voided_at TIMESTAMPTZ,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every list of invoices is "the live ones for these orders", so the partial
-- index carries the voided filter rather than making each query re-check it.
CREATE INDEX idx_invoices_order ON invoices (order_id) WHERE voided_at IS NULL;
-- Partial: the only time crm_order_id is looked up is to resolve an invoice
-- that has not been matched to an order yet.
CREATE INDEX idx_invoices_crm_order ON invoices (crm_order_id)
  WHERE order_id IS NULL;
CREATE INDEX idx_invoices_date ON invoices (invoice_date DESC);

CREATE TABLE invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,

  product_code TEXT,
  description TEXT NOT NULL,
  -- The ERP's own word for the unit: "BOX", "EACH", "KG". Not an enum — a new
  -- unit in the ERP must not need a migration here.
  unit TEXT,
  quantity NUMERIC(12,3) NOT NULL,
  -- 4dp: wholesale unit prices carry them (the paper shows 1.043).
  unit_price NUMERIC(12,4),
  case_price NUMERIC(12,4),
  discount_pct NUMERIC(5,2),
  -- The rate AND the ERP's code for it. Ireland runs S 23% / R 13.5% / Z 0% and
  -- a food wholesaler hits all three on one document. The code is what the VAT
  -- summary block groups by, and deriving it from the rate would break the day
  -- a rate changes.
  vat_code TEXT,
  vat_rate NUMERIC(5,2),
  amount_inc_vat NUMERIC(12,2) NOT NULL,

  UNIQUE (invoice_id, line_no)
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines (invoice_id, line_no);

-- The VAT summary block, as printed.
--
-- A real table rather than JSONB because it is a repeating structure that the
-- PDF renders row by row and that an auditor may one day query. JSONB would
-- hide it from both.
CREATE TABLE invoice_vat_totals (
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  vat_code TEXT NOT NULL,
  vat_rate NUMERIC(5,2) NOT NULL,
  net_amount NUMERIC(12,2) NOT NULL,
  vat_amount NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (invoice_id, vat_code)
);

COMMENT ON TABLE invoices IS
  'Sales invoices as issued by the ERP, and the document a driver presents at '
  'the door. FINANCIAL RECORDS: Irish Revenue requires VAT records be retained '
  'SIX YEARS (VAT Consolidation Act 2010 s.84). These rows are EXCLUDED from '
  'the notification/message retention sweep — do not add them to it. Contains '
  'customer personal data (name, address, email, phone).';

COMMENT ON COLUMN invoices.order_id IS
  'NULL means the invoice has not been matched to an order yet — normal when '
  'the invoice arrives before the order. Surface these; an unmatched invoice '
  'is invisible to the driver who needs it.';

COMMENT ON COLUMN invoices.totals_mismatch IS
  'The ERP''s totals disagree with the sum of its own lines. Reported, never '
  'corrected — the TMS does not compute money.';

-- ===========================================================================
-- The ingestion log
-- ===========================================================================
--
-- A clone of crm_webhook_deliveries (0015), deliberately NOT merged with it.
-- 0015 chose a table per feed so each Integration Settings card reads one
-- table; generalising them now would rewrite the CRM feed card for no benefit,
-- and the two feeds fail in different ways and get rotated on different
-- secrets.

CREATE TABLE invoice_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The invoice reference from the ERP, when the payload carried one.
  crm_invoice_id TEXT,

  action TEXT NOT NULL DEFAULT 'upsert'
    CHECK (action IN ('upsert', 'void')),

  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'created', 'updated', 'voided',
      'skipped', 'rejected', 'unauthorized', 'bad_request'
    )
  ),
  -- Why, in the same words the endpoint returns.
  reason TEXT,

  -- Kept only when something went wrong, and that is deliberate. A stored
  -- invoice is already in `invoices`; a failed one is undiagnosable without
  -- seeing what arrived. Carries customer personal data and line-level pricing,
  -- so it falls under the retention window — unlike `invoices` itself, this log
  -- is diagnostic and is NOT a six-year financial record.
  payload JSONB
);

CREATE INDEX idx_invoice_deliveries_received
  ON invoice_webhook_deliveries (received_at DESC);
CREATE INDEX idx_invoice_deliveries_outcome
  ON invoice_webhook_deliveries (outcome, received_at DESC);

COMMENT ON TABLE invoice_webhook_deliveries IS
  'Append-only log of invoice pushes to /api/webhooks/invoices. Diagnostic '
  'only — never a source of truth for an invoice. Contains customer personal '
  'data and pricing in failed payloads; purge on the configured retention '
  'window. NOT subject to the six-year invoice retention.';

-- ===========================================================================
-- RLS
-- ===========================================================================
--
-- The existing `USING (TRUE)` idiom, matching every other operational table.
-- Migration 0021 replaces these with staff/driver policies when driver logins
-- arrive — keeping the whole isolation change in one file.

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_vat_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoices_authenticated ON invoices
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY invoice_lines_authenticated ON invoice_lines
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY invoice_vat_totals_authenticated ON invoice_vat_totals
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

-- Readable by the team so a dispatcher can see the feed is alive. Writes come
-- only from the webhook, which uses the service role and bypasses RLS — there
-- is no user session on an inbound push.
CREATE POLICY invoice_deliveries_read ON invoice_webhook_deliveries
  FOR SELECT TO authenticated USING (TRUE);
