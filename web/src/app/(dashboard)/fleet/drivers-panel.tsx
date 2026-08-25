"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  Badge,
  Button,
  EmptyState,
  Card,
  CountryChip,
  DriverHoursBadge,
  DriverHoursBar,
  Icon,
  StatTile,
  cx,
} from "@/components/ui";
import {
  CONTINUOUS_DRIVING_LIMIT_S,
  DUTY_STATUS_LABEL,
  WEEKLY_DRIVING_LIMIT_S,
  driverHours,
  formatDuration,
} from "@/lib/driver-hours";
import { deleteDriver } from "@/lib/data/mutations";
import { formatDateFull, relativeTime } from "@/lib/format";
import type { Driver, Truck } from "@/lib/types";

import { DriverEditor } from "./driver-editor";

export type DriverAssignment = { reference: string; plate: string | null } | null;

/** Directive 2003/59/EC: a lapsed CPC means the driver may not work at all. */
const CPC_WARNING_DAYS = 90;

function cpcState(driver: Driver, now: Date) {
  if (!driver.cpc_expires_on) return { level: "unknown" as const, days: null };
  const days = Math.round(
    (new Date(driver.cpc_expires_on).getTime() - now.getTime()) / 86_400_000,
  );
  if (days < 0) return { level: "expired" as const, days };
  if (days <= CPC_WARNING_DAYS) return { level: "expiring" as const, days };
  return { level: "valid" as const, days };
}

function DriverCard({
  driver,
  truck,
  assignment,
  now,
  onEdit,
  onDelete,
}: {
  driver: Driver;
  /** The driver's assigned vehicle, if the truck still exists. */
  truck: Truck | null;
  assignment: DriverAssignment;
  now: Date;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hours = driverHours(driver);
  const cpc = cpcState(driver, now);
  // No sync means the counters are defaults, not readings. Zeroes render as
  // "10h left today", which is a claim that the driver is fully rested — the
  // app cannot back that, so it says nothing instead.
  const hasDutyData = driver.duty_synced_at !== null;

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-hairline px-4 py-3.5">
        <span
          className={cx(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-caption font-medium",
            driver.duty_status === "driving"
              ? "bg-brand-soft text-brand"
              : "bg-surface-sunken text-ink-subtle",
          )}
        >
          {driver.full_name
            .split(" ")
            .map((part) => part[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-heading text-ink">{driver.full_name}</h3>
            <CountryChip code={driver.home_country} />
          </div>
          <p className="flex items-center gap-1.5 truncate font-mono text-data-sm text-ink-subtle">
            <Icon name="local_shipping" className="text-[14px]" />
            {truck ? (
              <span className="text-ink">{truck.license_plate}</span>
            ) : (
              <span>no vehicle</span>
            )}
            <span aria-hidden="true">·</span>
            {driver.tachograph_card_no ?? "no tacho card"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {driver.duty_synced_at ? (
            <Badge tone={driver.duty_status === "driving" ? "brand" : "neutral"} dot>
              {DUTY_STATUS_LABEL[driver.duty_status]}
            </Badge>
          ) : null}
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${driver.full_name}`}
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="tune" className="text-[17px]" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${driver.full_name}`}
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger"
          >
            <Icon name="delete" className="text-[17px]" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3.5">
        {hasDutyData ? (
          <>
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="font-mono text-label uppercase text-ink-subtle">
                  Before 45 min break
                </span>
                <span className="font-mono text-data-sm tabular text-ink">
                  {formatDuration(hours.secondsUntilBreak)}
                </span>
              </div>
              <DriverHoursBar
                secondsLeft={hours.secondsUntilBreak}
                limitSeconds={CONTINUOUS_DRIVING_LIMIT_S}
                level={hours.level}
              />
            </div>

            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-sm border border-hairline bg-surface-muted px-2 py-1.5">
                <dt className="font-mono text-label uppercase text-ink-subtle">
                  Left today
                </dt>
                <dd className="mt-0.5 font-mono text-data-sm tabular text-ink">
                  {formatDuration(hours.secondsUntilDailyLimit)}
                  <span className="ml-1 text-ink-subtle">
                    / {formatDuration(hours.dailyLimitSeconds)}
                  </span>
                </dd>
              </div>
              <div className="rounded-sm border border-hairline bg-surface-muted px-2 py-1.5">
                <dt className="font-mono text-label uppercase text-ink-subtle">
                  Left this week
                </dt>
                <dd className="mt-0.5 font-mono text-data-sm tabular text-ink">
                  {formatDuration(hours.secondsUntilWeeklyLimit)}
                  <span className="ml-1 text-ink-subtle">
                    / {formatDuration(WEEKLY_DRIVING_LIMIT_S)}
                  </span>
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="flex items-start gap-2 rounded-sm border border-hairline bg-surface-muted px-2.5 py-2 text-caption text-ink-muted">
            <Icon name="gavel" className="mt-px text-[15px] text-ink-subtle" />
            <span>
              No tachograph data. Driving time is unknown for this driver —
              not zero. Connect a tachograph feed before relying on hours.
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {hasDutyData ? (
            <DriverHoursBadge level={hours.level} label={hours.headline} />
          ) : null}
          {hasDutyData && hours.extensionAvailable ? (
            <Badge
              tone="neutral"
              title="Art. 6(1): 10 h days, at most twice in a fixed week"
            >
              {2 - driver.extended_days_this_week} × 10 h left
            </Badge>
          ) : hasDutyData ? (
            <Badge tone="warn" title="Both weekly 10 h extensions already used">
              Capped at 9 h
            </Badge>
          ) : null}
        </div>

        {assignment ? (
          <p className="flex items-center gap-1.5 text-caption text-ink-muted">
            <Icon name="route" className="text-[15px] text-ink-subtle" />
            <span className="font-mono text-data-sm text-ink">
              {assignment.reference}
            </span>
            {assignment.plate ? <>· {assignment.plate}</> : null}
          </p>
        ) : null}

        <div
          className={cx(
            "mt-auto flex items-start gap-1.5 rounded-sm border px-2.5 py-2 text-caption",
            cpc.level === "expired"
              ? "border-danger-border bg-danger-soft text-danger"
              : cpc.level === "expiring"
                ? "border-warn-border bg-warn-soft text-ink-muted"
                : "border-hairline bg-surface-muted text-ink-subtle",
          )}
        >
          <Icon
            name={cpc.level === "valid" ? "workspace_premium" : "warning"}
            className="mt-px text-[15px]"
          />
          <span>
            Driver CPC{" "}
            {driver.cpc_expires_on ? (
              <>
                {cpc.level === "expired" ? "expired" : "expires"}{" "}
                {formatDateFull(driver.cpc_expires_on)}
                {cpc.level === "expiring" ? ` · ${cpc.days} days` : null}
              </>
            ) : (
              "not recorded"
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

export function DriversPanel({
  drivers,
  trucks,
  assignments,
  now,
}: {
  drivers: Driver[];
  trucks: Truck[];
  assignments: Record<string, DriverAssignment>;
  now: Date;
}) {
  const withDuty = drivers.filter((d) => d.duty_synced_at !== null);
  const atRisk = withDuty.filter((d) => driverHours(d).level !== "ok").length;

  const cpcSoon = drivers.filter((d) => {
    const state = cpcState(d, now);
    return state.level === "expiring" || state.level === "expired";
  }).length;

  const router = useRouter();
  const [editing, setEditing] = useState<Driver | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Driver | null>(null);

  const driving = drivers.filter((d) => d.duty_status === "driving").length;
  const lastSync = drivers
    .map((d) => d.duty_synced_at)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Driving now"
          value={driving}
          hint="Tachograph reports the wheel turning"
          icon="directions_car"
          tone="brand"
        />
        <StatTile
          label="Hours attention"
          value={withDuty.length === 0 ? "—" : atRisk}
          hint={
            withDuty.length === 0
              ? "No tachograph feed connected"
              : "Break or daily limit close"
          }
          icon="gavel"
          tone={
            withDuty.length === 0 ? "neutral" : atRisk > 0 ? "danger" : "ok"
          }
        />
        <StatTile
          label="CPC attention"
          value={cpcSoon}
          hint="Expired or inside 90 days"
          icon="workspace_premium"
          tone={cpcSoon > 0 ? "warn" : "ok"}
        />
        <StatTile
          label="Tacho sync"
          value={lastSync ? relativeTime(lastSync, now) : "—"}
          hint="Last duty snapshot pulled"
          icon="sync"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 shadow-card">
        <Icon name="badge" className="text-[20px] text-ink-subtle" />
        <div className="min-w-0 flex-1">
          <p className="text-body-sm font-medium text-ink">
            Drivers are entered here, not synced
          </p>
          <p className="text-caption text-ink-muted">
            Reveal has no driver records for this fleet, so there is nothing to
            pull. Adding them here is what lets a load carry a named driver.
          </p>
        </div>
        <Button variant="primary" icon="person_add" onClick={() => setEditing(null)}>
          Add driver
        </Button>
      </div>

      {drivers.length === 0 ? (
        <Card>
          <EmptyState
            icon="badge"
            title="No drivers yet"
            description="Add your drivers with their tachograph card numbers. A load cannot show driving time, or send a route by SMS, without one."
          />
        </Card>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {drivers.map((driver) => (
            <li key={driver.id} className="flex">
              <DriverCard
                driver={driver}
                truck={
                  trucks.find((t) => t.id === driver.assigned_truck_id) ?? null
                }
                assignment={assignments[driver.id] ?? null}
                now={now}
                onEdit={() => setEditing(driver)}
                onDelete={() => setDeleting(driver)}
              />
            </li>
          ))}
        </ul>
      )}

      {editing !== undefined ? (
        <DriverEditor
          driver={editing}
          trucks={trucks}
          otherDrivers={drivers.filter((d) => d.id !== editing?.id)}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            router.refresh();
          }}
        />
      ) : null}

      {deleting ? (
        <DriverDeleteConfirm
          driver={deleting}
          assignment={assignments[deleting.id] ?? null}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      ) : null}

      <p className="mt-4 flex items-start gap-2 text-caption text-ink-subtle">
        <Icon name="gavel" className="mt-px text-[15px]" />
        Driving time and rest under Regulation (EC) No 561/2006 — 4h30 driving
        before a 45 min break, 9h a day (10h twice weekly), 56h a week. Retained
        in UK and NI law with the same figures. These counters are a planning
        aid; the tachograph record is the legal evidence.
      </p>
    </>
  );
}

function DriverDeleteConfirm({
  driver,
  assignment,
  onClose,
  onDeleted,
}: {
  driver: Driver;
  /** Current (not-yet-completed) load, if any — known from props, no extra fetch. */
  assignment: DriverAssignment;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${driver.full_name}`}
        className="fixed inset-x-4 top-[18vh] z-50 mx-auto max-w-md overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <div className="flex items-start gap-3 px-6 py-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
            <Icon name="delete" className="text-[20px]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-title text-ink">Delete {driver.full_name}?</h2>
            <p className="mt-1 text-body-sm text-ink-muted">
              {assignment
                ? `Currently on ${assignment.reference}${assignment.plate ? ` · ${assignment.plate}` : ""}. Reassign or remove them from that load first — a driver on a load cannot be deleted.`
                : "This cannot be undone. A driver with any load recorded against them — past or present — cannot be deleted; that record is who the CMR names and who the duty counters belong to."}
            </p>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="mx-6 mb-4 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
          >
            <Icon name="error" className="mt-px text-[17px]" />
            {error}
          </p>
        ) : null}

        <footer className="flex items-center gap-2 border-t border-hairline px-6 py-3">
          <Button onClick={onClose} className="mr-auto">
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={pending ? "progress_activity" : "delete"}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteDriver(driver.id);
                if (result.ok) {
                  onDeleted();
                } else {
                  setError(result.message ?? "Could not delete.");
                }
              })
            }
          >
            {pending ? "Deleting…" : "Delete driver"}
          </Button>
        </footer>
      </div>
    </>
  );
}
