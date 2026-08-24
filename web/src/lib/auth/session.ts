import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { DEFAULT_ROLE, isRole, type Role } from "./roles";

/**
 * Who is using the app.
 *
 * Server-only by construction: importing `next/headers` from a client
 * component is a build error, so this module cannot reach the browser bundle.
 *
 * The role always comes from `profiles`, never from user metadata (which the
 * client can write) and never from a cookie. There is no demo path: an
 * unconfigured deployment fails to load rather than inventing a dispatcher.
 */
export interface AppUser {
  id: string;
  fullName: string;
  email: string | null;
  role: Role;
  depot: string;
  /**
   * Why the role is what it is.
   *
   * `missing` and `error` both fall back to `dispatcher`, which is the safe
   * behaviour — but silently. Without this flag "you are a dispatcher" and
   * "we could not read your profile" look identical from the UI, and the
   * second one is a broken deployment rather than a permission decision.
   */
  profileStatus: "ok" | "missing" | "error";
  profileError: string | null;
}

/** Whether a real Supabase project is wired up. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * The current user, or `null` when Supabase is configured and nobody is signed
 * in. Callers that require a user should use `requireUser()`.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  if (!isSupabaseConfigured()) {
    // Refuse rather than degrade. A silent fallback here is how a production
    // deployment ends up serving an app that authenticates nobody.
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  const supabase = await createClient();

  // `getUser()` revalidates against the auth server. Never trust
  // `getSession()` on the server — its contents come from the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("full_name, role, depot")
    .eq("id", user.id)
    .maybeSingle();

  // Fail closed, but never silently. A signed-in user with no profile row
  // usually means the backfill in migration 0004 did not run — the signup
  // trigger only fires on INSERT, so anyone created in the dashboard before
  // that migration has no row, and lands here looking like a dispatcher.
  let profileStatus: AppUser["profileStatus"] = "ok";
  if (error) {
    profileStatus = "error";
    console.error(
      `[auth] could not read profiles for ${user.email}: ${error.message}`,
    );
  } else if (!profile) {
    profileStatus = "missing";
    console.warn(
      `[auth] no profiles row for ${user.email} (${user.id}) — defaulting to ${DEFAULT_ROLE}. Run supabase/bootstrap_profiles.sql.`,
    );
  }

  const role: Role = isRole(profile?.role) ? profile.role : DEFAULT_ROLE;

  return {
    id: user.id,
    fullName: profile?.full_name ?? user.email ?? "Unknown user",
    email: user.email ?? null,
    role,
    depot: profile?.depot ?? "Balkania",
    profileStatus,
    profileError: error?.message ?? null,
  };
}

/**
 * The current user, redirecting to sign-in when there is none.
 *
 * Every page inside `(dashboard)` goes through this, so an unauthenticated
 * request never reaches a screen that would query real data.
 */
export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** Re-exported so server call sites need a single import. */
export { DEFAULT_ROLE };
