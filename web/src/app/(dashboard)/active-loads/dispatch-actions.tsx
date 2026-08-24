"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Icon, cx } from "@/components/ui";
import { syncGpsNow, type PollResult } from "@/lib/telematics/poll";
import type { Driver, Order, Truck } from "@/lib/types";

import { PlanLoadDialog } from "./plan-load-dialog";

/** The two header actions on Active Loads. */
export function DispatchActions({
  trucks,
  drivers,
  unassignedOrders,
}: {
  trucks: Truck[];
  drivers: Driver[];
  unassignedOrders: Order[];
}) {
  const router = useRouter();
  const [planning, setPlanning] = useState(false);
  const [poll, setPoll] = useState<PollResult | null>(null);
  const [pending, startTransition] = useTransition();

  const sync = () =>
    startTransition(async () => {
      const result = await syncGpsNow();
      setPoll(result);
      if (result.updated > 0) router.refresh();
    });

  return (
    <>
      <Button
        icon={pending ? "progress_activity" : "refresh"}
        onClick={sync}
        disabled={pending}
        title="Ask Reveal for each truck's current position"
      >
        {pending ? "Syncing…" : "Sync GPS"}
      </Button>

      <Button
        variant="primary"
        icon="add"
        onClick={() => setPlanning(true)}
        disabled={unassignedOrders.length === 0 && trucks.length === 0}
      >
        Plan load
      </Button>

      {planning ? (
        <PlanLoadDialog
          trucks={trucks}
          drivers={drivers}
          orders={unassignedOrders}
          onClose={() => setPlanning(false)}
        />
      ) : null}

      {poll ? <PollReport result={poll} onDismiss={() => setPoll(null)} /> : null}
    </>
  );
}

/**
 * Result of a manual poll.
 *
 * Per truck rather than a single count: with one HTTP call per vehicle, a
 * partial failure is normal and "3 of 6 updated" is not enough to act on.
 */
function PollReport({
  result,
  onDismiss,
}: {
  result: PollResult;
  onDismiss: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onDismiss}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="GPS sync result"
        className="fixed inset-x-4 top-[10vh] z-50 mx-auto flex max-h-[80vh] max-w-lg flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div>
            <h2 className="text-title text-ink">GPS sync</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              {result.ok
                ? `${result.updated} of ${result.lines.length} trucks updated.`
                : "Could not poll."}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="close" className="text-[20px]" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {result.message ? (
            <p className="flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5 text-body-sm text-ink-muted">
              <Icon name="info" className="mt-px text-[17px] text-warn" />
              {result.message}
            </p>
          ) : null}

          {result.lines.length > 0 ? (
            <ul className="divide-y divide-hairline">
              {result.lines.map((line) => (
                <li key={line.vehicleNumber} className="flex items-start gap-3 py-2.5">
                  <Badge
                    tone={
                      line.outcome === "updated"
                        ? "ok"
                        : line.outcome === "unchanged"
                          ? "neutral"
                          : "danger"
                    }
                  >
                    {line.outcome}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-data-sm text-ink">
                      {line.plate}
                    </span>
                    <span className="block text-caption text-ink-subtle">
                      {line.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <p className={cx("mr-auto text-caption text-ink-subtle")}>
            Polling is the fallback. The push webhook is the intended path.
          </p>
          <Button onClick={onDismiss}>Close</Button>
        </footer>
      </div>
    </>
  );
}
