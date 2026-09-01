"use server";

import { revalidatePath } from "next/cache";
import { createClient as createPlainClient } from "@supabase/supabase-js";

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
 * rather than trusting the page that rendered it. And every path returns an
 * `AccountActionState` — a thrown error from an auth call (Supabase's write
 * methods throw `AuthRetryableFetchError` on a network blip) would otherwise
 * hit the root error boundary and drop the whole screen.
 */

export interface AccountActionState {
  status: "idle" | "ok" | "error";
  message: string | null;
}

export const IDLE: AccountActionState = { status: "idle", message: null };

const MAX_NAME = 120;
const MIN_PASSWORD = 8;

const fail = (message: string): AccountActionState => ({
  status: "error",
  message,
});

export async function updateProfileName(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const user = await getCurrentUser();
    if (!user) return fail("You are not signed in.");

    const fullName = String(formData.get("full_name") ?? "").trim();
    if (fullName === "") return fail("Enter a name.");
    if (fullName.length > MAX_NAME) {
      return fail(`Keep it under ${MAX_NAME} characters.`);
    }
    if (fullName === user.fullName) return { status: "idle", message: null };

    const supabase = await createClient();

    // `profiles.full_name` is what the app reads everywhere (see
    // `lib/auth/session.ts`). RLS lets a user update their own row as long as
    // `role` is unchanged — which it is, since it is not in this patch.
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName })
      .eq("id", user.id);
    if (error) return fail(error.message);

    // Best-effort: keep the auth-metadata copy of the name in step so a future
    // re-provision reads the same value. A failure here must not fail the
    // action — the row above is the one that matters.
    try {
      await supabase.auth.updateUser({ data: { full_name: fullName } });
    } catch {
      // ignored on purpose
    }

    // The name shows in the app-shell chip on every route.
    revalidatePath("/", "layout");
    return { status: "ok", message: "Name updated." };
  } catch (e) {
    return fail(
      e instanceof Error && e.message
        ? `Could not update your name: ${e.message}`
        : "Could not update your name — try again.",
    );
  }
}

export async function changePassword(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const user = await getCurrentUser();
    if (!user) return fail("You are not signed in.");
    if (!user.email) {
      return fail(
        "This account has no email address, so the current password cannot be verified. Ask an admin to reset it.",
      );
    }

    const current = String(formData.get("current_password") ?? "");
    const next = String(formData.get("new_password") ?? "");
    const confirm = String(formData.get("confirm_password") ?? "");

    if (!current || !next || !confirm) return fail("Fill in all three fields.");
    if (next.length < MIN_PASSWORD) {
      return fail(`The new password must be at least ${MIN_PASSWORD} characters.`);
    }
    if (next !== confirm) {
      return fail("The new password and confirmation do not match.");
    }
    if (next === current) {
      return fail("The new password must be different from the current one.");
    }

    // Verify the current password on a throwaway client that does NOT touch
    // the cookie jar — `signInWithPassword` on the real session client would
    // rotate the user's tokens mid-request as a side effect of a check.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return fail("Auth is not configured on this deployment.");

    const verifier = createPlainClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: verifyError } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: current,
    });
    if (verifyError) return fail("Your current password is incorrect.");

    const supabase = await createClient();
    const { error } = await supabase.auth.updateUser({ password: next });
    if (error) {
      // Supabase's messages here are already user-facing ("Password should be…").
      return fail(error.message);
    }

    return { status: "ok", message: "Password changed." };
  } catch (e) {
    return fail(
      e instanceof Error && e.message
        ? `Could not change your password: ${e.message}`
        : "Could not change your password — try again.",
    );
  }
}
