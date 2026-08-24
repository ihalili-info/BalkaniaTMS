import { AppShell, type ShellStats } from "@/components/app-shell";
import { ProfileWarning } from "@/components/profile-warning";
import { requireUser } from "@/lib/auth/session";
import { activeOf, getLoads, getOrders, getTrucks } from "@/lib/data/fleet";

/**
 * Every dashboard route depends on the signed-in user, so none of them can be
 * prerendered. Saying so explicitly matters: without it the build tries to
 * statically generate them and fails at `requireUser()`, which reads a session
 * that does not exist at build time.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  const [trucks, loads, orders] = await Promise.all([
    getTrucks(),
    getLoads(),
    getOrders(),
  ]);

  const assigned = new Set(loads.flatMap((l) => l.stops.map((s) => s.order_id)));
  const located = trucks.filter((t) => t.current_location !== null);

  const stats: ShellStats = {
    activeLoads: activeOf(loads).length,
    unassignedOrders: orders.filter((o) => !assigned.has(o.id)).length,
    outOfService: trucks.filter((t) => t.availability !== "available").length,
    trucksOnline: located.length,
    trucksTotal: trucks.length,
    // Derived, never asserted — a hardcoded "1 min ago" would keep saying that
    // with a dead feed.
    newestFix:
      located
        .map((t) => t.location_updated_at)
        .sort()
        .at(-1) ?? null,
  };

  return (
    <AppShell user={user} stats={stats}>
      <ProfileWarning user={user} />
      {children}
    </AppShell>
  );
}
