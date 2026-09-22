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
import { factoryAbi, poolAbi, quoterAbi, v2FactoryAbi, v2PairAbi, v4QuoterAbi } from './quoteAbis'
import { v2AmountOut, v3AmountOut, v4PoolId } from './localQuote'
import { feedV2Pair, feedV3Pools, feedV4PoolsFor } from './poolFeed'

const STATE_VIEW = '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C'
const stateViewAbi = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] },
  { name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint128' }] },
]
const v3PoolAbi = [
  ...poolAbi,
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
]

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
// Bytes of calldata per Multicall3 chunk. viem's 1KB default splits ~5 lookups per eth_call.
const MULTICALL_BATCH_BYTES = 16_384
const STATE_TTL_MS = 12_000
const NEGATIVE_TTL_MS = 60_000

const lower = address => address.toLowerCase()
const node = address => (lower(address) === ETH_ADDRESS ? lower(WETH) : lower(address))

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

async function resolveV2V3Pools(edges, feed) {
  const lookups = []
  for (const { a, b } of edges) {
    const [x, y] = [a, b].sort()
    const v2Key = `v2|${x}-${y}`
    if (cachedAddress(v2Key) === undefined && !feedV2Pair(feed, a, b)) {
      lookups.push({ key: v2Key, call: { address: V2_FACTORY, abi: v2FactoryAbi, functionName: 'getPair', args: [a, b] } })
    }
    for (const fee of FEE_TIERS) {
      const v3Key = `v3|${x}-${y}|${fee}`
      if (cachedAddress(v3Key) === undefined && !feedV3Pools(feed, a, b).some(p => p.fee === fee)) {
        lookups.push({ key: v3Key, call: { address: POOL_FACTORY, abi: factoryAbi, functionName: 'getPool', args: [a, b, fee] } })
      }
    }
  }
  const unique = [...new Map(lookups.map(l => [l.key, l])).values()]
  if (unique.length) {
    const results = await client.multicall({
      contracts: unique.map(l => l.call), allowFailure: true, batchSize: MULTICALL_BATCH_BYTES,
    }).catch(() => [])
    unique.forEach((l, i) => {
      const r = results[i]
      // A failed call is a transport problem, not an answer — leave it uncached so it's retried.
      if (r?.status !== 'success') return
      const address = r.result && lower(r.result) !== ETH_ADDRESS ? lower(r.result) : null
      addressCache.set(l.key, { address, at: Date.now() })
    })
  }
}

// `a` and `b` are graph nodes (lowercase, ETH folded into WETH).
function poolsForEdge(a, b, feed) {
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

  for (const pool of feedV4PoolsFor(feed, a)) {
    const other = node(pool.currency0) === a ? node(pool.currency1) : node(pool.currency0)
    if (other !== b) continue
    const poolId = v4PoolId(pool)
    pools.push({
      kind: 2, key: `2:${poolId}`, poolId, token0: node(pool.currency0),
      fee: Number(pool.fee), tickSpacing: Number(pool.tickSpacing), v4: pool,
    })
  }
  return pools
}

// ---------------------------------------------------------------- pool state

const stateCache = new Map()   // pool key -> { at, state }

async function fetchStates(pools) {
  const fresh = key => {
    const hit = stateCache.get(key)
    return hit && Date.now() - hit.at <= STATE_TTL_MS ? hit.state : undefined
  }
  const missing = [...new Map(pools.filter(p => fresh(p.key) === undefined).map(p => [p.key, p])).values()]
  if (missing.length) {
    const calls = []
    const slots = []
    for (const p of missing) {
      const at = calls.length
      if (p.kind === 0) {
        calls.push({ address: p.address, abi: v2PairAbi, functionName: 'getReserves' })
        slots.push({ p, at, liq: -1 })
      } else if (p.kind === 1) {
        calls.push({ address: p.address, abi: v3PoolAbi, functionName: 'slot0' })
        calls.push({ address: p.address, abi: v3PoolAbi, functionName: 'liquidity' })
        slots.push({ p, at, liq: at + 1 })
      } else {
        calls.push({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [p.poolId] })
        calls.push({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [p.poolId] })
        slots.push({ p, at, liq: at + 1 })
      }
    }
    const results = await client.multicall({ contracts: calls, allowFailure: true, batchSize: MULTICALL_BATCH_BYTES })
      .catch(() => [])
    const ok = i => i >= 0 && results[i]?.status === 'success'
    for (const { p, at, liq } of slots) {
      if (!ok(at)) continue
      let state = null
      if (p.kind === 0) {
        const [r0, r1] = results[at].result
        if (BigInt(r0) > 0n && BigInt(r1) > 0n) state = { reserve0: BigInt(r0), reserve1: BigInt(r1) }
      } else if (ok(liq)) {
        const slot0 = results[at].result
        const sqrtPriceX96 = BigInt(Array.isArray(slot0) ? slot0[0] : slot0)
        const liquidity = BigInt(results[liq].result)
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

  const edgeList = [{ a, b }, ...xs.flatMap(x => [{ a, b: x }, { a: x, b }])]
  await resolveV2V3Pools(edgeList, feed)

  const direct = poolsForEdge(a, b, feed)
  const legs = xs.map(x => ({ x, first: poolsForEdge(a, x, feed), second: poolsForEdge(x, b, feed) }))
  const states = await fetchStates([...direct, ...legs.flatMap(l => [...l.first, ...l.second])])

  const localOut = (leg, guarded) => {
    const mid = bestLocalOut(leg.first, states, a, probe, guarded)
    return mid > 0n ? bestLocalOut(leg.second, states, leg.x, mid, guarded) : 0n
  }
  const local = legs
    .map(leg => ({ ...leg, out: localOut(leg, true) }))
    .filter(c => c.out > 0n)
    .sort(byOutDesc)
  // Verification set: the trusted leaders, plus the corridors only optimism likes.
  const optimistic = legs
    .map(leg => ({ ...leg, out: localOut(leg, false) }))
    .filter(c => c.out > 0n)
    .sort(byOutDesc)
    .slice(0, VERIFY_OPTIMISTIC)
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
