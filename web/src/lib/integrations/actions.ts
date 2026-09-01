"use server";

import { revalidatePath } from "next/cache";

import { requireAccess } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  readConfig as readSentConfig,
  verifyConnection as verifySentConnection,
} from "@/lib/messaging/sent";
import {
  readShortioConfig,
  verifyShortioConnection,
} from "@/lib/messaging/shortio";
import {
  ROUTING_MESSAGE,
  routingConfigured,
  verifyRoutingConnection,
} from "@/lib/routing/google";

import { connector } from "./catalogue";
import type { ConfigValue } from "./store";

export interface SaveState {
  ok: boolean;
  message: string | null;
}

/**
 * Saves one connector's non-secret configuration.
 *
 * Three checks, on purpose: `requireAccess` confirms the caller may open the
 * Integrations module at all, the field allow-list means only declared keys are
 * written, and RLS on `integration_settings` refuses a non-admin regardless of
 * what got past the first two. A server action is a public HTTP endpoint — the
 * page having been rendered for an admin proves nothing about who calls it.
 */
export async function saveConnectorConfig(
  connectorId: string,
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  await requireAccess("/integration-settings");

  const spec = connector(connectorId);
  if (!spec) return { ok: false, message: "Unknown integration." };

  const user = await getCurrentUser();
  if (!user) return { ok: false, message: "Not signed in." };

  // Allow-list: only fields this connector declares. Anything else in the form
  // body is ignored rather than written.
  const config: Record<string, ConfigValue> = {};
  for (const field of spec.fields) {
    const raw = formData.get(field.key);
    if (field.kind === "toggle") {
      config[field.key] = raw === "on" || raw === "true";
      continue;
    }
    if (raw === null) continue;
    if (field.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      config[field.key] = Math.min(
        field.max ?? Number.MAX_SAFE_INTEGER,
        Math.max(field.min ?? 0, n),
      );
      continue;
    }
    config[field.key] = String(raw).trim();
  }

  const supabase = await createClient();
  const { error } = await supabase.from("integration_settings").upsert(
    {
      connector_id: connectorId,
      config,
      enabled: true,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connector_id" },
  );

  if (error) {
    // An RLS refusal surfaces here for a non-admin who called the action
    // directly. Say what happened rather than pretending it saved.
    return { ok: false, message: error.message };
  }

  revalidatePath("/integration-settings");
  return { ok: true, message: `${spec.name} settings saved.` };
}

export interface ConnectionTestResult {
  id: string;
  name: string;
  ok: boolean;
  message: string;
}

/**
 * The "Test connections" button's actual work.
 *
 * Only ever tests what has a **free** check — sending a real message to prove
 * a channel works is not a test, it is a bill. Today that is Sent's
 * `GET /v3/me` and a 1×1 Routes matrix request (a fraction of a cent — the
 * Routes API has no free endpoint). Reveal, Geotab, geocoding and the rest
 * have no equivalent wired up yet, so they are silently left out rather than
 * reported as failing for a check that was never attempted.
 */
export async function testConnections(): Promise<ConnectionTestResult[]> {
  await requireAccess("/integration-settings");

  const results: ConnectionTestResult[] = [];

  const sentConfig = readSentConfig();
  if (!sentConfig) {
    results.push({
      id: "sent",
      name: "Sent (sent.dm)",
      ok: false,
      message: "SENT_DM_API_KEY is not set.",
    });
  } else {
    const check = await verifySentConnection(sentConfig);
    results.push({
      id: "sent",
      name: "Sent (sent.dm)",
      ok: check.ok,
      message: check.ok
        ? "Key is valid."
        : (check.error ?? `Request failed (${check.status}).`),
    });
  }

  // Short.io: always reported, because "the driver SMS still has the long URL"
  // is the exact symptom of it not being set up, and the dispatcher needs to
  // see which half is missing.
  const shortioConfig = readShortioConfig();
  if (!shortioConfig) {
    results.push({
      id: "shortio",
      name: "Short.io link shortener",
      ok: false,
      message:
        "Not set — add SHORTIO_API_KEY and SHORTIO_DOMAIN. Until then driver route links are sent in full.",
    });
  } else {
    const check = await verifyShortioConnection(shortioConfig);
    results.push({
      id: "shortio",
      name: "Short.io link shortener",
      ok: check.ok,
      message: check.ok
        ? "Key is valid and the domain matches — links will be shortened."
        : (check.error ?? `Request failed (${check.status}).`),
    });
  }

  if (!routingConfigured()) {
    results.push({
      id: "routing",
      name: "Routing & ETA",
      ok: false,
      message: ROUTING_MESSAGE.not_configured,
    });
  } else {
    const check = await verifyRoutingConnection();
    results.push({
      id: "routing",
      name: "Routing & ETA",
      ok: check.ok,
      message: check.ok
        ? "Google Routes reachable and the key is enabled for it."
        : (check.failure ? ROUTING_MESSAGE[check.failure] : "Request failed."),
    });
  }

  return results;
}
