"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
  roadMatrixForOrders,
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
import type { Order, RouteLeg, Truck } from "@/lib/types";

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
  onClose,
}: {
  /** The selected orders. */
  orders: Order[];
  trucks: Truck[];
  loadRefByOrderId: Record<string, string>;
  /** Whether GEOCODING_API_KEY is set — the button is honest about it if not. */
  geocodingReady: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [options, setOptions] = useState<PlannerOptions>(DEFAULT_PLANNER_OPTIONS);
  const [geocodeLines, setGeocodeLines] = useState<GeocodeLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [overrides, setOverrides] = useState<Record<number, string>>({});
  const [geocoding, startGeocode] = useTransition();
  const [creating, startCreate] = useTransition();

  const onLoad = useMemo(
    () => new Set(Object.keys(loadRefByOrderId)),
    [loadRefByOrderId],
  );

  const missing = orders.filter(
    (o) => o.delivery_location === null && !onLoad.has(o.id),
  );

  // Road distances for the drops we can actually plan. Resolved once per set of
  // located orders (a server round-trip that bills Google), then held and
  // reused as the radius / max-stops knobs move — those must stay instant.
  const locatedKey = useMemo(
    () =>
      orders
        .filter((o) => o.delivery_location !== null && !onLoad.has(o.id))
        .map((o) => o.id)
        .sort()
        .join(","),
    [orders, onLoad],
  );

  // `forKey` records which set of drops the matrix was built for, so a matrix
  // left over from a previous selection is ignored rather than reset in the
  // effect body (which would be a synchronous cascading render).
  const [road, setRoad] = useState<{
    forKey: string;
    legs: Record<string, RouteLeg> | null;
    note: string | null;
  } | null>(null);
  const [routing, startRouting] = useTransition();
  const requestedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!locatedKey || locatedKey.split(",").length < 2) return;
    if (requestedKey.current === locatedKey) return;
    requestedKey.current = locatedKey;
    startRouting(async () => {
      const result = await roadMatrixForOrders(locatedKey.split(","));
      setRoad({
        forKey: locatedKey,
        legs: result.routed ? result.legs : null,
        note: result.message,
      });
    });
  }, [locatedKey]);

  const matrix = road?.forKey === locatedKey ? road.legs : null;
  const routingNote = road?.forKey === locatedKey ? road.note : null;
  const geometry = useMemo<PlannerGeometry>(
    () =>
      matrix
        ? { leg: (a, b) => matrix[`${coordKey(a)}|${coordKey(b)}`] ?? null }
        : {},
    [matrix],
  );
  const routed = matrix !== null;

  const plan = useMemo(
    () =>
      planLoads({
        orders,
        trucks,
        depot: { lat: DEPOT.lat, lng: DEPOT.lng },
        originCountry: HOME_COUNTRY,
        onLoadOrderIds: onLoad,
        options,
        geometry,
      }),
    [orders, trucks, onLoad, options, geometry],
  );

  const kept = plan.loads
    .map((load, index) => ({ load, index }))
    .filter(({ index }) => !dropped.has(index));

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
          orderIds: load.stops.map((s) => s.id),
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
        className="fixed inset-x-4 top-[4vh] z-50 mx-auto flex max-h-[92vh] max-w-4xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <p className="font-mono text-label uppercase text-ink-subtle">
              Dispatch
            </p>
            <h2 className="text-title text-ink">Auto-plan loads</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Groups {orders.length} selected order
              {orders.length === 1 ? "" : "s"} by how close the drops are, and
              sequences each run from the depot outwards.
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
          {plan.loads.length === 0 ? (
            <p className="rounded-sm border border-dashed border-hairline-strong px-3 py-8 text-center text-caption text-ink-subtle">
              Nothing to group yet. Orders need coordinates first.
            </p>
          ) : (
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
                      {load.stops.map((stop, i) => (
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
