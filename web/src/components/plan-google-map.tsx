"use client";

/**
 * The auto-planner's proposal, on the Google basemap.
 *
 * Same idea as `plan-map.tsx` — depot out to each group's stops and back, one
 * colour per group — but on real roads and coastline, so a dispatcher can see
 * that a group straddles an estuary or that two "nearby" drops are an hour
 * apart by road. The connectors are still **straight lines**: the planner
 * sequences on great-circle distance and drawing a road it did not compute
 * would be a lie. Falls back to the schematic when there is no Maps key.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui";
import { loadGoogleMaps, token } from "@/lib/maps";
import type { LatLng } from "@/lib/types";

import type { PlanMapGroup } from "@/components/plan-map";

export function PlanGoogleMap({
  apiKey,
  depot,
  groups,
}: {
  apiKey: string;
  depot: LatLng;
  groups: PlanMapGroup[];
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const drawn = useRef<{
    markers: google.maps.Marker[];
    lines: google.maps.Polyline[];
  }>({ markers: [], lines: [] });

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // --- create the map once ----------------------------------------------
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((maps) => {
        if (cancelled || !holder.current || mapRef.current) return;
        mapRef.current = new maps.Map(holder.current, {
          center: depot,
          zoom: 8,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          styles: [
            { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
            { featureType: "transit", elementType: "labels", stylers: [{ visibility: "off" }] },
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
    // depot is a stable constant; groups changing must not recreate the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // --- overlays --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (status !== "ready" || !map) return;
    const maps = window.google.maps;

    for (const m of drawn.current.markers) m.setMap(null);
    for (const l of drawn.current.lines) l.setMap(null);
    drawn.current = { markers: [], lines: [] };

    const bounds = new maps.LatLngBounds();
    bounds.extend(depot);

    const ink = token("--color-ink", "#0e1725");
    const surface = token("--color-surface", "#ffffff");

    // Depot — a dark square, distinct from the round stop markers.
    drawn.current.markers.push(
      new maps.Marker({
        map,
        position: depot,
        title: "Depot",
        zIndex: 100,
        icon: {
          path: "M -7 -7 H 7 V 7 H -7 Z",
          fillColor: ink,
          fillOpacity: 1,
          strokeColor: surface,
          strokeWeight: 2,
        },
      }),
    );

    // Kept groups drawn last so they sit above dropped ones.
    for (const g of [...groups].sort((a, b) => Number(b.dropped) - Number(a.dropped))) {
      const colour = token(g.colour.token, g.colour.hex);
      const path: LatLng[] = [
        depot,
        ...g.stops.map((s) => ({ lat: s.lat, lng: s.lng })),
        depot,
      ];
      for (const p of path) bounds.extend(p);

      const lineOpts: google.maps.PolylineOptions = g.dropped
        ? {
            map,
            path,
            // A dashed line: transparent stroke with repeating dash symbols.
            strokeOpacity: 0,
            clickable: false,
            icons: [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: 0.5,
                  strokeColor: colour,
                  strokeWeight: 2,
                  scale: 3,
                },
                offset: "0",
                repeat: "14px",
              },
            ],
          }
        : {
            map,
            path,
            strokeColor: colour,
            strokeOpacity: 0.9,
            strokeWeight: 3,
            clickable: false,
          };
      drawn.current.lines.push(new maps.Polyline(lineOpts));

      g.stops.forEach((s, i) => {
        drawn.current.markers.push(
          new maps.Marker({
            map,
            position: { lat: s.lat, lng: s.lng },
            title: `Group ${g.index + 1} · stop ${i + 1} — ${s.name}`,
            opacity: g.dropped ? 0.4 : 1,
            zIndex: g.dropped ? 5 : 20,
            icon: {
              path: maps.SymbolPath.CIRCLE,
              fillColor: colour,
              fillOpacity: 1,
              strokeColor: surface,
              strokeWeight: 1.5,
              scale: 9,
            },
            label: {
              text: String(i + 1),
              color: "#fff",
              fontSize: "11px",
              fontWeight: "700",
            },
          }),
        );
      });
    }

    map.fitBounds(bounds, 56);
  }, [status, depot, groups]);

  // --- teardown -------------------------------------------------------
  useEffect(
    () => () => {
      for (const m of drawn.current.markers) m.setMap(null);
      for (const l of drawn.current.lines) l.setMap(null);
      drawn.current = { markers: [], lines: [] };
    },
    [],
  );

  if (status === "error") {
    return (
      <div className="flex h-[24rem] flex-col items-center justify-center gap-2 rounded-lg border border-hairline bg-surface-muted px-6 text-center">
        <Icon name="map" className="text-[26px] text-ink-subtle" />
        <p className="text-body-sm font-medium text-ink">Google Maps did not load</p>
        <p className="max-w-md text-caption text-ink-subtle">
          Usually the key is referrer-restricted to a different host, or the Maps
          JavaScript API is not enabled. The browser console has Google&rsquo;s
          own error.
        </p>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-hairline">
      <div ref={holder} className="h-[24rem] w-full" />
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
