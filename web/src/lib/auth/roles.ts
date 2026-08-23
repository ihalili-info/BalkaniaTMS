/**
 * Roles and the module registry.
 *
 * One source of truth, read by four places: the sidebar (what to render), the
 * page itself (a server-side guard), the middleware (a redirect before the
 * page runs), and the RLS policies in migration 0004 (the actual enforcement).
 *
 * **Hiding a nav item is not access control.** A dispatcher who types
 * `/integration-settings` must be stopped by the guard and the proxy, and
 * a dispatcher who calls PostgREST directly must be stopped by RLS. The nav
 * filter exists so people are not shown doors they cannot open.
 *
 * No dependencies beyond types — `proxy.ts` runs on the edge runtime and
 * imports this file.
 */

/**
 * Cookie the demo role switcher writes. Declared here rather than beside the
 * session helpers because `proxy.ts` runs on the edge runtime and must not
 * pull in `next/headers` transitively.
 */
export const DEMO_ROLE_COOKIE = "balkania_demo_role";

export type Role = "admin" | "dispatcher";

export const ROLES: Record<Role, { label: string; description: string }> = {
  admin: {
    label: "Admin",
    description: "Every module, including Integrations and its credentials.",
  },
  dispatcher: {
    label: "Dispatcher",
    description: "Every module except Integrations.",
  },
};

/** New accounts default to the lower privilege — see the trigger in 0004. */
export const DEFAULT_ROLE: Role = "dispatcher";

export type ModuleGroup = "Dispatch" | "Insight" | "Configure";

export interface AppModule {
  id: string;
  href: string;
  label: string;
  icon: string;
  group: ModuleGroup;
  /** Roles permitted to open it. Order is irrelevant; membership is the rule. */
  roles: Role[];
}

const ALL: Role[] = ["admin", "dispatcher"];
const ADMIN_ONLY: Role[] = ["admin"];

export const MODULES: AppModule[] = [
  {
    id: "active-loads",
    href: "/active-loads",
    label: "Active Loads",
    icon: "local_shipping",
    group: "Dispatch",
    roles: ALL,
  },
  {
    id: "orders-queue",
    href: "/orders-queue",
    label: "Orders Queue",
    icon: "inbox",
    group: "Dispatch",
    roles: ALL,
  },
  {
    id: "live-fleet-map",
    href: "/live-fleet-map",
    label: "Live Fleet Map",
    icon: "map",
    group: "Dispatch",
    roles: ALL,
  },
  {
    id: "fleet",
    href: "/fleet",
    label: "Fleet",
    icon: "garage",
    group: "Dispatch",
    roles: ALL,
  },
  {
    id: "analytics",
    href: "/analytics",
    label: "Analytics",
    icon: "monitoring",
    group: "Insight",
    roles: ALL,
  },
  {
    // Holds connector configuration and the shape of the credential set.
    // Admin only — this is the restriction the whole role model exists for.
    id: "integration-settings",
    href: "/integration-settings",
    label: "Integrations",
    icon: "hub",
    group: "Configure",
    roles: ADMIN_ONLY,
  },
];

export const GROUP_ORDER: ModuleGroup[] = ["Dispatch", "Insight", "Configure"];

export function modulesFor(role: Role): AppModule[] {
  return MODULES.filter((m) => m.roles.includes(role));
}

/** Groups that still have at least one module for this role. */
export function groupsFor(role: Role): { group: ModuleGroup; modules: AppModule[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    modules: modulesFor(role).filter((m) => m.group === group),
  })).filter((g) => g.modules.length > 0);
}

export function moduleForPath(pathname: string): AppModule | undefined {
  // Longest match first, so `/fleet` never shadows a future `/fleet/reports`.
  return [...MODULES]
    .sort((a, b) => b.href.length - a.href.length)
    .find((m) => pathname === m.href || pathname.startsWith(`${m.href}/`));
}

/**
 * Whether `role` may open `pathname`.
 *
 * A path that matches no module is allowed — it is a non-module route such as
 * `/forbidden` or the root redirect, and gating those here would lock people
 * out of the very page that explains the lockout.
 */
export function canAccessPath(role: Role, pathname: string): boolean {
  const found = moduleForPath(pathname);
  return found ? found.roles.includes(role) : true;
}

export function isRole(value: unknown): value is Role {
  return value === "admin" || value === "dispatcher";
}
