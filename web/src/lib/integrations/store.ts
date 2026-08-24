import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/auth/session";

import { CONNECTORS, DEFAULT_CONFIG, type Connector } from "./catalogue";

export type ConfigValue = string | number | boolean;
export type ConnectorConfig = Record<string, ConfigValue>;

export interface ConnectorState {
  connector: Connector;
  config: ConnectorConfig;
  /** Which of this connector's secrets are present in the environment. */
  secretsSet: Record<string, boolean>;
  /** True when every declared env var has a value. */
  envComplete: boolean;
  updatedAt: string | null;
}

/**
 * Whether each secret is set — by presence only.
 *
 * Deliberately returns booleans, never values. A secret that reaches a React
 * prop is a secret in the HTML payload, and there is no way to walk that back.
 */
function secretPresence(connector: Connector): Record<string, boolean> {
  return Object.fromEntries(
    connector.envVars.map((name) => [name, Boolean(process.env[name])]),
  );
}

export async function loadConnectorStates(): Promise<ConnectorState[]> {
  const stored = new Map<
    string,
    { config: ConnectorConfig; updated_at: string | null }
  >();

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    // RLS restricts this to admins; a dispatcher gets zero rows rather than an
    // error, which is the intended behaviour.
    const { data } = await supabase
      .from("integration_settings")
      .select("connector_id, config, updated_at");

    for (const row of data ?? []) {
      stored.set(row.connector_id, {
        config: (row.config ?? {}) as ConnectorConfig,
        updated_at: row.updated_at,
      });
    }
  }

  return CONNECTORS.map((connector) => {
    const saved = stored.get(connector.id);
    const secretsSet = secretPresence(connector);
    return {
      connector,
      config: {
        ...(DEFAULT_CONFIG[connector.id] ?? {}),
        ...(saved?.config ?? {}),
      },
      secretsSet,
      envComplete: connector.envVars.every((name) => secretsSet[name]),
      updatedAt: saved?.updated_at ?? null,
    };
  });
}

/**
 * Live status, derived rather than hard-coded.
 *
 * `not_built` stays whatever the catalogue says — no amount of configuration
 * makes a route that does not exist work, and claiming otherwise would be the
 * most misleading thing this screen could do.
 */
export function deriveStatus(state: ConnectorState): Connector["status"] {
  if (state.connector.status === "not_built") return "not_built";
  if (!state.envComplete) return "not_configured";
  return state.updatedAt ? "connected" : "configured";
}
