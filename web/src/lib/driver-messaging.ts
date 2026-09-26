/**
 * Composing the WhatsApp message a dispatcher sends a driver.
 *
 * Drivers only. Customers receive nothing from this path — their whole
 * messaging surface is the three automated types in `notifications`. See the
 * header comment on migration 0005.
 */

import { NAV_TARGETS, stopsCovered, type NavApp } from "./navigation-links";
import type { Driver, LoadView, Stop } from "./types";

/**
 * The only channel the app sends on. WhatsApp is the sole messaging channel;
 * migration 0023 stops the table accepting anything else.
 */
export type Channel = "whatsapp";

export interface DriverMessage {
  id: string;
  load_id: string;
  driver_id: string | null;
  /** `sms` / `rcs` appear only on rows sent before WhatsApp became the sole channel. */
  channel: Channel | "sms" | "rcs";
  to_phone: string;
  body: string;
  kind: "route_link" | "custom";
  sent_by: string | null;
  sent_at: string;
  status: "queued" | "sent" | "delivered" | "undelivered" | "failed";
}

/**
 * The route message.
 *
 * Only the apps the dispatcher ticked are included, each labelled with what it
 * will actually do — a Waze link that silently covers one stop of four is worse
 * than no link, because the driver assumes the whole route is loaded.
 */
export function routeMessage({
  load,
  remaining,
  apps,
  urls,
}: {
  load: LoadView;
  remaining: Stop[];
  apps: NavApp[];
  urls: Partial<Record<NavApp, string | null>>;
}): string {
  const lines: string[] = [
    `Balkania ${load.reference} - ${remaining.length} stop${remaining.length === 1 ? "" : "s"} left.`,
  ];

  const next = remaining[0];
  if (next) {
    lines.push(
      `Next: ${next.order.customer_name}, ${next.order.delivery_address}`,
    );
  }

  let truncated = false;
  for (const app of apps) {
    const url = urls[app];
    if (!url) continue;
    const target = NAV_TARGETS[app];
    const covered = stopsCovered(app, remaining.length);
    let scope: string;
    if (!target.multiStop) {
      scope = "next stop only";
    } else if (covered >= remaining.length) {
      scope = `all ${remaining.length}`;
    } else {
      scope = `stops 1-${covered} of ${remaining.length}`;
      truncated = true;
    }
    lines.push(`${target.label} (${scope}): ${url}`);
  }

  if (truncated) {
    const covered = stopsCovered("google", remaining.length);
    lines.push(
      `This link covers the first ${covered} of ${remaining.length} stops - Google Maps takes no more per link.`,
    );
  }

  return lines.join("\n");
}

export function driverPhone(driver: Driver | null): string | null {
  return driver?.phone ?? null;
}
