import type { Metadata } from "next";

import { Icon, Page, PageHeader, StatTile } from "@/components/ui";
import {
  GEOFENCE_RADIUS_M,
  activeOf,
  getLoads,
  getTrucks,
  stopsInGeofence,
} from "@/lib/data/fleet";
import { MAPS_KEY_VARS, googleMapsKey } from "@/lib/maps.server";
import { SyncGpsButton } from "@/components/sync-gps";

import { FleetMap } from "./fleet-map";
import { RealtimeStatus } from "./realtime-status";

export const metadata: Metadata = { title: "Live Fleet Map" };

export default async function LiveFleetMapPage() {
  const [trucks, loads] = await Promise.all([getTrucks(), getLoads()]);
  const reporting = trucks.filter((t) => t.current_location !== null);
  const offline = trucks.length - reporting.length;
  const activeLoads = activeOf(loads);
  const inGeofence = stopsInGeofence(loads);
  const mapsKey = googleMapsKey();

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Live Fleet Map"
        description="Truck positions from the telematics feed, with the 5 km alert geofence drawn around each next stop."
        actions={<SyncGpsButton />}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
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
      </div>

      <FleetMap
        trucks={trucks}
        loads={loads}
        now={new Date()}
        googleMapsKey={mapsKey}
      />

      <RealtimeStatus />

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
