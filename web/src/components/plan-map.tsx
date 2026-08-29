"use client";

import { useMemo } from "react";

import { REFERENCE_PLACES } from "@/lib/geo/reference";
import type { LatLng } from "@/lib/types";

/**
 * A schematic of what the auto-planner proposed — depot out to each group's
 * stops and back, one colour per group.
 *
 * **Straight lines, on purpose.** This is the same great-circle geometry the
 * planner sequences on, drawn so a dispatcher can see the shape of a day
 * before creating anything. It is not a road map: an estuary the route jumps
 * is a real detour, and the list view carries the honest disclaimer. There is
 * no basemap — the grey city labels are the only orientation.
 */

export interface GroupColour {
  /** CSS custom-property name, for SVG. */
  token: string;
  /** Resolved hex, for Google Maps overlays (which take strings, not vars). */
  hex: string;
}

export interface PlanMapGroup {
  index: number;
  colour: GroupColour;
  /** Dimmed and dashed when the dispatcher has unchecked the group. */
  dropped: boolean;
  stops: { lat: number; lng: number; name: string }[];
}

/** Distinct enough at a glance, and all on the design system. */
export const GROUP_PALETTE: GroupColour[] = [
  { token: "--color-viz-1", hex: "#2f5bd7" },
  { token: "--color-viz-2", hex: "#c2701c" },
  { token: "--color-viz-3", hex: "#0f9488" },
  { token: "--color-accent", hex: "#7c0fe8" },
  { token: "--color-ok", hex: "#12855a" },
  { token: "--color-danger", hex: "#c33227" },
  { token: "--color-warn", hex: "#a76400" },
];

export const groupColour = (index: number): GroupColour =>
  GROUP_PALETTE[index % GROUP_PALETTE.length];

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLng = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
const GRID_KM = 25;

type XY = { x: number; y: number };

export function PlanMap({
  depot,
  groups,
}: {
  depot: LatLng;
  groups: PlanMapGroup[];
}) {
  const view = useMemo(() => {
    const points: LatLng[] = [
      depot,
      ...groups.flatMap((g) => g.stops.map((s) => ({ lat: s.lat, lng: s.lng }))),
    ];

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
    const pad = 24;
    let minX = Math.min(...xs) - pad;
    let maxX = Math.max(...xs) + pad;
    let minY = Math.min(...ys) - pad;
    let maxY = Math.max(...ys) + pad;

    // A single stop would give a zero-size box.
    if (maxX - minX < 60) {
      const c = (minX + maxX) / 2;
      minX = c - 30;
      maxX = c + 30;
    }
    if (maxY - minY < 60) {
      const c = (minY + maxY) / 2;
      minY = c - 30;
      maxY = c + 30;
    }

    // Widen to a letterbox; only ever adds ground, never distorts scale.
    const aspect = 1.7;
    const wantedW = (maxY - minY) * aspect;
    if (wantedW > maxX - minX) {
      const grow = (wantedW - (maxX - minX)) / 2;
      minX -= grow;
      maxX += grow;
    } else {
      const wantedH = (maxX - minX) / aspect;
      const grow = (wantedH - (maxY - minY)) / 2;
      minY -= grow;
      maxY += grow;
    }

    const gridAt = (from: number, to: number) => {
      const out: number[] = [];
      for (let v = Math.ceil(from / GRID_KM) * GRID_KM; v <= to; v += GRID_KM) {
        out.push(v);
      }
      return out;
    };

    const depotXY = project(depot);
    const places = REFERENCE_PLACES.map((p) => ({
      name: p.name,
      ...project({ lat: p.lat, lng: p.lng }),
    })).filter(
      (p) =>
        p.x > minX + 6 &&
        p.x < maxX - 6 &&
        p.y > minY + 4 &&
        p.y < maxY - 4 &&
        Math.hypot(p.x - depotXY.x, p.y - depotXY.y) > 10,
    );

    return {
      project,
      depotXY,
      places,
      viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      unit: (maxX - minX) / 100,
      gridXs: gridAt(minX, maxX),
      gridYs: gridAt(minY, maxY),
      minX,
      minY,
      maxX,
      maxY,
    };
  }, [depot, groups]);

  const u = view.unit;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface-muted">
      <svg
        viewBox={view.viewBox}
        className="block w-full"
        style={{ aspectRatio: "1.7 / 1" }}
        role="img"
        aria-label="Schematic of the proposed load routes from the depot"
      >
        {/* grid */}
        {view.gridXs.map((x) => (
          <line
            key={`vx${x}`}
            x1={x}
            y1={view.minY}
            x2={x}
            y2={view.maxY}
            stroke="var(--color-viz-grid)"
            strokeWidth={u * 0.15}
          />
        ))}
        {view.gridYs.map((y) => (
          <line
            key={`hy${y}`}
            x1={view.minX}
            y1={y}
            x2={view.maxX}
            y2={y}
            stroke="var(--color-viz-grid)"
            strokeWidth={u * 0.15}
          />
        ))}

        {/* reference cities */}
        {view.places.map((p) => (
          <g key={p.name}>
            <circle cx={p.x} cy={p.y} r={u * 0.5} fill="var(--color-ink-subtle)" opacity={0.4} />
            <text
              x={p.x + u * 1}
              y={p.y + u * 0.5}
              fontSize={u * 2.2}
              fill="var(--color-ink-subtle)"
              opacity={0.7}
            >
              {p.name}
            </text>
          </g>
        ))}

        {/* routes — dropped groups first so kept ones draw on top */}
        {[...groups]
          .sort((a, b) => Number(b.dropped) - Number(a.dropped))
          .map((g) => {
            const seq = [
              view.depotXY,
              ...g.stops.map((s) => view.project({ lat: s.lat, lng: s.lng })),
              view.depotXY,
            ];
            const d = seq.map((p) => `${p.x},${p.y}`).join(" ");
            const stroke = `var(${g.colour.token})`;
            return (
              <g key={g.index} opacity={g.dropped ? 0.28 : 1}>
                <polyline
                  points={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={u * (g.dropped ? 0.5 : 0.8)}
                  strokeDasharray={g.dropped ? `${u * 1.5} ${u * 1.5}` : undefined}
                  strokeLinejoin="round"
                />
                {g.stops.map((s, i) => {
                  const p = view.project({ lat: s.lat, lng: s.lng });
                  return (
                    <g key={i}>
                      <circle cx={p.x} cy={p.y} r={u * 1.7} fill={stroke} />
                      <text
                        x={p.x}
                        y={p.y}
                        fontSize={u * 2}
                        fill="#fff"
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontWeight={600}
                      >
                        {i + 1}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

        {/* depot */}
        <g>
          <path
            d={`M ${view.depotXY.x} ${view.depotXY.y - u * 2.4}
                L ${view.depotXY.x + u * 2.4} ${view.depotXY.y}
                L ${view.depotXY.x} ${view.depotXY.y + u * 2.4}
                L ${view.depotXY.x - u * 2.4} ${view.depotXY.y} Z`}
            fill="var(--color-ink)"
          />
          <text
            x={view.depotXY.x + u * 3}
            y={view.depotXY.y + u * 0.6}
            fontSize={u * 2.4}
            fill="var(--color-ink)"
            fontWeight={600}
          >
            Depot
          </text>
        </g>
      </svg>

      {/* legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-hairline px-4 py-2.5">
        {groups.map((g) => (
          <span
            key={g.index}
            className="flex items-center gap-1.5 text-caption"
            style={{ opacity: g.dropped ? 0.5 : 1 }}
          >
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: `var(${g.colour.token})` }}
            />
            <span className="text-ink">Group {g.index + 1}</span>
            <span className="text-ink-subtle">
              {g.stops.length} stop{g.stops.length === 1 ? "" : "s"}
              {g.dropped ? " · skipped" : ""}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
