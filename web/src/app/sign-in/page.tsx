import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card, Icon } from "@/components/ui";
import { getCurrentUser, isSupabaseConfigured } from "@/lib/auth/session";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  const configured = isSupabaseConfigured();

  // Already signed in — or running on fixtures, where there is no sign-in to
  // do and bouncing someone to a dead form would be worse than letting them in.
  const user = await getCurrentUser();
  if (user) redirect("/active-loads");

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand text-ink-inverse">
            <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
              <path
                d="M4.5 19c0-6 7.5-4.5 7.5-7S19.5 11 19.5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="4.5" cy="19" r="2.4" fill="currentColor" />
              <circle cx="19.5" cy="5" r="2.4" fill="currentColor" />
            </svg>
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-heading tracking-tight text-ink">Balkania</span>
            <span className="mt-0.5 font-mono text-label uppercase text-brand">
              TMS
            </span>
          </span>
        </div>

        <Card>
          <div className="border-b border-hairline px-6 py-4">
            <h1 className="text-title text-ink">Sign in</h1>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Dispatcher access to loads, fleet and orders.
            </p>
          </div>
          <div className="px-6 py-5">
            {configured ? null : (
              <p className="mb-4 flex items-start gap-2 rounded-sm border border-warn-border bg-warn-soft px-3 py-2 text-caption text-ink-muted">
                <Icon name="info" className="mt-px text-[15px] text-warn" />
                No Supabase project is configured, so this form has nothing to
                authenticate against. The app is running on demo fixtures.
              </p>
            )}
            <SignInForm configured={configured} />
          </div>
        </Card>

        <p className="mt-4 text-center text-caption text-ink-subtle">
          Access is granted by an admin. Roles live on{" "}
          <code className="font-mono">profiles</code> and are enforced by
          row-level security.
        </p>
      </div>
    </div>
  );
}
