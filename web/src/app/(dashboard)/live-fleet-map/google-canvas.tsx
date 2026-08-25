"use client";

/**
 * The Live Fleet Map's basemap, on Google Maps.
 *
 * The overlays are the same three things the schematic drew — truck, next
 * stop, and the 5 km geofence ring around it — but on real roads, so a
 * dispatcher can see *whether the truck is actually on the motorway* rather
 * than just how far it is as the crow flies.
 *
 * The geofence circle is drawn with `google.maps.Circle`, whose radius is in
 * metres on the sphere. That matters: it is the same 5 000 m the alert engine
 * compares against, not a scaled approximation of it.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui";
import { GEOFENCE_RADIUS_M, loadForTruck, nextStop } from "@/lib/fleet-selectors";
import { DEPOT } from "@/lib/geo/reference";
import { MAP_DEFAULT_ZOOM, loadGoogleMaps, token } from "@/lib/maps";
import type { LoadView, Order, Truck } from "@/lib/types";

/** Every overlay we own, so a redraw can dispose of exactly its own objects. */
interface Drawn {
  markers: google.maps.Marker[];
  shapes: (google.maps.Circle | google.maps.Polyline)[];
}

export function GoogleCanvas({
  apiKey,
  trucks,
  loads,
  pendingOrders,
  selectedId,
  onSelect,
}: {
  apiKey: string;
  trucks: Truck[];
  loads: LoadView[];
  /** CRM demand not yet on a load. Only the geocoded ones. */
  pendingOrders: Order[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const drawn = useRef<Drawn>({ markers: [], shapes: [] });
  // Kept in a ref so re-drawing overlays does not need `onSelect` in its
  // dependency list — a new inline callback each render would redraw the whole
  // map on every parent update and make markers flicker.
  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  }, [onSelect]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [fitted, setFitted] = useState(false);

  // --- create the map once -------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps(apiKey)
      .then((maps) => {
        if (cancelled || !holder.current || mapRef.current) return;
        mapRef.current = new maps.Map(holder.current, {
          center: { lat: DEPOT.lat, lng: DEPOT.lng },
          zoom: MAP_DEFAULT_ZOOM,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          // Points of interest are noise for dispatch — the useful labels are
          // roads and towns.
          styles: [
            {
              featureType: "poi",
              elementType: "labels",
              stylers: [{ visibility: "off" }],
            },
            {
              featureType: "transit",
              elementType: "labels",
              stylers: [{ visibility: "off" }],
            },
          ],
        });
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
    if (status !== "ready" || !map) return;

    const maps = window.google.maps;
    const brand = token("--color-brand", "#2f4bd6");
    const warn = token("--color-warn", "#b26a00");
    const ink = token("--color-ink", "#1c2126");
    const inkSubtle = token("--color-ink-subtle", "#7b8798");
    const surface = token("--color-surface", "#ffffff");

    // Clear what the previous pass drew. Google overlays are not React —
    // nothing is reconciled for us, so anything left attached stays on screen.
    for (const m of drawn.current.markers) m.setMap(null);
    for (const s of drawn.current.shapes) s.setMap(null);
    drawn.current = { markers: [], shapes: [] };

    const bounds = new maps.LatLngBounds();
    let anyPoint = false;

    const dot = (fill: string, scale: number, strokeWeight = 2) => ({
      path: maps.SymbolPath.CIRCLE,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: surface,
      strokeWeight,
      scale,
      // Symbol space is multiplied by `scale`, so this lifts the plate clear of
      // the dot instead of printing it through the middle of it.
      labelOrigin: new maps.Point(0, -2.6),
    });

    // Hollow — deliberately not a filled dot, so a pending order never reads
    // as a truck or an active stop at a glance.
    const ring = (stroke: string, scale: number) => ({
      path: maps.SymbolPath.CIRCLE,
      fillOpacity: 0,
      strokeColor: stroke,
      strokeWeight: 2,
      scale,
    });

    // A teardrop pin, not a dot — the delivery stop is a fixed place a truck
    // is heading *to*, and it needs to read differently from the round
    // vehicle markers at a glance, not just in a different colour. Anchored
    // at its own tip (12, 22) so the point, not the icon's centre, sits on
    // the coordinate.
    const PIN_PATH =
      "M12 22s8-4.5 8-11.8A8 8 0 1 0 4 10.2C4 17.5 12 22 12 22z";
    const pin = (fill: string, scale: number) => ({
      path: PIN_PATH,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: surface,
      strokeWeight: 1.5,
      scale,
      anchor: new maps.Point(12, 22),
    });

    // Depot.
    drawn.current.markers.push(
      new maps.Marker({
        map,
        position: { lat: DEPOT.lat, lng: DEPOT.lng },
        title: "Ballymount depot",
        zIndex: 10,
        icon: {
          path: "M -7 -7 H 7 V 7 H -7 Z",
          fillColor: ink,
          fillOpacity: 1,
          strokeColor: surface,
          strokeWeight: 2,
        },
      }),
    );
    bounds.extend({ lat: DEPOT.lat, lng: DEPOT.lng });
    anyPoint = true;

    // Pending orders — CRM demand not yet on a load. Drawn before trucks so a
    // truck marker sitting on top of one always wins visually.
    for (const order of pendingOrders) {
      if (!order.delivery_location) continue;
      bounds.extend(order.delivery_location);
      anyPoint = true;

      drawn.current.markers.push(
        new maps.Marker({
          map,
          position: order.delivery_location,
          title: `${order.customer_name} — ${order.delivery_address} (pending, not yet on a load)`,
          zIndex: 15,
          icon: ring(inkSubtle, 6),
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

      bounds.extend(at);
      anyPoint = true;

      if (target) {
        bounds.extend(target);

        drawn.current.shapes.push(
          new maps.Circle({
            map,
            center: target,
            // The alert radius itself, in metres — not a drawing convenience.
            radius: GEOFENCE_RADIUS_M,
            fillColor: inFence ? warn : brand,
            fillOpacity: active ? 0.14 : 0.06,
            strokeColor: inFence ? warn : brand,
            strokeOpacity: active ? 0.7 : 0.28,
            strokeWeight: 1,
            clickable: false,
          }),
        );

        // Straight-line leg, drawn dashed so it never reads as a routed path.
        // We do not have a routing API, and pretending otherwise would put a
        // road on the screen the truck is not taking.
        drawn.current.shapes.push(
          new maps.Polyline({
            map,
            path: [at, target],
            strokeOpacity: 0,
            clickable: false,
            icons: [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: active ? 0.85 : 0.3,
                  strokeColor: brand,
                  strokeWeight: 2,
                  scale: 3,
                },
                offset: "0",
                repeat: "12px",
              },
            ],
          }),
        );

        drawn.current.markers.push(
          new maps.Marker({
            map,
            position: target,
            title: `${stop?.order.customer_name ?? "Stop"} — ${stop?.order.delivery_address ?? ""}`,
            zIndex: 20,
            icon: pin(active ? ink : inkSubtle, active ? 1.3 : 1.1),
          }),
        );
      }

      const marker = new maps.Marker({
        map,
        position: at,
        title: truck.license_plate,
        zIndex: active ? 60 : 40,
        icon: dot(brand, active ? 9 : 7, active ? 3 : 2),
        label: {
          text: truck.license_plate,
          className: "gmap-plate",
          color: ink,
          fontSize: "11px",
          fontWeight: active ? "700" : "500",
        },
      });
      marker.addListener("click", () => select.current(truck.id));
      drawn.current.markers.push(marker);
    }

    // Fit once. Re-fitting on every fix would yank the view out from under a
    // dispatcher who has zoomed in on one truck.
    if (!fitted && anyPoint) {
      if (
        trucks.some((t) => t.current_location) ||
        pendingOrders.some((o) => o.delivery_location)
      ) {
        map.fitBounds(bounds, 48);
      }
      setFitted(true);
    }
  }, [status, trucks, loads, pendingOrders, selectedId, fitted]);

  // --- follow the selection ------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (status !== "ready" || !map || !selectedId) return;
    const truck = trucks.find((t) => t.id === selectedId);
    if (truck?.current_location) map.panTo(truck.current_location);
  }, [status, selectedId, trucks]);

  // --- teardown ------------------------------------------------------------
  useEffect(
    () => () => {
      for (const m of drawn.current.markers) m.setMap(null);
      for (const s of drawn.current.shapes) s.setMap(null);
      drawn.current = { markers: [], shapes: [] };
    },
    [],
  );

  if (status === "error") {
    return (
      <div className="flex h-[30rem] flex-col items-center justify-center gap-2 bg-surface-muted px-6 text-center">
        <Icon name="map" className="text-[28px] text-ink-subtle" />
        <p className="text-body-sm font-medium text-ink">
          Google Maps did not load
        </p>
        <p className="max-w-md text-caption text-ink-subtle">
          Usually the key is restricted to different referrers, or the Maps
          JavaScript API is not enabled on the project. The browser console
          carries Google&rsquo;s own error, which names which of the two it is.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div ref={holder} className="h-[30rem] w-full" />
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
