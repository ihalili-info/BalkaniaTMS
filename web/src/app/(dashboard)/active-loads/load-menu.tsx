"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  Badge,
  Button,
  Field,
  Icon,
  controlClass,
  cx,
} from "@/components/ui";
import { deleteLoad, unstartLoad, updateLoad } from "@/lib/data/mutations";
import type { Driver, LoadView, Order, Truck } from "@/lib/types";

/**
 * Edit / delete for one load.
 *
 * Both are guarded server-side as well; the UI only ever explains a refusal
 * rather than being the thing that prevents it.
 */
export function LoadMenu({
  load,
  trucks,
  drivers,
  unassignedOrders,
}: {
  load: LoadView;
  trucks: Truck[];
  drivers: Driver[];
  unassignedOrders: Order[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [unstartError, setUnstartError] = useState<string | null>(null);
  const [unstarting, startUnstarting] = useTransition();

  const deliveredCount = load.stops.filter((s) => s.delivered_at !== null).length;
  const alertsSent = load.stops.some((s) => s.notifications.length > 0);
  const deletable = deliveredCount === 0 && !alertsSent;
  // Same threshold as delete — nothing on it has actually happened yet, so
  // "started by mistake" (or started onto a truck/driver already running
  // another active load) can still be undone rather than only deleted.
  const unstartable = load.status === "active" && deletable;

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`Actions for ${load.reference}`}
          className="flex size-9 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        >
          <Icon name="more_horiz" className="text-[18px]" />
        </button>

        {open ? (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border border-hairline bg-surface shadow-pop"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setEditing(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
              >
                <Icon name="edit" className="text-[17px]" />
                Edit load
              </button>

              {load.status === "active" ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!unstartable || unstarting}
                  title={
                    unstartable
                      ? undefined
                      : "Delivered stops or sent alerts mean this load has actually left the yard"
                  }
                  onClick={() => {
                    setUnstartError(null);
                    startUnstarting(async () => {
                      const result = await unstartLoad(load.id);
                      if (result.ok) {
                        setOpen(false);
                        router.refresh();
                      } else {
                        setUnstartError(result.message ?? "Could not move it back to planned.");
                      }
                    });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink disabled:cursor-not-allowed disabled:text-ink-subtle disabled:hover:bg-transparent"
                >
                  <Icon
                    name={unstarting ? "progress_activity" : "undo"}
                    className="text-[17px]"
                  />
                  {unstarting ? "Moving back…" : "Move back to planned"}
                </button>
              ) : null}

              {unstartError ? (
                <p className="border-t border-hairline bg-danger-soft px-3 py-2 text-caption text-danger">
                  {unstartError}
                </p>
              ) : null}

              <button
                type="button"
                role="menuitem"
                disabled={!deletable}
                title={
                  deletable
                    ? undefined
                    : "Delivered stops or sent alerts cannot be discarded"
                }
                onClick={() => {
                  setOpen(false);
                  setConfirming(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:text-ink-subtle disabled:hover:bg-transparent"
              >
                <Icon name="delete" className="text-[17px]" />
                Delete load
              </button>

              {!deletable ? (
                <p className="border-t border-hairline bg-surface-muted px-3 py-2 text-caption text-ink-subtle">
                  {deliveredCount > 0
                    ? `${deliveredCount} stop${deliveredCount === 1 ? " has" : "s have"} been delivered.`
                    : "Customer alerts have been sent."}{" "}
                  Deleting would erase that record.
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {editing ? (
        <EditLoadDialog
          load={load}
          trucks={trucks}
          drivers={drivers}
          unassignedOrders={unassignedOrders}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {confirming ? (
        <DeleteConfirm load={load} onClose={() => setConfirming(false)} />
      ) : null}
    </>
  );
}

function DeleteConfirm({
  load,
  onClose,
}: {
  load: LoadView;
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
        aria-label={`Delete ${load.reference}`}
        className="fixed inset-x-4 top-[18vh] z-50 mx-auto max-w-md overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <div className="flex items-start gap-3 px-6 py-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
            <Icon name="delete" className="text-[20px]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-title text-ink">Delete {load.reference}?</h2>
            <p className="mt-1 text-body-sm text-ink-muted">
              Its {load.stops.length} stop
              {load.stops.length === 1 ? "" : "s"} go back to the Orders Queue
              as pending, so the work is not lost — only the plan.
            </p>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="mx-6 mb-4 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
          >
            <Icon name="error" className="mt-px text-[17px]" />
            {error}
          </p>
        ) : null}

        <footer className="flex items-center gap-2 border-t border-hairline px-6 py-3">
          <Button onClick={onClose} className="mr-auto">
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={pending ? "progress_activity" : "delete"}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteLoad(load.id);
                if (result.ok) {
                  onClose();
                  router.refresh();
                } else {
                  setError(result.message ?? "Could not delete.");
                }
              })
            }
          >
            {pending ? "Deleting…" : "Delete load"}
          </Button>
        </footer>
      </div>
    </>
  );
}

function EditLoadDialog({
  load,
  trucks,
  drivers,
  unassignedOrders,
  onClose,
}: {
  load: LoadView;
  trucks: Truck[];
  drivers: Driver[];
  unassignedOrders: Order[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [truckId, setTruckId] = useState(load.truck_id ?? "");
  const [driverId, setDriverId] = useState(load.driver_id ?? "");
  const [cmr, setCmr] = useState(load.cmr_number ?? "");
  const [sequence, setSequence] = useState<string[]>(
    load.stops.map((s) => s.order_id),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const known = useMemo(() => {
    const map = new Map<string, Order>();
    for (const s of load.stops) map.set(s.order_id, s.order);
    for (const o of unassignedOrders) map.set(o.id, o);
    return map;
  }, [load.stops, unassignedOrders]);

  const deliveredIds = useMemo(
    () =>
      new Set(
        load.stops.filter((s) => s.delivered_at !== null).map((s) => s.order_id),
      ),
    [load.stops],
  );

  // Only trucks that may be given work, plus whatever is on the load already —
  // dropping the current truck out of the list would look like data loss.
  const selectableTrucks = trucks.filter(
    (t) => t.availability === "available" || t.id === load.truck_id,
  );

  const move = (index: number, by: number) =>
    setSequence((prev) => {
      const next = [...prev];
      const target = index + by;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const remove = (orderId: string) =>
    setSequence((prev) => prev.filter((id) => id !== orderId));

  const add = (orderId: string) =>
    setSequence((prev) => (prev.includes(orderId) ? prev : [...prev, orderId]));

  const addable = unassignedOrders.filter((o) => !sequence.includes(o.id));

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
        aria-label={`Edit ${load.reference}`}
        className="fixed inset-x-4 top-[4vh] z-50 mx-auto flex max-h-[92vh] max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <p className="font-mono text-label uppercase text-ink-subtle">
              {load.reference}
            </p>
            <h2 className="text-title text-ink">Edit load</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Delivered stops are locked — they record something that already
              happened.
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
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Field label="Truck" htmlFor="el-truck">
              <select
                id="el-truck"
                className={controlClass}
                value={truckId}
                onChange={(e) => setTruckId(e.target.value)}
              >
                {selectableTrucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.license_plate}
                    {t.availability !== "available" ? " (out of service)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Driver" htmlFor="el-driver">
              <select
                id="el-driver"
                className={controlClass}
                value={driverId}
                onChange={(e) => {
                  setDriverId(e.target.value);
                  // Bring the driver's usual truck across, but only onto a load
                  // that has not started — swapping the vehicle under a running
                  // job is a decision, not a default.
                  const usual = drivers.find(
                    (d) => d.id === e.target.value,
                  )?.assigned_truck_id;
                  if (
                    usual &&
                    load.status === "planned" &&
                    selectableTrucks.some((t) => t.id === usual)
                  ) {
                    setTruckId(usual);
                  }
                }}
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
            <Field label="CMR number" htmlFor="el-cmr">
              <input
                id="el-cmr"
                className={controlClass}
                value={cmr}
                onChange={(e) => setCmr(e.target.value)}
              />
            </Field>
          </div>

          <h3 className="mb-2 text-heading text-ink">Stops</h3>
          <ol className="mb-4 space-y-1 rounded-sm border border-hairline p-1">
            {sequence.map((orderId, i) => {
              const order = known.get(orderId);
              const isDelivered = deliveredIds.has(orderId);
              return (
                <li
                  key={orderId}
                  className={cx(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5",
                    isDelivered ? "bg-surface-muted" : "hover:bg-surface-muted",
                  )}
                >
                  <span
                    className={cx(
                      "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-label",
                      isDelivered
                        ? "bg-ok text-ink-inverse"
                        : "bg-brand text-ink-inverse",
                    )}
                  >
                    {isDelivered ? (
                      <Icon name="check" className="text-[13px]" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm text-ink">
                      {order?.customer_name ?? "Unknown order"}
                    </span>
                    <span className="block truncate text-caption text-ink-subtle">
                      {order?.delivery_address ?? ""}
                    </span>
                  </span>
                  {isDelivered ? (
                    <Badge tone="ok">Delivered</Badge>
                  ) : (
                    <span className="flex items-center gap-1">
                      <span className="flex flex-col">
                        <button
                          type="button"
                          aria-label="Move earlier"
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          className="text-ink-subtle hover:text-ink disabled:opacity-30"
                        >
                          <Icon name="expand_less" className="text-[16px]" />
                        </button>
                        <button
                          type="button"
                          aria-label="Move later"
                          disabled={i === sequence.length - 1}
                          onClick={() => move(i, 1)}
                          className="text-ink-subtle hover:text-ink disabled:opacity-30"
                        >
                          <Icon name="expand_more" className="text-[16px]" />
                        </button>
                      </span>
                      <button
                        type="button"
                        aria-label="Remove stop"
                        onClick={() => remove(orderId)}
                        className="rounded-sm p-1 text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <Icon name="close" className="text-[15px]" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>

          {addable.length > 0 ? (
            <details className="rounded-sm border border-hairline">
              <summary className="cursor-pointer px-3 py-2 text-body-sm text-ink-muted hover:text-ink">
                Add a stop — {addable.length} unassigned order
                {addable.length === 1 ? "" : "s"} waiting
              </summary>
              <ul className="max-h-52 space-y-1 overflow-y-auto border-t border-hairline p-1">
                {addable.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => add(o.id)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface-muted"
                    >
                      <Icon name="add" className="text-[16px] text-ink-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm text-ink">
                          {o.customer_name}
                        </span>
                        <span className="block truncate text-caption text-ink-subtle">
                          {o.delivery_address}
                        </span>
                      </span>
                    </button>
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

        <footer className="flex items-center gap-2 border-t border-hairline px-6 py-3">
          <p className="mr-auto max-w-xs text-caption text-ink-subtle">
            Removed stops return to the Orders Queue as pending.
          </p>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={pending ? "progress_activity" : "save"}
            disabled={pending || sequence.length === 0 || truckId === ""}
            onClick={() =>
              startTransition(async () => {
                const result = await updateLoad(load.id, {
                  truckId,
                  driverId: driverId === "" ? null : driverId,
                  cmrNumber: cmr.trim() === "" ? null : cmr.trim(),
                  orderIds: sequence,
                });
                if (result.ok) {
                  onClose();
                  router.refresh();
                } else {
                  setError(result.message ?? "Could not save.");
                }
              })
            }
          >
            {pending ? "Saving…" : "Save load"}
          </Button>
        </footer>
      </div>
    </>
  );
}
