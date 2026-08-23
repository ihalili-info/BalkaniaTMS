"use client";

import { useActionState } from "react";

import { Button, Field, Icon, controlClass } from "@/components/ui";
import { signIn, type SignInState } from "@/lib/auth/actions";

const INITIAL: SignInState = { error: null };

export function SignInForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(signIn, INITIAL);

  return (
    <form action={action} className="space-y-4">
      <Field label="Email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="dispatch@balkania.ie"
          className={controlClass}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={controlClass}
        />
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
        >
          <Icon name="error" className="mt-px text-[17px]" />
          {state.error}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        icon={pending ? "progress_activity" : "login"}
        disabled={pending || !configured}
        className="w-full justify-center"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
