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
  - `0013_truck_gps_esn.sql` — `trucks.gps_esn`: the device ESN, a fallback join
    key for the GPS webhook when a fix carries no Vehicle Number. Also widens
    `trucks_geo`.
  - `0011_driver_vehicle.sql` — `drivers.assigned_truck_id` / `assigned_at`: the
    truck a driver normally runs. Deliberately **not** unique — double-shifting
    one tractor is normal — and stamped by a trigger so an unrelated edit does
    not make the pairing look freshly set
  - `0007_sent_channels.sql` — widens `driver_messages.channel` to include RCS
  - `0008_production_reads.sql` — `orders.promised_at`, the `*_geo` views that
    expose lat/lng, and the analytics RPCs
  - `0012_geocode_cache.sql` — `geocode_cache`: resolved delivery locations
    reused across imports, keyed on Eircode (IE) or postcode + address line.
    `manual` fixes outrank and are never overwritten by an automatic geocode
    (`upsert_geocode_cache` enforces it). `geocode_cache_geo` exposes lat/lng.
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
  - `src/lib/routing/google.ts` — Google Routes API client (road distance/time,
    live-traffic single leg); falls back to great-circle on any failure
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
  **we choose** and enter in Reveal's "Submit GPS webhook endpoints" form
  (`reveal.eu.vzconnect.com` → admin → integration → partner integrations →
  webhook), alongside the URL. Not issued by Verizon. The creds must avoid
  `/ \ ' " : @`; the hostname must have no underscore.

**The push feed is AWS SNS.** Two message types on the `x-amz-sns-message-type`
header, though the code detects them by content:

- **`SubscriptionConfirmation`** arrives **first, with no credentials**. The
  endpoint must answer `401` + `WWW-Authenticate: Basic` — that is the protocol,
  not a rejection — and SNS retries *with* credentials. Then the `SubscribeURL`
  in the body is fetched (`confirmSubscription`, SSRF-allow-listed to AWS /
  Verizon hosts) to activate the feed. The token **expires after 3 days**; if
  the handshake never completes, resubmit the endpoint in Reveal for a fresh one.
- **`Notification`** is a **CloudEvent**: the position is under `data`, in
  camelCase (`data.sequenceId`, `data.vehicle.number`, `data.latitude`, …).
  Verizon's C# reference models are PascalCase only because .NET deserialises
  case-insensitively. `normaliseGpsPush()` reads every key case-insensitively
  and unwraps `data`, so both shapes parse. `Content-Type` is always
  `text/plain` — read the raw body, then `JSON.parse`.

**15-second ack deadline, only `200` counts, 2 retries then discarded.** Writes
are small enough to stay in the request path for now; heavy work would need a
queue.

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

**Matching a fix to a truck: Vehicle Number, then ESN.** `trucks.gps_device_id`
holds Reveal's **Vehicle Number**; Verizon does not populate it automatically,
so a fix can arrive with only `vehicle.esn` (which the guide calls the
"mandatory" key). Migration 0013 adds `trucks.gps_esn` as a fallback the webhook
matches on — `Sync from Reveal` fills it on create when the list response
carries it. A fix that matches neither is reported, not an error.

Webhook deliveries retry, duplicate and arrive out of order, so every write is
guarded by `SequenceId` (`isNewerFix`). Without it a late delivery overwrites a
newer position and the truck jumps backwards on the live map. Positions that
fail validation — no identifier, unparseable `updateUTC`, or `0,0` null island
from a device with no fix — are rejected rather than coerced. A trip flagged
`isPrivate` (Verizon strips the coordinates) is **skipped, not rejected** — it
is a deliberate state.

**Transposition guard.** The reverse-geocoded `address.country` (ISO alpha-3)
is used as an anchor: if the fix's coordinates are not in that country but the
mirror image is, the feed sent lat/lng the wrong way round and they are
swapped. Without this a transposed fix plots the truck in the Southern Ocean.

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

`POST https://api.sent.dm/v3/messages`, authenticated with an **`x-api-key`**
header holding a UUID. Their authentication reference is explicit that this is
header-key auth, *not* `Authorization: Bearer`. Client in
`web/src/lib/messaging/sent.ts` — a plain `fetch` client, so no runtime
dependency; the official SDK is `@sentdm/sentdm` if that ever changes.

Behaviours that differ from a Twilio-shaped API, and two of them cost money:

- **`channel` is a broadcast list, not a fallback order.** `["sms","whatsapp"]`
  sends *two* messages and bills for both; the customer gets the alert twice.
  The value meaning "pick one, with fallback" is the sentinel **`["sent"]`** —
  also the server-side default when `channel` is omitted. `deliverBy: "auto"`
  sends it explicitly rather than depending on a default that could change.
  There is deliberately no "all channels" option in the UI.
- **`template` and `text` are mutually exclusive** — exactly one, or 400. Raw
  `text` is supported, so the app's templates need nothing registered with the
  provider.
- **The response is enveloped.** Message ids live at
  `data.recipients[].message_id` — one per recipient, not one per call — with
  `meta.request_id` for support queries. Reading a top-level `message_id`
  silently yields null.
- **`sandbox: true`** validates auth, body and template without sending or
  billing. Use it for the first end-to-end run.
- **`Idempotency-Key`** is how a retried send avoids double-billing and
  double-alerting; derive it from `(load_item_id, type)`.
- **`GET /v3/me`** is the free connection test — `verifyConnection()`. A test
  button that sends a real message is not a test.

RCS is a first-class channel alongside SMS and WhatsApp (migration 0007 widened
the `driver_messages.channel` CHECK to match).

**Inbound webhook signatures are verified**, and the scheme is no longer a
guess: strip `whsec_` from the secret, base64-decode the rest as the HMAC key,
and compare `HMAC-SHA256("{X-Webhook-ID}.{X-Webhook-Timestamp}.{rawBody}")`
against the `v1,{base64}` signature header, rejecting anything more than five
minutes old. `rawBody` must be the **exact bytes received** — a parse/stringify
round trip reorders keys and can never match.

**Still unverified:** the `x-profile-id` sender-profile header. The
authentication reference says the key alone identifies the caller, so it is
probably unnecessary; it is sent only when `SENT_PROFILE_ID` is set.

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
- The address comes in as **two columns** — `address_line_1` (required) and
  `address_line_2` (optional) — because that is how the CRM holds it. They are
  joined with `", "` into the single `orders.delivery_address` on import; a
  blank line 2 is dropped. A one-column file still works: `delivery address` /
  `address` are aliases of line 1.
- **Errors block a row; warnings do not.** A duplicate reference or unknown
  country is an error. A malformed postcode or a phone without a country code is
  a warning — postal data is messy, and dropping the order is worse than
  importing it with a flag. Bad rows are skipped, never guessed at.
- Imported orders have **no coordinates** unless the file supplies lat/lng or
  the address is a hit in the geocode cache (see that section); otherwise they
  queue for geocoding — the same rule the CRM path must follow: flag, never
  drop.

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

## Auto-planning loads

**Auto-plan** in the Orders Queue selection bar: geocode → group by geography →
review → create. `lib/load-planner.ts` is the whole algorithm and it is pure —
no I/O, no clock — so it can be reasoned about and run standalone.

- **Roads when routing is configured, straight lines otherwise.** With
  `ROUTING_API_KEY` set, sequencing, `routeMeters` and `routeSeconds` run on
  the Google Routes matrix (ferries included); clustering stays great-circle
  because a cluster centroid is not a real place to route from. Without a key,
  every distance is great-circle — no roads, no drive times, no ferries, two
  drops either side of an estuary look adjacent and are an hour apart. Either
  way it is a **proposal a dispatcher reviews** (road routing is still a *car*,
  not a 4.6 m trailer), and the dialog says so where it would be easiest to
  forget.
- **Customs splits before geography.** A cluster straddling a customs boundary
  cannot be cut in half afterwards without leaving both halves badly shaped, so
  regimes are separated first. Mixing a GB export with a domestic drop puts two
  paperwork regimes on one truck.
- **Seeded from the furthest drop.** Seeding from the nearest fills the first
  truck with easy local work and strands the remote ones.
- **Nearest-neighbour sequencing**, chosen for being *explicable* rather than
  optimal — a dispatcher can see why each stop follows the last and drag it
  around if they disagree.
- **No capacity check is possible.** `orders` carries no weight or volume, so
  there is nothing to compare `trucks.capacity_kg` against; trucks are assigned
  longest-run-first and the dispatcher confirms. Adding order weight would make
  this real.

## Geocoding

`lib/geocoding/google.ts`, server-only, `GEOCODING_API_KEY`. Separate key from
the basemap — this one must stay private and must have **no HTTP referrer
restriction** (a server-side call sends no referrer).

**Precision is the whole game.** Google answers "Ballymount, Dublin" with the
centre of Ballymount and calls it success. Stored, that coordinate clusters
convincingly and sits inside a 5 km geofence, so the proximity alert fires
while the driver is streets away from a customer who was just told they were
close. A wrong coordinate is worse than none, because none is visible. So
`APPROXIMATE` results are **refused** and sent to the manual Fix address path;
`ROOFTOP`, `RANGE_INTERPOLATED` and `GEOMETRIC_CENTER` are accepted. The
country is checked twice — component filter plus bounding box — and Google's
normalised address is shown back, because a match on the wrong Station Road is
only catchable by reading it.

**Eircode first, for Ireland.** An Eircode is a single building, not a district
like a UK outward code. When an Irish order carries a well-formed one,
`geocodeAddress()` queries the **Eircode alone** before it tries the address
string — that is what turns a rural townland address with no usable street into
a rooftop match. It falls through to the address query if the Eircode misses,
and `GeocodeOutcome.matchedBy` records which produced the point.

## Deleting orders

`deleteOrders` in `lib/data/mutations.ts`, behind the red **Delete** in the
Orders Queue selection bar.

`load_items.order_id` is `ON DELETE CASCADE` and `notifications.load_item_id`
cascades from that, so a plain `DELETE FROM orders` silently takes the stop and
every alert ever sent for it. Only an order that is **pending and on no load**
is deletable; anything else comes back in `blocked` with a reason. The confirm
dialog evaluates the same rule client-side first, so a partial delete is an
outcome the dispatcher has read, not a surprise.

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

## Routing & ETA — Google Routes API

`lib/routing/google.ts`, server-only, `ROUTING_API_KEY` (falls back to
`GEOCODING_API_KEY` — same Google Cloud project). Two calls: `routeMatrix()`
(traffic-unaware, 625-element tiles) feeds the auto-planner; `routeLeg()`
(traffic-aware) is the live truck → next-stop ETA. **Both degrade to
`haversineMeters` on any failure** — no key, spent quota or a network blip
must never break auto-plan or the load board, it just drops to straight-line
maths with the UI saying so.

- **`travelMode: "DRIVE"` is a car.** Google Routes has no HGV profile, so it
  ignores the 4.0 m bridge, the weight limit and ADR. `truckRoutingWarning()`
  still applies at every navigation handoff. A routed number beats a straight
  line and is not a truck-legal route.
- **The planner stays pure.** `planLoads()` takes an optional
  `geometry.leg(from, to)` accessor; `roadMatrixForOrders()` (a server action)
  resolves the matrix once and the dialog hands it in as a plain lookup, so the
  radius / max-stops knobs stay instant and never bill Google. Clustering stays
  great-circle — a cluster centroid is not a real place to route from — only
  sequencing, `routeMeters` and `routeSeconds` use roads.
- **Live ETA is deliberately narrow.** `getLoads({ routedEtas: true })` — only
  Active Loads and the Live Fleet Map pass it, because the dashboard layout
  also calls `getLoads()` on every navigation — routes **only the next
  undelivered stop of each *active* load**, traffic-aware. Every other stop
  keeps `estimateMinutes()`, and `Stop.eta_source` (`"routed"` /
  `"straight_line"`) says which; the UI labels it.
- **The geofence signal.** `isApproaching()` in `lib/fleet-selectors.ts` prefers
  a routed ETA (≤ `APPROACH_ETA_MINUTES`) and falls back to the 5 km
  straight-line ring. The Live Fleet Map still **draws** the 5 km ring from
  straight-line `distance_m` — a road distance is not a circle. This is a
  dashboard cue, **not** an alert trigger: the geofence engine that fires
  customer messages is still unbuilt, and wiring ETA to it is a separate task.

## Order geocoding — Eircode first

`geocodeAddress()` in `lib/geocoding/google.ts`. For an Irish order carrying a
well-formed Eircode it queries the **Eircode alone** before the address string
— an Eircode is a single building, not a district, so it turns a hopeless rural
address into a rooftop match. Falls through to the address-string query if the
Eircode misses. `GeocodeOutcome.matchedBy` records which won.

Postcodes are stored in **canonical form** — `normalisePostcode()` in
`regions.ts` collapses `"n39hx56"`, `"N39 HX56"` and `"N39  HX56"` to one
spelling on import and on Fix address, so the queue does not show three
versions of one place and the cache keys them together. The IE pattern allows
the `D6W` routing key (Dublin 6 West — a letter in the third position).

## Geocode cache

`lib/geocoding/cache.ts` + migration 0012. Resolved delivery locations are
saved and reused, so a re-imported address costs no Google lookup and a
hand-placed rural address is never hand-placed twice. Fills three paths:
`importOrders` (before an order queues for geocoding), `geocodeOrders` (in
front of Google), and `fixOrderAddress` (writes a `manual` entry).

- **The key is tight, because a cache hit is invisible.** Eircode for Ireland,
  `country:postcode:normalised-address` elsewhere, and **nothing without one of
  those** — a fuzzy address-string match is how a stale pin reaches a live
  order. `geocodeCacheKey()` builds it; keep it in step with the SQL comment.
- **`source` grades trust.** `manual` is reused directly and is **never**
  overwritten by an automatic geocode (`upsert_geocode_cache` has the guard in
  its `ON CONFLICT` clause). `rooftop` / `interpolated` are reused directly.
  `geometric_center` is weak — `geocodeOrders` still tries a fresh geocode and
  only falls back to the cached point if that fails.
- **Never silent.** Every reuse shows "from a saved location / manual fix" on
  the row, the same principle as showing Google's normalised address back.
- **Retention.** It is customer personal data keyed by address — same posture
  as `orders` / `notifications`. `last_used_at` (indexed, non-manual only) is
  there for a staleness sweep; `manual` entries are real human knowledge and
  are kept until the address itself is corrected.
- **Not built:** an admin screen to inspect or prune it, and the staleness
  sweep itself. `geocodeOrders` still hard-returns `not_configured` when
  `GEOCODING_API_KEY` is unset, so cache-only geocoding from the UI does not
  work yet (the import path already runs cache-only).

## Known gaps

- **ETA-based geofence *alert firing*** still needs the geofence engine itself,
  which is unbuilt. `isApproaching()` now has a routed-ETA signal, but nothing
  fires `notifications` rows yet. `estimateMinutes()` in `lib/format.ts`
  remains a crude 45 km/h stand-in for display only and must never gate an
  alert.
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
