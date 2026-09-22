/**
 * Guard rails shared by the API-key proxies in src/app/api (LI.FI, Uniswap Trading API).
 *
 * The proxies exist so the keys stay on the server instead of being inlined into the browser
 * bundle as NEXT_PUBLIC_*. That also makes each proxy a door to those keys, so it refuses anything
 * the app itself would never send: cross-site callers, other chains, unknown endpoints and
 * parameters, oversized bodies, and bursts beyond a per-IP budget. None of this is authentication
 * (a scripted client can still call a public proxy); it keeps the proxy from being an open relay.
 *
 * Server-only: import this from route handlers, never from client components.
 */

export const SEPOLIA_CHAIN_ID = 11155111;
const UPSTREAM_TIMEOUT_MS = 15_000;
const RATE_WINDOW_MS = 60_000;

/**
 * Server-side key lookup. `legacy` is the old NEXT_PUBLIC_* name: still honoured so an existing
 * deployment doesn't silently lose its key, but it would be inlined into the client bundle if any
 * client code referenced it — so it warns once.
 */
const warnedLegacy = new Set<string>();
export function serverKey(name: string, legacy?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value) return value;
  const legacyValue = legacy ? process.env[legacy]?.trim() : undefined;
  if (legacyValue && legacy && !warnedLegacy.has(legacy)) {
    warnedLegacy.add(legacy);
    console.warn(`[api-proxy] ${legacy} is set — rename it to ${name} so the key stays server-only.`);
  }
  return legacyValue || undefined;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Browsers label every fetch with Sec-Fetch-Site; a page on another site calling this proxy
 * through a visitor's browser shows up as "cross-site" (or with a foreign Origin). The app's own
 * calls are "same-origin".
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

// Fixed-window counter per (scope, IP). In-memory, so it's per server instance — enough to stop a
// runaway loop or a scraper from draining the upstream quota; use the host's limiter for more.
const buckets = new Map<string, { count: number; resetAt: number }>();
export function isRateLimited(request: Request, scope: string, perMinute: number): boolean {
  const now = Date.now();
  if (buckets.size > 5_000) {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }
  const key = `${scope}|${clientIp(request)}`;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > perMinute;
}

/** Upstream call with a hard timeout. Throws on network failure / timeout. */
export async function fetchUpstream(url: string | URL, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Passes the upstream status and body through, but none of its headers except the content type:
 * nothing upstream sends (cookies, rate-limit/account headers) needs to reach the browser.
 */
export async function relay(upstream: Response): Promise<Response> {
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

export function upstreamFailure(error: unknown, service: string): Response {
  const timedOut = error instanceof Error && error.name === "AbortError";
  return json({ message: timedOut ? `${service} timed out` : `${service} unreachable` }, timedOut ? 504 : 502);
}
