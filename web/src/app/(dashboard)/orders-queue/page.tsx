import type { Metadata } from "next";

import { Button, Page, PageHeader } from "@/components/ui";
import { loadRefByOrderId, orders } from "@/lib/demo/fleet";

import { OrdersWorkspace } from "./orders-workspace";

export const metadata: Metadata = { title: "Orders Queue" };

/** Newest first — the top of a queue should be the work that just arrived. */
const byNewest = [...orders].sort((a, b) =>
  b.created_at.localeCompare(a.created_at),
);

export default function OrdersQueuePage() {
  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Orders Queue"
        description="Orders waiting to be placed on a load. Until the CRM webhook is built, they arrive by CSV import. Destination country drives the customs position for the run."
        actions={
          <Button icon="download">Export CSV</Button>
        }
      />

      <OrdersWorkspace
        initialOrders={byNewest}
        loadRefByOrderId={loadRefByOrderId}
      />
    </Page>
  );
}
