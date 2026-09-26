import type { Metadata } from "next";

import { Page, PageHeader } from "@/components/ui";
import { getOrders } from "@/lib/data/fleet";
import { hereMapsKey } from "@/lib/maps.server";

import { OrdersMap } from "./orders-map";

export const metadata: Metadata = { title: "Orders Map" };

export default async function OrdersMapPage() {
  const orders = await getOrders();

  return (
    <Page>
      <PageHeader
        eyebrow="Dispatch"
        title="Orders Map"
        description="Every order with a delivery location, on one map: green where the delivery is done, red where it is not. Narrow it to a day or a range to see what was completed when."
      />
      <OrdersMap orders={orders} hereMapsKey={hereMapsKey()} />
    </Page>
  );
}
