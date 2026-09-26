"use client";

/**
 * Orders on a map, coloured by whether the delivery is done.
 *
 * **Completed** is `orders.status === "delivered"` — green, with a tick.
 * **Not completed** is everything else (pending, assigned, en route) — red.
 * The two also differ in shape, not just hue, so the map still reads for
 * anyone who cannot tell red from green; red is drawn on top so outstanding
 * work is never buried under a pile of finished drops.
 *
 * Only orders with coordinates can be pinned. The rest are counted and pointed
 * at CRM Errors rather than silently left out of the totals.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Card, CardHeader, EmptyState, Icon, StatTile, cx } from "@/components/ui";
import { formatClock, formatDate } from "@/lib/format";
import { DEFAULT_VIEW, DEPOT } from "@/lib/geo/reference";
import { loadHereMaps, token, type HereNamespace } from "@/lib/maps";
import type { LatLng, Order } from "@/lib/types";

type StatusFilter = "all" | "done" | "open";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "done", label: "Completed" },
  { key: "open", label: "Not completed" },
];

const isDone = (o: Order) => o.status === "delivered";

/** The UTC calendar day an order was received — the zone the app prints times in. */
const receivedDay = (o: Order) => o.created_at.slice(0, 10);

function utcDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const PRESETS: { label: string; range: () => [string, string] }[] = [
  { label: "Today", range: () => [utcDay(), utcDay()] },
  { label: "Yesterday", range: () => [utcDay(-1), utcDay(-1)] },
  { label: "7 days", range: () => [utcDay(-6), utcDay()] },
];

const dateInputClass =
  "h-9 rounded-sm border border-hairline bg-surface-muted px-2 text-body-sm text-ink outline-none focus:border-brand-border focus:bg-surface";

const STATUS_LABEL: Record<Order["status"], string> = {
  pending: "Pending",
  assigned: "Assigned",
  en_route: "En route",
  delivered: "Delivered",
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function OrdersMap({
  orders,
  hereMapsKey,
}: {
  orders: Order[];
  hereMapsKey: string | null;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const dated = from !== "" || to !== "";

  const inRange = useMemo(
    () =>
      orders.filter((o) => {
        const day = receivedDay(o);
        return (from === "" || day >= from) && (to === "" || day <= to);
      }),
    [orders, from, to],
  );

  const located = useMemo(
    () => inRange.filter((o) => o.delivery_location !== null),
    [inRange],
  );
  const doneCount = located.filter(isDone).length;
  const openCount = located.length - doneCount;
  const unlocated = inRange.length - located.length;

  const shown = useMemo(
    () =>
      located.filter((o) =>
        status === "all" ? true : status === "done" ? isDone(o) : !isDone(o),
      ),
    [located, status],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Completed"
          value={doneCount}
          hint="Delivered — green"
          icon="check_circle"
          tone="ok"
        />
        <StatTile
          label="Not completed"
          value={openCount}
          hint="Pending, assigned or en route — red"
          icon="pending"
          tone="danger"
        />
        <StatTile
          label="On the map"
          value={located.length}
          unit={`/ ${inRange.length}`}
          hint={dated ? "Orders received in the range" : "All orders"}
          icon="pin_drop"
          tone="brand"
        />
        <StatTile
          label="No location"
          value={unlocated}
          hint="Cannot be pinned"
          icon="wrong_location"
          tone={unlocated > 0 ? "warn" : "ok"}
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Delivery locations"
          hint={`${shown.length} order${shown.length === 1 ? "" : "s"} shown`}
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESETS.map((p) => {
                const [pFrom, pTo] = p.range();
                const active = from === pFrom && to === pTo;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setFrom(pFrom);
                      setTo(pTo);
                    }}
                    aria-pressed={active}
                    className={cx(
                      "rounded-sm px-2 py-1.5 text-body-sm transition-colors",
                      active
                        ? "bg-brand-soft font-medium text-brand-ink"
                        : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Received from"
                className={dateInputClass}
              />
              <span className="text-body-sm text-ink-subtle">to</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Received to"
                className={dateInputClass}
              />
              {dated ? (
                <button
                  type="button"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                  className="rounded-sm px-2 py-1.5 text-body-sm text-ink-muted hover:bg-surface-muted hover:text-ink"
                >
                  Clear dates
                </button>
              ) : null}
            </div>
          }
        />

        <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-2.5">
          <div role="group" aria-label="Status" className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatus(f.key)}
                aria-pressed={status === f.key}
                className={cx(
                  "flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-body-sm transition-colors",
                  status === f.key
                    ? "bg-brand-soft font-medium text-brand-ink"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                {f.key === "done" ? (
                  <span className="size-2.5 rounded-full bg-ok" aria-hidden="true" />
                ) : f.key === "open" ? (
                  <span className="size-2.5 rounded-full bg-danger" aria-hidden="true" />
                ) : null}
                {f.label}
                <span className="font-mono text-label tabular text-ink-subtle">
                  {f.key === "all"
                    ? located.length
                    : f.key === "done"
                      ? doneCount
                      : openCount}
                </span>
              </button>
            ))}
          </div>
          <p className="ml-auto text-caption text-ink-subtle">
            Filtered by the day an order was received.
          </p>
        </div>

        <div className="relative bg-surface-muted">
          {located.length === 0 ? (
            <EmptyState
              icon="map"
              title="Nothing to show"
              description={
                dated
                  ? "No order received in this range has a delivery location. Widen the dates, or clear them."
                  : "No order has a delivery location yet."
              }
            />
          ) : hereMapsKey ? (
            <HereOrders apiKey={hereMapsKey} orders={shown} />
          ) : (
            <SchematicOrders orders={shown} />
          )}

          <ul className="pointer-events-none absolute bottom-3 right-3 z-10 space-y-1 rounded-sm border border-hairline bg-surface/90 px-3 py-2 backdrop-blur-sm">
            <li className="flex items-center gap-2 text-caption text-ink-muted">
              <span className="size-2.5 rounded-full bg-ok" />
              Completed (delivered)
            </li>
            <li className="flex items-center gap-2 text-caption text-ink-muted">
              <span className="size-2.5 rounded-full bg-danger" />
              Not completed
            </li>
          </ul>
        </div>

        {unlocated > 0 ? (
          <p className="flex items-start gap-2 border-t border-hairline px-5 py-3 text-caption text-ink-muted">
            <Icon name="wrong_location" className="mt-px text-[15px] text-warn" />
            <span>
              {unlocated} order{unlocated === 1 ? " has" : "s have"} no
              coordinates and {unlocated === 1 ? "is" : "are"} not on this map.
              See{" "}
              <Link
                href="/crm-errors"
                prefetch={false}
                className="font-medium text-brand hover:underline"
              >
                CRM Errors
              </Link>{" "}
              or fix the address on the{" "}
              <Link
                href="/orders-queue"
                prefetch={false}
                className="font-medium text-brand hover:underline"
              >
                Orders Queue
              </Link>
              .
            </span>
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/** What the popup says about one order. */
function popupHtml(o: Order): string {
  const done = isDone(o);
  return (
    `<div style="font:12px system-ui,sans-serif;max-width:230px">` +
    `<b>${esc(o.customer_name)}</b><br>` +
    `<span style="font-family:ui-monospace,monospace">${esc(o.crm_order_id)}</span><br>` +
    `<span style="color:#5b6675">${esc(o.delivery_address)}</span><br>` +
    `<b style="color:${done ? "#12855a" : "#c33227"}">${esc(STATUS_LABEL[o.status])}</b>` +
    ` <span style="color:#5b6675">· received ${esc(formatDate(o.created_at))} ${esc(formatClock(o.created_at))} UTC</span>` +
    `</div>`
  );
}

/* --- HERE basemap ------------------------------------------------------- */

function HereOrders({ apiKey, orders }: { apiKey: string; orders: Order[] }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<HereNamespace>(null);
  const hRef = useRef<HereNamespace>(null);
  const uiRef = useRef<HereNamespace>(null);
  const drawn = useRef<HereNamespace[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    loadHereMaps()
      .then((H: HereNamespace) => {
        if (cancelled || !holder.current || mapRef.current) return;
        hRef.current = H;
        const platform = new H.service.Platform({ apiKey });
        const layers = platform.createDefaultLayers();
        const map = new H.Map(holder.current, layers.vector.normal.map, {
          center: DEFAULT_VIEW.centre,
          zoom: 7,
          pixelRatio: window.devicePixelRatio || 1,
        });
        new H.mapevents.Behavior(new H.mapevents.MapEvents(map));
        uiRef.current = H.ui.UI.createDefault(map, layers);

        map.addEventListener("tap", (evt: HereNamespace) => {
          const target = evt.target;
          const ui = uiRef.current;
          if (!ui) return;
          for (const b of ui.getBubbles()) ui.removeBubble(b);
          if (target instanceof H.map.Marker && target.getData()?.html) {
            ui.addBubble(
              new H.ui.InfoBubble(target.getGeometry(), {
                content: target.getData().html,
              }),
            );
          }
        });

        const onResize = () => map.getViewPort().resize();
        window.addEventListener("resize", onResize);
        map.__onResize = onResize;

        mapRef.current = map;
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  useEffect(() => {
    const map = mapRef.current;
    const H = hRef.current;
    if (state !== "ready" || !map || !H) return;

    for (const object of drawn.current) map.removeObject(object);
    drawn.current = [];

    const ok = token("--color-ok", "#12855a");
    const danger = token("--color-danger", "#c33227");
    const ink = token("--color-ink", "#0e1725");
    const surface = token("--color-surface", "#ffffff");

    // One icon per colour, shared by every marker — a thousand orders must not
    // mean a thousand SVGs to parse.
    const svg = (markup: string, size: number) =>
      new H.map.Icon(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${markup}</svg>`,
        { anchor: new H.math.Point(size / 2, size / 2) },
      );
    const doneIcon = svg(
      `<circle cx="8" cy="8" r="6.5" fill="${ok}" stroke="${surface}" stroke-width="1.5"/>` +
        `<path d="M5 8.2 l2 2 l4-4.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      16,
    );
    const openIcon = svg(
      `<circle cx="8" cy="8" r="6.5" fill="${danger}" stroke="${surface}" stroke-width="1.5"/>` +
        `<circle cx="8" cy="8" r="2" fill="#fff"/>`,
      16,
    );

    const points: LatLng[] = [{ lat: DEPOT.lat, lng: DEPOT.lng }];
    const group = new H.map.Group();

    group.addObject(
      new H.map.Marker(
        { lat: DEPOT.lat, lng: DEPOT.lng },
        {
          icon: svg(
            `<rect x="3" y="3" width="14" height="14" fill="${ink}" stroke="${surface}" stroke-width="2"/>`,
            20,
          ),
          data: { html: `<div style="font:12px system-ui"><b>Depot</b></div>` },
          zIndex: 1,
        },
      ),
    );

    for (const o of orders) {
      if (!o.delivery_location) continue;
      points.push(o.delivery_location);
      const done = isDone(o);
      group.addObject(
        new H.map.Marker(o.delivery_location, {
          icon: done ? doneIcon : openIcon,
          data: { html: popupHtml(o) },
          // Outstanding work on top of finished work.
          zIndex: done ? 5 : 10,
        }),
      );
    }

    map.addObject(group);
    drawn.current.push(group);

    map.getViewModel().setLookAtData({ bounds: H.geo.Rect.coverPoints(points) });
  }, [state, orders]);

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

  if (state === "error") {
    return (
      <div className="flex h-[36rem] flex-col items-center justify-center gap-2 px-6 text-center xl:h-[44rem]">
        <Icon name="map" className="text-[28px] text-ink-subtle" />
        <p className="text-body-sm font-medium text-ink">HERE Maps did not load</p>
        <p className="max-w-md text-caption text-ink-subtle">
          Usually the key is restricted to different domains, or the Maps API
          for JavaScript is not enabled on the project.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div ref={holder} className="h-[36rem] w-full xl:h-[44rem]" />
      {state === "loading" ? (
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

function SchematicOrders({ orders }: { orders: Order[] }) {
  const view = useMemo(() => {
    const pts: LatLng[] = [
      { lat: DEPOT.lat, lng: DEPOT.lng },
      ...orders.flatMap((o) => (o.delivery_location ? [o.delivery_location] : [])),
    ];
    const latMid = pts.reduce((n, p) => n + p.lat, 0) / pts.length;
    const origin = {
      lat: Math.max(...pts.map((p) => p.lat)),
      lng: Math.min(...pts.map((p) => p.lng)),
    };
    const project = (p: LatLng) => ({
      x: (p.lng - origin.lng) * kmPerDegLng(latMid),
      y: (origin.lat - p.lat) * KM_PER_DEG_LAT,
    });
    const xy = pts.map(project);
    const pad = 12;
    let minX = Math.min(...xy.map((p) => p.x)) - pad;
    let maxX = Math.max(...xy.map((p) => p.x)) + pad;
    let minY = Math.min(...xy.map((p) => p.y)) - pad;
    let maxY = Math.max(...xy.map((p) => p.y)) + pad;
    if (maxX - minX < 40) [minX, maxX] = [(minX + maxX) / 2 - 20, (minX + maxX) / 2 + 20];
    if (maxY - minY < 40) [minY, maxY] = [(minY + maxY) / 2 - 20, (minY + maxY) / 2 + 20];
    return {
      project,
      viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      unit: (maxX - minX) / 100,
    };
  }, [orders]);

  const u = view.unit;
  const depotXY = view.project({ lat: DEPOT.lat, lng: DEPOT.lng });
  // Red last, so outstanding work draws over finished work.
  const ordered = [...orders].sort((a, b) => Number(isDone(b)) - Number(isDone(a)));

  return (
    <div>
      <svg
        viewBox={view.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="block h-[36rem] w-full xl:h-[44rem]"
        role="img"
        aria-label="Schematic map of order delivery locations"
      >
        <rect
          x={depotXY.x - u * 1.2}
          y={depotXY.y - u * 1.2}
          width={u * 2.4}
          height={u * 2.4}
          fill="var(--color-ink)"
        />
        {ordered.map((o) => {
          if (!o.delivery_location) return null;
          const p = view.project(o.delivery_location);
          const done = isDone(o);
          return (
            <circle
              key={o.id}
              cx={p.x}
              cy={p.y}
              r={u * 0.7}
              fill={done ? "var(--color-ok)" : "var(--color-danger)"}
              stroke="var(--color-surface)"
              strokeWidth={u * 0.15}
            >
              <title>
                {`${o.customer_name} — ${o.delivery_address} (${STATUS_LABEL[o.status]})`}
              </title>
            </circle>
          );
        })}
      </svg>
      <p className="border-t border-hairline px-5 py-2 text-caption text-ink-subtle">
        Schematic — no basemap key is configured, so there are no roads or
        coastline. Distances are to scale.
      </p>
    </div>
  );
}
