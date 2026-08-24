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
import type { GpsFeedHealth } from "@/lib/data/gps-feed";
import { relativeTime } from "@/lib/format";

const OUTCOME: Record<string, { tone: Tone; label: string }> = {
  stored: { tone: "ok", label: "Stored" },
  skipped: { tone: "warn", label: "Skipped" },
  rejected: { tone: "danger", label: "Rejected" },
  unauthorized: { tone: "danger", label: "Auth failed" },
  bad_request: { tone: "danger", label: "Bad request" },
};

/**
 * What the GPS webhook has actually received.
 *
 * Exists because "no fixes yet" has four different causes that are
 * indistinguishable from the dashboard, and each needs a different fix.
 */
export function GpsFeedCard({
  health,
  now,
}: {
  health: GpsFeedHealth;
  now: Date;
}) {
  const working = (health.totals.stored ?? 0) > 0;

  return (
    <Card className="mt-4">
      <CardHeader
        title="GPS feed"
        hint="What Verizon Connect Reveal has sent to /api/webhooks/gps"
        actions={
          <Badge tone={working ? "ok" : health.lastDelivery ? "warn" : "neutral"} dot>
            {working
              ? "Receiving"
              : health.lastDelivery
                ? "Delivering, not storing"
                : "Never called"}
          </Badge>
        }
      />

      <div className="grid gap-px bg-hairline sm:grid-cols-3">
        {[
          {
            label: "Last delivery",
            value: health.lastDelivery
              ? relativeTime(health.lastDelivery, now)
              : "never",
          },
          {
            label: "Trucks with a fix",
            value: `${health.trucksWithFix} / ${health.trucksTotal}`,
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
            <p className="font-mono text-label uppercase text-ink-subtle">
              {cell.label}
            </p>
            <p className="mt-0.5 text-body-sm text-ink">{cell.value}</p>
          </div>
        ))}
      </div>

      <p
        className={cx(
          "flex items-start gap-2 border-t border-hairline px-5 py-3 text-body-sm",
          working ? "text-ink-muted" : "bg-warn-soft text-ink-muted",
        )}
      >
        <Icon
          name={working ? "check_circle" : "troubleshoot"}
          className={cx("mt-px text-[18px]", working ? "text-ok" : "text-warn")}
        />
        {health.diagnosis}
      </p>

      {health.recent.length === 0 ? (
        <EmptyState
          icon="satellite_alt"
          title="No deliveries recorded"
          description="Every call to the webhook is logged here — including rejected ones — so this staying empty means nothing has reached it."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-32">When</Th>
              <Th>Vehicle No.</Th>
              <Th>Outcome</Th>
              <Th>Reason</Th>
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
                    {d.vehicle_number ?? "—"}
                  </Td>
                  <Td>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </Td>
                  <Td className="text-caption text-ink-muted">
                    {d.reason ?? "—"}
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
