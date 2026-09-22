import { createPublicClient, createTransport } from 'viem'
import { sepolia } from 'viem/chains'
import { erc20Abi, factoryAbi, poolAbi, quoterAbi, v2FactoryAbi, v2PairAbi, v4QuoterAbi } from './quoteAbis'
import { ETH_ADDRESS, POOL_FACTORY, POOL_MANAGER, QUOTER_V2, V2_FACTORY, V4_QUOTER } from './quoteConfig'
import { PUBLIC_FALLBACKS } from './rpcEndpoints'

// Next.js inlines NEXT_PUBLIC_* at build time, so these must be written literally
// (no dynamic property access) to be statically replaced.
const envMany = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URLS
const envOne = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL
// A public deployment ships proxy paths (/api/rpc/0, …) instead of keyed URLs, so the keys stay on
// the server (see src/app/api/rpc). Resolve those against the page origin — sharding, failover and
// health tracking all parse these with `new URL`. Outside a browser (SSR, Node scripts) they're
// dropped and the keyed or public endpoints take over.
const absoluteEndpoint = url => {
  if (/^https?:\/\//.test(url)) return url
  if (!url.startsWith('/')) return null
  const origin = globalThis.location?.origin
  return typeof origin === 'string' ? `${origin}${url}` : null
}
const configured = [
  ...(envMany ? envMany.split(',').map(s => s.trim()).filter(Boolean) : []),
  ...(envOne ? [envOne] : []),
].map(absoluteEndpoint).filter(Boolean)
const CONFIGURED_URLS = [...new Set(configured.length ? configured : ['https://ethereum-sepolia-rpc.publicnode.com'])]
const ALL_RPC_URLS = [...new Set([...CONFIGURED_URLS, ...PUBLIC_FALLBACKS])]

// ── RPC AGGREGATOR (batch-sharding across DISTINCT providers) ──────────────────────────────────
// A quote fires hundreds of eth_calls. Putting them all on one RPC throttles it (HTTP 429) → routes
// drop → the quote degrades / "refreshes". Per-call round-robin was tried and is SLOWER (it shatters
// JSON-RPC batching). The fix is to keep batching BUT spread the load: collect the burst, split it
// into shards, and send each shard as its own batched request to a DIFFERENT provider IN PARALLEL.
// Distinct providers (Alchemy / drpc / Infura) have INDEPENDENT rate limits, so no single one is
// overloaded — like a DEX aggregator, but for RPCs. Each shard fails over across the full URL pool,
// and a provider that returns HTTP-200-with-rate-limit-errors (Infura's poison) gets its whole shard
// retried elsewhere. Same-provider keys (the 9 drpc) share one IP limit so they collapse to ONE shard.
// Each configured endpoint is its OWN account with an independent rate limit (verified: 120 parallel
// requests spread across all of them = 0 throttle, so they do NOT share a per-IP limit). So shard
// across EVERY configured endpoint, not one-per-provider — this is the payoff of the multi-account
// setup. Infura is excluded from the shard rotation (slow ~1.4s; it would drag 1/N of every heavy
// scan) but stays in ALL_RPC_URLS as last-resort failover; weak public RPCs are likewise failover-only.
const SHARD_URLS = (() => {
  const shardable = CONFIGURED_URLS.filter(u => !u.includes('infura'))
  return shardable.length ? shardable : CONFIGURED_URLS
})()
const BATCH_WAIT_MS = 16
const SHARD_TIMEOUT_MS = 8_000

// ── Provider health ─────────────────────────────────────────────────────────────────────────────
// Failover used to walk ALL_RPC_URLS in list order on every failed shard. With keys that are dead
// for the month (measured 2026-09-22: 26 of 27 configured Alchemy keys answer 429 "monthly
// capacity exceeded", 401 "must be authenticated", 403 "app inactive"/"IP not on whitelist"), a
// shard whose primary was dead retried ~26 dead endpoints one after another before reaching a live
// one — seconds of pure failover on every heavy scan. A provider that fails at the HTTP level is
// now benched: failover tries healthy endpoints first and shards never start on a benched one.
// Benched endpoints stay in the order as a last resort, so nothing is ever permanently removed.
// In a BROWSER those dead keys don't even surface a status: their 401/403/429 responses carry no
// CORS headers, so fetch() rejects with a bare network error. So every failure counts as a strike,
// and repeated strikes bench for longer (1 → 2 → 4 … minutes, capped) until a request succeeds.
const BENCH_RATE_MS = 60_000            // first strike / 429 / throttle — usually clears within a minute
const BENCH_DEAD_MS = 30 * 60_000       // auth / capacity / inactive — won't clear on its own soon
const DEAD_RE = /capacity|inactive|authenticated|whitelist|forbidden|suspended|disabled|unauthorized|api key/i
const benchedUntil = new Map()          // url -> timestamp
const strikes = new Map()               // url -> consecutive failures

// ── Endpoint latency ────────────────────────────────────────────────────────────────────────────
// A heavy scan's waves wait for their SLOWEST shard, and the configured endpoints differ by 50x:
// measured in the browser 2026-09-22, Alchemy ~50ms per batch vs etherspot ~1.4s and 1rpc ~2.7s —
// a round-robin that handed those two a share of every wave kept an 8s full scan 8s. Each endpoint's
// round-trip is tracked (EWMA of successful POSTs); shards only start on endpoints within
// SLOW_FACTOR of the fastest (with an absolute floor, so a 120ms endpoint isn't dropped next to a
// 40ms one). Slow endpoints stay in the failover order, and every REPROBE_EVERY-th heavy flush
// gives them a shard again so a recovered endpoint earns its way back.
const LATENCY_ALPHA = 0.3
const SLOW_FACTOR = 4
const SLOW_FLOOR_MS = 250
const REPROBE_EVERY = 25
const latencyMs = new Map()             // url -> EWMA ms

let latencyPersistedAt = 0
function recordLatency(url, ms) {
  const prev = latencyMs.get(url)
  latencyMs.set(url, prev === undefined ? ms : prev * (1 - LATENCY_ALPHA) + ms * LATENCY_ALPHA)
  if (Date.now() - latencyPersistedAt > 30_000) {
    latencyPersistedAt = Date.now()
    persistRpcHealth()
  }
}
function fastEndpoints(urls) {
  const known = urls.map(url => latencyMs.get(url)).filter(ms => ms !== undefined)
  if (known.length < 3) return urls
  const best = Math.min(...known)
  const limit = Math.max(best * SLOW_FACTOR, best + SLOW_FLOOR_MS)
  // Unknown endpoints stay in: they need traffic to be measured at all.
  const fast = urls.filter(url => (latencyMs.get(url) ?? 0) <= limit)
  return fast.length ? fast : urls
}
// Fastest known first, unmeasured after them, benched last.
const byLatency = urls => [...urls].sort((a, b) => (latencyMs.get(a) ?? 1e6) - (latencyMs.get(b) ?? 1e6))

// Long benches and measured latencies survive a page reload: without this every reload re-learned
// that 21 endpoints are dead (~1s of failed requests before the first quote) and that two are slow.
// Keyed by a hash so the stored copy doesn't carry the RPC keys in the URLs.
const RPC_HEALTH_STORE_KEY = 'aether_rpc_health_v1'
const RPC_HEALTH_MAX_AGE_MS = 30 * 60_000
const PERSIST_BENCH_MIN_MS = 5 * 60_000
function urlHash(url) {
  let h = 0x811c9dc5
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
function loadRpcHealth(urls) {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RPC_HEALTH_STORE_KEY) ?? 'null')
    if (!stored || Date.now() - stored.at > RPC_HEALTH_MAX_AGE_MS) return
    for (const url of urls) {
      const key = urlHash(url)
      if (stored.b?.[key] > Date.now()) {
        benchedUntil.set(url, stored.b[key])
        strikes.set(url, 1)
      }
      if (stored.l?.[key] !== undefined) latencyMs.set(url, stored.l[key])
    }
  } catch { /* unavailable/corrupt — start fresh */ }
}
let persistTimer = null
function persistRpcHealth() {
  if (persistTimer || !globalThis.localStorage) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      const now = Date.now()
      const b = {}
      for (const [url, until] of benchedUntil) if (until - now >= PERSIST_BENCH_MIN_MS) b[urlHash(url)] = until
      const l = {}
      for (const [url, ms] of latencyMs) l[urlHash(url)] = Math.round(ms)
      globalThis.localStorage.setItem(RPC_HEALTH_STORE_KEY, JSON.stringify({ at: now, b, l }))
    } catch { /* quota/unavailable */ }
  }, 2_000)
  persistTimer.unref?.()
}

function benchUrl(url, ms) {
  const until = Date.now() + ms
  if ((benchedUntil.get(url) ?? 0) < until) benchedUntil.set(url, until)
  if (ms >= PERSIST_BENCH_MIN_MS) persistRpcHealth()
}
function strikeUrl(url, { dead = false } = {}) {
  const count = (strikes.get(url) ?? 0) + 1
  strikes.set(url, count)
  benchUrl(url, dead ? BENCH_DEAD_MS : Math.min(BENCH_RATE_MS * 2 ** (count - 1), BENCH_DEAD_MS))
}
function clearStrikes(url) {
  const hadLongBench = (benchedUntil.get(url) ?? 0) - Date.now() >= PERSIST_BENCH_MIN_MS
  if (strikes.has(url)) strikes.delete(url)
  if (benchedUntil.has(url)) benchedUntil.delete(url)
  if (hadLongBench) persistRpcHealth()
}
const isBenched = url => (benchedUntil.get(url) ?? 0) > Date.now()
const healthyFirst = urls => [...byLatency(urls.filter(u => !isBenched(u))), ...urls.filter(isBenched)]
loadRpcHealth(ALL_RPC_URLS)

// Live view from the browser console: `aetherRpcHealth()` — which endpoints this session is
// currently routing around and why. Keys are masked to the provider and last 4 characters.
// (`npm run rpc:health` is the full probe; this only reflects what real traffic has seen.)
globalThis.aetherRpcHealth = () => ALL_RPC_URLS.map(url => {
  const until = benchedUntil.get(url) ?? 0
  return {
    endpoint: `${new URL(url).host.split('.').slice(-2)[0]} …${url.replace(/\/+$/, '').slice(-4)}`,
    status: until > Date.now() ? 'benched' : 'ok',
    benchedForSec: until > Date.now() ? Math.round((until - Date.now()) / 1000) : 0,
    strikes: strikes.get(url) ?? 0,
    latencyMs: latencyMs.has(url) ? Math.round(latencyMs.get(url)) : null,
  }
})
const MAX_PER_SHARD = 40                                    // flush early so each batch stays modest
const HEAVY_SCAN_THRESHOLD = 100                            // only spread once a scan exceeds this many calls
const RATE_RE = /rate|limit|capacity|exceeded|429|too many|-3200[56]|-32016/i

// ── Per-minute RPC spend log ────────────────────────────────────────────────────────────────────
// One console line per minute while traffic flows: calls and estimated compute units per provider
// for that minute, plus the session total. The units are computed from what we send — providers
// expose no usage API: drpc bills a flat 20 CU per method, Alchemy per method (26 by default),
// Tenderly ~1 TU per call, publicnode is free. Requests that fail outright (timeout, HTTP error)
// are not counted as billed. Read it any time from the browser console: `aetherRpcSpend`.
const ALCHEMY_CU_PER_METHOD = { eth_call: 26, eth_getLogs: 75, eth_blockNumber: 10, eth_chainId: 0 }
const providerOfUrl = url =>
  url.includes('alchemy') ? 'alchemy'
    : url.includes('drpc') ? 'drpc'
      : url.includes('tenderly') ? 'tenderly'
        : url.includes('infura') ? 'infura'
          : url.includes('publicnode') ? 'publicnode'
            : 'other'
function estimateCu(url, method) {
  const provider = providerOfUrl(url)
  if (provider === 'drpc') return 20
  if (provider === 'alchemy') return ALCHEMY_CU_PER_METHOD[method] ?? 26
  if (provider === 'tenderly') return 1
  return 0
}

const rpcSpend = {}   // provider -> { calls, cu, minCalls, minCu }
globalThis.aetherRpcSpend = rpcSpend
let rpcSpendTimer = null

function logRpcSpend() {
  const active = Object.entries(rpcSpend).filter(([, s]) => s.minCalls > 0)
  if (!active.length) return
  const minute = active
    .map(([provider, s]) => `${provider} ${s.minCalls} call ~${Math.round(s.minCu)} CU`)
    .join(' | ')
  const session = Object.entries(rpcSpend)
    .map(([provider, s]) => `${provider} ${s.calls} call ~${Math.round(s.cu)} CU`)
    .join(', ')
  console.log(`[rpc/1mnt] ${minute}  —  sesi: ${session}`)
  for (const [, s] of active) { s.minCalls = 0; s.minCu = 0 }
}

function recordRpcSpend(url, batch, billed) {
  const provider = providerOfUrl(url)
  const s = rpcSpend[provider] ?? (rpcSpend[provider] = { calls: 0, cu: 0, minCalls: 0, minCu: 0 })
  s.calls += batch.length
  s.minCalls += batch.length
  if (billed) {
    const cu = batch.reduce((sum, call) => sum + estimateCu(url, call.method), 0)
    s.cu += cu
    s.minCu += cu
  }
  if (!rpcSpendTimer) {
    rpcSpendTimer = setInterval(logRpcSpend, 60_000)
    rpcSpendTimer.unref?.()  // in Node (debug scripts) do not keep the process alive
  }
}

function shardedTransport() {
  let queue = []
  let timer = null
  let idSeq = 1
  let scanReqs = 0    // calls in the current scan (resets after an idle gap) — the "is this heavy?" signal
  let lastReqAt = 0
  let flushCount = 0

  async function postOne(url, batch) {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), SHARD_TIMEOUT_MS)
    let billed = false
    let res
    const startedAt = Date.now()
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(batch), signal: ctrl.signal })
    } catch (error) {
      // Network / CORS failure / our own timeout — no answer at all from this endpoint.
      strikeUrl(url)
      clearTimeout(to)
      recordRpcSpend(url, batch, false)
      throw error
    }
    try {
      if (!res.ok) {
        // Read the body only to classify: a 429 "monthly capacity exceeded" is as dead as a 401.
        // A 400 is about THIS request, not the endpoint — Alchemy's free tier answers any
        // eth_getLogs wider than 10 blocks with 400 while serving eth_call fine (and fastest of
        // all configured endpoints), so benching on it would throw away healthy capacity.
        const text = await res.text().catch(() => '')
        if (res.status !== 400) strikeUrl(url, { dead: res.status === 401 || res.status === 403 || DEAD_RE.test(text) })
        throw new Error(`HTTP ${res.status}`)
      }
      const json = await res.json()
      billed = true
      clearStrikes(url)
      recordLatency(url, Date.now() - startedAt)
      return Array.isArray(json) ? json : [json]
    } finally {
      clearTimeout(to)
      recordRpcSpend(url, batch, billed)
    }
  }

  // drpc's free tier rejects JSON-RPC batches larger than 3 (HTTP 500 "Batch of more than 3 requests
  // are not allowed on free tier"). Split a batch headed to a drpc endpoint into ≤3-call chunks fired
  // in parallel, so the fastest provider stays in the shard rotation instead of always failing over.
  // Other providers are capped at 8 calls per POST: servers execute a JSON-RPC batch's calls
  // SERIALLY, and one whale-size quoter eth_call takes ~100-500ms of EVM time — a 25-40 call batch
  // therefore stalls 8-15s while parallel small chunks finish in one call's time (measured: drpc's
  // forced 3-chunks consistently beat the mega-batch providers on heavy scans for exactly this reason).
  async function postBatch(url, batch) {
    const limit = url.includes('drpc') ? 3 : 8
    if (batch.length <= limit) return postOne(url, batch)
    const chunks = []
    for (let i = 0; i < batch.length; i += limit) chunks.push(batch.slice(i, i + limit))
    const parts = await Promise.all(chunks.map(c => postOne(url, c)))
    return parts.flat()
  }

  // Per-call failover for calls a provider answers with 200-plus-error because it simply doesn't
  // serve them (drpc free rejects eth_getLogs ranges this way). That's an infra quirk, not an
  // answer — retry just those calls on the other providers instead of dropping them. This is what
  // silently killed V4 event discovery: getLogs windows landed on drpc shards, errored at HTTP
  // 200, and whole fee tiers (e.g. the live zkLTC 90% pool) stayed invisible.
  async function failoverCalls(items, urls) {
    let remaining = items
    for (const url of healthyFirst(urls)) {
      if (!remaining.length) return
      let responses
      const t0 = Date.now()
      try { responses = await postBatch(url, remaining.map(it => it.payload)) } catch (e) {
        if (globalThis.__AETHER_DEBUG) console.log(`[dbg] getLogs-failover FAIL ${new URL(url).host} n=${remaining.length} ${Date.now() - t0}ms: ${e?.message ?? e}`)
        continue
      }
      const byId = new Map(responses.map(r => [r.id, r]))
      const next = []
      for (const it of remaining) {
        const r = byId.get(it.payload.id)
        if (r && !r.error) it.resolve(r.result)
        else next.push(it)
      }
      remaining = next
    }
    for (const it of remaining) it.reject(new Error('eth_getLogs failed on all providers'))
  }

  async function sendShard(primaryUrl, items) {
    const batch = items.map(it => it.payload)
    const order = healthyFirst([primaryUrl, ...ALL_RPC_URLS.filter(u => u !== primaryUrl)])
    let lastErr
    for (const url of order) {
      const shardT0 = Date.now()
      try {
        const responses = await postBatch(url, batch)
        // Treat a provider that 200s with mostly rate-limit errors as a failed shard → fail over.
        const limited = responses.filter(r => r?.error && RATE_RE.test(`${r.error.message ?? ''} ${r.error.code ?? ''}`)).length
        if (limited > batch.length / 2) {
          strikeUrl(url)
          throw new Error('shard rate-limited (200-with-errors)')
        }
        const byId = new Map(responses.map(r => [r.id, r]))
        const getLogsRetries = []
        for (const it of items) {
          const r = byId.get(it.payload.id)
          if (!r) { it.reject(new Error('missing RPC response')); continue }
          if (r.error) {
            if (it.payload.method === 'eth_getLogs') { getLogsRetries.push(it); continue }
            const e = new Error(r.error.message || 'RPC error'); e.code = r.error.code; e.data = r.error.data; it.reject(e)
          }
          else it.resolve(r.result)
        }
        if (getLogsRetries.length) await failoverCalls(getLogsRetries, order.filter(u => u !== url))
        if (globalThis.__AETHER_DEBUG && (Date.now() - shardT0 > 2000 || url !== primaryUrl)) {
          console.log(`[dbg] shard ${new URL(url).host} n=${batch.length} ${Date.now() - shardT0}ms${url !== primaryUrl ? ' (failover)' : ''}`)
        }
        return
      } catch (e) {
        lastErr = e
        if (globalThis.__AETHER_DEBUG) {
          console.log(`[dbg] shard FAIL ${new URL(url).host} n=${batch.length} p=${order.indexOf(url)}/${order.length} prim=${new URL(primaryUrl).host} ${Date.now() - shardT0}ms: ${e?.message ?? e}`)
        }
      }
    }
    for (const it of items) it.reject(lastErr ?? new Error('all RPC providers failed'))
  }

  function flush() {
    const items = queue
    queue = []
    if (timer) { clearTimeout(timer); timer = null }
    if (!items.length) return
    // Spread across providers ONLY when the whole SCAN is heavy (a full/whale scan fires 100s of
    // calls and throttles a single RPC). A light scan (fast preview = ~74 calls total) stays on the
    // ONE primary provider — sharding its small bursts just multiplies HTTP round-trips and slowed it
    // 4x. So gate on cumulative scanReqs (not per-burst size): heavy scans shard, light scans don't.
    const heavy = scanReqs >= HEAVY_SCAN_THRESHOLD
    // Shards start only on healthy endpoints (all of them, if every one is benched), and only on
    // the fast ones among those — except on a periodic re-probe flush (see REPROBE_EVERY).
    const healthyShards = SHARD_URLS.filter(u => !isBenched(u))
    const candidates = healthyShards.length ? healthyShards : SHARD_URLS
    flushCount++
    const shardUrls = byLatency(heavy && flushCount % REPROBE_EVERY === 0 ? candidates : fastEndpoints(candidates))
    // Heavy scan: fan out across endpoints, ~4 calls per shard, up to every shardable endpoint.
    const n = heavy ? Math.min(shardUrls.length, Math.max(1, Math.ceil(items.length / 4))) : 1
    const groups = Array.from({ length: n }, () => [])
    items.forEach((it, i) => groups[i % n].push(it))
    groups.forEach((g, gi) => { if (g.length) sendShard(shardUrls[gi], g) })
  }

  return () => createTransport({
    key: 'rpc-aggregator', name: 'RPC aggregator (sharded)', type: 'sharded', retryCount: 0,
    async request({ method, params }) {
      const now = Date.now()
      if (now - lastReqAt > 300) scanReqs = 0   // 300ms idle = a new scan started
      lastReqAt = now
      scanReqs++
      return new Promise((resolve, reject) => {
        queue.push({ payload: { jsonrpc: '2.0', id: idSeq++, method, params: params ?? [] }, resolve, reject })
        if (queue.length >= SHARD_URLS.length * MAX_PER_SHARD) flush()
        else if (!timer) timer = setTimeout(flush, BATCH_WAIT_MS)
      })
    },
  })
}

// Exported so the local pricing module reads pool state through the same sharded
// transport (and the same RPC accounting) instead of opening its own connection.
export const client = createPublicClient({ chain: sepolia, transport: shardedTransport() })

const MAX_CACHE_ENTRIES = 800
const poolExistsCache = new Map()
const v2PairAddressCache = new Map()
const v3PoolAddressCache = new Map()
const poolMetaCache = new Map()
const v2PairMetaCache = new Map()
const quoteCache = new Map()
const decimalsCache = {}
// Quotes are point-in-time pool snapshots keyed by amount, and Sepolia pools can move 2-3x within
// a session (often from the owner's own swaps). Without an expiry, re-quoting the same amount
// replays the old snapshot for the rest of the session: the UI shows a "live" price that no longer
// exists on-chain, preflight then rejects every route against it ("route skipped"). 20s keeps one
// quote run (fast scan + full scan) cached but never a previous pool state.
const QUOTE_CACHE_TTL_MS = 20_000
// "Doesn't exist" answers expire after this long, so a pool/pair the owner creates MID-SESSION
// becomes visible on the next quote instead of staying invisible until a page reload (the app
// looked "blind to new pools": once a pair was quoted before its LP existed, the zero-address
// answer was cached for the whole session). Positive answers stay cached — a deployed pool
// address never changes.
const NEGATIVE_CACHE_TTL_MS = 60_000

// Quoter gasEstimate ceiling for ONE route. Quotes run through eth_call, which nodes allow up to
// ~50M gas, so a quote "succeeds" through a pool whose swap needs far more gas than any transaction
// may carry. Measured 2026-09-22: a USDC→0xD1→WETH corridor quoted, preflighted and was sent — and
// needed ~24.6M gas, above Sepolia's per-transaction cap of 16,777,216 (EIP-7825, Fusaka). Its
// thin, far-off-market pool walks thousands of ticks. The wallet couldn't even estimate it, fell
// back to 2M, and the swap reverted out of gas. A normal V3/V4 leg costs 100-300k; a route past
// this ceiling is treated as unquotable at that amount (it may still be fine at a smaller one).
export const MAX_ROUTE_GAS = 1_500_000n
export const overRouteGasBudget = gasEstimate =>
  gasEstimate !== undefined && gasEstimate !== null && BigInt(gasEstimate) > MAX_ROUTE_GAS

export function invalidateQuoteCache() {
  quoteCache.clear()
}

// --- V4 pool liveness (pool-keyed, amount-independent) ------------------------------------------
// The any-fee tier expansion made the static V4 candidate ladder big, and the amount-keyed
// quoteCache meant every new amount re-discovered the same non-existent pools via reverting
// eth_calls — the dominant repeat cost of a quote. Liveness is per POOL: one successful quote
// marks it alive for the session (a pool can't be un-created); a revert marks it dead for
// V4_DEAD_POOL_TTL_MS — unless it was ever seen alive, because an alive pool's revert is an
// amount/liquidity signal (e.g. a whale-size quote on a thin pool), not non-existence, and it
// must stay quotable at other amounts. Initialize-event discovery clears a dead mark (the event
// is proof of existence), so an LP created mid-session is re-probed on the next quote — the same
// recovery contract NEGATIVE_CACHE_TTL_MS gives V2/V3.
const V4_DEAD_POOL_TTL_MS = 600_000
// Multi-hop combos revert amount-dependently even on real pools, so a combo is only remembered
// as dead when at least one leg has never proven alive (≈ guessed pool that doesn't exist), and
// for a shorter TTL — long enough to kill the per-quote repeat burn, short enough that a thin
// corridor a smaller trade could use is back quickly.
const V4_DEAD_COMBO_TTL_MS = 180_000
const v4LivenessCache = new Map()  // poolKey -> true (alive, session) | { at } (dead, TTL)
const v4DeadComboCache = new Map() // `${poolKeyA}|${poolKeyB}` -> { at }

const v4LivenessKey = pool =>
  `${pool.currency0.toLowerCase()}-${pool.currency1.toLowerCase()}-${pool.fee}-${pool.tickSpacing}-${(pool.hooks ?? ETH_ADDRESS).toLowerCase()}`

function deadEntryFresh(cache, key, ttlMs) {
  const entry = cache.get(key)
  if (entry === undefined || entry === true) return false
  if (Date.now() - entry.at > ttlMs) {
    cache.delete(key)
    return false
  }
  return true
}

const v4PoolIsDead = pool => deadEntryFresh(v4LivenessCache, v4LivenessKey(pool), V4_DEAD_POOL_TTL_MS)

// Only a CONTRACT revert is evidence of non-existence. A transport failure (429/timeout/HTTP)
// says nothing about the pool — dead-marking on those would hide real pools for the whole TTL
// whenever a provider throttles (the old "deep pool vanishes under throttle" failure, made sticky).
const isRevertError = error =>
  /revert/i.test(`${error?.shortMessage ?? ''} ${error?.message ?? ''}`)

function markV4PoolAlive(pool) {
  v4LivenessCache.set(v4LivenessKey(pool), true)
}

function markV4PoolDead(pool) {
  const key = v4LivenessKey(pool)
  if (v4LivenessCache.get(key) !== true) setLimitedCache(v4LivenessCache, key, { at: Date.now() })
}

// A discovered Initialize event proves the pool exists on-chain — drop any dead mark so the next
// quote probes it fresh (it may have been marked dead before its LP existed).
function clearV4DeadMark(pool) {
  const key = v4LivenessKey(pool)
  if (v4LivenessCache.get(key) !== true) v4LivenessCache.delete(key)
}

export function v4PoolKnownLive(pool) {
  return v4LivenessCache.get(v4LivenessKey(pool)) === true
}

// --- V4 pool discovery via PoolManager Initialize events ---------------------------------------
// V4 has no on-chain getPool(), so guessing poolKeys (fee/tickSpacing/hooks) is the only other
// option and it misses non-standard fee tiers. Initialize events enumerate every pool that was
// ever created for a currency, with EXACT fee/tickSpacing/hooks — no guessing. Cached per
// currency so a hub like ETH is scanned once per session and reused across pairs.
const V4_INITIALIZE_EVENT = {
  type: 'event', name: 'Initialize',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false },
    { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
}
// Generous because discovery competes with the rest of a quote's RPC burst; it's cached per
// currency for the session, so this only costs the first quote of a session, never repeats.
const V4_DISCOVERY_TIMEOUT_MS = 15000
// V4 on Sepolia is recent; this lookback covers its full history while staying small enough that
// public RPCs (which cap getLogs ranges) only need a handful of windows.
const V4_DISCOVERY_LOOKBACK = 1_200_000n
const V4_LOG_WINDOW = 45000n
// Past this age a cache hit still serves instantly but also kicks a background re-scan, so a V4
// pool the owner creates mid-session shows up within a couple of quotes instead of after a reload.
const V4_RESOLVED_REFRESH_MS = 120_000
const v4ResolvedCache = new Map()  // currency -> { pools, at } (background-refreshed when stale)
const v4InflightCache = new Map()  // currency -> in-flight scan promise (shared, dropped on settle)

function withSoftTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallbackValue),
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms)),
  ])
}

export async function getLatestBlockNumber() {
  return client.getBlockNumber().catch(() => 0n)
}

// Generic resilient event fetch, shared by V4 Initialize discovery and the pool-index factory
// scans. Fast path is ONE query over [fromBlock, toBlock] for capable RPCs; providers that cap
// getLogs ranges get parallel windows instead — but only back to `windowFloor` (a full-history
// fromBlock of 0 would mean thousands of windows). Returns { logs, complete } — `complete` is
// false when any window failed, so callers can use the partial result NOW without freezing it
// in a session/persistent cache (a starved scan would otherwise pin a half-discovered pool list).
export async function fetchEventLogs({ address, event, args, fromBlock, toBlock, windowFloor = fromBlock }) {
  if (fromBlock > toBlock) return { logs: [], complete: true }
  try {
    const logs = await client.getLogs({ address, event, args, fromBlock, toBlock })
    return { logs, complete: true }
  } catch {
    const floor = windowFloor > fromBlock ? windowFloor : fromBlock
    const ranges = []
    for (let to = toBlock; to > floor; to -= (V4_LOG_WINDOW + 1n)) {
      const from = to - V4_LOG_WINDOW > floor ? to - V4_LOG_WINDOW : floor
      ranges.push([from, to])
    }
    let failed = 0
    const results = await Promise.all(ranges.map(([from, to]) =>
      client.getLogs({ address, event, args, fromBlock: from, toBlock: to })
        .catch(() => { failed++; return [] })
    ))
    // The windowed fallback only covers back to `windowFloor`: complete relative to that floor.
    return { logs: results.flat(), complete: failed === 0 }
  }
}

async function getInitLogs(filterArgs) {
  const latest = await getLatestBlockNumber()
  if (latest === 0n) return { logs: [], complete: false }
  const floor = latest > V4_DISCOVERY_LOOKBACK ? latest - V4_DISCOVERY_LOOKBACK : 0n
  return fetchEventLogs({ address: POOL_MANAGER, event: V4_INITIALIZE_EVENT, args: filterArgs, fromBlock: floor, toBlock: latest })
}

function fetchV4PoolsForCurrency(key, currency) {
  let scan = v4InflightCache.get(key)
  if (!scan) {
    scan = (async () => {
      // currency0/currency1 are indexed; query both positions to find every pool touching it.
      const [asC0, asC1] = await Promise.all([
        getInitLogs({ currency0: currency }),
        getInitLogs({ currency1: currency }),
      ])
      const pools = []
      const seen = new Set()
      for (const log of [...asC0.logs, ...asC1.logs]) {
        const a = log.args
        // Only no-hook pools: the swap path settles with hookData '0x' and can't drive arbitrary hooks.
        if (!a || a.hooks?.toLowerCase() !== ETH_ADDRESS) continue
        const c0 = a.currency0
        const c1 = a.currency1
        const fee = Number(a.fee)
        const tickSpacing = Number(a.tickSpacing)
        const id = `evt_${c0.toLowerCase()}_${c1.toLowerCase()}_${fee}_${tickSpacing}`
        if (seen.has(id)) continue
        seen.add(id)
        pools.push({ id, currency0: c0, currency1: c1, fee, tickSpacing, hooks: a.hooks, token0IsEth: c0.toLowerCase() === ETH_ADDRESS })
      }
      return { pools, complete: asC0.complete && asC1.complete }
    })()
    // Session-cache from the UNDERLYING scan, not the timeout-raced view: a slow scan still lands
    // for the NEXT quote even when this quote's soft timeout already returned [] (the completed
    // result used to be discarded — a new pool stayed invisible for the whole session). Cache only
    // COMPLETE scans; partial ones are served once and re-scanned next quote.
    scan
      .then(({ pools, complete }) => {
        v4InflightCache.delete(key)
        pools.forEach(clearV4DeadMark)
        if (complete && pools.length) v4ResolvedCache.set(key, { pools, at: Date.now() })
      })
      .catch(() => v4InflightCache.delete(key))
    v4InflightCache.set(key, scan)
  }
  return withSoftTimeout(scan.then(result => result.pools), V4_DISCOVERY_TIMEOUT_MS, [])
}

// Returns executable (no-hook) V4 pools that contain `currency`, in the same shape as V4_POOLS.
// `background: true` (used by the fast scan) returns cached pools instantly and warms the cache
// in the background without blocking — the slow getLogs scan never sits on the fast path. The
// full scan calls it without `background` to await + populate the cache.
export async function discoverV4PoolsForCurrency(currency, { background = false } = {}) {
  const key = currency.toLowerCase()
  // Native ETH (0x0) is currency0 of nearly every V4 pool, so enumerating it returns thousands
  // of logs and times out. It's unnecessary: ETH-paired pools are already covered by the base
  // pool set, and any specific ETH/X pool is found by enumerating X (the non-ETH endpoint).
  if (key === ETH_ADDRESS) return []
  const hit = v4ResolvedCache.get(key)
  if (hit) {
    // Stale-while-revalidate: never block the current quote on a re-scan (the in-flight dedupe
    // in fetchV4PoolsForCurrency keeps concurrent stale hits from double-scanning).
    if (Date.now() - hit.at > V4_RESOLVED_REFRESH_MS) fetchV4PoolsForCurrency(key, currency)
    return hit.pools
  }
  if (background) {
    fetchV4PoolsForCurrency(key, currency)  // fire-and-forget warm; populates cache for next quote
    return []
  }
  return fetchV4PoolsForCurrency(key, currency)
}

function setLimitedCache(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value
    cache.delete(firstKey)
  }
  cache.set(key, value)
  return value
}

function cachePromise(cache, key, factory, negativeTtlMs = 0) {
  const entry = cache.get(key)
  if (entry) {
    const negativeExpired = negativeTtlMs > 0 && entry.negativeAt > 0 &&
      Date.now() - entry.negativeAt > negativeTtlMs
    if (!negativeExpired) return entry.promise
    cache.delete(key)
  }
  const record = { promise: Promise.resolve().then(factory), negativeAt: 0 }
  record.promise
    .then(value => {
      // Zero-address = "doesn't exist YET" — mark it so it expires (see NEGATIVE_CACHE_TTL_MS).
      if (negativeTtlMs > 0 && (!value || value === ETH_ADDRESS)) record.negativeAt = Date.now()
    })
    // Never cache a failure: if the call rejects (429/throttle/timeout), drop the entry so the
    // next quote retries instead of replaying the rejected promise for the rest of the session.
    .catch(() => { if (cache.get(key) === record) cache.delete(key) })
  setLimitedCache(cache, key, record)
  return record.promise
}

function getCachedQuote(key) {
  const entry = quoteCache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > QUOTE_CACHE_TTL_MS) {
    quoteCache.delete(key)
    return undefined
  }
  return entry.value
}

function setCachedQuote(key, value) {
  setLimitedCache(quoteCache, key, { value, at: Date.now() })
  return value
}

function calcSpotPrice(sqrtPriceX96, token0Decimals, token1Decimals) {
  const Q96 = 2n ** 96n
  const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2
  return price * (10 ** token0Decimals) / (10 ** token1Decimals)
}

function encodePath(tokens, fees) {
  let encoded = tokens[0].slice(2).toLowerCase()
  for (let i = 0; i < fees.length; i++) {
    encoded += fees[i].toString(16).padStart(6, '0') + tokens[i + 1].slice(2).toLowerCase()
  }
  return '0x' + encoded
}

function getV2AmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * 997n
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee)
}

export async function getDecimals(address) {
  if (address === ETH_ADDRESS) return 18
  const key = address.toLowerCase()
  if (decimalsCache[key] !== undefined) return decimalsCache[key]
  try {
    const d = await client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })
    decimalsCache[key] = Number(d)
    return Number(d)
  } catch {
    decimalsCache[key] = 18
    return 18
  }
}

// `true` is cached for the session (a pool can't be un-created); `false` expires after
// NEGATIVE_CACHE_TTL_MS so an LP the owner adds mid-session opens its routes on the next quote.
function getExistsCached(key) {
  const entry = poolExistsCache.get(key)
  if (entry === undefined) return undefined
  if (entry === true) return true
  if (Date.now() - entry.at > NEGATIVE_CACHE_TTL_MS) {
    poolExistsCache.delete(key)
    return undefined
  }
  return false
}

function setExistsCached(key, value) {
  setLimitedCache(poolExistsCache, key, value ? true : { at: Date.now() })
  return value
}

export async function poolExists(addrA, addrB, fee) {
  const key = `${addrA.toLowerCase()}-${addrB.toLowerCase()}-${fee}`
  const cached = getExistsCached(key)
  if (cached !== undefined) return cached
  try {
    const addr = await client.readContract({
      address: POOL_FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [addrA, addrB, fee],
    })
    return setExistsCached(key, !!addr && addr !== ETH_ADDRESS)
  } catch {
    return false // RPC failure — do NOT cache, so the next quote retries this pool
  }
}

export async function v2PairExists(addrA, addrB) {
  const key = `v2pair-${addrA.toLowerCase()}-${addrB.toLowerCase()}`
  const cached = getExistsCached(key)
  if (cached !== undefined) return cached
  try {
    const addr = await client.readContract({
      address: V2_FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getPair',
      args: [addrA, addrB],
    })
    return setExistsCached(key, !!addr && addr !== ETH_ADDRESS)
  } catch {
    return false // RPC failure — do NOT cache, so the next quote retries this pair
  }
}

export async function queryV2Pair(addrIn, addrOut, amountRaw, tokenIn, tokenOut) {
  const key = `v2-${addrIn.toLowerCase()}-${addrOut.toLowerCase()}-${amountRaw}`
  const cached = getCachedQuote(key)
  if (cached !== undefined) return cached

  try {
    const pairKey = `${addrIn.toLowerCase()}-${addrOut.toLowerCase()}`
    const pair = await cachePromise(v2PairAddressCache, pairKey, () => client.readContract({
      address: V2_FACTORY,
      abi: v2FactoryAbi,
      functionName: 'getPair',
      args: [addrIn, addrOut],
    }), NEGATIVE_CACHE_TTL_MS)
    if (!pair || pair === ETH_ADDRESS) return setCachedQuote(key, null)

    const [reserves, token0] = await Promise.all([
      client.readContract({ address: pair, abi: v2PairAbi, functionName: 'getReserves' }),
      cachePromise(v2PairMetaCache, pair.toLowerCase(), () =>
        client.readContract({ address: pair, abi: v2PairAbi, functionName: 'token0' })
      ),
    ])

    const reserve0 = Array.isArray(reserves) ? reserves[0] : reserves.reserve0
    const reserve1 = Array.isArray(reserves) ? reserves[1] : reserves.reserve1
    const isToken0In = addrIn.toLowerCase() === token0.toLowerCase()
    const reserveIn = BigInt(isToken0In ? reserve0 : reserve1)
    const reserveOut = BigInt(isToken0In ? reserve1 : reserve0)
    const amountOut = getV2AmountOut(BigInt(amountRaw), reserveIn, reserveOut)
    if (amountOut <= 0n) return setCachedQuote(key, null)

    const amountInNum = Number(amountRaw) / 10 ** tokenIn.decimals
    const amountOutNum = Number(amountOut) / 10 ** tokenOut.decimals
    const reserveInNum = Number(reserveIn) / 10 ** tokenIn.decimals
    const reserveOutNum = Number(reserveOut) / 10 ** tokenOut.decimals
    const spotPrice = reserveInNum === 0 ? 0 : reserveOutNum / reserveInNum
    const quotedPrice = amountInNum === 0 ? 0 : amountOutNum / amountInNum
    const quotedPriceBeforeFee = quotedPrice / 0.997
    const priceImpact = spotPrice === 0 ? 0 : Math.max(0, (spotPrice - quotedPriceBeforeFee) / spotPrice)

    return setCachedQuote(key, {
      pair,
      fee: 3000,
      amountOut,
      amountOutNum,
      priceImpact,
      spotPrice,
      quotedPrice,
    })
  } catch {
    return setCachedQuote(key, null)
  }
}

export async function queryPool(addrIn, addrOut, fee, amountRaw, tokenIn, tokenOut) {
  const key = `v3-${addrIn.toLowerCase()}-${addrOut.toLowerCase()}-${fee}-${amountRaw}`
  const cached = getCachedQuote(key)
  if (cached !== undefined) return cached

  const poolKey = `${addrIn.toLowerCase()}-${addrOut.toLowerCase()}-${fee}`
  const poolAddr = await cachePromise(v3PoolAddressCache, poolKey, () => client.readContract({
    address: POOL_FACTORY,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [addrIn, addrOut, fee],
  }), NEGATIVE_CACHE_TTL_MS)
  if (!poolAddr || poolAddr === ETH_ADDRESS) throw new Error('no pool')

  const [quoteResult, slot0Result, token0Result] = await Promise.all([
    client.simulateContract({
      address: QUOTER_V2,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: addrIn, tokenOut: addrOut, amountIn: BigInt(amountRaw), fee, sqrtPriceLimitX96: 0n }],
    }),
    client.readContract({ address: poolAddr, abi: poolAbi, functionName: 'slot0' }),
    cachePromise(poolMetaCache, poolAddr.toLowerCase(), () =>
      client.readContract({ address: poolAddr, abi: poolAbi, functionName: 'token0' })
    ),
  ])

  const amountOut = quoteResult.result[0]
  const gasEstimate = quoteResult.result[3]
  if (overRouteGasBudget(gasEstimate)) return setCachedQuote(key, null)
  const sqrtPriceX96 = Array.isArray(slot0Result) ? slot0Result[0] : slot0Result.sqrtPriceX96
  const token0 = token0Result.toLowerCase()

  if (token0 !== addrIn.toLowerCase() && token0 !== addrOut.toLowerCase()) {
    throw new Error('wrong pool')
  }

  const isToken0In = addrIn.toLowerCase() === token0
  const spotRaw = calcSpotPrice(sqrtPriceX96, tokenIn.decimals, tokenOut.decimals)
  const spotPrice = isToken0In ? spotRaw : (spotRaw === 0 ? 0 : 1 / spotRaw)
  const amountInNum = Number(amountRaw) / 10 ** tokenIn.decimals
  const amountOutNum = Number(amountOut) / 10 ** tokenOut.decimals
  const quotedPrice = amountInNum === 0 ? 0 : amountOutNum / amountInNum
  const feeFactor = 1 - (fee / 1_000_000)
  const quotedPriceBeforeFee = feeFactor > 0 ? quotedPrice / feeFactor : quotedPrice
  const priceImpact = spotPrice === 0 ? 0 : Math.max(0, (spotPrice - quotedPriceBeforeFee) / spotPrice)

  return setCachedQuote(key, { fee, amountOut, amountOutNum, priceImpact, spotPrice, quotedPrice, gasEstimate })
}

export async function queryTwoHop(addrIn, addrMid, addrOut, fee1, fee2, amountRaw, decimalsOut) {
  const key = `v3hop-${addrIn.toLowerCase()}-${addrMid.toLowerCase()}-${addrOut.toLowerCase()}-${fee1}-${fee2}-${amountRaw}`
  const cached = getCachedQuote(key)
  if (cached !== undefined) return cached
  try {
    const path = encodePath([addrIn, addrMid, addrOut], [fee1, fee2])
    const result = await client.simulateContract({
      address: QUOTER_V2,
      abi: quoterAbi,
      functionName: 'quoteExactInput',
      args: [path, BigInt(amountRaw)],
    })
    const amountOut = result.result[0]
    const gasEstimate = result.result[3]
    if (overRouteGasBudget(gasEstimate)) return setCachedQuote(key, null)
    const amountOutNum = Number(amountOut) / 10 ** decimalsOut
    return setCachedQuote(key, { amountOut, amountOutNum, fee1, fee2, via: addrMid, gasEstimate })
  } catch {
    return setCachedQuote(key, null)
  }
}

export async function queryV4Pool(pool, currencyIn, currencyOut, amountRaw, decimalsOut) {
  const key = `v4-${pool.id}-${currencyIn.toLowerCase()}-${currencyOut.toLowerCase()}-${amountRaw}`
  const cached = getCachedQuote(key)
  if (cached !== undefined) return cached
  if (v4PoolIsDead(pool)) return null
  try {
    const zeroForOne = currencyIn.toLowerCase() === pool.currency0.toLowerCase()
    const result = await client.simulateContract({
      address: V4_QUOTER,
      abi: v4QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{
        poolKey: {
          currency0: pool.currency0,
          currency1: pool.currency1,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          hooks: pool.hooks,
        },
        zeroForOne,
        exactAmount: BigInt(amountRaw),
        hookData: '0x',
      }],
    })

    const amountOut = result.result[0]
    const gasEstimate = result.result[1]
    const amountOutNum = Number(amountOut) / 10 ** decimalsOut
    markV4PoolAlive(pool)
    // Alive, just too expensive at this amount — never a dead mark.
    if (overRouteGasBudget(gasEstimate)) return setCachedQuote(key, null)
    return setCachedQuote(key, { amountOut, amountOutNum, pool, zeroForOne, gasEstimate })
  } catch (error) {
    if (isRevertError(error)) markV4PoolDead(pool)
    return setCachedQuote(key, null)
  }
}

export async function queryV4MultiHop(poolA, poolB, currencyIn, intermediateCurrency, currencyOut, amountRaw, decimalsOut) {
  const key = `v4hop-${poolA.id}-${poolB.id}-${currencyIn.toLowerCase()}-${intermediateCurrency.toLowerCase()}-${currencyOut.toLowerCase()}-${amountRaw}`
  const cached = getCachedQuote(key)
  if (cached !== undefined) return cached
  if (v4PoolIsDead(poolA) || v4PoolIsDead(poolB)) return null
  const comboKey = `${v4LivenessKey(poolA)}|${v4LivenessKey(poolB)}`
  if (deadEntryFresh(v4DeadComboCache, comboKey, V4_DEAD_COMBO_TTL_MS)) return null
  try {
    const result = await client.simulateContract({
      address: V4_QUOTER,
      abi: v4QuoterAbi,
      functionName: 'quoteExactInput',
      args: [{
        currencyIn,
        path: [
          {
            intermediateCurrency,
            fee: poolA.fee,
            tickSpacing: poolA.tickSpacing,
            hooks: poolA.hooks,
            hookData: '0x',
          },
          {
            intermediateCurrency: currencyOut,
            fee: poolB.fee,
            tickSpacing: poolB.tickSpacing,
            hooks: poolB.hooks,
            hookData: '0x',
          },
        ],
        amountIn: BigInt(amountRaw),
      }],
    })

    const amountOut = result.result[0]
    const gasEstimate = result.result[1]
    const amountOutNum = Number(amountOut) / 10 ** decimalsOut
    markV4PoolAlive(poolA)
    markV4PoolAlive(poolB)
    if (overRouteGasBudget(gasEstimate)) return setCachedQuote(key, null)
    return setCachedQuote(key, { amountOut, amountOutNum, poolA, poolB, via: intermediateCurrency, gasEstimate })
  } catch (error) {
    // Can't tell WHICH leg failed, so never dead-mark a pool from here; remember the combo as
    // dead only on a real revert AND when a leg has never proven alive (both alive = a real
    // amount-dependent revert that a different amount may pass).
    if (isRevertError(error) && (!v4PoolKnownLive(poolA) || !v4PoolKnownLive(poolB))) {
      setLimitedCache(v4DeadComboCache, comboKey, { at: Date.now() })
    }
    return setCachedQuote(key, null)
  }
}
