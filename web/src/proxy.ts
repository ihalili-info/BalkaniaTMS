import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import {
  DEFAULT_ROLE,
  DEMO_ROLE_COOKIE,
  canAccessPath,
  isRole,
  moduleForPath,
} from "@/lib/auth/roles";

/**
 * Route guard and session refresh — the second of four layers.
 *
 *   1. the sidebar hides modules a role cannot open  (convenience only)
 *   2. this proxy redirects before the page renders
 *   3. the page itself re-checks server-side          (defence in depth)
 *   4. RLS policies in migration 0004                 (the real enforcement)
 *
 * This layer alone is not sufficient: the docs are explicit that a proxy may be
 * deployed to a CDN and must not rely on shared state, and a careless `matcher`
 * edit would silently disable it. Hence 3 and 4.
 *
 * Named `proxy`, not `middleware` — the `middleware` file convention is
 * deprecated in Next.js 16 and renamed to `proxy`.
 */

/** Routes reachable without a session. Gating these locks people out of the
 *  very pages that let them back in. */
const PUBLIC_PATHS = ["/sign-in", "/forbidden", "/api/webhooks"];

const isPublic = (pathname: string) =>
  PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const supabaseConfigured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ---- demo mode: no Supabase, so authorise from the demo cookie ----------
  if (!supabaseConfigured()) {
    if (!moduleForPath(pathname)) return NextResponse.next();
    const raw = request.cookies.get(DEMO_ROLE_COOKIE)?.value;
    const role = isRole(raw) ? raw : DEFAULT_ROLE;
    if (canAccessPath(role, pathname)) return NextResponse.next();
    return NextResponse.redirect(forbiddenUrl(request, pathname));
  }

  // ---- real mode: refresh the session on every request --------------------
  // Supabase access tokens are short-lived. Refreshing here is what keeps a
  // server component from seeing an expired session, and the refreshed cookies
  // have to be written onto the response that is actually returned.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // `getUser()` revalidates against the auth server; `getSession()` would just
  // echo the cookie back.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    if (isPublic(pathname)) return response;
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // Authenticated. Role-based authorisation for module routes happens in
  // `requireAccess()` on the page, which can read `profiles`; doing it here
  // would mean a database round-trip on every request the matcher touches.
  return response;
}

function forbiddenUrl(request: NextRequest, from: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/forbidden";
  url.search = `?from=${encodeURIComponent(from)}`;
  return url;
}

export const config = {
  // Without a matcher this runs on every request including static assets, and
  // a redirect would block CSS and images from loading.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
