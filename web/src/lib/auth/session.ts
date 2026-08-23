import { cookies } from "next/headers";

import { DEFAULT_ROLE, DEMO_ROLE_COOKIE, isRole, type Role } from "./roles";

/**
 * Who is using the app.
 *
 * Server-only by construction: importing `next/headers` from a client
 * component is a build error, so this module cannot reach the browser bundle.
 *
 * There is no Supabase project yet, so the role comes from a cookie that the
 * demo role switcher sets. The shape and every call site are already what the
 * real implementation needs — see `getCurrentUser` for the swap.
 */
export interface AppUser {
  id: string;
  fullName: string;
  role: Role;
  depot: string;
  /** False once a real session backs this, so the UI can stop apologising. */
  isDemo: boolean;
}

const DEMO_PROFILE: Record<Role, { id: string; fullName: string }> = {
  admin: { id: "usr-admin", fullName: "Órla Fitzgerald" },
  dispatcher: { id: "usr-dispatcher", fullName: "Declan Murphy" },
};

/**
 * The current user, for server components and route handlers.
 *
 * To wire Supabase Auth, replace the body with:
 *
 * ```ts
 * const supabase = await createClient();               // lib/supabase/server
 * const { data: { user } } = await supabase.auth.getUser();
 * if (!user) redirect("/sign-in");
 * const { data: profile } = await supabase
 *   .from("profiles")
 *   .select("full_name, role, depot")
 *   .eq("id", user.id)
 *   .single();
 * ```
 *
 * Every caller and the whole permission model stay as they are. Note the role
 * must come from `profiles`, never from user metadata the client can write.
 */
export async function getCurrentUser(): Promise<AppUser> {
  const store = await cookies();
  // Fail closed: an absent or unrecognised value gets the *lower* privilege,
  // matching the `DEFAULT 'dispatcher'` on profiles.role. A fallback to admin
  // here would be a line that quietly survives into production.
  const raw = store.get(DEMO_ROLE_COOKIE)?.value;
  const role: Role = isRole(raw) ? raw : DEFAULT_ROLE;

  return {
    ...DEMO_PROFILE[role],
    role,
    depot: "Ballymount Terminal, Dublin",
    isDemo: true,
  };
}

/** Re-exported so server call sites need a single import. */
export { DEFAULT_ROLE, DEMO_ROLE_COOKIE };
