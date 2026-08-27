"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { Badge, Button, Icon, cx } from "@/components/ui";
import { sendDriverRouteMessage } from "@/lib/data/messaging";
import {
  routeMessage,
  smsSegments,
  toGsm7,
  type Channel,
} from "@/lib/driver-messaging";
import {
  NAV_TARGETS,
  navigationUrl,
  stopsCovered,
  truckRoutingWarning,
  type NavApp,
} from "@/lib/navigation-links";
import type { LoadView } from "@/lib/types";

const APPS: NavApp[] = ["google", "waze", "apple"];

export function SendRouteDialog({
  load,
  onSend,
  onClose,
}: {
  load: LoadView;
  onSend: (summary: { channel: Channel; to: string }) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<NavApp[]>(["google", "waze"]);
  const [channel, setChannel] = useState<Channel>("sms");
  const [forceGsm, setForceGsm] = useState(false);
  const [copied, setCopied] = useState<NavApp | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remaining = useMemo(
    () => load.stops.filter((s) => s.delivered_at === null),
    [load.stops],
  );

  const urls = useMemo(() => {
    const route = {
      origin: load.truck?.current_location ?? null,
      stops: remaining
        .map((s) => s.order.delivery_location)
        .filter((p): p is NonNullable<typeof p> => p !== null),
    };
    return Object.fromEntries(
      APPS.map((app) => [app, navigationUrl(app, route)]),
    ) as Record<NavApp, string | null>;
  }, [load.truck, remaining]);

  const geocodedCount = remaining.filter(
    (s) => s.order.delivery_location !== null,
  ).length;

  const rawBody = useMemo(
    () =>
      routeMessage({ load, remaining, apps: selected, urls }),
    [load, remaining, selected, urls],
  );
  const body = forceGsm ? toGsm7(rawBody) : rawBody;
  const meta = smsSegments(body);

  const phone = load.driver?.phone ?? null;
  const warning = truckRoutingWarning(load.truck, load.destination_countries);

  // Sent's driver-route template takes one link, not one per app — so of
  // whichever apps the dispatcher ticked, the first one's URL is what
  // actually goes out. The message preview below still shows all of them;
  // only this one reaches the driver's phone.
  const routeUrl = selected.map((app) => urls[app]).find((u) => u !== null) ?? null;

  const canSend =
    phone !== null && selected.length > 0 && geocodedCount > 0 && routeUrl !== null;

  const copy = async (app: NavApp) => {
    const url = urls[app];
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(app);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Send route for ${load.reference}`}
        className="fixed inset-x-4 top-[5vh] z-50 mx-auto flex max-h-[90vh] max-w-2xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div className="min-w-0">
            <p className="font-mono text-label uppercase text-ink-subtle">
              {load.reference}
            </p>
            <h2 className="text-title text-ink">Send route to driver</h2>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              {load.driver?.full_name ?? "No driver assigned"}
              {phone ? (
                <span className="ml-1 font-mono text-data-sm">{phone}</span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="close" className="text-[20px]" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {warning ? (
            <p className="flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5 text-body-sm text-ink-muted">
              <Icon name="warning" className="mt-0.5 text-[17px] text-warn" />
              <span>{warning}</span>
            </p>
          ) : null}

          <section>
            <h3 className="mb-1 text-heading text-ink">Navigation apps</h3>
            <p className="mb-3 text-caption text-ink-subtle">
              Only Google Maps takes a multi-stop route. Waze and Apple Maps
              accept one destination, so they get the <em>next</em> stop — not
              the last, which would skip everything between.
            </p>
            <ul className="space-y-2">
              {APPS.map((app) => {
                const target = NAV_TARGETS[app];
                const url = urls[app];
                const on = selected.includes(app);
                const covers = stopsCovered(app, geocodedCount);
                return (
                  <li
                    key={app}
                    className={cx(
                      "flex flex-wrap items-center gap-2 rounded-sm border px-3 py-2.5 transition-colors",
                      on ? "border-brand-border bg-brand-soft" : "border-hairline",
                    )}
                  >
                    <input
                      type="checkbox"
                      id={`app-${app}`}
                      checked={on}
                      disabled={url === null}
                      onChange={() =>
                        setSelected((prev) =>
                          prev.includes(app)
                            ? prev.filter((a) => a !== app)
                            : [...prev, app],
                        )
                      }
                      className="size-3.5 accent-brand"
                    />
                    <Icon
                      name={target.icon}
                      className={cx(
                        "text-[19px]",
                        on ? "text-brand" : "text-ink-subtle",
                      )}
                    />
                    <label
                      htmlFor={`app-${app}`}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block text-body-sm font-medium text-ink">
                        {target.label}
                      </span>
                      <span className="block text-caption text-ink-subtle">
                        {target.note}
                      </span>
                    </label>
                    <Badge tone={target.multiStop ? "ok" : "neutral"}>
                      {covers} of {geocodedCount} stops
                    </Badge>
                    <div className="flex gap-1">
                      <Button
                        icon={copied === app ? "check" : "content_copy"}
                        disabled={url === null}
                        onClick={() => void copy(app)}
                        title="Copy link"
                      >
                        {copied === app ? "Copied" : "Copy"}
                      </Button>
                      <a
                        href={url ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-disabled={url === null}
                        className={cx(
                          "inline-flex h-9 items-center gap-1.5 rounded-sm border border-hairline-strong bg-surface px-3 text-body-sm font-medium text-ink transition-colors hover:bg-surface-muted",
                          url === null && "pointer-events-none opacity-50",
                        )}
                      >
                        <Icon name="open_in_new" className="text-[17px]" />
                        Open
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>

            {geocodedCount < remaining.length ? (
              <p className="mt-2 flex items-start gap-1.5 text-caption text-warn">
                <Icon name="wrong_location" className="mt-px text-[14px]" />
                {remaining.length - geocodedCount} remaining stop
                {remaining.length - geocodedCount === 1 ? " has" : "s have"} no
                coordinates and cannot be routed to. Geocode them first.
              </p>
            ) : null}
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h3 className="text-heading text-ink">Message</h3>
              <div className="flex gap-1 rounded-sm border border-hairline bg-surface-muted p-0.5">
                {(["sms", "whatsapp", "rcs"] as Channel[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChannel(c)}
                    aria-pressed={channel === c}
                    className={cx(
                      "rounded-xs px-2.5 py-1 text-caption transition-colors",
                      channel === c
                        ? "bg-surface font-medium text-ink shadow-card"
                        : "text-ink-muted hover:text-ink",
                    )}
                  >
                    {c === "sms" ? "SMS" : c === "whatsapp" ? "WhatsApp" : "RCS"}
                  </button>
                ))}
              </div>
              <span className="ml-auto font-mono text-data-sm text-ink-subtle">
                {meta.characters} chars · {meta.segments} segment
                {meta.segments === 1 ? "" : "s"}
              </span>
            </div>

            <pre className="whitespace-pre-wrap break-words rounded-sm border border-hairline bg-surface-muted px-3 py-2.5 font-mono text-data-sm text-ink-muted">
              {body || "Select at least one navigation app."}
            </pre>
            <p className="mt-1.5 text-caption text-ink-subtle">
              A preview for your own reference — the send uses the registered
              Sent template, with{" "}
              <span className="font-mono text-data-sm">{routeUrl ?? "—"}</span>{" "}
              as its link. The template&rsquo;s own wording may not match this
              exactly.
            </p>

            {meta.unicode && channel === "sms" ? (
              <label className="mt-2 flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2 text-caption text-ink-muted">
                <input
                  type="checkbox"
                  checked={forceGsm}
                  onChange={(e) => setForceGsm(e.target.checked)}
                  className="mt-0.5 size-3.5 accent-brand"
                />
                <span>
                  An accented character forces UCS-2 encoding, cutting each
                  segment from 153 to 67 characters. Strip accents to send this
                  as {smsSegments(toGsm7(body)).segments} segment
                  {smsSegments(toGsm7(body)).segments === 1 ? "" : "s"} instead
                  of {meta.segments}.
                </span>
              </label>
            ) : null}
          </section>
        </div>

        {sendError ? (
          <p
            role="alert"
            className="mx-6 mb-3 flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
          >
            <Icon name="error" className="mt-px text-[17px]" />
            {sendError}
          </p>
        ) : null}

        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-6 py-3">
          <p className="mr-auto max-w-sm text-caption text-ink-subtle">
            Goes to the driver only. Customers receive nothing from here — just
            the three automated alerts.
          </p>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={pending ? "progress_activity" : "send"}
            disabled={!canSend || pending}
            onClick={() => {
              setSendError(null);
              startTransition(async () => {
                const result = await sendDriverRouteMessage({
                  loadId: load.id,
                  driverId: load.driver?.id ?? null,
                  toPhone: phone ?? "",
                  channel,
                  routeUrl: routeUrl ?? "",
                  previewBody: body,
                });
                if (result.ok) {
                  onSend({ channel: result.channel ?? channel, to: phone ?? "" });
                } else {
                  setSendError(result.message ?? "Could not send the route.");
                }
              });
            }}
          >
            {pending
              ? "Sending…"
              : phone
                ? `Send ${channel.toUpperCase()}`
                : "No driver number"}
          </Button>
        </footer>
      </div>
    </>
  );
}
