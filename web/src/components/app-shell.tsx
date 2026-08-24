"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { signOut } from "@/lib/auth/actions";
import { Icon, cx } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import type { AppUser } from "@/lib/auth/session";
import { ROLES, groupsFor } from "@/lib/auth/roles";

/** Live figures for the rail, resolved server-side and passed down. */
export interface ShellStats {
  activeLoads: number;
  unassignedOrders: number;
  outOfService: number;
  trucksOnline: number;
  trucksTotal: number;
  /** ISO timestamp of the freshest GPS fix, or null when there are none. */
  newestFix: string | null;
}

function BrandMark() {
  return (
    // Plain <img>: the mark is a static SVG in /public, so next/image would
    // add a request round-trip and a layout wrapper for no benefit.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.svg"
      alt=""
      width={34}
      height={34}
      className="size-[34px] shrink-0"
    />
  );
}

function Sidebar({
  pathname,
  user,
  stats,
}: {
  pathname: string;
  user: AppUser;
  stats: ShellStats;
}) {
  const counts: Record<string, { value: number; tone?: "warn" } | undefined> = {
    "active-loads": { value: stats.activeLoads },
    "orders-queue": { value: stats.unassignedOrders },
    fleet: { value: stats.outOfService, tone: "warn" },
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-rail flex-col bg-rail">
      <div className="flex h-topbar items-center gap-2.5 border-b border-rail-line px-4">
        <BrandMark />
        <span className="flex min-w-0 flex-col leading-none">
          <span className="truncate text-heading tracking-tight text-rail-ink-strong">
            Balkania
          </span>
          <span className="mt-0.5 font-mono text-label uppercase text-accent-rail">
            TMS
          </span>
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {/* Only the modules this role may open. The proxy and the page guards
            enforce it; this keeps people from being shown locked doors. */}
        {groupsFor(user.role).map(({ group, modules }) => (
          <div key={group} className="mb-5 last:mb-0">
            <p className="px-2 pb-2 font-mono text-label uppercase text-rail-ink/60">
              {group}
            </p>
            <ul className="space-y-0.5">
              {modules.map((item) => {
                const active = pathname.startsWith(item.href);
                const count = counts[item.id];
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "group relative flex items-center gap-2.5 rounded-sm px-2 py-2 text-body-sm transition-colors",
                        active
                          ? "bg-rail-hover font-medium text-rail-ink-strong"
                          : "text-rail-ink hover:bg-rail-raised hover:text-rail-ink-strong",
                      )}
                    >
                      {active ? (
                        <span className="absolute inset-y-1.5 -left-3 w-0.5 rounded-r-full bg-accent-rail" />
                      ) : null}
                      <Icon
                        name={item.icon}
                        filled={active}
                        className={cx(
                          "text-[19px]",
                          active ? "text-accent-rail" : "text-rail-ink/70",
                        )}
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                      {count && count.value > 0 ? (
                        <span
                          className={cx(
                            "rounded-full px-1.5 py-px font-mono text-label tabular",
                            count.tone === "warn"
                              ? "bg-warn/20 text-warn"
                              : active
                                ? "bg-accent-rail text-rail"
                                : "bg-rail-hover text-rail-ink",
                          )}
                        >
                          {count.value}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-rail-line p-3">
        <div className="mb-3 rounded-md bg-rail-raised p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-label uppercase text-rail-ink/70">
              Fleet online
            </span>
            <span className="font-mono text-data-sm tabular text-rail-ink-strong">
              {stats.trucksOnline}/{stats.trucksTotal}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-rail">
            <div
              className="h-full rounded-full bg-ok"
              style={{
                width: `${stats.trucksTotal === 0 ? 0 : (stats.trucksOnline / stats.trucksTotal) * 100}%`,
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rail-hover text-caption font-medium text-rail-ink-strong">
            {user.fullName
              .split(" ")
              .map((part) => part[0])
              .slice(0, 2)
              .join("")}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body-sm font-medium text-rail-ink-strong">
              {user.fullName}
            </span>
            <span className="truncate text-caption text-rail-ink/70">
              {ROLES[user.role].label} · {user.email ?? user.depot}
            </span>
          </span>
          <form action={signOut} className="ml-auto">
            <button
              type="submit"
              title="Sign out"
              className="rounded-sm p-1.5 text-rail-ink transition-colors hover:bg-rail-hover hover:text-rail-ink-strong"
            >
              <Icon name="logout" className="text-[18px]" />
            </button>
          </form>
        </div>

      </div>
    </aside>
  );
}

function Topbar({ stats }: { stats: ShellStats }) {
  return (
    <header className="fixed inset-x-0 left-rail top-0 z-40 flex h-topbar items-center gap-4 border-b border-hairline bg-surface/85 px-6 backdrop-blur-md">
      <label className="flex h-9 w-full max-w-md items-center gap-2 rounded-sm border border-hairline bg-surface-muted px-3 focus-within:border-brand-border focus-within:bg-surface">
        <Icon name="search" className="text-[18px] text-ink-subtle" />
        <input
          type="search"
          placeholder="Search loads, plates, CRM orders or customers"
          className="w-full bg-transparent text-body-sm text-ink outline-none placeholder:text-ink-subtle"
        />
      </label>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden flex-col items-end border-r border-hairline pr-3 lg:flex">
          <span className="font-mono text-label uppercase text-ink-subtle">
            GPS sync
          </span>
          <span
            className="font-mono text-data-sm text-ok"
            title="Verizon Connect Reveal GPS webhook"
          >
            {stats.newestFix
              ? relativeTime(stats.newestFix, new Date())
              : "no fixes yet"}
          </span>
        </div>

        <button
          type="button"
          title="Alerts"
          className="relative rounded-sm p-2 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
        >
          <Icon name="notifications" className="text-[20px]" />
          <span className="absolute right-1.5 top-1.5 size-2 rounded-full border-2 border-surface bg-danger" />
        </button>
      </div>
    </header>
  );
}

export function AppShell({
  user,
  stats,
  children,
}: {
  user: AppUser;
  stats: ShellStats;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";

  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar pathname={pathname} user={user} stats={stats} />
      <Topbar stats={stats} />
      <main className="pl-rail pt-topbar">{children}</main>
    </div>
  );
}
