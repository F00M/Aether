import { isCrossSite, isRateLimited, json } from "@/lib/api-proxy";

/**
 * POST /api/rpc/<shard> — server-side proxy for the Sepolia RPC endpoints.
 *
 * On a public deployment the endpoint list cannot be NEXT_PUBLIC_*: Next inlines those into the
 * client bundle, so anyone could read the keys and spend the quota. The browser therefore talks to
 * this route and the keys stay in SEPOLIA_RPC_URLS on the server.
 *
 * The quote engine spreads one burst of calls across several endpoints in parallel (see
 * quoteProviders.js). It keeps doing that here: each `<shard>` maps to its own upstream, so
 * NEXT_PUBLIC_SEPOLIA_RPC_URLS=/api/rpc/0,/api/rpc/1,/api/rpc/2 gives the client three independent
 * lanes without telling it which providers are behind them. A shard whose upstream fails over to
 * the next one in the list.
 */
const PER_MINUTE = 1200;
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 25_000;
const COOLDOWN_MS = 60_000;
const PUBLIC_FALLBACK = "https://ethereum-sepolia-rpc.publicnode.com";

// An endpoint whose key is spent or disabled answers instantly, but it still costs one hop on
// every request. Remembering the failure for a minute keeps it out of the way without pinning it
// as dead — quotas reset and keys get re-enabled.
const cooldown = new Map<string, number>();
function isCoolingDown(url: string): boolean {
  const until = cooldown.get(url);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  cooldown.delete(url);
  return false;
}

// Reads only: the wallet signs and broadcasts its own transactions through its own provider, so
// this proxy never needs to accept eth_sendRawTransaction or anything that spends.
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
  "web3_clientVersion",
]);

function upstreams(): string[] {
  const configured = process.env.SEPOLIA_RPC_URLS || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URLS || "";
  const list = configured
    .split(",")
    .map((url) => url.trim())
    // Relative entries are this proxy's own paths — following them would loop back here.
    .filter((url) => /^https?:\/\//.test(url));
  return list.length ? list : [PUBLIC_FALLBACK];
}

type RpcCall = { method?: unknown; id?: unknown };

function methodsAllowed(payload: unknown): boolean {
  const calls: RpcCall[] = Array.isArray(payload) ? payload : [payload as RpcCall];
  if (!calls.length) return false;
  return calls.every((call) => typeof call?.method === "string" && ALLOWED_METHODS.has(call.method));
}

export async function POST(request: Request, { params }: { params: Promise<{ shard: string }> }) {
  if (isCrossSite(request)) return json({ error: "cross_site" }, 403);
  if (isRateLimited(request, "rpc", PER_MINUTE)) return json({ error: "rate_limited" }, 429);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!methodsAllowed(payload)) return json({ error: "method_not_allowed" }, 403);

  const endpoints = upstreams();
  const { shard } = await params;
  const start = Number.isInteger(Number(shard)) ? Math.abs(Number(shard)) % endpoints.length : 0;

  // This shard's endpoint first, then the rest — one dead provider shouldn't fail the batch. Ones
  // that failed recently go last rather than being dropped, so a request still succeeds when every
  // endpoint is in cooldown. A whole-request budget bounds the walk no matter how long the list is.
  const order = Array.from({ length: endpoints.length }, (_, step) => endpoints[(start + step) % endpoints.length]);
  const queue = [...order.filter((url) => !isCoolingDown(url)), ...order.filter(isCoolingDown)];
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  let lastError: unknown = null;
  for (const url of queue) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(UPSTREAM_TIMEOUT_MS, left)),
      });
      if (!upstream.ok) {
        cooldown.set(url, Date.now() + COOLDOWN_MS);
        lastError = new Error(`upstream ${upstream.status}`);
        continue;
      }
      cooldown.delete(url);
      // Relayed as-is minus upstream headers, so nothing about the provider leaks to the browser.
      return new Response(await upstream.text(), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (error) {
      cooldown.set(url, Date.now() + COOLDOWN_MS);
      lastError = error;
    }
  }
  console.error("[api/rpc] every upstream failed:", lastError);
  return json({ error: "upstream_unavailable" }, 502);
}
