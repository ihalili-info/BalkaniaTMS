"use client";

/**
 * Schematic fleet map.
 *
 * There is no tile provider wired up (no HERE key), so this projects
 * real coordinates onto a plain canvas rather than faking a basemap. The
 * projection is equirectangular in **kilometres**, which means the 5 km
 * geofence rings are drawn to true scale — the one thing a dispatcher has to
 * be able to trust here. Swapping in tiles later means replacing the `<svg>`
 * and keeping these overlays.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LoadStatusBadge,
  TruckDutyBadge,
  cx,
} from "@/components/ui";
import {
  GEOFENCE_RADIUS_M,
  activeOf,
  loadForTruck,
  loadProgress,
  nextStop,
  stopEtaMinutes,
} from "@/lib/fleet-selectors";
import { routeActiveLoad, type LoadRouteInfo } from "@/lib/data/mutations";
import { formatDuration } from "@/lib/driver-hours";
import { truckDuty, unavailabilityReason } from "@/lib/fleet-status";
import {
  formatClock,
  formatCoords,
  formatDistance,
  relativeTime,
} from "@/lib/format";
import { DEFAULT_VIEW, DEPOT, REFERENCE_PLACES } from "@/lib/geo/reference";
import type { LatLng, LoadView, Order, RouteLeg, Truck } from "@/lib/types";

import { HereCanvas } from "./here-canvas";

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLng = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
const GEOFENCE_KM = GEOFENCE_RADIUS_M / 1000;
const GRID_KM = 25;
/** The map panel is a wide letterbox; the fleet's bounds rarely are. */
const PANEL_ASPECT = 2;

type XY = { x: number; y: number };

export function FleetMap({
  trucks,
  loads,
  pendingOrders,
  now,
  hereMapsKey,
}: {
  trucks: Truck[];
  loads: LoadView[];
  /** CRM demand not yet on a load. Only the geocoded ones — see the page's caveat. */
  pendingOrders: Order[];
  now: Date;
  /** Absent → the schematic below, which is to scale but has no roads. */
  hereMapsKey: string | null;
}) {
  // Open on a truck that is actually on a load, so the route panel has
  // something to show; fall back to the first unit.
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      activeOf(loads).find((l) => l.truck_id !== null)?.truck_id ??
      trucks[0]?.id ??
      null,
  );

  const located = trucks.filter((t) => t.current_location !== null);
  const activeLoads = activeOf(loads);

  /**
   * Everything is derived inside the component now — with real data the fleet
   * moves, so the projection cannot be computed once at module scope.
   */
  const view = useMemo(() => {
    const points: LatLng[] = [
      { lat: DEPOT.lat, lng: DEPOT.lng },
      ...REFERENCE_PLACES.map((p) => ({ lat: p.lat, lng: p.lng })),
      ...located.map((t) => t.current_location!),
      ...activeOf(loads).flatMap((l) =>
        l.stops.flatMap((s) =>
          s.order.delivery_location ? [s.order.delivery_location] : [],
        ),
      ),
      ...pendingOrders.flatMap((o) =>
        o.delivery_location ? [o.delivery_location] : [],
      ),
    ];

    // An empty fleet still needs a sane frame rather than NaN bounds.
    if (points.length === 0) {
      points.push(DEFAULT_VIEW.centre);
    }

    const latMid = points.reduce((n, p) => n + p.lat, 0) / points.length;
    const origin = {
      lat: Math.max(...points.map((p) => p.lat)),
      lng: Math.min(...points.map((p) => p.lng)),
    };

    const project = (p: LatLng): XY => ({
      x: (p.lng - origin.lng) * kmPerDegLng(latMid),
      y: (origin.lat - p.lat) * KM_PER_DEG_LAT,
    });

    const xs = points.map((p) => project(p).x);
    const ys = points.map((p) => project(p).y);
    const pad = 14;
    let minX = Math.min(...xs) - pad;
    let maxX = Math.max(...xs) + pad;
    let minY = Math.min(...ys) - pad;
    let maxY = Math.max(...ys) + pad;

    // Guard against a single point, which would give a zero-width viewBox.
    if (maxX - minX < 40) {
      const c = (minX + maxX) / 2;
      minX = c - 20;
      maxX = c + 20;
    }
    if (maxY - minY < 40) {
      const c = (minY + maxY) / 2;
      minY = c - 20;
      maxY = c + 20;
    }

    // Widen to the panel's aspect. Only ever *adds* ground, so the km scale —
    // and therefore the geofence rings — is untouched.
    const wantedW = (maxY - minY) * PANEL_ASPECT;
    if (wantedW > maxX - minX) {
      const grow = (wantedW - (maxX - minX)) / 2;
      minX -= grow;
      maxX += grow;
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const marker = h * 0.02;

    const lines = (from: number, to: number) => {
      const out: number[] = [];
      for (let v = Math.ceil(from / GRID_KM) * GRID_KM; v <= to; v += GRID_KM) {
        out.push(v);
      }
      return out;
    };

    const depotXY = project({ lat: DEPOT.lat, lng: DEPOT.lng });

    return {
      project,
      minX,
      minY,
      w,
      h,
      marker,
      gridXs: lines(minX, maxX),
      gridYs: lines(minY, maxY),
      depotXY,
      places: REFERENCE_PLACES.map((p) => ({
        name: p.name,
        ...project({ lat: p.lat, lng: p.lng }),
      })).filter(
        (p) => Math.hypot(p.x - depotXY.x, p.y - depotXY.y) > 8,
      ),
    };
  }, [located, loads, pendingOrders]);

  const selected = trucks.find((t) => t.id === selectedId) ?? null;
  const selectedLoad = selected ? loadForTruck(loads, selected.id) : undefined;
  const selectedStop = selectedLoad ? nextStop(selectedLoad) : undefined;

  // Road figures for the selected load. Fetched when it is selected, not when
  // the page renders (every render bills routing), and remembered per load and
  // per set of delivered stops so switching back and forth costs nothing.
  const routeKey = selectedLoad
    ? `${selectedLoad.id}|${selectedLoad.stops
        .map((s) => (s.delivered_at ? "1" : "0"))
        .join("")}`
    : null;
  const [routes, setRoutes] = useState<Record<string, LoadRouteInfo>>({});
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedLoad || !routeKey) return;
    if (routeKey in routes || inflight.current.has(routeKey)) return;
    inflight.current.add(routeKey);
    void routeActiveLoad(selectedLoad.id)
      .then((info) => setRoutes((prev) => ({ ...prev, [routeKey]: info })))
      .finally(() => inflight.current.delete(routeKey));
  }, [selectedLoad, routeKey, routes]);
  const selectedRoute = routeKey ? (routes[routeKey] ?? null) : null;

  if (trucks.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="local_shipping"
          title="No trucks yet"
          description="Add trucks on the Fleet page with their Reveal Vehicle Number in the GPS device field. Positions appear here as soon as the webhook receives a fix."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader
          title="Fleet positions"
          hint={
            hereMapsKey
              ? "HERE basemap · 5 km geofence rings drawn on the sphere"
              : "Equirectangular schematic · geofence rings drawn to true 5 km scale"
          }
          actions={
            hereMapsKey ? (
              <Badge tone="ok" dot>
                HERE Maps
              </Badge>
            ) : (
              <Badge tone="warn" dot>
                No basemap
              </Badge>
            )
          }
        />

        <div className="relative bg-surface-muted">
          {located.length === 0 && pendingOrders.length === 0 ? (
            <EmptyState
              icon="satellite_alt"
              title="No positions yet"
              description="Every truck is waiting for its first GPS fix. Check that Vehicle Numbers are set in Reveal and that the webhook endpoint has been registered."
            />
          ) : hereMapsKey ? (
            <HereCanvas
              apiKey={hereMapsKey}
              trucks={trucks}
              loads={loads}
              pendingOrders={pendingOrders}
              selectedId={selectedId}
              onSelect={setSelectedId}
              heightClass="h-[26rem] sm:h-[34rem] xl:h-[42rem]"
            />
          ) : (
            <svg
              viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
              className="h-[26rem] w-full sm:h-[34rem] xl:h-[42rem]"
              role="img"
              aria-label="Schematic map of truck positions and delivery geofences"
            >
              <g>
                {view.gridXs.map((x) => (
                  <line
                    key={`x${x}`}
                    x1={x}
                    x2={x}
                    y1={view.minY}
                    y2={view.minY + view.h}
                    stroke="var(--color-hairline)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {view.gridYs.map((y) => (
                  <line
                    key={`y${y}`}
                    x1={view.minX}
                    x2={view.minX + view.w}
                    y1={y}
                    y2={y}
                    stroke="var(--color-hairline)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>

              {view.places.map((c) => (
                <g key={c.name}>
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={view.marker * 0.18}
                    fill="var(--color-ink-subtle)"
                  />
                  <text
                    x={c.x}
                    y={c.y + view.marker * 0.95}
                    textAnchor="middle"
                    className="fill-ink-subtle text-[5px]"
                  >
                    {c.name}
                  </text>
                </g>
              ))}

              <g>
                <rect
                  x={view.depotXY.x - view.marker * 0.45}
                  y={view.depotXY.y - view.marker * 0.45}
                  width={view.marker * 0.9}
                  height={view.marker * 0.9}
                  rx={view.marker * 0.15}
                  fill="var(--color-ink)"
                />
                <text
                  x={view.depotXY.x}
                  y={view.depotXY.y + view.marker * 1.35}
                  textAnchor="middle"
                  stroke="var(--color-surface-muted)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  vectorEffect="non-scaling-stroke"
                  className="fill-ink text-[5px] font-semibold"
                >
                  Depot
                </text>
              </g>

              <g>
                {pendingOrders.map((order) => {
                  if (!order.delivery_location) return null;
                  const at = view.project(order.delivery_location);
                  return (
                    <circle
                      key={order.id}
                      cx={at.x}
                      cy={at.y}
                      r={view.marker * 0.4}
                      fill="none"
                      stroke="var(--color-danger)"
                      strokeWidth={1.5}
                      strokeDasharray="2 2"
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>
                        {`${order.customer_name} — ${order.delivery_address} (pending, not yet on a load)`}
                      </title>
                    </circle>
                  );
                })}
              </g>

              <g>
                {activeOf(loads).flatMap((l) => {
                  const isSelected = l.truck_id === selectedId;
                  const next = nextStop(l);
                  const r = view.marker * (isSelected ? 0.55 : 0.4);
                  return l.stops.map((stop, i) => {
                    if (!stop.order.delivery_location) return null;
                    const at = view.project(stop.order.delivery_location);
                    const done = stop.delivered_at !== null;
                    const isNext = next?.id === stop.id;
                    return (
                      <g key={stop.id} opacity={isSelected || isNext ? 1 : 0.8}>
                        {isNext ? (
                          <circle
                            cx={at.x}
                            cy={at.y}
                            r={r * 1.35}
                            fill="none"
                            stroke="var(--color-warn)"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                          />
                        ) : null}
                        <circle
                          cx={at.x}
                          cy={at.y}
                          r={r}
                          fill={
                            done
                              ? "var(--color-ok)"
                              : isSelected
                                ? "var(--color-brand)"
                                : "var(--color-ink)"
                          }
                          stroke="var(--color-surface)"
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        >
                          <title>
                            {`${l.reference} · stop ${i + 1} — ${stop.order.customer_name} (${
                              done ? "delivered" : isNext ? "next" : "pending"
                            })`}
                          </title>
                        </circle>
                        <text
                          x={at.x}
                          y={at.y}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={r * 1.15}
                          fontWeight={700}
                          fill="#fff"
                          pointerEvents="none"
                        >
                          {done ? "\u2713" : i + 1}
                        </text>
                      </g>
                    );
                  });
                })}
              </g>

              {trucks.map((truck) => {
                if (!truck.current_location) return null;
                const at = view.project(truck.current_location);
                const load = loadForTruck(loads, truck.id);
                const stop = load ? nextStop(load) : undefined;
                const target = stop?.order.delivery_location
                  ? view.project(stop.order.delivery_location)
                  : null;
                const active = truck.id === selectedId;
                const inFence =
                  stop?.distance_m != null &&
                  stop.distance_m <= GEOFENCE_RADIUS_M;

                return (
                  <g key={truck.id}>
                    {target ? (
                      <>
                        <circle
                          cx={target.x}
                          cy={target.y}
                          r={GEOFENCE_KM}
                          fill={inFence ? "var(--color-warn)" : "var(--color-brand)"}
                          fillOpacity={active ? 0.14 : 0.07}
                          stroke={inFence ? "var(--color-warn)" : "var(--color-brand)"}
                          strokeOpacity={active ? 0.7 : 0.3}
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        />
                        <polyline
                          points={[
                            at,
                            ...(active && load
                              ? load.stops.flatMap((s) =>
                                  s.delivered_at === null &&
                                  s.order.delivery_location
                                    ? [view.project(s.order.delivery_location)]
                                    : [],
                                )
                              : [target]),
                          ]
                            .map((p) => `${p.x},${p.y}`)
                            .join(" ")}
                          fill="none"
                          stroke="var(--color-brand)"
                          strokeOpacity={active ? 0.8 : 0.25}
                          strokeWidth={2}
                          strokeDasharray="4 3"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      </>
                    ) : null}

                    <g
                      onClick={() => setSelectedId(truck.id)}
                      className="cursor-pointer"
                    >
                      <circle cx={at.x} cy={at.y} r={view.marker * 1.4} fill="transparent" />
                      {active ? (
                        <circle
                          cx={at.x}
                          cy={at.y}
                          r={view.marker * 1.05}
                          fill="var(--color-brand)"
                          fillOpacity={0.18}
                        />
                      ) : null}
                      <circle
                        cx={at.x}
                        cy={at.y}
                        r={view.marker * 0.55}
                        fill="var(--color-brand)"
                        stroke="var(--color-surface)"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={at.x}
                        y={at.y - view.marker * 0.95}
                        textAnchor="middle"
                        stroke="var(--color-surface-muted)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        vectorEffect="non-scaling-stroke"
                        className={cx(
                          "text-[5px]",
                          active ? "fill-ink font-semibold" : "fill-ink-muted",
                        )}
                      >
                        {truck.license_plate}
                      </text>
                    </g>
                  </g>
                );
              })}

              <g transform={`translate(${view.minX + 8} ${view.minY + view.h - 8})`}>
                <line
                  x1={0}
                  x2={GRID_KM}
                  y1={0}
                  y2={0}
                  stroke="var(--color-ink-muted)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                <text x={GRID_KM / 2} y={-3} textAnchor="middle" className="fill-ink-muted text-[5px]">
                  25 km
                </text>
              </g>
            </svg>
          )}

          {located.length > 0 || pendingOrders.length > 0 ? (
            <ul className="pointer-events-none absolute bottom-3 right-3 z-10 space-y-1 rounded-sm border border-hairline bg-surface/90 px-3 py-2 backdrop-blur-sm">
              {[
                { color: "var(--color-brand)", label: "Truck / route leg", hollow: false },
                { color: "var(--color-warn)", label: "Inside 5 km geofence", hollow: false },
                { color: "var(--color-ok)", label: "Delivered stop", hollow: false },
                {
                  color: "var(--color-ink)",
                  label: "Pending stop (numbered) / depot",
                  hollow: false,
                },
                {
                  color: "var(--color-danger)",
                  label: "Pending order, not yet on a load",
                  hollow: true,
                },
              ].map((l) => (
                <li key={l.label} className="flex items-center gap-2 text-caption text-ink-muted">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={
                      l.hollow
                        ? {
                            border: `1.5px dashed ${l.color}`,
                            background: "transparent",
                          }
                        : { background: l.color }
                    }
                  />
                  {l.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      {/* The fleet detail sits under the wide map — Active loads, Units and the
          selected truck side by side from lg up, stacked below it. */}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Active loads"
            hint={`${activeLoads.length} in progress`}
          />
          {activeLoads.length === 0 ? (
            <EmptyState
              icon="route"
              title="No active loads"
              description="Loads appear here once a driver departs on one."
            />
          ) : (
            <ul className="max-h-[26rem] divide-y divide-hairline overflow-y-auto">
              {activeLoads.map((load) => {
                const stop = nextStop(load);
                const truckId = load.truck_id;
                const selectable = truckId !== null;
                const isSelected = selectable && truckId === selectedId;
                const progress = loadProgress(load);
                return (
                  <li key={load.id}>
                    <button
                      type="button"
                      disabled={!selectable}
                      onClick={() => truckId && setSelectedId(truckId)}
                      aria-pressed={selectable && truckId === selectedId}
                      className={cx(
                        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                        selectable && truckId === selectedId
                          ? "bg-brand-soft"
                          : selectable
                            ? "hover:bg-surface-muted"
                            : "cursor-not-allowed opacity-60",
                      )}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
                        <Icon name="location_on" filled className="text-[17px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-data-sm font-medium text-ink">
                          {load.reference}
                        </span>
                        <span className="block truncate text-caption text-ink-subtle">
                          {stop
                            ? `${stop.order.customer_name} · ${load.driver?.full_name ?? "no driver"}`
                            : "No stops remaining"}
                        </span>
                        <span className="mt-1.5 flex items-center gap-1.5">
                          <span
                            className="flex items-center gap-0.5"
                            aria-hidden="true"
                          >
                            {load.stops.map((s) => (
                              <span
                                key={s.id}
                                className={cx(
                                  "size-1.5 rounded-full",
                                  s.delivered_at
                                    ? "bg-ok"
                                    : s.id === stop?.id
                                      ? "bg-warn"
                                      : "bg-hairline-strong",
                                )}
                              />
                            ))}
                          </span>
                          <span className="font-mono text-label tabular text-ink-subtle">
                            {progress.done}/{progress.total} delivered
                          </span>
                        </span>
                      </span>
                      {stop?.distance_m != null ? (
                        <span className="shrink-0 font-mono text-data-sm tabular text-ink-muted">
                          {formatDistance(stop.distance_m)}
                        </span>
                      ) : (
                        <LoadStatusBadge status={load.status} />
                      )}
                    </button>
                    {isSelected ? (
                      <LoadDetail load={load} route={selectedRoute} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Units"
            hint={`${located.length} of ${trucks.length} reporting`}
          />
          <ul className="max-h-[26rem] divide-y divide-hairline overflow-y-auto">
            {trucks.map((truck) => {
              const load = loadForTruck(loads, truck.id);
              const stop = load ? nextStop(load) : undefined;
              const offline = truck.current_location === null;
              return (
                <li key={truck.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(truck.id)}
                    aria-pressed={truck.id === selectedId}
                    className={cx(
                      "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                      truck.id === selectedId ? "bg-brand-soft" : "hover:bg-surface-muted",
                    )}
                  >
                    <span
                      className={cx(
                        "flex size-8 shrink-0 items-center justify-center rounded-md",
                        offline
                          ? "bg-surface-sunken text-ink-subtle"
                          : "bg-brand text-ink-inverse",
                      )}
                    >
                      <Icon name="local_shipping" filled className="text-[17px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-data-sm font-medium text-ink">
                        {truck.license_plate}
                      </span>
                      <span className="block truncate text-caption text-ink-subtle">
                        {unavailabilityReason(truck) ??
                          (offline
                            ? `No fix · ${relativeTime(truck.location_updated_at, now)}`
                            : load
                              ? `${load.reference} · ${load.driver?.full_name ?? "no driver"}`
                              : "Idle · available")}
                      </span>
                    </span>
                    {stop?.distance_m != null ? (
                      <span className="shrink-0 font-mono text-data-sm tabular text-ink-muted">
                        {formatDistance(stop.distance_m)}
                      </span>
                    ) : (
                      <TruckDutyBadge duty={truckDuty(truck, load != null)} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {selected ? (
          <Card>
            <CardHeader
              title={selected.license_plate}
              hint={selected.gps_device_id}
            />
            <dl className="divide-y divide-hairline">
              {[
                {
                  term: "Position",
                  value:
                    selected.last_known_address ??
                    formatCoords(selected.current_location),
                  mono: selected.last_known_address === null,
                },
                {
                  term: "Last fix",
                  value: relativeTime(selected.location_updated_at, now),
                },
                { term: "Load", value: selectedLoad?.reference ?? "—", mono: true },
                { term: "Driver", value: selectedLoad?.driver?.full_name ?? "—" },
                {
                  term: "Tacho card",
                  value: selectedLoad?.driver?.tachograph_card_no ?? "—",
                  mono: true,
                },
                {
                  term: "Next stop",
                  value: selectedStop?.order.customer_name ?? "—",
                },
                {
                  term: "Distance",
                  value: formatDistance(selectedStop?.distance_m ?? null),
                  mono: true,
                },
                {
                  term:
                    selectedStop?.eta_source === "routed" ? "ETA by road" : "Rough ETA",
                  value: (() => {
                    if (!selectedStop) return "—";
                    const eta = stopEtaMinutes(selectedStop);
                    if (eta === null) return "—";
                    return selectedStop.eta_source === "routed"
                      ? `${eta} min`
                      : `~${eta} min`;
                  })(),
                },
              ].map((row) => (
                <div
                  key={row.term}
                  className="flex items-baseline justify-between gap-3 px-4 py-2"
                >
                  <dt className="font-mono text-label uppercase text-ink-subtle">
                    {row.term}
                  </dt>
                  <dd
                    className={cx(
                      "truncate text-body-sm text-ink",
                      row.mono && "font-mono text-data-sm",
                    )}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3">
              <TruckDutyBadge duty={truckDuty(selected, selectedLoad != null)} />
              {selectedLoad ? <LoadStatusBadge status={selectedLoad.status} /> : null}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

const kmOf = (leg: RouteLeg) => `${Math.round(leg.distanceMeters / 1000)} km`;

/**
 * One load, opened up: road figures for the run, then every stop with its
 * state — delivered (with the time), next, or still pending.
 */
function LoadDetail({
  load,
  route,
}: {
  load: LoadView;
  route: LoadRouteInfo | null;
}) {
  const next = nextStop(load);
  return (
    <div className="border-t border-hairline bg-surface-muted/60 px-4 py-3">
      <dl className="grid grid-cols-2 gap-3">
        <RouteFigure
          label="Whole run"
          hint="depot, every stop, back"
          leg={route?.planned ?? null}
          loading={route === null}
        />
        <RouteFigure
          label="Remaining"
          hint="truck now, stops left, back"
          leg={route?.remaining ?? null}
          loading={route === null}
        />
      </dl>
      {route && !route.routed ? (
        <p className="mt-2 text-caption text-ink-subtle">
          {route.message ??
            "Road routing is not configured, so there is no distance or driving time for this load."}
        </p>
      ) : route?.message ? (
        <p className="mt-2 text-caption text-warn">{route.message}</p>
      ) : route ? (
        <p className="mt-2 text-caption text-ink-subtle">
          Driving time by road for this truck, without live traffic — it leaves
          out unloading and the driver&rsquo;s breaks.
        </p>
      ) : null}

      <ol className="mt-3 space-y-1">
        {load.stops.map((stop, i) => {
          const done = stop.delivered_at !== null;
          const isNext = stop.id === next?.id;
          const eta = isNext ? stopEtaMinutes(stop) : null;
          return (
            <li
              key={stop.id}
              className={cx(
                "flex items-center gap-2 rounded-sm px-2 py-1.5",
                isNext && "bg-surface ring-1 ring-warn-border",
              )}
            >
              {done ? (
                <Icon name="check_circle" filled className="text-[20px] text-ok" />
              ) : (
                <span
                  className={cx(
                    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-label text-ink-inverse",
                    isNext ? "bg-warn" : "bg-ink-subtle",
                  )}
                >
                  {i + 1}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={cx(
                    "block truncate text-body-sm",
                    done ? "text-ink-muted" : "text-ink",
                  )}
                >
                  {stop.order.customer_name}
                </span>
                <span className="block truncate text-caption text-ink-subtle">
                  {stop.order.delivery_address}
                </span>
              </span>
              <span className="shrink-0 text-right text-caption text-ink-subtle">
                {done ? (
                  <>
                    <span className="block font-medium text-ok">Delivered</span>
                    {stop.delivered_at
                      ? `${formatClock(stop.delivered_at)} UTC`
                      : null}
                  </>
                ) : isNext ? (
                  <>
                    <span className="block font-medium text-warn">Next</span>
                    {eta !== null
                      ? `${stop.eta_source === "routed" ? "" : "~"}${eta} min`
                      : "no fix"}
                  </>
                ) : (
                  "Pending"
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function RouteFigure({
  label,
  hint,
  leg,
  loading,
}: {
  label: string;
  hint: string;
  leg: RouteLeg | null;
  loading: boolean;
}) {
  return (
    <div>
      <dt className="font-mono text-label uppercase text-ink-subtle">{label}</dt>
      <dd className="text-heading tabular text-ink">
        {leg ? (
          <>
            {kmOf(leg)}
            <span className="mx-1 text-ink-subtle">·</span>
            {formatDuration(leg.durationSeconds)}
          </>
        ) : loading ? (
          <span className="text-ink-subtle">…</span>
        ) : (
          <span className="text-ink-subtle">—</span>
        )}
      </dd>
      <dd className="text-caption text-ink-subtle">{hint}</dd>
    </div>
  );
}
