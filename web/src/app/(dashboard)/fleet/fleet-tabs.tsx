"use client";

import { useState } from "react";

import { Icon, cx } from "@/components/ui";
import type { Driver, Truck } from "@/lib/types";

import { DriversPanel, type DriverAssignment } from "./drivers-panel";
import { FleetManager, type Assignment } from "./fleet-manager";

type Tab = "trucks" | "drivers";

export function FleetTabs({
  trucks,
  truckAssignments,
  drivers,
  driverAssignments,
}: {
  trucks: Truck[];
  truckAssignments: Record<string, Assignment>;
  drivers: Driver[];
  driverAssignments: Record<string, DriverAssignment>;
}) {
  const [tab, setTab] = useState<Tab>("trucks");

  const TABS: { key: Tab; label: string; icon: string; count: number }[] = [
    { key: "trucks", label: "Trucks", icon: "local_shipping", count: trucks.length },
    { key: "drivers", label: "Drivers", icon: "badge", count: drivers.length },
  ];

  return (
    <>
      <div
        role="tablist"
        aria-label="Fleet resources"
        className="mb-6 flex gap-1 border-b border-hairline"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cx(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-body-sm transition-colors",
              tab === t.key
                ? "border-brand font-medium text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            <Icon
              name={t.icon}
              filled={tab === t.key}
              className={cx("text-[18px]", tab === t.key && "text-brand")}
            />
            {t.label}
            <span className="font-mono text-label tabular text-ink-subtle">
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {tab === "trucks" ? (
        <FleetManager trucks={trucks} assignments={truckAssignments} />
      ) : (
        <DriversPanel drivers={drivers} assignments={driverAssignments} />
      )}
    </>
  );
}
