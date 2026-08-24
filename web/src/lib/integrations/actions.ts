"use server";

import { revalidatePath } from "next/cache";

import { requireAccess } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

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
  if (!user || user.isDemo) {
    return {
      ok: false,
      message:
        "Running on demo fixtures — connect Supabase before saving settings.",
    };
  }

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
