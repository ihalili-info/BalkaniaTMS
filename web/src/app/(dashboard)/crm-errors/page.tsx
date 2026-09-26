import type { Metadata } from "next";
import Link from "next/link";

import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  Page,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { getCrmErrors, type CrmOrderIssue } from "@/lib/data/crm-errors";
import { relativeTime } from "@/lib/format";

export const metadata: Metadata = { title: "CRM Errors" };

export default async function CrmErrorsPage() {
  const errors = await getCrmErrors();
  const now = new Date();

  return (
    <Page>
      <PageHeader
        eyebrow="Insight"
        title="CRM Errors"
        description={`Orders the CRM sent that did not make it into the TMS cleanly, and what is wrong with each — the last ${errors.windowDays} days. Fix them in the CRM; an order leaves this list once it has been accepted.`}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatTile
          label="Not received"
          value={errors.rejected.length}
          hint="Refused by the TMS, still missing"
          icon="cloud_off"
          tone={errors.rejected.length > 0 ? "danger" : "ok"}
        />
        <StatTile
          label="Cancellations to do"
          value={errors.cancellations.length}
          hint="CRM cancelled it, but it is on a load"
          icon="cancel_schedule_send"
          tone={errors.cancellations.length > 0 ? "warn" : "ok"}
        />
        <StatTile
          label="No location"
          value={errors.unlocatedTotal}
          hint="Arrived, but cannot be put on a map"
          icon="wrong_location"
          tone={errors.unlocatedTotal > 0 ? "warn" : "ok"}
        />
      </div>

      {errors.truncated ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-warn-border bg-warn-soft px-4 py-3 text-body-sm text-ink-muted">
          <Icon name="warning" className="mt-px text-[18px] text-warn" />
          The log is very busy, so the oldest failures in the window may not be
          listed here.
        </p>
      ) : null}

      {/* --- refused orders --------------------------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Orders that did not arrive"
          hint="Refused by the TMS and not accepted since — latest reason per order"
        />

        {errors.rejected.length === 0 ? (
          <EmptyState
            icon="check_circle"
            title="Nothing is being refused"
            description="Every order the CRM has pushed in this window was accepted, or has been accepted since it was first refused."
          />
        ) : (
          <>
            <ul className="flex flex-wrap gap-2 border-b border-hairline px-5 py-3">
              {errors.rejectedByCause.map((c) => (
                <li key={c.what}>
                  <Badge tone="danger">
                    {c.count} × {c.what}
                  </Badge>
                </li>
              ))}
            </ul>
            <IssueTable issues={errors.rejected} now={now} detail="What is wrong" />
          </>
        )}
      </Card>

      {/* --- cancellations we could not apply --------------------------- */}
      <Card className="mb-6">
        <CardHeader
          title="Cancellations that need doing by hand"
          hint="The CRM cancelled these, but they are already on a load — the TMS will not pull a stop off a load by itself"
        />
        {errors.cancellations.length === 0 ? (
          <EmptyState
            icon="check_circle"
            title="No cancellations waiting"
            description="Every cancellation the CRM sent was applied, or referred to an order that was not on a load."
          />
        ) : (
          <IssueTable
            issues={errors.cancellations}
            now={now}
            detail="What to do"
            useReason
          />
        )}
      </Card>

      {/* --- arrived, but no coordinates -------------------------------- */}
      <Card>
        <CardHeader
          title="Arrived without a location"
          hint="The address could not be placed on the map, so these cannot be planned or tracked"
          actions={
            <Link
              href="/orders-queue"
              prefetch={false}
              className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-hairline-strong bg-surface px-3 text-body-sm font-medium text-ink transition-colors hover:bg-surface-muted"
            >
              <Icon name="edit_location_alt" className="text-[16px]" />
              Fix in Orders Queue
            </Link>
          }
        />
        {errors.unlocated.length === 0 ? (
          <EmptyState
            icon="check_circle"
            title="Every pending order has a location"
            description="Nothing is waiting on a geocode or a manual address fix."
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Customer</Th>
                  <Th>Delivery address</Th>
                  <Th className="text-right">Received</Th>
                </tr>
              </thead>
              <tbody>
                {errors.unlocated.map((o) => (
                  <Tr key={o.id}>
                    <Td className="font-mono text-data-sm text-ink">
                      {o.crm_order_id}
                    </Td>
                    <Td className="text-ink">{o.customer_name}</Td>
                    <Td className="max-w-md text-ink-muted">
                      <span className="block truncate">{o.delivery_address}</span>
                      {o.delivery_postcode ? (
                        <span className="font-mono text-data-sm text-ink-subtle">
                          {o.delivery_postcode}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-right text-caption text-ink-subtle">
                      {relativeTime(o.created_at, now)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {errors.unlocatedTotal > errors.unlocated.length ? (
              <p className="border-t border-hairline px-5 py-3 text-caption text-ink-subtle">
                Showing the newest {errors.unlocated.length} of{" "}
                {errors.unlocatedTotal}.
              </p>
            ) : null}
          </>
        )}
      </Card>
    </Page>
  );
}

function IssueTable({
  issues,
  now,
  detail,
  useReason = false,
}: {
  issues: CrmOrderIssue[];
  now: Date;
  detail: string;
  /** Show the endpoint's own wording rather than the translated cause. */
  useReason?: boolean;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Order</Th>
          <Th>{detail}</Th>
          <Th className="text-right">Tried</Th>
          <Th className="text-right">Last seen</Th>
        </tr>
      </thead>
      <tbody>
        {issues.map((i) => (
          <Tr key={i.ref}>
            <Td className="font-mono text-data-sm text-ink">{i.ref}</Td>
            <Td className="text-ink-muted">
              {useReason ? i.reason : i.what}
              {!useReason && i.what !== i.reason ? (
                <span className="ml-2 font-mono text-caption text-ink-subtle">
                  {i.reason}
                </span>
              ) : null}
            </Td>
            <Td className="whitespace-nowrap text-right text-caption text-ink-subtle tabular">
              {i.attempts}×
            </Td>
            <Td className="whitespace-nowrap text-right text-caption text-ink-subtle">
              {relativeTime(i.lastSeen, now)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
