"use client";

import {
  Badge,
  Card,
  CountryChip,
  DriverHoursBadge,
  DriverHoursBar,
  Icon,
  StatTile,
  cx,
} from "@/components/ui";
import { DEMO_NOW } from "@/lib/demo/fleet";
import {
  CONTINUOUS_DRIVING_LIMIT_S,
  DUTY_STATUS_LABEL,
  WEEKLY_DRIVING_LIMIT_S,
  driverHours,
  formatDuration,
} from "@/lib/driver-hours";
import { formatDateFull, relativeTime } from "@/lib/format";
import type { Driver } from "@/lib/types";

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
  assignment,
}: {
  driver: Driver;
  assignment: DriverAssignment;
}) {
  const hours = driverHours(driver);
  const cpc = cpcState(driver, DEMO_NOW);

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
          <p className="truncate font-mono text-data-sm text-ink-subtle">
            {driver.tachograph_card_no ?? "no tacho card"}
          </p>
        </div>
        <Badge tone={driver.duty_status === "driving" ? "brand" : "neutral"} dot>
          {DUTY_STATUS_LABEL[driver.duty_status]}
        </Badge>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 py-3.5">
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

        <div className="flex flex-wrap items-center gap-1.5">
          <DriverHoursBadge level={hours.level} label={hours.headline} />
          {hours.extensionAvailable ? (
            <Badge
              tone="neutral"
              title="Art. 6(1): 10 h days, at most twice in a fixed week"
            >
              {2 - driver.extended_days_this_week} × 10 h left
            </Badge>
          ) : (
            <Badge tone="warn" title="Both weekly 10 h extensions already used">
              Capped at 9 h
            </Badge>
          )}
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
  assignments,
}: {
  drivers: Driver[];
  assignments: Record<string, DriverAssignment>;
}) {
  const atRisk = drivers.filter((d) => driverHours(d).level !== "ok").length;

  const cpcSoon = drivers.filter((d) => {
    const state = cpcState(d, DEMO_NOW);
    return state.level === "expiring" || state.level === "expired";
  }).length;

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
          value={atRisk}
          hint="Break or daily limit close"
          icon="gavel"
          tone={atRisk > 0 ? "danger" : "ok"}
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
          value={lastSync ? relativeTime(lastSync, DEMO_NOW) : "—"}
          hint="Last duty snapshot pulled"
          icon="sync"
        />
      </div>

      <ul className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {drivers.map((driver) => (
          <li key={driver.id} className="flex">
            <DriverCard
              driver={driver}
              assignment={assignments[driver.id] ?? null}
            />
          </li>
        ))}
      </ul>

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
