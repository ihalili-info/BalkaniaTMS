import type { Metadata } from "next";

import {
  Badge,
  Button,
  Card,
  CardHeader,
  Icon,
  Page,
  PageHeader,
  Progress,
  type Tone,
} from "@/components/ui";
import { requireAccess } from "@/lib/auth/guard";
import {
  connectors,
  privacySettings,
  type ConnectorStatus,
} from "@/lib/demo/integrations";

import { AlertRules } from "./alert-rules";

export const metadata: Metadata = { title: "Integration Settings" };

const STATUS: Record<ConnectorStatus, { tone: Tone; label: string }> = {
  connected: { tone: "ok", label: "Connected" },
  configured: { tone: "brand", label: "Configured" },
  not_configured: { tone: "warn", label: "Needs keys" },
  not_built: { tone: "danger", label: "Not built" },
};

const ready = connectors.filter((c) => c.status === "connected").length;

export default async function IntegrationSettingsPage() {
  // Admin only. The proxy redirects before this renders and RLS refuses the
  // data underneath; this is the layer that survives both being wrong.
  await requireAccess("/integration-settings");

  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title="Integration Settings"
        description="Every external system Balkania TMS talks to, what it needs, and whether it is live — plus the regulatory positions that govern customer messaging."
        actions={
          <>
            <Button icon="description">Open .env.example</Button>
            <Button variant="primary" icon="bolt">
              Test connections
            </Button>
          </>
        }
      />

      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-warn-soft text-warn">
            <Icon name="rocket_launch" className="text-[20px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-heading text-ink">
              {ready} of {connectors.length} integrations live
            </p>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              The admin panel runs on demo fixtures until Supabase is provisioned
              and the webhook routes are implemented.
            </p>
            <Progress
              value={ready}
              max={connectors.length}
              tone={ready === connectors.length ? "ok" : "warn"}
              className="mt-3 max-w-md"
            />
          </div>
          <Button variant="secondary" icon="menu_book">
            Setup guide
          </Button>
        </div>
      </Card>

      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {connectors.map((connector) => {
          const status = STATUS[connector.status];
          return (
            <Card key={connector.id} className="flex flex-col">
              <div className="flex items-start gap-3 border-b border-hairline px-5 py-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface-muted text-ink-muted">
                  <Icon name={connector.icon} className="text-[19px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-heading text-ink">
                      {connector.name}
                    </h3>
                    <Badge tone={status.tone} dot>
                      {status.label}
                    </Badge>
                  </div>
                  <p className="mt-1 text-body-sm text-ink-muted">
                    {connector.purpose}
                  </p>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-3 px-5 py-4">
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

                <div>
                  <p className="mb-1.5 font-mono text-label uppercase text-ink-subtle">
                    Environment
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {connector.envVars.map((v) => (
                      <li
                        key={v}
                        className="rounded-xs border border-hairline bg-surface-muted px-1.5 py-0.5 font-mono text-data-sm text-ink-subtle"
                      >
                        {v}
                      </li>
                    ))}
                  </ul>
                </div>

                {connector.note ? (
                  <p className="text-caption text-ink-subtle">{connector.note}</p>
                ) : null}

                <Button className="mt-auto w-full justify-center" icon="settings">
                  Configure
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <AlertRules />

      {/* The alerts carry personal data, so the decisions GDPR requires the
          operator to have made belong on the same screen as the sender. */}
      <Card className="mt-4">
        <CardHeader
          title="Data protection"
          hint="GDPR and ePrivacy positions for customer messaging"
          actions={
            <Badge tone="brand">
              <Icon name="shield" className="text-[13px]" />
              EU / UK GDPR
            </Badge>
          }
        />
        <ul className="grid gap-px bg-hairline md:grid-cols-2 xl:grid-cols-3">
          {privacySettings.map((setting) => (
            <li key={setting.id} className="bg-surface px-5 py-4">
              <div className="mb-1 flex items-center gap-2">
                <Icon
                  name={setting.icon}
                  className="text-[17px] text-ink-subtle"
                />
                <span className="font-mono text-label uppercase text-ink-subtle">
                  {setting.label}
                </span>
              </div>
              <p className="text-body-sm font-medium text-ink">{setting.value}</p>
              <p className="mt-1 text-caption text-ink-subtle">{setting.basis}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-5 py-3">
          <Icon name="info" className="text-[17px] text-ink-subtle" />
          <p className="flex-1 text-caption text-ink-muted">
            An opted-out customer is excluded at the query, not filtered in the
            UI — see <code className="font-mono">idx_orders_alertable</code> in
            migration 0003.
          </p>
          <Button icon="policy">Retention policy</Button>
        </div>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title="Data ownership"
          hint="Where orders.status changes hands — keep this in step with the architecture doc"
        />
        <ul className="divide-y divide-hairline">
          {[
            {
              status: "assigned",
              when: "A dispatcher places the order on a load.",
              icon: "assignment_turned_in",
            },
            {
              status: "en_route",
              when: "The dispatch confirmation notification is sent.",
              icon: "outgoing_mail",
            },
            {
              status: "delivered",
              when: "The matching load_items.delivered_at is set.",
              icon: "task_alt",
            },
          ].map((row) => (
            <li key={row.status} className="flex items-center gap-3 px-5 py-3">
              <Icon name={row.icon} className="text-[18px] text-ink-subtle" />
              <code className="font-mono text-data-sm text-brand-ink">
                {row.status}
              </code>
              <span className="text-body-sm text-ink-muted">{row.when}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}
