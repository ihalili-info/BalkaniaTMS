"use client";

import { useActionState } from "react";

import { Button, Field, Icon, controlClass, cx } from "@/components/ui";
import {
  IDLE,
  changePassword,
  updateProfileName,
  type AccountActionState,
} from "@/lib/auth/account-actions";

function Result({ state }: { state: AccountActionState }) {
  if (state.status === "idle" || !state.message) return null;
  const ok = state.status === "ok";
  return (
    <p
      role="alert"
      className={cx(
        "flex items-start gap-2 rounded-sm border px-3 py-2 text-body-sm",
        ok
          ? "border-ok-border bg-ok-soft text-ok"
          : "border-danger-border bg-danger-soft text-danger",
      )}
    >
      <Icon name={ok ? "check_circle" : "error"} className="mt-px text-[17px]" />
      {state.message}
    </p>
  );
}

export function NameForm({ initialName }: { initialName: string }) {
  const [state, action, pending] = useActionState(updateProfileName, IDLE);

  return (
    <form action={action} className="space-y-4 px-5 py-4">
      <Field label="Full name" htmlFor="full_name" hint="Shown on the navigation rail and against anything you send a driver.">
        <input
          id="full_name"
          name="full_name"
          type="text"
          autoComplete="name"
          required
          maxLength={120}
          defaultValue={initialName}
          className={controlClass}
        />
      </Field>

      <Result state={state} />

      <Button
        type="submit"
        variant="primary"
        icon={pending ? "progress_activity" : "save"}
        disabled={pending}
      >
        {pending ? "Saving…" : "Save name"}
      </Button>
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, IDLE);

  return (
    <form action={action} className="space-y-4 px-5 py-4">
      <Field label="Current password" htmlFor="current_password">
        <input
          id="current_password"
          name="current_password"
          type="password"
          autoComplete="current-password"
          required
          className={controlClass}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="New password" htmlFor="new_password" hint="At least 8 characters.">
          <input
            id="new_password"
            name="new_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className={controlClass}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm_password">
          <input
            id="confirm_password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            className={controlClass}
          />
        </Field>
      </div>

      <Result state={state} />

      <Button
        type="submit"
        variant="primary"
        icon={pending ? "progress_activity" : "lock_reset"}
        disabled={pending}
      >
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
