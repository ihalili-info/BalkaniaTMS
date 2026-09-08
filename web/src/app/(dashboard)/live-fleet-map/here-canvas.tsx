"use client";

/**
 * The Live Fleet Map's basemap, on HERE.
 *
 * The overlays are the same three things the schematic drew — truck, next
 * stop, and the 5 km geofence ring around it — but on real roads, so a
 * dispatcher can see *whether the truck is actually on the motorway* rather
 * than just how far it is as the crow flies.
 *
 * The geofence circle is drawn with `H.map.Circle`, whose radius is in metres
 * on the sphere. That matters: it is the same 5 000 m the alert engine compares
 * against, not a scaled approximation of it.
 *
 * **Markers carry their own artwork.** HERE has no equivalent of Google's
 * marker `label`, so the truck's plate is drawn into the marker SVG rather than
 * layered on top of it. Everything else maps across one-for-one.
 */

import { useEffect, useRef, useState } from "react";

import { Icon, cx } from "@/components/ui";
import { GEOFENCE_RADIUS_M, loadForTruck, nextStop } from "@/lib/fleet-selectors";
import { DEPOT } from "@/lib/geo/reference";
import { MAP_DEFAULT_ZOOM, loadHereMaps, token, type HereNamespace } from "@/lib/maps";
import type { LoadView, Order, Truck } from "@/lib/types";

/** Escapes text before it goes into a marker's SVG. A plate is user data. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A design token at partial opacity.
 *
 * HERE's style objects take a single colour string with no separate opacity
 * field, unlike Google's `fillOpacity` / `strokeOpacity`. The tokens resolve to
 * `#rrggbb`, so the alpha is appended as the fourth hex pair. Anything that is
 * not a six-digit hex (a token someone later writes as `oklch(...)`) is handed
 * back untouched rather than mangled into an invalid colour.
 */
function alpha(color: string, opacity: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const byte = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return `${color}${byte.toString(16).padStart(2, "0")}`;
}

export function HereCanvas({
  apiKey,
  trucks,
  loads,
  pendingOrders,
  selectedId,
  onSelect,
  heightClass = "h-[30rem]",
}: {
  apiKey: string;
  trucks: Truck[];
  loads: LoadView[];
  /** CRM demand not yet on a load. Only the geocoded ones. */
  pendingOrders: Order[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Tailwind height for the map canvas. Taller now the map is full width. */
  heightClass?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<HereNamespace>(null);
  const hRef = useRef<HereNamespace>(null);
  /** Every object we added, so a redraw can remove exactly its own. */
  const drawn = useRef<HereNamespace[]>([]);
  // Kept in a ref so re-drawing overlays does not need `onSelect` in its
  // dependency list — a new inline callback each render would redraw the whole
  // map on every parent update and make markers flicker.
  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  }, [onSelect]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // A ref, not state: nothing renders from it, and flipping state inside the
  // overlay effect would re-run the effect purely to observe its own write.
  const fitted = useRef(false);

  // --- create the map once -------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    loadHereMaps()
      .then((H: HereNamespace) => {
        if (cancelled || !holder.current || mapRef.current) return;
        hRef.current = H;

        const platform = new H.service.Platform({ apiKey });
        const layers = platform.createDefaultLayers();
        const map = new H.Map(holder.current, layers.vector.normal.map, {
          center: { lat: DEPOT.lat, lng: DEPOT.lng },
          zoom: MAP_DEFAULT_ZOOM,
          pixelRatio: window.devicePixelRatio || 1,
        });

        // Pan, scroll-zoom and pinch. Without this the map is a static image.
        new H.mapevents.Behavior(new H.mapevents.MapEvents(map));
        H.ui.UI.createDefault(map, layers);

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
  }, [apiKey]);

  // --- overlays ------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const H = hRef.current;
    if (status !== "ready" || !map || !H) return;

    const brand = token("--color-brand", "#2f4bd6");
    const warn = token("--color-warn", "#b26a00");
    const ink = token("--color-ink", "#1c2126");
    const inkSubtle = token("--color-ink-subtle", "#7b8798");
    const danger = token("--color-danger", "#c33227");
    const surface = token("--color-surface", "#ffffff");

    // Clear what the previous pass drew. HERE objects are not React — nothing
    // is reconciled for us, so anything left attached stays on screen.
    for (const object of drawn.current) map.removeObject(object);
    drawn.current = [];

    const points: { lat: number; lng: number }[] = [];

    const icon = (markup: string, w: number, h: number, ax: number, ay: number) =>
      new H.map.Icon(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${markup}</svg>`,
        { anchor: new H.math.Point(ax, ay) },
      );

    const add = (object: HereNamespace) => {
      map.addObject(object);
      drawn.current.push(object);
      return object;
    };

    // Depot — a square, so it never reads as a vehicle or a stop.
    add(
      new H.map.Marker(
        { lat: DEPOT.lat, lng: DEPOT.lng },
        {
          icon: icon(
            `<rect x="3" y="3" width="14" height="14" fill="${ink}" stroke="${surface}" stroke-width="2"/>`,
            20,
            20,
            10,
            10,
          ),
          data: { title: DEPOT.label },
          zIndex: 10,
        },
      ),
    );
    points.push({ lat: DEPOT.lat, lng: DEPOT.lng });

    // Pending orders — CRM demand not yet on a load. Hollow, deliberately not a
    // filled dot, so a pending order never reads as a truck or an active stop
    // at a glance. Drawn before trucks so a truck marker on top always wins.
    for (const order of pendingOrders) {
      if (!order.delivery_location) continue;
      points.push(order.delivery_location);
      add(
        new H.map.Marker(order.delivery_location, {
          icon: icon(
            `<circle cx="8" cy="8" r="6" fill="none" stroke="${danger}" stroke-width="2"/>`,
            16,
            16,
            8,
            8,
          ),
          data: {
            title: `${order.customer_name} — ${order.delivery_address} (pending, not yet on a load)`,
          },
          zIndex: 15,
        }),
      );
    }

    for (const truck of trucks) {
      if (!truck.current_location) continue;
      const at = truck.current_location;
      const active = truck.id === selectedId;
      const load = loadForTruck(loads, truck.id);
      const stop = load ? nextStop(load) : undefined;
      const target = stop?.order.delivery_location ?? null;
      const inFence =
        stop?.distance_m != null && stop.distance_m <= GEOFENCE_RADIUS_M;

      points.push(at);

      if (target) {
        points.push(target);

        add(
          // The alert radius itself, in metres — not a drawing convenience.
          // Same 5 000 m `isApproaching()` compares against.
          new H.map.Circle(target, GEOFENCE_RADIUS_M, {
            style: {
              fillColor: alpha(inFence ? warn : brand, active ? 0.14 : 0.06),
              strokeColor: alpha(inFence ? warn : brand, active ? 0.7 : 0.28),
              lineWidth: 1,
            },
          }),
        );

        // Straight-line leg, drawn dashed so it never reads as a routed path.
        // The routed ETA is a number on the board, not a shape on the map —
        // painting a road here the truck may not be taking would be a lie.
        const line = new H.geo.LineString();
        line.pushPoint(at);
        line.pushPoint(target);
        add(
          new H.map.Polyline(line, {
            style: {
              strokeColor: alpha(brand, active ? 0.85 : 0.3),
              lineWidth: 2,
              lineDash: [4, 4],
              lineCap: "round",
            },
          }),
        );

        add(
          new H.map.Marker(target, {
            icon: icon(
              // A teardrop pin, not a dot — the delivery stop is a fixed place
              // a truck is heading *to*, and it needs to read differently from
              // the round vehicle markers at a glance. Anchored at its tip so
              // the point, not the centre, sits on the coordinate.
              `<path d="M12 22s8-4.5 8-11.8A8 8 0 1 0 4 10.2C4 17.5 12 22 12 22z" fill="${
                active ? ink : inkSubtle
              }" stroke="${surface}" stroke-width="1.5"/>`,
              24,
              24,
              12,
              22,
            ),
            data: {
              title: `${stop?.order.customer_name ?? "Stop"} — ${stop?.order.delivery_address ?? ""}`,
            },
            zIndex: 20,
          }),
        );
      }

      // The truck, with its plate drawn into the icon — HERE has no marker
      // label, so the plate rides along as part of the artwork.
      const plate = esc(truck.license_plate);
      const marker = new H.map.Marker(at, {
        icon: icon(
          `<text x="60" y="14" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="${
            active ? 700 : 500
          }" fill="${ink}" stroke="${surface}" stroke-width="3" paint-order="stroke">${plate}</text>` +
            `<circle cx="60" cy="32" r="${active ? 9 : 7}" fill="${brand}" stroke="${surface}" stroke-width="${
              active ? 3 : 2
            }"/>`,
          120,
          44,
          60,
          32,
        ),
        data: { title: truck.license_plate, truckId: truck.id },
        zIndex: active ? 60 : 40,
      });
      marker.addEventListener("tap", () => select.current(truck.id));
      add(marker);
    }

    // Fit once. Re-fitting on every fix would yank the view out from under a
    // dispatcher who has zoomed in on one truck.
    if (!fitted.current && points.length > 0) {
      if (
        trucks.some((t) => t.current_location) ||
        pendingOrders.some((o) => o.delivery_location)
      ) {
        map.getViewModel().setLookAtData({
          bounds: H.geo.Rect.coverPoints(points),
        });
      }
      fitted.current = true;
    }
  }, [status, trucks, loads, pendingOrders, selectedId]);

  // --- follow the selection ------------------------------------------------
  // Frames the truck *and* its next stop, not just the truck — picking a load
  // from the "Active loads" list is a request to see where it's headed, and a
  // plain pan can leave that pin off the edge of the viewport.
  useEffect(() => {
    const map = mapRef.current;
    const H = hRef.current;
    if (status !== "ready" || !map || !H || !selectedId) return;
    const truck = trucks.find((t) => t.id === selectedId);
    if (!truck?.current_location) return;

    const load = loadForTruck(loads, truck.id);
    const target = load ? nextStop(load)?.order.delivery_location : undefined;

    if (target) {
      map.getViewModel().setLookAtData({
        bounds: H.geo.Rect.coverPoints([truck.current_location, target]),
      });
    } else {
      map.setCenter(truck.current_location, true);
    }
  }, [status, selectedId, trucks, loads]);

  // --- teardown ------------------------------------------------------------
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
      <div className={cx("flex flex-col items-center justify-center gap-2 bg-surface-muted px-6 text-center", heightClass)}>
        <Icon name="map" className="text-[28px] text-ink-subtle" />
        <p className="text-body-sm font-medium text-ink">
          HERE Maps did not load
        </p>
        <p className="max-w-md text-caption text-ink-subtle">
          Usually the key is restricted to different domains, or the Maps API
          for JavaScript is not enabled on the project. The browser console
          carries HERE&rsquo;s own error, which names which of the two it is.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
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
