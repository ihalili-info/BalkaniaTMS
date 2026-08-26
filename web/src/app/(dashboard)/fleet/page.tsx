import type { Metadata } from "next";

import { Button, Page, PageHeader } from "@/components/ui";
import {
  getDrivers,
  getLoads,
  getTrucks,
  loadForDriver,
  loadForTruck,
} from "@/lib/data/fleet";

import { FleetTabs } from "./fleet-tabs";
import type { Assignment } from "./fleet-manager";
import type { DriverAssignment } from "./drivers-panel";

export const metadata: Metadata = { title: "Fleet" };

export default async function FleetPage() {
  const [trucks, drivers, loads] = await Promise.all([
    getTrucks(),
    getDrivers(),
    getLoads(),
  ]);

  // "Is this truck busy" is a join against `loads`, not a column on `trucks` —
  // resolved here so the client components never carry the load rows.
  const truckAssignments: Record<string, Assignment> = Object.fromEntries(
    trucks.map((truck) => {
      const load = loadForTruck(loads, truck.id);
      return [
        truck.id,
        load
          ? { reference: load.reference, driver: load.driver?.full_name ?? null }
          : null,
      ];
    }),
  );

  const driverAssignments: Record<string, DriverAssignment> = Object.fromEntries(
    drivers.map((driver) => {
      const load = loadForDriver(loads, driver.id);
      return [
        driver.id,
        load
          ? { reference: load.reference, plate: load.truck?.license_plate ?? null }
          : null,
      ];
    }),
  );

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Fleet"
        description="The GPS feed brings in truck positions; the tachograph feed brings in driver duty. Everything else — capacity, equipment, availability and licences — is recorded here."
        actions={<Button icon="download">Export fleet</Button>}
      />

      <FleetTabs
        trucks={trucks}
        truckAssignments={truckAssignments}
        drivers={drivers}
        driverAssignments={driverAssignments}
      />
    </Page>
  );
}
