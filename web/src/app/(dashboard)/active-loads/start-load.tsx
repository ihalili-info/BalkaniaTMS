"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Icon } from "@/components/ui";
import { startLoad } from "@/lib/data/mutations";

/** Moves a planned load onto the board as active. */
export function StartLoadButton({ loadId }: { loadId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span className="flex items-center gap-1 text-caption text-danger">
          <Icon name="error" className="text-[14px]" />
          {error}
        </span>
      ) : null}
      <Button
        variant="primary"
        icon={pending ? "progress_activity" : "play_arrow"}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await startLoad(loadId);
            if (result.ok) router.refresh();
            else setError(result.message ?? "Could not start.");
          })
        }
      >
        {pending ? "Starting…" : "Start"}
      </Button>
    </span>
  );
}
