import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  Table,
  Td,
  Th,
  Tr,
  cx,
  type Tone,
} from "@/components/ui";
import type { InvoiceFeedHealth } from "@/lib/data/invoice-feed";
import { relativeTime } from "@/lib/format";

const OUTCOME: Record<string, { tone: Tone; label: string }> = {
  created: { tone: "ok", label: "Created" },
  updated: { tone: "ok", label: "Updated" },
  voided: { tone: "neutral", label: "Voided" },
  skipped: { tone: "warn", label: "Skipped" },
  rejected: { tone: "danger", label: "Rejected" },
  unauthorized: { tone: "danger", label: "Auth failed" },
  bad_request: { tone: "danger", label: "Bad request" },
};

/**
 * What the invoice ingestion webhook has actually received.
 *
 * The unmatched count is the one that earns this card its place: an invoice
 * with no `order_id` is invisible to every driver by RLS, so without this it
 * presents as "the phone shows nothing for this drop" and gets diagnosed as an
 * app bug rather than a reference mismatch.
 */
export function InvoiceFeedCard({
  health,
  now,
}: {
  health: InvoiceFeedHealth;
  now: Date;
}) {
  const working = (health.totals.created ?? 0) + (health.totals.updated ?? 0) > 0;

  return (
    <Card className="mt-4">
      <CardHeader
        title="Invoice feed"
        hint="What the ERP has sent to /api/webhooks/invoices"
        actions={
          <Badge tone={working ? "ok" : health.lastDelivery ? "warn" : "neutral"} dot>
            {working
              ? "Receiving"
              : health.lastDelivery
                ? "Calling, not storing"
                : "Never called"}
          </Badge>
        }
      />

      <div className="grid gap-px bg-hairline sm:grid-cols-3">
        {[
          {
            label: "Last delivery",
            value: health.lastDelivery ? relativeTime(health.lastDelivery, now) : "never",
          },
          {
            label: "Matched to a delivery",
            value: `${health.invoicesTotal - health.invoicesUnmatched} / ${health.invoicesTotal}`,
          },
          {
            label: "Recent outcomes",
            value:
              Object.keys(health.totals).length === 0
                ? "—"
                : Object.entries(health.totals)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(", "),
          },
        ].map((cell) => (
          <div key={cell.label} className="bg-surface px-5 py-3">
            <p className="font-mono text-label uppercase text-ink-subtle">{cell.label}</p>
            <p className="mt-0.5 text-body-sm text-ink">{cell.value}</p>
          </div>
        ))}
      </div>

      <p
        className={cx(
          "flex items-start gap-2 border-t border-hairline px-5 py-3 text-body-sm",
          working && health.invoicesUnmatched === 0
            ? "text-ink-muted"
            : "bg-warn-soft text-ink-muted",
        )}
      >
        <Icon
          name={working && health.invoicesUnmatched === 0 ? "check_circle" : "troubleshoot"}
          className={cx(
            "mt-px text-[18px]",
            working && health.invoicesUnmatched === 0 ? "text-ok" : "text-warn",
          )}
        />
        {health.diagnosis}
      </p>

      {health.invoicesMismatched > 0 ? (
        <p className="flex items-start gap-2 border-t border-hairline bg-warn-soft px-5 py-3 text-body-sm text-ink-muted">
          <Icon name="calculate" className="mt-px text-[18px] text-warn" />
          {health.invoicesMismatched} invoice
          {health.invoicesMismatched === 1 ? "" : "s"} where the lines do not sum to the
          ERP&rsquo;s own total. Stored exactly as sent and never corrected — but worth
          checking the export before a driver takes one to a door.
        </p>
      ) : null}

      {health.recent.length === 0 ? (
        <EmptyState
          icon="receipt_long"
          title="No deliveries recorded"
          description="Every call to the webhook is logged here — including rejected ones — so this staying empty means nothing has reached it."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-32">When</Th>
              <Th>Invoice</Th>
              <Th>Outcome</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody>
            {health.recent.map((d) => {
              const meta = OUTCOME[d.outcome] ?? OUTCOME.rejected;
              return (
                <Tr key={d.id}>
                  <Td className="whitespace-nowrap text-caption text-ink-subtle">
                    {relativeTime(d.received_at, now)}
                  </Td>
                  <Td className="font-mono text-data-sm text-ink">
                    {d.crm_invoice_id ?? "—"}
                    {d.action === "void" ? (
                      <span className="ml-1 text-caption text-ink-subtle">void</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </Td>
                  <Td className="text-caption text-ink-muted">{d.reason ?? "—"}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
