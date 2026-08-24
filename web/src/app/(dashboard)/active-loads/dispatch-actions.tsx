"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import type { Driver, Order, Truck } from "@/lib/types";

import { AutoPlanDialog } from "@/components/auto-plan-dialog";
import { SyncGpsButton } from "@/components/sync-gps";

import { PlanLoadDialog } from "./plan-load-dialog";

/** The two header actions on Active Loads. */
export function DispatchActions({
  trucks,
  drivers,
  unassignedOrders,
  geocodingReady,
}: {
  trucks: Truck[];
  drivers: Driver[];
  unassignedOrders: Order[];
  /** GEOCODING_API_KEY present — Auto-plan says so rather than failing late. */
  geocodingReady: boolean;
}) {
  const [planning, setPlanning] = useState(false);
  const [autoPlanning, setAutoPlanning] = useState(false);

  return (
    <>
      <SyncGpsButton />

      <Button
        icon="auto_awesome"
        onClick={() => setAutoPlanning(true)}
        disabled={unassignedOrders.length === 0}
        title="Group the waiting orders by how close the drops are and propose loads"
      >
        Auto-plan
      </Button>

      <Button
        variant="primary"
        icon="add"
        onClick={() => setPlanning(true)}
        disabled={unassignedOrders.length === 0 && trucks.length === 0}
      >
        Plan load
      </Button>

      {autoPlanning ? (
        <AutoPlanDialog
          orders={unassignedOrders}
          trucks={trucks}
          // Unassigned by definition, so nothing here is on a load already.
          loadRefByOrderId={{}}
          geocodingReady={geocodingReady}
          onClose={() => setAutoPlanning(false)}
        />
      ) : null}

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
