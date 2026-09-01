import type { Metadata } from "next";

import { Card, CardHeader, Icon, Page, PageHeader } from "@/components/ui";
import { ROLES } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

import { NameForm, PasswordForm } from "./account-forms";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <Page>
      <PageHeader
        eyebrow="Your account"
        title="Account"
        description="Your name and password. Role, email and depot are set by an administrator."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Name" hint="How you appear across the app" />
          <NameForm initialName={user.fullName} />
        </Card>

        <Card>
          <CardHeader
            title="Password"
            hint="You'll be asked for your current password to confirm"
          />
          <PasswordForm />
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Managed by an administrator"
          hint="Contact an admin to change any of these"
        />
        <ul className="grid gap-px bg-hairline sm:grid-cols-3">
          {[
            { label: "Email", value: user.email ?? "—", icon: "mail" },
            {
              label: "Role",
              value: ROLES[user.role].label,
              icon: "badge",
            },
            { label: "Depot", value: user.depot, icon: "warehouse" },
          ].map((row) => (
            <li key={row.label} className="bg-surface px-5 py-4">
              <div className="mb-1 flex items-center gap-2">
                <Icon name={row.icon} className="text-[17px] text-ink-subtle" />
                <span className="font-mono text-label uppercase text-ink-subtle">
                  {row.label}
                </span>
              </div>
              <p className="text-body-sm font-medium text-ink">{row.value}</p>
            </li>
          ))}
        </ul>
        <p className="flex items-start gap-2 border-t border-hairline px-5 py-3 text-caption text-ink-muted">
          <Icon name="shield" className="mt-px text-[15px] text-ink-subtle" />
          Your role cannot be changed here even by you — the{" "}
          <code className="font-mono">profiles_update_self</code> policy in
          migration 0004 pins it, so no restriction can be lifted voluntarily.
        </p>
      </Card>
    </Page>
  );
}
