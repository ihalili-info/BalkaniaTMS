import { Badge, Icon } from "@/components/ui";
import { getGpsFeedHealth } from "@/lib/data/gps-feed";
import { relativeTime } from "@/lib/format";

/**
 * Is the *push* feed live?
 *
 * This is a different question from "do the trucks have positions", and the
 * two are easy to confuse: a successful **Sync GPS** proves the pull API works
 * — token, App ID, Vehicle Numbers — and proves nothing at all about whether
 * Verizon is pushing. A fleet can sit here with fresh-looking coordinates that
 * are only ever as new as the last time somebody pressed a button.
 *
 * So this strip reports on `gps_webhook_deliveries` alone: has anything ever
 * called the endpoint, and when.
 */
export async function RealtimeStatus() {
  let health;
  try {
    health = await getGpsFeedHealth();
  } catch {
    // The log table is migration 0009. If it has not been applied, that is a
    // deployment step, not a fault worth breaking the map over.
    return null;
  }

  const stored = health.totals.stored ?? 0;
  const live = stored > 0;
  const now = new Date();

  return (
    <div className="mt-4 flex flex-wrap items-start gap-3 rounded-lg border border-hairline bg-surface px-4 py-3 shadow-card">
      <Icon
        name={live ? "wifi_tethering" : "wifi_tethering_off"}
        className={`mt-0.5 text-[20px] ${live ? "text-ok" : "text-warn"}`}
      />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-body-sm font-medium text-ink">
          Realtime push feed
          <Badge tone={live ? "ok" : "warn"} dot>
            {live ? "Live" : "Not delivering"}
          </Badge>
          {health.lastDelivery ? (
            <span className="font-mono text-label uppercase text-ink-subtle">
              last call {relativeTime(health.lastDelivery, now)}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-caption text-ink-muted">{health.diagnosis}</p>
        {!live ? (
          <p className="mt-1 text-caption text-ink-subtle">
            Positions on this map came from a manual <strong>Sync GPS</strong>,
            which polls Reveal on demand. That is the fallback path — it works,
            but nothing updates between presses. Full detail on Integrations →
            Verizon Connect Reveal.
          </p>
        ) : null}
      </div>
    </div>
  );
}
