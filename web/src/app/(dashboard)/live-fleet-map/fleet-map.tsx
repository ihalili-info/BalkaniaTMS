"use client";

/**
 * Schematic fleet map.
 *
 * There is no tile provider wired up (no Mapbox/Google key), so this projects
 * real coordinates onto a plain canvas rather than faking a basemap. The
 * projection is equirectangular in **kilometres**, which means the 5 km
 * geofence rings are drawn to true scale — the one thing a dispatcher has to
 * be able to trust here. Swapping in tiles later means replacing the `<svg>`
 * and keeping these overlays.
 */

import { useMemo, useState } from "react";

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
  loadForTruck,
  nextStop,
} from "@/lib/fleet-selectors";
import { truckDuty, unavailabilityReason } from "@/lib/fleet-status";
import {
  estimateMinutes,
  formatCoords,
  formatDistance,
  relativeTime,
} from "@/lib/format";
import { DEFAULT_VIEW, DEPOT, REFERENCE_PLACES } from "@/lib/geo/reference";
import type { LatLng, LoadView, Truck } from "@/lib/types";

import { GoogleCanvas } from "./google-canvas";

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
  now,
  googleMapsKey,
}: {
  trucks: Truck[];
  loads: LoadView[];
  now: Date;
  /** Absent → the schematic below, which is to scale but has no roads. */
  googleMapsKey: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    trucks[0]?.id ?? null,
  );

  const located = trucks.filter((t) => t.current_location !== null);

  /**
   * Everything is derived inside the component now — with real data the fleet
   * moves, so the projection cannot be computed once at module scope.
   */
  const view = useMemo(() => {
    const points: LatLng[] = [
      { lat: DEPOT.lat, lng: DEPOT.lng },
      ...REFERENCE_PLACES.map((p) => ({ lat: p.lat, lng: p.lng })),
      ...located.map((t) => t.current_location!),
      ...loads.flatMap((l) => {
        const stop = nextStop(l);
        return stop?.order.delivery_location ? [stop.order.delivery_location] : [];
      }),
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
  }, [located, loads]);

  const selected = trucks.find((t) => t.id === selectedId) ?? null;
  const selectedLoad = selected ? loadForTruck(loads, selected.id) : undefined;
  const selectedStop = selectedLoad ? nextStop(selectedLoad) : undefined;

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
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_20rem]">
      <Card className="overflow-hidden">
        <CardHeader
          title="Fleet positions"
          hint={
            googleMapsKey
              ? "Google basemap · 5 km geofence rings drawn on the sphere"
              : "Equirectangular schematic · geofence rings drawn to true 5 km scale"
          }
          actions={
            googleMapsKey ? (
              <Badge tone="ok" dot>
                Google Maps
              </Badge>
            ) : (
              <Badge tone="warn" dot>
                No basemap
              </Badge>
            )
          }
        />

        <div className="relative bg-surface-muted">
          {located.length === 0 ? (
            <EmptyState
              icon="satellite_alt"
              title="No positions yet"
              description="Every truck is waiting for its first GPS fix. Check that Vehicle Numbers are set in Reveal and that the webhook endpoint has been registered."
            />
          ) : googleMapsKey ? (
            <GoogleCanvas
              apiKey={googleMapsKey}
              trucks={trucks}
              loads={loads}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : (
            <svg
              viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
              className="h-[30rem] w-full"
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
                        <line
                          x1={at.x}
                          y1={at.y}
                          x2={target.x}
                          y2={target.y}
                          stroke="var(--color-brand)"
                          strokeOpacity={active ? 0.8 : 0.25}
                          strokeWidth={2}
                          strokeDasharray="4 3"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                        <circle
                          cx={target.x}
                          cy={target.y}
                          r={view.marker * 0.22}
                          fill="var(--color-ink)"
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

          {located.length > 0 ? (
            <ul className="pointer-events-none absolute bottom-3 right-3 z-10 space-y-1 rounded-sm border border-hairline bg-surface/90 px-3 py-2 backdrop-blur-sm">
              {[
                { color: "var(--color-brand)", label: "Truck / route leg" },
                { color: "var(--color-warn)", label: "Inside 5 km geofence" },
                { color: "var(--color-ink)", label: "Stop / depot" },
              ].map((l) => (
                <li key={l.label} className="flex items-center gap-2 text-caption text-ink-muted">
                  <span className="size-2 rounded-full" style={{ background: l.color }} />
                  {l.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Units"
            hint={`${located.length} of ${trucks.length} reporting`}
          />
          <ul className="divide-y divide-hairline">
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
                  term: "Rough ETA",
                  value: (() => {
                    const eta = estimateMinutes(selectedStop?.distance_m ?? null);
                    return eta === null ? "—" : `~${eta} min`;
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
