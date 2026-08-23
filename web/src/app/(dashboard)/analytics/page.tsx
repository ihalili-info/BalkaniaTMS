import type { Metadata } from "next";

import { CategoryBars, ColumnChart, LineChart } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  NOTIFICATION_LABEL,
  Page,
  PageHeader,
  Progress,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import {
  alertsByType,
  corridors,
  dailySeries,
  summary,
} from "@/lib/demo/analytics";

export const metadata: Metadata = { title: "Analytics" };

const CATEGORY_COLORS = [
  "var(--color-viz-1)",
  "var(--color-viz-2)",
  "var(--color-viz-3)",
];

const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "2-digit", timeZone: "UTC" }).format(
    new Date(iso),
  );

const dayCaption = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(iso));

const deliveryPoints = dailySeries.map((d) => ({
  label: dayLabel(d.date),
  value: d.deliveries,
  caption: dayCaption(d.date),
}));

const onTimePoints = dailySeries.map((d) => ({
  label: dayLabel(d.date),
  value: d.on_time_pct,
  caption: dayCaption(d.date),
}));

const alertCategories = alertsByType.map((a, i) => ({
  label: NOTIFICATION_LABEL[a.type],
  value: a.count,
  color: CATEGORY_COLORS[i],
}));

const maxCorridorDeliveries = Math.max(...corridors.map((c) => c.deliveries));

export default function AnalyticsPage() {
  return (
    <Page>
      <PageHeader
        eyebrow="Insight"
        title="Analytics"
        description="Delivery throughput, punctuality and customer-alert volume across the last fourteen days."
        actions={
          <>
            <Button icon="calendar_month">Last 14 days</Button>
            <Button variant="primary" icon="download">
              Export report
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="On-time rate"
          value={summary.onTimePct}
          unit="%"
          hint={`+${summary.onTimeDeltaPts} pts vs. previous 14 days`}
          icon="schedule"
          tone="ok"
        />
        <StatTile
          label="Deliveries"
          value={summary.deliveries}
          hint="Completed stops"
          icon="package_2"
          tone="brand"
        />
        <StatTile
          label="Alerts sent"
          value={summary.alertsSent}
          hint="SMS and WhatsApp combined"
          icon="forum"
        />
        <StatTile
          label="Alert lead time"
          value={summary.avgAlertLeadMin}
          unit="min"
          hint="Proximity alert to delivery"
          icon="notifications_active"
          tone="warn"
        />
      </div>

      {/* Two measures, two scales — deliberately two plots on one axis each,
          never a dual-axis chart. */}
      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Deliveries per day"
            hint="Completed stops, last 14 days"
          />
          <CardBody>
            <ColumnChart data={deliveryPoints} unit="deliveries" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="On-time rate"
            hint="Share of stops served inside the promised window"
          />
          <CardBody>
            <LineChart data={onTimePoints} unit="%" />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[20rem_1fr]">
        <Card>
          <CardHeader title="Alerts by type" hint="Sent sends, last 14 days" />
          <CardBody>
            <CategoryBars items={alertCategories} unit="Sent" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Corridor performance"
            hint="Where the fleet runs and how well"
            actions={
              <Badge tone={corridors.some((c) => c.on_time_pct < 90) ? "warn" : "ok"} dot>
                {corridors.filter((c) => c.on_time_pct < 90).length} below 90%
              </Badge>
            }
          />
          <Table>
            <thead>
              <tr>
                <Th>Corridor</Th>
                <Th className="w-56">Deliveries</Th>
                <Th className="text-right">Avg stops / load</Th>
                <Th className="text-right">On time</Th>
              </tr>
            </thead>
            <tbody>
              {corridors.map((c) => (
                <Tr key={c.corridor}>
                  <Td className="font-medium text-ink">{c.corridor}</Td>
                  <Td>
                    <div className="flex items-center gap-3">
                      <Progress
                        value={c.deliveries}
                        max={maxCorridorDeliveries}
                        className="flex-1"
                      />
                      <span className="w-8 shrink-0 text-right font-mono text-data-sm tabular text-ink-muted">
                        {c.deliveries}
                      </span>
                    </div>
                  </Td>
                  <Td className="text-right font-mono text-data-sm tabular text-ink-muted">
                    {c.avg_stops.toFixed(1)}
                  </Td>
                  <Td className="text-right">
                    <span
                      className={
                        c.on_time_pct < 90
                          ? "font-mono text-data-sm tabular text-warn"
                          : "font-mono text-data-sm tabular text-ink"
                      }
                    >
                      {c.on_time_pct.toFixed(1)}%
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </Page>
  );
}
