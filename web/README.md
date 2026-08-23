# Balkania TMS — admin panel

Next.js 16 (App Router) dispatcher console for Balkania TMS — an Ireland-based
haulier running domestic, Northern Ireland, GB and mainland EU work. Load
planning, live fleet tracking, driver-hours compliance, geofenced customer
alerts, and integration setup.

```bash
npm install
cp .env.example .env.local   # fill in before any real data will load
npm run dev                  # http://localhost:3000
```

Every screen currently renders **demo fixtures** — no Supabase project is
connected yet. The header shows a "Demo data" badge so this is never mistaken
for live state.

## Layout

```
src/
  proxy.ts                route guard (Next 16 renamed middleware -> proxy)
  app/
    layout.tsx              root layout, fonts, metadata
    globals.css             the whole design system as Tailwind v4 @theme tokens
    (dashboard)/            the nav sections, wrapped in AppShell
    forbidden/              shown when a role cannot open a module
  components/
    app-shell.tsx           dark navigation rail + light topbar
    ui/index.tsx            Card, Button, Badge, StatTile, Table, … primitives
    charts.tsx              dependency-free SVG column / line / category charts
  lib/
    types.ts                row types mirroring supabase/migrations/
    auth/                   roles + module registry, session, page guard
    navigation-links.ts     Waze / Google / Apple deep links + HGV caveats
    driver-messaging.ts     driver SMS composition, GSM-7 segment counting
    csv.ts                  RFC 4180 CSV reader/writer
    orders-import.ts        CSV column schema, auto-mapping, row validation
    regions.ts              country registry — limits, postcodes, customs regimes
    driver-hours.ts         Reg. (EC) 561/2006 driving time and rest
    fleet-status.ts         truck duty / GPS signal derivation
    truck-features.ts       equipment tag catalogue
    format.ts               distance, ETA and relative-time formatting
    demo/                   fixtures: fleet, analytics, integrations
    supabase/               client / server / service-role helpers
```

## Conventions

- **Tokens, not literals.** Colours, type sizes, radii and shadows all live in
  `globals.css` under `@theme`. Components use `bg-surface`, `text-heading`,
  `border-hairline` and friends — never a raw hex or `text-[13px]`.
- **Fixtures match the schema.** `lib/demo/*` returns the exact shapes in
  `lib/types.ts`, so replacing a fixture import with a real Supabase query is a
  one-line change per page.
- **Fixed demo clock.** Timestamps are anchored to `DEMO_NOW`, not
  `Date.now()`, so server and client render identical strings.
- **Charts.** One y-axis per plot, marks carry the series colour, text never
  does, and every plot ships a tooltip plus a `<details>` table view. The
  categorical palette (`--color-viz-1..3`) is validated for colour-vision
  deficiency — re-run the validator before changing it.
- **No country is hard-coded.** Dial prefixes, postcode shapes, weight and
  height limits and customs regimes are rows in `lib/regions.ts`. Adding a
  country is a row there; a component that special-cases `"IE"` is a bug.
- **Nav filtering is not access control.** Roles gate modules in four layers:
  sidebar (convenience), `proxy.ts`, `requireAccess()` in the page, and RLS in
  migration 0004. Adding an admin-only page means a `roles` entry in
  `lib/auth/roles.ts` *and* a `requireAccess()` call — never one alone. Unknown
  roles fail closed to `dispatcher`.
- **Compliance numbers are planning aids.** The Reg. 561/2006 counters and
  `estimateMinutes()` help a dispatcher decide; the tachograph is the legal
  record. Never label the app's figures as proof of compliance.

## Sending a driver their route

From Active Loads, "Send route" composes an SMS or WhatsApp with navigation
deep links. Google Maps takes the whole remaining route; Waze and Apple Maps
take the next stop only, and each link says which. A warning fires when the
vehicle is too tall, too heavy or carrying ADR for a consumer navigator to route
safely.

**Drivers only.** Customers receive only the three automated alerts in
`notifications` — there is no dispatcher-initiated customer SMS. Keep it that
way unless there is a decision to the contrary.

## Importing orders

No CRM sync yet, so the Orders Queue takes a CSV. Drop a file, match the
columns (auto-mapped from common header spellings), review the per-row result,
import. A template is downloadable from the dialog.

`lib/csv.ts` is a proper RFC 4180 parser — quoted commas, escaped quotes,
embedded newlines, BOM, CRLF and semicolon/tab delimiters all work, because
real order exports have all of them. Errors block a row; warnings (odd
postcode, missing country code) do not.

## Roles

`admin` sees every module; `dispatcher` sees every module except Integrations.
The sidebar has a **demo-only** role switcher because nothing authenticates yet
— it writes the cookie `getCurrentUser()` reads, so switching exercises the
real guards. It disappears with Supabase Auth, since a real user cannot choose
their own role.

To wire real auth, replace the body of `getCurrentUser()` in
`lib/auth/session.ts` (the doc comment has the exact query) and build a sign-in
page. Everything downstream is already role-aware. Take the role from
`profiles`, never from user metadata the client can write.

## Swapping fixtures for Supabase

1. Provision the project, enable PostGIS, apply `supabase/migrations/` in order
   (0004 turns on RLS — after that, an unauthenticated client sees nothing).
2. Fill `.env.local` from `.env.example`.
3. Per page, replace the `@/lib/demo/fleet` import with a query through
   `@/lib/supabase/server`, returning the same `LoadView` / `Order` shapes.
4. Drop the "Demo data" badge in `components/app-shell.tsx`.

## Deploying to Vercel

The app builds clean and has no runtime that Vercel can't host, and no module
reads an env var at import time, so a build succeeds even with nothing
configured. Module routes are server-rendered rather than static, because the
role guard reads cookies — that is expected, not a regression. Three things need
saying:

1. **Set the Vercel project's Root Directory to `web`.** The repo root holds the
   architecture doc and `supabase/`; the Next.js app is one level down. Without
   this, the build finds no `package.json`. `vercel.json` lives here in `web/`
   for the same reason — Vercel reads it from the root directory, not the repo
   root.
2. **Import from GitHub.** The repo root is a git repository with `origin` at
   `github.com/ihalili-info/BalkaniaTMS`, `main` as the default branch — Vercel's
   "Import Project" can point at it directly. `vercel deploy` from the CLI also
   works, and will prompt for the root directory on first `vercel link`.
3. **Functions run in `dub1` (Dublin).** Set in `vercel.json`, and not cosmetic.
   Vercel defaults every new project to `iad1` (Washington DC), which would put
   customer names, phone numbers and delivery addresses through US compute on
   every request — an EEA transfer the GDPR section of the architecture doc does
   not budget for — and would add a transatlantic round trip to every Supabase
   query. Provision Supabase in an EU region too, or the region pinning only
   solves half of it. `dub1` is a single region, so it is within the Hobby plan
   limit.

Then add the `.env.example` variables as Vercel Environment Variables. Only the
`NEXT_PUBLIC_*` pair is exposed to the browser; keep
`SUPABASE_SERVICE_ROLE_KEY`, the Sent credentials and the webhook secrets
server-only.

Note that **Routing Middleware — our `proxy.ts` — is deployed to all regions
regardless of the `regions` setting.** That is fine here: it reads a cookie and
either continues or redirects, so it touches no personal data and reaches no
database.

### Not yet needed, but coming

- **A cron entry in `vercel.json`** for GPS polling, once `/api/cron/gps`
  exists. Deliberately not added yet — a cron pointed at a route that doesn't
  exist just fails on a schedule. Note the platform floor of one minute; prefer
  the provider's push webhook where it is offered.
- **Dynamic rendering.** The moment a page reads Supabase through
  `lib/supabase/server.ts` it stops being static, because that helper touches
  cookies. That is expected, not a regression.
