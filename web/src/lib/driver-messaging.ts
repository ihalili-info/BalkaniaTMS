/**
 * Composing the SMS a dispatcher sends a driver.
 *
 * Drivers only. Customers receive nothing from this path — their whole
 * messaging surface is the three automated types in `notifications`. See the
 * header comment on migration 0005.
 */

import { NAV_TARGETS, type NavApp } from "./navigation-links";
import type { Driver, LoadView, Stop } from "./types";

export type Channel = "sms" | "whatsapp";

export interface DriverMessage {
  id: string;
  load_id: string;
  driver_id: string | null;
  channel: Channel;
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
    // Plain hyphen, not an em dash: a single non-GSM-7 character flips the
    // whole message to UCS-2 and cuts the segment budget from 153 to 67.
    `Balkania ${load.reference} - ${remaining.length} stop${remaining.length === 1 ? "" : "s"} left.`,
  ];

  const next = remaining[0];
  if (next) {
    lines.push(
      `Next: ${next.order.customer_name}, ${next.order.delivery_address}`,
    );
  }

  for (const app of apps) {
    const url = urls[app];
    if (!url) continue;
    const target = NAV_TARGETS[app];
    const scope = target.multiStop
      ? `all ${remaining.length}`
      : "next stop only";
    lines.push(`${target.label} (${scope}): ${url}`);
  }

  return lines.join("\n");
}

/**
 * GSM-7 vs UCS-2 segment count.
 *
 * Worth showing: a single accented character — `Pádraig`, `Dún Laoghaire`,
 * `Düsseldorf` — switches the whole message to UCS-2 and cuts the per-segment
 * budget from 153 to 67, which can triple the cost of a route send.
 */
const GSM7 =
  /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

export function smsSegments(body: string): {
  characters: number;
  segments: number;
  unicode: boolean;
} {
  const unicode = !GSM7.test(body);
  const characters = [...body].length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return {
    characters,
    segments: characters === 0 ? 0 : characters <= single ? 1 : Math.ceil(characters / multi),
    unicode,
  };
}

/** Strips accents so a message fits GSM-7, when the dispatcher opts to. */
export function toGsm7(body: string): string {
  return body
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");
}

export function driverPhone(driver: Driver | null): string | null {
  return driver?.phone ?? null;
}
