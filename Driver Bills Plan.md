# Driver Bills — `tms.balkania.ie/bills`

## Context

Balkania's proof-of-delivery is paper today. The driver carries a printed ERP
invoice (e.g. `B-0216022`), the customer signs it at the door, and outcomes are
annotated in pen — the sample that prompted this work reads **"Not Delivered"**
across the header. Nothing about that flow reaches the TMS, so dispatch cannot
see what was actually delivered, refused, or left in the van, and the customer
gets no receipt.

This builds the digital equivalent: drivers sign in on their phones, see only
their own loads' invoices, capture the customer's signature at the door, and a
signed PDF is emailed to the customer. The driver surface is a PWA because it
runs on a phone at a loading bay with poor signal.

**Two corrections to the original brief:**

1. **Supabase SMTP cannot do this.** It only sends templated Auth emails (magic
   link, invite, reset) and cannot attach a PDF. Email goes via Balkania's own
   `balkania.ie` SMTP through nodemailer instead — no new vendor, and the mail
   comes from the real domain, which matters for an invoice.
2. **A refused delivery is a first-class outcome, not an error path.** The paper
   flow proves it. This is also the single hardest item in the build (see
   Hazards).

## Decisions taken

| Question | Decision |
|---|---|
| Invoice data source | **CRM pushes invoices** — new webhook mirroring `/api/webhooks/crm`. The TMS never computes money. |
| Email transport | **Own balkania.ie SMTP** via nodemailer, modelled as a connector. |
| Driver accounts | **Admin-provisioned invite** from Fleet › Drivers. No self-signup. |
| Signing | **Customer signs on the driver's phone.** No public signing link. |

## Starting position

Verified in the codebase, and each one shapes the plan:

- **`drivers` has no link to auth at all** — no `user_id`, no email. Drivers are
  data rows with no login capability.
- **No invoice/bill table exists**, and `orders` carries no prices, line items,
  or customer email.
- **`canAccessPath` fails OPEN** — `roles.ts:131` returns `true` for any path not
  in the module registry. An unregistered `/bills` is readable by everyone.
- **`isRole` is hardcoded** to `"admin" || "dispatcher"` (`roles.ts:135`), so a
  new role silently falls back to `dispatcher` in `getCurrentUser()`.
- **RLS is `USING (TRUE)` on every operational table.** Migration 0017 documents
  this as deliberate, ending *"Revisit only if per-user data isolation becomes a
  requirement."* This feature is that trigger.
- **`handle_new_user()` hardcodes `'dispatcher'`** for every new auth user.
- **Nothing PWA exists** — no manifest, service worker, icons, or viewport export.
- **No PDF, email, or signature dependency**, and Supabase Storage is unused.

---

## 1. Schema

Three migrations, next number is **0020**. Follow the house style: numbered,
heavy prose comment at the top, RLS in the same file, `COMMENT ON TABLE` on
anything holding personal data.

### `0020_invoices.sql`

`invoices` + `invoice_lines` + `invoice_vat_totals` + `invoice_webhook_deliveries`
(a clone of `crm_webhook_deliveries` from 0015 — do **not** merge the two logs).

Key modelling rules, each with a reason:

- **Money is `NUMERIC(12,2)`, never float.** Unit prices are `NUMERIC(12,4)` —
  wholesale carries 4dp (the sample shows `1.043`).
- **The header is a snapshot, not a join.** `customer_name`, `delivery_address`,
  `delivery_postcode` etc. are copied onto the invoice, so it renders as issued
  even if the order's address is corrected later.
- **`order_id` is nullable**, with `crm_order_id` stored raw. Invoices can arrive
  before their order (picking runs ahead of dispatch); an unmatched invoice
  queues visibly instead of being dropped, and is re-resolved when the order lands.
- **`totals_mismatch BOOLEAN`** — set at ingest when the lines don't sum to the
  ERP's totals. Never corrected, only reported. Same posture as an address that
  won't geocode: flag, never fix.
- **`customer_email`** — the address the signed PDF goes to. Does not exist
  anywhere today; must be added to the CRM payload contract.
- **`invoice_vat_totals` is a table, not JSONB.** Ireland runs S 23% / R 13.5% /
  Z 0% and a food wholesaler hits all three on one document; the PDF renders it
  row by row and an auditor may query it.

```sql
COMMENT ON TABLE invoices IS
  'Sales invoices as issued by the ERP. Financial records: Irish Revenue '
  'requires VAT records be retained SIX YEARS (VAT Consolidation Act 2010 '
  's.84). EXCLUDED from the notification retention sweep — do not add them.';
```

Ship 0020 with the existing `USING (TRUE)` policy idiom; 0021 flips the whole
model in one reviewable file.

### `0021_driver_accounts.sql`

```sql
ALTER TABLE drivers
  -- NULL = no login, the normal state for a driver who only appears on the
  -- board. UNIQUE because the RLS helper resolves a uid to at most one driver
  -- and a second match would silently widen access. SET NULL not CASCADE:
  -- deleting an auth user must not delete the driver loads are attributed to.
  ADD COLUMN user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN email TEXT,
  ADD COLUMN invited_at TIMESTAMPTZ;

CREATE INDEX idx_drivers_user ON drivers (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'dispatcher', 'driver'));
```

Plus the RLS rewrite (§2) — the dangerous migration, in its own file.

### `0022_delivery_receipts.sql`

`delivery_receipts` is the table the feature turns on. **Append-only event log,
one row per delivery *attempt*** — a refusal followed by a redelivery is two
rows, and neither may be edited away.

| Column | Why |
|---|---|
| `outcome` | `delivered` / `partial` / `refused` / `no_access`. The pen annotation, made structured. |
| `outcome_reason` | Required for anything but a clean `delivered`. |
| `signed_by_name`, `signature_path`, `signature_sha256` | The hash lets the PDF prove the image in the document is the image captured. |
| `payment_method`, `amount_collected` | The CASH/CHEQUE/CARD boxes. Reference only — the TMS does not reconcile cash and must not appear to. |
| `captured_at` **and** `recorded_at` | Two clocks. A receipt queued offline and uploaded two hours later must not claim it was recorded at the door. |
| `client_event_id UUID UNIQUE` | Minted on the device before queueing, so a retried upload can't create a second receipt. Same role as the Sent `Idempotency-Key`. |
| `pdf_path`, `pdf_sha256` | Stored, not regenerated (§6). |

`load_item_id` and `invoice_id` are `ON DELETE RESTRICT` — deleting a load must
not be able to destroy proof a delivery happened. `deleteLoad()` already refuses
once a stop is delivered; this makes the database enforce it.

Also `delivery_receipt_lines` (per-line accepted quantities for a partial) and
`invoice_emails` (send audit: `queued`/`sent`/`failed`/`skipped`, attempts,
last error).

---

## 2. RLS tightening — the part that can lock the company out

### Helpers (`0021`)

Follow the 0004 + 0017 idiom exactly: `STABLE SECURITY DEFINER SET search_path =
public`, then `REVOKE ... FROM anon, PUBLIC; GRANT ... TO authenticated`.

```sql
CREATE OR REPLACE FUNCTION public.current_driver_id() RETURNS UUID ...
  SELECT id FROM public.drivers WHERE user_id = auth.uid();

-- Staff = admin/dispatcher AND not linked to a driver row.
-- The second clause closes a real window: handle_new_user() makes every new
-- auth user a 'dispatcher', so a driver is a dispatcher in `profiles` until
-- provisioning updates them. Requiring "no drivers row" means linking
-- drivers.user_id is what actually demotes them — and that link is set by the
-- same admin action that sends the invite, before it can be accepted.
CREATE OR REPLACE FUNCTION public.is_staff() RETURNS BOOLEAN ...
  SELECT public.current_role_name() IN ('admin','dispatcher')
     AND public.current_driver_id() IS NULL;
```

Consequence, deliberate: **one login cannot be both staff and a driver.** Give
them two accounts.

### Policy rewrite

Permissive policies OR together, so the pattern is: replace the always-true
policy with a staff policy, then add a narrow driver `SELECT` alongside.

```sql
DROP POLICY loads_authenticated ON loads;
CREATE POLICY loads_staff ON loads FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY loads_driver_read ON loads FOR SELECT TO authenticated
  USING (driver_id = (SELECT public.current_driver_id()));
```

Same shape for `load_items`, `orders`, `invoices` (traversing `load_items → loads
→ driver_id`), and `drivers` (own row only, no driver writes — tachograph
counters are not theirs to edit). `trucks`, `stop_visits`, `geocode_cache`,
`notifications` and the webhook logs become **staff-only**; adding a driver
policy "just in case" is how isolation leaks back.

Two performance notes:

- **Wrap every helper call as `(SELECT public.fn())`** so Postgres evaluates it
  once per statement as an InitPlan rather than once per row. Without it the
  dispatch board's load query goes quadratic.
- **Verify `load_items(load_id)` is indexed** — 0001 created no index on it. Add
  `idx_load_items_load` and `idx_load_items_order` in the same migration or the
  `EXISTS` clauses table-scan.

`delivery_receipts` gets **read policies only**. No INSERT/UPDATE/DELETE for
anyone — receipts are written solely by the service role from
`POST /api/bills/receipts`, which re-checks ownership in application code. A
driver-facing INSERT policy would have to trust client-supplied `driver_id`,
`captured_at` and `signature_path`: exactly the fields that make the row evidence.

**Fail-closed divergence to handle first.** `is_staff()` returns FALSE when
`profiles` has no row, but `getCurrentUser()` falls back to `dispatcher` and only
*warns*. After this migration a missing profile stops being cosmetic and becomes
a blank dispatch board. **Run `supabase/bootstrap_profiles.sql` immediately
before 0021**, and update the `ProfileWarning` copy to say so.

---

## 3. Role, routing, and the fail-open hazard

In `web/src/lib/auth/roles.ts`:

- `Role = "admin" | "dispatcher" | "driver"`, plus a `ROLES.driver` entry.
- **Rewrite `isRole` to derive from `ROLES`** (`value in ROLES`). Leaving it
  hardcoded makes `getCurrentUser()` coerce a driver into a dispatcher, leaving
  `is_staff()` as the only thing protecting the board.
- **Rename `ALL` to `STAFF`** and leave its members unchanged, with a comment
  that a new role is opt-in and never inherited. That rename is what stops a
  future module accidentally exposing itself to drivers.
- Register `{ id: "bills", href: "/bills", roles: ["driver", "admin"] }` in a new
  `"Driver"` module group.
- **Fix the fail-open** with an explicit allowlist — `UNGATED_PATHS = ["/",
  "/sign-in", "/forbidden", "/account"]`, everything else unregistered is
  refused. `/account` must be in that list or everyone loses their password page.
- Add `landingPathFor(role)` — `driver → /bills`, else `/active-loads`.

Guards in `web/src/lib/auth/guard.ts`:

- `requireStaff()` — redirects a driver to `/bills`, **not** `/forbidden`. A
  driver hitting the board from a bookmark hasn't done anything wrong, and a
  forbidden page on a phone is a dead end. Call it once in
  `(dashboard)/layout.tsx` — one choke point covering all six sections, five of
  which have no server-side role check today.
- `requireDriverProfile()` — resolves the `drivers` row via `user_id`, with a
  distinct explanatory page when a driver has no linked row (half-completed
  provisioning, which otherwise presents as an empty list).

Landing changes: `lib/auth/actions.ts` `signIn()` (hardcodes `/active-loads`),
`app/page.tsx`, and the `/forbidden` back-link.

New route group, with its own lightweight layout — **it must not inherit
`(dashboard)/layout.tsx`, which fetches all trucks/loads/orders on every request
just for rail counters**:

```
web/src/app/(driver)/layout.tsx                        — requireDriverProfile(), no fleet queries
web/src/app/(driver)/bills/page.tsx                    — today's stops for this driver
web/src/app/(driver)/bills/[invoiceId]/page.tsx        — the invoice
web/src/app/(driver)/bills/[invoiceId]/sign/page.tsx   — signing screen
web/src/components/driver/driver-shell.tsx             — top bar + thumb-reachable bottom bar
web/src/components/driver/signature-pad.tsx
web/src/lib/data/bills.ts                              — narrow driver read layer
```

`components/app-shell.tsx` is a `fixed w-rail` desktop sidebar with essentially
no responsive treatment — **do not try to make it responsive.** Build
`driver-shell.tsx` fresh from the same `globals.css` tokens. 44px touch targets,
`text-body` not `text-caption`.

`lib/data/bills.ts` must be separate from `getLoads()`, which fetches trucks and
can route ETAs through Google. A driver on 3G at a loading bay issues one narrow
query.

---

## 4. PWA

**Hand-roll the service worker (~150 lines), don't adopt `@serwist/next`.**
Precaching Next's build output buys little here — `/_next/static/*` is
content-hashed and `immutable`, and every screen needs the network anyway.
Workbox strategies are one `if` each when the policy is "network-only for
everything that matters". This matches the repo's culture (hand-rolled RFC 4180
parser, dependency-free SVG charts). Write the escape hatch down: if precaching
the shell across deploys becomes necessary, `@serwist/next` is the thing to adopt.

Caching policy — **stale data is the primary risk in this feature**:

```
NEVER cache:   /api/*, *.supabase.co/*, navigations to /bills/*, anything
               with Set-Cookie. A cached invoice is a WRONG invoice.
Cache-first:   /_next/static/*, /icons/*, manifest, apple-touch-icon
Network-first: navigations inside /bills (3s timeout → /offline)
Pass through:  everything else, untouched
```

That last rule matters: the SW registers at scope `/`, so it installs for a
dispatcher who visits. A strict no-op outside driver paths means a SW bug cannot
take the dispatch board down.

Also a **product** rule, not a caching rule: show "loaded at HH:MM" and refuse to
sign an invoice whose local copy is older than N minutes without a refresh.

Files: `public/manifest.webmanifest` (`start_url`/`scope` = `/bills`,
`display: standalone`, `theme_color` from `--color-rail`), `public/icons/`
(192, 512, 512-maskable, 180 apple-touch), `public/sw.js`, `app/offline/page.tsx`,
and `viewport`/`appleWebApp` exports in `app/layout.tsx` — **do not set
`userScalable: false`**, it's a WCAG failure and Safari ignores it.

**Proxy fix, or nothing installs.** `manifest.webmanifest`, `sw.js` and
`apple-touch-icon.png` currently fall through `proxy.ts`'s matcher to the auth
check and get a 302 to `/sign-in` — the SW registration fails outright because
the response isn't JavaScript. Add them to the **matcher** (not `PUBLIC_PATHS`),
which also skips the `getUser()` round trip. While in there, the existing matcher
has an unescaped `\.` inside a JS string literal; worth fixing.

**Offline queue** (Stage 5): hand-rolled IndexedDB in `lib/driver/queue.ts`, one
store keyed on `client_event_id`. Flush on submit, on `online`, and on shell
mount — **`SyncManager` is a bonus, not the design**, because iOS Safari has no
Background Sync and half the drivers will be on iPhones. Server dedupes on the
unique constraint and returns `200` with the existing receipt, never `409`. A
visible "2 receipts waiting" chip — a silent queue is how a driver finishes a
route believing everything is filed. Test the offline-session-expiry path
explicitly; it's the one that loses real signatures.

---

## 5. Signature capture

**Hand-roll the canvas** in `components/driver/signature-pad.tsx`. The details
that actually matter and need no library:

- Size the backing store by `devicePixelRatio` and scale the context, or it's a
  blurry mess on a phone.
- `touch-action: none` on the canvas plus Pointer Events and
  `setPointerCapture` — without it the browser scrolls instead of drawing.
- Reject a near-empty canvas by tracking total path length. A blank signature
  that validates is worse than none.
- Export `canvas.toBlob(cb, "image/png")` — ~20 kB at 600×200 @2×.

`signature_pad`'s real value is variable-width Bézier smoothing. Budget a
half-day and a **real-device test**; if the hand-rolled version looks scratchy,
that's the moment to reconsider — a legible signature is the product.

**Storage: a private `pod` bucket, written only by the service role.** Ruled out:
`bytea` (every `select *` drags images across the wire) and data URLs (33% larger
and inlined into every query). Do **not** grant `authenticated` any policy on
`storage.objects` — instead the browser POSTs multipart to
`/api/bills/receipts`, which re-checks the session, verifies the driver owns the
load, then writes the row and uploads with the service client. Reads go through a
handler minting a 60s signed URL after the same check. This reuses the existing
"service-role-written, application-checked" pattern (`lib/supabase/service.ts`,
`crm_webhook_deliveries`) and means exactly one reviewable code path can create a
signature object. Storage is a new surface here — confirm the Supabase project
region is EU; the bucket inherits it.

---

## 6. PDF generation

**Rule out headless Chrome.** `puppeteer-core` + `@sparticuz/chromium` is ~50 MB
of binary, pushes Vercel's function size limit, needs 1–2 GB memory and gives
5–10 s cold starts — to render one fixed-layout page. A Chromium bump breaking
PDF generation at 6 a.m. is a real operational cost.

**Use `pdf-lib`** over `@react-pdf/renderer`: one pure-JS dependency, no WASM
layout engine, no second styling language alongside Tailwind. There is no
reasonable way to hand-roll a PDF writer, so the dep earns itself.

**The trap:** `StandardFonts.Helvetica` is WinAnsi-only. `€` is fine; Balkan and
Eastern European names (`č`, `ć`, `ž`, `ł`, `ș`) are **not**, and `drawText`
*throws* rather than substituting. For a company called Balkania this will
happen. Embed a subsetted TTF via `@pdf-lib/fontkit` and **decide it up front** —
retrofitting a font after the layout is built is a re-layout.

- `lib/invoices/pdf.ts` is **pure**: plain document object in, `Uint8Array` out.
  No Supabase, no clock, no env — same discipline as `lib/load-planner.ts`, so
  the layout can be iterated against a fixture.
- **Not in the signing request.** The driver taps Confirm and gets an answer as
  soon as the receipt commits; PDF + email is a follow-on step.
  `runtime = "nodejs"`, `maxDuration = 30`.
- **Store, don't regenerate.** `invoices` rows are mutable (the CRM repushes), so
  regenerating in 2028 could differ from what's in the customer's inbox — exactly
  what a PoD exists to prevent. Hash it, treat it as immutable. Regeneration is a
  fallback only, and must be visibly marked a reproduction.
- **The PDF is a delivery receipt reproducing the ERP's invoice, not a second VAT
  invoice.** A partial delivery shows accepted quantities as a note and must not
  restate a different total.

Honest estimate: a table with right-aligned money columns, wrapped descriptions,
a per-rate VAT block and a totals box is **real layout work** in pdf-lib — you
write your own text measurement and wrapping. **Two to three days, not an
afternoon.** This is the most underestimated item in the request.

---

## 7. Email

nodemailer is the one dependency that clearly earns its keep — SMTP is a stateful
line protocol (EHLO negotiation, STARTTLS, AUTH, MIME multipart, header
word-encoding, dot-stuffing), unlike `sent.ts`/`shortio.ts` which are `fetch` +
JSON and correctly hand-rolled.

- `lib/messaging/smtp.ts` — mirrors `sent.ts`: `sendInvoiceEmail()` and
  `verifyConnection()`, returning a discriminated result rather than throwing.
- Add an `smtp` connector to `lib/integrations/catalogue.ts` — env vars
  (`SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`), editable `from_name`, `reply_to`,
  `bcc_archive` (e.g. `accounts@balkania.ie`), `send_enabled`. The `note:` must
  carry the two gotchas: **port 25 is blocked outbound on Vercel — use 587 or
  465**, and **SPF/DKIM/DMARC for `balkania.ie` must authorise the relay** or
  every PoD lands in spam invisibly.
- `testConnections()` gains `transporter.verify()` — a perfect fit for the
  existing rule that *a test button which sends a real message is not a test*.
- `pool: false` (a pool in a serverless function is a leak), explicit timeouts.
- **The delivery is never blocked on the email.** Receipt commits → `invoice_emails`
  row `queued` → PDF → send. If SMTP is down the driver still completed the drop.
  No `customer_email` → `status = 'skipped'` with a reason, surfaced — not a
  silent no-op. Best-effort but reported, same posture as Short.io.
- A "Resend" button on the dispatcher's invoice view. No bounce handling —
  document the gap the way the Sent receipts gap is documented.

---

## 8. GDPR / retention

A handwritten signature is **ordinary personal data, not Article 9 biometric
data** — it becomes biometric only if processed through specific technical means
to uniquely identify someone (Art. 4(14)). Getting this right matters: the Art. 9
framing would demand explicit consent, which is the wrong basis. Lawful basis is
**Art. 6(1)(b)** (delivery contract) and **6(1)(f)** (proof in a dispute).

| Data | Retention |
|---|---|
| `invoices`, `invoice_lines`, `invoice_vat_totals` | **6 years** — VAT Consolidation Act 2010 s.84 |
| `delivery_receipts`, signature image, PDF | **6 years** — part of the VAT record; contract claims run 6 years |
| `invoice_emails` | 1–2 years — audit of a send, not a financial record |
| `invoice_webhook_deliveries` | 90 days, failed payloads only — same as 0015 |

Three conflicts to write down now:

1. **The 90-day sweep must not touch invoices.** No purge job exists yet, so this
   is a documentation-first obligation — the `COMMENT ON TABLE` must say
   "excluded from the retention sweep" *before* anyone writes the sweep.
2. **Art. 17 erasure cannot remove a signed invoice** — Art. 17(3)(b) and (e)
   apply. That's the right answer, but it needs to be the written answer before a
   customer asks.
3. **Two new processors** — Supabase Storage (confirm EU region; `vercel.json`
   pins compute to `dub1` but that covers compute only) and the mail provider.

Add a **Proof of delivery** connector card with `pod_retention_years` (min 6)
rather than reusing Sent's `retention_days`. Two retention classes, visibly
separate. And note that `delivery_receipts.driver_id + captured_at` is a delivery
record, **not** a duty record — the same caveat Analytics already carries.

---

## 9. Phasing

**Stage 1 — Invoices exist, dispatchers see them.** Migration 0020,
`lib/invoices/payload.ts` (pure, mirroring `lib/crm/payload.ts` field for field
including warnings-don't-block), `POST /api/webhooks/invoices` with its own
`INVOICE_WEBHOOK_SECRET` (separate from the CRM one so it rotates
independently), an Invoice feed card on Integration Settings, and an invoice
panel on the Active Loads stop row. *Useful alone: dispatch sees what's actually
on the truck. **Zero lockout risk.***

**Stage 2 — Driver identity and isolation.** Migration 0021, role registry
changes, `isRole` fix, fail-closed `canAccessPath`, `requireStaff` in the
dashboard layout, the "Create login" action (service client +
`auth.admin.inviteUserByEmail`, then set `profiles.role` and `drivers.user_id`
**in that order, before the invite can be accepted**), and a read-only
`/bills`. *Useful alone: a driver sees their run on a phone. Better than a paper
docket.* **Rehearse on a branch database** — `is_staff()` returning false for
everyone is a total dispatch outage that will look like a database failure.

**Stage 3 — Signing at the door (online only).** Migration 0022, the `pod`
bucket, `POST /api/bills/receipts`, the signature pad, the outcome picker, and
wiring `delivered` into `settleStopDelivered()`. Include `client_event_id` from
day one so Stage 5 needs no API change.

**Stage 3.5 — Installable.** Manifest, icons, viewport, proxy matcher fix,
near-no-op SW. Cheap, ship alongside Stage 3, de-risks Stage 5.

**Stage 4 — PDF and email.** `pdf-lib` + fontkit + font, the PDF route, the SMTP
connector, `invoice_emails`, resend action.

**Stage 5 — Offline queue.** IndexedDB, real SW fetch handler, pending chip.
Test on a real iPhone in a real dead zone.

---

## 10. Hazards, ranked by damage if missed

1. **The `handle_new_user()` → dispatcher window.** Every invited driver is a
   dispatcher until something changes it. The `is_staff()` "not a driver row"
   clause is the mitigation; get the provisioning order right and comment why.
2. **`is_staff()` fails closed where `getCurrentUser()` fails open.** Missing
   profile = empty board after Stage 2. Run the backfill first.
3. **`syncLoadCompletion()` cannot complete a load with a refused stop.**
   Verified at `stop-delivery.ts:142` — `rows.every(s => s.delivered_at !== null)`.
   A refused stop never gets `delivered_at`, so the load stays `active` forever,
   clogs the board, and `startLoad`'s clash check then blocks that driver's next
   load. Fixing it means a settled-but-not-delivered state and changing
   `allDelivered` — **the most load-bearing cascade in the app**, with
   `undeliverStop`, `deleteLoad` and `updateLoad` all reading off it. Its own
   change, its own review, undo path in the same commit.
4. **Partial delivery must not reprice anything** — recording accepted quantities
   and restating a total creates a conflicting VAT document. Report; let the ERP
   credit.
5. **`canAccessPath` fail-open is load-bearing for `/account`** — flipping it
   without `UNGATED_PATHS` locks everyone out of their password page.
6. **Invoice↔order matching order.** `order_id IS NULL` makes an invoice invisible
   to every driver by RLS — correct, but it presents as "the phone shows
   nothing". Surface unmatched invoices loudly.
7. **`customer_email` doesn't exist today.** The whole email half depends on the
   CRM supplying it. Confirm with the connector owner in **week one**.
8. **pdf-lib throws on non-WinAnsi characters.** Decide font embedding up front.
9. **iOS PWA ≠ Android PWA** — no `beforeinstallprompt`, no Background Sync,
   Add-to-Home-Screen only, possibly a separate cookie jar (drivers may have to
   sign in again inside the installed app). Write a one-page install guide.
10. **PWA icons are a design dependency, not a code task.** Nothing installs
    without them; the maskable one needs a 40% safe circle. Start early.

---

## Verification

**Stage 1.** POST a fixture invoice to `/api/webhooks/invoices` with the Bearer
secret; confirm the row, lines and VAT totals land, that a re-push updates in
place rather than duplicating, that a bad payload logs to
`invoice_webhook_deliveries` with the raw body, and that an invoice with an
unknown `crm_order_id` queues visibly with `order_id IS NULL`. Confirm
`totals_mismatch` trips on a deliberately inconsistent fixture.

**Stage 2 — rehearse on a Supabase branch database, never production first.**
Run `bootstrap_profiles.sql`, apply 0021, then:
- Sign in as a **dispatcher** and confirm Active Loads, Fleet, Orders Queue and
  Analytics all still render rows. This is the outage check.
- Sign in as a **driver** and confirm: `/bills` lists only their loads; `/active-loads`
  redirects to `/bills`; a direct PostgREST query from the browser for `trucks`
  and for another driver's `loads` returns **zero rows**.
- Confirm an admin still sees everything.
- Check `EXPLAIN` on the board's load query for an InitPlan rather than a
  per-row helper call.

**Stage 3.** On a real phone: sign, confirm the receipt row, the object in the
`pod` bucket, the `sha256` match, and that `delivered` cascades through
`settleStopDelivered()` to `orders.status` and the load. Then run the **refused**
path and confirm the load-completion behaviour is what you decided in Hazard 3.

**Stage 3.5.** Chrome DevTools → Application → Manifest and Service Workers.
Confirm `manifest.webmanifest` and `sw.js` return 200 (not a 302 to `/sign-in`)
while signed out, that the install prompt appears on Android, and Add to Home
Screen works on iOS. Confirm the SW is a **no-op** on `/active-loads`.

**Stage 4.** Generate against a fixture with a `č` in the customer name — that's
the WinAnsi trap. Check money alignment, the VAT block, and long wrapped
descriptions. Use `verifyConnection()` for SMTP, then one real send to an
internal address, checking SPF/DKIM/DMARC pass in the received headers.

**Stage 5.** Real iPhone, airplane mode mid-route: sign three drops offline,
confirm the pending chip, restore signal, confirm all three upload exactly once.
Then repeat with the session expired while offline.

---

## Critical files

| Path | Why |
|---|---|
| `supabase/migrations/0004_auth_roles.sql` | The policies and helpers 0021 replaces; the idiom every migration copies |
| `supabase/migrations/0017_advisor_fixes.sql` | Documents the always-true stance this feature deliberately reverses |
| `web/src/lib/auth/roles.ts` | Role union, registry, hardcoded `isRole` (:135), fail-open `canAccessPath` (:131) |
| `web/src/lib/auth/guard.ts`, `session.ts` | Where `requireStaff`/`requireDriverProfile` go |
| `web/src/app/api/webhooks/crm/route.ts` + `web/src/lib/crm/payload.ts` | The exact ingestion contract the invoice webhook mirrors |
| `web/src/lib/data/stop-delivery.ts` | `settleStopDelivered`/`syncLoadCompletion` — signing ties in here; refusal breaks here (:142) |
| `web/src/proxy.ts` | The matcher that currently 302s `manifest.webmanifest` and `sw.js` |
| `web/src/lib/integrations/catalogue.ts` | Where the SMTP and Proof-of-delivery connectors are declared |
| `web/src/lib/supabase/service.ts` | The service-role client the receipt handler uses |
| `web/src/app/(dashboard)/layout.tsx` | The one place `requireStaff()` needs to go |
