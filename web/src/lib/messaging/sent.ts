/**
 * Sent (sent.dm) — the messaging provider.
 *
 * `POST https://api.sent.dm/v3/messages`, authenticated with an `x-api-key`
 * header. Returns 202 with `{ status: "QUEUED", message_id }`.
 *
 * Two things about this API are easy to get wrong, and both cost money:
 *
 * 1. **`channel` is a broadcast list, not a fallback order.** Passing
 *    `["sms", "whatsapp"]` does not mean "try SMS, fall back to WhatsApp" —
 *    it creates a separate message per (recipient, channel) pair and sends
 *    them all, each billed separately. A customer would receive the same
 *    delivery alert twice.
 *
 *    **Omitting `channel` is what gives cross-channel fallback**, and that is
 *    what a transactional alert wants. `deliverBy: "auto"` below does that.
 *
 * 2. **`template` and `text` are mutually exclusive.** Exactly one, or the API
 *    returns 400 "Provide exactly one of 'template' or 'text'."
 *
 * Verified against https://docs.sent.dm (August 2026).
 */

export const SENT_API_BASE = "https://api.sent.dm";

/** Channels Sent can deliver on. RCS is supported alongside SMS/WhatsApp. */
export type SentChannel = "sms" | "whatsapp" | "rcs";

/**
 * How to deliver.
 *
 * `auto` omits `channel` entirely, letting Sent pick and fall back — one
 * message, one charge. Anything else is an explicit broadcast: every channel
 * listed produces its own message and its own charge.
 */
export type DeliveryPreference = "auto" | SentChannel[];

export interface SentConfig {
  apiKey: string;
  /**
   * Sender Profile, sent as `x-profile-id`. Only needed for organisation-level
   * API keys; a key scoped to a single profile does not require it.
   */
  profileId?: string;
}

export function readConfig(): SentConfig | null {
  const apiKey = process.env.SENT_DM_API_KEY;
  if (!apiKey) return null;
  return { apiKey, profileId: process.env.SENT_PROFILE_ID };
}

export interface SendMessageInput {
  /** E.164 recipients. */
  to: string[];
  /** Raw message body. Mutually exclusive with `template`. */
  text?: string;
  /** Pre-registered template. Mutually exclusive with `text`. */
  template?: { id: string; parameters?: Record<string, string> };
  /** Defaults to `auto` — one message with provider-side fallback. */
  deliverBy?: DeliveryPreference;
}

export interface SendMessageResult {
  ok: boolean;
  status: number;
  messageId: string | null;
  /** How many billable messages this call created. */
  billableMessages: number;
  error: string | null;
}

/**
 * Number of messages a send will actually be charged for.
 *
 * Exposed so the UI can warn *before* someone broadcasts a customer alert
 * across three channels.
 */
export function billableMessageCount(
  recipients: number,
  deliverBy: DeliveryPreference = "auto",
): number {
  return deliverBy === "auto" ? recipients : recipients * deliverBy.length;
}

export async function sendMessage(
  config: SentConfig,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const hasText = typeof input.text === "string" && input.text.length > 0;
  const hasTemplate = input.template !== undefined;
  if (hasText === hasTemplate) {
    throw new Error(
      "sent.dm requires exactly one of `text` or `template` — got " +
        (hasText ? "both" : "neither"),
    );
  }

  const deliverBy = input.deliverBy ?? "auto";

  const body: Record<string, unknown> = { to: input.to };
  if (hasText) body.text = input.text;
  if (hasTemplate) body.template = input.template;
  // Deliberately absent for "auto": omitting the field is what enables Sent's
  // own cross-channel fallback. Sending ["sms"] would pin it to SMS only.
  if (deliverBy !== "auto") body.channel = deliverBy;

  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    "Content-Type": "application/json",
  };
  if (config.profileId) headers["x-profile-id"] = config.profileId;

  const response = await fetch(`${SENT_API_BASE}/v3/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const billable = billableMessageCount(input.to.length, deliverBy);

  let payload: { message_id?: string; status?: string; message?: string } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // A non-JSON body on an error status is still worth reporting by status.
  }

  return {
    ok: response.ok,
    status: response.status,
    messageId: payload.message_id ?? null,
    billableMessages: response.ok ? billable : 0,
    error: response.ok ? null : (payload.message ?? response.statusText),
  };
}

/** Sent's status vocabulary mapped onto `driver_messages.status`. */
export function normaliseStatus(
  providerStatus: string | undefined,
): "queued" | "sent" | "delivered" | "undelivered" | "failed" {
  switch (providerStatus?.toUpperCase()) {
    case "QUEUED":
    case "ACCEPTED":
      return "queued";
    case "SENT":
      return "sent";
    case "DELIVERED":
      return "delivered";
    case "UNDELIVERED":
      return "undelivered";
    default:
      return "failed";
  }
}
