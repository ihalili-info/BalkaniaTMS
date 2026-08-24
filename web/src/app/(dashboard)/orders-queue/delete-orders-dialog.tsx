"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Icon } from "@/components/ui";
import { deleteOrders } from "@/lib/data/mutations";
import type { Order } from "@/lib/types";

/**
 * Confirms a bulk delete from the Orders Queue.
 *
 * The point of the dialog is the split it shows *before* anything happens.
 * `deleteOrders` will not touch an order that is delivered or sitting on a
 * load — deleting one cascades through `load_items` into `notifications` and
 * would erase the record of a customer having been alerted. Rather than
 * failing the whole batch or quietly skipping rows, the same rule is evaluated
 * here so the dispatcher confirms an outcome they have already read.
 */
export function DeleteOrdersDialog({
  orders,
  loadRefByOrderId,
  onClose,
  onDeleted,
}: {
  /** The selected orders, in the order they appear in the table. */
  orders: Order[];
  loadRefByOrderId: Record<string, string>;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const blocked = orders
    .map((o) => {
      if (o.status === "delivered") {
        return { order: o, reason: "delivered" };
      }
      const ref = loadRefByOrderId[o.id];
      if (ref) return { order: o, reason: `on ${ref}` };
      return null;
    })
    .filter((v): v is { order: Order; reason: string } => v !== null);

  const deletable = orders.length - blocked.length;

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
        aria-label="Delete orders"
        className="fixed inset-x-4 top-[12vh] z-50 mx-auto flex max-h-[76vh] max-w-lg flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start gap-3 px-6 py-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
            <Icon name="delete" className="text-[20px]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-title text-ink">
              {deletable === 0
                ? "Nothing can be deleted"
                : `Delete ${deletable} order${deletable === 1 ? "" : "s"}?`}
            </h2>
            <p className="mt-1 text-body-sm text-ink-muted">
              {deletable > 0
                ? "This is permanent. Deleted orders do not return to the queue — re-import the CSV row if you need one back."
                : "Every order selected is either delivered or already on a load."}
            </p>
          </div>
        </header>

        {blocked.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline px-6 py-4">
            <p className="mb-2 flex items-start gap-1.5 text-body-sm text-ink-muted">
              <Icon name="shield" className="mt-px text-[16px] text-ink-subtle" />
              <span>
                {blocked.length} order{blocked.length === 1 ? " is" : "s are"}{" "}
                kept. Deleting one would take its stop and any alert already
                sent to that customer with it.
              </span>
            </p>
            <ul className="divide-y divide-hairline">
              {blocked.map(({ order, reason }) => (
                <li
                  key={order.id}
                  className="flex items-center gap-3 py-2 text-body-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">
                      {order.customer_name}
                    </span>
                    <span className="block font-mono text-data-sm text-ink-subtle">
                      {order.crm_order_id}
                    </span>
                  </span>
                  <Badge tone="neutral">{reason}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

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
            disabled={pending || deletable === 0}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await deleteOrders(orders.map((o) => o.id));
                if (result.ok) {
                  onDeleted();
                  router.refresh();
                } else {
                  setError(result.message ?? "Could not delete.");
                }
              })
            }
          >
            {pending
              ? "Deleting…"
              : `Delete ${deletable} order${deletable === 1 ? "" : "s"}`}
          </Button>
        </footer>
      </div>
    </>
  );
}
