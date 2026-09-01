import "server-only";

/**
 * Short.io — shortens the navigation URL before it goes out in a driver SMS.
 *
 * **Why this exists.** A multi-stop Google Maps directions URL runs to roughly
 * 500 characters, which pushes the route SMS to four or more segments. A long
 * concatenated SMS is reassembled by the receiving handset from parts that are
 * delivered separately, and when one part is dropped or reordered the driver is
 * left with a truncated, dead link — the exact failure this replaces. A
 * ~25-character short link keeps the whole message inside one or two segments
 * and the link intact.
 *
 * **Best-effort, never on the critical path.** No key, an unknown domain, a
 * rate limit, or a slow response all fall back to sending the full URL: a long
 * link that usually works beats no message.
 *
 * API: `POST https://api.short.io/links`, authenticated with `Authorization:
 * <key>` — the raw key, not `Bearer`. `allowDuplicates: false` (the default)
 * means re-shortening a URL already in the account returns the existing short
 * link *without* spending another slot from the plan's quota, so resending the
 * same route costs nothing. `GET /api/domains` is the free connection check.
 */

const API_BASE = "https://api.short.io";

/**
 * Below this length, shortening spends quota to save little: a single-
 * destination Waze or Apple Maps link is already short enough not to fragment
 * an SMS. The long Google Maps multi-stop link — the one that actually breaks —
 * is far above it.
 */
const MIN_LENGTH_TO_SHORTEN = 100;

/** A slow shortener must not stall the send. */
const TIMEOUT_MS = 4000;

export interface ShortioConfig {
  apiKey: string;
  /**
   * The short domain links are created under — a custom domain like
   * `go.balkania.ie`, or the plan's assigned `*.short.gy` subdomain. Must be a
   * domain that already exists in the Short.io account.
   */
  domain: string;
}

export function readShortioConfig(): ShortioConfig | null {
  const apiKey = process.env.SHORTIO_API_KEY?.trim();
  const domain = process.env.SHORTIO_DOMAIN?.trim();
  if (!apiKey || !domain) return null;
  return { apiKey, domain };
}

export function shortioConfigured(): boolean {
  return readShortioConfig() !== null;
}

export interface ShortenOutcome {
  /** The short URL on success, otherwise the original untouched. */
  url: string;
  shortened: boolean;
}

/**
 * Shortens one URL. Always returns a usable URL — the original when shortening
 * was skipped (already short) or failed for any reason.
 */
export async function shortenUrl(
  config: ShortioConfig,
  originalURL: string,
): Promise<ShortenOutcome> {
  if (originalURL.length < MIN_LENGTH_TO_SHORTEN) {
    return { url: originalURL, shortened: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/links`, {
      method: "POST",
      headers: {
        Authorization: config.apiKey,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        originalURL,
        domain: config.domain,
        allowDuplicates: false,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return { url: originalURL, shortened: false };

    const body = (await response.json().catch(() => ({}))) as {
      shortURL?: string;
      secureShortURL?: string;
    };
    const short = body.secureShortURL ?? body.shortURL ?? null;
    return short
      ? { url: short, shortened: true }
      : { url: originalURL, shortened: false };
  } catch {
    // Timeout, network, non-JSON body — all fall back to the full URL.
    return { url: originalURL, shortened: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyShortioConnection(
  config: ShortioConfig,
): Promise<{ ok: boolean; status: number; error: string | null }> {
  try {
    const response = await fetch(`${API_BASE}/api/domains`, {
      headers: { Authorization: config.apiKey, accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error:
          response.status === 401
            ? "SHORTIO_API_KEY was rejected."
            : `short.io returned ${response.status}.`,
      };
    }
    const domains = (await response.json().catch(() => [])) as {
      hostname?: string;
    }[];
    const known =
      Array.isArray(domains) &&
      domains.some((d) => d.hostname === config.domain);
    return known
      ? { ok: true, status: 200, error: null }
      : {
          ok: false,
          status: 200,
          error: `Key is valid, but SHORTIO_DOMAIN "${config.domain}" is not one of this account's domains.`,
        };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
