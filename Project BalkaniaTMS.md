# Balkania TMS — System Architecture

## Project Overview
**Balkania TMS** is an Ireland-based automated logistics, route tracking, and customer notification platform. The system synchronizes order data from an existing CRM, tracks vehicle positions via telematics APIs, manages load assignments, and sends automated proximity alerts to customers via SMS and WhatsApp.

---

## Tech Stack & Tooling Strategy

| Layer / Subsystem | Chosen Technology | Description & Purpose |
| :--- | :--- | :--- |
| **Development Assistant** | **Claude** | Primary AI assistant for code generation, API routes, database functions, and logic implementation. |
| **UI Design System** | **In-repo design system** | Tailwind v4 `@theme` tokens in `web/src/app/globals.css` plus primitives in `web/src/components/ui/`. (Google Stitch was used for the first round of prototypes and has been retired.) |
| **Frontend Framework** | **Next.js (App Router)** | Hosted on **Vercel** for server-rendered UI, admin load planning, and serverless API endpoints. |
| **Backend & Database** | **Supabase** | PostgreSQL database with **PostGIS** extension for geospatial calculations, webhooks, and real-time state updates. |
| **Authentication** | **Supabase Auth** | Login and role-based access. Two roles in `profiles.role`: `admin` (all modules) and `dispatcher` (all except Integrations), enforced by RLS — see migration 0004. |
| **Geocoding** | **Google Geocoding API** (or Mapbox) | Converts CRM delivery addresses into `GEOGRAPHY(Point, 4326)` coordinates during order ingestion. For Irish orders a well-formed Eircode is queried on its own first — it is a building, not a district. |
| **Routing & ETA** | **Google Routes API** (`ROUTING_API_KEY`, falls back to the Geocoding key) | Road distance/time for auto-plan sequencing (`computeRouteMatrix`, traffic-unaware) and live truck → next-stop ETA (`computeRoutes`, traffic-aware). Car routing — no HGV profile. Every consumer falls back to great-circle distance when unconfigured or on failure. |
| **Communications** | **Sent** (sent.dm) | Unified SMS/WhatsApp/RCS API for triggered dispatch and proximity alerts. `POST /v3/messages`, `x-api-key` auth. Leave `channel` unset so Sent falls back across channels — naming several broadcasts and bills per channel. |
| **Telematics / GPS** | **Verizon Connect Reveal** (formerly Fleetmatics) | EU tenant `fim.eu.fleetmatics.com`. GPS webhook push into `/api/webhooks/gps` (Basic auth we set). RAD REST pull is fallback only — no fleet-wide endpoint, and Verizon caps polling at one call per vehicle every 3–5 minutes. |
| **Tachograph** | **Smart tachograph API** | Reg. (EU) 165/2014. Driver cards and duty time, feeding the Reg. 561/2006 counters on `drivers`. Deliberately separate from the GPS feed — position is not duty. |
| **Customs** | **Declaration provider** *(not chosen)* | Export/import declarations for GB movements and Windsor Framework lanes for Northern Ireland. |

---

## High-Level System Workflow

```
[ CRM API ] ---> ( Next.js Webhook / API Route ) ---> [ Supabase (PostGIS) ]
                                                             ^
[ Admin Panel (Next.js)   ] <--------------------------------+
                                                             v
[ Vehicle GPS API ] ---> ( Vercel Cron Job ) ---------------+
                                                             |
                                                  (Geofence Calculation)
                                                             |
                                                             v
[ Sent API ] <--- ( Supabase Webhook / Edge Function ) ------+---> [ WhatsApp / SMS Alert ]
```

---

## Key Modules & Responsibilities

### 1. Ingestion & Load Planning (Admin Panel)
* **Design Framework:** Built on the in-repo design system — see `web/README.md` for tokens and conventions.
* **Access Control:** Authentication via **Supabase Auth**; `profiles.role` decides which modules are reachable. `admin` gets everything including Integrations and its connector configuration; `dispatcher` gets everything else. Enforced in the database by RLS (migration 0004), not only in the UI — the sidebar filter is a convenience, the policies are the control. New accounts default to `dispatcher`, and nobody can edit their own role.
* **CSV Import (interim):** Until the webhook exists, dispatchers import orders from a spreadsheet on the Orders Queue. Rows are validated against the same required fields and per-country postcode rules the webhook will use; rows with errors are skipped rather than guessed at, and imported orders without coordinates queue for geocoding exactly as a failed geocode does. Worth keeping after the webhook ships, for one-off spreadsheets.
* **CRM Ingestion:** Webhook endpoint (`/api/webhooks/crm`) receives processed orders and geocodes the street address into a `GEOGRAPHY(Point, 4326)` coordinate. Orders that fail geocoding are flagged for manual address correction in the Admin Panel rather than silently dropped.
* **Manual Load Assignment:** Interface allowing dispatchers to select target orders, assign them to trucks, and set sequence stop orders. Assigning a load transitions `orders.status` to `assigned`.
* **Status Ownership:** `orders.status` is updated at three points — `assigned` on load assignment, `en_route` when the dispatch confirmation notification is sent, `delivered` when the corresponding `load_items.delivered_at` is set.
* **Finishing a load:** `load_items.delivered_at` will be stamped by the geofencing engine (§2) once it exists. Until then a dispatcher marks each drop manually on the active load (`markStopDelivered` / `undeliverStop`); the last stop delivered moves `loads.status` to `completed`. The manual control stays afterwards as the override for a GPS gap or a phoned-in delivery.

### 2. Live Tracking & Geofencing Engine
* **GPS Sync:** Verizon Connect Reveal pushes each fix to `/api/webhooks/gps`, updating `trucks.current_location` in near real-time. The route authenticates with HTTP Basic (credentials we choose and register with Verizon) and guards every write with Reveal's per-vehicle `SequenceId`, because webhook deliveries retry, duplicate and arrive out of order. Polling the RAD API is a fallback only: there is no fleet-wide endpoint, so it costs one HTTP call per truck per cycle, and Verizon asks for no more than one call per vehicle every 3–5 minutes. That provider limit — not Vercel Cron's one-minute floor — is what bounds how fresh a polled position can be.
* **Identifier:** `trucks.gps_device_id` stores Reveal's **Vehicle Number**, not the device serial. Verizon does not populate that field on account creation; it must be set per vehicle in Reveal first.
* **Spatial Querying:** Uses PostgreSQL PostGIS functions (`ST_Distance`) to compute distance between trucks and destination stops.
* **Realtime Dashboard:** Supabase Realtime updates dispatcher maps dynamically without full page reloads.

### 3. Driver Navigation Handoff
* **Deep links:** A dispatcher can send the assigned driver their route as **Waze**, **Google Maps** and **Apple Maps** links, recorded in `driver_messages` with the sending user for accountability.
* **Not equivalent:** only Google Maps accepts a multi-stop URL (nine waypoints). Waze and Apple Maps take a single destination and therefore receive the *next* stop, not the last. Each link states its coverage.
* **Consumer navigators, not HGV routing:** none applies height, weight or ADR restrictions. A 4.62 m Irish trailer is legal at home and over the 4.00 m limit across most of the continent, so the warning is shown at the point of handoff. Proper truck routing needs an HGV-aware routing API — an open item alongside ETA-based geofencing.

### 4. Automated Client Alerts (Sent)
* **Scope — customer messaging is closed:** the three types below are the *only* messages a customer receives. There is no dispatcher-initiated customer SMS and no public tracking link; both would create a new exposure of a customer's address for no operational gain. Driver messaging is a separate table and a separate channel.
* **Trigger Conditions (v1):** Fires when a truck is within $5\text{ km}$ of the destination stop (straight-line PostGIS distance). Time-based triggering ($\le 15\text{ minutes}$ ETA) requires a routing/ETA API and is a v2 consideration — straight-line distance is not a reliable proxy for drive time.
* **Notification Types** (logged individually in the `notifications` table so each can fire independently per order):
  * **Dispatch Confirmation:** *"Your order #1234 has been loaded and is on the way."*
  * **Proximity Alert:** *"Our driver is approximately 15 minutes away from your location."*
  * **Delivery Complete:** *"Order delivered successfully."*.

---

## Database Schema (Supabase + PostGIS)

```sql
-- Enable PostGIS extension for distance & geofencing calculations
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Trucks Table  (see migration 0002 for the dispatcher-owned columns)
CREATE TABLE trucks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_plate TEXT NOT NULL,
  gps_device_id TEXT UNIQUE NOT NULL,

  -- owned by the telematics feed
  current_location GEOGRAPHY(POINT, 4326),
  location_updated_at TIMESTAMPTZ DEFAULT NOW(),  -- renamed from updated_at in 0002

  -- owned by dispatchers, edited in the admin panel (0002)
  label TEXT,
  make_model TEXT,
  capacity_kg INTEGER CHECK (capacity_kg IS NULL OR capacity_kg > 0),
  capacity_m3 NUMERIC(6,2) CHECK (capacity_m3 IS NULL OR capacity_m3 > 0),
  pallet_slots SMALLINT CHECK (pallet_slots IS NULL OR pallet_slots > 0),
  features TEXT[] NOT NULL DEFAULT '{}',
  availability TEXT NOT NULL DEFAULT 'available'
    CHECK (availability IN ('available', 'unavailable', 'maintenance')),
  availability_note TEXT,
  unavailable_until TIMESTAMPTZ,
  details_updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Orders Table
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_order_id TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_location GEOGRAPHY(POINT, 4326),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'en_route', 'delivered')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Loads Table (Grouping Orders to Trucks)
CREATE TABLE loads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Load Items (Stop Sequence & Delivery Tracking)
CREATE TABLE load_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id UUID REFERENCES loads(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  stop_sequence INT NOT NULL,
  delivered_at TIMESTAMPTZ
);

-- 5. Notifications Table (per-type alert log — replaces a single boolean flag
-- so dispatch/proximity/delivery alerts can each fire independently per stop)
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  load_item_id UUID REFERENCES load_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('dispatch_confirmation', 'proximity_alert', 'delivery_complete')),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (load_item_id, type)
);

-- 6. Geocode cache (migration 0012) — resolved delivery locations, reused
-- across imports. Keyed on an Eircode (IE) or country:postcode:address line.
-- A `manual` fix is human-verified and upsert_geocode_cache() refuses to let
-- an automatic geocode overwrite it.
CREATE TABLE geocode_cache (
  key TEXT PRIMARY KEY,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','rooftop','interpolated','geometric_center')),
  formatted_address TEXT,
  verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  hit_count INT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Spatial indexes for efficient proximity queries
CREATE INDEX idx_trucks_location ON trucks USING GIST (current_location);
CREATE INDEX idx_trucks_features ON trucks USING GIN (features);
CREATE INDEX idx_trucks_assignable ON trucks (id) WHERE availability = 'available';
CREATE INDEX idx_orders_location ON orders USING GIST (delivery_location);
CREATE INDEX idx_geocode_cache_last_used ON geocode_cache (last_used_at) WHERE source <> 'manual';
```

### Truck ownership split

`trucks` has two writers and they must not tread on each other:

* **The telematics feed** owns `current_location` and `location_updated_at`.
  Nothing a dispatcher does may touch them — otherwise flipping a truck to
  "unavailable" would make a stale GPS fix look fresh on the live map. This is
  why `updated_at` was renamed in migration 0002; the old name invited exactly
  that bug.
* **Dispatchers** own identity, capacity, `features` and `availability`, all
  stamped with `details_updated_at`.

`availability` records *intent* — may this truck be given work at all. Whether
it is **busy right now** is a different question, already answerable from
`loads`, and is deliberately not duplicated onto the truck row. The admin panel
shows the two as separate badges (duty and GPS signal) rather than collapsing
them, because a truck can be booked solid *and* have a dead tracker.

`features` is an open `TEXT[]`, not a lookup table or an enum: the panel ships a
catalogue of known tags (reefer, tail lift, ADR, …) for labels and icons, but a
dispatcher can add a one-off tag without a migration. The GIN index keeps
`features @> ARRAY['reefer']` cheap when matching a load's requirements.

### Geography, customs and jurisdiction

The operation runs out of Dublin into Northern Ireland, Great Britain and
mainland Europe, and is expanding further. Country is therefore never assumed:

* `orders.delivery_country`, `loads.origin_country` and `drivers.home_country`
  are ISO 3166-1 alpha-2, plus **`XI` for Northern Ireland**. `XI` is not
  decoration — it is the real EORI/VAT prefix, and under the Windsor Framework
  NI is its own customs territory. Treating it as `GB` produces the wrong
  paperwork.
* Everything that varies by jurisdiction — dial prefix, postcode format, gross
  weight and height limits, customs regime — lives in
  `web/src/lib/regions.ts`, keyed by those codes. **Adding a country is a row
  in that table, not a code change.**
* International carriage by road needs a CMR consignment note
  (`loads.cmr_number`); a domestic run does not.

### Driving time and rest (Reg. (EC) No 561/2006)

The limits are per driver, tracked against a personal tachograph card, and they
decide whether a dispatch plan is legal. `drivers` carries a duty snapshot the
tachograph sync overwrites: driving since last break, driving today, extended
10-hour days used this week, driving this week.

`web/src/lib/driver-hours.ts` is the single implementation of the rules — 4h30
before a 45 min break, 9h a day (10h twice weekly), 56h a week. The UK and NI
retained the same figures after Brexit, so one implementation covers every
country the fleet runs in.

**These counters are a planning aid, not evidence.** The tachograph record is
what roadside enforcement reads, and `estimateMinutes()` is a crude speed
assumption. Never present the app's numbers as proof of compliance.

### Data protection (GDPR / ePrivacy)

`orders` and `notifications` hold names, phone numbers, addresses and
timestamps. Three rules the implementation has to respect:

* **Lawful basis** for delivery alerts is performance of a contract, Art.
  6(1)(b) — transactional, not marketing, so no prior opt-in. Anything
  promotional would need separate consent.
* **Opt-out is absolute.** A STOP reply sets `orders.notifications_opt_out`.
  The alert query excludes those rows via `idx_orders_alertable` — filtering in
  the UI is not sufficient, because the sender is what has to stay silent.
* **Retention.** `notifications` rows are purged on a schedule (Art. 5(1)(e));
  `idx_notifications_sent_at` exists to make that cheap.

---

## Geofence Proximity Query Example

```sql
-- Query to identify active orders within 5km (5000m) of truck position
-- that have not yet received a proximity alert
SELECT 
  li.id AS load_item_id,
  o.customer_phone,
  o.crm_order_id,
  ST_Distance(t.current_location, o.delivery_location) AS distance_meters
FROM load_items li
JOIN loads l ON li.load_id = l.id
JOIN trucks t ON l.truck_id = t.id
JOIN orders o ON li.order_id = o.id
WHERE l.status = 'active'
  AND ST_Distance(t.current_location, o.delivery_location) <= 5000
  -- ePrivacy: a customer who replied STOP is excluded here, at the query,
  -- rather than being filtered out somewhere downstream.
  AND o.notifications_opt_out = FALSE
  AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.load_item_id = li.id AND n.type = 'proximity_alert'
  );
```

---

## Next Steps for Implementation

1. **Setup Core Stack:** Provision Vercel project and Supabase instance (enable PostGIS, apply migrations 0001–0004, obtain a geocoding API key).
2. **Admin Panel UI:** Built — Active Loads, Orders Queue, Live Fleet Map, Analytics and Integration Settings all render against demo fixtures. Still to design: the Login screen, and a real basemap for the fleet map.
3. **Claude Coding Workflows:** Use Claude to build Next.js API routes, Supabase client integrations, and Sent webhooks.
4. **GPS Integration & Testing:** Connect vehicle GPS API feed to verify spatial distance triggers and messaging routines.
5. **Tachograph Integration:** Connect a smart tachograph feed so the Reg. 561/2006 counters on `drivers` are real rather than fixtures. **Reveal cannot supply this** — its API offers `PUT Hours of Use` but no way to read tachograph duty, so this needs a separate provider.
6. **Sign-in:** Build the login screen and swap `getCurrentUser()` in `web/src/lib/auth/session.ts` for the real Supabase session. Everything downstream is already role-aware.
7. **Customs:** Choose a declaration provider before the first GB or at-risk NI load moves; obtain the EORI number and UKIMS authorisation.