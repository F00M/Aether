// Corridor screen — ranks transit candidates by what they would actually PAY, from pool state.
//
// The liquidity graph can name hundreds of tokens that connect both ends of a swap (USDC alone has
// 800+ neighbours), but only a handful can get the expensive quoter treatment. Ranking them by
// edge COUNT picked well-connected tokens and threw away the corridor that paid 16x: ETH/zkLTC
// (86% fee V4) → zkLTC/USDC (V3 1%) has two pools, not twenty. Here every candidate corridor
// A→X→B is priced with the same in-range math localQuote uses — one Multicall3 round for pool
// addresses, one for state — and ranked by output.
//
// Screening only ORDERS candidates. The winners still go through the real quoter and the
// execute() simulation, so an optimistic local number can cost a few quote calls but can never
// reach the screen or the chain.
import { FEE_TIERS, ETH_ADDRESS, POOL_FACTORY, QUOTER_V2, V2_FACTORY, V4_QUOTER, WETH } from './quoteConfig'
import { client, overRouteGasBudget } from './quoteProviders'
import { quoterAbi, v4QuoterAbi } from './quoteAbis'
import { v2AmountOut, v3AmountOut, v4PoolIdOf } from './localQuote'
import { feedV2Pair, feedV3Pools, feedV4PoolsFor } from './poolFeed'
import { addressWord, readCalls, resultWord, selector, uintWord } from './multicall3'

const STATE_VIEW = '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C'
// The reads the screen makes by the thousand (see multicall3.js), and how many 32-byte words each
// answers with — a shorter answer is not that contract and is treated as a failed call.
const GET_PAIR = selector('function getPair(address,address)')
const GET_POOL = selector('function getPool(address,address,uint24)')
const GET_RESERVES = selector('function getReserves()')
const SLOT0 = selector('function slot0()')
const LIQUIDITY = selector('function liquidity()')
const GET_SLOT0 = selector('function getSlot0(bytes32)')
const GET_LIQUIDITY = selector('function getLiquidity(bytes32)')
const WORDS = { address: 1, reserves: 3, slot0: 7, v4Slot0: 4, liquidity: 1 }

// Screen at a slice of the trade: a corridor usually takes a share of a split, and the in-range
// math is only honest while the amount is small against the pool's visible depth.
const SCREEN_SHARE_DIVISOR = 10n
// In-range math can't see past the active tick range, so a pool parked at an off-market price
// with a thin range scores far above what it pays (measured: a corridor screened at 1,387 USDC
// for 0.0001 WETH that the quoter priced at a fraction of that). The top local picks — and the
// direct baseline they're compared against — are therefore re-priced with the real quoters on
// their best pools per leg before anything is ranked.
const VERIFY_TOP = 8
const VERIFY_OPTIMISTIC = 6
const VERIFY_POOLS_PER_LEG = 2
const V3_TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 }
// Same guard as localQuote: a pool whose in-range depth isn't 10x the input is priced at a
// fantasy rate (a drained pool parked off-market quotes GREAT and pays nothing).
const DEPTH_SAFETY = 10n
const STATE_TTL_MS = 12_000
const NEGATIVE_TTL_MS = 60_000

const lower = address => address.toLowerCase()
const WETH_NODE = lower(WETH)
const node = address => {
  const key = lower(address)
  return key === ETH_ADDRESS ? WETH_NODE : key
}

// A screen is a few loops over every candidate's pools. Hub detection runs them over every token
// paired with both anchors (thousands of pools) in the background, and without pauses that held
// the main thread long enough to feel while scrolling or typing. The pauses are timed rather than
// counted: a slow phone takes more of them, and a quote's few dozen candidates on a fast machine
// take none.
const breathe = () => new Promise(resolve => setTimeout(resolve, 0))
const SLICE_MS = 8
function pacer() {
  let since = performance.now()
  return {
    due: () => performance.now() - since >= SLICE_MS,
    async rest() {
      await breathe()
      since = performance.now()
    },
    // After waiting on the network: that time was not spent holding the thread.
    restart() { since = performance.now() },
  }
}

// A call answered with at least `words` 32-byte words.
const answered = (result, words) => Boolean(result?.success) && result.data.length >= words * 64

// ---------------------------------------------------------------- pool addresses

const addressCache = new Map()   // 'v2|a-b' / 'v3|a-b|fee' -> { address, at }

function cachedAddress(key) {
  const hit = addressCache.get(key)
  if (!hit) return undefined
  if (!hit.address && Date.now() - hit.at > NEGATIVE_TTL_MS) {
    addressCache.delete(key)
    return undefined
  }
  return hit.address
}

async function resolveV2V3Pools(edges, feed, pace) {
  const lookups = []
  for (const { a, b } of edges) {
    if (pace.due()) await pace.rest()
    const [x, y] = [a, b].sort()
    const v2Key = `v2|${x}-${y}`
    if (cachedAddress(v2Key) === undefined && !feedV2Pair(feed, a, b)) {
      lookups.push({ key: v2Key, target: V2_FACTORY, data: GET_PAIR + addressWord(a) + addressWord(b) })
    }
    for (const fee of FEE_TIERS) {
      const v3Key = `v3|${x}-${y}|${fee}`
      if (cachedAddress(v3Key) === undefined && !feedV3Pools(feed, a, b).some(p => p.fee === fee)) {
        lookups.push({ key: v3Key, target: POOL_FACTORY, data: GET_POOL + addressWord(a) + addressWord(b) + uintWord(fee) })
      }
    }
  }
  const unique = [...new Map(lookups.map(l => [l.key, l])).values()]
  if (unique.length) {
    const results = await readCalls(unique)
    pace.restart()
    unique.forEach((l, i) => {
      const r = results[i]
      // A failed call is a transport problem, not an answer — leave it uncached so it's retried.
      if (!answered(r, WORDS.address)) return
      const found = `0x${r.data.slice(24, 64)}`.toLowerCase()
      addressCache.set(l.key, { address: found !== ETH_ADDRESS ? found : null, at: Date.now() })
    })
  }
}

// `a` and `b` are graph nodes (lowercase, ETH folded into WETH).
export function poolsForEdge(a, b, feed) {
  const pools = []
  const [x, y] = [a, b].sort()
  const token0 = x
  const v2 = feedV2Pair(feed, a, b)?.pair ?? cachedAddress(`v2|${x}-${y}`)
  if (v2) pools.push({ kind: 0, key: `0:${v2}`, address: v2, token0, fee: 3000 })

  const v3ByFee = new Map(feedV3Pools(feed, a, b).map(p => [p.fee, p.pool]))
  for (const fee of FEE_TIERS) {
    const address = v3ByFee.get(fee) ?? cachedAddress(`v3|${x}-${y}|${fee}`)
    if (address) v3ByFee.set(fee, address)
  }
  for (const [fee, address] of v3ByFee) {
    if (address) {
      pools.push({ kind: 1, key: `1:${address}`, address, token0, token1: y, fee, tickSpacing: V3_TICK_SPACING[fee] ?? 1 })
    }
  }

  // A pool between a and b is in both tokens' lists, so the shorter one is walked. WETH's list is
  // nearly every V4 pool there is (~10k); walking it once per transit candidate was most of a
  // quote's main-thread time, and the candidate's own list is a handful.
  const fromA = feedV4PoolsFor(feed, a)
  const fromB = feedV4PoolsFor(feed, b)
  const [list, far] = fromA.length <= fromB.length ? [fromA, b] : [fromB, a]
  for (const pool of list) {
    const node0 = node(pool.currency0)
    const node1 = node(pool.currency1)
    if (node0 !== far && node1 !== far) continue
    const poolId = v4PoolIdOf(pool)
    pools.push({
      kind: 2, key: `2:${poolId}`, poolId, token0: node0,
      fee: Number(pool.fee), tickSpacing: Number(pool.tickSpacing), v4: pool,
    })
  }
  return pools
}

// ---------------------------------------------------------------- pool state

const stateCache = new Map()   // pool key -> { at, state }

async function fetchStates(pools, pace) {
  const fresh = key => {
    const hit = stateCache.get(key)
    return hit && Date.now() - hit.at <= STATE_TTL_MS ? hit.state : undefined
  }
  const missing = [...new Map(pools.filter(p => fresh(p.key) === undefined).map(p => [p.key, p])).values()]
  if (missing.length) {
    const calls = []
    const slots = []
    for (const p of missing) {
      if (pace.due()) await pace.rest()
      const at = calls.length
      if (p.kind === 0) {
        calls.push({ target: p.address, data: GET_RESERVES })
        slots.push({ p, at, liq: -1, words: WORDS.reserves })
      } else if (p.kind === 1) {
        calls.push({ target: p.address, data: SLOT0 })
        calls.push({ target: p.address, data: LIQUIDITY })
        slots.push({ p, at, liq: at + 1, words: WORDS.slot0 })
      } else {
        calls.push({ target: STATE_VIEW, data: GET_SLOT0 + p.poolId.slice(2) })
        calls.push({ target: STATE_VIEW, data: GET_LIQUIDITY + p.poolId.slice(2) })
        slots.push({ p, at, liq: at + 1, words: WORDS.v4Slot0 })
      }
    }
    const results = await readCalls(calls)
    pace.restart()
    for (const { p, at, liq, words } of slots) {
      if (pace.due()) await pace.rest()
      if (!answered(results[at], words)) continue
      let state = null
      if (p.kind === 0) {
        const reserve0 = resultWord(results[at].data, 0)
        const reserve1 = resultWord(results[at].data, 1)
        if (reserve0 > 0n && reserve1 > 0n) state = { reserve0, reserve1 }
      } else if (answered(results[liq], WORDS.liquidity)) {
        const sqrtPriceX96 = resultWord(results[at].data, 0)
        const liquidity = resultWord(results[liq].data, 0)
        if (sqrtPriceX96 > 0n && liquidity > 0n) state = { sqrtPriceX96, liquidity }
      }
      // `null` = read fine, pool is empty — cache it too, so an empty pool isn't re-read per quote.
      stateCache.set(p.key, { at: Date.now(), state })
    }
  }
  return new Map(pools.map(p => [p.key, fresh(p.key) ?? null]))
}

// ---------------------------------------------------------------- pricing

// `guarded` applies the depth rule. Unguarded numbers are pure optimism — a pool parked far off
// market scores huge — and are only ever used to NOMINATE corridors for a real quote, because
// that same "too thin to trust" shape is also what a genuinely mispriced pool looks like (verified
// on-chain: 0.005 WETH → 0xD1 → USDC paid 22,451 USDC through a pool the depth rule rejects).
function poolOut(pool, state, fromNode, amountIn, guarded = true) {
  if (!state || amountIn <= 0n) return 0n
  const zeroForOne = pool.token0 === fromNode
  if (pool.kind === 0) {
    const [rIn, rOut] = zeroForOne ? [state.reserve0, state.reserve1] : [state.reserve1, state.reserve0]
    if (guarded && rIn < amountIn * DEPTH_SAFETY) return 0n
    return v2AmountOut(amountIn, rIn, rOut)
  }
  const res = v3AmountOut({ ...state, fee: pool.fee, tickSpacing: pool.tickSpacing }, amountIn, zeroForOne)
  if (!res || (guarded && res.depthIn < amountIn * DEPTH_SAFETY)) return 0n
  return res.amountOut
}

const byOutDesc = (p, q) => (q.out > p.out ? 1 : q.out < p.out ? -1 : 0)

function rankEdge(pools, states, fromNode, amountIn, guarded = true) {
  return pools
    .map(pool => ({ pool, out: poolOut(pool, states.get(pool.key), fromNode, amountIn, guarded) }))
    .filter(r => r.out > 0n)
    .sort(byOutDesc)
}

const bestLocalOut = (pools, states, fromNode, amountIn, guarded = true) =>
  rankEdge(pools, states, fromNode, amountIn, guarded)[0]?.out ?? 0n

// One real quoter call for a single pool. V2 needs none — the constant-product math on fresh
// reserves IS what the pair pays. A revert (drained pool, amount past its liquidity) prices at 0,
// and so does a swap whose gas estimate no transaction could carry (see MAX_ROUTE_GAS).
async function quotedPoolOut(pool, state, fromNode, amountIn) {
  if (pool.kind === 0) return poolOut(pool, state, fromNode, amountIn)
  try {
    if (pool.kind === 1) {
      const tokenOut = fromNode === pool.token0 ? pool.token1 : pool.token0
      const { result } = await client.simulateContract({
        address: QUOTER_V2, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: fromNode, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
      })
      return overRouteGasBudget(result[3]) ? 0n : result[0]
    }
    const { currency0, currency1, fee, tickSpacing, hooks } = pool.v4
    const { result } = await client.simulateContract({
      address: V4_QUOTER, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle',
      args: [{
        poolKey: { currency0, currency1, fee, tickSpacing, hooks },
        zeroForOne: node(currency0) === fromNode,
        exactAmount: amountIn,
        hookData: '0x',
      }],
    })
    return overRouteGasBudget(result[1]) ? 0n : result[0]
  } catch {
    return 0n
  }
}

// Real quotes on the leg's most promising pools: the best trusted (depth-guarded) ones plus the
// best optimistic one, so a mispriced thin pool gets its chance to prove itself.
async function quotedEdgeOut(pools, states, fromNode, amountIn) {
  const picks = new Map()
  for (const r of rankEdge(pools, states, fromNode, amountIn).slice(0, VERIFY_POOLS_PER_LEG)) picks.set(r.pool.key, r.pool)
  for (const r of rankEdge(pools, states, fromNode, amountIn, false).slice(0, 1)) picks.set(r.pool.key, r.pool)
  if (!picks.size) return 0n
  const outs = await Promise.all([...picks.values()].map(pool => quotedPoolOut(pool, states.get(pool.key), fromNode, amountIn)))
  return outs.reduce((best, out) => (out > best ? out : best), 0n)
}

/**
 * Prices every A→X→B corridor for the given candidates (and the direct A→B baseline) and returns
 * them best-first. Local math ranks all of them; the top VERIFY_TOP are then re-priced with the
 * real quoters, and only those can be `beatsDirect`. `out` is in tokenOut base units at the
 * screening slice — comparable across corridors and against `directOut`, never a display amount.
 */
export async function screenCorridors({ addrIn, addrOut, amountRaw, candidates, feed }) {
  const a = node(addrIn)
  const b = node(addrOut)
  const probe = BigInt(amountRaw) / SCREEN_SHARE_DIVISOR || 1n
  const xs = [...new Set(candidates.map(node))].filter(x => x !== a && x !== b)

  const pace = pacer()
  const edgeList = [{ a, b }, ...xs.flatMap(x => [{ a, b: x }, { a: x, b }])]
  await resolveV2V3Pools(edgeList, feed, pace)

  const direct = poolsForEdge(a, b, feed)
  const legs = []
  for (const x of xs) {
    if (pace.due()) await pace.rest()
    legs.push({ x, first: poolsForEdge(a, x, feed), second: poolsForEdge(x, b, feed) })
  }
  const states = await fetchStates([...direct, ...legs.flatMap(l => [...l.first, ...l.second])], pace)

  const localOut = (leg, guarded) => {
    const mid = bestLocalOut(leg.first, states, a, probe, guarded)
    return mid > 0n ? bestLocalOut(leg.second, states, leg.x, mid, guarded) : 0n
  }
  // Every corridor that pays, best first — with or without the depth rule.
  const ranked = async guarded => {
    const paying = []
    for (const leg of legs) {
      if (pace.due()) await pace.rest()
      const out = localOut(leg, guarded)
      if (out > 0n) paying.push({ ...leg, out })
    }
    return paying.sort(byOutDesc)
  }
  const local = await ranked(true)
  // Verification set: the trusted leaders, plus the corridors only optimism likes.
  const optimistic = (await ranked(false)).slice(0, VERIFY_OPTIMISTIC)
  const toVerify = [...new Map([...local.slice(0, VERIFY_TOP), ...optimistic].map(leg => [leg.x, leg])).values()]
  const verifiedSet = new Set(toVerify.map(leg => leg.x))

  const [quotedDirect, verified] = await Promise.all([
    quotedEdgeOut(direct, states, a, probe),
    Promise.all(toVerify.map(async leg => {
      const mid = await quotedEdgeOut(leg.first, states, a, probe)
      const out = mid > 0n ? await quotedEdgeOut(leg.second, states, leg.x, mid) : 0n
      return { address: leg.x, out, localOut: leg.out, verified: true }
    })),
  ])
  // If every direct quote failed (RPC trouble), fall back to the local baseline rather than let
  // any corridor "beat" a zero.
  const directOut = quotedDirect > 0n ? quotedDirect : bestLocalOut(direct, states, a, probe)

  const corridors = [
    ...verified.filter(c => c.out > 0n).sort(byOutDesc).map(c => ({ ...c, beatsDirect: c.out > directOut })),
    ...local.filter(leg => !verifiedSet.has(leg.x)).map(leg => ({
      address: leg.x, out: leg.out, localOut: leg.out, verified: false, beatsDirect: false,
    })),
  ]

  // Local math liked these, the quoters paid nothing: drained or off-range pools.
  const rejected = verified.filter(c => c.out === 0n).map(c => c.address)

  return { directOut, corridors, rejected, probe }
}
