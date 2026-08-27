"use client";

import { useState, useTransition } from "react";

import { Button, Icon, cx } from "@/components/ui";
import {
  testConnections,
  type ConnectionTestResult,
} from "@/lib/integrations/actions";

/**
 * Was a plain, unwired `<Button>` — looked like a test, did nothing. Now it
 * actually calls `testConnections()`, which only checks providers with a free
 * connection test (today, just Sent's `GET /v3/me`).
 */
export function TestConnectionsButton() {
  const [results, setResults] = useState<ConnectionTestResult[] | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="relative">
      <Button
        variant="primary"
        icon={pending ? "progress_activity" : "bolt"}
        disabled={pending}
        onClick={() =>
          startTransition(async () => setResults(await testConnections()))
        }
      >
        {pending ? "Testing…" : "Test connections"}
      </Button>

      {results ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setResults(null)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-md border border-hairline bg-surface p-3 shadow-pop">
            <ul className="space-y-2">
              {results.map((r) => (
                <li key={r.id} className="flex items-start gap-2 text-body-sm">
                  <Icon
                    name={r.ok ? "check_circle" : "error"}
                    className={cx(
                      "mt-0.5 text-[16px]",
                      r.ok ? "text-ok" : "text-danger",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{r.name}</span>
                    <span className="block text-caption text-ink-subtle">
                      {r.message}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 border-t border-hairline pt-2 text-caption text-ink-subtle">
              Only providers with a free connection check are tested — sending
              a real message would not be a test.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
