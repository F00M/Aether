import {
  SEPOLIA_CHAIN_ID,
  fetchUpstream,
  isCrossSite,
  isRateLimited,
  json,
  relay,
  serverKey,
  upstreamFailure,
} from "@/lib/api-proxy";

/**
 * POST /api/uniswap/quote and /api/uniswap/swap — server-side proxy for the Uniswap Trading API.
 *
 * Replaces the old `/uniswap-api/*` rewrite, which forwarded whatever the browser sent — including
 * the key, read from NEXT_PUBLIC_UNISWAP_API_KEY and therefore visible in the client bundle. Now
 * UNISWAP_API_KEY and the fixed API headers are added here, and only Sepolia requests to the two
 * endpoints the app uses are forwarded.
 */
const ENDPOINTS: Record<string, string> = {
  quote: "https://trade-api.gateway.uniswap.org/v1/quote",
  swap: "https://trade-api.gateway.uniswap.org/v1/swap",
};
const PER_MINUTE = 60;
// /swap posts the full /quote response back, route included — generous, but bounded.
const MAX_BODY_BYTES = 256 * 1024;

type Body = Record<string, unknown>;

function chainOk(endpoint: string, body: Body): boolean {
  if (endpoint === "quote") {
    return body.tokenInChainId === SEPOLIA_CHAIN_ID && body.tokenOutChainId === SEPOLIA_CHAIN_ID;
  }
  const quote = body.quote as Body | undefined;
  if (!quote || typeof quote !== "object") return false;
  return quote.chainId === undefined || quote.chainId === SEPOLIA_CHAIN_ID;
}

export async function POST(request: Request, { params }: { params: Promise<{ endpoint: string }> }) {
  const { endpoint } = await params;
  const target = ENDPOINTS[endpoint];
  if (!target) return json({ error: "not_found" }, 404);
  if (isCrossSite(request)) return json({ error: "cross_site" }, 403);
  if (isRateLimited(request, "uniswap", PER_MINUTE)) return json({ error: "rate_limited" }, 429);

  const key = serverKey("UNISWAP_API_KEY", "NEXT_PUBLIC_UNISWAP_API_KEY");
  // The client reads this as "no API reference for this deployment" and stops asking.
  if (!key) return json({ error: "not_configured" }, 503);

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let body: Body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || !chainOk(endpoint, body)) {
    return json({ error: "only_sepolia" }, 400);
  }

  try {
    const response = await fetchUpstream(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": key,
        "x-universal-router-version": "2.0",
        "x-permit2-disabled": "true",
      },
      body: text,
    });
    return relay(response);
  } catch (error) {
    return upstreamFailure(error, "Uniswap API");
  }
}
