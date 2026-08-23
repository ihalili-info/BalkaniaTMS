"use client";

import { useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CountryChip,
  CustomsBadge,
  Icon,
  OrderStatusBadge,
  Table,
  Td,
  Th,
  Tr,
  cx,
  EmptyState,
} from "@/components/ui";
import { formatDate, formatClock } from "@/lib/format";
import { DEPOT } from "@/lib/demo/fleet";
import { customsRegime } from "@/lib/regions";
import type { Order, OrderStatus } from "@/lib/types";

type Filter = "all" | OrderStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "assigned", label: "Assigned" },
  { key: "en_route", label: "En route" },
  { key: "delivered", label: "Delivered" },
];

export function OrdersTable({
  orders,
  loadRefByOrderId,
  importedIds,
}: {
  orders: Order[];
  loadRefByOrderId: Record<string, string>;
  /** Ids added by CSV import this session — marked so they are traceable. */
  importedIds?: Set<string>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const counts = useMemo(() => {
    const map: Record<Filter, number> = {
      all: orders.length,
      pending: 0,
      assigned: 0,
      en_route: 0,
      delivered: 0,
    };
    for (const o of orders) map[o.status] += 1;
    return map;
  }, [orders]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (filter !== "all" && o.status !== filter) return false;
      if (!q) return true;
      return (
        o.customer_name.toLowerCase().includes(q) ||
        o.crm_order_id.toLowerCase().includes(q) ||
        o.delivery_address.toLowerCase().includes(q) ||
        (o.delivery_postcode ?? "").toLowerCase().includes(q)
      );
    });
  }, [orders, filter, query]);

  // Only unassigned orders can be put on a new load.
  const selectable = visible.filter((o) => o.status === "pending");
  const allSelected =
    selectable.length > 0 && selectable.every((o) => selected.includes(o.id));

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleAll = () =>
    setSelected(allSelected ? [] : selectable.map((o) => o.id));

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={cx(
                "flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-body-sm transition-colors",
                filter === f.key
                  ? "bg-brand-soft font-medium text-brand-ink"
                  : "text-ink-muted hover:bg-surface-muted hover:text-ink",
              )}
            >
              {f.label}
              <span className="font-mono text-label tabular text-ink-subtle">
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>

        <label className="ml-auto flex h-9 w-full max-w-xs items-center gap-2 rounded-sm border border-hairline bg-surface-muted px-3 focus-within:border-brand-border focus-within:bg-surface">
          <Icon name="filter_alt" className="text-[17px] text-ink-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by customer, CRM id, address or postcode"
            className="w-full bg-transparent text-body-sm outline-none placeholder:text-ink-subtle"
          />
        </label>
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-brand-border bg-brand-soft px-5 py-2.5">
          <span className="text-body-sm text-brand-ink">
            {selected.length} order{selected.length === 1 ? "" : "s"} selected
          </span>
          <Button
            variant="primary"
            icon="add_road"
            className="ml-auto"
            onClick={() => setSelected([])}
          >
            Assign to load
          </Button>
          <Button variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="No orders match"
          description="Adjust the status filter or clear the search to see the rest of the queue."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={selectable.length === 0}
                  aria-label="Select all assignable orders"
                  className="size-3.5 accent-brand"
                />
              </Th>
              <Th>CRM order</Th>
              <Th>Customer</Th>
              <Th>Delivery address</Th>
              <Th>Destination</Th>
              <Th>Status</Th>
              <Th>Load</Th>
              <Th className="text-right">Received</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((order) => {
              const ref = loadRefByOrderId[order.id];
              const ungeocoded = order.delivery_location === null;
              return (
                <Tr key={order.id}>
                  <Td>
                    <input
                      type="checkbox"
                      checked={selected.includes(order.id)}
                      onChange={() => toggle(order.id)}
                      disabled={order.status !== "pending"}
                      aria-label={`Select ${order.crm_order_id}`}
                      className="size-3.5 accent-brand disabled:opacity-30"
                    />
                  </Td>
                  <Td className="font-mono text-data-sm text-ink">
                    {order.crm_order_id}
                    {importedIds?.has(order.id) ? (
                      <Badge tone="brand" className="mt-1 block w-fit">
                        <Icon name="upload_file" className="text-[12px]" />
                        Imported
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="font-medium text-ink">
                      {order.customer_name}
                    </span>
                    <span className="block font-mono text-data-sm text-ink-subtle">
                      {order.customer_phone}
                    </span>
                  </Td>
                  <Td className="max-w-xs">
                    <span className="block truncate text-ink-muted">
                      {order.delivery_address}
                    </span>
                    {order.delivery_postcode ? (
                      <span className="font-mono text-data-sm text-ink-subtle">
                        {order.delivery_postcode}
                      </span>
                    ) : null}
                    {ungeocoded ? (
                      <Badge tone="danger" className="mt-1">
                        No coordinates
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <CountryChip code={order.delivery_country} />
                      <CustomsBadge
                        regime={customsRegime(
                          DEPOT.country,
                          order.delivery_country,
                        )}
                      />
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <OrderStatusBadge status={order.status} />
                      {order.notifications_opt_out ? (
                        <Badge
                          tone="neutral"
                          title="Customer replied STOP — no alerts may be sent (ePrivacy)"
                        >
                          <Icon name="notifications_off" className="text-[13px]" />
                          No alerts
                        </Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="font-mono text-data-sm text-ink-muted">
                    {ref ?? "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-right text-ink-muted tabular">
                    {formatDate(order.created_at)}
                    <span className="block text-caption text-ink-subtle">
                      {formatClock(order.created_at)}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
