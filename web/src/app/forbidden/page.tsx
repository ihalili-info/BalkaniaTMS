import type { Metadata } from "next";
import Link from "next/link";

import { Card, Icon } from "@/components/ui";
import { ProfileWarning } from "@/components/profile-warning";
import { requireUser } from "@/lib/auth/session";
import { ROLES, moduleForPath, modulesFor } from "@/lib/auth/roles";

export const metadata: Metadata = { title: "No access" };

export default async function ForbiddenPage({
  searchParams,
}: PageProps<"/forbidden">) {
  const { from } = await searchParams;
  const user = await requireUser();
  const blocked = typeof from === "string" ? moduleForPath(from) : undefined;
  const allowed = modulesFor(user.role);

  return (
    <div className="min-h-screen bg-canvas">
      <ProfileWarning user={user} />
      <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-lg">
        <div className="flex items-start gap-4 border-b border-hairline px-6 py-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-warn-soft text-warn">
            <Icon name="lock" className="text-[22px]" />
          </span>
          <div>
            <h1 className="text-title text-ink">
              {blocked ? `${blocked.label} is admin only` : "No access"}
            </h1>
            <p className="mt-1 text-body-sm text-ink-muted">
              You are signed in as{" "}
              <strong className="text-ink">{ROLES[user.role].label}</strong>.{" "}
              {ROLES[user.role].description}
            </p>
          </div>
        </div>

        <div className="px-6 py-5">
          <p className="mb-3 font-mono text-label uppercase text-ink-subtle">
            Available to you
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {allowed.map((module) => (
              <li key={module.id}>
                <Link
                  href={module.href}
                  className="flex items-center gap-2 rounded-sm border border-hairline px-3 py-2 text-body-sm text-ink-muted transition-colors hover:border-brand-border hover:bg-brand-soft hover:text-brand-ink"
                >
                  <Icon name={module.icon} className="text-[18px]" />
                  {module.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-caption text-ink-subtle">
            If you need this module, an admin can change your role. Roles live
            on the <code className="font-mono">profiles</code> table and are
            enforced by row-level security, not by this page.
          </p>
        </div>
      </Card>
      </div>
    </div>
  );
}
