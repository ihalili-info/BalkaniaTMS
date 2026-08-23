import { NextResponse, type NextRequest } from "next/server";

import {
  DEFAULT_ROLE,
  DEMO_ROLE_COOKIE,
  canAccessPath,
  isRole,
  moduleForPath,
} from "@/lib/auth/roles";

/**
 * Route guard — the second of four layers.
 *
 *   1. the sidebar hides modules a role cannot open  (convenience only)
 *   2. this proxy redirects before the page renders
 *   3. the page itself re-checks server-side          (defence in depth)
 *   4. RLS policies in migration 0004                 (the real enforcement)
 *
 * This layer alone is not sufficient: the docs are explicit that a proxy may
 * be deployed to a CDN and must not rely on shared state, and a careless
 * `matcher` edit would silently disable it. Hence 3 and 4.
 *
 * Named `proxy`, not `middleware` — the `middleware` file convention is
 * deprecated in Next.js 16 and renamed to `proxy`.
 *
 * When Supabase Auth lands, the role comes from the verified session rather
 * than this cookie; the rest of the function is unchanged.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Non-module routes (/forbidden, the root redirect) are deliberately open —
  // gating them would lock people out of the page explaining the lockout.
  if (!moduleForPath(pathname)) return NextResponse.next();

  // Fail closed — same rule as `getCurrentUser`, and for the same reason.
  const raw = request.cookies.get(DEMO_ROLE_COOKIE)?.value;
  const role = isRole(raw) ? raw : DEFAULT_ROLE;

  if (canAccessPath(role, pathname)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/forbidden";
  url.search = `?from=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Without a matcher this runs on every request including static assets, and
  // a redirect would block CSS and images from loading.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
