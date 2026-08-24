import { createClient } from "@/lib/supabase/server";
import type { NotificationType } from "@/lib/types";
import type { CountryCode } from "@/lib/regions";

/**
 * Analytics, aggregated in Postgres rather than in the browser.
 *
 * On-time rate is measured only against orders that carried a promise
 * (`orders.promised_at`). Anything without one is excluded rather than counted
 * as on time — a rate computed over a denominator of zero is not 100%, it is
 * unknown, and the UI says so.
 */

export interface DayPoint {
  date: string;
  deliveries: number;
  onTime: number;
  measurable: number;
}

export interface DestinationRow {
  country: CountryCode;
  deliveries: number;
  onTime: number;
  measurable: number;
}

export interface AnalyticsSummary {
  days: DayPoint[];
  alerts: { type: NotificationType; sent: number }[];
  destinations: DestinationRow[];
  totalDeliveries: number;
  /** null when nothing in the window carried a promised time. */
  onTimePct: number | null;
  measurable: number;
  alertsSent: number;
  avgAlertLeadMin: number | null;
  hasAnyData: boolean;
}

export async function getAnalytics(days = 14): Promise<AnalyticsSummary> {
  const supabase = await createClient();

  const [daily, alerts, destinations, lead] = await Promise.all([
    supabase.rpc("analytics_daily", { p_days: days }),
    supabase.rpc("analytics_alerts", { p_days: days }),
    supabase.rpc("analytics_destinations", { p_days: days }),
    supabase.rpc("analytics_alert_lead_minutes", { p_days: days }),
  ]);

  const dayRows = (daily.data ?? []) as {
    day: string;
    deliveries: number;
    on_time: number;
    measurable: number;
  }[];

  const points: DayPoint[] = dayRows.map((r) => ({
    date: r.day,
    deliveries: Number(r.deliveries ?? 0),
    onTime: Number(r.on_time ?? 0),
    measurable: Number(r.measurable ?? 0),
  }));

  const totalDeliveries = points.reduce((n, d) => n + d.deliveries, 0);
  const measurable = points.reduce((n, d) => n + d.measurable, 0);
  const onTime = points.reduce((n, d) => n + d.onTime, 0);

  const alertRows = (alerts.data ?? []) as { type: string; sent: number }[];
  const alertList = alertRows.map((a) => ({
    type: a.type as NotificationType,
    sent: Number(a.sent ?? 0),
  }));

  const destRows = (destinations.data ?? []) as {
    country: string;
    deliveries: number;
    on_time: number;
    measurable: number;
  }[];

  const leadValue = typeof lead.data === "number" ? lead.data : null;

  return {
    days: points,
    alerts: alertList,
    destinations: destRows.map((d) => ({
      country: d.country,
      deliveries: Number(d.deliveries ?? 0),
      onTime: Number(d.on_time ?? 0),
      measurable: Number(d.measurable ?? 0),
    })),
    totalDeliveries,
    measurable,
    onTimePct:
      measurable === 0 ? null : Math.round((onTime / measurable) * 1000) / 10,
    alertsSent: alertList.reduce((n, a) => n + a.sent, 0),
    avgAlertLeadMin: leadValue === null ? null : Math.round(leadValue),
    hasAnyData: totalDeliveries > 0 || alertList.length > 0,
  };
}
