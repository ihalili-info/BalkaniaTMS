"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  Badge,
  Button,
  CountryChip,
  CustomsBadge,
  Field,
  Icon,
  controlClass,
  cx,
} from "@/components/ui";
import {
  commitPlan,
  geocodeOrders,
  roadLegsForGroups,
  type GeocodeLine,
} from "@/lib/data/mutations";
import { coordKey, formatDistance } from "@/lib/format";
import { formatDuration } from "@/lib/driver-hours";
import { DEPOT } from "@/lib/geo/reference";
import {
  DEFAULT_PLANNER_OPTIONS,
  SKIP_MESSAGE,
  planLoads,
  type PlannerGeometry,
  type PlannerOptions,
  type ProposedLoad,
} from "@/lib/load-planner";
import { HOME_COUNTRY, requiresCmr } from "@/lib/regions";
import { PlanMap, groupColour, type PlanMapGroup } from "@/components/plan-map";
import { PlanGoogleMap } from "@/components/plan-google-map";
import type { LatLng, Order, RouteLeg, Truck } from "@/lib/types";

/** Stable reference so map effects do not redraw on every render. */
const DEPOT_LATLNG: LatLng = { lat: DEPOT.lat, lng: DEPOT.lng };

/**
 * Road legs bought from Google, held for the life of the page.
 *
 * Deliberately outside the component: the dialog unmounts when it closes, so
 * per-mount state meant closing and reopening it re-bought every leg. A leg is
 * safe to keep — `routeMatrix` is traffic-unaware, so the road distance
 * between two fixed points does not drift, and correcting an address moves the
 * coordinate and therefore the key.
 */
const legCache: Record<string, RouteLeg> = {};

/** Groups already paid for, so a second look at the same one is free. */
const boughtGroups = new Set<string>();

const groupKey = (orderIds: string[]) => [...orderIds].sort().join(",");

/**
 * Auto-plan: geocode, then group by geography, then review.
 *
 * Three steps rather than one button, because the middle one is where the
 * judgement lives. The grouping is straight-line only — it has no road
 * network, no drive times and no ferries — so the last screen is a proposal a
 * dispatcher accepts, adjusts or throws away, and the dialog says so in the
 * place where it would be tempting to forget.
 */
export function AutoPlanDialog({
  orders,
  trucks,
  loadRefByOrderId,
  geocodingReady,
  mapsKey = null,
  onClose,
}: {
  /** The selected orders. */
  orders: Order[];
  trucks: Truck[];
  loadRefByOrderId: Record<string, string>;
  /** Whether GEOCODING_API_KEY is set — the button is honest about it if not. */
  geocodingReady: boolean;
  /** Google Maps browser key. Absent → the schematic map. */
  mapsKey?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [view, setView] = useState<"list" | "map">("list");
  const [options, setOptions] = useState<PlannerOptions>(DEFAULT_PLANNER_OPTIONS);
  const [geocodeLines, setGeocodeLines] = useState<GeocodeLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Dispatcher-adjusted stop sequence per group, keyed by group index (same
  // keying as `dropped`/`overrides`). Holds the ordered stop ids; discarded
  // in favour of the planner's own order the moment the group's stop set no
  // longer matches (a radius/max-stops change, or a drop being removed) —
  // see `orderedStops`.
  const [stopOrder, setStopOrder] = useState<Record<number, string[]>>({});
  const [geocoding, startGeocode] = useTransition();
  const [creating, startCreate] = useTransition();

  const onLoad = useMemo(
    () => new Set(Object.keys(loadRefByOrderId)),
    [loadRefByOrderId],
  );

  // Orders the dispatcher pulled out of this plan. They stay in the queue,
  // never committed, and the grouping recomputes without them — so removing a
  // far-flung drop can tighten the groups that remain.
  const plannableOrders = useMemo(
    () => orders.filter((o) => !excluded.has(o.id)),
    [orders, excluded],
  );
  const excludedOrders = useMemo(
    () => orders.filter((o) => excluded.has(o.id)),
    [orders, excluded],
  );

  const excludeOrder = (id: string) =>
    setExcluded((prev) => new Set(prev).add(id));
  const restoreOrder = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const missing = plannableOrders.filter(
    (o) => o.delivery_location === null && !onLoad.has(o.id),
  );

  // Seeded from the session cache, so reopening the dialog costs nothing for
  // groups already paid for.
  const [legs, setLegs] = useState<Record<string, RouteLeg>>(() => ({
    ...legCache,
  }));
  const [routingNote, setRoutingNote] = useState<string | null>(null);
  const [routing, startRouting] = useTransition();

  // A free pass with no road geometry, purely to learn the groups. `cluster()`
  // compares against a straight-line centroid, so the grouping it produces is
  // the same one the routed plan below will land on — and because this pass
  // never reads `legs`, buying legs cannot change it. That is what stops a
  // fetch → replan → fetch loop.
  const freePlan = useMemo(
    () =>
      planLoads({
        orders: plannableOrders,
        trucks,
        depot: DEPOT_LATLNG,
        originCountry: HOME_COUNTRY,
        onLoadOrderIds: onLoad,
        options,
      }),
    [plannableOrders, trucks, onLoad, options],
  );

  useEffect(() => {
    const wanted = freePlan.loads
      .map((load) => load.stops.map((s) => s.id))
      .filter((ids) => ids.length > 0);
    const unbought = wanted.filter((ids) => !boughtGroups.has(groupKey(ids)));
    if (unbought.length === 0) return;

    // Debounced, because the radius slider fires on every 5 km step and each
    // step regroups. Buying on every intermediate grouping would cost more
    // than the whole-matrix approach this replaced; only the setting the
    // dispatcher actually settles on gets paid for.
    const timer = setTimeout(() => {
      startRouting(async () => {
        const result = await roadLegsForGroups(unbought);
        // Marked bought even on failure: retrying on every render would bill
        // Google in a loop, and a group with no legs simply straight-lines.
        for (const ids of unbought) boughtGroups.add(groupKey(ids));
        Object.assign(legCache, result.legs);
        setLegs((prev) => ({ ...prev, ...result.legs }));
        setRoutingNote(result.message);
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [freePlan]);

  const geometry = useMemo<PlannerGeometry>(
    () =>
      Object.keys(legs).length === 0
        ? {}
        : { leg: (a, b) => legs[`${coordKey(a)}|${coordKey(b)}`] ?? null },
    [legs],
  );
  const routed = Object.keys(legs).length > 0;

  const plan = useMemo(
    () =>
      planLoads({
        orders: plannableOrders,
        trucks,
        depot: DEPOT_LATLNG,
        originCountry: HOME_COUNTRY,
        onLoadOrderIds: onLoad,
        options,
        geometry,
      }),
    [plannableOrders, trucks, onLoad, options, geometry],
  );

  const kept = plan.loads
    .map((load, index) => ({ load, index }))
    .filter(({ index }) => !dropped.has(index));

  // The planner's own sequence, unless the dispatcher has dragged stops
  // around for this group *and* the set of stop ids still matches — if a
  // stop was removed or the groups recomputed, the manual order no longer
  // applies to anything and the planner's order wins again.
  const orderedStops = (load: ProposedLoad, index: number) => {
    const manual = stopOrder[index];
    if (!manual || manual.length !== load.stops.length) return load.stops;
    const byId = new Map(load.stops.map((s) => [s.id, s]));
    if (!manual.every((id) => byId.has(id))) return load.stops;
    return manual.map((id) => byId.get(id)!);
  };

  const moveStop = (load: ProposedLoad, index: number, stopId: string, direction: -1 | 1) => {
    const current = orderedStops(load, index).map((s) => s.id);
    const pos = current.indexOf(stopId);
    const swapWith = pos + direction;
    if (pos === -1 || swapWith < 0 || swapWith >= current.length) return;
    const next = [...current];
    [next[pos], next[swapWith]] = [next[swapWith], next[pos]];
    setStopOrder((prev) => ({ ...prev, [index]: next }));
  };

  const mapGroups: PlanMapGroup[] = plan.loads.map((load, index) => ({
    index,
    colour: groupColour(index),
    dropped: dropped.has(index),
    stops: orderedStops(load, index).map((s) => ({
      lat: s.delivery_location!.lat,
      lng: s.delivery_location!.lng,
      name: s.customer_name,
    })),
  }));

  const truckFor = (load: ProposedLoad, index: number) =>
    overrides[index] ?? load.truck?.id ?? "";

  const creatable = kept.filter(({ load, index }) => truckFor(load, index) !== "");

  const runGeocode = () =>
    startGeocode(async () => {
      setError(null);
      const result = await geocodeOrders(missing.map((o) => o.id));
      setGeocodeLines(result.lines);
      if (!result.ok) setError(result.message);
      // Refresh so the newly located orders arrive as props and the plan below
      // recomputes against real coordinates rather than the stale set.
      router.refresh();
    });

  const runCreate = () =>
    startCreate(async () => {
      setError(null);
      const result = await commitPlan(
        creatable.map(({ load, index }) => ({
          truckId: truckFor(load, index),
          orderIds: orderedStops(load, index).map((s) => s.id),
          cmrNumber: null,
        })),
      );
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        setError(result.message ?? "Could not create the loads.");
      }
    });

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Auto-plan loads"
        className="fixed inset-x-3 top-[2vh] z-50 mx-auto flex max-h-[96vh] max-w-[100rem] flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <p className="font-mono text-label uppercase text-ink-subtle">
              Dispatch
            </p>
            <h2 className="text-title text-ink">Auto-plan loads</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Groups{" "}
              {excluded.size > 0
                ? `${plannableOrders.length} of ${orders.length} selected orders`
                : `${orders.length} selected order${orders.length === 1 ? "" : "s"}`}{" "}
              by how close the drops are, and sequences each run from the depot
              outwards. Use the arrows to move a drop up or down, or the ✕ to
              remove it and leave it in the queue.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="close" className="text-[20px]" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* --- step 1: coordinates ------------------------------------- */}
          {missing.length > 0 ? (
            <section className="mb-5 rounded-lg border border-warn-border bg-warn-soft px-4 py-3">
              <p className="flex items-start gap-2 text-body-sm text-ink">
                <Icon name="wrong_location" className="mt-px text-[18px] text-warn" />
                <span>
                  <strong>{missing.length}</strong> of these have no
                  coordinates, so they cannot be grouped — grouping is entirely
                  geographic. They are left in the queue, never guessed at.
                </span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  icon={geocoding ? "progress_activity" : "explore_nearby"}
                  disabled={geocoding || !geocodingReady}
                  onClick={runGeocode}
                  title={
                    geocodingReady
                      ? "Resolve these addresses with Google Geocoding"
                      : "GEOCODING_API_KEY is not set on this deployment"
                  }
                >
                  {geocoding
                    ? "Geocoding…"
                    : `Geocode ${missing.length} address${missing.length === 1 ? "" : "es"}`}
                </Button>
                {!geocodingReady ? (
                  <span className="text-caption text-ink-muted">
                    Needs{" "}
                    <span className="font-mono text-data-sm">
                      GEOCODING_API_KEY
                    </span>{" "}
                    — a server-side key with no referrer restriction. Or place
                    them by hand with Fix addresses.
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}

          {geocodeLines && geocodeLines.length > 0 ? (
            <section className="mb-5 rounded-lg border border-hairline">
              <p className="border-b border-hairline px-4 py-2 text-body-sm font-medium text-ink">
                Geocoding result
              </p>
              <ul className="max-h-48 divide-y divide-hairline overflow-y-auto">
                {geocodeLines.map((line) => (
                  <li
                    key={line.orderId}
                    className="flex items-start gap-3 px-4 py-2"
                  >
                    <Badge tone={line.outcome === "located" ? "ok" : "danger"}>
                      {line.outcome}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-data-sm text-ink">
                        {line.reference}
                      </span>
                      <span className="block truncate text-caption text-ink-muted">
                        Searched:{" "}
                        {line.queried || <em className="text-warn">no address</em>}
                        {line.postcode ? ` · ${line.postcode}` : ""}
                      </span>
                      <span className="block text-caption text-ink-subtle">
                        {line.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* --- step 2: the knobs ---------------------------------------- */}
          <section className="mb-5 grid gap-3 sm:grid-cols-3">
            <Field
              label="Group radius"
              htmlFor="ap-radius"
              hint="How far a drop may sit from the middle of its group"
            >
              <div className="flex items-center gap-2">
                <input
                  id="ap-radius"
                  type="range"
                  min={5}
                  max={300}
                  step={5}
                  value={options.maxRadiusKm}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      maxRadiusKm: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-brand"
                />
                <span className="w-16 shrink-0 text-right font-mono text-data-sm tabular text-ink">
                  {options.maxRadiusKm} km
                </span>
              </div>
            </Field>

            <Field label="Max stops" htmlFor="ap-stops" hint="Per load">
              <input
                id="ap-stops"
                type="number"
                min={1}
                max={20}
                className={controlClass}
                value={options.maxStops}
                onChange={(e) =>
                  setOptions((o) => ({
                    ...o,
                    maxStops: Math.max(1, Math.min(20, Number(e.target.value))),
                  }))
                }
              />
            </Field>

            <Field label="Customs" htmlFor="ap-customs" hint="Recommended on">
              <label
                htmlFor="ap-customs"
                className="flex h-9 items-center gap-2 rounded-sm border border-hairline bg-surface-muted px-3 text-body-sm text-ink-muted"
              >
                <input
                  id="ap-customs"
                  type="checkbox"
                  className="size-3.5 accent-brand"
                  checked={options.separateCustomsRegimes}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      separateCustomsRegimes: e.target.checked,
                    }))
                  }
                />
                Keep regimes apart
              </label>
            </Field>
          </section>

          <p className="mb-4 flex items-start gap-2 rounded-sm border border-hairline bg-surface-muted px-3 py-2.5 text-caption text-ink-muted">
            <Icon
              name={routed ? "route" : "straighten"}
              className="mt-px text-[16px] text-ink-subtle"
            />
            <span>
              {routing ? (
                "Resolving road distances…"
              ) : routed ? (
                <>
                  Distances and drive times are on real roads (Google Routes,
                  live traffic excluded), ferries included. Still a{" "}
                  <strong>car</strong> route — it does not know a 4.0 m bridge
                  or a weight limit, so treat the sequence as a starting point
                  and adjust it on the load.
                </>
              ) : (
                <>
                  Distances are straight lines
                  {routingNote ? ` — ${routingNote}` : ""}. No road network, no
                  drive time, no ferry — two drops either side of an estuary
                  look adjacent here and are an hour apart in a truck. Treat the
                  sequence as a starting point and adjust it on the load.
                </>
              )}
            </span>
          </p>

          {/* --- step 3: the proposal ------------------------------------- */}
          {/* Below lg the map and the group list share the space and toggle;
              from lg up they sit side by side and this switcher is hidden. */}
          {plan.loads.length > 0 ? (
            <div
              role="tablist"
              aria-label="Proposal view"
              className="mb-3 flex gap-1 border-b border-hairline lg:hidden"
            >
              {(["list", "map"] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-body-sm transition-colors",
                    view === v
                      ? "border-brand font-medium text-ink"
                      : "border-transparent text-ink-muted hover:text-ink",
                  )}
                >
                  <Icon
                    name={v === "list" ? "list" : "map"}
                    filled={view === v}
                    className={cx("text-[17px]", view === v && "text-brand")}
                  />
                  {v === "list" ? "Groups" : "Map"}
                </button>
              ))}
            </div>
          ) : null}

          {plan.loads.length === 0 ? (
            <p className="rounded-sm border border-dashed border-hairline-strong px-3 py-8 text-center text-caption text-ink-subtle">
              Nothing to group yet. Orders need coordinates first.
            </p>
          ) : (
            <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_42rem] lg:items-start lg:gap-6">
              {/* Group + order adjustments — the left pane from lg up, a
                  toggled full-width view below it. */}
              <div
                className={cx(
                  "min-w-0",
                  view === "map" && "hidden lg:block",
                )}
              >
                <ul className="space-y-3">
              {plan.loads.map((load, index) => {
                const off = dropped.has(index);
                const chosen = truckFor(load, index);
                const needsCmr = requiresCmr(load.regime);
                return (
                  <li
                    key={index}
                    className={cx(
                      "rounded-lg border transition-colors",
                      off
                        ? "border-hairline bg-surface-muted opacity-60"
                        : "border-hairline bg-surface",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={!off}
                        aria-label={`Include group ${index + 1}`}
                        className="size-3.5 accent-brand"
                        onChange={() =>
                          setDropped((prev) => {
                            const next = new Set(prev);
                            if (next.has(index)) next.delete(index);
                            else next.add(index);
                            return next;
                          })
                        }
                      />
                      <span className="text-heading text-ink">
                        Group {index + 1}
                      </span>
                      <span className="font-mono text-label uppercase text-ink-subtle">
                        {load.stops.length} stop
                        {load.stops.length === 1 ? "" : "s"} ·{" "}
                        {formatDistance(load.routeMeters)} round trip
                        {load.routeSeconds !== null
                          ? ` · ≈${formatDuration(load.routeSeconds)} driving`
                          : ""}{" "}
                        · {formatDistance(load.spreadMeters)} spread
                      </span>
                      {load.countries.map((c) => (
                        <CountryChip key={c} code={c} />
                      ))}
                      {load.regime !== "domestic" ? (
                        <CustomsBadge regime={load.regime} />
                      ) : null}

                      <select
                        aria-label={`Truck for group ${index + 1}`}
                        className={cx(controlClass, "ml-auto h-8 w-44")}
                        value={chosen}
                        onChange={(e) =>
                          setOverrides((prev) => ({
                            ...prev,
                            [index]: e.target.value,
                          }))
                        }
                      >
                        <option value="">No truck — skip</option>
                        {trucks
                          .filter((t) => t.availability === "available")
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.license_plate}
                            </option>
                          ))}
                      </select>
                    </div>

                    <ol className="divide-y divide-hairline">
                      {orderedStops(load, index).map((stop, i, stops) => (
                        <li
                          key={stop.id}
                          className="flex items-center gap-3 px-4 py-2"
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-label text-ink-inverse">
                            {i + 1}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body-sm text-ink">
                              {stop.customer_name}
                            </span>
                            <span className="block truncate text-caption text-ink-subtle">
                              {stop.delivery_address}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-data-sm text-ink-subtle">
                            {stop.crm_order_id}
                          </span>
                          <div className="flex shrink-0 items-center">
                            <button
                              type="button"
                              aria-label={`Move ${stop.customer_name} up`}
                              title="Move up"
                              disabled={i === 0}
                              onClick={() => moveStop(load, index, stop.id, -1)}
                              className="rounded-sm p-1 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                            >
                              <Icon name="arrow_upward" className="text-[15px]" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Move ${stop.customer_name} down`}
                              title="Move down"
                              disabled={i === stops.length - 1}
                              onClick={() => moveStop(load, index, stop.id, 1)}
                              className="rounded-sm p-1 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                            >
                              <Icon name="arrow_downward" className="text-[15px]" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Remove ${stop.customer_name} from the plan`}
                              title="Remove this drop — it stays in the queue"
                              onClick={() => excludeOrder(stop.id)}
                              className="rounded-sm p-1 text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger"
                            >
                              <Icon name="close" className="text-[15px]" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ol>

                    {needsCmr ? (
                      <p className="border-t border-hairline px-4 py-2 text-caption text-ink-muted">
                        International carriage — a CMR number is required. Add
                        it on the load after it is created.
                      </p>
                    ) : null}
                  </li>
                );
              })}
                </ul>
              </div>

              {/* The map — the right pane from lg up, kept in view while the
                  group list scrolls; a toggled full-width view below lg. */}
              <div
                className={cx(
                  "mt-4 lg:mt-0 lg:sticky lg:top-0",
                  view === "list" && "hidden lg:block",
                )}
              >
                {mapsKey ? (
                  <PlanGoogleMap
                    apiKey={mapsKey}
                    depot={DEPOT_LATLNG}
                    groups={mapGroups}
                    heightClass="h-[24rem] lg:h-[42rem]"
                  />
                ) : (
                  <PlanMap
                    depot={DEPOT_LATLNG}
                    groups={mapGroups}
                    heightClass="h-[24rem] lg:h-[42rem]"
                  />
                )}
                <p className="mt-2 text-caption text-ink-subtle">
                  Straight lines from the depot through each group&rsquo;s stops
                  and back — the geometry the planner sequenced on, not a road
                  route. Uncheck a group to drop it; it dims here.
                </p>
              </div>
            </div>
          )}

          {plan.unTrucked > 0 ? (
            <p className="mt-3 flex items-start gap-2 text-caption text-warn">
              <Icon name="local_shipping" className="mt-px text-[15px]" />
              {plan.unTrucked} group{plan.unTrucked === 1 ? " has" : "s have"} no
              truck left to assign. Pick one manually above, or free up a truck
              on the Fleet page.
            </p>
          ) : null}

          {plan.skipped.length > 0 ? (
            <details className="mt-3 rounded-sm border border-hairline">
              <summary className="cursor-pointer px-3 py-2 text-body-sm text-ink-muted hover:text-ink">
                {plan.skipped.length} order
                {plan.skipped.length === 1 ? "" : "s"} left out
              </summary>
              <ul className="max-h-40 divide-y divide-hairline overflow-y-auto border-t border-hairline">
                {plan.skipped.map(({ order, reason }) => (
                  <li key={order.id} className="px-3 py-1.5">
                    <span className="font-mono text-data-sm text-ink">
                      {order.crm_order_id}
                    </span>{" "}
                    <span className="text-caption text-ink-subtle">
                      {SKIP_MESSAGE[reason]}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {excludedOrders.length > 0 ? (
            <section className="mt-3 rounded-sm border border-hairline">
              <p className="border-b border-hairline px-3 py-2 text-body-sm font-medium text-ink">
                {excludedOrders.length} drop
                {excludedOrders.length === 1 ? "" : "s"} you removed
                <span className="ml-1 font-normal text-ink-subtle">
                  — left in the queue, not planned
                </span>
              </p>
              <ul className="max-h-40 divide-y divide-hairline overflow-y-auto">
                {excludedOrders.map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center gap-3 px-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm text-ink">
                        {o.customer_name}
                      </span>
                      <span className="block truncate text-caption text-ink-subtle">
                        {o.delivery_address}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-data-sm text-ink-subtle">
                      {o.crm_order_id}
                    </span>
                    <button
                      type="button"
                      onClick={() => restoreOrder(o.id)}
                      className="shrink-0 text-caption font-medium text-brand hover:underline"
                    >
                      Add back
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
            >
              <Icon name="error" className="mt-px text-[17px]" />
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-6 py-3">
          <p className="mr-auto max-w-sm text-caption text-ink-subtle">
            Created as <strong>planned</strong>, with no driver. Assign drivers
            and start them from Active Loads.
          </p>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={creating ? "progress_activity" : "auto_awesome"}
            disabled={creating || creatable.length === 0}
            onClick={runCreate}
          >
            {creating
              ? "Creating…"
              : `Create ${creatable.length} load${creatable.length === 1 ? "" : "s"}`}
          </Button>
        </footer>
      </div>
    </>
  );
}
