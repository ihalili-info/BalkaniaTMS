"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { DEMO_ROLE_COOKIE, isRole } from "./roles";
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
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } else {
    // Demo mode: drop the acting role so sign-out visibly does something.
    const store = await cookies();
    store.delete(DEMO_ROLE_COOKIE);
  }
  revalidatePath("/", "layout");
  redirect("/sign-in");
}

/**
 * Demo-only: switch the acting role so both permission sets can be seen
 * without an auth backend.
 *
 * Refuses once Supabase is configured — a real user cannot choose their own
 * role, and leaving this reachable would be a privilege-escalation hole rather
 * than a convenience.
 */
export async function setDemoRole(next: string): Promise<void> {
  if (isSupabaseConfigured()) return;
  if (!isRole(next)) return;

  const store = await cookies();
  store.set(DEMO_ROLE_COOKIE, next, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  revalidatePath("/", "layout");
}
