"use client";

/**
 * A map the dispatcher builds a route on by clicking.
 *
 * Every unassigned order with coordinates is a marker. Clicking one adds it to
 * the end of the route; clicking a numbered one takes it out again, and the
 * numbers close up. The number *is* the stop sequence, so the click order is the
 * order the driver runs — the same `picked` array the list view edits.
 *
 * Unlike `plan-here-map.tsx`, which draws the auto-planner's proposal read-only,
 * this one is an input. The connecting line is a **straight line** depot → stops
 * → depot: it shows the shape and order of the run, not a road. Falls back to a
 * clickable schematic when there is no Maps key.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon, cx } from "@/components/ui";
import { loadHereMaps, token, type HereNamespace } from "@/lib/maps";
import type { LatLng, Order } from "@/lib/types";

export interface PickRouteMapProps {
  /** HERE Maps browser key; without one the schematic is drawn instead. */
  apiKey: string | null;
  depot: LatLng;
  /** Candidate stops. Orders with no coordinates are ignored here. */
  orders: Order[];
  /** Order ids in the sequence chosen so far. */
  picked: string[];
  onToggle: (orderId: string) => void;
  heightClass?: string;
}

type Located = { order: Order; point: LatLng };

const located = (orders: Order[]): Located[] =>
  orders.flatMap((order) =>
    order.delivery_location ? [{ order, point: order.delivery_location }] : [],
  );

export function PickRouteMap(props: PickRouteMapProps) {
  return props.apiKey ? (
    <HerePick {...props} apiKey={props.apiKey} />
  ) : (
    <SchematicPick {...props} />
  );
}

/* --- HERE basemap ------------------------------------------------------- */

function HerePick({
  apiKey,
  depot,
  orders,
  picked,
  onToggle,
  heightClass = "h-[26rem]",
}: PickRouteMapProps & { apiKey: string }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<HereNamespace>(null);
  const hRef = useRef<HereNamespace>(null);
  const drawn = useRef<HereNamespace[]>([]);
  // The tap listener is registered once; it must still call the latest handler.
  const onToggleRef = useRef(onToggle);
  useEffect(() => {
    onToggleRef.current = onToggle;
  }, [onToggle]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const points = useMemo(() => located(orders), [orders]);

  // --- create the map once ----------------------------------------------
  useEffect(() => {
    let cancelled = false;
    loadHereMaps()
      .then((H: HereNamespace) => {
        if (cancelled || !holder.current || mapRef.current) return;
        hRef.current = H;

        const platform = new H.service.Platform({ apiKey });
        const layers = platform.createDefaultLayers();
        const map = new H.Map(holder.current, layers.vector.normal.map, {
          center: depot,
          zoom: 8,
          pixelRatio: window.devicePixelRatio || 1,
        });

        new H.mapevents.Behavior(new H.mapevents.MapEvents(map));
        H.ui.UI.createDefault(map, layers);

        const markerId = (target: HereNamespace): string | null =>
          target instanceof H.map.Marker ? (target.getData()?.id ?? null) : null;

        map.addEventListener("tap", (evt: HereNamespace) => {
          const id = markerId(evt.target);
          if (id) onToggleRef.current(id);
        });
        const setCursor = (evt: HereNamespace, on: boolean) => {
          if (holder.current && markerId(evt.target)) {
            holder.current.style.cursor = on ? "pointer" : "";
          }
        };
        map.addEventListener("pointerenter", (e: HereNamespace) => setCursor(e, true));
        map.addEventListener("pointerleave", (e: HereNamespace) => setCursor(e, false));

        const onResize = () => map.getViewPort().resize();
        window.addEventListener("resize", onResize);
        map.__onResize = onResize;

        mapRef.current = map;
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // depot is a stable constant; picks changing must not recreate the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // --- fit once per set of candidates — not on every click ---------------
  useEffect(() => {
    const map = mapRef.current;
    const H = hRef.current;
    if (status !== "ready" || !map || !H) return;
    map
      .getViewModel()
      .setLookAtData({ bounds: H.geo.Rect.coverPoints([depot, ...points.map((p) => p.point)]) });
  }, [status, depot, points]);

  // --- overlays ----------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const H = hRef.current;
    if (status !== "ready" || !map || !H) return;

    for (const object of drawn.current) map.removeObject(object);
    drawn.current = [];

    const ink = token("--color-ink", "#0e1725");
    const muted = token("--color-ink-subtle", "#6b7688");
    const brand = token("--color-brand", "#2f5bd7");
    const surface = token("--color-surface", "#ffffff");

    const icon = (markup: string, size: number) =>
      new H.map.Icon(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${markup}</svg>`,
        { anchor: new H.math.Point(size / 2, size / 2) },
      );
    const add = (object: HereNamespace) => {
      map.addObject(object);
      drawn.current.push(object);
    };

    const sequence = new Map(picked.map((id, i) => [id, i + 1]));
    const chosen = picked
      .map((id) => points.find((p) => p.order.id === id))
      .filter((p): p is Located => p !== undefined);

    if (chosen.length > 0) {
      const line = new H.geo.LineString();
      for (const p of [depot, ...chosen.map((c) => c.point), depot]) line.pushPoint(p);
      add(
        new H.map.Polyline(line, {
          style: { strokeColor: brand, lineWidth: 3 },
          volatility: false,
        }),
      );
    }

    add(
      new H.map.Marker(depot, {
        icon: icon(
          `<rect x="3" y="3" width="14" height="14" fill="${ink}" stroke="${surface}" stroke-width="2"/>`,
          20,
        ),
        data: { title: "Depot" },
        zIndex: 100,
      }),
    );

    for (const { order, point } of points) {
      const n = sequence.get(order.id);
      const label = `${order.customer_name} — ${order.delivery_address}`;
      add(
        new H.map.Marker(point, {
          icon:
            n === undefined
              ? icon(
                  `<circle cx="9" cy="9" r="6.5" fill="${surface}" stroke="${muted}" stroke-width="2"/>`,
                  18,
                )
              : icon(
                  `<circle cx="12" cy="12" r="10" fill="${brand}" stroke="${surface}" stroke-width="1.5"/>` +
                    `<text x="12" y="16" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fff">${n}</text>`,
                  24,
                ),
          data: { id: order.id, title: n === undefined ? label : `Stop ${n} — ${label}` },
          zIndex: n === undefined ? 10 : 20,
        }),
      );
    }
  }, [status, depot, points, picked]);

  // --- teardown ----------------------------------------------------------
  useEffect(
    () => () => {
      const map = mapRef.current;
      if (!map) return;
      if (map.__onResize) window.removeEventListener("resize", map.__onResize);
      map.dispose();
      mapRef.current = null;
      drawn.current = [];
    },
    [],
  );

  if (status === "error") {
    return (
      <div
        className={cx(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-hairline bg-surface-muted px-6 text-center",
          heightClass,
        )}
      >
        <Icon name="map" className="text-[26px] text-ink-subtle" />
        <p className="text-body-sm font-medium text-ink">HERE Maps did not load</p>
        <p className="max-w-md text-caption text-ink-subtle">
          Switch to the list view to pick stops, or check the Maps key&rsquo;s
          domain restriction.
        </p>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-hairline">
      <div ref={holder} className={cx("w-full", heightClass)} />
      {status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-muted">
          <span className="flex items-center gap-2 text-body-sm text-ink-subtle">
            <Icon name="progress_activity" className="animate-spin text-[18px]" />
            Loading basemap…
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* --- schematic fallback ------------------------------------------------- */

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLng = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

function SchematicPick({
  depot,
  orders,
  picked,
  onToggle,
  heightClass = "h-[26rem]",
}: PickRouteMapProps) {
  const points = useMemo(() => located(orders), [orders]);

  const view = useMemo(() => {
    const all = [depot, ...points.map((p) => p.point)];
    const latMid = all.reduce((n, p) => n + p.lat, 0) / all.length;
    const origin = {
      lat: Math.max(...all.map((p) => p.lat)),
      lng: Math.min(...all.map((p) => p.lng)),
    };
    const project = (p: LatLng) => ({
      x: (p.lng - origin.lng) * kmPerDegLng(latMid),
      y: (origin.lat - p.lat) * KM_PER_DEG_LAT,
    });
    const xy = all.map(project);
    const pad = 12;
    let minX = Math.min(...xy.map((p) => p.x)) - pad;
    let maxX = Math.max(...xy.map((p) => p.x)) + pad;
    let minY = Math.min(...xy.map((p) => p.y)) - pad;
    let maxY = Math.max(...xy.map((p) => p.y)) + pad;
    // A lone stop would give a zero-size box.
    if (maxX - minX < 40) [minX, maxX] = [(minX + maxX) / 2 - 20, (minX + maxX) / 2 + 20];
    if (maxY - minY < 40) [minY, maxY] = [(minY + maxY) / 2 - 20, (minY + maxY) / 2 + 20];
    return {
      project,
      viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      unit: (maxX - minX) / 100,
    };
  }, [depot, points]);

  const u = view.unit;
  const depotXY = view.project(depot);
  const chosen = picked
    .map((id) => points.find((p) => p.order.id === id))
    .filter((p): p is Located => p !== undefined);
  const sequence = new Map(picked.map((id, i) => [id, i + 1]));
  const route = [depotXY, ...chosen.map((c) => view.project(c.point)), depotXY]
    .map((p) => `${p.x},${p.y}`)
    .join(" ");

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface-muted">
      <svg
        viewBox={view.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className={cx("block w-full", heightClass)}
        role="group"
        aria-label="Schematic of unassigned orders. Select a stop to add it to the route."
      >
        {chosen.length > 0 ? (
          <polyline
            points={route}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth={u * 0.7}
            strokeLinejoin="round"
          />
        ) : null}

        <path
          d={`M ${depotXY.x} ${depotXY.y - u * 2.4} L ${depotXY.x + u * 2.4} ${depotXY.y} L ${depotXY.x} ${depotXY.y + u * 2.4} L ${depotXY.x - u * 2.4} ${depotXY.y} Z`}
          fill="var(--color-ink)"
        />
        <text
          x={depotXY.x + u * 3}
          y={depotXY.y + u * 0.6}
          fontSize={u * 2.4}
          fill="var(--color-ink)"
          fontWeight={600}
        >
          Depot
        </text>

        {points.map(({ order, point }) => {
          const p = view.project(point);
          const n = sequence.get(order.id);
          return (
            <g
              key={order.id}
              role="button"
              tabIndex={0}
              aria-pressed={n !== undefined}
              aria-label={`${order.customer_name}, ${order.delivery_address}`}
              onClick={() => onToggle(order.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(order.id);
                }
              }}
              className="cursor-pointer outline-none"
            >
              <title>
                {n === undefined ? "" : `Stop ${n} — `}
                {order.customer_name} — {order.delivery_address}
              </title>
              {n === undefined ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={u * 1.4}
                  fill="var(--color-surface)"
                  stroke="var(--color-ink-subtle)"
                  strokeWidth={u * 0.35}
                />
              ) : (
                <>
                  <circle cx={p.x} cy={p.y} r={u * 1.9} fill="var(--color-brand)" />
                  <text
                    x={p.x}
                    y={p.y}
                    fontSize={u * 2.1}
                    fill="#fff"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontWeight={600}
                    pointerEvents="none"
                  >
                    {n}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <p className="border-t border-hairline px-4 py-2 text-caption text-ink-subtle">
        Schematic — no basemap key is configured, so there are no roads or
        coastline. Distances are to scale.
      </p>
    </div>
  );
}
