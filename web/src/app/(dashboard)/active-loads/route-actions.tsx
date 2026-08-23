"use client";

import { useState } from "react";

import { Badge, Button, Icon } from "@/components/ui";
import type { Channel } from "@/lib/driver-messaging";
import type { LoadView } from "@/lib/types";

import { SendRouteDialog } from "./send-route-dialog";

/**
 * "Send route" for one load. Small on purpose — it keeps the load card itself
 * a server component, and only this button and its dialog ship to the browser.
 */
export function RouteActions({ load }: { load: LoadView }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<{ channel: Channel; to: string } | null>(
    null,
  );

  const hasDriver = load.driver?.phone != null;

  return (
    <>
      {sent ? (
        <Badge tone="ok" dot title={`Sent to ${sent.to}`}>
          Route sent
        </Badge>
      ) : null}

      <Button
        icon="near_me"
        onClick={() => setOpen(true)}
        disabled={!hasDriver}
        title={
          hasDriver
            ? "Send navigation links to the driver"
            : "No driver phone number on this load"
        }
      >
        Send route
      </Button>

      {open ? (
        <SendRouteDialog
          load={load}
          onClose={() => setOpen(false)}
          onSend={({ channel, to }) => {
            // The single seam for Sent. Today it records locally; wiring it
            // up means POSTing to a route handler that sends via Sent and
            // inserts a `driver_messages` row (migration 0005).
            setSent({ channel, to });
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Per-stop navigation for the dispatcher — checking a drop on a map without
 * having to message the driver about it.
 */
export function StopNavMenu({
  links,
  label,
}: {
  links: { id: string; label: string; icon: string; url: string | null }[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const usable = links.filter((l) => l.url !== null);

  if (usable.length === 0) {
    return (
      <span
        title="No coordinates for this stop"
        className="flex size-7 items-center justify-center text-ink-subtle/50"
      >
        <Icon name="wrong_location" className="text-[16px]" />
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Navigate to ${label}`}
        className="flex size-7 items-center justify-center rounded-sm text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
      >
        <Icon name="near_me" className="text-[16px]" />
      </button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-md border border-hairline bg-surface shadow-pop"
          >
            {usable.map((link) => (
              <a
                key={link.id}
                role="menuitem"
                href={link.url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-body-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
              >
                <Icon name={link.icon} className="text-[17px]" />
                {link.label}
                <Icon
                  name="open_in_new"
                  className="ml-auto text-[14px] text-ink-subtle"
                />
              </a>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
