"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Icon } from "@/components/ui";
import { markStopDelivered, undeliverStop } from "@/lib/data/mutations";

/**
 * Records the drop for one stop — the manual stand-in for the geofence engine,
 * shown on the next undelivered stop of a load that is on the road.
 */
export function MarkDeliveredButton({ loadItemId }: { loadItemId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        variant="primary"
        icon={pending ? "progress_activity" : "check"}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await markStopDelivered(loadItemId);
            if (result.ok) router.refresh();
            else setError(result.message ?? "Could not mark delivered.");
          })
        }
      >
        {pending ? "Saving…" : "Mark delivered"}
      </Button>
      {error ? (
        <span className="flex items-center gap-1 text-caption text-danger">
          <Icon name="error" className="text-[14px]" />
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Undo for a stop marked delivered by mistake. The caller hides it once a
 * delivery-complete alert exists for the stop; the server refuses it then too.
 */
export function UndeliverButton({ loadItemId }: { loadItemId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await undeliverStop(loadItemId);
            if (result.ok) router.refresh();
            else setError(result.message ?? "Could not undo.");
          })
        }
        className="text-caption text-ink-subtle underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink disabled:opacity-50"
      >
        {pending ? "Undoing…" : "Undo delivery"}
      </button>
      {error ? (
        <span className="mt-1 flex items-center gap-1 text-right text-caption text-danger">
          <Icon name="error" className="text-[14px]" />
          {error}
        </span>
      ) : null}
    </span>
  );
}
