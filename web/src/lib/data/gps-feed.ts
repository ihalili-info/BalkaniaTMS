import { createClient } from "@/lib/supabase/server";
import { isConfirmableUrl } from "@/lib/telematics/subscription";

/** Diagnostic view of the Reveal GPS webhook. */

export interface GpsDelivery {
  id: string;
  received_at: string;
  vehicle_number: string | null;
  outcome:
    | "stored"
    | "skipped"
    | "rejected"
    | "unauthorized"
    | "bad_request"
    | "subscription_confirmed"
    | "subscription_pending";
  reason: string | null;
  subscribe_url: string | null;
}

export interface GpsFeedHealth {
  /** Null when the endpoint has never been called at all. */
  lastDelivery: string | null;
  totals: Record<string, number>;
  recent: GpsDelivery[];
  /** Vehicle Numbers Verizon sent that match no truck. */
  unmatchedNumbers: string[];
  trucksTotal: number;
  trucksWithFix: number;
  /**
   * A pending SubscribeURL that is safe to offer as a link.
   *
   * Only ever set when the host is a recognised Verizon or AWS one. Offering
   * an admin a one-click link to whatever URL happened to arrive in a request
   * body would turn this diagnostic panel into a phishing surface — the whole
   * point of the allow-list is that an unrecognised host is not trustworthy.
   */
  pendingSubscribeUrl: string | null;
  /** A confirmation arrived whose URL we will not link to. */
  untrustedSubscribeHost: string | null;
  /** Plain-English next step, derived from what the log actually shows. */
  diagnosis: string;
}

export async function getGpsFeedHealth(): Promise<GpsFeedHealth> {
  const supabase = await createClient();

  const [{ data: recent }, { data: trucks }] = await Promise.all([
    supabase
      .from("gps_webhook_deliveries")
      .select("id, received_at, vehicle_number, outcome, reason, subscribe_url")
      .order("received_at", { ascending: false })
      .limit(50),
    supabase.from("trucks_geo").select("id, lat"),
  ]);

  const rows = (recent ?? []) as GpsDelivery[];
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;

  const unmatchedNumbers = [
    ...new Set(
      rows
        .filter((r) => r.outcome === "skipped" && r.reason?.includes("no truck"))
        .map((r) => r.vehicle_number)
        .filter((n): n is string => n !== null),
    ),
  ];

  const trucksTotal = trucks?.length ?? 0;
  const trucksWithFix = (trucks ?? []).filter((t) => t.lat !== null).length;

  const confirmed = rows.some((r) => r.outcome === "subscription_confirmed");
  const pending = rows.find((r) => r.outcome === "subscription_pending");

  // Each cause needs a different fix, so name the one the evidence supports
  // rather than offering a checklist.
  let diagnosis: string;
  const pendingUrl = pending?.subscribe_url ?? null;
  const pendingTrusted = pendingUrl !== null && isConfirmableUrl(pendingUrl);
  let untrustedSubscribeHost: string | null = null;
  if (pendingUrl && !pendingTrusted) {
    try {
      untrustedSubscribeHost = new URL(pendingUrl).hostname;
    } catch {
      untrustedSubscribeHost = "unparseable URL";
    }
  }

  if (pending && !confirmed && pendingTrusted) {
    diagnosis =
      "Verizon sent the subscription confirmation but it could not be completed automatically. Open the SubscribeURL below to activate the feed — the submission expires three days after it was made.";
  } else if (pending && !confirmed) {
    diagnosis = `A subscription confirmation arrived pointing at ${untrustedSubscribeHost}, which is not a Verizon or AWS host. It was not fetched and is not linked here. If you did not expect this, ignore it — a genuine confirmation comes from Verizon's own domain.`;
  } else if (rows.length === 0) {
    diagnosis =
      trucksTotal === 0
        ? "Nothing has ever called this endpoint, and there are no trucks yet. Sync the fleet from Reveal, then have the endpoint registered."
        : "Nothing has ever called this endpoint. Verizon does not push until the URL and Basic-auth credentials are registered in Reveal (Admin → Integrations) — that request goes through your Reveal account manager.";
  } else if ((totals.unauthorized ?? 0) > 0) {
    diagnosis =
      "Verizon is calling but the credentials are being rejected. The username and password registered with them do not match GPS_WEBHOOK_USER / GPS_WEBHOOK_SECRET in Vercel.";
  } else if (unmatchedNumbers.length > 0) {
    diagnosis = `Positions are arriving for Vehicle Numbers with no truck: ${unmatchedNumbers.join(", ")}. Sync the fleet from Reveal, or correct the GPS device field on those trucks.`;
  } else if ((totals.rejected ?? 0) > 0 && (totals.stored ?? 0) === 0) {
    diagnosis =
      "Positions are arriving but failing validation — see the reasons below. A device with no fix reports 0,0 and is refused rather than plotted in the Atlantic.";
  } else if ((totals.stored ?? 0) > 0) {
    diagnosis = "The feed is working. Positions are being stored.";
  } else if (confirmed) {
    diagnosis =
      "Subscription confirmed. Verizon should begin pushing positions shortly — nothing further to do.";
  } else {
    diagnosis = "Deliveries are arriving but none have been stored yet.";
  }

  return {
    lastDelivery: rows[0]?.received_at ?? null,
    totals,
    recent: rows.slice(0, 12),
    unmatchedNumbers,
    trucksTotal,
    trucksWithFix,
    pendingSubscribeUrl: confirmed || !pendingTrusted ? null : pendingUrl,
    untrustedSubscribeHost: confirmed ? null : untrustedSubscribeHost,
    diagnosis,
  };
}
