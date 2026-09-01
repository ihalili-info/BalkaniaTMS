/**
 * Sent (sent.dm) — the messaging provider.
 *
 * `POST https://api.sent.dm/v3/messages`, authenticated with an **`x-api-key`**
 * header holding a UUID, and nothing else. Sent's own reference is explicit
 * that this is header-key auth and *not* `Authorization: Bearer`, and that "no
 * other identifier is required" — confirmed against this account: sending works
 * on the API key alone, with no `x-profile-id` sender-profile header.
 *
 * Three things about this API are easy to get wrong:
 *
 * 1. **`channel` is a broadcast list, not a fallback order.** Passing
 *    `["sms", "whatsapp"]` does not mean "try SMS, fall back to WhatsApp" —
 *    it creates a separate message per (recipient, channel) pair and sends
 *    them all, each billed separately. A customer would get the alert twice.
 *
 *    The value that means *pick a channel and fall back* is the sentinel
 *    **`["sent"]`**, which is also what the API defaults to when `channel` is
 *    omitted. `deliverBy: "auto"` sends it explicitly rather than relying on a
 *    server-side default that could change under us.
 *
 * 2. **`template` and `text` are mutually exclusive.** Exactly one, or 400.
 *
 * 3. **The response is enveloped.** The message id is at
 *    `data.recipients[].message_id`, not at the top level — one id per
 *    recipient, not one per call.
 *
 * Checked against https://docs.sent.dm — the API reference for
 * `/v3/messages`, the authentication reference, and the TypeScript SDK page
 * (August 2026). The official SDK is `@sentdm/sentdm`; this stays a plain
 * `fetch` client so the app carries no runtime dependency for it, and because
 * the request is one JSON body.
 */

export const SENT_API_BASE = "https://api.sent.dm";

/** Channels Sent can deliver on. RCS is first-class alongside SMS/WhatsApp. */
export type SentChannel = "sms" | "whatsapp" | "rcs";

/**
 * The provider's own sentinel for "choose a channel, with fallback".
 *
 * Not one of `SentChannel` — it is a routing instruction, not a transport.
 */
const AUTO_CHANNEL = "sent";

/**
 * How to deliver.
 *
 * `auto` sends `channel: ["sent"]` — one message, one charge, provider-side
 * fallback. Anything else is an explicit broadcast: every channel listed
 * produces its own message and its own charge.
 */
export type DeliveryPreference = "auto" | SentChannel[];

export interface SentConfig {
  apiKey: string;
}

export function readConfig(): SentConfig | null {
  const apiKey = process.env.SENT_DM_API_KEY;
  if (!apiKey) return null;
  return { apiKey };
}

export interface SendMessageInput {
  /** E.164 recipients. At least one. */
  to: string[];
  /** Raw message body. Mutually exclusive with `template`. */
  text?: string;
  /** Pre-registered template, addressed by id or name. */
  template?: {
    id?: string;
    name?: string;
    parameters?: Record<string, string>;
  };
  /** Defaults to `auto` — one message with provider-side fallback. */
  deliverBy?: DeliveryPreference;
  /**
   * Validate the whole path without sending or being charged.
   *
   * Worth using for the first end-to-end run: it exercises auth, the body
   * shape and the template, and nothing reaches a customer's phone.
   */
  sandbox?: boolean;
  /**
   * Replay guard on Sent's side.
   *
   * A network timeout on a send is ambiguous — the message may or may not have
   * gone. Retrying without this bills twice and alerts the customer twice. The
   * caller should derive it from something stable, e.g. the notification's
   * `(load_item_id, type)` pair.
   */
  idempotencyKey?: string;
}

export interface SentRecipientResult {
  messageId: string;
  to: string;
  /** The channel Sent actually chose, which matters when `deliverBy` is auto. */
  channel: string | null;
}

export interface SendMessageResult {
  ok: boolean;
  status: number;
  /** One per recipient. Empty on failure. */
  recipients: SentRecipientResult[];
  /** Provider-side status for the batch, e.g. `QUEUED`. */
  providerStatus: string | null;
  /** Sent's request id — quote this when asking their support about a send. */
  requestId: string | null;
  /** How many billable messages this call created. Zero in sandbox. */
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

/** The documented v3 envelope. Every field optional — this is parsed, not trusted. */
interface SentEnvelope {
  success?: boolean;
  data?: {
    status?: string;
    recipients?: { message_id?: string; to?: string; channel?: string }[];
  } | null;
  error?: { code?: string; message?: string; details?: unknown } | null;
  meta?: { request_id?: string } | null;
  /** Older/edge error bodies put the text at the top level. */
  message?: string;
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
  if (input.to.length === 0) {
    throw new Error("sent.dm requires at least one recipient.");
  }

  const deliverBy = input.deliverBy ?? "auto";

  const body: Record<string, unknown> = {
    to: input.to,
    channel: deliverBy === "auto" ? [AUTO_CHANNEL] : deliverBy,
  };
  if (hasText) body.text = input.text;
  if (hasTemplate) body.template = input.template;
  if (input.sandbox) body.sandbox = true;

  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${SENT_API_BASE}/v3/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      recipients: [],
      providerStatus: null,
      requestId: null,
      billableMessages: 0,
      error: `Could not reach Sent: ${(e as Error).message}`,
    };
  }

  let payload: SentEnvelope = {};
  try {
    payload = (await response.json()) as SentEnvelope;
  } catch {
    // A non-JSON body on an error status is still worth reporting by status.
  }

  const recipients = (payload.data?.recipients ?? [])
    .filter((r) => typeof r.message_id === "string")
    .map((r) => ({
      messageId: r.message_id!,
      to: r.to ?? "",
      channel: r.channel ?? null,
    }));

  return {
    ok: response.ok,
    status: response.status,
    recipients,
    providerStatus: payload.data?.status ?? null,
    requestId: payload.meta?.request_id ?? null,
    // Sandbox sends are validated, not delivered, so nothing is charged.
    billableMessages:
      response.ok && !input.sandbox
        ? billableMessageCount(input.to.length, deliverBy)
        : 0,
    error: response.ok
      ? null
      : (payload.error?.message ?? payload.message ?? response.statusText),
  };
}

/**
 * Is the key valid?
 *
 * `GET /v3/me` is the cheapest way to answer that, and it is the honest test
 * for an Integrations "test connection" button — unlike sending a message,
 * it costs nothing and reaches nobody.
 */
export async function verifyConnection(
  config: SentConfig,
): Promise<{ ok: boolean; status: number; error: string | null }> {
  try {
    const response = await fetch(`${SENT_API_BASE}/v3/me`, {
      headers: { "x-api-key": config.apiKey, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (response.ok) return { ok: true, status: response.status, error: null };
    const payload = (await response.json().catch(() => ({}))) as SentEnvelope;
    return {
      ok: false,
      status: response.status,
      error: payload.error?.message ?? response.statusText,
    };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

/* --- inbound webhooks ------------------------------------------------------
 *
 * Sent can POST delivery-status receipts, signed with a `whsec_`-prefixed
 * secret (HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, `v1,{base64}` header,
 * five-minute replay window). Nothing consumes them yet — there is no route
 * and `driver_messages.status` is only ever set at send time — so the
 * verifier and `SENT_WEBHOOK_SECRET` were removed rather than shipped unwired.
 * Re-add both together when receipts are actually wanted.
 */
