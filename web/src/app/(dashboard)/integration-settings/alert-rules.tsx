"use client";

import { useState } from "react";

import { Badge, Card, CardBody, CardHeader, Icon, cx } from "@/components/ui";
import { messageTemplates } from "@/lib/integrations/policy";
import type { NotificationType } from "@/lib/types";

const TYPES = Object.keys(messageTemplates) as NotificationType[];

const TYPE_LABEL: Record<NotificationType, string> = {
  dispatch_confirmation: "Dispatch confirmation",
  proximity_alert: "Proximity alert",
  delivery_complete: "Delivery complete",
};

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-brand" : "bg-hairline-strong",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 size-4 rounded-full bg-surface shadow-card transition-all",
          checked ? "left-[1.125rem]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function AlertRules() {
  const [radiusKm, setRadiusKm] = useState(5);
  const [enabled, setEnabled] = useState<Record<NotificationType, boolean>>({
    dispatch_confirmation: true,
    proximity_alert: true,
    delivery_complete: true,
  });
  /**
   * "auto" omits `channel` on the Sent API, which is what enables its
   * cross-channel fallback — one message, one charge. Pinning a channel is
   * supported; picking several would broadcast, sending (and billing) the same
   * alert once per channel. That is not an option offered here on purpose.
   */
  const [channel, setChannel] = useState<"auto" | "sms" | "whatsapp" | "rcs">(
    "auto",
  );

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader
          title="Geofence trigger"
          hint="When a proximity alert fires"
        />
        <CardBody className="space-y-5">
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <label
                htmlFor="radius"
                className="font-mono text-label uppercase text-ink-subtle"
              >
                Alert radius
              </label>
              <span className="font-mono text-data tabular text-ink">
                {radiusKm} km
              </span>
            </div>
            <input
              id="radius"
              type="range"
              min={1}
              max={25}
              step={1}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="w-full accent-brand"
            />
            <p className="mt-2 text-caption text-ink-subtle">
              Straight-line PostGIS distance between{" "}
              <code className="font-mono text-data-sm">
                trucks.current_location
              </code>{" "}
              and the stop.
            </p>
          </div>

          <div className="rounded-md border border-warn-border bg-warn-soft px-3 py-2.5">
            <p className="text-body-sm font-medium text-ink">
              Distance is not drive time
            </p>
            <p className="mt-0.5 text-caption text-ink-muted">
              A 5 km straight line can be 8 minutes or 25 depending on terrain.
              ETA-based triggering needs a routing API and is still open — see
              the known gaps in the architecture doc.
            </p>
          </div>

          <div>
            <p className="mb-2 font-mono text-label uppercase text-ink-subtle">
              Delivery channel
            </p>
            <div className="flex gap-1 rounded-sm border border-hairline bg-surface-muted p-1">
              {(["auto", "sms", "whatsapp", "rcs"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChannel(c)}
                  aria-pressed={channel === c}
                  className={cx(
                    "flex-1 rounded-xs px-3 py-1.5 text-body-sm transition-colors",
                    channel === c
                      ? "bg-surface font-medium text-ink shadow-card"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  {c === "auto"
                    ? "Auto"
                    : c === "sms"
                      ? "SMS"
                      : c === "whatsapp"
                        ? "WhatsApp"
                        : "RCS"}
                </button>
              ))}
            </div>
            <p className="mt-2 text-caption text-ink-subtle">
              {channel === "auto"
                ? "Sent picks the channel and falls back if it fails — one message per alert."
                : `Pinned to ${channel.toUpperCase()}. No fallback: if it fails, the customer is not told.`}
            </p>
            <p className="mt-2 flex items-start gap-1.5 rounded-sm border border-hairline bg-surface-muted px-2.5 py-2 text-caption text-ink-muted">
              <Icon name="payments" className="mt-px text-[15px] text-ink-subtle" />
              <span>
                There is deliberately no &ldquo;all channels&rdquo; option.
                On Sent, naming several channels broadcasts rather than falls
                back — the customer gets the same alert once per channel, and
                each one is billed.
              </span>
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Message templates"
          hint="One row in notifications per type, per stop"
          actions={
            <Badge tone="neutral" title="Customers receive nothing else">
              Customer-facing
            </Badge>
          }
        />
        <ul className="divide-y divide-hairline">
          {TYPES.map((type) => (
            <li key={type} className="px-5 py-4">
              <div className="mb-2 flex items-center gap-3">
                <span className="flex-1 text-body-sm font-medium text-ink">
                  {TYPE_LABEL[type]}
                </span>
                <Badge tone={enabled[type] ? "ok" : "neutral"} dot>
                  {enabled[type] ? "On" : "Off"}
                </Badge>
                <Toggle
                  checked={enabled[type]}
                  onChange={(next) =>
                    setEnabled((prev) => ({ ...prev, [type]: next }))
                  }
                  label={`Enable ${TYPE_LABEL[type]}`}
                />
              </div>
              <p className="mb-2 text-caption text-ink-subtle">
                Trigger: {messageTemplates[type].trigger}
              </p>
              <p
                className={cx(
                  "rounded-sm border border-hairline bg-surface-muted px-3 py-2 font-mono text-data-sm",
                  enabled[type] ? "text-ink-muted" : "text-ink-subtle line-through",
                )}
              >
                {messageTemplates[type].body}
              </p>
            </li>
          ))}
        </ul>
        <p className="flex items-start gap-2 border-t border-hairline px-5 py-3 text-caption text-ink-subtle">
          <Icon name="lock" className="mt-px text-[15px]" />
          <span>
            These three are the <strong>only</strong> messages a customer ever
            receives. There is no dispatcher-initiated customer SMS. Navigation
            links sent from Active Loads go to the driver, are recorded in{" "}
            <code className="font-mono">driver_messages</code>, and never reach
            a customer.
          </span>
        </p>
      </Card>
    </div>
  );
}
