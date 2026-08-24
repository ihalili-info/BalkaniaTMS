"use client";

import { useState, useTransition } from "react";

import {
  Badge,
  Button,
  Icon,
  Table,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui";
import { applyVehicleSync, planVehicleSync, type SyncPlan } from "@/lib/telematics/sync";

/**
 * Pulls the fleet from Verizon Connect Reveal.
 *
 * Always previews before writing. The response field names are not publicly
 * documented, so the first run is also how the mapping gets confirmed — the
 * raw sample is on screen next to what we made of it.
 */
export function RevealSync() {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => {
    setOpen(true);
    setPlan(null);
    setDone(null);
    startTransition(async () => setPlan(await planVehicleSync()));
  };

  const apply = () =>
    startTransition(async () => {
      const result = await applyVehicleSync();
      setDone(
        result.ok
          ? `Created ${result.created}, updated ${result.updated}.`
          : (result.message ?? "Sync failed."),
      );
      if (result.ok) setPlan(await planVehicleSync());
    });

  const counts = {
    create: plan?.rows.filter((r) => r.action === "create").length ?? 0,
    update: plan?.rows.filter((r) => r.action === "update").length ?? 0,
    unchanged: plan?.rows.filter((r) => r.action === "unchanged").length ?? 0,
  };

  return (
    <>
      <Button icon="cloud_sync" onClick={load}>
        Sync from Reveal
      </Button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Sync fleet from Reveal"
            className="fixed inset-x-4 top-[5vh] z-50 mx-auto flex max-h-[90vh] max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
          >
            <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
              <div>
                <p className="font-mono text-label uppercase text-ink-subtle">
                  Verizon Connect Reveal
                </p>
                <h2 className="text-title text-ink">Sync fleet</h2>
                <p className="mt-0.5 text-body-sm text-ink-muted">
                  Matches on Vehicle Number. Nothing is ever deleted — a vehicle
                  removed in Reveal is reported, not acted on.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
              >
                <Icon name="close" className="text-[20px]" />
              </button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
              {pending && !plan ? (
                <p className="flex items-center gap-2 text-body-sm text-ink-muted">
                  <Icon name="progress_activity" className="text-[18px]" />
                  Asking Reveal for the vehicle list…
                </p>
              ) : null}

              {plan && !plan.ok ? (
                <p className="flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2.5 text-body-sm text-danger">
                  <Icon name="error" className="mt-px text-[17px]" />
                  {plan.message}
                </p>
              ) : null}

              {done ? (
                <p className="flex items-start gap-2 rounded-sm border border-ok-border bg-ok-soft px-3 py-2.5 text-body-sm text-ok">
                  <Icon name="check_circle" className="mt-px text-[17px]" />
                  {done}
                </p>
              ) : null}

              {plan?.ok ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={counts.create > 0 ? "ok" : "neutral"} dot>
                      {counts.create} to create
                    </Badge>
                    <Badge tone={counts.update > 0 ? "brand" : "neutral"} dot>
                      {counts.update} to update
                    </Badge>
                    <Badge tone="neutral">{counts.unchanged} unchanged</Badge>
                    {plan.unusable > 0 ? (
                      <Badge tone="warn" dot>
                        {plan.unusable} without a Vehicle Number
                      </Badge>
                    ) : null}
                  </div>

                  {plan.rows.length === 0 ? (
                    <p className="flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5 text-body-sm text-ink-muted">
                      <Icon name="warning" className="mt-px text-[17px] text-warn" />
                      Reveal returned no usable vehicles. The most common cause
                      is that Vehicle Number is not populated per vehicle in
                      Reveal — Verizon does not set it automatically, and it is
                      what everything keys on.
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-sm border border-hairline">
                      <Table>
                        <thead>
                          <tr>
                            <Th>Vehicle No.</Th>
                            <Th>Plate</Th>
                            <Th>Name</Th>
                            <Th>Make / model</Th>
                            <Th>Action</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.rows.map((r) => (
                            <Tr key={r.vehicleNumber}>
                              <Td className="font-mono text-data-sm text-ink">
                                {r.vehicleNumber}
                              </Td>
                              <Td className="font-mono text-data-sm">{r.plate}</Td>
                              <Td className="text-ink-muted">{r.label ?? "—"}</Td>
                              <Td className="text-ink-muted">
                                {r.makeModel ?? "—"}
                              </Td>
                              <Td>
                                <span
                                  className={cx(
                                    "font-mono text-label uppercase",
                                    r.action === "create"
                                      ? "text-ok"
                                      : r.action === "update"
                                        ? "text-brand"
                                        : "text-ink-subtle",
                                  )}
                                >
                                  {r.action}
                                </span>
                              </Td>
                            </Tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                  )}

                  {plan.missingFromReveal.length > 0 ? (
                    <p className="flex items-start gap-2 rounded-sm border border-hairline bg-surface-muted px-3 py-2.5 text-caption text-ink-muted">
                      <Icon name="info" className="mt-px text-[15px]" />
                      <span>
                        In the fleet but not in Reveal:{" "}
                        <span className="font-mono">
                          {plan.missingFromReveal.join(", ")}
                        </span>
                        . Left alone — they may carry load history.
                      </span>
                    </p>
                  ) : null}

                  {plan.sample ? (
                    <details className="rounded-sm border border-hairline">
                      <summary className="cursor-pointer px-3 py-2 text-caption text-ink-subtle hover:text-ink">
                        Raw record from Reveal — check the field mapping
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t border-hairline bg-surface-muted px-3 py-2 font-mono text-data-sm text-ink-muted">
                        {JSON.stringify(plan.sample, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>

            <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-6 py-3">
              <p className="mr-auto max-w-sm text-caption text-ink-subtle">
                Capacity, equipment and availability are dispatcher-owned and
                are never overwritten by a sync.
              </p>
              <Button onClick={() => setOpen(false)}>Close</Button>
              <Button
                variant="primary"
                icon={pending ? "progress_activity" : "cloud_download"}
                disabled={pending || !plan?.ok || counts.create + counts.update === 0}
                onClick={apply}
              >
                {pending
                  ? "Working…"
                  : `Apply ${counts.create + counts.update} change${counts.create + counts.update === 1 ? "" : "s"}`}
              </Button>
            </footer>
          </div>
        </>
      ) : null}
    </>
  );
}
