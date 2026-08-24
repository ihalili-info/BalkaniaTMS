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
import { createLoad } from "@/lib/data/mutations";
import { customsRegime, requiresCmr, HOME_COUNTRY } from "@/lib/regions";
import { vehicleBreaches } from "@/lib/regions";
import type { Driver, Order, Truck } from "@/lib/types";

/**
 * Builds a load out of unassigned orders.
 *
 * The stop list is ordered, not a selection: the sequence a dispatcher sets
 * here becomes `stop_sequence`, which is the order the driver drives and the
 * order the geofence engine walks.
 */
export function PlanLoadDialog({
  trucks,
  drivers,
  orders,
  onClose,
}: {
  trucks: Truck[];
  drivers: Driver[];
  /** Unassigned orders only. */
  orders: Order[];
  onClose: () => void;
}) {
  const router = useRouter();
  const available = trucks.filter((t) => t.availability === "available");

  const [truckId, setTruckId] = useState(available[0]?.id ?? "");
  const [driverId, setDriverId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [cmr, setCmr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const orderById = useMemo(
    () => new Map(orders.map((o) => [o.id, o])),
    [orders],
  );
  const stops = picked
    .map((id) => orderById.get(id))
    .filter((o): o is Order => o !== undefined);

  const truck = trucks.find((t) => t.id === truckId) ?? null;

  const destinations = [...new Set(stops.map((s) => s.delivery_country))];
  const regime = destinations
    .map((c) => customsRegime(HOME_COUNTRY, c))
    .sort()
    .at(-1);
  const needsCmr = regime ? requiresCmr(regime) : false;

  // A 4.65 m Irish trailer is over the limit across most of the continent.
  // Better to say so while the load is being planned than at a weighbridge.
  const limitProblems = truck
    ? destinations.flatMap((c) => vehicleBreaches(truck, c))
    : [];

  /**
   * Picking a driver pulls their assigned vehicle across.
   *
   * Only when that truck is actually available: a driver whose usual unit is
   * in the workshop needs a different truck, and silently selecting one that
   * cannot take work would fail at create time instead of here.
   */
  const pickDriver = (id: string) => {
    setDriverId(id);
    const usual = drivers.find((d) => d.id === id)?.assigned_truck_id;
    if (usual && available.some((t) => t.id === usual)) setTruckId(usual);
  };

  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const move = (index: number, by: number) =>
    setPicked((prev) => {
      const next = [...prev];
      const target = index + by;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createLoad({
        truckId,
        driverId: driverId === "" ? null : driverId,
        orderIds: picked,
        cmrNumber: cmr.trim() === "" ? null : cmr.trim(),
      });
      if (result.ok) {
        onClose();
        router.refresh();
      } else {
        setError(result.message ?? "Could not create the load.");
      }
    });
  };

  const blocked = truckId === "" || picked.length === 0;

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
        aria-label="Plan a load"
        className="fixed inset-x-4 top-[4vh] z-50 mx-auto flex max-h-[92vh] max-w-4xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <p className="font-mono text-label uppercase text-ink-subtle">
              Dispatch
            </p>
            <h2 className="text-title text-ink">Plan a load</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Pick a truck and the stops. The order you set is the order the
              driver runs.
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
          {available.length === 0 ? (
            <p className="mb-4 flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5 text-body-sm text-ink-muted">
              <Icon name="warning" className="mt-px text-[17px] text-warn" />
              No truck is available. Every truck is marked unavailable or in
              maintenance on the Fleet page.
            </p>
          ) : null}

          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Field label="Truck" htmlFor="pl-truck">
              <select
                id="pl-truck"
                className={controlClass}
                value={truckId}
                onChange={(e) => setTruckId(e.target.value)}
              >
                {available.length === 0 ? <option value="">None available</option> : null}
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.license_plate}
                    {t.label ? ` — ${t.label}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Driver"
              htmlFor="pl-driver"
              hint={drivers.length === 0 ? "No drivers added yet" : undefined}
            >
              <select
                id="pl-driver"
                className={controlClass}
                value={driverId}
                onChange={(e) => pickDriver(e.target.value)}
              >
                <option value="">Unassigned</option>
                {drivers.map((d) => {
                  const plate = trucks.find(
                    (t) => t.id === d.assigned_truck_id,
                  )?.license_plate;
                  return (
                    <option key={d.id} value={d.id}>
                      {d.full_name}
                      {plate ? ` — ${plate}` : ""}
                    </option>
                  );
                })}
              </select>
            </Field>

            <Field
              label="CMR number"
              htmlFor="pl-cmr"
              hint={needsCmr ? "Required for this movement" : "International only"}
            >
              <input
                id="pl-cmr"
                className={cx(controlClass, needsCmr && cmr.trim() === "" && "border-warn")}
                value={cmr}
                onChange={(e) => setCmr(e.target.value)}
                placeholder={needsCmr ? "CMR-IE-…" : "not needed"}
              />
            </Field>
          </div>

          {limitProblems.length > 0 ? (
            <p className="mb-4 flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5 text-body-sm text-ink-muted">
              <Icon name="public_off" className="mt-px text-[17px] text-warn" />
              <span>{limitProblems[0]}</span>
            </p>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-2">
            {/* --- available orders --- */}
            <section>
              <h3 className="mb-2 text-heading text-ink">
                Unassigned orders
                <span className="ml-2 font-mono text-label uppercase text-ink-subtle">
                  {orders.length}
                </span>
              </h3>
              {orders.length === 0 ? (
                <p className="rounded-sm border border-hairline bg-surface-muted px-3 py-4 text-caption text-ink-subtle">
                  Nothing waiting. Import orders on the Orders Queue.
                </p>
              ) : (
                <ul className="max-h-80 space-y-1 overflow-y-auto rounded-sm border border-hairline p-1">
                  {orders.map((o) => {
                    const on = picked.includes(o.id);
                    return (
                      <li key={o.id}>
                        <label
                          className={cx(
                            "flex cursor-pointer items-start gap-2 rounded-sm px-2.5 py-2 transition-colors",
                            on ? "bg-brand-soft" : "hover:bg-surface-muted",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(o.id)}
                            className="mt-0.5 size-3.5 accent-brand"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2">
                              <span className="text-body-sm font-medium text-ink">
                                {o.customer_name}
                              </span>
                              <span className="font-mono text-data-sm text-ink-subtle">
                                {o.crm_order_id}
                              </span>
                              <CountryChip code={o.delivery_country} />
                            </span>
                            <span className="block truncate text-caption text-ink-subtle">
                              {o.delivery_address}
                            </span>
                            {o.delivery_location === null ? (
                              <Badge tone="danger" className="mt-1">
                                No coordinates
                              </Badge>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* --- the route --- */}
            <section>
              <h3 className="mb-2 text-heading text-ink">
                Stop sequence
                <span className="ml-2 font-mono text-label uppercase text-ink-subtle">
                  {stops.length}
                </span>
              </h3>
              {stops.length === 0 ? (
                <p className="rounded-sm border border-dashed border-hairline-strong px-3 py-8 text-center text-caption text-ink-subtle">
                  Tick orders on the left. Their order here is the order the
                  driver runs them.
                </p>
              ) : (
                <ol className="space-y-1 rounded-sm border border-hairline p-1">
                  {stops.map((o, i) => (
                    <li
                      key={o.id}
                      className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-surface-muted"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-label text-ink-inverse">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm text-ink">
                          {o.customer_name}
                        </span>
                        <span className="block truncate text-caption text-ink-subtle">
                          {o.delivery_address}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col">
                        <button
                          type="button"
                          aria-label="Move earlier"
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          className="text-ink-subtle transition-colors hover:text-ink disabled:opacity-30"
                        >
                          <Icon name="expand_less" className="text-[16px]" />
                        </button>
                        <button
                          type="button"
                          aria-label="Move later"
                          disabled={i === stops.length - 1}
                          onClick={() => move(i, 1)}
                          className="text-ink-subtle transition-colors hover:text-ink disabled:opacity-30"
                        >
                          <Icon name="expand_more" className="text-[16px]" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {regime && regime !== "domestic" ? (
                <p className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-label uppercase text-ink-subtle">
                    Customs
                  </span>
                  <CustomsBadge regime={regime} full />
                </p>
              ) : null}
            </section>
          </div>

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
            Created as <strong>planned</strong>. Start it when the truck leaves
            — that is what puts it on the board as active.
          </p>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={pending ? "progress_activity" : "add_road"}
            disabled={pending || blocked}
            onClick={submit}
          >
            {pending
              ? "Creating…"
              : `Create load · ${picked.length} stop${picked.length === 1 ? "" : "s"}`}
          </Button>
        </footer>
      </div>
    </>
  );
}
