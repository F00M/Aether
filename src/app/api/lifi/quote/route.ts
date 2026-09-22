import type { NextRequest } from "next/server";

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
 * GET /api/lifi/quote — server-side proxy for LI.FI's /v1/quote.
 *
 * Adds LIFI_API_KEY (12,000 requests / 2h instead of the keyless 75) and LIFI_INTEGRATOR on the
 * server. Only same-chain Sepolia quotes with well-formed parameters are forwarded, and only the
 * parameters the app sends — everything else is dropped before it reaches LI.FI.
 */
const LIFI_QUOTE_URL = "https://li.quest/v1/quote";
// One quote run asks LI.FI once or twice; 60/min per IP leaves room for fast typing.
const PER_MINUTE = 60;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]{1,78}$/;

export async function GET(request: NextRequest) {
  if (isCrossSite(request)) return json({ message: "Cross-site requests are not allowed" }, 403);
  if (isRateLimited(request, "lifi", PER_MINUTE)) return json({ message: "Rate limit exceeded" }, 429);

  const q = request.nextUrl.searchParams;
  const chain = String(SEPOLIA_CHAIN_ID);
  if (q.get("fromChain") !== chain || q.get("toChain") !== chain) {
    return json({ message: "Only Sepolia same-chain quotes are proxied" }, 400);
  }
  const fromToken = q.get("fromToken") ?? "";
  const toToken = q.get("toToken") ?? "";
  const fromAddress = q.get("fromAddress") ?? "";
  const fromAmount = q.get("fromAmount") ?? "";
  if (![fromToken, toToken, fromAddress].every((a) => ADDRESS.test(a)) || !UINT.test(fromAmount)) {
    return json({ message: "Invalid quote parameters" }, 400);
  }
  const slippage = q.get("slippage");
  if (slippage !== null && !(Number(slippage) > 0 && Number(slippage) <= 0.5)) {
    return json({ message: "Invalid slippage" }, 400);
  }

  const upstream = new URL(LIFI_QUOTE_URL);
  upstream.search = new URLSearchParams({
    fromChain: chain,
    toChain: chain,
    fromToken,
    toToken,
    fromAmount,
    fromAddress,
    ...(slippage !== null ? { slippage } : {}),
  }).toString();
  const integrator = serverKey("LIFI_INTEGRATOR", "NEXT_PUBLIC_LIFI_INTEGRATOR");
  if (integrator) upstream.searchParams.set("integrator", integrator);

  const key = serverKey("LIFI_API_KEY", "NEXT_PUBLIC_LIFI_API_KEY");
  try {
    const response = await fetchUpstream(upstream, {
      headers: { accept: "application/json", ...(key ? { "x-lifi-api-key": key } : {}) },
    });
    return relay(response);
  } catch (error) {
    return upstreamFailure(error, "LI.FI");
  }
}
