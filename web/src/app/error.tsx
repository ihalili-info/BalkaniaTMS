"use client";

import { useEffect } from "react";

import { Button, Icon } from "@/components/ui";

/**
 * Catches anything that throws below the root layout — in practice, almost
 * always one of the `lib/data/*` reads inside `(dashboard)/layout.tsx` or a
 * page, since none of them retry a transient Supabase hiccup. Without this,
 * that throw reached the browser as a bare, unbranded crash screen with no
 * way back in short of typing the URL again.
 *
 * Lives at the app root, not inside `(dashboard)/`, on purpose: an error
 * boundary never catches a throw from its *own* segment's layout, only from
 * what's nested inside it. `(dashboard)/layout.tsx` does its own fetching
 * (for the nav rail's stats), so the boundary has to sit one level up, above
 * it, to catch that too.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm rounded-lg border border-hairline bg-surface p-6 text-center shadow-pop">
        <span className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-danger-soft text-danger">
          <Icon name="error" className="text-[22px]" />
        </span>
        <p className="text-heading text-ink">Something went wrong</p>
        <p className="mt-1 text-body-sm text-ink-muted">
          Usually a dropped connection to the database rather than anything
          wrong with your data. Try again — if it keeps happening, a full
          reload clears more state than this button does.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button icon="refresh" onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button variant="primary" icon="replay" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
