import type { Metadata } from "next";

import { Button, Page, PageHeader } from "@/components/ui";
import { getLoads, getOrders, loadRefByOrderId } from "@/lib/data/fleet";

import { OrdersWorkspace } from "./orders-workspace";

export const metadata: Metadata = { title: "Orders Queue" };

export default async function OrdersQueuePage() {
  const [orders, loads] = await Promise.all([getOrders(), getLoads()]);

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Orders Queue"
        description="Orders waiting to be placed on a load. Until the CRM webhook is built, they arrive by CSV import. Destination country drives the customs position for the run."
        actions={<Button icon="download">Export CSV</Button>}
      />

      <OrdersWorkspace
        initialOrders={orders}
        loadRefByOrderId={loadRefByOrderId(loads)}
      />
    </Page>
  );
}
