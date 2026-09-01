"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { isSupabaseConfigured } from "./session";

export interface SignInState {
  error: string | null;
}

/**
 * Email + password sign-in.
 *
 * Returns the error rather than throwing so the form can render it. Supabase's
 * own message is deliberately not passed through verbatim for a failed
 * credential check — "Invalid login credentials" is the right thing to show,
 * and anything more specific tells an attacker which half was wrong.
 */
export async function signIn(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email address and password." };
  }
  if (!isSupabaseConfigured()) {
    return {
      error:
        "No Supabase project is configured, so there is nothing to sign in to.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "Those credentials were not accepted." };
  }

  revalidatePath("/", "layout");
  redirect("/active-loads");
}

export async function signOut(): Promise<void> {
  try {
    const supabase = await createClient();
    // `scope: "local"` drops this device's session without the network round
    // trip a global sign-out makes to revoke every session — that call throws
    // `AuthRetryableFetchError` on a blip, which would turn "log out" into the
    // root error screen. The local session (the cookies) is cleared either way.
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The cookies are already being cleared by the client's setAll; even if
    // the GoTrue call failed, land the user on sign-in rather than an error.
  }
  revalidatePath("/", "layout");
  redirect("/sign-in");
}
