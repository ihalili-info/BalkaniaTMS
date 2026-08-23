/**
 * Demo analytics fixtures. Fourteen days ending on `DEMO_NOW`, weekdays busy
 * and weekends light, so the charts show a real shape rather than noise.
 */

import type { NotificationType } from "../types";

export interface DayPoint {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  deliveries: number;
  on_time_pct: number;
}

export const dailySeries: DayPoint[] = [
  { date: "2026-08-10", deliveries: 34, on_time_pct: 93.1 },
  { date: "2026-08-11", deliveries: 41, on_time_pct: 94.4 },
  { date: "2026-08-12", deliveries: 38, on_time_pct: 91.8 },
  { date: "2026-08-13", deliveries: 44, on_time_pct: 95.2 },
  { date: "2026-08-14", deliveries: 47, on_time_pct: 96.1 },
  { date: "2026-08-15", deliveries: 22, on_time_pct: 97.3 },
  { date: "2026-08-16", deliveries: 9, on_time_pct: 98.0 },
  { date: "2026-08-17", deliveries: 36, on_time_pct: 92.6 },
  { date: "2026-08-18", deliveries: 43, on_time_pct: 94.9 },
  { date: "2026-08-19", deliveries: 39, on_time_pct: 93.4 },
  { date: "2026-08-20", deliveries: 48, on_time_pct: 95.8 },
  { date: "2026-08-21", deliveries: 52, on_time_pct: 96.7 },
  { date: "2026-08-22", deliveries: 26, on_time_pct: 97.1 },
  { date: "2026-08-23", deliveries: 11, on_time_pct: 96.2 },
];

export const alertsByType: { type: NotificationType; count: number }[] = [
  { type: "dispatch_confirmation", count: 168 },
  { type: "proximity_alert", count: 151 },
  { type: "delivery_complete", count: 142 },
];

export interface CorridorRow {
  /** Named for the run, not the country pair — a corridor can cross both. */
  corridor: string;
  deliveries: number;
  on_time_pct: number;
  avg_stops: number;
}

export const corridors: CorridorRow[] = [
  { corridor: "Dublin — Cork", deliveries: 96, on_time_pct: 97.9, avg_stops: 4.2 },
  { corridor: "Dublin — Galway / Limerick", deliveries: 84, on_time_pct: 94.0, avg_stops: 3.6 },
  { corridor: "Dublin — Waterford / Wexford", deliveries: 61, on_time_pct: 95.1, avg_stops: 3.1 },
  { corridor: "Dublin — Belfast (XI)", deliveries: 47, on_time_pct: 89.4, avg_stops: 2.8 },
  { corridor: "Dublin — GB via Holyhead", deliveries: 38, on_time_pct: 86.1, avg_stops: 2.4 },
];

const totalDeliveries = dailySeries.reduce((n, d) => n + d.deliveries, 0);

const weightedOnTime =
  dailySeries.reduce((n, d) => n + d.on_time_pct * d.deliveries, 0) /
  totalDeliveries;

export const summary = {
  deliveries: totalDeliveries,
  onTimePct: Math.round(weightedOnTime * 10) / 10,
  /** Change in on-time rate against the preceding 14 days, in points. */
  onTimeDeltaPts: 1.4,
  alertsSent: alertsByType.reduce((n, a) => n + a.count, 0),
  /** Minutes between a proximity alert firing and the stop being completed. */
  avgAlertLeadMin: 18,
  failedGeocodes: 1,
};
