"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import { getCurrentUser } from "./session";

/**
 * Self-service account edits — the two things a user may change about their own
 * login without an admin.
 *
 * Everything else on `profiles` is admin-managed: `role` is pinned by the
 * `profiles_update_self` policy (migration 0004) so a restriction can never be
 * lifted voluntarily, and `depot` / `email` are set by whoever provisions the
 * account. These actions touch only `full_name` and the auth password.
 *
 * A server action is a public HTTP endpoint, so each one re-reads the session
 * rather than trusting the page that rendered it.
 */

export interface AccountActionState {
  status: "idle" | "ok" | "error";
  message: string | null;
}

export const IDLE: AccountActionState = { status: "idle", message: null };

const MAX_NAME = 120;
const MIN_PASSWORD = 8;

export async function updateProfileName(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "You are not signed in." };

  const fullName = String(formData.get("full_name") ?? "").trim();
  if (fullName === "") {
    return { status: "error", message: "Enter a name." };
  }
  if (fullName.length > MAX_NAME) {
    return { status: "error", message: `Keep it under ${MAX_NAME} characters.` };
  }
  if (fullName === user.fullName) {
    return { status: "idle", message: null };
  }

  const supabase = await createClient();

  // `profiles.full_name` is what the app reads everywhere (see
  // `lib/auth/session.ts`). RLS lets a user update their own row as long as
  // `role` is unchanged — which it is, since it is not in this patch.
  const { error } = await supabase
    .from("profiles")
    .update({ full_name: fullName })
    .eq("id", user.id);
  if (error) return { status: "error", message: error.message };

  // Keep the auth metadata copy in step, so a future re-provision or the
  // signup trigger reads the same name.
  await supabase.auth.updateUser({ data: { full_name: fullName } });

  // The name shows in the app-shell chip on every route.
  revalidatePath("/", "layout");
  return { status: "ok", message: "Name updated." };
}

export async function changePassword(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "You are not signed in." };
  if (!user.email) {
    return {
      status: "error",
      message:
        "This account has no email address, so the current password cannot be verified. Ask an admin to reset it.",
    };
  }

  const current = String(formData.get("current_password") ?? "");
  const next = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");

  if (!current || !next || !confirm) {
    return { status: "error", message: "Fill in all three fields." };
  }
  if (next.length < MIN_PASSWORD) {
    return {
      status: "error",
      message: `The new password must be at least ${MIN_PASSWORD} characters.`,
    };
  }
  if (next !== confirm) {
    return { status: "error", message: "The new password and confirmation do not match." };
  }
  if (next === current) {
    return { status: "error", message: "The new password must be different from the current one." };
  }

  const supabase = await createClient();

  // Supabase's `updateUser({ password })` does NOT re-check the current
  // password, so a stolen session could set a new one silently. Verify it
  // explicitly first. `signInWithPassword` for the same user just refreshes
  // the session cookies — no disruption.
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (verifyError) {
    return { status: "error", message: "Your current password is incorrect." };
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    // Supabase's messages here are already user-facing ("Password should be…").
    return { status: "error", message: error.message };
  }

  return { status: "ok", message: "Password changed." };
}
