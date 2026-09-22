'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { parseUnits } from 'viem'
import {
  AETHER_AGGREGATOR,
  AETHER_AGGREGATOR_ABI,
  AETHER_GAS_BUDGET,
  buildAetherParams,
  classifyFailingRoutes,
  quoteCanUseAether,
} from '../swap/aetherBuilder'
import { calibrateLocal, invalidateLocalState, localEstimate } from '../swap/localQuote'
import { fetchLifiQuote } from '../swap/lifi'
import {
  API_QUOTE_REFRESH_AGE_MS,
  API_SANITY_MAX_LOCAL_BPS,
  fetchUniswapApiQuote,
  findSplitRoutes,
  invalidateQuoteCache,
  isEthWethPair,
  tokenByAddress,
} from '../swap/quoteEngine'

const API_SANITY_MIN_LOCAL_BPS = 9950n
// LI.FI is rate-limited without an API key, so it's re-asked less eagerly than the Uniswap API:
// once per run, plus one refresh when the full scan lands if the number in hand is older than this.
const LIFI_REFRESH_AGE_MS = 15_000

// Tags a LI.FI quote with how it compares to the Aether total on screen. Unavailable results pass
// through untouched so the routes panel can say LI.FI had nothing.
function compareLifi(lifiQuote, totalAmountOut, tokenOut) {
  if (!lifiQuote || lifiQuote.unavailable || totalAmountOut == null) return lifiQuote ?? null
  const delta = BigInt(lifiQuote.amountOut) - BigInt(totalAmountOut)
  return {
    ...lifiQuote,
    isBetter: delta > 0n,
    deltaFormatted: (Number(delta) / 10 ** tokenOut.decimals).toFixed(6),
  }
}

function attachLifiQuote(current, lifiQuote, tokenOut) {
  if (!current || current.isWrap) return current
  return { ...current, lifiQuote: compareLifi(lifiQuote, current.totalAmountOut, tokenOut) }
}

export {
  POSITION_MANAGER,
  UNISWAP_API_ROUTER,
  UNIVERSAL_ROUTER,
  invalidateQuoteCache,
  isEthWethPair,
  routeExecutionKey,
  resolveAddress,
  resolveCurrency,
} from '../swap/quoteEngine'

// Instant, locally-computed stand-in shown while the real scan runs. Carries
// `provisional` so the UI can mark it as an estimate, and `routes: []` so the
// routes panel keeps showing its "finding…" state instead of inventing a split.
function buildLocalQuote({ local, tokenIn, tokenOut, amountIn, slippage }) {
  const amountOutNum = Number(local.amountOut) / 10 ** tokenOut.decimals
  const slip = parseFloat(slippage) / 100

  return {
    routes: [],
    totalAmountOut: local.amountOut.toString(),
    amountOutFormatted: amountOutNum.toFixed(6),
    minOutFormatted: (amountOutNum * (1 - slip)).toFixed(6),
    rate: (amountOutNum / parseFloat(amountIn)).toFixed(6),
    fee: local.fee ?? 0,
    priceImpact: 0,
    priceImpactPct: '0.00',
    slippageUsed: (slip * 100).toFixed(2),
    isSplit: false,
    hasV4: local.kind === 2,
    apiQuote: null,
    provisional: true,
    approx: local.approx,
  }
}

function buildWrapQuote({ tokenIn, tokenOut, amountRaw }) {
  const amountOutNum = Number(amountRaw) / 10 ** tokenOut.decimals

  return {
    routes: [],
    totalAmountOut: amountRaw,
    amountOutFormatted: amountOutNum.toFixed(6),
    minOutFormatted: amountOutNum.toFixed(6),
    rate: '1.000000',
    fee: 0,
    priceImpact: 0,
    priceImpactPct: '0.00',
    slippageUsed: '0.00',
    isSplit: false,
    hasV4: false,
    isWrap: true,
    wrapAction: tokenIn.address === 'ETH' ? 'wrap' : 'unwrap',
    apiQuote: null,
  }
}

function buildRouteQuote({ split, apiQuote, lifiQuote, tokenIn, tokenOut, amountIn, slippage }) {
  const apiAmountOut = apiQuote?.amountOut ? BigInt(apiQuote.amountOut) : null
  const apiSanityWarning = !!apiAmountOut &&
    split.totalAmountOut > (apiAmountOut * API_SANITY_MAX_LOCAL_BPS / 10000n)
  const apiBetterTooMuch = !!apiAmountOut &&
    split.totalAmountOut * 10000n < apiAmountOut * API_SANITY_MIN_LOCAL_BPS
  const apiDelta = apiAmountOut != null ? apiAmountOut - split.totalAmountOut : null
  const apiDeltaNum = apiDelta != null ? Number(apiDelta) / 10 ** tokenOut.decimals : null
  const amountOutNum = Number(split.totalAmountOut) / 10 ** tokenOut.decimals
  const slip = parseFloat(slippage) / 100
  const priceImpact = split.priceImpact ?? 0
  // A mixed route counts only when one of its legs is V4: a V3→V3 bridge is pure V3.
  const hasV4 = split.routes.some(route =>
    route.type === 'v4_direct' ||
    route.type === 'v4_multihop' ||
    (route.type?.startsWith('mixed') && route.legs?.some(leg => leg.protocol === 'v4'))
  )

  return {
    routes: split.routes,
    totalAmountOut: split.totalAmountOut.toString(),
    amountOutFormatted: amountOutNum.toFixed(6),
    minOutFormatted: (amountOutNum * (1 - slip)).toFixed(6),
    rate: (amountOutNum / parseFloat(amountIn)).toFixed(6),
    fee: split.routes.length > 0
      ? split.routes.reduce((best, route) => route.percent > best.percent ? route : best, split.routes[0]).fee
      : 0,
    priceImpact,
    priceImpactPct: (priceImpact * 100).toFixed(2),
    slippageUsed: (slip * 100).toFixed(2),
    isSplit: split.routes.length > 1,
    hasV4,
    splitMode: split.splitMode,
    isBalanced: split.splitMode === 'balanced',
    balancedRejected: split.balancedRejected,
    apiSanityWarning,
    apiBetterTooMuch,
    apiQuote: apiQuote ? {
      ...apiQuote,
      isBetter: apiAmountOut > split.totalAmountOut,
      deltaFormatted: apiDeltaNum != null ? apiDeltaNum.toFixed(6) : null,
    } : null,
    lifiQuote: compareLifi(lifiQuote, split.totalAmountOut, tokenOut),
    sharedPoolsMerged: split.sharedPoolsMerged ?? 0,
  }
}

function attachApiQuote(current, apiQuote, tokenOut) {
  if (!current || !apiQuote?.amountOut) return current
  const apiAmountOut = BigInt(apiQuote.amountOut)
  const currentAmountOut = BigInt(current.totalAmountOut)
  const apiDelta = apiAmountOut - currentAmountOut
  const apiDeltaNum = Number(apiDelta) / 10 ** tokenOut.decimals

  return {
    ...current,
    apiSanityWarning: currentAmountOut > (apiAmountOut * API_SANITY_MAX_LOCAL_BPS / 10000n),
    apiBetterTooMuch: currentAmountOut * 10000n < apiAmountOut * API_SANITY_MIN_LOCAL_BPS,
    apiQuote: {
      ...apiQuote,
      isBetter: apiAmountOut > currentAmountOut,
      deltaFormatted: apiDeltaNum.toFixed(6),
    },
  }
}

// Multi-route splits: the engine quotes each route against a FRESH pool, but the routes execute
// sequentially in one execute() and move each other's pools — at whale size the summed total
// overshoots what the contract actually pays by several percent, so an honest preflight could
// never pass. One real execute() simulation (min = 1) returns the contract's true amountOut for
// the exact displayed set; that number goes on screen, so display = what the wallet receives.
// Needs the connected wallet's real balance + allowance — when unavailable (not connected, not
// yet approved, balance short) it returns null and the engine total stays (the click-time
// preflight re-measures and re-syncs honestly).
const splitAmountIn = split =>
  BigInt(split.totalAmountIn ?? 0) || split.routes.reduce((sum, route) => sum + BigInt(route.amountIn), 0n)

// A revert that says "this wallet can't fund the swap yet" (no approval, balance short) rather than
// "a route in this set is dead". The click flow handles funding; screening routes for it is waste.
function isFundingRevert(error) {
  const reverted = error?.walk?.(e => e?.data?.errorName)
  if (reverted?.data?.errorName === 'TransferFailed') return true
  return /insufficient funds|exceeds balance|exceeds allowance/i.test(error?.shortMessage ?? error?.message ?? '')
}

// `total` is the contract's real payout for the set (null when it couldn't be measured).
// `routeRevert` marks a set that reverted for a reason other than funding: some route in it is
// likely dead, which is worth screening before the quote goes final.
async function simulateExecutedTotal({ publicClient, swapper, split, tokenIn, tokenOut }) {
  if (!publicClient || !swapper) return { total: null }
  if (!split?.routes || split.routes.length <= 1) return { total: null }
  if (!quoteCanUseAether({ routes: split.routes })) return { total: null }
  try {
    const params = buildAetherParams({
      routes: split.routes,
      tokenIn,
      tokenOut,
      totalAmountIn: splitAmountIn(split),
      totalAmountOutMin: 1n,
      recipient: swapper,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    })
    const { result } = await publicClient.simulateContract({
      account: swapper,
      address: AETHER_AGGREGATOR,
      abi: AETHER_AGGREGATOR_ABI,
      functionName: 'execute',
      args: [params],
      value: tokenIn.address === 'ETH' ? params.amountIn : 0n,
      // Same real-world gas budget as the click-time preflight, so the number on screen is one a
      // transaction can actually deliver.
      gas: AETHER_GAS_BUDGET,
    })
    return { total: result != null && BigInt(result) > 0n ? BigInt(result) : null }
  } catch (error) {
    return { total: null, routeRevert: !isFundingRevert(error) }
  }
}

// Routes that failed a solo simulation, remembered per pair so every keystroke's re-quote skips
// them without re-screening. Expire: a pool that was drained can be refilled.
const DEAD_ROUTE_TTL_MS = 10 * 60_000
// Loose on purpose: only a route that can't deliver even 10% under its own quote counts as dead.
const DEAD_ROUTE_SCREEN_SLIPPAGE = '10'
const deadRoutesByPair = new Map()

const pairKey = (tokenIn, tokenOut) => `${tokenIn.address}>${tokenOut.address}`.toLowerCase()

function deadRouteKeys(tokenIn, tokenOut) {
  const entry = deadRoutesByPair.get(pairKey(tokenIn, tokenOut))
  if (!entry) return []
  const now = Date.now()
  for (const [key, at] of entry) if (now - at > DEAD_ROUTE_TTL_MS) entry.delete(key)
  return [...entry.keys()]
}

// For re-quotes outside the hook (the click-time fresh scan): the caller's blocks plus this pair's
// known-dead routes, so it never rebuilds a set the hook already screened out.
export function withDeadRouteKeys(tokenIn, tokenOut, keys = []) {
  return [...new Set([...keys, ...deadRouteKeys(tokenIn, tokenOut)])]
}

function rememberDeadRoutes(tokenIn, tokenOut, keys) {
  const key = pairKey(tokenIn, tokenOut)
  const entry = deadRoutesByPair.get(key) ?? new Map()
  for (const routeKey of keys) entry.set(routeKey, Date.now())
  deadRoutesByPair.set(key, entry)
}

// Solo-simulates each route of a set that reverted as a whole. Returns the keys of the routes that
// fail on their own — only when SOME do: all failing means the wallet (not the routes) is the
// problem, and blocking everything would leave nothing to quote.
async function screenDeadRoutes({ publicClient, swapper, split, tokenIn, tokenOut }) {
  try {
    const failing = await classifyFailingRoutes({
      publicClient,
      account: swapper,
      quote: split,
      tokenIn,
      tokenOut,
      totalAmountIn: splitAmountIn(split),
      recipient: swapper,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      slippage: DEAD_ROUTE_SCREEN_SLIPPAGE,
    })
    return failing.length > 0 && failing.length < split.routes.length ? failing.map(route => route.key) : []
  } catch {
    return []
  }
}

export function useQuote({ tokenIn, tokenOut, amountIn, slippage, swapper, blockedRouteKeys = [] }) {
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const publicClient = usePublicClient()
  const cancelRef = useRef(false)
  const runRef = useRef(null)
  const runSeqRef = useRef(0)
  const blockedRouteSignature = blockedRouteKeys.join('|')

  useEffect(() => {
    // "0", "0.", "0.00" while typing are all zero: quoting them fired a full scan plus LI.FI and
    // Uniswap requests for nothing and surfaced "No liquidity pool found".
    if (!tokenIn || !tokenOut || !amountIn || !(Number.parseFloat(amountIn) > 0)) {
      setQuote(null)
      setError(null)
      return
    }

    const run = async () => {
      const runSeq = ++runSeqRef.current
      const isCurrentRun = () => !cancelRef.current && runSeq === runSeqRef.current
      cancelRef.current = false
      setLoading(true)
      setError(null)
      let hadDisplay = false

      try {
        const amountRaw = parseUnits(amountIn, tokenIn.decimals).toString()

        if (isEthWethPair(tokenIn, tokenOut)) {
          if (!cancelRef.current) setQuote(buildWrapQuote({ tokenIn, tokenOut, amountRaw }))
          return
        }

        // Paint a locally-computed number immediately so a keystroke never waits on
        // the network. Pool STATE is cached, so once a pair has been quoted this
        // resolves with zero RPC. It only ever fills the gap before the first real
        // split lands — `hadDisplay` keeps it from overwriting an authoritative one.
        localEstimate({ tokenIn, tokenOut, amountIn: BigInt(amountRaw) })
          .then(local => {
            // `calibrated` gates the display: an unlearned direction is ~17% off,
            // and a number that visibly jumps on every scan is worse than a spinner.
            if (!local?.calibrated || !isCurrentRun() || hadDisplay) return
            setQuote(buildLocalQuote({ local, tokenIn, tokenOut, amountIn, slippage }))
          })
          .catch(() => {})

        // The API reference attaches WHENEVER it lands — never discarded on a timer. (The old
        // 1.5s race threw away every response slower than that, so the panel stayed empty for
        // the whole run: the "API syncs forever" complaint.) It must also be comparable
        // same-instant with OUR number — Sepolia pools drift in minutes — so when the full scan
        // lands and the reference in hand is older than API_QUOTE_REFRESH_AGE_MS, it is
        // re-fetched once; the winner check (and the execute-via-API path) reads a fresh number.
        let latestApiQuote = null
        let apiInFlight = false
        let displayedQuote = null
        const requestApiQuote = () => {
          apiInFlight = true
          fetchUniswapApiQuote({ tokenIn, tokenOut, amountRaw, slippage, swapper })
            .then(apiQuote => {
              apiInFlight = false
              if (!isCurrentRun() || !apiQuote) return
              latestApiQuote = apiQuote
              setQuote(current => {
                if (!current || current.totalAmountOut !== displayedQuote?.totalAmountOut) return current
                return attachApiQuote(current, apiQuote, tokenOut)
              })
            })
            .catch(() => { apiInFlight = false })
        }
        requestApiQuote()

        // LI.FI runs alongside, attaches whenever it lands, and is compared against whatever
        // Aether number is on screen at that moment (and again when each new split lands).
        let latestLifiQuote = null
        let lifiInFlight = false
        const requestLifiQuote = () => {
          lifiInFlight = true
          fetchLifiQuote({ tokenIn, tokenOut, amountRaw, slippage, fromAddress: swapper })
            .then(lifiQuote => {
              lifiInFlight = false
              if (!isCurrentRun()) return
              latestLifiQuote = lifiQuote
              setQuote(current => attachLifiQuote(current, lifiQuote, tokenOut))
            })
            .catch(() => { lifiInFlight = false })
        }
        requestLifiQuote()

        // `final` marks the full scan's result. The fast first paint is routinely well below the
        // final split, so the swap card only lets another venue win against a final number.
        const showSplit = (split, { final = false } = {}) => {
          displayedQuote = {
            ...buildRouteQuote({
              split, apiQuote: latestApiQuote, lifiQuote: latestLifiQuote, tokenIn, tokenOut, amountIn, slippage,
            }),
            final,
          }
          if (isCurrentRun()) {
            hadDisplay = true
            setQuote(displayedQuote)
          }
        }

        const blockedKeys = () => withDeadRouteKeys(tokenIn, tokenOut, blockedRouteKeys)

        let fastScanImpact = 0
        let fastScanOut = 0
        try {
          const fastSplit = await findSplitRoutes(tokenIn, tokenOut, amountRaw, { fast: true, blockedRouteKeys: blockedKeys() })
          if (!isCurrentRun()) return
          fastScanImpact = fastSplit?.priceImpact ?? 0
          fastScanOut = fastSplit?.totalAmountOut ? Number(fastSplit.totalAmountOut) / 10 ** tokenOut.decimals : 0
          showSplit(fastSplit)
          setLoading(false)
        } catch {
          // Fall through to the full router if the fast path has no usable pool.
        }

        // Always refine with the full optimizer scan — the cheap direct-pool greedy gains +0.3-0.6%
        // even on low-impact trades. But the HEAVY part — the cross-token MUSD/tBTC/SOL bridge
        // discovery and its marginal re-quoting — only pays off on large, pool-SATURATING trades; on
        // a small swap it just burned 400+ RPC calls for nothing (the "UI got heavy/laggy" report).
        // So enable mixed bridges only when the trade is big enough to impact the direct pools: high
        // fast-scan price impact, or a large stablecoin input. Bridged-token routing through ETH
        // (V4 multi-hop) is separate and still runs — this only gates the MUSD/tBTC/SOL mixed bridges.
        const amountInNum = Number.parseFloat(amountIn)
        const stableIn = tokenIn.symbol === 'USDC' || tokenIn.symbol === 'MUSD'
        const stableOut = tokenOut.symbol === 'USDC' || tokenOut.symbol === 'MUSD'
        // Approx trade value in USD from whichever side is a stablecoin (input if selling one, else
        // the output if buying one). Robust where price impact is unreliable — V4 routes report 0
        // impact, which is why ETH→USDC (single V4 pool) slipped through and lost -52% to the
        // ETH→MUSD→USDC detour. Now a $150k ETH→USDC counts as "large" and gets the heavy routing.
        const tradeValueUsd = stableIn ? amountInNum : stableOut ? fastScanOut : 0
        const enableMixed = fastScanImpact > 0.02 || tradeValueUsd >= 50000
        let fullSplit = await findSplitRoutes(tokenIn, tokenOut, amountRaw, { blockedRouteKeys: blockedKeys(), enableMixed })
        if (!isCurrentRun()) return
        // Honest total for multi-route sets: one real execute() simulation replaces the engine's
        // summed estimate with what the contract actually pays for this exact set right now.
        let executed = await simulateExecutedTotal({ publicClient, swapper, split: fullSplit, tokenIn, tokenOut })
        if (!isCurrentRun()) return
        if (executed.routeRevert) {
          // The set can't execute: find the dead route(s) now and re-quote without them, so the
          // number that goes final is one Swap can send — instead of the click finding out and
          // asking for a second click.
          const dead = await screenDeadRoutes({ publicClient, swapper, split: fullSplit, tokenIn, tokenOut })
          if (!isCurrentRun()) return
          if (dead.length) {
            rememberDeadRoutes(tokenIn, tokenOut, dead)
            fullSplit = await findSplitRoutes(tokenIn, tokenOut, amountRaw, { blockedRouteKeys: blockedKeys(), enableMixed })
            if (!isCurrentRun()) return
            executed = await simulateExecutedTotal({ publicClient, swapper, split: fullSplit, tokenIn, tokenOut })
            if (!isCurrentRun()) return
          }
        }
        const executedTotal = executed.total
        showSplit(
          executedTotal ? { ...fullSplit, totalAmountOut: executedTotal, executedTotalSimulated: true } : fullSplit,
          { final: true },
        )
        // Teach the local estimator what this direction actually pays, so the next
        // keystroke can be answered instantly instead of waiting for another scan.
        calibrateLocal({
          tokenIn, tokenOut,
          amountIn: BigInt(amountRaw),
          engineOut: BigInt(executedTotal ?? fullSplit.totalAmountOut ?? 0n),
        })
        // Same-instant winner check: our final number just landed — refresh the API reference
        // if the one in hand predates it by more than the freshness window (an in-flight fetch
        // will attach on its own).
        if (!apiInFlight && Date.now() - (latestApiQuote?.at ?? 0) > API_QUOTE_REFRESH_AGE_MS) {
          requestApiQuote()
        }
        if (!lifiInFlight && Date.now() - (latestLifiQuote?.at ?? 0) > LIFI_REFRESH_AGE_MS) {
          requestLifiQuote()
        }

      } catch (e) {
        console.error('Quote error:', e)
        if (runSeq === runSeqRef.current && !cancelRef.current && !hadDisplay) {
          setError(e.message?.includes('revert') ? 'No liquidity pool for this pair' : e.message)
        }
        // The full scan failed after the fast one painted: what's on screen is all there will be
        // for this run, so treat it as final rather than leaving the venue choice locked.
        if (hadDisplay && isCurrentRun()) setQuote(current => (current ? { ...current, final: true } : current))
      } finally {
        if (runSeq === runSeqRef.current && !cancelRef.current) setLoading(false)
      }
    }

    runRef.current = run
    const timer = setTimeout(run, 300)
    return () => {
      cancelRef.current = true
      clearTimeout(timer)
    }
  }, [tokenIn, tokenOut, amountIn, slippage, swapper, blockedRouteKeys, blockedRouteSignature, publicClient])

  const refresh = useCallback((options = {}) => {
    if (!runRef.current) return
    cancelRef.current = false
    // keepCache: the caller just ran a fresh scan itself (cache is warm and current, quotes
    // expire via TTL anyway) and only needs the displayed quote re-synced — invalidating here
    // would re-fire the whole RPC burst for nothing.
    if (options.keepCache !== true) { invalidateQuoteCache(); invalidateLocalState() }
    runRef.current()
  }, [])

  return { quote, loading, error, refresh }
}
