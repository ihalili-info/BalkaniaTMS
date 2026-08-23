"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { DEMO_ROLE_COOKIE, isRole } from "./roles";

/**
 * Demo-only: switch the acting role so both permission sets can be seen
 * without an auth backend.
 *
 * This disappears entirely when Supabase Auth lands — a real user cannot
 * choose their own role, which is the whole point. Until then it is a plain
 * cookie, and every guard reads the same cookie, so the demo exercises the
 * real code path rather than a bypass.
 */
export async function setDemoRole(next: string): Promise<void> {
  // Validate on the server: this is user input, even in a demo.
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
