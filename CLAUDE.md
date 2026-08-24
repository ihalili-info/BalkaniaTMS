# Balkania TMS

Smart logistics dispatch platform: syncs orders from a CRM, tracks trucks via
GPS/telematics, geofences delivery stops, and sends automated SMS/WhatsApp
customer alerts via Sent (sent.dm).

**The operation is Ireland-based** — Dublin (Ballymount) depot — running
domestic work plus cross-border into Northern Ireland, Great Britain and
mainland Europe, and expanding further into the EU and UK. Nothing hard-codes
Ireland: country is a column and a row in `web/src/lib/regions.ts`.

The product name is **Balkania TMS** (previously "LogiTrack" — that name is
retired; don't reintroduce it).

Read [Project BalkaniaTMS.md](Project%20BalkaniaTMS.md) first — it's the full
architecture doc: tech stack, workflow diagram, module responsibilities, and
the canonical DB schema. Treat it as the source of truth for schema changes;
keep it and `supabase/migrations/` in sync.

## Structure

- `Project BalkaniaTMS.md` — architecture doc (source of truth for schema/design decisions)
- `supabase/bootstrap_profiles.sql` — idempotent profile backfill + first-admin bootstrap
- `supabase/diagnose_admin.sql` — prints a plain-English diagnosis per auth user
- `supabase/migrations/`
  - `0001_init.sql` — DB schema (PostGIS: trucks, orders, loads, load_items, notifications)
  - `0002_truck_details.sql` — dispatcher-owned truck columns (capacity, `features TEXT[]`,
    `availability`), and renames `trucks.updated_at` → `location_updated_at`
  - `0003_eu_compliance.sql` — `drivers` table with tachograph cards and Reg. 561/2006
    duty counters; `loads.driver_id`/`cmr_number`; order `delivery_country`,
    `delivery_postcode` and `notifications_opt_out`; truck gross weight, height,
    length, Euro class and ADR classes
  - `0004_auth_roles.sql` — `profiles` (role), `integration_settings`, and **RLS on
    every table**. This is where access control actually lives.
  - `0005_driver_messaging.sql` — `driver_messages`: dispatcher → driver SMS/WhatsApp
    (navigation links). Drivers only, never customers.
  - `0006_fleetmatics_gps.sql` — `trucks.gps_sequence_id` and `last_known_address`
    for the Verizon Connect Reveal push feed
  - `0011_driver_vehicle.sql` — `drivers.assigned_truck_id` / `assigned_at`: the
    truck a driver normally runs. Deliberately **not** unique — double-shifting
    one tractor is normal — and stamped by a trigger so an unrelated edit does
    not make the pairing look freshly set
  - `0007_sent_channels.sql` — widens `driver_messages.channel` to include RCS
  - `0008_production_reads.sql` — `orders.promised_at`, the `*_geo` views that
    expose lat/lng, and the analytics RPCs
- `web/` — Next.js 16 (App Router, TypeScript, Tailwind v4) admin panel. See
  [web/README.md](web/README.md) for its layout and conventions.
  - `src/app/globals.css` — the entire design system as Tailwind v4 `@theme` tokens
  - `src/components/app-shell.tsx` — dark navigation rail + light topbar, wraps all dashboard routes
  - `src/components/ui/index.tsx` — Card, Button, Badge, StatTile, Table, Progress, EmptyState
  - `src/components/charts.tsx` — dependency-free SVG charts
  - `src/app/(dashboard)/` — the 6 nav sections: `active-loads`, `orders-queue`, `live-fleet-map`, `fleet` (Trucks / Drivers tabs), `analytics`, `integration-settings`
  - `src/lib/auth/roles.ts` — roles + the module registry. **Add a module or change
    who can see one here, nowhere else.**
  - `src/lib/auth/session.ts` — `getCurrentUser()`; the single seam for Supabase Auth
  - `src/lib/auth/guard.ts` — `requireAccess()` for server-side page checks
  - `src/proxy.ts` — route guard (Next 16 renamed `middleware` → `proxy`)
  - `src/lib/telematics/fleetmatics.ts` — Verizon Connect Reveal client + GPS push normaliser
  - `src/app/api/webhooks/gps/route.ts` — the Reveal GPS webhook (Basic auth, replay-guarded)
  - `src/lib/navigation-links.ts` — Waze / Google Maps / Apple Maps deep links + HGV caveats
  - `src/lib/driver-messaging.ts` — driver SMS composition and GSM-7 segment counting
  - `src/lib/csv.ts` — RFC 4180 CSV reader/writer (quotes, BOM, CRLF, delimiter detection)
  - `src/lib/orders-import.ts` — CSV column schema, auto-mapping and row validation
  - `src/lib/regions.ts` — country registry: dial prefixes, postcode shapes, weight/height
    limits, customs regime derivation. **Add a country here, not in a component.**
  - `src/lib/driver-hours.ts` — Reg. (EC) 561/2006 driving time and rest, as pure functions
  - `src/lib/fleet-status.ts` — duty/signal derivation (pure, survives the move to Supabase)
  - `src/lib/truck-features.ts` — equipment tag catalogue (labels + icons)
  - `src/lib/data/` — the real read layer (`fleet.ts`, `analytics.ts`) and `mutations.ts`
  - `src/lib/fleet-selectors.ts` — pure selectors, safe for client components
  - `src/lib/geo/reference.ts` — depot + map landmarks (reference data, not fixtures)
  - `src/lib/integrations/` — connector catalogue, config store, messaging policy
  - `src/lib/types.ts` — row types mirroring the migration
  - `src/lib/supabase/` — `client.ts` (browser), `server.ts` (RSC/route handlers, cookie-based), `service.ts` (service-role, server-only, bypasses RLS — for webhooks/cron)
  - `.env.example` — required env vars (Supabase, Sent, geocoding, GPS provider); copy to `.env.local` and fill in

## Design system

Light working canvas, dark navigation rail. Everything is a token in
`globals.css` under `@theme` — surfaces, ink, rail, brand, status triplets,
type scale, radii, shadows, and the chart palette. Components consume them as
utilities (`bg-surface`, `text-heading`, `border-hairline`); a raw hex or an
arbitrary `text-[13px]` in a component is a bug.

The chart palette (`--color-viz-1..3`) passed the dataviz validator against the
light surface (lightness band, chroma floor, CVD separation, contrast). Re-run
that validator before changing any of those three values.

## Status

**Live at tms.balkania.ie.** Supabase Auth is wired, every page reads real
data, and there are no fixtures anywhere — `lib/demo/` is deleted and the demo
role switcher is gone. An unconfigured deployment now **throws** rather than
falling back to a demo user; a silent fallback is how an app ends up
authenticating nobody.

**Reads:** `lib/data/fleet.ts` and `lib/data/analytics.ts`. Coordinates come
from the `trucks_geo` / `orders_geo` views, because PostgREST serialises
GEOGRAPHY as WKB hex. Those views are `security_invoker = true` — without it a
view runs with its owner's rights and silently bypasses RLS.

**Writes:** `lib/data/mutations.ts`. Truck edits, CSV import and address fixes
persist. Each action re-checks the session (a server action is a public HTTP
endpoint) and truck updates go through a **field allow-list**, so a crafted
call cannot touch `current_location` or `location_updated_at` — the ownership
split 0002 exists to protect.

**Not done:** no CRM webhook, no tachograph feed, no customs provider, no
basemap. Creating trucks, drivers and loads from the UI is not built — the
Fleet page edits existing rows but "Add truck" does nothing yet, so the first
rows go in through Supabase.

**Empty by design.** The database has no trucks, drivers or loads. Every screen
has an empty state; nothing is estimated or back-filled.

## Polling is not realtime

**A successful "Sync GPS" proves the pull API works and says nothing about the
push feed.** The two are separate paths with separate credentials, and a fleet
can show fresh-looking coordinates that are only ever as new as the last time
somebody pressed the button. `gps_webhook_deliveries` is the only evidence the
push feed is delivering; `RealtimeStatus` on the Live Fleet Map and the GPS
feed card on Integrations both read it and nothing else.

## GPS provider — Verizon Connect Reveal (Fleetmatics)

The fleet's telematics provider. EU tenant: `fim.eu.fleetmatics.com`, API host
`https://fim.api.eu.fleetmatics.com`.

**Use the push webhook, not polling.** Reveal POSTs each fix to
`/api/webhooks/gps`. Two documented limits make polling a poor second: there is
**no fleet-wide endpoint** (one call per vehicle, per cycle) and Verizon asks
for **no more than one call per vehicle every 3–5 minutes**.

Auth, and the asymmetry is easy to get wrong:

- **Pull:** `GET /token` with HTTP Basic → a **plain-text** token (not JSON),
  valid 20 minutes. Subsequent calls send
  `Authorization: Atmosphere atmosphere_app_id={appId}, Bearer {token}`. The
  token call is the one request that does *not* take the app id.
- **Push:** Basic auth on the inbound request, with a username and password
  **we choose** and hand to Verizon when registering the endpoint. They are not
  issued by Verizon. Registration is not self-serve — it goes through Reveal
  (API integrations → SUBMIT ENDPOINTS → GPS webhook) or their support.

**Fleet sync.** `Sync from Reveal` on the Fleet page pulls `/cmd/v1/vehicles`
and creates/updates truck rows keyed on Vehicle Number. Two rules make it safe
to re-run: it **never deletes** (a vehicle gone from Reveal may still carry load
history, so it is reported not acted on), and it only writes the fields Reveal
owns — capacity, equipment and availability are dispatcher-owned and survive a
sync untouched. It always previews before writing.

The vehicle-list response fields are **not publicly documented**, so
`normaliseVehicle()` accepts several plausible spellings and keeps the raw
record; the preview dialog shows it so the mapping can be confirmed against a
real payload rather than assumed.

`trucks.gps_device_id` holds Reveal's **Vehicle Number** — not the device
serial or ESN. Verizon does not populate that field automatically; it has to be
set per vehicle in Reveal or nothing matches.

Webhook deliveries retry, duplicate and arrive out of order, so every write is
guarded by `SequenceId` (`isNewerFix`). Without it a late delivery overwrites a
newer position and the truck jumps backwards on the live map. Positions that
fail validation — no vehicle number, unparseable `UpdateUTC`, or `0,0` null
island from a device with no fix — are rejected rather than coerced.

The push payload is reverse-geocoded by Verizon, so `last_known_address` comes
free with every fix.

**Reveal does not solve driver hours.** Its API has `PUT Hours of Use` but no
way to *read* tachograph duty, so the Reg. 561/2006 counters on `drivers` still
need a separate tachograph source. Do not wire them to this feed.

## Messaging: who may be sent what

**Customers receive exactly three messages, all automated** — dispatch
confirmation, proximity alert, delivery complete. They are fired by the geofence
engine, one row per type per stop in `notifications`, guarded by
`UNIQUE (load_item_id, type)` and by `orders.notifications_opt_out`.

**There is no dispatcher-initiated customer message, and adding one is a
deliberate decision, not a convenience.** No tracking-link SMS, no public
tracking page — a public tracking URL is a standing exposure of someone's
delivery address, and the three automated alerts already tell the customer what
they need.

**Drivers are a separate channel.** A dispatcher can send a driver their route
as navigation deep links, recorded in `driver_messages` with `sent_by` for
accountability. A driver is staff being given a job, not a marketing recipient,
so the ePrivacy opt-out rules governing `notifications` do not apply — but the
phone number is still personal data and the retention window still applies.

## Navigation handoff

`lib/navigation-links.ts` builds deep links for Waze, Google Maps and Apple
Maps. The three are **not** equivalent and the UI must not imply they are:

- **Google Maps** is the only one with a documented multi-stop URL
  (`waypoints=`, nine intermediate stops max).
- **Waze** and **Apple Maps** take one destination. They get the *next* stop,
  never the last — a driver navigating straight to the final drop would skip
  everything in between. Each link is labelled with how many stops it covers.
- **All three route cars, not HGVs.** None of them knows a 4.62 m trailer
  cannot pass under a 4.0 m bridge, or applies weight and ADR restrictions.
  `truckRoutingWarning()` states this at the point of handoff, checked against
  the load's destination countries.

Keep the default SMS body inside GSM-7. A single em dash or accented character
flips the whole message to UCS-2 and cuts the per-segment budget from 153 to 67
characters — that alone doubled a route message from 3 segments to 6.

## Messaging provider — Sent (sent.dm)

`POST https://api.sent.dm/v3/messages`, authenticated with an `x-api-key`
header. Client in `web/src/lib/messaging/sent.ts`.

Two behaviours here differ from a Twilio-shaped API and both cost money:

- **`channel` is a broadcast list, not a fallback order.** `["sms","whatsapp"]`
  sends *two* messages and bills for both; the customer gets the alert twice.
  **Omitting `channel` is what gives cross-channel fallback** — that is the
  right default for a transactional alert, and it is what `deliverBy: "auto"`
  does. There is deliberately no "all channels" option in the UI.
- **`template` and `text` are mutually exclusive** — exactly one, or the API
  returns 400. Raw `text` is supported, so the message templates in the app
  work without registering anything with the provider.

RCS is a first-class channel alongside SMS and WhatsApp (migration 0007 widened
the `driver_messages.channel` CHECK to match).

**Unverified:** the `x-profile-id` sender-profile header, and the signing scheme
for inbound delivery-status webhooks. Confirm both against the account before
relying on them — `.env.example` says so too.

## Order intake

Until the CRM webhook is built, orders arrive through **CSV import** on the
Orders Queue. It is a stopgap, and the code says so — but it lands orders in
exactly the shape the webhook will produce, so the two paths converge instead of
diverging.

- `lib/csv.ts` is a real RFC 4180 parser, not `split(",")`. Irish addresses are
  full of commas (`"Station Road, Blarney, Co. Cork"`), and Excel adds a BOM,
  CRLF endings and — under several European locales — a semicolon delimiter.
  All four are handled, and the delimiter is auto-detected by column-count
  consistency rather than raw frequency.
- `lib/orders-import.ts` owns the column schema, header aliases for
  auto-mapping, and validation. Postcode and country rules come from
  `regions.ts`, so a GB or DE import is checked against *that* country's format.
- **Errors block a row; warnings do not.** A duplicate reference or unknown
  country is an error. A malformed postcode or a phone without a country code is
  a warning — postal data is messy, and dropping the order is worse than
  importing it with a flag. Bad rows are skipped, never guessed at.
- Imported orders have **no coordinates** unless the file supplies lat/lng, so
  they queue for geocoding — the same rule the CRM path must follow: flag,
  never drop.

When the webhook lands, keep the import: a manual path for one-off spreadsheets
is worth having regardless.

## Access control

Two roles: **admin** (every module) and **dispatcher** (every module except
Integrations). Both are values in `profiles.role`; adding a third is a value in
the CHECK plus a `roles: []` entry in the module registry. Nothing else should
branch on a role name.

Enforced in four layers, and **the first one is not security**:

1. **Sidebar filtering** — convenience. It stops people being shown doors they
   cannot open. It is not a control and must never be the only thing.
2. **`src/proxy.ts`** — redirects to `/forbidden` before the page renders. Not
   sufficient alone: the Next docs note a proxy may be CDN-deployed, and a
   careless `matcher` edit silently disables it.
3. **`requireAccess()` in the page** — a server-side re-check. It only ever
   fires when layer 2 failed, which is the point.
4. **RLS policies (migration 0004)** — the real enforcement. A dispatcher
   calling PostgREST straight from the browser gets zero rows from
   `integration_settings`, whatever the UI did.

**Fail closed.** An absent or unrecognised role resolves to `dispatcher`, never
`admin` — matching `DEFAULT 'dispatcher'` on the column and the signup trigger.
A fallback to admin is the kind of line that quietly survives into production.

**Two modes, chosen by config.** With `NEXT_PUBLIC_SUPABASE_URL` set,
`getCurrentUser()` reads a real Supabase session and takes the role from
`profiles` — never from user metadata, which the client can write. Without it,
the app falls back to the demo cookie so the fixture deployment keeps working.
`setDemoRole` refuses outright once Supabase is configured, so the switcher
cannot become an escalation path.

**Bootstrapping the first admin is a migration, not a screen.** Nobody can
promote themselves (`profiles_update_self` pins `role`), so 0004 backfills
profiles for pre-existing `auth.users` and sets `admin@balkania.ie` to `admin`.
The backfill matters: the signup trigger only fires on INSERT, so users created
in the Supabase dashboard *before* the migration would otherwise have no
profile — and no profile means no role means locked out.

Nobody may edit their own `role`: the `profiles_update_self` policy pins it to
the existing value, otherwise every restriction would be voluntary.

The sidebar's role switcher is **demo-only** and disappears with Supabase Auth —
a real user cannot pick their own role. It writes the same cookie every guard
reads, so switching exercises the real path rather than a bypass.

## Analytics honesty

On-time rate is measured only against `orders.promised_at`. Orders without a
promised time are **excluded from the denominator**, never counted as on time,
and when nothing in the window carries one the figure renders as `—` with an
explanation rather than a fabricated percentage. `promised_at` arrived in 0008
precisely because the metric had no basis before it.

"Corridors" are gone. The schema records a destination country, not a named
corridor, so the table shows countries — the honest unit.

## Regulatory model

Four regimes are modelled, and each one changes what the UI shows:

**Driving time — Reg. (EC) 561/2006.** 4h30 driving before a 45 min break, 9h a
day (10h at most twice a week), 56h a week. `lib/driver-hours.ts` is the single
implementation; Active Loads shows time-to-break per load and flags a next stop
the driver cannot legally reach. Retained in UK and NI law with the same
numbers, so one implementation covers every country the fleet runs in. **These
counters are a planning aid — the tachograph is the legal record.** Never
present them as evidence of compliance.

**Tachograph — Reg. (EU) 165/2014.** Drivers carry a card number; duty counters
are a snapshot written by the tachograph sync, kept deliberately separate from
the GPS feed. Position is not duty, and only the tachograph is evidence.

**Customs.** `XI` (Northern Ireland) is a distinct territory from `GB`, not a
synonym — that is the real EORI/VAT prefix, and the Windsor Framework green/red
lanes only exist for NI. `customsRegime()` derives the position from the country
pair; the load card lists the paperwork it implies.

**GDPR / ePrivacy.** Delivery alerts are transactional (Art. 6(1)(b)), so no
prior opt-in — but a STOP reply sets `orders.notifications_opt_out` and must be
honoured permanently. Opted-out customers are excluded **at the query**
(`idx_orders_alertable`), never filtered in the UI. `notifications` rows are
personal data with a retention window.

**Weights & dimensions — Directive 96/53/EC.** `capacity_kg` is payload;
`gross_weight_kg` is the regulated figure. Ireland and the UK allow 4.65 m,
most of the mainland 4.00 m — so a legal Irish trailer can be illegal in France.
`vehicleBreaches()` catches that, and the Fleet cards surface it.

## Loads: editing and deleting

`updateLoad` / `deleteLoad` in `lib/data/mutations.ts`, surfaced by the `⋯`
menu on each load card.

- A **delivered** stop can never be removed or reordered out of existence — it
  records something that happened.
- **Delete is refused** when any stop is delivered *or* any `notifications` row
  exists for its stops. `load_items` cascades from `loads` and `notifications`
  cascades from `load_items`, so deleting would destroy the evidence that a
  delivery occurred and that a customer was told about it.
- Removed and deleted orders revert to `pending` and reappear in the Orders
  Queue. The work is never lost, only the plan.

## Truck data ownership

`trucks` has two writers, and the split is load-bearing:

- The **telematics feed** owns `current_location` / `location_updated_at`.
- **Dispatchers** own label, capacity, `features`, `availability` and
  `gps_device_id`, stamped with `details_updated_at`. `gps_device_id` looks
  telematics-owned but isn't: Verizon never sets Reveal's Vehicle Number on
  its own, so a dispatcher has to type it in here to match what's entered for
  that vehicle in Reveal — the Fleet editor's "GPS matching" field, not the
  read-only feed block.

Never let a dispatcher edit bump the location timestamp — a stale fix would
start looking fresh on the live map. That is why 0002 renamed the column.

`availability` is intent ("may this truck be given work"), not busy-ness. Busy
comes from `loads`. The UI shows duty and GPS signal as two separate badges;
don't collapse them, because a truck can be booked solid *and* have a dead
tracker — `trk-06` in the fixtures is deliberately both.

## Known gaps

- **ETA-based geofence triggering** (vs. straight-line distance) needs a
  routing/ETA API — not yet chosen. `estimateMinutes()` in `lib/format.ts` is a
  crude 45 km/h stand-in for display only; it must never gate an alert.
- GPS polling is capped by the **provider**, not by Vercel. Verizon asks for no
  more than one call per vehicle every 3–5 minutes, and there is no fleet-wide
  endpoint — so polling costs one HTTP call per truck per cycle. Vercel Cron's
  one-minute floor is no longer the binding constraint; use the push webhook.

## Deployment (Vercel)

The Vercel project's **Root Directory is `web`**, so `web/vercel.json` — not a
file at the repo root — is the config Vercel reads.

**Functions are pinned to `dub1` (Dublin).** Vercel defaults new projects to
`iad1` in Virginia; leaving it there would route every customer name, phone
number and delivery address through US compute and add a transatlantic hop to
every Supabase query. Pin the Supabase project to an EU region as well — the
region setting only covers compute. `proxy.ts` is Routing Middleware and runs
in all regions regardless, which is fine: it reads a cookie and redirects,
touching no personal data.

No cron entry yet — `/api/cron/gps` does not exist, and the push webhook is the
preferred path anyway.

## Conventions

- Git repo root is this directory, remote `origin` is
  `github.com/ihalili-info/BalkaniaTMS`, default branch `main`.
- Google Stitch is no longer part of the workflow. The old Stitch exports were
  deleted and their tokens superseded by the design system above — don't
  re-export from Stitch or recreate those folders; extend `globals.css` and
  `components/ui/` instead.
