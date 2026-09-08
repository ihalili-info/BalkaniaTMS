"use client";

/**
 * The auto-planner's proposal, on the HERE basemap.
 *
 * Same idea as `plan-map.tsx` — depot out to each group's stops and back, one
 * colour per group — but on real roads and coastline, so a dispatcher can see
 * that a group straddles an estuary or that two "nearby" drops are an hour
 * apart by road. The connectors are still **straight lines**: the planner
 * clusters on great-circle distance and drawing a road it did not compute would
 * be a lie, even now that the leg *distances* come off the road network. Falls
 * back to the schematic when there is no Maps key.
 */

import { useEffect, useRef, useState } from "react";

import { Icon, cx } from "@/components/ui";
import { loadHereMaps, token, type HereNamespace } from "@/lib/maps";
import type { LatLng } from "@/lib/types";

import type { PlanMapGroup } from "@/components/plan-map";

export function PlanHereMap({
  apiKey,
  depot,
  groups,
  heightClass = "h-[24rem]",
}: {
  apiKey: string;
  depot: LatLng;
  groups: PlanMapGroup[];
  /** Tailwind height for the map canvas. Taller in the side-by-side layout. */
  heightClass?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<HereNamespace>(null);
  const hRef = useRef<HereNamespace>(null);
  const drawn = useRef<HereNamespace[]>([]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

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
    // depot is a stable constant; groups changing must not recreate the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // --- overlays --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const H = hRef.current;
    if (status !== "ready" || !map || !H) return;

    for (const object of drawn.current) map.removeObject(object);
    drawn.current = [];

    const ink = token("--color-ink", "#0e1725");
    const surface = token("--color-surface", "#ffffff");

    const points: LatLng[] = [depot];

    const icon = (markup: string, size: number, anchor: number) =>
      new H.map.Icon(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${markup}</svg>`,
        { anchor: new H.math.Point(anchor, anchor) },
      );

    const add = (object: HereNamespace) => {
      map.addObject(object);
      drawn.current.push(object);
    };

    // Depot — a dark square, distinct from the round stop markers.
    add(
      new H.map.Marker(depot, {
        icon: icon(
          `<rect x="3" y="3" width="14" height="14" fill="${ink}" stroke="${surface}" stroke-width="2"/>`,
          20,
          10,
        ),
        data: { title: "Depot" },
        zIndex: 100,
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
      points.push(...path);

      const line = new H.geo.LineString();
      for (const p of path) line.pushPoint(p);

      add(
        new H.map.Polyline(line, {
          style: g.dropped
            ? { strokeColor: colour, lineWidth: 2, lineDash: [5, 5] }
            : { strokeColor: colour, lineWidth: 3 },
          // A dropped group stays on the map at half strength: seeing what you
          // just removed, and where it was, is the point of the review step.
          volatility: false,
        }),
      );

      g.stops.forEach((s, i) => {
        add(
          new H.map.Marker(
            { lat: s.lat, lng: s.lng },
            {
              icon: icon(
                `<circle cx="11" cy="11" r="9" fill="${colour}" stroke="${surface}" stroke-width="1.5" opacity="${
                  g.dropped ? 0.4 : 1
                }"/>` +
                  `<text x="11" y="15" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fff" opacity="${
                    g.dropped ? 0.4 : 1
                  }">${i + 1}</text>`,
                22,
                11,
              ),
              data: {
                title: `Group ${g.index + 1} · stop ${i + 1} — ${s.name}`,
              },
              zIndex: g.dropped ? 5 : 20,
            },
          ),
        );
      });
    }

    if (points.length > 0) {
      map.getViewModel().setLookAtData({ bounds: H.geo.Rect.coverPoints(points) });
    }
  }, [status, depot, groups]);

  // --- teardown -------------------------------------------------------
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
      <div className={cx("flex flex-col items-center justify-center gap-2 rounded-lg border border-hairline bg-surface-muted px-6 text-center", heightClass)}>
        <Icon name="map" className="text-[26px] text-ink-subtle" />
        <p className="text-body-sm font-medium text-ink">HERE Maps did not load</p>
        <p className="max-w-md text-caption text-ink-subtle">
          Usually the key is restricted to a different domain, or the Maps API
          for JavaScript is not enabled on the project. The browser console has
          HERE&rsquo;s own error.
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
