"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import type { Driver, Order, Truck } from "@/lib/types";

import { SyncGpsButton } from "@/components/sync-gps";

import { PlanLoadDialog } from "./plan-load-dialog";

/** The two header actions on Active Loads. */
export function DispatchActions({
  trucks,
  drivers,
  unassignedOrders,
}: {
  trucks: Truck[];
  drivers: Driver[];
  unassignedOrders: Order[];
}) {
  const [planning, setPlanning] = useState(false);

  return (
    <>
      <SyncGpsButton />

      <Button
        variant="primary"
        icon="add"
        onClick={() => setPlanning(true)}
        disabled={unassignedOrders.length === 0 && trucks.length === 0}
      >
        Plan load
      </Button>

      {planning ? (
        <PlanLoadDialog
          trucks={trucks}
          drivers={drivers}
          orders={unassignedOrders}
          onClose={() => setPlanning(false)}
        />
      ) : null}

    </>
  );
}
