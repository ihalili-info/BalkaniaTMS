"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_CONFIG } from "@/lib/integrations/catalogue";
import { readConfig as readSentConfig, sendMessage } from "@/lib/messaging/sent";
import type { Channel } from "@/lib/driver-messaging";

/**
 * The seam `route-actions.tsx` was waiting on: actually calling Sent, and
 * recording what happened in `driver_messages` (migration 0005).
 *
 * Sends by **template**, not raw `text` — the driver route template already
 * exists in the Sent dashboard, so `sendMessage` gets `template.id` +
 * `parameters.routeURL` instead of a composed body. The dispatcher-facing
 * preview in `SendRouteDialog` still shows a composed body for readability;
 * what actually goes out is whatever wording is registered on the template,
 * with `routeURL` substituted in. The two are not guaranteed to read
 * identically — the template is the source of truth for the words.
 */

export interface SendDriverRouteInput {
  loadId: string;
  driverId: string | null;
  toPhone: string;
  channel: Channel;
  /** The single navigation link the template's `routeURL` variable takes. */
  routeUrl: string;
  /** The dispatcher-facing preview body, stored for the audit trail only. */
  previewBody: string;
}

export interface SendDriverRouteResult {
  ok: boolean;
  message: string | null;
  channel: Channel | null;
}

/** Reads the Sent connector's saved config, falling back to its catalogue defaults. */
async function loadSentTemplateId(
  key: "template_route_link",
): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("integration_settings")
    .select("config")
    .eq("connector_id", "sent")
    .maybeSingle();

  const config = {
    ...DEFAULT_CONFIG.sent,
    ...((data?.config as Record<string, unknown>) ?? {}),
  };
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function sendDriverRouteMessage(
  input: SendDriverRouteInput,
): Promise<SendDriverRouteResult> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, message: "Not signed in.", channel: null };

    const sentConfig = readSentConfig();
    if (!sentConfig) {
      return {
        ok: false,
        message: "Sent is not configured — SENT_DM_API_KEY is not set.",
        channel: null,
      };
    }

    const templateId = await loadSentTemplateId("template_route_link");
    if (!templateId) {
      return {
        ok: false,
        message:
          "No driver route template is set on Integration Settings → Sent.",
        channel: null,
      };
    }

    const result = await sendMessage(sentConfig, {
      to: [input.toPhone],
      template: { id: templateId, parameters: { routeURL: input.routeUrl } },
      // The dispatcher picked a channel in the dialog — an explicit
      // single-channel array, not "auto", so the send goes exactly where they
      // chose rather than wherever Sent's fallback would have picked.
      deliverBy: [input.channel],
      // A fresh key per click: this is a one-off dispatcher action, not a
      // background job that retries on its own, so there is no natural
      // stable key the way `(load_item_id, type)` is for the automated
      // alerts — and a stable key here would block a deliberate resend.
      idempotencyKey: randomUUID(),
    });

    const supabase = await createClient();
    const sentChannel = (result.recipients[0]?.channel as Channel | undefined) ?? input.channel;

    const { error: insertError } = await supabase.from("driver_messages").insert({
      load_id: input.loadId,
      driver_id: input.driverId,
      channel: sentChannel,
      to_phone: input.toPhone,
      body: input.previewBody,
      kind: "route_link",
      sent_by: user.id,
      provider_sid: result.recipients[0]?.messageId ?? null,
      status: result.ok ? "queued" : "failed",
      failure_reason: result.ok ? null : result.error,
    });

    if (insertError) {
      // The send may have gone out even though the record failed to save —
      // say so rather than reporting a clean failure for a message that
      // actually reached the driver.
      return {
        ok: false,
        message: result.ok
          ? `Sent, but the record could not be saved: ${insertError.message}`
          : insertError.message,
        channel: sentChannel,
      };
    }

    revalidatePath("/active-loads");

    return {
      ok: result.ok,
      message: result.ok ? null : (result.error ?? "Sent refused the message."),
      channel: sentChannel,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message, channel: null };
  }
}
