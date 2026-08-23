import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/auth/session";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  return <AppShell user={user}>{children}</AppShell>;
}
