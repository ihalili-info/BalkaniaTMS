import "server-only";

import { headers } from "next/headers";

/**
 * Is this render a speculative prefetch rather than someone actually looking?
 *
 * Next's router prefetches a `<Link>` before it is clicked, which means the
 * page is rendered on the server with no viewer — and a dynamic route with no
 * `loading.tsx` boundary is rendered in full. That is fine for a page that only
 * reads the database, and expensive for one that calls a metered third party.
 *
 * Active Loads and the Live Fleet Map both ask HERE for a traffic-aware
 * driving time on every render. A prefetch has nobody to show it to, and by the
 * time the navigation actually happens the answer would be re-fetched anyway
 * (Next's client router treats dynamic segments as stale immediately), so
 * paying for it twice buys nothing.
 *
 * The nav rail now sets `prefetch={false}`, so in practice this should rarely
 * fire. It stays as the backstop: the header is the ground truth, and it keeps
 * a future `<Link>` added somewhere else from quietly reopening the tap.
 *
 * `next-router-prefetch` is Next's own marker; `purpose` / `x-purpose` /
 * `x-moz` are what browsers send for a speculative fetch of their own.
 */
export async function isPrefetchRequest(): Promise<boolean> {
  const h = await headers();

  if (h.get("next-router-prefetch") === "1") return true;

  for (const name of ["purpose", "x-purpose", "x-moz"]) {
    if (h.get(name)?.toLowerCase() === "prefetch") return true;
  }

  return false;
}
