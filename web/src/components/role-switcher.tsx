"use client";

import { useState, useTransition } from "react";

import { Icon, cx } from "@/components/ui";
import { setDemoRole } from "@/lib/auth/actions";
import { ROLES, type Role } from "@/lib/auth/roles";

/**
 * Demo-only role switcher.
 *
 * A real user can never choose their own role — that is the point of having
 * one. Rendered only when `user.isDemo`, and `setDemoRole` refuses outright
 * once Supabase is configured, so this cannot become an escalation path if the
 * render condition is ever loosened by mistake. It writes the same cookie the
 * proxy and the page guards read, so switching exercises the real code path.
 */
export function RoleSwitcher({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Awaiting the action before closing avoids the earlier bug, where closing
  // the menu unmounted the submitting form and cancelled the switch.
  const choose = (next: Role) =>
    startTransition(async () => {
      await setDemoRole(next);
      setOpen(false);
    });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded-sm border border-dashed border-rail-line px-2 py-1.5 text-left transition-colors hover:bg-rail-hover"
      >
        <Icon name="switch_account" className="text-[16px] text-rail-ink/70" />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-label uppercase text-rail-ink/60">
            Viewing as
          </span>
          <span className="block truncate text-caption text-rail-ink-strong">
            {ROLES[role].label}
          </span>
        </span>
        <Icon
          name={open ? "expand_less" : "expand_more"}
          className="text-[16px] text-rail-ink/70"
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-md border border-hairline bg-surface shadow-pop"
        >
          {(Object.keys(ROLES) as Role[]).map((option) => (
            <button
              key={option}
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={() => choose(option)}
              className={cx(
                "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-muted disabled:opacity-60",
                option === role && "bg-brand-soft",
              )}
            >
              <Icon
                name={
                  option === role
                    ? "radio_button_checked"
                    : "radio_button_unchecked"
                }
                className={cx(
                  "mt-0.5 text-[16px]",
                  option === role ? "text-brand" : "text-ink-subtle",
                )}
              />
              <span className="min-w-0">
                <span className="block text-body-sm font-medium text-ink">
                  {ROLES[option].label}
                </span>
                <span className="block text-caption text-ink-subtle">
                  {ROLES[option].description}
                </span>
              </span>
            </button>
          ))}
          <p className="border-t border-hairline bg-surface-muted px-3 py-2 text-caption text-ink-subtle">
            Demo only. With Supabase Auth the role comes from{" "}
            <code className="font-mono">profiles</code> and cannot be chosen.
          </p>
        </div>
      ) : null}
    </div>
  );
}
