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
  - `src/lib/types.ts` — row types mirroring the migration
  - `src/lib/demo/` — fixtures every page currently renders from
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

**Done:** Next.js scaffold; the Balkania TMS design system; AppShell; shared UI
primitives and SVG charts; all six pages built out against demo fixtures and
verified in-browser; Supabase client helpers; DB migrations written.

**Not done:** everything is fixtures. No page reads Supabase, no API routes
exist, and nothing authenticates (the role model is built; the sign-in is not).
Orders arrive by **CSV import** — a deliberate stopgap until
`/api/webhooks/crm` exists. Truck edits on the Fleet page live in React state
and vanish on refresh — `updateTruck` in `fleet/fleet-manager.tsx` is the single
seam to swap for a real mutation. Driver duty counters have no editor at all:
they are written by the tachograph sync, which is not built.

**Backend:** no real Supabase project connected yet — `.env.local` is unset.
Migration hasn't been applied anywhere.

**Live Fleet Map:** now a coded screen, but the map itself is a schematic
equirectangular projection (km units, so the 5 km geofence rings are true to
scale) — there is no basemap. Choosing and keying a tile provider (Mapbox or
Google Maps) replaces the `<svg>`; the geofence/route-leg/marker overlays are
written to carry over.

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

Nobody may edit their own `role`: the `profiles_update_self` policy pins it to
the existing value, otherwise every restriction would be voluntary.

The sidebar's role switcher is **demo-only** and disappears with Supabase Auth —
a real user cannot pick their own role. It writes the same cookie every guard
reads, so switching exercises the real path rather than a bypass.

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
- **No login screen.** Roles, guards and RLS policies exist, but nothing
  authenticates: `getCurrentUser()` reads a demo cookie. Supabase Auth plugs
  into that one function — see the worked example in its doc comment.
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
