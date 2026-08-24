import { Icon } from "@/components/ui";
import type { AppUser } from "@/lib/auth/session";

/**
 * Shown when the role was defaulted because the profile could not be read.
 *
 * Without this, "signed in as a dispatcher" and "your profile row is missing"
 * are indistinguishable — the nav simply has fewer items and nobody can tell
 * whether that is a permission decision or a broken deployment.
 */
export function ProfileWarning({ user }: { user: AppUser }) {
  if (user.profileStatus === "ok" || user.profileStatus === "demo") return null;

  const missing = user.profileStatus === "missing";

  return (
    <div className="border-b border-warn-border bg-warn-soft px-6 py-2.5">
      <div className="mx-auto flex max-w-[1600px] items-start gap-2.5">
        <Icon name="warning" className="mt-px text-[18px] text-warn" />
        <div className="min-w-0 flex-1 text-caption text-ink-muted">
          <p className="text-body-sm font-medium text-ink">
            {missing
              ? "No profile row for this account — role defaulted to dispatcher"
              : "Could not read your profile — role defaulted to dispatcher"}
          </p>
          <p className="mt-0.5">
            {missing ? (
              <>
                The signup trigger only fires on INSERT, so an account created
                in the Supabase dashboard before migration 0004 ran has no{" "}
                <code className="font-mono">profiles</code> row. Run{" "}
                <code className="font-mono">
                  supabase/bootstrap_profiles.sql
                </code>{" "}
                in the SQL editor, then sign out and back in.
              </>
            ) : (
              <>
                {user.profileError ?? "Unknown error"}. Check that migration
                0004 has been applied and that RLS allows a user to read their
                own row.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
