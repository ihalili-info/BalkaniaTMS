"use client";

/**
 * Schematic fleet map.
 *
 * There is no tile provider wired up yet (no Mapbox/Google key in `.env`), so
 * this projects the real coordinates onto a plain canvas rather than faking a
 * basemap. The projection is equirectangular with units of **kilometres**,
 * which means the 5 km geofence rings are drawn to true scale — the one thing
 * a dispatcher actually has to trust here. Swapping in real tiles later means
 * replacing the `<svg>` with a map component and keeping these overlays.
 */

import { useState } from "react";

import {
  Badge,
  Card,
  CardHeader,
  Icon,
  LoadStatusBadge,
  TruckDutyBadge,
  cx,
} from "@/components/ui";
import { truckDuty, unavailabilityReason } from "@/lib/fleet-status";
import {
  CITIES,
  DEMO_NOW,
  DEPOT,
  GEOFENCE_RADIUS_M,
  loadForTruck,
  nextStop,
  trucks,
} from "@/lib/demo/fleet";
import {
  estimateMinutes,
  formatCoords,
  formatDistance,
  relativeTime,
} from "@/lib/format";
import type { LatLng } from "@/lib/types";

/* --- projection ------------------------------------------------------------- */

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLng = (lat: number) =>
  111.32 * Math.cos((lat * Math.PI) / 180);

type XY = { x: number; y: number };

const located = trucks.filter((t) => t.current_location !== null);

const allPoints: LatLng[] = [
  DEPOT,
  ...Object.values(CITIES),
  ...located.map((t) => t.current_location!),
  ...trucks.flatMap((t) => {
    const stop = loadForTruck(t.id) ? nextStop(loadForTruck(t.id)!) : undefined;
    return stop?.order.delivery_location ? [stop.order.delivery_location] : [];
  }),
];

const latMid =
  allPoints.reduce((n, p) => n + p.lat, 0) / allPoints.length;
const origin = {
  lat: Math.max(...allPoints.map((p) => p.lat)),
  lng: Math.min(...allPoints.map((p) => p.lng)),
};

/** Degrees → kilometres, y growing downward so it maps straight to SVG. */
function project(p: LatLng): XY {
  return {
    x: (p.lng - origin.lng) * kmPerDegLng(latMid),
    y: (origin.lat - p.lat) * KM_PER_DEG_LAT,
  };
}

const projected = allPoints.map(project);
const PAD_KM = 14;

/**
 * The fleet's bounding box is near-square, but the map panel is a wide
 * letterbox. Widening the box to the panel's aspect fills the width instead of
 * leaving two dead margins — and because it only *adds* ground, the km scale
 * (and so the geofence rings) is untouched.
 */
const PANEL_ASPECT = 2;

function fitToAspect(
  lo: number,
  hi: number,
  otherSpan: number,
  isHorizontal: boolean,
): [number, number] {
  const span = hi - lo;
  const wanted = isHorizontal
    ? otherSpan * PANEL_ASPECT
    : otherSpan / PANEL_ASPECT;
  if (wanted <= span) return [lo, hi];
  const grow = (wanted - span) / 2;
  return [lo - grow, hi + grow];
}

const rawMinX = Math.min(...projected.map((p) => p.x)) - PAD_KM;
const rawMaxX = Math.max(...projected.map((p) => p.x)) + PAD_KM;
const rawMinY = Math.min(...projected.map((p) => p.y)) - PAD_KM;
const rawMaxY = Math.max(...projected.map((p) => p.y)) + PAD_KM;

const [minY, maxY] = fitToAspect(
  rawMinY,
  rawMaxY,
  rawMaxX - rawMinX,
  false,
);
const [minX, maxX] = fitToAspect(rawMinX, rawMaxX, maxY - minY, true);

const VB_W = maxX - minX;
const VB_H = maxY - minY;

/** Marker sizes key off the height, which the aspect fit leaves alone. */
const M = VB_H * 0.02;
const GEOFENCE_KM = GEOFENCE_RADIUS_M / 1000;

/** Graticule every 25 km — a scale reference, not decoration. */
const GRID_KM = 25;

function gridLines(from: number, to: number): number[] {
  const lines: number[] = [];
  for (let v = Math.ceil(from / GRID_KM) * GRID_KM; v <= to; v += GRID_KM) {
    lines.push(v);
  }
  return lines;
}

const gridXs = gridLines(minX, maxX);
const gridYs = gridLines(minY, maxY);

const depotXY = project(DEPOT);

/**
 * City labels sit *below* their dot; truck plates sit above their marker. The
 * two bands never fight. Cities within 8 km of the depot are dropped outright —
 * the depot already labels that spot.
 */
const CITY_LABELS = Object.entries(CITIES)
  .map(([key, at]) => ({
    name: key.charAt(0).toUpperCase() + key.slice(1),
    ...project(at),
  }))
  .filter((c) => Math.hypot(c.x - depotXY.x, c.y - depotXY.y) > 8);

/* --- component ---------------------------------------------------------------- */

export function FleetMap() {
  const [selectedId, setSelectedId] = useState<string>(trucks[0].id);
  const selected = trucks.find((t) => t.id === selectedId)!;
  const selectedLoad = loadForTruck(selected.id);
  const selectedStop = selectedLoad ? nextStop(selectedLoad) : undefined;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_20rem]">
      <Card className="overflow-hidden">
        <CardHeader
          title="Fleet positions"
          hint="Equirectangular schematic · geofence rings drawn to true 5 km scale"
          actions={
            <Badge tone="warn" dot>
              No basemap
            </Badge>
          }
        />

        <div className="relative bg-surface-muted">
          <svg
            viewBox={`${minX} ${minY} ${VB_W} ${VB_H}`}
            className="h-[30rem] w-full"
            role="img"
            aria-label="Schematic map of truck positions and delivery geofences"
          >
            {/* graticule */}
            <g>
              {gridXs.map((x) => (
                <line
                  key={`x${x}`}
                  x1={x}
                  x2={x}
                  y1={minY}
                  y2={maxY}
                  stroke="var(--color-hairline)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {gridYs.map((y) => (
                <line
                  key={`y${y}`}
                  x1={minX}
                  x2={maxX}
                  y1={y}
                  y2={y}
                  stroke="var(--color-hairline)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>

            {/* city context labels */}
            {CITY_LABELS.map((c) => (
              <g key={c.name}>
                <circle cx={c.x} cy={c.y} r={M * 0.18} fill="var(--color-ink-subtle)" />
                <text
                  x={c.x}
                  y={c.y + M * 0.95}
                  textAnchor="middle"
                  className="fill-ink-subtle text-[5px]"
                >
                  {c.name}
                </text>
              </g>
            ))}

            {/* depot */}
            <g>
              <rect
                x={depotXY.x - M * 0.45}
                y={depotXY.y - M * 0.45}
                width={M * 0.9}
                height={M * 0.9}
                rx={M * 0.15}
                fill="var(--color-ink)"
              />
              <text
                x={depotXY.x}
                y={depotXY.y + M * 1.35}
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

            {/* per-truck overlay: geofence ring, route leg, marker */}
            {trucks.map((truck) => {
              if (!truck.current_location) return null;
              const at = project(truck.current_location);
              const load = loadForTruck(truck.id);
              const stop = load ? nextStop(load) : undefined;
              const target = stop?.order.delivery_location
                ? project(stop.order.delivery_location)
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
                        fill={
                          inFence ? "var(--color-warn)" : "var(--color-brand)"
                        }
                        fillOpacity={active ? 0.14 : 0.07}
                        stroke={
                          inFence ? "var(--color-warn)" : "var(--color-brand)"
                        }
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
                        r={M * 0.22}
                        fill="var(--color-ink)"
                      />
                    </>
                  ) : null}

                  <g
                    onClick={() => setSelectedId(truck.id)}
                    className="cursor-pointer"
                  >
                    {/* hit target, larger than the mark */}
                    <circle cx={at.x} cy={at.y} r={M * 1.4} fill="transparent" />
                    {active ? (
                      <circle
                        cx={at.x}
                        cy={at.y}
                        r={M * 1.05}
                        fill="var(--color-brand)"
                        fillOpacity={0.18}
                      />
                    ) : null}
                    <circle
                      cx={at.x}
                      cy={at.y}
                      r={M * 0.55}
                      fill="var(--color-brand)"
                      stroke="var(--color-surface)"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={at.x}
                      y={at.y - M * 0.95}
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

            {/* scale bar: 25 km */}
            <g transform={`translate(${minX + 8} ${maxY - 8})`}>
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

          <ul className="absolute bottom-3 right-3 space-y-1 rounded-sm border border-hairline bg-surface/90 px-3 py-2 backdrop-blur-sm">
            {[
              { color: "var(--color-brand)", label: "Truck / route leg" },
              { color: "var(--color-warn)", label: "Inside 5 km geofence" },
              { color: "var(--color-ink)", label: "Stop / depot" },
            ].map((l) => (
              <li key={l.label} className="flex items-center gap-2 text-caption text-ink-muted">
                <span
                  className="size-2 rounded-full"
                  style={{ background: l.color }}
                />
                {l.label}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Units" hint={`${located.length} of ${trucks.length} reporting`} />
          <ul className="divide-y divide-hairline">
            {trucks.map((truck) => {
              const load = loadForTruck(truck.id);
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
                      truck.id === selectedId
                        ? "bg-brand-soft"
                        : "hover:bg-surface-muted",
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
                            ? `No fix · ${relativeTime(truck.location_updated_at, DEMO_NOW)}`
                            : load
                              ? `${load.reference} · ${load.driver?.full_name}`
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

        <Card>
          <CardHeader title={selected.license_plate} hint={selected.gps_device_id} />
          <dl className="divide-y divide-hairline">
            {[
              {
                term: "Position",
                value: formatCoords(selected.current_location),
                mono: true,
              },
              {
                term: "Last fix",
                value: relativeTime(selected.location_updated_at, DEMO_NOW),
              },
              {
                term: "Load",
                value: selectedLoad?.reference ?? "—",
                mono: true,
              },
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
            {selectedLoad ? (
              <LoadStatusBadge status={selectedLoad.status} />
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
