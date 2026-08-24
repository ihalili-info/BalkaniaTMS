"use client";

import { useActionState } from "react";

import {
  Badge,
  Button,
  Card,
  Field,
  Icon,
  controlClass,
  cx,
  type Tone,
} from "@/components/ui";
import { saveConnectorConfig, type SaveState } from "@/lib/integrations/actions";
import type { ConnectorField } from "@/lib/integrations/catalogue";
import type { ConnectorState } from "@/lib/integrations/store";

const STATUS: Record<string, { tone: Tone; label: string }> = {
  connected: { tone: "ok", label: "Configured" },
  configured: { tone: "brand", label: "Env ready" },
  not_configured: { tone: "warn", label: "Needs keys" },
  not_built: { tone: "danger", label: "Not built" },
};

const INITIAL: SaveState = { ok: false, message: null };

function FieldControl({
  field,
  value,
}: {
  field: ConnectorField;
  value: string | number | boolean;
}) {
  const id = `f-${field.key}`;

  if (field.kind === "toggle") {
    return (
      <label className="flex items-start gap-2.5 rounded-sm border border-hairline px-3 py-2.5">
        <input
          id={id}
          name={field.key}
          type="checkbox"
          defaultChecked={Boolean(value)}
          className="mt-0.5 size-3.5 accent-brand"
        />
        <span className="min-w-0">
          <span className="block text-body-sm text-ink">{field.label}</span>
          {field.help ? (
            <span className="block text-caption text-ink-subtle">
              {field.help}
            </span>
          ) : null}
        </span>
      </label>
    );
  }

  return (
    <Field label={field.label} htmlFor={id} hint={field.help}>
      {field.kind === "select" ? (
        <select
          id={id}
          name={field.key}
          defaultValue={String(value)}
          className={controlClass}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="relative">
          <input
            id={id}
            name={field.key}
            type={field.kind === "number" ? "number" : "text"}
            min={field.min}
            max={field.max}
            defaultValue={String(value)}
            placeholder={field.placeholder}
            className={cx(controlClass, field.suffix && "pr-14")}
          />
          {field.suffix ? (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-caption text-ink-subtle">
              {field.suffix}
            </span>
          ) : null}
        </div>
      )}
    </Field>
  );
}

export function ConnectorCard({
  state,
  status,
  canEdit,
}: {
  state: ConnectorState;
  status: string;
  canEdit: boolean;
}) {
  const { connector, config, secretsSet } = state;
  const save = saveConnectorConfig.bind(null, connector.id);
  const [result, action, pending] = useActionState(save, INITIAL);
  const meta = STATUS[status] ?? STATUS.not_configured;

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 border-b border-hairline px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface-muted text-ink-muted">
          <Icon name={connector.icon} className="text-[19px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-heading text-ink">{connector.name}</h3>
            <Badge tone={meta.tone} dot>
              {meta.label}
            </Badge>
          </div>
          <p className="mt-1 text-body-sm text-ink-muted">{connector.purpose}</p>
        </div>
      </div>

      <form action={action} className="flex flex-1 flex-col gap-4 px-5 py-4">
        {connector.endpoint ? (
          <div>
            <p className="mb-1 font-mono text-label uppercase text-ink-subtle">
              Endpoint
            </p>
            <code className="block truncate rounded-sm border border-hairline bg-surface-muted px-2 py-1.5 font-mono text-data-sm text-ink-muted">
              {connector.endpoint}
            </code>
          </div>
        ) : null}

        {connector.fields.length > 0 ? (
          <div className="space-y-3">
            {connector.fields.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={config[field.key] ?? ""}
              />
            ))}
          </div>
        ) : null}

        {/* Secrets are shown as present or absent, never as values. */}
        <div>
          <p className="mb-1.5 font-mono text-label uppercase text-ink-subtle">
            Environment
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {connector.envVars.map((name) => {
              const isSecret = connector.secrets.includes(name);
              const set = secretsSet[name];
              return (
                <li
                  key={name}
                  title={
                    isSecret
                      ? "Secret — set in Vercel, never stored in the database"
                      : "Environment variable"
                  }
                  className={cx(
                    "inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 font-mono text-data-sm",
                    set
                      ? "border-ok-border bg-ok-soft text-ok"
                      : "border-hairline bg-surface-muted text-ink-subtle",
                  )}
                >
                  <Icon
                    name={isSecret ? (set ? "lock" : "lock_open") : set ? "check" : "remove"}
                    className="text-[12px]"
                  />
                  {name}
                </li>
              );
            })}
          </ul>
          {connector.secrets.length > 0 ? (
            <p className="mt-1.5 text-caption text-ink-subtle">
              Secrets are environment-only. Change them in Vercel and redeploy —
              they are deliberately not editable here.
            </p>
          ) : null}
        </div>

        {connector.note ? (
          <p className="text-caption text-ink-subtle">{connector.note}</p>
        ) : null}

        {result.message ? (
          <p
            role="status"
            className={cx(
              "flex items-start gap-1.5 rounded-sm border px-2.5 py-2 text-caption",
              result.ok
                ? "border-ok-border bg-ok-soft text-ok"
                : "border-danger-border bg-danger-soft text-danger",
            )}
          >
            <Icon
              name={result.ok ? "check_circle" : "error"}
              className="mt-px text-[14px]"
            />
            {result.message}
          </p>
        ) : null}

        {connector.fields.length > 0 ? (
          <div className="mt-auto flex items-center gap-2 border-t border-hairline pt-3">
            <span className="mr-auto text-caption text-ink-subtle">
              {state.updatedAt
                ? `Saved ${new Date(state.updatedAt).toLocaleDateString("en-GB")}`
                : "Never saved"}
            </span>
            <Button
              type="submit"
              variant="primary"
              icon={pending ? "progress_activity" : "save"}
              disabled={pending || !canEdit}
              title={canEdit ? undefined : "Connect Supabase to save settings"}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
