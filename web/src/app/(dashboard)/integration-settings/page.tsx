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
} from "@/components/ui";
import { requireAccess } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { privacySettings } from "@/lib/integrations/policy";
import { deriveStatus, loadConnectorStates } from "@/lib/integrations/store";

import { ConnectorCard } from "./connector-card";

import { AlertRules } from "./alert-rules";

export const metadata: Metadata = { title: "Integration Settings" };

export default async function IntegrationSettingsPage() {
  // Admin only. The proxy redirects before this renders and RLS refuses the
  // data underneath; this is the layer that survives both being wrong.
  await requireAccess("/integration-settings");

  const states = await loadConnectorStates();
  const user = await getCurrentUser();
  const canEdit = user !== null;
  const ready = states.filter((s) => deriveStatus(s) === "connected").length;

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
              {ready} of {states.length} integrations configured
            </p>
            <p className="mt-0.5 text-body-sm text-ink-muted">
              Settings below are saved to{" "}
              <code className="font-mono">integration_settings</code>. Secrets
              stay in environment variables and are never written to the
              database.
            </p>
            <Progress
              value={ready}
              max={states.length}
              tone={ready === states.length ? "ok" : "warn"}
              className="mt-3 max-w-md"
            />
          </div>
          <Button variant="secondary" icon="menu_book">
            Setup guide
          </Button>
        </div>
      </Card>

      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {states.map((state) => (
          <ConnectorCard
            key={state.connector.id}
            state={state}
            status={deriveStatus(state)}
            canEdit={canEdit}
          />
        ))}
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
