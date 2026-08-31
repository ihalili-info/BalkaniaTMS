import type { Metadata } from "next";

import {
  Badge,
  Card,
  CardHeader,
  CustomsBadge,
  EmptyState,
  DriverHoursBadge,
  DriverHoursBar,
  Icon,
  LoadStatusBadge,
  NOTIFICATION_ICON,
  NOTIFICATION_LABEL,
  Page,
  PageHeader,
  Progress,
  StatTile,
  cx,
} from "@/components/ui";
import {
  GEOFENCE_RADIUS_M,
  activeOf,
  getDrivers,
  getLoads,
  getOrders,
  getRecentAlerts,
  getTrucks,
  isApproaching,
  loadProgress,
  plannedOf,
  recentlyCompletedOf,
  stopEtaMinutes,
  stopsInGeofence,
} from "@/lib/data/fleet";
import {
  CONTINUOUS_DRIVING_LIMIT_S,
  canDriveFor,
  driverHours,
  formatDuration,
} from "@/lib/driver-hours";
import { formatDistance, relativeTime } from "@/lib/format";
import {
  NAV_TARGETS,
  navigationUrl,
  type NavApp,
} from "@/lib/navigation-links";
import { CUSTOMS_REGIME } from "@/lib/regions";

import { geocodingConfigured } from "@/lib/geocoding/google";
import { googleMapsKey } from "@/lib/maps.server";

import { DispatchActions } from "./dispatch-actions";
import { LoadMenu } from "./load-menu";
import { StartLoadButton } from "./start-load";
import { MarkDeliveredButton, UndeliverButton } from "./stop-delivery";
import { RouteActions, StopNavMenu } from "./route-actions";
import type { Driver, LatLng, LoadView, Order, Stop, Truck } from "@/lib/types";

export const metadata: Metadata = { title: "Active Loads" };

const NAV_ORDER: NavApp[] = ["google", "waze", "apple"];

function StopRow({
  stop,
  isNext,
  isLast,
  loadActive,
  hoursWarning,
  origin,
  now,
}: {
  stop: Stop;
  isNext: boolean;
  isLast: boolean;
  /** The load is on the road — enables the manual delivered / undo controls. */
  loadActive: boolean;
  /** Set when Reg. 561/2006 says the driver cannot legally reach this stop. */
  hoursWarning?: string | null;
  /** Truck position, so a single-stop link starts from where it actually is. */
  origin: LatLng | null;
  now: Date;
}) {
  const navLinks = NAV_ORDER.map((app) => ({
    id: app,
    label: NAV_TARGETS[app].label,
    icon: NAV_TARGETS[app].icon,
    url: stop.order.delivery_location
      ? navigationUrl(app, {
          origin,
          stops: [stop.order.delivery_location],
        })
      : null,
  }));

  const delivered = stop.delivered_at !== null;
  const approaching = !delivered && isApproaching(stop);
  const eta = stopEtaMinutes(stop);
  const routed = stop.eta_source === "routed";

  return (
    <li className="relative flex gap-3 px-5 py-2.5">
      {/* Sequence rail — the stop_sequence column, drawn as a timeline. The
          connector is absolute so it bridges the row padding and reaches the
          next badge; a flex-1 span inside the row stops at the row's edge and
          leaves a broken, barely visible dash. */}
      {isLast ? null : (
        <span className="absolute -bottom-2.5 left-8 top-[2.125rem] w-px -translate-x-1/2 bg-hairline-strong" />
      )}
      <div className="flex flex-col items-center">
        <span
          className={cx(
            "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-label",
            delivered
              ? "border-ok bg-ok text-ink-inverse"
              : isNext
                ? "border-brand bg-brand text-ink-inverse"
                : "border-hairline-strong bg-surface text-ink-subtle",
          )}
        >
          {delivered ? <Icon name="check" className="text-[14px]" /> : stop.stop_sequence}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cx(
              "truncate text-body-sm font-medium",
              delivered ? "text-ink-subtle line-through" : "text-ink",
            )}
          >
            {stop.order.customer_name}
          </span>
          <span className="font-mono text-data-sm text-ink-subtle">
            {stop.order.crm_order_id}
          </span>
          {approaching ? (
            <Badge tone="warn" dot pulse>
              {routed && eta !== null
                ? `Approaching · ${eta} min`
                : `Within ${GEOFENCE_RADIUS_M / 1000} km`}
            </Badge>
          ) : null}
          {stop.order.notifications_opt_out ? (
            <Badge tone="neutral" title="Customer replied STOP — no alerts may be sent">
              <Icon name="notifications_off" className="text-[13px]" />
              No alerts
            </Badge>
          ) : null}
        </div>
        <p className="truncate text-caption text-ink-subtle">
          {stop.order.delivery_address}
          {stop.order.delivery_postcode ? (
            <span className="ml-1.5 font-mono text-data-sm">
              {stop.order.delivery_postcode}
            </span>
          ) : null}
        </p>
        {hoursWarning ? (
          <p className="mt-1 inline-flex items-center gap-1 rounded-xs bg-danger-soft px-1.5 py-0.5 text-caption text-danger">
            <Icon name="gavel" className="text-[13px]" />
            {hoursWarning}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <div className="text-right">
          {delivered ? (
            <>
              <p className="text-body-sm text-ok">Delivered</p>
              <p className="text-caption text-ink-subtle">
                {relativeTime(stop.delivered_at!, now)}
              </p>
            </>
          ) : (
            <>
              <p className="font-mono text-data-sm tabular text-ink">
                {formatDistance(stop.distance_m)}
              </p>
              <p
                className="text-caption text-ink-subtle"
                title={
                  routed
                    ? "Road drive-time from the truck's current position (Google Routes, live traffic)"
                    : "Straight-line estimate at 45 km/h — a display stand-in, not alert-grade"
                }
              >
                {eta === null
                  ? "no fix"
                  : routed
                    ? `${eta} min by road`
                    : `~${eta} min`}
              </p>
            </>
          )}
          </div>
          {delivered ? null : (
            <StopNavMenu links={navLinks} label={stop.order.customer_name} />
          )}
        </div>
        {loadActive && delivered && !stop.notifications.includes("delivery_complete") ? (
          <UndeliverButton loadItemId={stop.id} />
        ) : null}
        {loadActive && !delivered && isNext ? (
          <MarkDeliveredButton loadItemId={stop.id} />
        ) : null}
      </div>
    </li>
  );
}

function LoadCard({
  load,
  now,
  trucks,
  drivers,
  unassignedOrders,
}: {
  load: LoadView;
  now: Date;
  trucks: Truck[];
  drivers: Driver[];
  unassignedOrders: Order[];
}) {
  const { done, total } = loadProgress(load);
  const nextIndex = load.stops.findIndex((s) => s.delivered_at === null);

  const hasDutyData = load.driver?.duty_synced_at != null;
  const hours = load.driver && hasDutyData ? driverHours(load.driver) : null;
  const nextStop = nextIndex === -1 ? null : load.stops[nextIndex];
  // Can this driver legally still reach the next drop? Uses the routed
  // drive-time when there is one, the straight-line stand-in otherwise —
  // either way a planning aid, the tachograph remains the legal record.
  const reach =
    hours && nextStop
      ? canDriveFor(hours, stopEtaMinutes(nextStop))
      : { ok: true, reason: null };
  const paperwork = CUSTOMS_REGIME[load.customs_regime].paperwork;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-soft text-brand">
            <Icon name="local_shipping" filled className="text-[20px]" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-heading text-ink">{load.reference}</h3>
              <LoadStatusBadge status={load.status} />
              <CustomsBadge regime={load.customs_regime} />
            </div>
            <p className="text-caption text-ink-subtle">
              {load.truck?.license_plate ?? "unassigned"} ·{" "}
              {load.driver?.full_name ?? "no driver"}
              {load.truck ? (
                <> · GPS {relativeTime(load.truck.location_updated_at, now)}</>
              ) : null}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-32">
            <div className="mb-1 flex justify-between font-mono text-label uppercase text-ink-subtle">
              <span>Stops</span>
              <span className="tabular text-ink">
                {done}/{total}
              </span>
            </div>
            <Progress value={done} max={total} tone={done === total ? "ok" : "brand"} />
          </div>
          <RouteActions load={load} />
          <LoadMenu
            load={load}
            trucks={trucks}
            drivers={drivers}
            unassignedOrders={unassignedOrders}
          />
        </div>
      </div>

      {load.driver ? (
        hours ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline bg-surface-muted px-5 py-2.5">
          <div className="flex items-center gap-2">
            <Icon name="badge" className="text-[17px] text-ink-subtle" />
            <span className="text-body-sm text-ink">{load.driver.full_name}</span>
            <span className="font-mono text-data-sm text-ink-subtle">
              {load.driver.tachograph_card_no}
            </span>
          </div>

          <div className="min-w-[11rem] flex-1">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="font-mono text-label uppercase text-ink-subtle">
                Driving before break
              </span>
              <span className="font-mono text-data-sm tabular text-ink">
                {formatDuration(hours.secondsUntilBreak)} left
              </span>
            </div>
            <DriverHoursBar
              secondsLeft={hours.secondsUntilBreak}
              limitSeconds={CONTINUOUS_DRIVING_LIMIT_S}
              level={hours.level}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-label uppercase text-ink-subtle">
              Today
            </span>
            <span className="font-mono text-data-sm tabular text-ink">
              {formatDuration(hours.secondsUntilDailyLimit)} of{" "}
              {formatDuration(hours.dailyLimitSeconds)}
            </span>
          </div>

          <DriverHoursBadge level={hours.level} label={hours.headline} />
        </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-muted px-5 py-2.5">
            <Icon name="badge" className="text-[17px] text-ink-subtle" />
            <span className="text-body-sm text-ink">{load.driver.full_name}</span>
            <span className="font-mono text-data-sm text-ink-subtle">
              {load.driver.tachograph_card_no ?? "no tacho card"}
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-caption text-ink-subtle">
              <Icon name="gavel" className="text-[15px]" />
              Driving time unknown — no tachograph feed
            </span>
          </div>
        )
      ) : null}

      {paperwork.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-5 py-2">
          <Icon name="description" className="text-[16px] text-ink-subtle" />
          <span className="font-mono text-label uppercase text-ink-subtle">
            Paperwork
          </span>
          {paperwork.map((doc) => (
            <Badge key={doc} tone="neutral">
              {doc}
            </Badge>
          ))}
          {load.cmr_number ? (
            <span className="font-mono text-data-sm text-ink-muted">
              {load.cmr_number}
            </span>
          ) : null}
        </div>
      ) : null}

      <ul>
        {load.stops.map((stop, i) => (
          <StopRow
            key={stop.id}
            stop={stop}
            isNext={i === nextIndex}
            isLast={i === load.stops.length - 1}
            loadActive={load.status === "active"}
            now={now}
            hoursWarning={i === nextIndex && !reach.ok ? reach.reason : null}
            origin={load.truck?.current_location ?? null}
          />
        ))}
      </ul>
    </Card>
  );
}

export default async function ActiveLoadsPage() {
  const now = new Date();
  const loads = await getLoads({ routedEtas: true });
  const activeLoads = activeOf(loads);
  const plannedLoads = plannedOf(loads);
  const completedLoads = recentlyCompletedOf(loads, now);
  const alertLog = await getRecentAlerts(loads);
  const [trucks, drivers, orders] = await Promise.all([
    getTrucks(),
    getDrivers(),
    getOrders(),
  ]);
  const onALoad = new Set(loads.flatMap((l) => l.stops.map((s) => s.order_id)));
  const unassignedOrders = orders.filter((o) => !onALoad.has(o.id));

  const stopsRemaining = activeLoads.reduce(
    (n, l) => n + l.stops.filter((s) => s.delivered_at === null).length,
    0,
  );
  const inGeofence = stopsInGeofence(loads);
  const midnight = now.toISOString().slice(0, 10);
  const alertsToday = alertLog.filter((a) => a.sent_at >= midnight);
  // Only drivers with a real tachograph reading can be judged against a limit.
  const loadsWithDuty = activeLoads.filter(
    (l) => l.driver !== null && l.driver.duty_synced_at !== null,
  );
  const hoursAtRisk = loadsWithDuty.filter(
    (l) => driverHours(l.driver!).level !== "ok",
  ).length;
  const crossBorderLoads = activeLoads.filter(
    (l) => l.customs_regime !== "domestic",
  ).length;

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Active Loads"
        description={`Every load on the road, its stop sequence, driving time left under Reg. 561/2006, and how close each truck is to its next drop. ${crossBorderLoads} of ${activeLoads.length} are cross-border.`}
        actions={
          <DispatchActions
            trucks={trucks}
            drivers={drivers}
            unassignedOrders={unassignedOrders}
            geocodingReady={geocodingConfigured()}
            mapsKey={googleMapsKey()}
          />
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-5">
        <StatTile
          label="Active loads"
          value={activeLoads.length}
          hint={`${plannedLoads.length} planned for later today`}
          icon="local_shipping"
          tone="brand"
        />
        <StatTile
          label="Stops remaining"
          value={stopsRemaining}
          hint="Across all active loads"
          icon="pin_drop"
        />
        <StatTile
          label="Inside geofence"
          value={inGeofence.length}
          unit={`/ ${GEOFENCE_RADIUS_M / 1000} km`}
          hint="Proximity alert has fired"
          icon="my_location"
          tone="warn"
        />
        <StatTile
          label="Alerts sent today"
          value={alertsToday.length}
          hint="SMS and WhatsApp, via Sent"
          icon="forum"
          tone="ok"
        />
        <StatTile
          label="Hours attention"
          value={loadsWithDuty.length === 0 ? "—" : hoursAtRisk}
          hint={
            loadsWithDuty.length === 0
              ? "No tachograph feed connected"
              : hoursAtRisk === 0
                ? "All drivers clear under Reg. 561/2006"
                : "Break or daily limit close"
          }
          icon="gavel"
          tone={
            loadsWithDuty.length === 0
              ? "neutral"
              : hoursAtRisk > 0
                ? "danger"
                : "ok"
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {plannedLoads.length > 0 ? (
            <Card>
              <CardHeader
                title="Planned"
                hint="Not on the road yet — start a load when the truck leaves"
              />
              <ul className="divide-y divide-hairline">
                {plannedLoads.map((load) => (
                  <li
                    key={load.id}
                    className="flex flex-wrap items-center gap-3 px-5 py-3"
                  >
                    <Icon
                      name="schedule"
                      className="text-[18px] text-ink-subtle"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-body-sm text-ink">
                          {load.reference}
                        </span>
                        <CustomsBadge regime={load.customs_regime} />
                      </span>
                      <span className="block truncate text-caption text-ink-subtle">
                        {load.truck?.license_plate ?? "no truck"} ·{" "}
                        {load.driver?.full_name ?? "no driver"} ·{" "}
                        {load.stops.length} stop
                        {load.stops.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <StartLoadButton loadId={load.id} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {activeLoads.length === 0 &&
          plannedLoads.length === 0 &&
          completedLoads.length === 0 ? (
            <Card>
              <EmptyState
                icon="local_shipping"
                title="Nothing on the road"
                description="Plan a load from the orders waiting in the queue. Pick a truck, choose the stops, set their order — that is the route the driver runs."
              />
            </Card>
          ) : null}

          {activeLoads.map((load) => (
            <LoadCard
              key={load.id}
              load={load}
              now={now}
              trucks={trucks}
              drivers={drivers}
              unassignedOrders={unassignedOrders}
            />
          ))}

          {completedLoads.length > 0 ? (
            <details className="group">
              <summary className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-2 text-body-sm text-ink-muted hover:text-ink">
                <Icon
                  name="expand_more"
                  className="text-[18px] transition-transform group-open:rotate-180"
                />
                Completed in the last 24 hours ({completedLoads.length})
              </summary>
              <div className="mt-2 space-y-4">
                {completedLoads.map((load) => (
                  <LoadCard
                    key={load.id}
                    load={load}
                    now={now}
                    trucks={trucks}
                    drivers={drivers}
                    unassignedOrders={unassignedOrders}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>

        <Card className="xl:sticky xl:top-[calc(var(--spacing-topbar)+1.5rem)] xl:self-start">
          <CardHeader
            title="Live event log"
            hint="Customer alerts, newest first"
            actions={
              <Badge tone="ok" dot pulse>
                Live
              </Badge>
            }
          />
          <ul className="max-h-[36rem] divide-y divide-hairline overflow-y-auto">
            {alertLog.slice(0, 16).map((event) => (
              <li key={event.id} className="flex gap-3 px-5 py-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-muted text-ink-muted">
                  <Icon
                    name={NOTIFICATION_ICON[event.type]}
                    className="text-[16px]"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-ink">
                    {NOTIFICATION_LABEL[event.type]}
                  </p>
                  <p className="truncate text-caption text-ink-subtle">
                    {event.order.customer_name} · {event.order.customer_phone}
                  </p>
                  <p className="mt-0.5 font-mono text-data-sm text-ink-subtle">
                    {event.load_reference} · {event.license_plate ?? "—"}
                  </p>
                </div>
                <span className="shrink-0 whitespace-nowrap text-caption text-ink-subtle">
                  {relativeTime(event.sent_at, now)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Page>
  );
}
