"use client";

import { useMemo, useState } from "react";

import { Badge, Button, Icon, StatTile } from "@/components/ui";
import { DEMO_NOW } from "@/lib/demo/fleet";
import { relativeTime } from "@/lib/format";
import type { CountryCode } from "@/lib/regions";
import type { LatLng, Order } from "@/lib/types";

import { FixAddressesDialog } from "./fix-addresses-dialog";
import { ImportDialog } from "./import-dialog";
import { OrdersTable } from "./orders-table";

/**
 * Holds the queue.
 *
 * The stat tiles and the geocoding banner live here rather than in the server
 * page so they stay truthful after a CSV import — a header claiming "6 awaiting
 * assignment" above a table showing 31 would be worse than no header at all.
 */
export function OrdersWorkspace({
  initialOrders,
  loadRefByOrderId,
}: {
  initialOrders: Order[];
  loadRefByOrderId: Record<string, string>;
}) {
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastImport, setLastImport] = useState<number | null>(null);
  const [fixing, setFixing] = useState<{ startWith: string | null } | null>(
    null,
  );
  const [lastFixed, setLastFixed] = useState<string | null>(null);

  const stats = useMemo(() => {
    const unassigned = orders.filter((o) => !loadRefByOrderId[o.id]);
    const oldest = unassigned.reduce<string | null>(
      (acc, o) => (acc === null || o.created_at < acc ? o.created_at : acc),
      null,
    );
    return {
      unassigned: unassigned.length,
      assigned: orders.filter((o) => o.status === "assigned").length,
      oldest,
      ungeocoded: orders.filter((o) => o.delivery_location === null),
      optedOut: orders.filter((o) => o.notifications_opt_out).length,
    };
  }, [orders, loadRefByOrderId]);

  const existingRefs = useMemo(
    () => new Set(orders.map((o) => o.crm_order_id)),
    [orders],
  );

  /**
   * Where a corrected address lands. Local state today; wiring Supabase means
   * an `update(...).eq("id", id)` here and nothing else changes.
   */
  const handleFix = (
    orderId: string,
    patch: {
      delivery_address: string;
      delivery_postcode: string | null;
      delivery_country: CountryCode;
      delivery_location: LatLng;
    },
  ) => {
    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? { ...o, ...patch, updated_at: DEMO_NOW.toISOString() }
          : o,
      ),
    );
    const fixed = orders.find((o) => o.id === orderId);
    setLastFixed(fixed?.crm_order_id ?? null);

    // Stay open while there is more to fix; the list shrinks under us.
    const remaining = stats.ungeocoded.filter((o) => o.id !== orderId);
    setFixing(remaining.length > 0 ? { startWith: remaining[0].id } : null);
  };

  const handleImport = (incoming: Order[]) => {
    // Newest first, matching the queue's own ordering.
    setOrders((prev) => [...incoming, ...prev]);
    setImportedIds((prev) => {
      const next = new Set(prev);
      for (const o of incoming) next.add(o.id);
      return next;
    });
    setLastImport(incoming.length);
    setDialogOpen(false);
  };

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-5">
        <StatTile
          label="Awaiting assignment"
          value={stats.unassigned}
          hint="Not yet on a load"
          icon="inbox"
          tone="brand"
        />
        <StatTile
          label="Assigned"
          value={stats.assigned}
          hint="On a load, not yet departed"
          icon="assignment_turned_in"
          tone="warn"
        />
        <StatTile
          label="Oldest in queue"
          value={
            stats.oldest
              ? relativeTime(stats.oldest, DEMO_NOW).replace(" ago", "")
              : "—"
          }
          hint="Since it reached the queue"
          icon="schedule"
        />
        <StatTile
          label="Need geocoding"
          value={stats.ungeocoded.length}
          hint="No coordinates yet"
          icon="wrong_location"
          tone={stats.ungeocoded.length > 0 ? "danger" : "ok"}
        />
        <StatTile
          label="Alert opt-outs"
          value={stats.optedOut}
          hint="Replied STOP — must stay silent"
          icon="notifications_off"
          tone="neutral"
        />
      </div>

      {lastFixed ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-ok-border bg-ok-soft px-4 py-3">
          <Icon name="edit_location_alt" className="text-[20px] text-ok" />
          <p className="min-w-0 flex-1 text-body-sm text-ink">
            <span className="font-mono text-data-sm">{lastFixed}</span> now has
            coordinates.{" "}
            <span className="text-ink-muted">
              It will appear on the fleet map and can be routed to.
            </span>
          </p>
          <Button variant="ghost" onClick={() => setLastFixed(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {lastImport !== null ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-ok-border bg-ok-soft px-4 py-3">
          <Icon name="task_alt" className="text-[20px] text-ok" />
          <p className="min-w-0 flex-1 text-body-sm text-ink">
            Imported {lastImport} order{lastImport === 1 ? "" : "s"}.{" "}
            <span className="text-ink-muted">
              They are held in this page only — there is no Supabase project
              connected yet, so a refresh restores the fixtures.
            </span>
          </p>
          <Button variant="ghost" onClick={() => setLastImport(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {stats.ungeocoded.length > 0 ? (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-danger-border bg-danger-soft px-4 py-3">
          <Icon name="wrong_location" className="text-[20px] text-danger" />
          <div className="min-w-0 flex-1">
            <p className="text-body-sm font-medium text-ink">
              {stats.ungeocoded.length} order
              {stats.ungeocoded.length === 1 ? " has" : "s have"} no coordinates
            </p>
            <p className="truncate text-caption text-ink-muted">
              {stats.ungeocoded
                .slice(0, 4)
                .map((o) => `${o.crm_order_id} — ${o.delivery_address}`)
                .join(" · ")}
              {stats.ungeocoded.length > 4
                ? ` · +${stats.ungeocoded.length - 4} more`
                : ""}
            </p>
          </div>
          <Button
            variant="danger"
            icon="edit_location_alt"
            onClick={() => setFixing({ startWith: stats.ungeocoded[0].id })}
          >
            Fix {stats.ungeocoded.length === 1 ? "address" : "addresses"}
          </Button>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 shadow-card">
        <Icon name="upload_file" className="text-[20px] text-ink-subtle" />
        <div className="min-w-0 flex-1">
          <p className="text-body-sm font-medium text-ink">
            No CRM sync yet — import a CSV instead
          </p>
          <p className="text-caption text-ink-muted">
            Orders land as pending in the same shape the webhook will produce,
            so nothing has to be redone when{" "}
            <code className="font-mono">/api/webhooks/crm</code> is built.
          </p>
        </div>
        <Badge tone="warn" dot>
          Stopgap
        </Badge>
        <Button variant="primary" icon="upload" onClick={() => setDialogOpen(true)}>
          Import CSV
        </Button>
      </div>

      <OrdersTable
        orders={orders}
        loadRefByOrderId={loadRefByOrderId}
        importedIds={importedIds}
        onFixAddress={(id) => setFixing({ startWith: id })}
      />

      {fixing ? (
        <FixAddressesDialog
          orders={stats.ungeocoded}
          startWith={fixing.startWith}
          onSave={handleFix}
          onClose={() => setFixing(null)}
        />
      ) : null}

      {dialogOpen ? (
        <ImportDialog
          existingRefs={existingRefs}
          now={DEMO_NOW}
          onImport={handleImport}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
