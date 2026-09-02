import type { Metadata } from "next";

import { CategoryBars, ColumnChart, LineChart } from "@/components/charts";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icon,
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
import { getAnalytics } from "@/lib/data/analytics";
import { country } from "@/lib/regions";

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

export default async function AnalyticsPage() {
  const a = await getAnalytics(14);

  const deliveryPoints = a.days.map((d) => ({
    label: dayLabel(d.date),
    value: d.deliveries,
    caption: dayCaption(d.date),
  }));

  // Only days with something to measure belong on an on-time chart.
  const onTimePoints = a.days
    .filter((d) => d.measurable > 0)
    .map((d) => ({
      label: dayLabel(d.date),
      value: Math.round((d.onTime / d.measurable) * 1000) / 10,
      caption: dayCaption(d.date),
    }));

  const alertCategories = a.alerts.map((x, i) => ({
    label: NOTIFICATION_LABEL[x.type] ?? x.type,
    value: x.sent,
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
  }));

  const maxDeliveries = Math.max(1, ...a.destinations.map((d) => d.deliveries));
  const maxCityDeliveries = Math.max(1, ...a.cities.map((c) => c.deliveries));
  const cityUnknown = a.cities.find((c) => c.city === "Unknown")?.deliveries ?? 0;

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

      {!a.hasAnyData ? (
        <Card>
          <EmptyState
            icon="monitoring"
            title="Nothing to report yet"
            description="Figures appear once loads start completing and alerts start going out. Nothing here is estimated or back-filled."
          />
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile
              label="On-time rate"
              value={a.onTimePct ?? "—"}
              unit={a.onTimePct === null ? undefined : "%"}
              hint={
                a.onTimePct === null
                  ? "No orders carried a promised time"
                  : `Measured over ${a.measurable} of ${a.totalDeliveries} deliveries`
              }
              icon="schedule"
              tone={a.onTimePct === null ? "neutral" : "ok"}
            />
            <StatTile
              label="Deliveries"
              value={a.totalDeliveries}
              hint="Completed stops"
              icon="package_2"
              tone="brand"
            />
            <StatTile
              label="Alerts sent"
              value={a.alertsSent}
              hint="SMS, WhatsApp and RCS via Sent"
              icon="forum"
            />
            <StatTile
              label="Alert lead time"
              value={a.avgAlertLeadMin ?? "—"}
              unit={a.avgAlertLeadMin === null ? undefined : "min"}
              hint="Proximity alert to delivery"
              icon="notifications_active"
              tone="warn"
            />
          </div>

          {a.onTimePct === null ? (
            <p className="mb-4 flex items-start gap-2 rounded-lg border border-warn-border bg-warn-soft px-4 py-3 text-body-sm text-ink-muted">
              <Icon name="info" className="mt-px text-[18px] text-warn" />
              <span>
                On-time performance needs a promised delivery time. Populate{" "}
                <code className="font-mono">orders.promised_at</code> from the
                CRM or the CSV import and the rate starts filling in — until
                then it is left blank rather than guessed at.
              </span>
            </p>
          ) : null}

          {/* Two measures, two scales — two plots on one axis each, never a
              dual-axis chart. */}
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
                hint="Share of promised deliveries met"
              />
              <CardBody>
                {onTimePoints.length > 0 ? (
                  <LineChart data={onTimePoints} unit="%" />
                ) : (
                  <EmptyState
                    icon="schedule"
                    title="No promised times recorded"
                    description="Nothing in this window can be measured for punctuality."
                  />
                )}
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[20rem_1fr]">
            <Card>
              <CardHeader
                title="Alerts by type"
                hint="sent.dm sends, last 14 days"
              />
              <CardBody>
                {alertCategories.length > 0 ? (
                  <CategoryBars items={alertCategories} unit="Sent" />
                ) : (
                  <EmptyState icon="forum" title="No alerts sent yet" />
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Destinations"
                hint="Where the fleet delivered, by country"
                actions={
                  <Badge tone="neutral">
                    {a.destinations.length} countr
                    {a.destinations.length === 1 ? "y" : "ies"}
                  </Badge>
                }
              />
              {a.destinations.length > 0 ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>Country</Th>
                      <Th className="w-56">Deliveries</Th>
                      <Th className="text-right">On time</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.destinations.map((d) => {
                      const pct =
                        d.measurable === 0
                          ? null
                          : Math.round((d.onTime / d.measurable) * 1000) / 10;
                      return (
                        <Tr key={d.country}>
                          <Td className="font-medium text-ink">
                            {country(d.country).name}
                            <span className="ml-1.5 font-mono text-data-sm text-ink-subtle">
                              {d.country}
                            </span>
                          </Td>
                          <Td>
                            <div className="flex items-center gap-3">
                              <Progress
                                value={d.deliveries}
                                max={maxDeliveries}
                                className="flex-1"
                              />
                              <span className="w-8 shrink-0 text-right font-mono text-data-sm tabular text-ink-muted">
                                {d.deliveries}
                              </span>
                            </div>
                          </Td>
                          <Td className="text-right font-mono text-data-sm tabular">
                            {pct === null ? (
                              <span
                                className="text-ink-subtle"
                                title="No promised times for this country"
                              >
                                —
                              </span>
                            ) : (
                              <span
                                className={pct < 90 ? "text-warn" : "text-ink"}
                              >
                                {pct.toFixed(1)}%
                              </span>
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              ) : (
                <EmptyState
                  icon="public"
                  title="No completed deliveries yet"
                  description="Destinations appear as loads finish."
                />
              )}
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader
              title="Destinations by city"
              hint="Where the fleet delivered, by town / city"
              actions={
                a.cities.length > 0 ? (
                  <Badge tone="neutral">
                    {a.cities.length} cit{a.cities.length === 1 ? "y" : "ies"}
                  </Badge>
                ) : undefined
              }
            />
            {a.cities.length > 0 ? (
              <>
                <div className="max-h-96 overflow-y-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>City</Th>
                        <Th className="w-56">Deliveries</Th>
                        <Th className="text-right">On time</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.cities.map((c) => {
                        const pct =
                          c.measurable === 0
                            ? null
                            : Math.round((c.onTime / c.measurable) * 1000) / 10;
                        return (
                          <Tr key={`${c.city}|${c.country}`}>
                            <Td className="font-medium text-ink">
                              {c.city === "Unknown" ? (
                                <span className="text-ink-subtle">
                                  No city recorded
                                </span>
                              ) : (
                                <>
                                  {c.city}
                                  <span className="ml-1.5 font-mono text-data-sm text-ink-subtle">
                                    {c.country}
                                  </span>
                                </>
                              )}
                            </Td>
                            <Td>
                              <div className="flex items-center gap-3">
                                <Progress
                                  value={c.deliveries}
                                  max={maxCityDeliveries}
                                  className="flex-1"
                                />
                                <span className="w-8 shrink-0 text-right font-mono text-data-sm tabular text-ink-muted">
                                  {c.deliveries}
                                </span>
                              </div>
                            </Td>
                            <Td className="text-right font-mono text-data-sm tabular">
                              {pct === null ? (
                                <span
                                  className="text-ink-subtle"
                                  title="No promised times for this city"
                                >
                                  —
                                </span>
                              ) : (
                                <span
                                  className={pct < 90 ? "text-warn" : "text-ink"}
                                >
                                  {pct.toFixed(1)}%
                                </span>
                              )}
                            </Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
                {cityUnknown > 0 ? (
                  <p className="flex items-start gap-2 border-t border-hairline px-5 py-3 text-caption text-ink-subtle">
                    <Icon name="info" className="mt-px text-[15px]" />
                    {cityUnknown} deliver{cityUnknown === 1 ? "y" : "ies"} had no{" "}
                    <code className="font-mono">delivery_city</code> — the CRM
                    bridge or CSV import populates it; nothing is inferred from
                    the address.
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon="location_city"
                title="No completed deliveries yet"
                description="City figures appear as loads finish. delivery_city comes from the CRM."
              />
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
