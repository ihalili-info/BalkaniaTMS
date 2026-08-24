import type { Metadata } from "next";

import { Button, Icon, Page, PageHeader, StatTile } from "@/components/ui";
import {
  GEOFENCE_RADIUS_M,
  activeOf,
  getLoads,
  getTrucks,
  stopsInGeofence,
} from "@/lib/data/fleet";

import { FleetMap } from "./fleet-map";

export const metadata: Metadata = { title: "Live Fleet Map" };

export default async function LiveFleetMapPage() {
  const [trucks, loads] = await Promise.all([getTrucks(), getLoads()]);
  const reporting = trucks.filter((t) => t.current_location !== null);
  const offline = trucks.length - reporting.length;
  const activeLoads = activeOf(loads);
  const inGeofence = stopsInGeofence(loads);

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Live Fleet Map"
        description="Truck positions from the telematics feed, with the 5 km alert geofence drawn around each next stop."
        actions={
          <>
            <Button icon="my_location">Centre on fleet</Button>
            <Button variant="primary" icon="refresh">
              Refresh positions
            </Button>
          </>
        }
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

      <FleetMap trucks={trucks} loads={loads} now={new Date()} />

      {/* Kept visible rather than buried in a doc: this screen is a placeholder
          geometry until a tile provider is chosen and keyed. */}
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 shadow-card">
        <Icon name="info" className="mt-0.5 text-[18px] text-ink-subtle" />
        <p className="text-body-sm text-ink-muted">
          This is a schematic projection, not a basemap — coordinates and the
          5 km geofence rings are to true scale, but there is no road network.
          Wiring a tile provider (Mapbox or Google Maps) replaces the canvas;
          the geofence, route-leg and marker overlays carry over unchanged.
        </p>
      </div>
    </Page>
  );
}
