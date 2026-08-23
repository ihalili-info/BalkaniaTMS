/**
 * Balkania TMS UI primitives.
 *
 * Every component here is a thin, unopinionated wrapper over the design tokens
 * in `globals.css`. Pages compose these instead of hand-rolling borders,
 * paddings and status colours, so a token change propagates everywhere.
 */

import type { ComponentProps, ReactNode } from "react";

import type { HoursLevel } from "@/lib/driver-hours";
import {
  CUSTOMS_REGIME,
  country,
  type CountryCode,
  type CustomsRegime,
} from "@/lib/regions";
import type {
  LoadStatus,
  NotificationType,
  OrderStatus,
  TruckDuty,
  TruckSignal,
} from "@/lib/types";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* --- icon ------------------------------------------------------------------ */

export function Icon({
  name,
  filled,
  className,
}: {
  name: string;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx("material-symbols-outlined", filled && "icon-filled", className)}
    >
      {name}
    </span>
  );
}

/* --- page scaffolding ------------------------------------------------------ */

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[1600px] px-6 py-6">{children}</div>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 font-mono text-label uppercase text-ink-subtle">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-display text-ink">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-body text-ink-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* --- card ------------------------------------------------------------------ */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx(
        "overflow-hidden rounded-lg border border-hairline bg-surface shadow-card",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="text-heading text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-caption text-ink-subtle">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("p-5", className)}>{children}</div>;
}

/* --- button ---------------------------------------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-ink-inverse border-brand hover:bg-brand-hover hover:border-brand-hover",
  secondary:
    "bg-surface text-ink border-hairline-strong hover:bg-surface-muted",
  ghost:
    "bg-transparent text-ink-muted border-transparent hover:bg-surface-muted hover:text-ink",
  danger:
    "bg-surface text-danger border-danger-border hover:bg-danger-soft",
};

export function Button({
  variant = "secondary",
  icon,
  className,
  children,
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; icon?: string }) {
  return (
    <button
      className={cx(
        "inline-flex h-9 items-center gap-1.5 rounded-sm border px-3 text-body-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} className="text-[18px]" /> : null}
      {children}
    </button>
  );
}

/* --- badge ------------------------------------------------------------------ */

export type Tone = "brand" | "ok" | "warn" | "danger" | "neutral";

const TONES: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand-ink border-brand-border",
  ok: "bg-ok-soft text-ok border-ok-border",
  warn: "bg-warn-soft text-warn border-warn-border",
  danger: "bg-danger-soft text-danger border-danger-border",
  neutral: "bg-surface-muted text-ink-muted border-hairline-strong",
};

const DOT_TONES: Record<Tone, string> = {
  brand: "bg-brand",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  neutral: "bg-ink-subtle",
};

export function Badge({
  tone = "neutral",
  dot,
  pulse,
  className,
  title,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  /** Native tooltip — used to carry the long form of a compliance label. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-label uppercase",
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          className={cx(
            "size-1.5 rounded-full",
            DOT_TONES[tone],
            pulse && "animate-pulse",
          )}
        />
      ) : null}
      {children}
    </span>
  );
}

/* --- domain status mapping --------------------------------------------------
   One place decides what each schema status looks like. */

const ORDER_STATUS: Record<OrderStatus, { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "Pending" },
  assigned: { tone: "warn", label: "Assigned" },
  en_route: { tone: "brand", label: "En route" },
  delivered: { tone: "ok", label: "Delivered" },
};

const LOAD_STATUS: Record<LoadStatus, { tone: Tone; label: string }> = {
  planned: { tone: "neutral", label: "Planned" },
  active: { tone: "brand", label: "Active" },
  completed: { tone: "ok", label: "Completed" },
};

export const NOTIFICATION_LABEL: Record<NotificationType, string> = {
  dispatch_confirmation: "Dispatch confirmation",
  proximity_alert: "Proximity alert",
  delivery_complete: "Delivery complete",
};

export const NOTIFICATION_ICON: Record<NotificationType, string> = {
  dispatch_confirmation: "outgoing_mail",
  proximity_alert: "my_location",
  delivery_complete: "task_alt",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { tone, label } = ORDER_STATUS[status];
  return (
    <Badge tone={tone} dot pulse={status === "en_route"}>
      {label}
    </Badge>
  );
}

export function LoadStatusBadge({ status }: { status: LoadStatus }) {
  const { tone, label } = LOAD_STATUS[status];
  return (
    <Badge tone={tone} dot pulse={status === "active"}>
      {label}
    </Badge>
  );
}

/* --- stat tile --------------------------------------------------------------- */

export function StatTile({
  label,
  value,
  unit,
  hint,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  icon: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-label uppercase text-ink-subtle">{label}</p>
        <span
          className={cx(
            "flex size-7 items-center justify-center rounded-sm border",
            TONES[tone],
          )}
        >
          <Icon name={icon} className="text-[16px]" />
        </span>
      </div>
      <p className="mt-3 text-metric tabular text-ink">
        {value}
        {unit ? (
          <span className="ml-1 text-body text-ink-subtle">{unit}</span>
        ) : null}
      </p>
      {hint ? <p className="mt-1 text-caption text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

/* --- progress ----------------------------------------------------------------- */

export function Progress({
  value,
  max,
  tone = "brand",
  className,
}: {
  value: number;
  max: number;
  tone?: Tone;
  className?: string;
}) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className={cx(
        "h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken",
        className,
      )}
    >
      <div
        className={cx("h-full rounded-full transition-all", DOT_TONES[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* --- table --------------------------------------------------------------------- */

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">{children}</table>
    </div>
  );
}

export function Th({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <th
      scope="col"
      className={cx(
        "border-b border-hairline bg-surface-muted px-4 py-2.5 text-left font-mono text-label uppercase text-ink-subtle",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  children,
  ...rest
}: ComponentProps<"td"> & { className?: string }) {
  return (
    <td
      className={cx("border-b border-hairline px-4 py-3 align-middle", className)}
      {...rest}
    >
      {children}
    </td>
  );
}

export function Tr({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <tr className={cx("transition-colors hover:bg-surface-muted/60", className)}>
      {children}
    </tr>
  );
}

/* --- empty state ----------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-full border border-hairline bg-surface-muted text-ink-subtle">
        <Icon name={icon} className="text-[22px]" />
      </span>
      <p className="text-heading text-ink">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-body-sm text-ink-muted">{description}</p>
      ) : null}
    </div>
  );
}

/* --- truck status ------------------------------------------------------------
   Duty and signal are separate badges on purpose — see the note on
   `TruckDuty` / `TruckSignal` in lib/types.ts. */

const DUTY: Record<TruckDuty, { tone: Tone; label: string }> = {
  on_load: { tone: "brand", label: "On load" },
  available: { tone: "ok", label: "Available" },
  unavailable: { tone: "warn", label: "Unavailable" },
  maintenance: { tone: "danger", label: "Maintenance" },
};

const SIGNAL: Record<TruckSignal, { tone: Tone; label: string; icon: string }> = {
  live: { tone: "ok", label: "Live", icon: "sensors" },
  stale: { tone: "warn", label: "Stale fix", icon: "sensors_off" },
  no_fix: { tone: "danger", label: "No fix", icon: "wifi_off" },
};

export function TruckDutyBadge({ duty }: { duty: TruckDuty }) {
  const { tone, label } = DUTY[duty];
  return (
    <Badge tone={tone} dot pulse={duty === "on_load"}>
      {label}
    </Badge>
  );
}

export function TruckSignalBadge({ signal }: { signal: TruckSignal }) {
  const { tone, label, icon } = SIGNAL[signal];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-label uppercase",
        TONES[tone],
      )}
    >
      <Icon name={icon} className="text-[13px]" />
      {label}
    </span>
  );
}

/** One equipment tag. Unknown tags still render, with a generic icon. */
export function FeatureChip({
  feature,
  onRemove,
}: {
  feature: { id: string; label: string; icon: string };
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-muted py-0.5 pl-2 pr-2 text-caption text-ink-muted">
      <Icon name={feature.icon} className="text-[14px] text-ink-subtle" />
      {feature.label}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${feature.label}`}
          className="-mr-1 rounded-full p-0.5 text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Icon name="close" className="text-[13px]" />
        </button>
      ) : null}
    </span>
  );
}

/* --- form controls -------------------------------------------------------- */

export const controlClass =
  "h-9 w-full rounded-sm border border-hairline bg-surface px-2.5 text-body-sm text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-brand";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block font-mono text-label uppercase text-ink-subtle"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-caption text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

/* --- regulatory badges --------------------------------------------------------
   Compliance state is never colour-alone: each of these carries a word. */

const HOURS_TONE: Record<HoursLevel, { tone: Tone; icon: string }> = {
  ok: { tone: "ok", icon: "schedule" },
  warning: { tone: "warn", icon: "hourglass_bottom" },
  break_due: { tone: "danger", icon: "free_breakfast" },
  limit_reached: { tone: "danger", icon: "block" },
};

/**
 * Driving time left before the binding Reg. 561/2006 limit bites, as a bar
 * plus the number. The bar is against the 4h30 continuous-driving ceiling,
 * because that is the constraint that bites first on a normal day.
 */
export function DriverHoursBar({
  secondsLeft,
  limitSeconds,
  level,
}: {
  secondsLeft: number;
  limitSeconds: number;
  level: HoursLevel;
}) {
  const pct = Math.max(0, Math.min(100, (secondsLeft / limitSeconds) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
      <div
        className={cx("h-full rounded-full transition-all", DOT_TONES[HOURS_TONE[level].tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function DriverHoursBadge({
  level,
  label,
}: {
  level: HoursLevel;
  label: string;
}) {
  const { tone, icon } = HOURS_TONE[level];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-label uppercase",
        TONES[tone],
      )}
    >
      <Icon name={icon} className="text-[13px]" />
      {label}
    </span>
  );
}

const REGIME_TONE: Record<CustomsRegime, Tone> = {
  domestic: "neutral",
  intra_eu: "brand",
  windsor_green: "ok",
  windsor_red: "danger",
  gb_import: "warn",
  third_country: "warn",
};

export function CustomsBadge({
  regime,
  full,
}: {
  regime: CustomsRegime;
  /** Long label; the short one is for table cells. */
  full?: boolean;
}) {
  const meta = CUSTOMS_REGIME[regime];
  if (regime === "domestic" && !full) return null;
  return (
    <Badge tone={REGIME_TONE[regime]} title={meta.detail}>
      <Icon name="public" className="text-[13px]" />
      {full ? meta.label : meta.short}
    </Badge>
  );
}

/** Country code as a labelled chip — never a bare flag, which reads ambiguously. */
export function CountryChip({ code }: { code: CountryCode }) {
  return (
    <span
      title={country(code).name}
      className="inline-flex items-center rounded-xs border border-hairline bg-surface-muted px-1.5 py-px font-mono text-label uppercase text-ink-muted"
    >
      {code}
    </span>
  );
}
