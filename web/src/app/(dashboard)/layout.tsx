import { AppShell } from "@/components/app-shell";
import { ProfileWarning } from "@/components/profile-warning";
import { requireUser } from "@/lib/auth/session";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <AppShell user={user}>
      <ProfileWarning user={user} />
      {children}
    </AppShell>
  );
}
