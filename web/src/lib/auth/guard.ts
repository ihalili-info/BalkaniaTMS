import { redirect } from "next/navigation";

import { canAccessPath, type Role } from "./roles";
import { requireUser } from "./session";

/**
 * Server-side guard for a module page — layer 3 of 4.
 *
 * `proxy.ts` already redirects, so reaching this usually means the proxy was
 * bypassed or its matcher was edited. That is exactly why it exists: a guard
 * that only ever runs when something else failed is doing its job.
 *
 * Call it at the top of any module page whose `roles` are narrower than all.
 */
export async function requireAccess(pathname: string): Promise<{ role: Role }> {
  const user = await requireUser();
  if (!canAccessPath(user.role, pathname)) {
    redirect(`/forbidden?from=${encodeURIComponent(pathname)}`);
  }
  return { role: user.role };
}
