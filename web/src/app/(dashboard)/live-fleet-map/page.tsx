import type { Metadata } from "next";

import { Icon, Page, PageHeader, StatTile } from "@/components/ui";
import {
  GEOFENCE_RADIUS_M,
  activeOf,
  getLoads,
  getOrders,
  getTrucks,
  stopsInGeofence,
} from "@/lib/data/fleet";
import { MAPS_KEY_VARS, googleMapsKey } from "@/lib/maps.server";
import { SyncGpsButton } from "@/components/sync-gps";

import { FleetMap } from "./fleet-map";
import { RealtimeStatus } from "./realtime-status";

export const metadata: Metadata = { title: "Live Fleet Map" };

export default async function LiveFleetMapPage() {
  const [trucks, loads, orders] = await Promise.all([
    getTrucks(),
    getLoads({ routedEtas: true }),
    getOrders(),
  ]);
  const reporting = trucks.filter((t) => t.current_location !== null);
  const offline = trucks.length - reporting.length;
  const activeLoads = activeOf(loads);
  const inGeofence = stopsInGeofence(loads);
  const mapsKey = googleMapsKey();

  // Demand that has not yet been put on a load — the CRM's "where we need to
  // go next", not the truck's own next stop. Only the geocoded ones can be
  // pinned; the rest are counted so the gap is visible rather than silent.
  const pending = orders.filter((o) => o.status === "pending");
  const pendingOrders = pending.filter((o) => o.delivery_location !== null);
  const pendingUngeocoded = pending.length - pendingOrders.length;

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Live Fleet Map"
        description="Truck positions from the telematics feed, with the 5 km alert geofence drawn around each next stop, alongside pending orders not yet on a load."
        actions={<SyncGpsButton />}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile
          label="Reporting"
          value={reporting.length}
          unit={`/ ${trucks.length}`}
          hint="Units with a recent GPS fix"
          icon="satellite_alt"
          tone="ok"
        />
        <StatTile
          label="On a load"
          value={activeLoads.length}
          hint="Active routes in progress"
          icon="route"
          tone="brand"
        />
        <StatTile
          label="Inside geofence"
          value={inGeofence.length}
          unit={`/ ${GEOFENCE_RADIUS_M / 1000} km`}
          hint="Approaching a delivery stop"
          icon="my_location"
          tone="warn"
        />
        <StatTile
          label="No fix"
          value={offline}
          hint="Device silent or out of coverage"
          icon="signal_disconnected"
          tone={offline > 0 ? "danger" : "ok"}
        />
        <StatTile
          label="Unplanned demand"
          value={pendingOrders.length}
          hint="Pending orders pinned, not yet on a load"
          icon="pin_drop"
          tone={pendingOrders.length > 0 ? "brand" : "neutral"}
        />
      </div>

      <FleetMap
        trucks={trucks}
        loads={loads}
        pendingOrders={pendingOrders}
        now={new Date()}
        googleMapsKey={mapsKey}
      />

      <RealtimeStatus />

      {pendingUngeocoded > 0 ? (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 shadow-card">
          <Icon name="pin_drop" className="mt-0.5 text-[18px] text-ink-subtle" />
          <p className="text-body-sm text-ink-muted">
            <strong className="text-ink">
              {pendingUngeocoded} pending order{pendingUngeocoded === 1 ? "" : "s"}
            </strong>{" "}
            {pendingUngeocoded === 1 ? "has" : "have"} no coordinates yet, so{" "}
            {pendingUngeocoded === 1 ? "it isn't" : "they aren't"} pinned above.
            Geocode {pendingUngeocoded === 1 ? "it" : "them"} from the Orders
            Queue to see {pendingUngeocoded === 1 ? "it" : "them"} on the map.
          </p>
        </div>
      ) : null}

      {!mapsKey ? (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 shadow-card">
          <Icon name="map" className="mt-0.5 text-[18px] text-ink-subtle" />
          <div className="text-body-sm text-ink-muted">
            <p>
              <strong className="text-ink">No basemap.</strong> This is a
              schematic projection — coordinates and the 5 km geofence rings are
              to true scale, but there is no road network. Neither of these is
              set on this deployment:
            </p>
            <ul className="my-1.5 space-y-0.5">
              {MAPS_KEY_VARS.map((name) => (
                <li key={name} className="font-mono text-data-sm text-ink">
                  {name}
                </li>
              ))}
            </ul>
            <p>
              Set either to a Google browser key with the{" "}
              <em>Maps JavaScript API</em> enabled, and the map switches over.
              The <span className="font-mono text-data-sm">NEXT_PUBLIC_</span>{" "}
              one is compiled in, so it needs a redeploy to take effect; the
              other is read per request. Either way the key is visible in page
              source, so restrict it by HTTP referrer and keep it separate from{" "}
              <span className="font-mono text-data-sm">GEOCODING_API_KEY</span>.
            </p>
          </div>
        </div>
      ) : null}

    </Page>
  );
}
