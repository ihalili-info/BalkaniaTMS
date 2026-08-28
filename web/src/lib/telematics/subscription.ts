/**
 * The GPS webhook subscription handshake.
 *
 * Verizon's GPS Push Service does not start sending positions the moment an
 * endpoint is submitted. It first POSTs a confirmation message carrying a
 * `SubscribeURL`, and the subscription only becomes live once that URL has
 * been fetched. Miss it and the submission expires after three days.
 *
 * The shape is the AWS SNS one (Type / Token / SubscribeURL), which is what
 * the service is built on.
 */

export interface SubscriptionMessage {
  subscribeUrl: string;
  messageType: string | null;
}

/** Case-insensitive lookup, because casing has varied across their payloads. */
function find(payload: Record<string, unknown>, key: string): unknown {
  const wanted = key.toLowerCase();
  for (const [k, v] of Object.entries(payload)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/**
 * Is this the handshake rather than a position?
 *
 * Detected by the presence of a SubscribeURL rather than by `Type`, because
 * the URL is the part we actually need — a message announcing itself as a
 * confirmation but carrying no URL is useless to us either way.
 */
export function readSubscription(
  payload: unknown,
): SubscriptionMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;

  const url = find(row, "SubscribeURL") ?? find(row, "subscribe_url");
  if (typeof url !== "string" || url.trim() === "") return null;

  const type = find(row, "Type");
  return {
    subscribeUrl: url.trim(),
    messageType: typeof type === "string" ? type : null,
  };
}

/**
 * Hosts we are willing to make an outbound request to.
 *
 * This matters more than it looks. Auto-confirming means our server fetches a
 * URL that arrived in a request body — server-side request forgery, if the URL
 * can be anything. Anyone who learned the webhook credentials could otherwise
 * point us at an internal address and use us as a proxy. An allow-list keeps
 * the convenience without the hole.
 */
const ALLOWED_HOSTS = [
  // Suffix-matched, so the EU regional SNS hosts (sns.eu-west-1.amazonaws.com,
  // sns.eu-central-1.amazonaws.com, …) are covered without listing each.
  "amazonaws.com",
  "fleetmatics.com",
  "verizonconnect.com",
  "vzconnect.com",
];

export function isConfirmableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export interface ConfirmResult {
  confirmed: boolean;
  status: number | null;
  reason: string;
}

/**
 * Completes the handshake by fetching the SubscribeURL.
 *
 * Never throws: a failure here must still return so the URL gets logged and a
 * human can finish it before the window closes.
 */
export async function confirmSubscription(
  subscribeUrl: string,
): Promise<ConfirmResult> {
  if (!isConfirmableUrl(subscribeUrl)) {
    return {
      confirmed: false,
      status: null,
      reason:
        "SubscribeURL is not on a recognised Verizon or AWS host — not fetched. Confirm it by hand if it is genuine.",
    };
  }

  try {
    const response = await fetch(subscribeUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return {
      confirmed: response.ok,
      status: response.status,
      reason: response.ok
        ? "Subscription confirmed automatically."
        : `Verizon returned ${response.status} for the SubscribeURL.`,
    };
  } catch (e) {
    return {
      confirmed: false,
      status: null,
      reason: `Could not reach the SubscribeURL: ${(e as Error).message}`,
    };
  }
}
