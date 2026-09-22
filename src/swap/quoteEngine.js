import { sepolia } from 'viem/chains'
import { TOKENS } from '../config/tokens'
import {
  API_QUOTE_REFRESH_AGE_MS,
  API_SANITY_MAX_LOCAL_BPS,
  BALANCED_IMPACT_THRESHOLD,
  BALANCED_MAX_ROUTE_SHARE,
  BALANCED_PROBE_SHARE,
  BALANCED_ROUTE_BPS,
  BALANCED_ROUTE_WEIGHT_POWER,
  BRIDGE_ASSIST_PCTS,
  COMPETITIVE_ROUTE_BPS,
  DIRECT_RELIEF_MAX_SHARE_BPS,
  ENABLE_SPLIT_EXECUTION,
  ENABLE_V4_MULTIHOP_ROUTES,
  ETH_ADDRESS,
  FAST_GREEDY_CHUNKS,
  FEE_TIERS,
  GREEDY_TIME_BUDGET_FAST_MS,
  GREEDY_TIME_BUDGET_FULL_MS,
  MARGINAL_SPLIT_CHUNKS,
  MAX_CANDIDATE_ROUTES,
  MAX_EXECUTABLE_SPLIT_ROUTES,
  MAX_EXECUTED_ROUTES,
  MAX_MARGINAL_GREEDY_CHUNKS,
  MAX_MARGINAL_GREEDY_ROUTES,
  MAX_MULTIHOP_POOLS_PER_HOP,
  MIN_BALANCED_OUTPUT_BPS,
  MIN_EXECUTABLE_ROUTE_BPS,
  MIN_V4_ASSIST_GAIN_BPS,
  OPTIMIZED_MAX_ROUTES,
  OPTIMIZED_SPLIT_SHARES,
  POSITION_MANAGER,
  PREFER_V3_SINGLE_ROUTE_EXECUTION,
  UNISWAP_API_ROUTER,
  PROBE_ONLY_MAX_ROUTE_SHARE,
  RELIEF_IMPACT_THRESHOLD,
  ROUTE_WEIGHT_POWER,
  UNIVERSAL_ROUTER,
  USDC_ADDRESS,
  V4_ASSIST_PCTS,
  V4_BALANCED_ROUTE_BPS,
  V4_COMPETITIVE_ROUTE_BPS,
  V4_COMMON_FEE_TIERS,
  V4_DYNAMIC_HUBS,
  V4_POOLS,
  WETH,
  makeV4Pool,
  v4PoolSet,
} from './quoteConfig'
import {
  discoverV4PoolsForCurrency,
  getDecimals,
  poolExists,
  queryPool,
  queryTwoHop,
  queryV2Pair,
  queryV4MultiHop,
  queryV4Pool,
  v2PairExists,
  v4PoolKnownLive,
} from './quoteProviders'
import { getTransitCandidates } from './poolIndex'
import { feedV4PoolsBetween, loadPoolFeed, poolFeedSnapshot } from './poolFeed'
import { bridgeTokens, refreshAutoHubs } from './autoHubs'

export { API_QUOTE_REFRESH_AGE_MS, API_SANITY_MAX_LOCAL_BPS, POSITION_MANAGER, UNISWAP_API_ROUTER, UNIVERSAL_ROUTER } from './quoteConfig'
export { invalidateQuoteCache } from './quoteProviders'

const isQuotedRoute = route =>
  route && typeof route.amountOut === 'bigint' && route.amountOut > 0n

// Screen-picked corridors quoted even when the heavy mixed-bridge search is off (see findSplitRoutes).
const MAX_SCREENED_MIXED_BRIDGES = 2

// scoreOut is a probe-scaled, impact-free estimate. On a thin pool it can dwarf the real
// quote (seen live: a drained V4 pool scored 15.7 ETH while actually paying 0.66 — topping
// the sort and crowding every real route out of the >=70%-of-best eligibility filter). Rank
// by the REAL full-amount quote whenever we have one; the scaled score is only meaningful
// for probe-only routes, where it is all we know.
const routeScoreOut = route => (route.probeOnly ? (route.scoreOut ?? route.amountOut) : route.amountOut)

function scaleQuote(amountOut, fromAmountRaw, toAmountRaw) {
  if (!amountOut || !fromAmountRaw || BigInt(fromAmountRaw) === 0n) return 0n
  return (amountOut * BigInt(toAmountRaw)) / BigInt(fromAmountRaw)
}

export function isEthWethPair(tokenIn, tokenOut) {
  if (!tokenIn || !tokenOut) return false
  const inAddress = tokenIn.address === 'ETH' ? ETH_ADDRESS : tokenIn.address.toLowerCase()
  const outAddress = tokenOut.address === 'ETH' ? ETH_ADDRESS : tokenOut.address.toLowerCase()
  return (
    (inAddress === ETH_ADDRESS && outAddress === WETH.toLowerCase()) ||
    (inAddress === WETH.toLowerCase() && outAddress === ETH_ADDRESS)
  )
}

const routeQualityBps = (route, bestOut) =>
  Number((routeScoreOut(route) * 10000n) / bestOut)

const isV4Route = route => route.type?.startsWith('v4')
const isV2Route = route => route.type?.startsWith('v2')
const isMixedRoute = route => route.type?.startsWith('mixed')

export function routeExecutionKey(route) {
  if (!route) return 'unknown'
  const parts = [
    route.type,
    route.protocol,
    route.poolId,
    route.fee,
    route.fee2,
    route.via?.toLowerCase?.(),
    route.currencyIn?.toLowerCase?.(),
    route.currencyOut?.toLowerCase?.(),
    route.currency0?.toLowerCase?.(),
    route.currency1?.toLowerCase?.(),
    route.currency02?.toLowerCase?.(),
    route.currency12?.toLowerCase?.(),
  ]
  if (route.legs?.length) {
    parts.push(route.legs.map(leg => routeExecutionKey(leg)).join('>'))
  }
  return parts.filter(value => value !== undefined && value !== null && value !== '').join('|')
}

function routeUsesPriorityBridge(route) {
  if (!route.via) return false
  const via = route.via.toLowerCase()
  return bridgeTokens().some(address => address.toLowerCase() === via)
}

function routeUsesPriorityBridgeDeep(route) {
  if (routeUsesPriorityBridge(route)) return true
  return route.legs?.some(leg => routeUsesPriorityBridge(leg)) ?? false
}

function isExecutableSplitRoute(route) {
  if (route.probeOnly) return false
  return (
    route.type === 'direct' ||
    route.type === 'multihop' ||
    route.type === 'v2_direct' ||
    route.type === 'v2_multihop' ||
    route.type === 'v4_direct' ||
    route.type === 'v4_multihop' ||
    isMixedRoute(route)
  )
}

function addressIsPriorityBridge(address, bridgeAddresses = bridgeTokens()) {
  if (!address) return false
  return bridgeAddresses.some(bridge => bridge.toLowerCase() === address.toLowerCase())
}

export function tokenByAddress(address) {
  const normalized = address.toLowerCase()
  return TOKENS.find(token => {
    const tokenAddress = token.address === 'ETH'
      ? ETH_ADDRESS
      : token.address.toLowerCase()
    return tokenAddress === normalized
  })
}

function sameTokenAddress(token, address) {
  const tokenAddress = token.address === 'ETH'
    ? ETH_ADDRESS
    : token.address.toLowerCase()
  return tokenAddress === address.toLowerCase()
}

function getTradeScaleConfig(amountRaw, tokenIn) {
  const amountNum = Number(amountRaw) / 10 ** tokenIn.decimals

  // maxTransitCandidates scales the dynamic-transit breadth with trade size. Measured on
  // USDC→ETH 1000: cap 8 vs 4 was 24s vs 20s (transit breadth is NOT the latency driver — the
  // two-hop quote bursts dominate) while cap 4 dropped a corridor worth +22% output. So stay
  // wide for any real trade; only dust trades trim, where corridors can't pay for themselves.
  if (amountNum >= 1_000_000) {
    return {
      maxExecutedRoutes: 16,
      maxOptimizerRoutes: 16,
      marginalChunks: 120,
      candidateRoutes: 120,
      minRouteShareBps: 50,
      maxTransitCandidates: 8,
    }
  }

  if (amountNum >= 100_000) {
    return {
      maxExecutedRoutes: 12,
      maxOptimizerRoutes: 12,
      marginalChunks: 80,
      candidateRoutes: 100,
      minRouteShareBps: 75,
      maxTransitCandidates: 8,
    }
  }

  if (amountNum >= 10_000) {
    return {
      maxExecutedRoutes: 8,
      maxOptimizerRoutes: 8,
      marginalChunks: 50,
      candidateRoutes: 80,
      minRouteShareBps: 100,
      maxTransitCandidates: 8,
    }
  }

  if (amountNum >= 1_000) {
    return {
      maxExecutedRoutes: 5,
      maxOptimizerRoutes: 5,
      marginalChunks: 30,
      candidateRoutes: 60,
      minRouteShareBps: 150,
      maxTransitCandidates: 8,
    }
  }

  return {
    maxExecutedRoutes: 3,
    maxOptimizerRoutes: 3,
    marginalChunks: 20,
    candidateRoutes: 40,
    minRouteShareBps: 200,
    maxTransitCandidates: 6,
  }
}

// The app's own server-side proxy (src/app/api/uniswap/[endpoint]) holds the API key and the
// fixed Trading API headers. A deployment without a key answers 503 `not_configured`, after which
// the API reference path stays off for the session instead of asking on every quote.
const UNISWAP_API_URL = '/api/uniswap/quote'
const UNISWAP_SWAP_URL = '/api/uniswap/swap'
let uniswapApiNotConfigured = false

export function resolveAddress(token) {
  if (token.address === 'ETH') return WETH
  return token.address
}

// Resolve the V4 currency for a token (V4 uses native ETH 0x000, not WETH).
export function resolveCurrency(token) {
  if (token.address === 'ETH') return ETH_ADDRESS
  return token.address
}

function resolveApiToken(token) {
  return token.address === 'ETH' ? ETH_ADDRESS : token.address
}

const UNISWAP_API_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
}

export async function fetchUniswapApiQuote({ tokenIn, tokenOut, amountRaw, slippage, swapper }) {
  if (uniswapApiNotConfigured || !swapper || typeof window === 'undefined') return null

  try {
    const response = await fetch(UNISWAP_API_URL, {
      method: 'POST',
      headers: UNISWAP_API_HEADERS,
      body: JSON.stringify({
        type: 'EXACT_INPUT',
        tokenInChainId: sepolia.id,
        tokenOutChainId: sepolia.id,
        tokenIn: resolveApiToken(tokenIn),
        tokenOut: resolveApiToken(tokenOut),
        amount: amountRaw,
        swapper,
        generatePermitAsTransaction: false,
        slippageTolerance: Number.parseFloat(slippage || '0.5'),
        routingPreference: 'BEST_PRICE',
        // MUST include V2: with only ['V3','V4'] the trade-api answers a weaker question — no
        // multi-route splits at all. Measured same-instant on 163k MUSD→USDC (2026-07-09):
        // ['V3','V4'] = 69,728 (single V4 0.01% pool) vs ['V2','V3','V4'] = 84,573 (95/5 split
        // through bridge corridors, +21%, matching the official Uniswap UI exactly).
        protocols: ['V2', 'V3', 'V4'],
        hooksOptions: 'V4_HOOKS_INCLUSIVE',
        spreadOptimization: 'EXECUTION',
        urgency: 'normal',
      }),
    })

    if (response.status === 503) {
      const body = await response.json().catch(() => null)
      if (body?.error === 'not_configured') {
        uniswapApiNotConfigured = true
        return null
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `Uniswap API quote failed (${response.status})`)
    }

    const data = await response.json()
    const outputAmount = data?.quote?.output?.amount
    if (!outputAmount) return null

    const amountOutNum = Number(outputAmount) / 10 ** tokenOut.decimals
    return {
      requestId: data.requestId,
      routing: data.routing,
      amountOut: outputAmount,
      amountOutFormatted: amountOutNum.toFixed(6),
      priceImpactPct: data.quote.priceImpact != null ? Number(data.quote.priceImpact).toFixed(2) : null,
      route: data.quote.route ?? [],
      routeString: data.quote.routeString,
      gasUseEstimate: data.quote.gasUseEstimate,
      blockNumber: data.quote.blockNumber,
      // Full /quote response + fetch time: `raw` is what the /swap endpoint needs to build
      // executable calldata (the winner-takes-execution path), `at` is what the same-instant
      // freshness check compares against.
      raw: data,
      at: Date.now(),
    }
  } catch (error) {
    console.warn('Uniswap API quote unavailable:', error)
    return null
  }
}

// Turns a /quote response into ready-to-send calldata via the Trading API's own /swap endpoint —
// the execution path when the API's routing beats ours (honest best price: whichever side quotes
// higher is the one that executes). Approvals for this path are the same Permit2 → Universal
// Router flow the app already uses for its non-Aether swaps (x-permit2-disabled: no signature).
export async function fetchUniswapApiSwap(apiRaw) {
  const response = await fetch(UNISWAP_SWAP_URL, {
    method: 'POST',
    headers: UNISWAP_API_HEADERS,
    body: JSON.stringify({ quote: apiRaw.quote, simulateTransaction: false }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Uniswap API swap failed (${response.status})`)
  }
  const data = await response.json()
  const swap = data?.swap
  if (!swap?.to || !swap?.data) throw new Error('Uniswap API swap returned no calldata')
  // Never send funds to an arbitrary target from an external response. The API answers with one
  // of TWO known deployments on Sepolia: its own thin forwarder (UNISWAP_API_ROUTER, ~1KB, pulls
  // tokens with a plain transferFrom) or the standard Universal Router (pulls via Permit2). Which
  // one arrives varies per route, so both are allowed — and the approve flow grants what each
  // needs. Anything outside this allowlist is still refused.
  const allowedTargets = [UNISWAP_API_ROUTER, UNIVERSAL_ROUTER]
  if (!allowedTargets.some(target => target.toLowerCase() === swap.to.toLowerCase())) {
    throw new Error(`Uniswap API swap targets unexpected router ${swap.to}`)
  }
  return { to: swap.to, data: swap.data, value: BigInt(swap.value ?? 0) }
}

function tokenForAddress(address) {
  const token = tokenByAddress(address)
  if (token) return token
  return {
    symbol: `${address.slice(0, 6)}...`,
    address,
    decimals: 18,
  }
}

function v4CurrenciesForToken(token) {
  if (token.address === 'ETH') {
    return [
      { currency: ETH_ADDRESS, unwrapWethInput: false, unwrapWethOutput: false, wrapEthInput: false },
      { currency: WETH, unwrapWethInput: false, unwrapWethOutput: true, wrapEthInput: true },
    ]
  }
  if (token.address.toLowerCase() === WETH.toLowerCase()) {
    return [
      { currency: WETH, unwrapWethInput: false, wrapEthOutput: false, unwrapWethOutput: false },
      { currency: ETH_ADDRESS, unwrapWethInput: true, wrapEthOutput: true, unwrapWethOutput: false },
    ]
  }
  return [{ currency: token.address, unwrapWethInput: false, wrapEthOutput: false, unwrapWethOutput: false }]
}

async function quoteDirectV3Leg(tokenIn, tokenOut, amountRaw) {
  const addrIn = resolveAddress(tokenIn)
  const addrOut = resolveAddress(tokenOut)
  const results = await Promise.allSettled(
    FEE_TIERS.map(async fee => {
      const quote = await queryPool(addrIn, addrOut, fee, amountRaw, tokenIn, tokenOut)
      if (!quote) return null
      return {
        protocol: 'v3',
        type: 'direct',
        hops: 1,
        fee,
        amountIn: amountRaw,
        amountOut: quote.amountOut,
        amountOutNum: quote.amountOutNum,
        priceImpact: quote.priceImpact ?? 0,
      }
    })
  )

  return results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(isQuotedRoute)
}

async function quoteDirectV2Leg(tokenIn, tokenOut, amountRaw) {
  const addrIn = resolveAddress(tokenIn)
  const addrOut = resolveAddress(tokenOut)
  const quote = await queryV2Pair(addrIn, addrOut, amountRaw, tokenIn, tokenOut)
  if (!quote) return []
  return [{
    protocol: 'v2',
    type: 'v2_direct',
    hops: 1,
    fee: 3000,
    pair: quote.pair,
    amountIn: amountRaw,
    amountOut: quote.amountOut,
    amountOutNum: quote.amountOutNum,
    priceImpact: quote.priceImpact ?? 0,
    label: 'V2 0.3%',
  }]
}

async function quoteDirectV4Leg(tokenIn, tokenOut, amountRaw) {
  const candidates = []
  const inputCurrencies = v4CurrenciesForToken(tokenIn)
  const outputCurrencies = v4CurrenciesForToken(tokenOut)

  await Promise.all(inputCurrencies.flatMap(input =>
    outputCurrencies.map(async output => {
      if (input.currency.toLowerCase() === output.currency.toLowerCase()) return

      // The curated/guessed set only knows standard-ish fee tiers; the pool feed knows every pool
      // actually initialized for this pair (e.g. ETH/zkLTC at 86%). Registered so the optimizer
      // can re-quote a mixed route's V4 leg by poolId.
      const legPools = withFeedV4Pools(poolFeedSnapshot()?.toBlock ? [] : V4_POOLS, [[input.currency, output.currency]])
      await Promise.all(legPools.map(async pool => {
        const hasIn = poolHasCurrency(pool, input.currency)
        const hasOut = poolHasCurrency(pool, output.currency)
        if (!hasIn || !hasOut) return

        const quote = await queryV4Pool(pool, input.currency, output.currency, amountRaw, tokenOut.decimals)
        if (!quote?.amountOut) return
        candidates.push({
          protocol: 'v4',
          type: 'v4_direct',
          hops: 1,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          hooks: pool.hooks,
          currency0: pool.currency0,
          currency1: pool.currency1,
          currencyIn: input.currency,
          currencyOut: output.currency,
          unwrapWethInput: input.unwrapWethInput,
          wrapEthOutput: output.wrapEthOutput,
          wrapEthInput: input.wrapEthInput,
          unwrapWethOutput: output.unwrapWethOutput,
          zeroForOne: quote.zeroForOne,
          amountIn: amountRaw,
          amountOut: quote.amountOut,
          amountOutNum: quote.amountOutNum,
          priceImpact: 0,
          poolId: pool.id,
        })
      }))
    })
  ))

  return candidates
}

async function findMixedBridgeRoutes(tokenIn, tokenOut, amountRaw, probeAmountRaw = amountRaw, bridgeAddresses = bridgeTokens()) {
  const bridgeTokenList = await Promise.all(bridgeAddresses
    .filter(address => !sameTokenAddress(tokenIn, address) && !sameTokenAddress(tokenOut, address))
    .map(async address => {
      const known = tokenByAddress(address)
      if (known) return known
      // Unlisted transit token (graph-discovered): fetch real decimals — tokenForAddress's
      // 18-default would mis-scale display/impact math for e.g. a 6-decimal bridge.
      return { symbol: `${address.slice(0, 6)}…`, address, decimals: await getDecimals(address) }
    }))

  // One direct leg across all three protocols. The protocols, the bridges, and each first leg's
  // second-leg quotes are all independent of each other — they used to be awaited one after
  // another (~30 sequential RPC round trips per bridge; measured 4.6s of a 8.8s full scan on
  // 0.01 ETH→USDC). Same quotes, fired concurrently.
  const directLeg = async (from, to, amount) => (await Promise.all([
    quoteDirectV3Leg(from, to, amount),
    quoteDirectV2Leg(from, to, amount),
    quoteDirectV4Leg(from, to, amount),
  ])).flat()

  const perBridge = await Promise.all(bridgeTokenList.map(async bridgeToken => {
    const shouldQuoteFull = probeAmountRaw === amountRaw
    const firstLegs = shouldQuoteFull
      ? (await directLeg(tokenIn, bridgeToken, amountRaw)).map(leg => ({ ...leg, scoreOut: leg.amountOut }))
      : (await directLeg(tokenIn, bridgeToken, probeAmountRaw)).map(leg => ({
        ...leg,
        scoreOut: scaleQuote(leg.amountOut, probeAmountRaw, amountRaw),
        probeOnly: true,
      }))

    const bestFirstLegs = firstLegs
      .sort((a, b) => Number(routeScoreOut(b) - routeScoreOut(a)))
      .slice(0, 8)

    const routes = await Promise.all(bestFirstLegs.map(async firstLeg => {
      const secondLegs = await directLeg(bridgeToken, tokenOut, firstLeg.amountOut.toString())
      return secondLegs.map(secondLeg => {
        const probeOnly = !!firstLeg.probeOnly
        const amountOut = probeOnly
          ? scaleQuote(secondLeg.amountOut, probeAmountRaw, amountRaw)
          : secondLeg.amountOut
        const protocolLabel = firstLeg.protocol === secondLeg.protocol
          ? firstLeg.protocol.toUpperCase()
          : `${firstLeg.protocol.toUpperCase()} -> ${secondLeg.protocol.toUpperCase()}`
        return {
          type: `mixed_${firstLeg.protocol}_${secondLeg.protocol}`,
          hops: 2,
          via: bridgeToken.address,
          fee: firstLeg.fee,
          fee2: secondLeg.fee,
          amountIn: amountRaw,
          amountOut,
          amountOutNum: Number(amountOut) / 10 ** tokenOut.decimals,
          scoreOut: amountOut,
          probeOnly,
          priceImpact: 0,
          label: `Bridge ${protocolLabel}`,
          legs: [
            firstLeg,
            {
              ...secondLeg,
              amountIn: firstLeg.amountOut.toString(),
            },
          ],
        }
      })
    }))
    return routes.flat()
  }))

  return perBridge.flat()
}

function poolHasCurrency(pool, currency) {
  const c = currency.toLowerCase()
  return pool.currency0.toLowerCase() === c || pool.currency1.toLowerCase() === c
}

function otherPoolCurrency(pool, currency) {
  const c = currency.toLowerCase()
  if (pool.currency0.toLowerCase() === c) return pool.currency1
  if (pool.currency1.toLowerCase() === c) return pool.currency0
  return null
}

// Standard V4 fee tiers (the real, usually-deep pools) — prioritized when capping multi-hop pools.
// Standard (non-exotic) tiers only: the hop-cap ranking uses this to keep the usually-deep
// standard pools ahead of exotic-fee guesses. Including the exotic tiers here (as it briefly
// did after the any-fee expansion) made hopRank a no-op.
const V4_STANDARD_FEES = new Set(V4_COMMON_FEE_TIERS.filter(tier => !tier.exotic).map(tier => tier.fee))

// Hub currencies (ETH/WETH/USDC — V4_DYNAMIC_HUBS + WETH). When BOTH endpoints are hubs, their direct pools are
// the deepest in the market and bridging can't beat them — so skip the (expensive, ~hundreds of
// calls) multi-hop search for hub↔hub pairs. That keeps the RPC burst small enough that the cheap-
// but-critical direct V2/V3/V4 quotes don't get rate-limited/dropped (the bug where the best direct
// route, e.g. V3 1%, vanished from the candidate set for USDC→ETH and we lost to Uniswap).
const V4_HUB_SET = new Set([...V4_DYNAMIC_HUBS, WETH].map(addr => addr.toLowerCase()))
function isHubToken(token) {
  const addr = token.address === 'ETH' ? ETH_ADDRESS : token.address.toLowerCase()
  return V4_HUB_SET.has(addr)
}

function v4PoolKey(pool) {
  return `${pool.currency0.toLowerCase()}-${pool.currency1.toLowerCase()}-${pool.fee}-${pool.tickSpacing}-${pool.hooks.toLowerCase()}`
}

// All V4 pools by id — seeded with the static set, augmented with event-discovered pools (id
// `evt_…`). Re-quoting during optimization (greedy/split/assist) looks pools up by id, but
// discovered pools live ONLY here, not in `V4_POOLS`. Without this, a route through a discovered
// pool can't be re-quoted → the optimizer gets null → greedy dies → the swap collapses to a single
// pool instead of splitting (the bug behind "100% one V4 2% pool, losing to Uniswap").
const v4PoolRegistry = new Map(V4_POOLS.map(pool => [pool.id, pool]))
function registerV4Pools(pools) { for (const pool of pools) v4PoolRegistry.set(pool.id, pool) }
function findV4Pool(id) { return v4PoolRegistry.get(id) }

// `basePools` plus every feed pool between each [currencyA, currencyB] pair, deduped by pool key
// and registered for re-quoting. The feed is read synchronously (findSplitRoutes warms it), so a
// cold feed simply adds nothing and the curated set works exactly as before.
function withFeedV4Pools(basePools, currencyPairs, { include } = {}) {
  const feed = poolFeedSnapshot()
  if (!feed) return basePools
  const seen = new Set(basePools.map(v4PoolKey))
  const added = []
  for (const [a, b] of currencyPairs) {
    for (const pool of feedV4PoolsBetween(feed, a, b)) {
      if (include && !include(pool)) continue
      const key = v4PoolKey(pool)
      if (seen.has(key)) continue
      seen.add(key)
      added.push(pool)
    }
  }
  if (!added.length) return basePools
  registerV4Pools(added)
  return [...basePools, ...added]
}

// For tokens that aren't in the predefined V4 pool set (e.g. a pasted contract address), build
// candidate pools pairing each endpoint with the hub currencies (and with each other) across the
// common fee tiers. Pools that don't actually exist are filtered out by the quoter (queryV4Pool
// returns null on revert), so this only adds reachable routes and never fabricates liquidity.
function dynamicV4PoolsFor(tokenIn, tokenOut, existingPools) {
  const endpoints = [tokenIn, tokenOut].map(token =>
    token.address === 'ETH' ? ETH_ADDRESS : token.address
  )
  const pairs = []
  for (const endpoint of endpoints) {
    for (const hub of V4_DYNAMIC_HUBS) pairs.push([endpoint, hub])
  }
  pairs.push([endpoints[0], endpoints[1]])

  const seen = new Set(existingPools.map(v4PoolKey))
  const dynamicPools = []
  for (const [a, b] of pairs) {
    if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue
    for (const feeTier of V4_COMMON_FEE_TIERS) {
      const pool = makeV4Pool(a, b, feeTier)
      if (!pool) continue
      const key = v4PoolKey(pool)
      if (seen.has(key)) continue
      seen.add(key)
      dynamicPools.push(pool)
    }
  }
  return dynamicPools
}

async function findV4Routes(tokenIn, tokenOut, amountRaw, probeAmountRaw = amountRaw, options = {}) {
  const bothHubs = isHubToken(tokenIn) && isHubToken(tokenOut)
  // A hub↔hub pair only has a DOMINANT direct pool when one side is ETH/WETH (the deep universal
  // counterparty). For non-ETH hub pairs (USDC↔MUSD, USDC↔TBTC, MUSD↔TBTC) the direct pool is
  // shallow and routing through ETH wins — Uniswap routes 75% of USDC→MUSD via USDC→ETH 2% → MUSD,
  // so those must NOT be treated as direct-dominant and must keep the V4 multi-hop search.
  const tokenIsEthOrWeth = token => {
    const a = token.address === 'ETH' ? ETH_ADDRESS : token.address.toLowerCase()
    return a === ETH_ADDRESS || a === WETH.toLowerCase()
  }
  const directHubPair = bothHubs && (tokenIsEthOrWeth(tokenIn) || tokenIsEthOrWeth(tokenOut))
  // Dynamic transit set from findSplitRoutes when available; the auto-detected hubs otherwise.
  const bridgeAddresses = options.bridgeAddresses ?? [ETH_ADDRESS, ...bridgeTokens()]

  // Pool feed pairs: the endpoints with each other (any fee — Sepolia's ETH/USDC alone has 35
  // no-hook pools across 32 fee tiers, most of which no guess list contains), and each endpoint
  // with every bridge and anchor, for the multi-hop legs.
  const endpointCurrencies = currenciesFor => currenciesFor.map(c => c.currency)
  const inCurrencies = endpointCurrencies(v4CurrenciesForToken(tokenIn))
  const outCurrencies = endpointCurrencies(v4CurrenciesForToken(tokenOut))
  const hopCurrencies = [...new Set([...bridgeAddresses, ETH_ADDRESS, WETH, USDC_ADDRESS].map(addr => addr.toLowerCase()))]
  const feedPairs = [
    ...inCurrencies.flatMap(a => outCurrencies.map(b => [a, b])),
    ...[...inCurrencies, ...outCurrencies].flatMap(a => hopCurrencies.map(b => [a, b])),
  ]

  let pools
  let poolSource
  if (poolFeedSnapshot()?.toBlock) {
    // The feed holds V4's COMPLETE history, so it is the pool list: quote exactly the pools that
    // were initialized. No guessed poolKeys (the static ladder was ~600 guesses, most of which
    // don't exist and cost a reverting eth_call each) and no per-currency getLogs discovery. The
    // fast scan keeps to standard fee tiers plus any pool already proven alive this session.
    pools = withFeedV4Pools([], feedPairs, {
      include: options.fast ? pool => V4_STANDARD_FEES.has(pool.fee) || v4PoolKnownLive(pool) : undefined,
    })
    poolSource = 'feed'
  } else {
    // Cold start (feed not built yet): the guess ladder + event discovery, as before.
    // Fast scan skips exotic-tier GUESSES that never proved alive — its job is a quick first
    // price from the pools that usually hold liquidity.
    const basePools = options.fast
      ? v4PoolSet().filter(pool => !pool.exotic || v4PoolKnownLive(pool))
      : v4PoolSet()
    // Event-log discovery (getLogs) is the slowest, heaviest step. Fast scan uses it in
    // BACKGROUND mode (cached/non-blocking); hub↔hub pairs skip it (the base pools cover their
    // standard tiers, and the getLogs burst would drown the critical direct quotes).
    let discoveredPools = []
    if (!bothHubs) {
      const endpoints = [...new Set([
        tokenIn.address === 'ETH' ? ETH_ADDRESS : tokenIn.address.toLowerCase(),
        tokenOut.address === 'ETH' ? ETH_ADDRESS : tokenOut.address.toLowerCase(),
      ])]
      try {
        const lists = await Promise.all(endpoints.map(currency =>
          discoverV4PoolsForCurrency(currency, { background: options.fast })
        ))
        discoveredPools = lists.flat()
      } catch { /* degrade to base + guessed */ }
    }
    const seenPoolKeys = new Set()
    const guessedAndDiscovered = []
    for (const pool of [...basePools, ...dynamicV4PoolsFor(tokenIn, tokenOut, basePools), ...discoveredPools]) {
      const poolKey = v4PoolKey(pool)
      if (seenPoolKeys.has(poolKey)) continue
      seenPoolKeys.add(poolKey)
      guessedAndDiscovered.push(pool)
    }
    pools = withFeedV4Pools(guessedAndDiscovered, feedPairs, {
      include: options.fast ? v4PoolKnownLive : undefined,
    })
    poolSource = 'guess+discovery'
  }
  // Make every pool (incl. event-discovered `evt_…`) findable by id for later re-quoting.
  registerV4Pools(pools)
  if (globalThis.__AETHER_DEBUG) {
    console.log('[dbg] v4 pools:', poolSource, '| total unique', pools.length)
  }
  const inputCurrencies = tokenIn.address.toLowerCase() === WETH.toLowerCase()
    ? [
      { currency: WETH, unwrapWethInput: false },
      { currency: ETH_ADDRESS, unwrapWethInput: true },
    ]
    : tokenIn.address === 'ETH'
      ? [
        { currency: ETH_ADDRESS, unwrapWethInput: false, wrapEthInput: false },
        { currency: WETH, unwrapWethInput: false, wrapEthInput: true },
      ]
      : [{ currency: tokenIn.address, unwrapWethInput: false }]
  const outputCurrencies = tokenOut.address.toLowerCase() === WETH.toLowerCase()
    ? [
      { currency: WETH, wrapEthOutput: false },
      { currency: ETH_ADDRESS, wrapEthOutput: true },
    ]
    : tokenOut.address === 'ETH'
      ? [
        { currency: ETH_ADDRESS, wrapEthOutput: false, unwrapWethOutput: false },
        { currency: WETH, wrapEthOutput: false, unwrapWethOutput: true },
      ]
      : [{ currency: tokenOut.address, wrapEthOutput: false }]

  const v4Routes = []

  await Promise.all(pools.map(async pool => {
    await Promise.all(inputCurrencies.flatMap(input =>
      outputCurrencies.map(async output => {
        const currencyIn = input.currency
        const currencyOut = output.currency
        if (currencyIn.toLowerCase() === currencyOut.toLowerCase()) return

        const poolTokens = [pool.currency0.toLowerCase(), pool.currency1.toLowerCase()]
        const hasIn  = poolTokens.includes(currencyIn.toLowerCase())
        const hasOut = poolTokens.includes(currencyOut.toLowerCase())
        if (!hasIn || !hasOut) return

        const [fullQuote, probeQuote] = await Promise.all([
          queryV4Pool(pool, currencyIn, currencyOut, amountRaw, tokenOut.decimals),
          probeAmountRaw === amountRaw
            ? Promise.resolve(null)
            : queryV4Pool(pool, currencyIn, currencyOut, probeAmountRaw, tokenOut.decimals),
        ])
        const result = fullQuote ?? probeQuote
        if (!result || result.amountOut === 0n) return

        const scoreOut = probeQuote
          ? scaleQuote(probeQuote.amountOut, probeAmountRaw, amountRaw)
          : result.amountOut
        const amountOut = fullQuote ? result.amountOut : scoreOut

        const bridgeLabel = input.unwrapWethInput || output.wrapEthOutput ? ' via ETH' : ''
        v4Routes.push({
          type: 'v4_direct',
          hops: 1,
          fee: pool.fee,
          tickSpacing: pool.tickSpacing,
          hooks: pool.hooks,
          currency0: pool.currency0,
          currency1: pool.currency1,
          currencyIn,
          currencyOut,
          unwrapWethInput: input.unwrapWethInput,
          wrapEthInput: input.wrapEthInput,
          wrapEthOutput: output.wrapEthOutput,
          unwrapWethOutput: output.unwrapWethOutput,
          zeroForOne: result.zeroForOne,
          amountOut,
          amountOutNum: result.amountOutNum,
          probeAmountOut: probeQuote?.amountOut,
          scoreOut,
          probeOnly: !fullQuote && !!probeQuote,
          priceImpact: 0,
          label: `V4 ${pool.fee / 10000}%${bridgeLabel}`,
          poolId: pool.id,
        })
      })
    ))
  }))

  // V4 multi-hop is combinatorial (firstHopPools × secondHopPools) — the single biggest source of
  // RPC calls. Skip it on the fast scan, and skip it only for DIRECT hub pairs (one side ETH/WETH,
  // e.g. USDC→ETH) whose deep direct pool dominates so bridging can't beat it. Non-ETH hub pairs
  // (USDC↔MUSD/TBTC) and exotic pairs DO need the multi-hop search — their direct pool is shallow
  // and routing through ETH wins (we were losing ~16% on USDC→MUSD by skipping it as "bothHubs").
  // NOTE: enabling it for directHubPair was tried for ETH→USDC but didn't help — queryV4MultiHop
  // under-quotes the ETH→MUSD→USDC path (180k vs the 322k chained single-pool quotes prove). The
  // real fix is in findMixedBridgeRoutes (produce the chained V4→V4 combo) or the V4 multi-hop quoter.
  if (ENABLE_V4_MULTIHOP_ROUTES && !options.fast && !directHubPair) {
    await Promise.all(inputCurrencies.flatMap(input =>
      outputCurrencies.map(async output => {
        const currencyIn = input.currency
        const currencyOut = output.currency
        if (currencyIn.toLowerCase() === currencyOut.toLowerCase()) return

        const routePromises = []
        // Each combo is FULL-quoted now, so cap pools per hop to bound the combo count. Order by
        // STANDARD fee tiers first (the real, usually-deep pools), then remaining by fee — a plain
        // fee-ascending cap wrongly drops a deep standard pool (e.g. USDC/ETH 1%) when many thin
        // exotic-fee discovered pools (0.15%, 0.43%…) crowd the low end.
        const hopRank = fee => (V4_STANDARD_FEES.has(fee) ? 0 : 1)
        // Rank by the pool's bridge currency priority (ETH = 0, the deepest hub, first) so the cap
        // keeps ALL fee tiers of the primary bridge — including the deep HIGH-fee ones (the USDC/ETH
        // 2% pool). Pure fee-ascending sorted that 2% pool last, so the cap dropped it and the
        // winning USDC→ETH 2% → ETH→UNI combo (which Uniswap uses) was never built → we lost ~7%.
        const bridgeRank = addr => {
          const i = bridgeAddresses.findIndex(b => b.toLowerCase() === (addr || '').toLowerCase())
          return i === -1 ? 99 : i
        }
        const firstHopPools = pools
          .map(pool => ({ pool, intermediateCurrency: otherPoolCurrency(pool, currencyIn) }))
          .filter(({ intermediateCurrency }) =>
            intermediateCurrency &&
            intermediateCurrency.toLowerCase() !== currencyOut.toLowerCase() &&
            addressIsPriorityBridge(intermediateCurrency, bridgeAddresses)
          )
          .sort((a, b) =>
            bridgeRank(a.intermediateCurrency) - bridgeRank(b.intermediateCurrency) ||
            hopRank(a.pool.fee) - hopRank(b.pool.fee) || a.pool.fee - b.pool.fee)
          .slice(0, MAX_MULTIHOP_POOLS_PER_HOP)
        // The second hop is INTERMEDIATE→currencyOut, so the pool must pair currencyOut with a
        // bridge currency (ETH/MUSD/TBTC) — mirror firstHopPools' bridge filter. Filtering to
        // bridge-paired pools BEFORE the cap is what lets the deep ETH/TOKEN pools survive: without
        // it the 8 slots filled with TOKEN/USDC, TOKEN/SOL, etc. pools (then skipped in the loop
        // below), crowding out the real ETH/TOKEN pools, so the winning combo (e.g. USDC→ETH 2% →
        // ETH→UNI 0.01%, which our quoter handles fine) was never built and we lost ~36% to Uniswap.
        const secondHopPools = pools
          .filter(pool => {
            if (!poolHasCurrency(pool, currencyOut)) return false
            const intermediate = otherPoolCurrency(pool, currencyOut)
            return intermediate && addressIsPriorityBridge(intermediate, bridgeAddresses)
          })
          .sort((a, b) =>
            bridgeRank(otherPoolCurrency(a, currencyOut)) - bridgeRank(otherPoolCurrency(b, currencyOut)) ||
            hopRank(a.fee) - hopRank(b.fee) || a.fee - b.fee)
          .slice(0, MAX_MULTIHOP_POOLS_PER_HOP)

        for (const { pool: poolA, intermediateCurrency } of firstHopPools) {
          for (const poolB of secondHopPools) {
            if (poolA.id === poolB.id) continue
            if (!poolHasCurrency(poolB, intermediateCurrency) || !poolHasCurrency(poolB, currencyOut)) continue

            routePromises.push((async () => {
              // Full-quote at the real amount so the route is EXECUTABLE. (This path only runs on
              // the full scan, where the bridged route is the whole point — e.g. USDC→ETH→UNI
              // through deep pools beats a shallow direct pool.) A combo that can't fill the full
              // amount reverts and is skipped; we no longer keep optimistic probe-scaled estimates
              // that the optimizer can't actually execute.
              const fullQuote = await queryV4MultiHop(poolA, poolB, currencyIn, intermediateCurrency, currencyOut, amountRaw, tokenOut.decimals)
              if (!fullQuote || fullQuote.amountOut === 0n) return
              const amountOut = fullQuote.amountOut

              const bridgeLabel = input.unwrapWethInput || output.wrapEthOutput ? ' via ETH' : ''
              v4Routes.push({
                type: 'v4_multihop',
                hops: 2,
                fee: poolA.fee,
                tickSpacing: poolA.tickSpacing,
                hooks: poolA.hooks,
                currency0: poolA.currency0,
                currency1: poolA.currency1,
                fee2: poolB.fee,
                tickSpacing2: poolB.tickSpacing,
                hooks2: poolB.hooks,
                currency02: poolB.currency0,
                currency12: poolB.currency1,
                currencyIn,
                currencyOut,
                via: intermediateCurrency,
                unwrapWethInput: input.unwrapWethInput,
                wrapEthInput: input.wrapEthInput,
                wrapEthOutput: output.wrapEthOutput,
                unwrapWethOutput: output.unwrapWethOutput,
                amountOut,
                amountOutNum: fullQuote.amountOutNum,
                scoreOut: amountOut,
                probeOnly: false,
                priceImpact: 0,
                label: `V4 ${poolA.fee / 10000}% -> ${poolB.fee / 10000}%${bridgeLabel}`,
                poolId: `${poolA.id}:${poolB.id}`,
              })
            })())
          }
        }

        await Promise.all(routePromises)
      })
    ))
  }

  return v4Routes
}

function shouldUseBalancedSplit(routes) {
  const bestImpact = routes[0]?.priceImpact ?? 0
  return bestImpact >= BALANCED_IMPACT_THRESHOLD
}

function selectRoutesToSplit(allRoutes, limit = 8, balanced = false, candidateLimit = MAX_CANDIDATE_ROUTES) {
  const bestOut = allRoutes[0] ? routeScoreOut(allRoutes[0]) : undefined
  if (!bestOut) return []

  const candidates = allRoutes
    .slice(0, candidateLimit)
    .filter((route, index) => {
      if (index === 0) return true
      const threshold = balanced
        ? (isV4Route(route) || isMixedRoute(route) ? V4_BALANCED_ROUTE_BPS : BALANCED_ROUTE_BPS)
        : (isV4Route(route) || isMixedRoute(route) ? V4_COMPETITIVE_ROUTE_BPS : COMPETITIVE_ROUTE_BPS)
      return routeQualityBps(route, bestOut) >= threshold
    })

  const selected = candidates
    .slice(0, limit)

  const priorityBridgeRoute = allRoutes.find(route =>
    !route.probeOnly &&
    routeUsesPriorityBridge(route) &&
    routeQualityBps(route, bestOut) >= (balanced ? V4_BALANCED_ROUTE_BPS : V4_COMPETITIVE_ROUTE_BPS)
  )
  if (priorityBridgeRoute && !selected.includes(priorityBridgeRoute)) {
    if (selected.length < limit) selected.push(priorityBridgeRoute)
    else selected[selected.length - 1] = priorityBridgeRoute
  }

  if (selected.some(route => isV4Route(route) || isMixedRoute(route))) return selected

  const bestV4 = candidates.find(route =>
    isV4Route(route) &&
    !route.wrapEthOutput &&
    routeQualityBps(route, bestOut) >= (balanced ? V4_BALANCED_ROUTE_BPS : V4_COMPETITIVE_ROUTE_BPS)
  )
  if (!bestV4) return selected

  if (selected.length < limit) return [...selected, bestV4]
  return [...selected.slice(0, limit - 1), bestV4]
}

function capWeights(weights, cap) {
  const capped = Array(weights.length).fill(false)
  const result = [...weights]

  for (let guard = 0; guard < weights.length; guard++) {
    const over = result.findIndex((weight, index) => !capped[index] && weight > cap)
    if (over === -1) break

    const excess = result[over] - cap
    result[over] = cap
    capped[over] = true

    const openIndexes = result
      .map((_, index) => index)
      .filter(index => !capped[index])
    const openTotal = openIndexes.reduce((sum, index) => sum + result[index], 0)
    if (openTotal === 0) break

    openIndexes.forEach(index => {
      result[index] += excess * (result[index] / openTotal)
    })
  }

  const total = result.reduce((sum, weight) => sum + weight, 0)
  return result.map(weight => weight / total)
}

function getRouteWeights(routes, balanced = false) {
  const bestOut = Number(routeScoreOut(routes[0]))
  const power = balanced ? BALANCED_ROUTE_WEIGHT_POWER : ROUTE_WEIGHT_POWER
  const scores = routes.map(route => {
    const ratio = Math.max(Number(routeScoreOut(route)) / bestOut, 0)
    return Math.pow(ratio, power)
  })
  const totalScore = scores.reduce((sum, score) => sum + score, 0)
  const weights = scores.map(score => score / totalScore)
  return balanced && routes.length > 1 ? capWeights(weights, BALANCED_MAX_ROUTE_SHARE) : weights
}

function capProbeOnlyWeights(routes, weights) {
  const capped = weights.map((weight, index) =>
    routes[index].probeOnly ? Math.min(weight, PROBE_ONLY_MAX_ROUTE_SHARE) : weight
  )
  const remaining = 1 - capped.reduce((sum, weight) => sum + weight, 0)
  if (Math.abs(remaining) < 0.000001) return capped

  const flexibleIndexes = routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => !route.probeOnly)
    .map(({ index }) => index)
  if (flexibleIndexes.length === 0) return weights

  const flexibleTotal = flexibleIndexes.reduce((sum, index) => sum + capped[index], 0)
  flexibleIndexes.forEach(index => {
    capped[index] += remaining * (flexibleTotal === 0 ? 1 / flexibleIndexes.length : capped[index] / flexibleTotal)
  })
  return capped
}

function selectOptimizerCandidates(executableRoutes, maxRoutes = OPTIMIZED_MAX_ROUTES) {
  const picked = []
  const seen = new Set()
  const add = route => {
    const key = `${route.type}-${route.poolId ?? ''}-${route.fee ?? ''}-${route.fee2 ?? ''}-${route.via ?? ''}`
    if (seen.has(key) || picked.length >= maxRoutes) return
    seen.add(key)
    picked.push(route)
  }

  // Pass 1 takes REAL quotes only: probe-scaled scores are impact-free (~spot), so on large
  // trades every probe bridge would outrank the impact-bearing deep direct pools and flood the
  // cap — the greedy then has nothing to spread the base allocation across. The corridor passes
  // below give probe bridges their own slots; input is scoreOut-sorted so each pass picks the
  // best of its class.
  executableRoutes.filter(route => !route.probeOnly).slice(0, Math.ceil(maxRoutes * 0.5)).forEach(add)
  executableRoutes.filter(routeUsesPriorityBridge).slice(0, Math.ceil(maxRoutes * 0.35)).forEach(add)
  executableRoutes.filter(route => isV4Route(route) || isMixedRoute(route)).slice(0, Math.ceil(maxRoutes * 0.35)).forEach(add)
  executableRoutes.slice(Math.ceil(maxRoutes * 0.35)).forEach(add)

  return picked
}

function shouldApplyBridgeRelief(bestFullRoute, candidates, amountRaw, tokenIn) {
  if (!bestFullRoute || bestFullRoute.type !== 'direct') return false
  if ((bestFullRoute.priceImpact ?? 0) < RELIEF_IMPACT_THRESHOLD) return false
  if (!candidates.some(route => routeUsesPriorityBridgeDeep(route))) return false

  const config = getTradeScaleConfig(amountRaw, tokenIn)
  return config.maxExecutedRoutes >= 8
}

function routeMaxInput(route, amountRawBig, bridgeRelief) {
  if (!bridgeRelief) return amountRawBig
  if (route.type === 'direct' && !routeUsesPriorityBridgeDeep(route)) {
    return amountRawBig * DIRECT_RELIEF_MAX_SHARE_BPS / 10000n
  }
  return amountRawBig
}

function preferWiderExecutableSplit(candidate, currentBest) {
  if (!candidate) return currentBest
  if (!currentBest) return candidate
  if ((candidate.routes?.length ?? 0) <= (currentBest.routes?.length ?? 0)) return currentBest
  if (candidate.totalAmountOut >= currentBest.totalAmountOut) return candidate

  const withinTolerance =
    candidate.totalAmountOut * 10000n >= currentBest.totalAmountOut * BigInt(MIN_BALANCED_OUTPUT_BPS)
  return withinTolerance ? candidate : currentBest
}

async function findV4AssistSplit(allRoutes, amountRaw, tokenIn, tokenOut, addrIn, addrOut) {
  const executableRoutes = allRoutes.filter(route => !route.probeOnly)
  const bestFullRoute = executableRoutes.reduce(
    (best, route) => (!best || route.amountOut > best.amountOut ? route : best),
    null
  )
  if (!bestFullRoute || bestFullRoute.type !== 'direct') return null
  if ((bestFullRoute.priceImpact ?? 0) < BALANCED_IMPACT_THRESHOLD) return null

  const v4Candidates = executableRoutes.filter(route =>
    route.type === 'v4_direct' &&
    route.currencyIn &&
    route.currencyOut &&
    route.currencyIn.toLowerCase() !== route.currencyOut.toLowerCase()
  )
  if (v4Candidates.length === 0) return null

  const amountRawBig = BigInt(amountRaw)

  // Pre-warm every (pool × pct) quote pair in one parallel wave (see findBridgeAssistSplit).
  await Promise.all(v4Candidates.flatMap(v4Route => {
    const pool = findV4Pool(v4Route.poolId)
    if (!pool) return []
    return V4_ASSIST_PCTS.flatMap(pct => {
      const v4AmountIn = amountRawBig * BigInt(pct) / 100n
      const v3AmountIn = amountRawBig - v4AmountIn
      if (v4AmountIn <= 0n || v3AmountIn <= 0n) return []
      return [
        queryPool(addrIn, addrOut, bestFullRoute.fee, v3AmountIn.toString(), tokenIn, tokenOut).catch(() => null),
        queryV4Pool(pool, v4Route.currencyIn, v4Route.currencyOut, v4AmountIn.toString(), tokenOut.decimals).catch(() => null),
      ]
    })
  }))

  let bestAssist = null

  for (const v4Route of v4Candidates) {
    const pool = findV4Pool(v4Route.poolId)
    if (!pool) continue

    for (const pct of V4_ASSIST_PCTS) {
      const v4AmountIn = amountRawBig * BigInt(pct) / 100n
      const v3AmountIn = amountRawBig - v4AmountIn
      if (v4AmountIn <= 0n || v3AmountIn <= 0n) continue

      try {
        const [v3Quote, v4Quote] = await Promise.all([
          queryPool(addrIn, addrOut, bestFullRoute.fee, v3AmountIn.toString(), tokenIn, tokenOut),
          queryV4Pool(pool, v4Route.currencyIn, v4Route.currencyOut, v4AmountIn.toString(), tokenOut.decimals),
        ])
        if (!v3Quote || !v4Quote?.amountOut) continue

        const totalAmountOut = v3Quote.amountOut + v4Quote.amountOut
        if (totalAmountOut * 10000n <= bestFullRoute.amountOut * BigInt(MIN_V4_ASSIST_GAIN_BPS)) continue
        if (bestAssist && totalAmountOut <= bestAssist.totalAmountOut) continue

        bestAssist = {
          routes: [
            {
              ...bestFullRoute,
              amountIn: v3AmountIn.toString(),
              amountOut: v3Quote.amountOut,
              amountOutNum: v3Quote.amountOutNum,
              percent: 100 - pct,
            },
            {
              ...v4Route,
              amountIn: v4AmountIn.toString(),
              amountOut: v4Quote.amountOut,
              amountOutNum: v4Quote.amountOutNum,
              percent: pct,
            },
          ],
          totalAmountOut,
          priceImpact: (bestFullRoute.priceImpact ?? 0) * ((100 - pct) / 100),
          splitMode: 'v4-assist',
        }
      } catch {
        // Ignore routes that quote in discovery but cannot be requoted for the split size.
      }
    }
  }

  return bestAssist
}

async function findBridgeAssistSplit(allRoutes, amountRaw, tokenIn, tokenOut, addrIn, addrOut) {
  const amountRawBig = BigInt(amountRaw)
  const executableRoutes = allRoutes.filter(route => !route.probeOnly)
  const bestFullRoute = executableRoutes.reduce(
    (best, route) => (!best || route.amountOut > best.amountOut ? route : best),
    null
  )
  if (!bestFullRoute || bestFullRoute.type !== 'direct') return null
  if ((bestFullRoute.priceImpact ?? 0) < RELIEF_IMPACT_THRESHOLD) return null

  const bridgeCandidates = allRoutes
    .filter(route => route !== bestFullRoute && routeUsesPriorityBridgeDeep(route))
    .filter(route =>
      route.type === 'multihop' ||
      route.type === 'v4_multihop' ||
      isMixedRoute(route)
    )
    .sort((a, b) => routeScoreOut(b) > routeScoreOut(a) ? 1 : -1)
    .slice(0, 8)
  if (bridgeCandidates.length === 0) return null

  // Pre-warm every (candidate × pct) quote in one parallel wave; the decision loop below then
  // reads from the amount-keyed quote cache instead of paying a round-trip per combination.
  await Promise.all([
    ...BRIDGE_ASSIST_PCTS.map(pct => {
      const directAmountIn = amountRawBig - amountRawBig * BigInt(pct) / 100n
      if (directAmountIn <= 0n) return null
      return quoteRouteAmount(bestFullRoute, directAmountIn, tokenIn, tokenOut, addrIn, addrOut).catch(() => null)
    }),
    ...bridgeCandidates.flatMap(bridgeRoute => BRIDGE_ASSIST_PCTS.map(pct => {
      const bridgeAmountIn = amountRawBig * BigInt(pct) / 100n
      if (bridgeAmountIn <= 0n || bridgeAmountIn >= amountRawBig) return null
      return quoteRouteAmount(bridgeRoute, bridgeAmountIn, tokenIn, tokenOut, addrIn, addrOut).catch(() => null)
    })),
  ])

  const directQuoteByPct = new Map()
  let bestAssist = null

  for (const bridgeRoute of bridgeCandidates) {
    for (const pct of BRIDGE_ASSIST_PCTS) {
      const bridgeAmountIn = amountRawBig * BigInt(pct) / 100n
      const directAmountIn = amountRawBig - bridgeAmountIn
      if (bridgeAmountIn <= 0n || directAmountIn <= 0n) continue

      try {
        let directQuote = directQuoteByPct.get(pct)
        if (!directQuote) {
          directQuote = await quoteRouteAmount(bestFullRoute, directAmountIn, tokenIn, tokenOut, addrIn, addrOut)
          if (directQuote?.amountOut) directQuoteByPct.set(pct, directQuote)
        }

        const bridgeQuote = await quoteRouteAmount(bridgeRoute, bridgeAmountIn, tokenIn, tokenOut, addrIn, addrOut)
        if (!directQuote?.amountOut || !bridgeQuote?.amountOut) continue

        const totalAmountOut = directQuote.amountOut + bridgeQuote.amountOut
        if (totalAmountOut <= bestFullRoute.amountOut) continue
        if (bestAssist && totalAmountOut <= bestAssist.totalAmountOut) continue

        bestAssist = {
          routes: [
            {
              ...bestFullRoute,
              ...directQuote,
              amountIn: directAmountIn.toString(),
              amountOut: directQuote.amountOut,
              percent: 100 - pct,
            },
            {
              ...bridgeRoute,
              ...bridgeQuote,
              amountIn: bridgeAmountIn.toString(),
              amountOut: bridgeQuote.amountOut,
              percent: pct,
            },
          ],
          totalAmountOut,
          priceImpact: (bestFullRoute.priceImpact ?? 0) * ((100 - pct) / 100),
          splitMode: 'bridge-assist',
        }
      } catch {
        // Some discovered bridge paths are valid only at probe size; skip them.
      }
    }
  }

  return bestAssist
}

async function quoteRouteAmount(route, amountIn, tokenIn, tokenOut, addrIn, addrOut) {
  if (route.type === 'direct') {
    const quote = await queryPool(addrIn, addrOut, route.fee, amountIn.toString(), tokenIn, tokenOut)
    if (!quote) return null
    return { ...route, ...quote, amountIn: amountIn.toString(), amountOut: quote.amountOut }
  }

  if (route.type === 'multihop') {
    const quote = await queryTwoHop(addrIn, route.via, addrOut, route.fee, route.fee2, amountIn.toString(), tokenOut.decimals)
    if (!quote) return null
    return { ...route, ...quote, amountIn: amountIn.toString(), amountOut: quote.amountOut }
  }

  if (route.type === 'v2_direct') {
    const quote = await queryV2Pair(addrIn, addrOut, amountIn.toString(), tokenIn, tokenOut)
    if (!quote) return null
    return { ...route, ...quote, amountIn: amountIn.toString(), amountOut: quote.amountOut }
  }

  if (route.type === 'v2_multihop') {
    const bridgeToken = tokenByAddress(route.via) ?? tokenForAddress(route.via)
    const firstQuote = await queryV2Pair(addrIn, route.via, amountIn.toString(), tokenIn, bridgeToken)
    if (!firstQuote?.amountOut) return null
    const secondQuote = await queryV2Pair(route.via, addrOut, firstQuote.amountOut.toString(), bridgeToken, tokenOut)
    if (!secondQuote?.amountOut) return null
    return {
      ...route,
      amountIn: amountIn.toString(),
      amountOut: secondQuote.amountOut,
      amountOutNum: secondQuote.amountOutNum,
    }
  }

  if (route.type === 'v4_direct') {
    const pool = findV4Pool(route.poolId)
    if (!pool) return null
    const quote = await queryV4Pool(pool, route.currencyIn, route.currencyOut, amountIn.toString(), tokenOut.decimals)
    if (!quote) return null
    return { ...route, ...quote, amountIn: amountIn.toString(), amountOut: quote.amountOut }
  }

  if (route.type === 'v4_multihop') {
    const [poolAId, poolBId] = route.poolId.split(':')
    const poolA = findV4Pool(poolAId)
    const poolB = findV4Pool(poolBId)
    if (!poolA || !poolB) return null
    const quote = await queryV4MultiHop(poolA, poolB, route.currencyIn, route.via, route.currencyOut, amountIn.toString(), tokenOut.decimals)
    if (!quote) return null
    return { ...route, ...quote, amountIn: amountIn.toString(), amountOut: quote.amountOut }
  }

  if (route.type?.startsWith('mixed')) {
    const [firstLeg, secondLeg] = route.legs ?? []
    if (!firstLeg || !secondLeg) return null
    const bridgeToken = tokenByAddress(route.via) ?? tokenForAddress(route.via)
    const quotedFirst = await quoteRouteAmount(firstLeg, amountIn, tokenIn, bridgeToken, addrIn, route.via)
    if (!quotedFirst?.amountOut) return null
    const quotedSecond = await quoteRouteAmount(secondLeg, quotedFirst.amountOut, bridgeToken, tokenOut, route.via, addrOut)
    if (!quotedSecond?.amountOut) return null
    return {
      ...route,
      amountIn: amountIn.toString(),
      amountOut: quotedSecond.amountOut,
      amountOutNum: quotedSecond.amountOutNum,
      legs: [
        { ...quotedFirst, amountIn: amountIn.toString() },
        { ...quotedSecond, amountIn: quotedFirst.amountOut.toString() },
      ],
    }
  }

  return null
}

// Every pool a route touches, as protocol-scoped keys. `from`/`to` are the route's ERC20 endpoints
// (a mixed route's legs are keyed against its bridge token).
function routePoolKeys(route, from, to) {
  const pair = (a, b) => [a.toLowerCase(), b.toLowerCase()].sort().join('-')
  const v4Key = id => {
    const pool = findV4Pool(id)
    return `v4|${pool ? v4PoolKey(pool) : id}`
  }
  switch (route.type) {
    case 'direct': return [`v3|${pair(from, to)}|${route.fee}`]
    case 'multihop': return [`v3|${pair(from, route.via)}|${route.fee}`, `v3|${pair(route.via, to)}|${route.fee2}`]
    case 'v2_direct': return [`v2|${pair(from, to)}`]
    case 'v2_multihop': return [`v2|${pair(from, route.via)}`, `v2|${pair(route.via, to)}`]
    case 'v4_direct': return route.poolId ? [v4Key(route.poolId)] : []
    case 'v4_multihop': return route.poolId ? route.poolId.split(':').map(v4Key) : []
    default: break
  }
  if (isMixedRoute(route) && route.legs?.length === 2 && route.via) {
    return [...routePoolKeys(route.legs[0], from, route.via), ...routePoolKeys(route.legs[1], route.via, to)]
  }
  return []
}

// Routes in one split are quoted against the SAME fresh pool state, but execute() runs them one
// after another. Two routes that share a pool therefore double-count it: measured on 1000 USDC→WETH,
// five corridors through the same thin X/WETH pool each quoted its full 1.2 WETH (a "6 WETH" split
// the chain could only ever pay ~1.2 for). Each group of pool-sharing routes collapses into the
// single member that pays most for the group's COMBINED input — an honest number, and fewer hops
// to execute. Independent routes are untouched.
// Group id per route: routes that share any pool (directly or through a chain of shared pools)
// get the same id.
function sharedPoolGroupIds(routes, addrIn, addrOut) {
  const parent = routes.map((_, i) => i)
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const owner = new Map()
  routes.forEach((route, i) => {
    for (const key of routePoolKeys(route, addrIn, addrOut)) {
      if (owner.has(key)) parent[find(i)] = find(owner.get(key))
      else owner.set(key, i)
    }
  })
  return routes.map((_, i) => find(i))
}

async function mergeSharedPoolRoutes(split, amountRaw, tokenIn, tokenOut, addrIn, addrOut) {
  const routes = split?.routes
  if (!routes || routes.length < 2) return split

  const groups = new Map()
  sharedPoolGroupIds(routes, addrIn, addrOut).forEach((root, i) => {
    groups.set(root, [...(groups.get(root) ?? []), i])
  })
  if ([...groups.values()].every(group => group.length === 1)) return split

  const merged = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(routes[group[0]])
      continue
    }
    const groupIn = group.reduce((sum, i) => sum + BigInt(routes[i].amountIn ?? 0), 0n)
    const requoted = await Promise.all(group.map(i =>
      quoteRouteAmount(routes[i], groupIn, tokenIn, tokenOut, addrIn, addrOut).catch(() => null)))
    const best = requoted.reduce((top, q) =>
      (q?.amountOut && (!top || BigInt(q.amountOut) > BigInt(top.amountOut)) ? q : top), null)
    if (!best) {
      // Can't price the combined amount (RPC trouble): leave the split as it was. The connected-
      // wallet execute() simulation and the click-time preflight still measure what it really pays.
      return split
    }
    merged.push({ ...best, amountIn: groupIn.toString(), amountOut: BigInt(best.amountOut) })
  }

  const total = BigInt(amountRaw)
  for (const route of merged) {
    route.percent = Math.max(1, Math.round(Number((BigInt(route.amountIn) * 10000n) / total) / 100))
  }
  const sumPct = merged.reduce((sum, route) => sum + route.percent, 0)
  if (sumPct !== 100) merged.sort((a, b) => b.percent - a.percent)[0].percent += 100 - sumPct

  if (globalThis.__AETHER_DEBUG) {
    console.log('[dbg] shared-pool merge:', routes.length, '→', merged.length, 'routes | total',
      split.totalAmountOut?.toString(), '→', merged.reduce((sum, r) => sum + BigInt(r.amountOut), 0n).toString())
  }
  return {
    ...split,
    routes: merged,
    totalAmountOut: merged.reduce((sum, route) => sum + BigInt(route.amountOut), 0n),
    sharedPoolsMerged: routes.length - merged.length,
  }
}

async function findOptimizedSplit(allRoutes, amountRaw, tokenIn, tokenOut, addrIn, addrOut, options = {}) {
  const amountRawBig = BigInt(amountRaw)
  const tradeConfig = getTradeScaleConfig(amountRaw, tokenIn)
  // Keep probe-only BRIDGE routes (USDC→TOKEN→ETH) in the candidate pool: they tap pools INDEPENDENT
  // of the direct USDC/ETH pools, so the greedy can route a whale trade's overflow through them once
  // the direct pools saturate (+27-40% measured on 280M USDC→ETH). The greedy re-quotes every
  // candidate at the REAL marginal amount each chunk (below), so the optimistic probe scoreOut only
  // surfaces the route into selection — it is never trusted for allocation. bestFullRoute stays on
  // genuinely full-quoted routes so a probe estimate can never become the baseline.
  // Same corridor classes the caller feeds in (mixed + V3/V4 multihop probes): this used to keep
  // only probe-only MIXED routes, silently re-dropping the probe-only multihops the caller had
  // deliberately included in the greedy input.
  const executableRoutes = allRoutes.filter(route =>
    !route.probeOnly || isMixedRoute(route) || route.type === 'multihop' || route.type === 'v4_multihop')
  const bestFullRoute = allRoutes
    .filter(route => !route.probeOnly)
    .reduce((best, route) => (!best || route.amountOut > best.amountOut ? route : best), null)
  if (!bestFullRoute) return null

  // One candidate per shared-pool group (best-ranked member): the group's members can't both take
  // flow anyway (see the greedy below), and letting them fill the candidate cap crowded out every
  // independent route — measured on 1000 USDC→WETH, all 5 slots went to corridors through the
  // same saturated pool, so once it filled there was nowhere for the other 99% to go.
  const optimizerPool = executableRoutes.filter(route =>
    route.type === 'direct' ||
    route.type === 'multihop' ||
    route.type === 'v2_direct' ||
    route.type === 'v2_multihop' ||
    route.type === 'v4_direct' ||
    route.type === 'v4_multihop' ||
    route.type?.startsWith('mixed')
  )
  const optimizerGroups = sharedPoolGroupIds(optimizerPool, addrIn, addrOut)
  const seenGroups = new Set()
  const candidates = selectOptimizerCandidates(
    optimizerPool.filter((_, i) => {
      if (seenGroups.has(optimizerGroups[i])) return false
      seenGroups.add(optimizerGroups[i])
      return true
    }),
    Math.min(tradeConfig.maxOptimizerRoutes, MAX_EXECUTABLE_SPLIT_ROUTES)
  )

  // Candidate selection ranks by scoreOut, which for probe-scaled quotes is impact-free and
  // collapses to ~spot price for every pool — so the genuinely deepest pool (highest REAL
  // full-amount amountOut) can get crowded out. Without it the greedy allocator can never beat
  // bestFullRoute and returns null (seen live: V3 1% paying 17.57 ETH was missing from the
  // candidate set while six shallower pools were in). Force the real best route in.
  const bestKey = routeExecutionKey(bestFullRoute)
  if (!candidates.some(route => routeExecutionKey(route) === bestKey)) {
    if (candidates.length >= Math.min(tradeConfig.maxOptimizerRoutes, MAX_EXECUTABLE_SPLIT_ROUTES)) {
      candidates.pop()
    }
    candidates.unshift(bestFullRoute)
  }
  if (globalThis.__AETHER_DEBUG) {
    console.log('[dbg] optimizer candidates:', candidates.length, candidates.map(r => r.label ?? r.type).join(', '),
      '| bestFullRoute:', bestFullRoute.label ?? bestFullRoute.type, Number(bestFullRoute.amountOut) / 1e18)
  }
  if (candidates.length <= 1) return null

  const bridgeRelief = shouldApplyBridgeRelief(bestFullRoute, candidates, amountRaw, tokenIn)
  // Marginal greedy is the strongest allocator (it naturally concentrates into deep pools and
  // only feeds thin pools their profitable share). Large trades used to skip it because their
  // configured chunk count exceeded MAX_MARGINAL_GREEDY_CHUNKS — exactly the trades where
  // allocation quality matters most (proven on-chain: even 6-way split 36.6 ETH vs greedy
  // 41.3 ETH for a 461k USDC swap). Clamp the chunk count instead of disabling the algorithm.
  const greedyChunkCap = options.fast ? FAST_GREEDY_CHUNKS : MAX_MARGINAL_GREEDY_CHUNKS
  const chunkCount = candidates.length <= MAX_MARGINAL_GREEDY_ROUTES
    ? Math.min(MARGINAL_SPLIT_CHUNKS, tradeConfig.marginalChunks, greedyChunkCap)
    : 0
  if (chunkCount > 0) {
    const chunkSize = amountRawBig / BigInt(chunkCount)
    if (chunkSize <= 0n) return null
    // Candidates that share a pool are quoted as if each had it to itself, so letting two of them
    // take flow double-counts that pool (see mergeSharedPoolRoutes). Within a group only the first
    // route to receive a chunk stays eligible — a saturated shared pool then stops attracting
    // chunks and the remainder flows to independent routes instead of into the same dead end.
    const groupIds = sharedPoolGroupIds(candidates, addrIn, addrOut)
    const allocations = candidates.map((route, i) => ({
      route,
      group: groupIds[i],
      amountIn: 0n,
      amountOut: 0n,
      maxAmountIn: routeMaxInput(route, amountRawBig, bridgeRelief),
    }))
    const groupOwner = new Map()   // group id -> allocation that holds it

    // Every amount the greedy can ever ask for is known up front (k × chunkSize, bounded by each
    // route's maxAmountIn), and all quote paths are amount-keyed-cached — so fire the whole ladder
    // as ONE parallel wave first. The sequential loop below then resolves from cache instead of
    // paying one RPC round-trip per step (30 waves → 1; the whale full scan's dominant cost).
    const warmLadder = []
    for (const allocation of allocations) {
      for (let k = 1; k <= chunkCount; k++) {
        const amountIn = chunkSize * BigInt(k)
        if (amountIn > allocation.maxAmountIn) break
        warmLadder.push(quoteRouteAmount(allocation.route, amountIn, tokenIn, tokenOut, addrIn, addrOut).catch(() => null))
      }
    }
    await Promise.all(warmLadder)

    // The ladder warm above already paid the RPC time; the loop below is mostly cache reads.
    // Start the time budget AFTER the warm so a slow warm wave doesn't instantly time-box the
    // allocator into one coarse final chunk.
    const greedyDeadline = Date.now() + (options.fast ? GREEDY_TIME_BUDGET_FAST_MS : GREEDY_TIME_BUDGET_FULL_MS)
    let allocated = 0n
    for (let step = 0; step < chunkCount; step++) {
      // Past the time budget, allocate everything left in one final round so a slow RPC
      // degrades the split's granularity instead of hanging the quote.
      const overBudget = Date.now() > greedyDeadline
      const chunk = step === chunkCount - 1 || overBudget
        ? amountRawBig - allocated
        : chunkSize
      if (chunk <= 0n) break
      if (overBudget && globalThis.__AETHER_DEBUG) {
        console.log('[dbg] greedy time-boxed at step', step, 'of', chunkCount)
      }

      const marginalQuotes = await Promise.all(allocations.map(async allocation => {
        const holder = groupOwner.get(allocation.group)
        if (holder && holder !== allocation) return null
        const nextAmountIn = allocation.amountIn + chunk
        if (nextAmountIn > allocation.maxAmountIn) return null
        try {
          const quotedRoute = await quoteRouteAmount(allocation.route, nextAmountIn, tokenIn, tokenOut, addrIn, addrOut)
          if (!quotedRoute?.amountOut || quotedRoute.amountOut <= allocation.amountOut) return null
          return {
            allocation,
            quotedRoute,
            nextAmountIn,
            nextAmountOut: BigInt(quotedRoute.amountOut),
            marginalOut: BigInt(quotedRoute.amountOut) - allocation.amountOut,
          }
        } catch {
          return null
        }
      }))

      const bestMarginal = marginalQuotes
        .filter(Boolean)
        .reduce((best, quote) => (!best || quote.marginalOut > best.marginalOut ? quote : best), null)

      if (!bestMarginal) {
        // No route can absorb more input profitably — the allocation so far IS the answer.
        // Returning null here used to throw away a 90%-allocated split and trigger the dp-matrix
        // fallback's own 350+-call flood; break and let the picked/improved checks below decide.
        if (globalThis.__AETHER_DEBUG) console.log('[dbg] greedy exhausted at step', step, 'of', chunkCount, '— keeping partial allocation')
        break
      }

      bestMarginal.allocation.amountIn = bestMarginal.nextAmountIn
      bestMarginal.allocation.amountOut = bestMarginal.nextAmountOut
      bestMarginal.allocation.route = bestMarginal.quotedRoute
      groupOwner.set(bestMarginal.allocation.group, bestMarginal.allocation)
      allocated += chunk
    }

    const picked = allocations
      .filter(allocation => allocation.amountIn > 0n && allocation.amountOut > 0n)
      .filter(allocation => allocation.amountIn * 10000n / amountRawBig >= BigInt(tradeConfig.minRouteShareBps))
      .sort((a, b) => Number(b.amountOut - a.amountOut))

    const totalAmountOut = picked.reduce((sum, allocation) => sum + allocation.amountOut, 0n)
    const outputIsImproved = totalAmountOut > bestFullRoute.amountOut

    if (globalThis.__AETHER_DEBUG) {
      console.log('[dbg] greedy result: picked', picked.length, 'routes, total', Number(totalAmountOut) / 1e18,
        '| improved vs bestFullRoute', Number(bestFullRoute.amountOut) / 1e18, '?', outputIsImproved)
    }
    if (picked.length > 1 && outputIsImproved) {
      const routes = picked.map(allocation => ({
        ...allocation.route,
        amountIn: allocation.amountIn.toString(),
        amountOut: allocation.amountOut,
        percent: Number((allocation.amountIn * 100n) / amountRawBig),
      }))
      const sumPct = routes.reduce((sum, route) => sum + route.percent, 0)
      if (sumPct !== 100 && routes.length > 0) routes[0].percent += 100 - sumPct

      const priceImpact = routes.reduce(
        (sum, route) => sum + ((route.priceImpact ?? 0) * route.percent / 100),
        0
      )

      return {
        routes,
        totalAmountOut,
        priceImpact,
        splitMode: 'optimized',
      }
    }
  }

  const quoteMatrix = await Promise.all(candidates.map(async route => {
    const entries = await Promise.all(OPTIMIZED_SPLIT_SHARES.map(async share => {
      const amountIn = amountRawBig * BigInt(share) / 100n
      if (amountIn <= 0n) return null
      try {
        const quotedRoute = await quoteRouteAmount(route, amountIn, tokenIn, tokenOut, addrIn, addrOut)
        if (!quotedRoute?.amountOut || quotedRoute.amountOut <= 0n) return null
        return { route: quotedRoute, share, amountIn, amountOut: BigInt(quotedRoute.amountOut) }
      } catch {
        return null
      }
    }))
    return entries.filter(Boolean)
  }))

  let dp = Array.from({ length: 101 }, () => null)
  dp[0] = { totalAmountOut: 0n, picks: [] }

  for (const entries of quoteMatrix) {
    if (entries.length === 0) continue
    const next = [...dp]

    for (let used = 0; used <= 100; used++) {
      const state = dp[used]
      if (!state) continue

      for (const entry of entries) {
        const nextShare = used + entry.share
        if (nextShare > 100) continue
        const totalAmountOut = state.totalAmountOut + entry.amountOut
        if (!next[nextShare] || totalAmountOut > next[nextShare].totalAmountOut) {
          next[nextShare] = {
            totalAmountOut,
            picks: [...state.picks, entry],
          }
        }
      }
    }

    dp = next
  }

  const bestState = dp[100]
  if (!bestState || bestState.picks.length <= 1) return null
  if (bestState.totalAmountOut <= bestFullRoute.amountOut) return null

  const routes = bestState.picks
    .sort((a, b) => b.share - a.share)
    .map(entry => ({
      ...entry.route,
      percent: entry.share,
      amountIn: entry.amountIn.toString(),
      amountOut: entry.amountOut,
    }))

  const priceImpact = routes.reduce(
    (sum, route) => sum + ((route.priceImpact ?? 0) * route.percent / 100),
    0
  )

  return {
    routes,
    totalAmountOut: bestState.totalAmountOut,
    priceImpact,
    splitMode: 'optimized',
  }
}

// Main routing

export async function findSplitRoutes(tokenIn, tokenOut, amountRaw, options = {}) {
  try {
    return await findSplitRoutesOnce(tokenIn, tokenOut, amountRaw, options)
  } finally {
    // Standing-hub re-detection (autoHubs.js) is a multi-second RPC burst of its own. Start it only
    // once a full scan is DONE, so it never competes with the quote someone is waiting on
    // (it's throttled to every 10 minutes anyway).
    if (!options.fast) refreshAutoHubs()
  }
}

async function findSplitRoutesOnce(tokenIn, tokenOut, amountRaw, options = {}) {
  const enableV4 = options.enableV4 ?? true
  const fast = options.fast ?? false
  const enableMixed = options.enableMixed ?? !fast
  const blockedRouteKeys = new Set(options.blockedRouteKeys ?? [])
  const addrIn  = resolveAddress(tokenIn)
  const addrOut = resolveAddress(tokenOut)
  const tradeConfig = getTradeScaleConfig(amountRaw, tokenIn)
  const probeDivisor = BigInt(Math.round(1 / BALANCED_PROBE_SHARE))
  const probeAmountRaw = BigInt(amountRaw) > probeDivisor
    ? (BigInt(amountRaw) / probeDivisor).toString()
    : amountRaw

  // Dynamic transit from the liquidity graph (poolIndex): which tokens can bridge THIS pair is
  // derived from indexed pool-creation events, so a brand-new token/pool becomes a corridor on
  // its own — no hardcoded bridge list. Full scan only (two-hop work is !fast anyway); falls
  // back to the legacy seed list inside getTransitCandidates when the graph can't answer.
  let transitAddresses = null
  let screenedCorridors = []
  if (fast) {
    // Never block the first paint on the pool feed — just make sure it's warming for the full scan.
    loadPoolFeed({ timeoutMs: 0 })
  } else {
    try {
      const transit = await getTransitCandidates(addrIn, addrOut, tradeConfig.maxTransitCandidates, { amountRaw })
      transitAddresses = transit.addresses
      screenedCorridors = transit.screened?.corridors ?? []
    } catch { transitAddresses = null }
    // getTransitCandidates already awaited the feed; this only covers the path where it threw.
    await loadPoolFeed({ timeoutMs: 8_000 })
  }
  // The mixed-bridge search is gated off for small trades (useQuote: it burned hundreds of calls
  // for nothing on a typical swap). But a corridor the screen priced ABOVE every direct pool is the
  // exact case that search exists for — the ETH/zkLTC 86% → zkLTC/USDC corridor paid 16x the
  // direct rate on a 0.001 WETH trade — so those few are quoted regardless of trade size.
  const screenedWinners = screenedCorridors
    .filter(corridor => corridor.beatsDirect)
    .slice(0, MAX_SCREENED_MIXED_BRIDGES)
    .map(corridor => corridor.address)
  const mixedBridgeAddresses = enableMixed ? (transitAddresses ?? undefined) : screenedWinners
  const runMixed = enableMixed || screenedWinners.length > 0
  const v2v3Intermediates = fast ? [] : (transitAddresses ?? [WETH, ...bridgeTokens()]).filter(addr =>
    addr.toLowerCase() !== addrIn.toLowerCase() &&
    addr.toLowerCase() !== addrOut.toLowerCase()
  )
  const v4BridgeAddresses = transitAddresses
    ? [ETH_ADDRESS, ...transitAddresses.filter(addr => addr.toLowerCase() !== WETH.toLowerCase())]
    : undefined

  const phaseDiscoveryT0 = Date.now()
  const timedPhase = (label, promise) => {
    if (!globalThis.__AETHER_DEBUG) return promise
    const t0 = Date.now()
    return promise.finally(() => console.log(`[dbg] phase ${label}: ${Date.now() - t0}ms`))
  }
  const [v2Routes, v3Result, v4Routes, mixedRoutes] = await Promise.all([
    // V2
    (async () => {
      const fullDirect = await queryV2Pair(addrIn, addrOut, amountRaw, tokenIn, tokenOut)
      const probeDirect = probeAmountRaw === amountRaw
        ? null
        : await queryV2Pair(addrIn, addrOut, probeAmountRaw, tokenIn, tokenOut)
      const directResult = fullDirect ?? probeDirect
      const directRoutes = directResult ? [{
        type: 'v2_direct',
        protocol: 'v2',
        hops: 1,
        fee: 3000,
        pair: directResult.pair,
        amountOut: fullDirect ? directResult.amountOut : scaleQuote(directResult.amountOut, probeAmountRaw, amountRaw),
        amountOutNum: directResult.amountOutNum,
        probeAmountOut: probeDirect?.amountOut,
        scoreOut: probeDirect ? scaleQuote(probeDirect.amountOut, probeAmountRaw, amountRaw) : directResult.amountOut,
        probeOnly: !fullDirect && !!probeDirect,
        priceImpact: directResult.priceImpact,
        spotPrice: directResult.spotPrice,
        quotedPrice: directResult.quotedPrice,
        label: 'V2 0.3%',
      }] : []

      // Two-hop (bridged) routes are combinatorial and expensive — skip on the fast scan so the
      // first price is quick; the full scan adds them (intermediates = the dynamic transit set).
      // Fast scan with no direct route escalates to a full scan (useQuote `!displayedSplit`),
      // so bridge-only pairs are still found.
      const intermediates = v2v3Intermediates
      await Promise.all(intermediates.map(addr => getDecimals(addr)))

      const twoHopRoutes = []
      await Promise.all(intermediates.map(async addrMid => {
        const [hasFirst, hasSecond] = await Promise.all([
          v2PairExists(addrIn, addrMid),
          v2PairExists(addrMid, addrOut),
        ])
        if (!hasFirst || !hasSecond) return
        const bridgeToken = tokenByAddress(addrMid) ?? tokenForAddress(addrMid)
        const first = await queryV2Pair(addrIn, addrMid, amountRaw, tokenIn, bridgeToken)
        const firstProbe = !first && probeAmountRaw !== amountRaw
          ? await queryV2Pair(addrIn, addrMid, probeAmountRaw, tokenIn, bridgeToken)
          : null
        const firstResult = first ?? firstProbe
        if (!firstResult?.amountOut) return
        const second = await queryV2Pair(addrMid, addrOut, firstResult.amountOut.toString(), bridgeToken, tokenOut)
        if (!second?.amountOut) return
        const probeOnly = !first && !!firstProbe
        const amountOut = probeOnly ? scaleQuote(second.amountOut, probeAmountRaw, amountRaw) : second.amountOut
        twoHopRoutes.push({
          type: 'v2_multihop',
          protocol: 'v2',
          hops: 2,
          fee: 3000,
          fee2: 3000,
          via: addrMid,
          amountOut,
          amountOutNum: Number(amountOut) / 10 ** tokenOut.decimals,
          probeAmountOut: probeOnly ? second.amountOut : undefined,
          scoreOut: amountOut,
          probeOnly,
          priceImpact: 0,
          label: 'V2 0.3% -> 0.3%',
        })
      }))

      return [...directRoutes, ...twoHopRoutes]
    })(),

    // V3
    (async () => {
      const directResults = await Promise.allSettled(
        FEE_TIERS.map(async fee => {
          const [fullQuote, probeQuote] = await Promise.allSettled([
            queryPool(addrIn, addrOut, fee, amountRaw, tokenIn, tokenOut),
            probeAmountRaw === amountRaw
              ? Promise.resolve(null)
              : queryPool(addrIn, addrOut, fee, probeAmountRaw, tokenIn, tokenOut),
          ])
          const full = fullQuote.status === 'fulfilled' ? fullQuote.value : null
          const probe = probeQuote.status === 'fulfilled' ? probeQuote.value : null
          const result = full ?? probe
          if (!result) return null
          return {
            ...result,
            amountOut: full ? result.amountOut : scaleQuote(result.amountOut, probeAmountRaw, amountRaw),
            probeOnly: !full && !!probe,
            probeAmountOut: probe?.amountOut,
            scoreOut: probe ? scaleQuote(probe.amountOut, probeAmountRaw, amountRaw) : result.amountOut,
          }
        })
      )
      const directPools = directResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(isQuotedRoute)
        .map(r => ({ ...r, type: 'direct', hops: 1 }))

      // Two-hop (bridged) routes are combinatorial and expensive — skip on the fast scan so the
      // first price is quick; the full scan adds them (intermediates = the dynamic transit set;
      // the per-fee poolExists checks below are what validate each corridor, so a graph candidate
      // without a real pool on either side costs a few cached getPool calls and produces nothing).
      const intermediates = v2v3Intermediates
      await Promise.all(intermediates.map(addr => getDecimals(addr)))

      const twoHopCandidates = []
      await Promise.all(intermediates.map(async addrMid => {
        const fee1Checks = await Promise.all(FEE_TIERS.map(f => poolExists(addrIn, addrMid, f)))
        const fee2Checks = await Promise.all(FEE_TIERS.map(f => poolExists(addrMid, addrOut, f)))
        const validFee1  = FEE_TIERS.filter((_, i) => fee1Checks[i])
        const validFee2  = FEE_TIERS.filter((_, i) => fee2Checks[i])
        if (validFee1.length === 0 || validFee2.length === 0) return

        const queries = []
        for (const f1 of validFee1) {
          for (const f2 of validFee2) {
            queries.push((async () => {
              const [fullQuote, probeQuote] = await Promise.all([
                queryTwoHop(addrIn, addrMid, addrOut, f1, f2, amountRaw, tokenOut.decimals),
                probeAmountRaw === amountRaw
                  ? Promise.resolve(null)
                  : queryTwoHop(addrIn, addrMid, addrOut, f1, f2, probeAmountRaw, tokenOut.decimals),
              ])
              const result = fullQuote ?? probeQuote
              if (!result) return null
              return {
                ...result,
                amountOut: fullQuote ? result.amountOut : scaleQuote(result.amountOut, probeAmountRaw, amountRaw),
                probeOnly: !fullQuote && !!probeQuote,
                probeAmountOut: probeQuote?.amountOut,
                scoreOut: probeQuote ? scaleQuote(probeQuote.amountOut, probeAmountRaw, amountRaw) : result.amountOut,
              }
            })())
          }
        }
        const results = await Promise.all(queries)
        results.forEach(r => { if (r) twoHopCandidates.push({ ...r, type: 'multihop', hops: 2, addrMid }) })
      }))

      return { directPools, twoHopCandidates }
    })(),

    // V4
    enableV4 ? findV4Routes(tokenIn, tokenOut, amountRaw, probeAmountRaw, { fast, bridgeAddresses: v4BridgeAddresses }) : Promise.resolve([]),

    // Mixed V3/V4 bridge routes, e.g. USDC -> MUSD on V4 then MUSD -> ETH on V3.
    runMixed ? findMixedBridgeRoutes(tokenIn, tokenOut, amountRaw, probeAmountRaw, mixedBridgeAddresses) : Promise.resolve([]),
  ])

  const { directPools, twoHopCandidates } = v3Result

  const allRoutes = [
    ...directPools.map(p => ({
      type: 'direct', hops: 1, fee: p.fee,
      amountOut: p.amountOut, amountOutNum: p.amountOutNum,
      probeAmountOut: p.probeAmountOut, scoreOut: p.scoreOut,
      probeOnly: p.probeOnly,
      priceImpact: p.priceImpact, spotPrice: p.spotPrice, quotedPrice: p.quotedPrice,
      label: `V3 ${p.fee / 10000}%`,
    })),
    ...twoHopCandidates.map(p => ({
      type: 'multihop', hops: 2, fee: p.fee1, fee2: p.fee2, via: p.addrMid,
      amountOut: p.amountOut, amountOutNum: p.amountOutNum,
      probeAmountOut: p.probeAmountOut, scoreOut: p.scoreOut,
      probeOnly: p.probeOnly,
      priceImpact: 0, label: `V3 ${p.fee1 / 10000}% -> ${p.fee2 / 10000}%`,
    })),
    ...v2Routes,
    ...v4Routes,
    ...mixedRoutes,
  ].filter(route => isQuotedRoute(route) && !blockedRouteKeys.has(routeExecutionKey(route)))

  if (globalThis.__AETHER_DEBUG) {
    console.log('[dbg] discovery: v3direct', directPools.length, '| v3hop', twoHopCandidates.length,
      '| v2', v2Routes.length, '| v4', v4Routes.length, '| mixed', mixedRoutes.length, '| total kept', allRoutes.length,
      `| ${Date.now() - phaseDiscoveryT0}ms`)
  }

  if (allRoutes.length === 0) throw new Error('No liquidity pool found for this pair on Sepolia')

  allRoutes.sort((a, b) => Number(routeScoreOut(b)) - Number(routeScoreOut(a)))

  if (globalThis.__AETHER_DEBUG) {
    for (const r of allRoutes) {
      console.log('[dbg] route', (r.label ?? r.type).padEnd(22),
        'scoreOut', (Number(routeScoreOut(r)) / 10 ** tokenOut.decimals).toFixed(4).padStart(12),
        'amountOut', (Number(r.amountOut) / 10 ** tokenOut.decimals).toFixed(4).padStart(12),
        'probeOnly', !!r.probeOnly)
    }
  }

  // Anchor the executability cutoff to the best EXECUTABLE route's score, not allRoutes[0]: the top
  // route can be a probe-only estimate (e.g. an optimistic bridge that probe-scaled to a huge number
  // on a whale trade), and its inflated score pushes every real executable route below the
  // MIN_EXECUTABLE_ROUTE_BPS bar → empties splitEligibleRoutes → throws "No executable route with
  // trusted liquidity" → the app silently falls back to a single fast-scan pool. Measuring "within
  // X% of the best" against the best EXECUTABLE option keeps the real routes eligible.
  const bestRouteOut = routeScoreOut(allRoutes.find(isExecutableSplitRoute) ?? allRoutes[0])
  // ALL executable routes (no MIN_EXECUTABLE_ROUTE_BPS band). This is fed to the greedy marginal
  // optimizer so it can spread a high-impact/whale trade across EVERY pool, not just the few within
  // 70% of the best. The greedy self-selects — it only adds an allocation when it improves the
  // marginal output — so a shallow/worse route never hurts; it just lets the optimizer tap the
  // deeper pools' tails once the best pool is impact-saturated (a 280M USDC→ETH can't fit in one
  // pool, so spreading across many is exactly what minimises total price impact).
  const allExecutableRoutes = allRoutes.filter(isExecutableSplitRoute)
  // Greedy input also carries the probe-only CORRIDOR routes (cross-protocol mixed bridges +
  // V3/V4 multihops): they tap pools independent of the direct pools, so the greedy can spill
  // overflow into them (+27-40% measured on 280M USDC→ETH) — it re-quotes every candidate at the
  // REAL marginal amount, so a probe estimate only surfaces a route, never drives allocation.
  // MUST stay ONE ordered filter over allRoutes (already scoreOut-sorted): candidate selection
  // takes the TOP of this list, so appending the probe corridors at the end (as this used to)
  // pushed every mixed bridge below the candidate cap regardless of rank — the optimizer never
  // saw the corridor class and shipped 100% direct while a corridor split genuinely paid more
  // (the MUSD→USDC 95/5 loss; systemic for every pair, not that pair's pools).
  const greedyInputRoutes = allRoutes.filter(route =>
    isExecutableSplitRoute(route) ||
    (route.probeOnly && (isMixedRoute(route) || route.type === 'multihop' || route.type === 'v4_multihop')))
  // The 70%-of-best band — kept for the weighted split + eligibility (preserves normal-trade behaviour).
  const executableAllRoutes = allExecutableRoutes
    .filter(route => routeScoreOut(route) * 10000n >= bestRouteOut * BigInt(MIN_EXECUTABLE_ROUTE_BPS))
  const bestExecutableRoute = executableAllRoutes[0] ?? allRoutes.find(route => !route.probeOnly) ?? allRoutes[0]
  const bestV3ExecutableRoute = allRoutes.find(route =>
    !route.probeOnly &&
    !isV2Route(route) &&
    !isV4Route(route) &&
    !isMixedRoute(route)
  )
  const safestExecutableRoute = PREFER_V3_SINGLE_ROUTE_EXECUTION
    ? (bestV3ExecutableRoute ?? bestExecutableRoute)
    : bestExecutableRoute

  if (!ENABLE_SPLIT_EXECUTION && safestExecutableRoute) {
    return {
      routes: [{ ...safestExecutableRoute, percent: 100, amountIn: amountRaw }],
      totalAmountOut: safestExecutableRoute.amountOut,
      priceImpact: safestExecutableRoute.priceImpact,
      splitMode: isMixedRoute(safestExecutableRoute) ? 'mixed-single' : 'single-route',
    }
  }

  const splitEligibleRoutes = executableAllRoutes
  if (splitEligibleRoutes.length === 0) {
    throw new Error('No executable route with trusted liquidity')
  }

  const balancedSplit = shouldUseBalancedSplit(splitEligibleRoutes)
  const buildWeightedSplit = async () => {
    const routesToSplit = selectRoutesToSplit(
      splitEligibleRoutes,
      Math.min(MAX_EXECUTED_ROUTES, tradeConfig.maxExecutedRoutes, MAX_EXECUTABLE_SPLIT_ROUTES),
      balancedSplit,
      tradeConfig.candidateRoutes
    )

    if (routesToSplit.length === 1) {
      const r = routesToSplit[0]
      return {
        routes: [{ ...r, percent: 100, amountIn: amountRaw }],
        totalAmountOut: r.amountOut,
        priceImpact:    r.priceImpact,
        splitMode:      balancedSplit ? 'balanced' : 'best-price',
      }
    }

    const weights      = balancedSplit
      ? capProbeOnlyWeights(routesToSplit, getRouteWeights(routesToSplit, balancedSplit))
      : getRouteWeights(routesToSplit, balancedSplit)
    const amountRawBig = BigInt(amountRaw)

    let allocated = 0n
    const splits = routesToSplit.map((r, i) => {
      const portion = i === routesToSplit.length - 1
        ? amountRawBig - allocated
        : BigInt(Math.round(Number(amountRawBig) * weights[i]))
      allocated += portion
      return { route: r, portion }
    })

    const reQuoted = await Promise.allSettled(
      splits.map(({ route, portion }) => {
        if (route.type === 'v4_direct') {
          const pool = findV4Pool(route.poolId)
          if (!pool) return Promise.resolve(BigInt(Math.round(Number(route.amountOut) * Number(portion) / Number(amountRawBig))))
          return queryV4Pool(pool, route.currencyIn ?? (route.zeroForOne ? route.currency0 : route.currency1),
            route.currencyOut ?? (route.zeroForOne ? route.currency1 : route.currency0),
            portion.toString(), tokenOut.decimals)
            .then(q => q?.amountOut ?? 0n)
        } else if (route.type === 'v4_multihop') {
          const [poolAId, poolBId] = route.poolId.split(':')
          const poolA = findV4Pool(poolAId)
          const poolB = findV4Pool(poolBId)
          if (!poolA || !poolB) return Promise.resolve(BigInt(Math.round(Number(route.amountOut) * Number(portion) / Number(amountRawBig))))
          return queryV4MultiHop(poolA, poolB, route.currencyIn, route.via, route.currencyOut, portion.toString(), tokenOut.decimals)
            .then(q => q?.amountOut ?? 0n)
        } else if (route.type === 'v2_direct' || route.type === 'v2_multihop') {
          return quoteRouteAmount(route, portion, tokenIn, tokenOut, addrIn, addrOut)
            .then(q => q?.amountOut ?? 0n)
        } else if (route.type === 'direct') {
          return queryPool(addrIn, addrOut, route.fee, portion.toString(), tokenIn, tokenOut)
            .then(q => q?.amountOut ?? 0n)
        } else if (route.type?.startsWith('mixed')) {
          return quoteRouteAmount(route, portion, tokenIn, tokenOut, addrIn, addrOut)
            .then(q => q?.amountOut ?? 0n)
        } else {
          return queryTwoHop(addrIn, route.via, addrOut, route.fee, route.fee2, portion.toString(), tokenOut.decimals)
            .then(q => q?.amountOut ?? 0n)
        }
      })
    )

    const routes = []
    let totalAmountOut = 0n
    let weightedImpact = 0

    for (let i = 0; i < splits.length; i++) {
      let pct = Math.round(weights[i] * 100)
      if (pct === 0 && (splits[i].route.type?.startsWith('v4') || splits[i].route.type?.startsWith('mixed'))) pct = 1
      if (pct === 0) continue
      const hasReQuote = reQuoted[i].status === 'fulfilled' && reQuoted[i].value > 0n
      if (!hasReQuote && splits[i].route.probeOnly) continue
      const amountOut = hasReQuote ? reQuoted[i].value : BigInt(splits[i].route.amountOut)
      routes.push({
        ...splits[i].route,
        percent:  pct,
        amountIn: splits[i].portion.toString(),
        amountOut,
      })
      totalAmountOut += BigInt(amountOut)
      weightedImpact += (splits[i].route.priceImpact ?? 0) * weights[i]
    }

    const sumPct = routes.reduce((s, r) => s + r.percent, 0)
    if (sumPct !== 100 && routes.length > 0) routes[0].percent += 100 - sumPct
    const bestSplitEligibleRoute = splitEligibleRoutes.find(route => !route.probeOnly) ?? splitEligibleRoutes[0]

    if (
      bestSplitEligibleRoute &&
      totalAmountOut <= bestSplitEligibleRoute.amountOut &&
      totalAmountOut * 10000n < bestSplitEligibleRoute.amountOut * BigInt(MIN_BALANCED_OUTPUT_BPS)
    ) {
      const best = bestSplitEligibleRoute
      return {
        routes: [{ ...best, percent: 100, amountIn: amountRaw }],
        totalAmountOut: best.amountOut,
        priceImpact: best.priceImpact,
        splitMode: 'best-price',
        balancedRejected: balancedSplit,
      }
    }

    return { routes, totalAmountOut, priceImpact: weightedImpact, splitMode: balancedSplit ? 'balanced' : 'best-price' }
  }

  // All three optimizer passes (greedy + bridge/V4 assist) fire their own SEQUENTIAL re-quote
  // rounds — the dominant latency cost. Skip them ALL on the fast scan: it returns the weighted
  // split quickly (one parallel round of re-quotes) so the price appears fast; the full scan that
  // follows runs the full optimizer to refine to the best split. Fast scan with no usable split
  // still escalates to a full scan (useQuote), and the final best-price guard below protects the
  // displayed number either way.
  // The greedy optimizer sees every route the assist passes see (executable + probe-only bridges)
  // and allocates marginally, so when it produces a split the assists can't beat it — they'd only
  // burn another ~300 whale-size quoter calls COMPETING with the greedy's own wave for provider
  // capacity (measured: running all three concurrently made each slower). Run the assists only as
  // the fallback when the greedy yields nothing.
  const optimizedSplit = fast
    ? null
    : await timedPhase('optimizedSplit', findOptimizedSplit(greedyInputRoutes, amountRaw, tokenIn, tokenOut, addrIn, addrOut, { fast }))
  const [bridgeAssistSplit, v4AssistSplit] = fast || optimizedSplit
    ? [null, null]
    : await Promise.all([
      timedPhase('bridgeAssist', findBridgeAssistSplit(allRoutes, amountRaw, tokenIn, tokenOut, addrIn, addrOut)),
      timedPhase('v4Assist', findV4AssistSplit(splitEligibleRoutes, amountRaw, tokenIn, tokenOut, addrIn, addrOut)),
    ])
  const assistedBest = [optimizedSplit, bridgeAssistSplit, v4AssistSplit]
    .filter(Boolean)
    .sort((a, b) => b.totalAmountOut > a.totalAmountOut ? 1 : b.totalAmountOut < a.totalAmountOut ? -1 : 0)[0]
  const weightedSplit = await timedPhase('weighted', buildWeightedSplit())
  if (globalThis.__AETHER_DEBUG) {
    const fmt = s => s ? `${s.splitMode}/${s.routes?.length}r/${Number(s.totalAmountOut) / 1e18}` : 'null'
    console.log('[dbg] optimized:', fmt(optimizedSplit), '| bridgeAssist:', fmt(bridgeAssistSplit), '| v4Assist:', fmt(v4AssistSplit), '| weighted:', fmt(weightedSplit))
  }
  // Both contenders are made honest BEFORE they're compared: a pool-sharing split carries an
  // inflated total and would otherwise beat a correct one only to be merged down afterwards
  // (measured: a 4-way split through one pool "paid" 4.8 WETH and beat the greedy's real 1.27).
  const [honestWeighted, honestAssisted] = await timedPhase('sharedPools', Promise.all([
    mergeSharedPoolRoutes(weightedSplit, amountRaw, tokenIn, tokenOut, addrIn, addrOut),
    mergeSharedPoolRoutes(assistedBest, amountRaw, tokenIn, tokenOut, addrIn, addrOut),
  ]))
  const picked = preferWiderExecutableSplit(honestWeighted, honestAssisted)

  // Final best-price guard: routes carry amountOut values that can be stale or probe-scaled, so
  // a multi-route split can slip through while quietly losing to just using the deepest pool
  // (seen live: an even 6-way split returned 36.6 ETH when 100% V3 1% paid 41.2). Re-quote the
  // best single executable route FRESH at the full amount and take it if it pays more.
  // Rank by REAL full-amount output here, not scoreOut: probe-scaled scoreOut is impact-free,
  // so the first route in scoreOut order can be a shallow pool whose real quote is far below
  // the deepest pool's.
  const bestByRealOutput = executableAllRoutes.reduce(
    (best, route) => (!best || BigInt(route.amountOut) > BigInt(best.amountOut) ? route : best),
    null
  ) ?? bestExecutableRoute
  if (picked && bestByRealOutput) {
    try {
      const freshBest = await timedPhase('finalGuard', quoteRouteAmount(bestByRealOutput, BigInt(amountRaw), tokenIn, tokenOut, addrIn, addrOut))
      if (globalThis.__AETHER_DEBUG) {
        console.log('[dbg] bestByRealOutput:', bestByRealOutput.label ?? bestByRealOutput.type,
          '| freshBest:', freshBest?.amountOut ? Number(freshBest.amountOut) / 1e18 : 'null',
          '| picked total:', Number(picked.totalAmountOut) / 1e18)
      }
      if (freshBest?.amountOut && BigInt(freshBest.amountOut) > BigInt(picked.totalAmountOut)) {
        return {
          routes: [{ ...freshBest, percent: 100, amountIn: amountRaw }],
          totalAmountOut: BigInt(freshBest.amountOut),
          priceImpact: freshBest.priceImpact ?? bestExecutableRoute.priceImpact ?? 0,
          splitMode: 'best-price',
        }
      }
    } catch {
      // Keep the picked split if the fresh re-quote fails.
    }
  }
  return picked
}
