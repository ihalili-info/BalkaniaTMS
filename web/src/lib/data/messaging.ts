"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_CONFIG } from "@/lib/integrations/catalogue";
import {
  missingConfigMessage,
  readConfig as readWhatsAppConfig,
  sendWhatsApp,
} from "@/lib/messaging/whatsapp";
import { readShortioConfig, shortenUrl } from "@/lib/messaging/shortio";
import type { Channel } from "@/lib/driver-messaging";

/**
 * Sending a driver their route over WhatsApp, and recording what happened in
 * `driver_messages` (migration 0005).
 *
 * **Two ways out, and which one runs depends on one setting.**
 *
 * - With a *driver route template* named on Integration Settings → WhatsApp,
 *   the send is a WhatsApp **template message** with the navigation link as its
 *   one variable. This is the only kind that can reach a driver who has not
 *   written to the business number in the last 24 hours — which is the normal
 *   case, so it is the one to set up. What the driver reads is the wording
 *   approved on the template; the dispatcher's preview is for reference.
 * - With none, the composed message goes as free-form **text**, every ticked
 *   navigation link included. WhatsApp only delivers that inside the 24-hour
 *   customer-service window, so it fails with an explained error otherwise.
 */

export interface SendDriverRouteInput {
  loadId: string;
  driverId: string | null;
  toPhone: string;
  /** The navigation link — the template's one variable, or the text's link. */
  routeUrl: string;
  /** The dispatcher-facing composed body. Sent as text when no template is set; stored for the audit trail either way. */
  previewBody: string;
}

export interface SendDriverRouteResult {
  ok: boolean;
  message: string | null;
  channel: Channel | null;
  /**
   * What happened to the navigation link.
   *   "shortened"      — a short.io link went out
   *   "full_url"       — short.io isn't configured; the full URL went out
   *   "shorten_failed" — short.io is configured but the call failed; the full
   *                      URL went out. `linkNote` says why.
   */
  link: "shortened" | "full_url" | "shorten_failed";
  linkNote: string | null;
}

export interface WhatsAppRouteStatus {
  /** Access token and phone-number id are both set. */
  configured: boolean;
  /** The approved template the route goes out as, or null for free-form text. */
  template: string | null;
}

/** The WhatsApp connector's saved, non-secret settings over its catalogue defaults. */
async function loadWhatsAppSettings(): Promise<{
  template: string | null;
  language: string;
}> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("integration_settings")
    .select("config")
    .eq("connector_id", "whatsapp")
    .maybeSingle();

  const config = {
    ...DEFAULT_CONFIG.whatsapp,
    ...((data?.config as Record<string, unknown>) ?? {}),
  };
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  return {
    template: text(config.template_route_link),
    language: text(config.template_language) ?? "en",
  };
}

/**
 * What the Send-route dialog needs to tell the dispatcher, before they send,
 * how the message will go out. Not secret — a template name and two booleans.
 */
export async function getWhatsAppRouteStatus(): Promise<WhatsAppRouteStatus> {
  const settings = await loadWhatsAppSettings();
  return {
    configured: readWhatsAppConfig() !== null,
    template: settings.template,
  };
}

export async function sendDriverRouteMessage(
  input: SendDriverRouteInput,
): Promise<SendDriverRouteResult> {
  // Default: no shortener wired up, so the full URL goes out. Narrowed below.
  let linkOutcome: Pick<SendDriverRouteResult, "link" | "linkNote"> = {
    link: "full_url",
    linkNote: null,
  };

  try {
    const user = await getCurrentUser();
    if (!user)
      return { ok: false, message: "Not signed in.", channel: null, ...linkOutcome };

    const config = readWhatsAppConfig();
    if (!config) {
      return {
        ok: false,
        message: missingConfigMessage(),
        channel: null,
        ...linkOutcome,
      };
    }

    const settings = await loadWhatsAppSettings();

    // Shorten the navigation link before it goes out. A multi-stop Google Maps
    // URL is ~500 characters — unreadable in a chat bubble and awkward to tap.
    // Best-effort: if short.io is not configured or the call fails, the full
    // URL is sent instead — and `linkOutcome` records which, so the dispatcher
    // is told.
    let routeUrl = input.routeUrl;
    let storedBody = input.previewBody;
    const shortio = readShortioConfig();
    if (shortio && routeUrl) {
      const short = await shortenUrl(shortio, routeUrl);
      if (short.shortened) {
        // Keep the audit-trail body in step with what actually went out.
        storedBody = storedBody.split(input.routeUrl).join(short.url);
        routeUrl = short.url;
        linkOutcome = { link: "shortened", linkNote: null };
      } else {
        linkOutcome = { link: "shorten_failed", linkNote: short.reason };
      }
    }

    const result = await sendWhatsApp(
      config,
      settings.template
        ? {
            to: input.toPhone,
            template: {
              name: settings.template,
              language: settings.language,
              bodyParameters: [routeUrl],
            },
          }
        : { to: input.toPhone, text: storedBody },
    );

    const supabase = await createClient();

    const { error: insertError } = await supabase.from("driver_messages").insert({
      load_id: input.loadId,
      driver_id: input.driverId,
      channel: "whatsapp",
      to_phone: input.toPhone,
      body: storedBody,
      kind: "route_link",
      sent_by: user.id,
      provider_sid: result.messageId,
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
        channel: "whatsapp",
        ...linkOutcome,
      };
    }

    revalidatePath("/active-loads");

    return {
      ok: result.ok,
      message: result.ok ? null : (result.error ?? "WhatsApp refused the message."),
      channel: "whatsapp",
      ...linkOutcome,
    };
  } catch (e) {
    return {
      ok: false,
      message: (e as Error).message,
      channel: null,
      ...linkOutcome,
    };
  }
}
