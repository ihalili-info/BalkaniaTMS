/**
 * WhatsApp — the messaging channel, over Meta's WhatsApp Business Cloud API.
 *
 * `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`,
 * authenticated with `Authorization: Bearer <access token>`. This is the only
 * messaging transport in the app: WhatsApp is the sole channel, so there is no
 * channel choice, no fallback and no provider in between.
 *
 * Things about this API that are easy to get wrong:
 *
 * 1. **A business can only open a conversation with a template.** Free-form
 *    `text` is delivered only inside the 24-hour customer-service window — i.e.
 *    the recipient messaged *this number* within the last day. Anything else
 *    is refused with error code 131047 ("re-engagement message"). A driver who
 *    has never written to the business number is always outside the window, so
 *    a route link to them has to be a pre-approved **template**. Templates are
 *    created and approved in Meta's WhatsApp Manager, not through this app.
 *
 * 2. **There is no idempotency key.** A timeout on a send is ambiguous — the
 *    message may have gone. Nothing here retries on its own, so the only
 *    double-send is a dispatcher clicking twice, which is a decision, not a
 *    bug. (Sent offered an `Idempotency-Key`; this API does not.)
 *
 * 3. **`200` means accepted, not delivered.** The response carries a message
 *    id (`wamid.…`); whether it reached the handset arrives later on a
 *    status webhook. That webhook is not consumed — there is no route for it —
 *    so `driver_messages.status` is set at send time only, as it always was.
 *
 * 4. **Template body variables cannot contain a newline, a tab, or more than
 *    four consecutive spaces.** A URL is fine; a composed multi-line message
 *    is not, which is why a template takes the link alone.
 *
 * 5. **The recipient is digits only** — country code first, no `+`, no
 *    spaces. `whatsappNumber()` does the conversion.
 *
 * Plain `fetch`; no SDK. Checked against Meta's Cloud API reference (Messages,
 * Message Templates, Error Codes), September 2026.
 */

/** Pinned rather than floating — Meta retires Graph versions on a schedule. Override with `WHATSAPP_API_VERSION`. */
const DEFAULT_API_VERSION = "v22.0";

export interface WhatsAppConfig {
  accessToken: string;
  /** The sending number's id from WhatsApp Manager — not the phone number itself. */
  phoneNumberId: string;
  apiVersion: string;
}

export function readConfig(): WhatsAppConfig | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!accessToken || !phoneNumberId) return null;
  return {
    accessToken,
    phoneNumberId,
    apiVersion: process.env.WHATSAPP_API_VERSION?.trim() || DEFAULT_API_VERSION,
  };
}

export function whatsappConfigured(): boolean {
  return readConfig() !== null;
}

/** Which of the two required variables is missing, for an error a person can act on. */
export function missingConfigMessage(): string {
  const missing = [
    process.env.WHATSAPP_ACCESS_TOKEN?.trim() ? null : "WHATSAPP_ACCESS_TOKEN",
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ? null : "WHATSAPP_PHONE_NUMBER_ID",
  ].filter(Boolean);
  return `WhatsApp is not configured — ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`;
}

/**
 * `+353 85 123 4567` → `353851234567`.
 *
 * Returns null for anything that cannot be a full international number, rather
 * than guessing a country: a local `085 123 4567` has no country code, and
 * prefixing the wrong one would message a stranger.
 */
export function whatsappNumber(phone: string): string | null {
  const trimmed = phone.trim();
  // `00` is the international dial prefix; `+` says the same thing.
  const international = trimmed.startsWith("+") || trimmed.startsWith("00");
  if (!international) return null;
  const digits = trimmed.replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export interface SendWhatsAppInput {
  /** E.164 (`+353…`). Converted with `whatsappNumber`. */
  to: string;
  /**
   * A pre-approved template. Required to reach anyone outside the 24-hour
   * window, which for a driver is the normal case.
   */
  template?: {
    name: string;
    /** Language code the template was approved in, e.g. `en`, `en_GB`. */
    language: string;
    /** Values for `{{1}}`, `{{2}}` … in the template body, in order. */
    bodyParameters: string[];
  };
  /** Free-form body. Only delivered inside the 24-hour window. Exclusive with `template`. */
  text?: string;
}

export interface SendWhatsAppResult {
  ok: boolean;
  status: number;
  /** `wamid.…` — the id to quote when asking Meta about a message. */
  messageId: string | null;
  /** Meta's error code, e.g. 131047. */
  errorCode: number | null;
  /** A message a dispatcher can act on. Null on success. */
  error: string | null;
}

/** Meta's error envelope. Every field optional — this is parsed, not trusted. */
interface GraphResponse {
  messages?: { id?: string }[];
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

/**
 * The codes a dispatcher will actually meet, said in terms of what to do.
 * Anything else falls through to Meta's own text.
 */
function explain(code: number | undefined, fallback: string): string {
  switch (code) {
    case 131047:
      return "WhatsApp only allows free-form messages within 24 hours of the driver last writing to this number. Set a driver route template on Integration Settings → WhatsApp so the link can be sent as a template.";
    case 131030:
      return "That number is not on the allowed recipient list for this WhatsApp number — add it in Meta's API setup while the app is in test mode.";
    case 131026:
      return "WhatsApp could not deliver to that number — it may not have a WhatsApp account, or has not accepted the latest terms.";
    case 132001:
      return "That template name and language don't exist (or aren't approved) in WhatsApp Manager. Check the name and language code on Integration Settings → WhatsApp.";
    case 132000:
    case 132005:
    case 132012:
      return `The template's variables don't match what was sent: ${fallback}`;
    case 190:
      return "The WhatsApp access token is invalid or expired — generate a new (permanent) system-user token and update WHATSAPP_ACCESS_TOKEN.";
    case 4:
    case 80007:
    case 130429:
      return "WhatsApp rate limit hit — wait a moment and send again.";
    default:
      return fallback;
  }
}

export async function sendWhatsApp(
  config: WhatsAppConfig,
  input: SendWhatsAppInput,
): Promise<SendWhatsAppResult> {
  const hasText = typeof input.text === "string" && input.text.length > 0;
  const hasTemplate = input.template !== undefined;
  if (hasText === hasTemplate) {
    throw new Error(
      "WhatsApp needs exactly one of `text` or `template` — got " +
        (hasText ? "both" : "neither"),
    );
  }

  const to = whatsappNumber(input.to);
  if (!to) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      errorCode: null,
      error: `"${input.to}" is not a full international number. WhatsApp needs the country code — e.g. +353 85 123 4567.`,
    };
  }

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
  };
  if (input.template) {
    body.type = "template";
    body.template = {
      name: input.template.name,
      language: { code: input.template.language },
      components:
        input.template.bodyParameters.length > 0
          ? [
              {
                type: "body",
                parameters: input.template.bodyParameters.map((text) => ({
                  type: "text",
                  text,
                })),
              },
            ]
          : [],
    };
  } else {
    body.type = "text";
    // A link preview would replace the URL with a map thumbnail in the chat.
    body.text = { body: input.text, preview_url: false };
  }

  let response: Response;
  try {
    response = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
  } catch (e) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      errorCode: null,
      error: `Could not reach WhatsApp: ${(e as Error).message}`,
    };
  }

  let payload: GraphResponse = {};
  try {
    payload = (await response.json()) as GraphResponse;
  } catch {
    // A non-JSON body on an error status is still worth reporting by status.
  }

  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      messageId: payload.messages?.[0]?.id ?? null,
      errorCode: null,
      error: null,
    };
  }

  const detail = payload.error?.error_data?.details ?? payload.error?.message;
  return {
    ok: false,
    status: response.status,
    messageId: null,
    errorCode: payload.error?.code ?? null,
    error: explain(payload.error?.code, detail ?? response.statusText),
  };
}

/**
 * Is the token valid, and is this the number we think it is?
 *
 * `GET /{phone-number-id}` reads the number's own profile — free, and it
 * reaches nobody, unlike a send. It also proves the *pairing* is right: a token
 * that is valid for a different business account fails here, which a bare
 * "is this token alive" check would not catch.
 */
export async function verifyConnection(
  config: WhatsAppConfig,
): Promise<{
  ok: boolean;
  status: number;
  error: string | null;
  /** e.g. `+353 85 123 4567 · Balkania Ltd` */
  detail: string | null;
}> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        cache: "no-store",
      },
    );
    const payload = (await response.json().catch(() => ({}))) as GraphResponse & {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
    };
    if (response.ok) {
      const detail = [
        payload.display_phone_number,
        payload.verified_name,
        payload.quality_rating ? `quality ${payload.quality_rating.toLowerCase()}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return { ok: true, status: response.status, error: null, detail: detail || null };
    }
    return {
      ok: false,
      status: response.status,
      error: explain(payload.error?.code, payload.error?.message ?? response.statusText),
      detail: null,
    };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message, detail: null };
  }
}

/* --- inbound webhooks ------------------------------------------------------
 *
 * Meta can POST delivery receipts and inbound messages (a driver's reply, a
 * customer's STOP) to a webhook signed with `X-Hub-Signature-256`
 * (HMAC-SHA256 of the raw body with the app secret). Nothing consumes them —
 * there is no route, and `driver_messages.status` is set only at send time.
 * Add the route and the verifier together if receipts or STOP handling over
 * WhatsApp are wanted; a driver reply would also open the 24-hour window.
 */
