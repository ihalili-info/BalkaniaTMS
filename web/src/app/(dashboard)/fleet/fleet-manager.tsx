"use client";

import { useMemo, useState } from "react";

import {
  Button,
  Card,
  EmptyState,
  FeatureChip,
  Icon,
  StatTile,
  TruckDutyBadge,
  TruckSignalBadge,
  cx,
} from "@/components/ui";
import { updateTruck as persistTruck } from "@/lib/data/mutations";
import { truckDuty, truckSignal, unavailabilityReason } from "@/lib/fleet-status";
import { formatDateFull } from "@/lib/format";
import { vehicleBreaches } from "@/lib/regions";
import { TRUCK_FEATURES, describeFeature } from "@/lib/truck-features";
import type { Truck, TruckDuty } from "@/lib/types";

import { TruckEditor } from "./truck-editor";

export type Assignment = { reference: string; driver: string | null } | null;

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII"];
const romanEuro = (n: number) => ROMAN[n] ?? String(n);

const DUTY_FILTERS: { key: "all" | TruckDuty; label: string }[] = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "on_load", label: "On load" },
  { key: "unavailable", label: "Unavailable" },
  { key: "maintenance", label: "Maintenance" },
];

function AvailabilitySwitch({
  truck,
  onToggle,
}: {
  truck: Truck;
  onToggle: (next: boolean) => void;
}) {
  // Maintenance is a deliberate choice made in the editor, not something to
  // fall into by flicking a switch — so the quick toggle sits it out.
  const locked = truck.availability === "maintenance";
  const on = truck.availability === "available";

  return (
    <div className="flex items-center gap-2">
      <span
        className={cx(
          "font-mono text-label uppercase",
          locked ? "text-ink-subtle" : on ? "text-ok" : "text-warn",
        )}
      >
        {locked ? "In maintenance" : on ? "Available" : "Unavailable"}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={locked}
        title={
          locked
            ? "Clear maintenance in the editor first"
            : on
              ? "Mark unavailable"
              : "Mark available"
        }
        onClick={() => onToggle(!on)}
        className={cx(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          locked
            ? "cursor-not-allowed bg-hairline-strong opacity-50"
            : on
              ? "bg-ok"
              : "bg-hairline-strong",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 size-4 rounded-full bg-surface shadow-card transition-all",
            on ? "left-[1.125rem]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

function TruckCard({
  truck,
  assignment,
  onEdit,
  onToggle,
  now,
}: {
  truck: Truck;
  assignment: Assignment;
  onEdit: () => void;
  onToggle: (next: boolean) => void;
  now: Date;
}) {
  const duty = truckDuty(truck, assignment !== null);
  const signal = truckSignal(truck, now);
  const reason = unavailabilityReason(truck);

  // Ireland and the UK allow 4.65 m; most of the mainland stops at 4.00 m, so
  // a perfectly legal Irish trailer can be illegal the moment it lands. Worth
  // catching in the yard rather than at a French weighbridge.
  const continentalIssues = vehicleBreaches(truck, "FR");

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-hairline px-4 py-3.5">
        <span
          className={cx(
            "flex size-9 shrink-0 items-center justify-center rounded-md",
            duty === "available"
              ? "bg-ok-soft text-ok"
              : duty === "on_load"
                ? "bg-brand-soft text-brand"
                : "bg-surface-sunken text-ink-subtle",
          )}
        >
          <Icon name="local_shipping" filled className="text-[19px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-mono text-heading text-ink">
              {truck.license_plate}
            </h3>
            {truck.label ? (
              <span className="truncate text-body-sm text-ink-muted">
                {truck.label}
              </span>
            ) : null}
          </div>
          <p className="truncate text-caption text-ink-subtle">
            {truck.make_model ?? "Model not set"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <TruckDutyBadge duty={duty} />
          <TruckSignalBadge signal={signal} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3.5">
        <dl className="grid grid-cols-4 gap-2">
          {[
            { term: "Payload", value: truck.capacity_kg, unit: "kg" },
            // The regulated figure, and the one Directive 96/53/EC caps.
            { term: "Gross", value: truck.gross_weight_kg, unit: "kg" },
            { term: "Volume", value: truck.capacity_m3, unit: "m³" },
            { term: "Pallets", value: truck.pallet_slots, unit: "" },
          ].map((cell) => (
            <div
              key={cell.term}
              className="rounded-sm border border-hairline bg-surface-muted px-2 py-1.5"
            >
              <dt className="font-mono text-label uppercase text-ink-subtle">
                {cell.term}
              </dt>
              <dd className="mt-0.5 font-mono text-data-sm tabular text-ink">
                {cell.value === null
                  ? "—"
                  : `${cell.value.toLocaleString("en-GB")}${cell.unit ? ` ${cell.unit}` : ""}`}
              </dd>
            </div>
          ))}
        </dl>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-data-sm text-ink-subtle">
          {truck.height_m ? <span>H {truck.height_m.toFixed(2)} m</span> : null}
          {truck.length_m ? <span>L {truck.length_m.toFixed(2)} m</span> : null}
          {truck.euro_emission_class ? (
            <span>Euro {romanEuro(truck.euro_emission_class)}</span>
          ) : null}
          {truck.adr_classes.length > 0 ? (
            <span>ADR {truck.adr_classes.join(", ")}</span>
          ) : null}
        </p>

        {continentalIssues.length > 0 ? (
          <p className="flex items-start gap-1.5 rounded-sm border border-warn-border bg-warn-soft px-2.5 py-2 text-caption text-ink-muted">
            <Icon name="public_off" className="mt-px text-[15px] text-warn" />
            <span>{continentalIssues[0]}</span>
          </p>
        ) : null}

        {truck.features.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {truck.features.map((f) => (
              <li key={f}>
                <FeatureChip feature={describeFeature(f)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-caption text-ink-subtle">No equipment recorded.</p>
        )}

        {assignment ? (
          <p className="flex items-center gap-1.5 text-caption text-ink-muted">
            <Icon name="route" className="text-[15px] text-ink-subtle" />
            <span className="font-mono text-data-sm text-ink">
              {assignment.reference}
            </span>
            {assignment.driver ? <>· {assignment.driver}</> : null}
          </p>
        ) : null}

        {reason ? (
          <p className="flex items-start gap-1.5 rounded-sm border border-warn-border bg-warn-soft px-2.5 py-2 text-caption text-ink-muted">
            <Icon name="event_busy" className="mt-px text-[15px] text-warn" />
            <span>
              {reason}
              {truck.unavailable_until ? (
                <>
                  {" "}
                  · back {formatDateFull(truck.unavailable_until)}
                </>
              ) : null}
            </span>
          </p>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-hairline pt-3">
          <AvailabilitySwitch truck={truck} onToggle={onToggle} />
          <Button icon="tune" onClick={onEdit}>
            Edit
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function FleetManager({
  trucks,
  assignments,
  now,
}: {
  trucks: Truck[];
  assignments: Record<string, Assignment>;
  now: Date;
}) {
  const [fleet, setFleet] = useState<Truck[]>(trucks);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duty, setDuty] = useState<"all" | TruckDuty>("all");
  const [featureFilter, setFeatureFilter] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * The single seam where a truck edit lands.
   *
   * Optimistic: the card updates immediately, and reverts if the write is
   * refused. Silently keeping a rejected edit on screen would be worse than
   * the flicker — a dispatcher would believe a truck was marked unavailable
   * when the database still says otherwise.
   */
  const updateTruck = (id: string, patch: Partial<Truck>) => {
    const previous = fleet;
    setSaveError(null);
    setFleet((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, ...patch, details_updated_at: new Date().toISOString() }
          : t,
      ),
    );

    void persistTruck(id, patch).then((result) => {
      if (!result.ok) {
        setFleet(previous);
        setSaveError(result.message ?? "Could not save that change.");
      }
    });
  };

  const counts = useMemo(() => {
    const map: Record<"all" | TruckDuty, number> = {
      all: fleet.length,
      available: 0,
      on_load: 0,
      unavailable: 0,
      maintenance: 0,
    };
    for (const t of fleet) map[truckDuty(t, assignments[t.id] != null)] += 1;
    return map;
  }, [fleet, assignments]);

  const noFix = fleet.filter(
    (t) => truckSignal(t, now) === "no_fix",
  ).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fleet.filter((t) => {
      if (duty !== "all" && truckDuty(t, assignments[t.id] != null) !== duty) {
        return false;
      }
      // Feature filters are AND-ed: "reefer + tail lift" means both.
      if (!featureFilter.every((f) => t.features.includes(f))) return false;
      if (!q) return true;
      return (
        t.license_plate.toLowerCase().includes(q) ||
        (t.label ?? "").toLowerCase().includes(q) ||
        (t.make_model ?? "").toLowerCase().includes(q) ||
        t.gps_device_id.toLowerCase().includes(q)
      );
    });
  }, [fleet, duty, featureFilter, query, assignments]);

  const editing = fleet.find((t) => t.id === editingId) ?? null;

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Available"
          value={counts.available}
          hint="Idle and clear to be given work"
          icon="check_circle"
          tone="ok"
        />
        <StatTile
          label="On a load"
          value={counts.on_load}
          hint="Running an active route"
          icon="route"
          tone="brand"
        />
        <StatTile
          label="Out of service"
          value={counts.unavailable + counts.maintenance}
          hint={`${counts.maintenance} in maintenance`}
          icon="event_busy"
          tone={counts.unavailable + counts.maintenance > 0 ? "warn" : "neutral"}
        />
        <StatTile
          label="No GPS fix"
          value={noFix}
          hint="Tracker silent — independent of duty"
          icon="wifi_off"
          tone={noFix > 0 ? "danger" : "ok"}
        />
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {DUTY_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setDuty(f.key)}
                aria-pressed={duty === f.key}
                className={cx(
                  "flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-body-sm transition-colors",
                  duty === f.key
                    ? "bg-brand-soft font-medium text-brand-ink"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                {f.label}
                <span className="font-mono text-label tabular text-ink-subtle">
                  {counts[f.key]}
                </span>
              </button>
            ))}
          </div>

          <label className="ml-auto flex h-9 w-full max-w-xs items-center gap-2 rounded-sm border border-hairline bg-surface-muted px-3 focus-within:border-brand-border focus-within:bg-surface">
            <Icon name="search" className="text-[17px] text-ink-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Plate, name, model or device id"
              className="w-full bg-transparent text-body-sm outline-none placeholder:text-ink-subtle"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3">
          <span className="font-mono text-label uppercase text-ink-subtle">
            Equipment
          </span>
          {TRUCK_FEATURES.map((feature) => {
            const on = featureFilter.includes(feature.id);
            return (
              <button
                key={feature.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setFeatureFilter((prev) =>
                    on
                      ? prev.filter((f) => f !== feature.id)
                      : [...prev, feature.id],
                  )
                }
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption transition-colors",
                  on
                    ? "border-brand-border bg-brand-soft text-brand-ink"
                    : "border-hairline bg-surface text-ink-muted hover:bg-surface-muted",
                )}
              >
                <Icon name={feature.icon} className="text-[14px]" />
                {feature.label}
              </button>
            );
          })}
          {featureFilter.length > 0 ? (
            <button
              type="button"
              onClick={() => setFeatureFilter([])}
              className="ml-1 inline-flex items-center gap-1 text-caption text-ink-subtle hover:text-ink"
            >
              <Icon name="clear_all" className="text-[15px]" />
              Clear
            </button>
          ) : null}
        </div>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="local_shipping"
            title="No trucks match"
            description="Loosen the duty filter or clear the equipment tags to see the rest of the fleet."
          />
        </Card>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {visible.map((truck) => (
            <li key={truck.id} className="flex">
              <TruckCard
                truck={truck}
                assignment={assignments[truck.id] ?? null}
                now={now}
                onEdit={() => setEditingId(truck.id)}
                onToggle={(next) =>
                  updateTruck(truck.id, {
                    availability: next ? "available" : "unavailable",
                    // The CHECK constraint rejects a leftover return date on
                    // an available truck, so clear both on the way back in.
                    availability_note: next ? null : truck.availability_note,
                    unavailable_until: next ? null : truck.unavailable_until,
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}

      {saveError ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
        >
          <Icon name="error" className="mt-px text-[17px]" />
          {saveError}
        </p>
      ) : null}

      {editing ? (
        <TruckEditor
          truck={editing}
          now={now}
          onClose={() => setEditingId(null)}
          onSave={(patch) => {
            updateTruck(editing.id, patch);
            setEditingId(null);
          }}
        />
      ) : null}
    </>
  );
}
