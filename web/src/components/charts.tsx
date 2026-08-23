"use client";

/**
 * Chart primitives for Balkania TMS.
 *
 * Deliberately dependency-free SVG. Conventions that must hold everywhere:
 *   · one y-axis per plot, never two;
 *   · marks carry the series colour, text never does;
 *   · gridlines are solid hairlines one step off the surface;
 *   · every plot ships a hover tooltip and a `<details>` table view, so no
 *     value is reachable only by reading a pixel.
 *
 * Strokes use `vector-effect="non-scaling-stroke"` so the 2px line / 1px grid
 * specs survive the SVG being scaled to its container width.
 */

import { useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

const W = 720;
const H = 200;
const PAD = { top: 16, right: 14, bottom: 24, left: 38 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

export type Point = { label: string; value: number; caption?: string };

/**
 * Rounds a max up to a clean axis ceiling. The steps are deliberately fine —
 * a coarse [1, 2, 5, 10] ladder sends a max of 52 to 100 and wastes half the
 * plot height.
 */
const AXIS_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of AXIS_STEPS) {
    const candidate = step * pow;
    if (candidate >= max) return candidate;
  }
  return 10 * pow;
}

function ticks(min: number, max: number, count = 4): number[] {
  return Array.from(
    { length: count + 1 },
    (_, i) => min + ((max - min) * i) / count,
  );
}

/* --- shared chrome ---------------------------------------------------------- */

function Grid({ values, y }: { values: number[]; y: (v: number) => number }) {
  return (
    <g>
      {values.map((v) => (
        <line
          key={v}
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(v)}
          y2={y(v)}
          stroke="var(--color-viz-grid)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

function AxisLabels({
  values,
  y,
  format,
}: {
  values: number[];
  y: (v: number) => number;
  format: (v: number) => string;
}) {
  return (
    <g>
      {values.map((v) => (
        <text
          key={v}
          x={PAD.left - 8}
          y={y(v) + 4}
          textAnchor="end"
          className="fill-ink-subtle font-mono text-[10px]"
        >
          {format(v)}
        </text>
      ))}
    </g>
  );
}

function Tooltip({
  x,
  children,
}: {
  /** Horizontal position as a 0–1 fraction of the plot. */
  x: number;
  children: ReactNode;
}) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm border border-hairline bg-surface px-2.5 py-1.5 text-caption shadow-pop"
      style={{ left: `${Math.min(88, Math.max(12, x * 100))}%` }}
    >
      {children}
    </div>
  );
}

function TableView({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-3 border-t border-hairline pt-2">
      <summary className="cursor-pointer text-caption text-ink-subtle hover:text-ink">
        Table view
      </summary>
      <div className="mt-2 max-h-56 overflow-auto">
        <table className="w-full text-caption">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="sticky top-0 border-b border-hairline bg-surface px-2 py-1.5 text-left font-mono text-label uppercase text-ink-subtle"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="border-b border-hairline px-2 py-1.5 text-ink-muted tabular"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Maps a pointer event to the nearest of `count` evenly spaced slots. */
function slotFromPointer(
  event: ReactMouseEvent<SVGSVGElement>,
  count: number,
): number | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0) return null;
  const fraction = (event.clientX - rect.left) / rect.width;
  const plotStart = PAD.left / W;
  const plotEnd = (W - PAD.right) / W;
  const t = (fraction - plotStart) / (plotEnd - plotStart);
  if (t < -0.02 || t > 1.02) return null;
  return Math.min(count - 1, Math.max(0, Math.round(t * (count - 1))));
}

/* --- column chart ------------------------------------------------------------
   Magnitude across discrete periods. Single series, so no legend box — the
   card title names what is plotted. */

export function ColumnChart({
  data,
  unit,
  tickEvery = 1,
}: {
  data: Point[];
  unit: string;
  /** Draw every nth x label; use 2 when day labels would collide. */
  tickEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;
  const band = PLOT_W / data.length;
  const barW = Math.min(24, band * 0.62);
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0]);

  return (
    <div className="relative">
      {hover !== null ? (
        <Tooltip x={(hover + 0.5) / data.length}>
          <span className="block font-medium text-ink">
            {data[hover].value} {unit}
          </span>
          <span className="block text-ink-subtle">
            {data[hover].caption ?? data[hover].label}
          </span>
        </Tooltip>
      ) : null}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${unit} per day, ${data.length} days`}
        onMouseMove={(e) => setHover(slotFromPointer(e, data.length))}
        onMouseLeave={() => setHover(null)}
      >
        <Grid values={ticks(0, max)} y={y} />
        <AxisLabels values={ticks(0, max)} y={y} format={(v) => String(Math.round(v))} />

        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          const top = y(d.value);
          const baseline = PAD.top + PLOT_H;
          const r = Math.min(4, barW / 2, baseline - top);
          const active = hover === i;
          return (
            <g key={d.label}>
              {/* Full-band hit target: bigger than the mark, per interaction spec. */}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={PLOT_H}
                fill="transparent"
              />
              <path
                d={`M${x},${baseline} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${baseline} Z`}
                fill="var(--color-viz-1)"
                opacity={hover === null || active ? 1 : 0.45}
              />
              {i % tickEvery === 0 ? (
                <text
                  x={x + barW / 2}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-ink-subtle font-mono text-[10px]"
                >
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Sparing direct label: the peak only. */}
        <text
          x={PAD.left + data.indexOf(peak) * band + band / 2}
          y={y(peak.value) - 6}
          textAnchor="middle"
          className="fill-ink font-mono text-[10px] font-semibold"
        >
          {peak.value}
        </text>
      </svg>

      <TableView
        columns={["Day", unit]}
        rows={data.map((d) => [d.caption ?? d.label, d.value])}
      />
    </div>
  );
}

/* --- line chart --------------------------------------------------------------
   Change over time for a rate. Domain is padded, never zero-based, because the
   interesting range of an on-time percentage is the top of the scale. */

export function LineChart({
  data,
  unit,
  tickEvery = 1,
}: {
  data: Point[];
  unit: string;
  tickEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const values = data.map((d) => d.value);
  const lo = Math.floor((Math.min(...values) - 1) / 2) * 2;
  const hi = Math.ceil(Math.max(...values) / 2) * 2;
  const y = (v: number) => PAD.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
  const x = (i: number) =>
    PAD.left + (data.length === 1 ? PLOT_W / 2 : (i / (data.length - 1)) * PLOT_W);

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
  const area = `${line} L${x(data.length - 1)},${PAD.top + PLOT_H} L${x(0)},${PAD.top + PLOT_H} Z`;
  const last = data[data.length - 1];

  return (
    <div className="relative">
      {hover !== null ? (
        <Tooltip x={hover / Math.max(1, data.length - 1)}>
          <span className="block font-medium text-ink">
            {data[hover].value.toFixed(1)}
            {unit}
          </span>
          <span className="block text-ink-subtle">
            {data[hover].caption ?? data[hover].label}
          </span>
        </Tooltip>
      ) : null}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`On-time rate over ${data.length} days`}
        onMouseMove={(e) => setHover(slotFromPointer(e, data.length))}
        onMouseLeave={() => setHover(null)}
      >
        <Grid values={ticks(lo, hi)} y={y} />
        <AxisLabels
          values={ticks(lo, hi)}
          y={y}
          format={(v) => `${Math.round(v)}${unit}`}
        />

        <path d={area} fill="var(--color-viz-1)" opacity={0.1} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-viz-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover !== null ? (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--color-hairline-strong)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={x(hover)}
              cy={y(data[hover].value)}
              r={4.5}
              fill="var(--color-viz-1)"
              stroke="var(--color-surface)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ) : null}

        {/* Endpoint marker + the one direct label. */}
        <circle
          cx={x(data.length - 1)}
          cy={y(last.value)}
          r={4}
          fill="var(--color-viz-1)"
          stroke="var(--color-surface)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />

        {data.map((d, i) =>
          i % tickEvery === 0 ? (
            <text
              key={d.label}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-ink-subtle font-mono text-[10px]"
            >
              {d.label}
            </text>
          ) : null,
        )}
      </svg>

      <TableView
        columns={["Day", `On time (${unit})`]}
        rows={data.map((d) => [d.caption ?? d.label, d.value.toFixed(1)])}
      />
    </div>
  );
}

/* --- category bars -----------------------------------------------------------
   Nominal categories, so one validated categorical hue per entity — assigned by
   identity and fixed, never by rank. */

export type Category = { label: string; value: number; color: string };

export function CategoryBars({
  items,
  unit,
}: {
  items: Category[];
  unit: string;
}) {
  const max = Math.max(...items.map((i) => i.value));

  return (
    <div>
      <ul className="space-y-3.5">
        {items.map((item) => (
          <li key={item.label}>
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: item.color }}
              />
              <span className="flex-1 truncate text-body-sm text-ink-muted">
                {item.label}
              </span>
              <span className="font-mono text-data-sm tabular text-ink">
                {item.value}
              </span>
            </div>
            {/* 4px rounded data-end, square at the baseline. */}
            <div className="h-2.5 w-full overflow-hidden rounded-l-[1px] bg-surface-sunken">
              <div
                className="h-full rounded-r-[4px]"
                style={{
                  width: `${(item.value / max) * 100}%`,
                  background: item.color,
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      <TableView
        columns={["Alert type", unit]}
        rows={items.map((i) => [i.label, i.value])}
      />
    </div>
  );
}
