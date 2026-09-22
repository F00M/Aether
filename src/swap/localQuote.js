// Local pricing — the "calculator" half of the quote.
//
// The engine's quoter path costs one eth_call per (pool, amount) pair, so the
// split optimizer's many amount probes dominate the RPC bill and make every
// keystroke wait on the network. This module instead reads pool STATE once
// (reserves / sqrtPrice+liquidity, one Multicall3 batch) and then computes any
// amount in JS for free.
//
// Scope, deliberately: this powers the INSTANT PROVISIONAL number only. The
// authoritative quote still comes from the engine, and execution still goes
// through findExecutableAetherParams' real execute() simulation. Nothing here
// can put a wrong number on-chain.
//
// Accuracy:
//   V2      exact — same constant-product formula the pair contract runs.
//   V3/V4   exact WHILE the swap stays inside the current tick range. Crossing
//           an initialized tick changes L, which needs tick bitmap data we do
//           not fetch, so those results are flagged `approx` instead of hidden.

import { keccak256, encodeAbiParameters } from 'viem'

import { client, discoverV4PoolsForCurrency } from './quoteProviders'
import { poolAbi, v2FactoryAbi, v2PairAbi } from './quoteAbis'
import { ETH_ADDRESS, FEE_TIERS, POOL_FACTORY, V2_FACTORY, V4_POOLS, WETH } from './quoteConfig'

const Q96 = 2n ** 96n

// Uniswap V4 exposes pool state through a periphery lens rather than the
// PoolManager itself.
const STATE_VIEW = '0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C'

const stateViewAbi = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] },
  { name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint128' }] },
]

const v3PoolAbi = [
  ...poolAbi,
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint128' }] },
]

const v3FactoryAbi = [
  { name: 'getPool', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
    outputs: [{ type: 'address' }] },
]

/* ------------------------------------------------------------------ math */

/** Constant product with the 0.30% pair fee. Exact. */
export function v2AmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const inWithFee = amountIn * 997n
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee)
}

/** Approximate tick of a sqrtPriceX96, good enough to detect a range crossing. */
function tickOf(sqrtPriceX96) {
  const ratio = Number(sqrtPriceX96) / Number(Q96)
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  return Math.floor(Math.log(ratio * ratio) / Math.log(1.0001))
}

/**
 * Concentrated-liquidity swap along a single tick range.
 * `fee` is in hundredths of a bip (3000 = 0.30%), matching the pool key.
 */
export function v3AmountOut({ sqrtPriceX96, liquidity, fee, tickSpacing }, amountIn, zeroForOne) {
  if (amountIn <= 0n || liquidity <= 0n || sqrtPriceX96 <= 0n) return null

  const afterFee = (amountIn * BigInt(1_000_000 - fee)) / 1_000_000n
  if (afterFee <= 0n) return null

  let sqrtNext
  let amountOut

  if (zeroForOne) {
    // token0 in → price falls. sqrtNext = L·Q96·sqrtP / (L·Q96 + in·sqrtP)
    const denominator = liquidity * Q96 + afterFee * sqrtPriceX96
    if (denominator <= 0n) return null
    sqrtNext = (liquidity * Q96 * sqrtPriceX96) / denominator
    amountOut = (liquidity * (sqrtPriceX96 - sqrtNext)) / Q96
  } else {
    // token1 in → price rises. sqrtNext = sqrtP + in·Q96/L
    sqrtNext = sqrtPriceX96 + (afterFee * Q96) / liquidity
    if (sqrtNext <= sqrtPriceX96) return null
    amountOut = (liquidity * Q96 * (sqrtNext - sqrtPriceX96)) / (sqrtNext * sqrtPriceX96)
  }

  if (amountOut <= 0n) return null

  // Virtual reserve of the INPUT side inside the current range — the same measure
  // the arb indexer gates on. In-range math is only trustworthy while the trade is
  // small against this; beyond it the swap leaves the range we can actually see.
  const depthIn = zeroForOne
    ? (liquidity * Q96) / sqrtPriceX96   // token0
    : (liquidity * sqrtPriceX96) / Q96   // token1

  // Past one tick spacing the real curve may have picked up or dropped liquidity
  // we never read, so the number stops being exact.
  const moved = Math.abs(tickOf(sqrtNext) - tickOf(sqrtPriceX96))
  const approx = moved > Math.max(tickSpacing || 1, 1)

  return { amountOut, approx, tickMoved: moved, depthIn }
}

/**
 * A pool whose visible in-range depth is not comfortably larger than the trade
 * cannot be priced locally: the swap would exit the range we read and the number
 * becomes fiction — usually fiction that looks GREAT, because a drained pool
 * sitting at an off-market price quotes an amazing rate it can never pay.
 */
const DEPTH_SAFETY = 10n
const depthSufficient = (depthIn, amountIn) => depthIn >= amountIn * DEPTH_SAFETY

/* ------------------------------------------------- pool key / discovery */

const POOL_KEY_COMPONENTS = [
  { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
]

/** V4 pools are addressed by keccak(PoolKey), not by a contract address. */
export function v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }) {
  return keccak256(
    encodeAbiParameters(POOL_KEY_COMPONENTS, [
      currency0, currency1, Number(fee), Number(tickSpacing), hooks ?? ETH_ADDRESS,
    ]),
  )
}

const asErc20 = token => (token.address === 'ETH' ? WETH : token.address)

/**
 * Direct V2/V3 pools for a pair. One Multicall3 round trip for the factory
 * lookups; results are cached for the session because addresses never change.
 */
const directPoolCache = new Map()

async function findDirectPools(tokenIn, tokenOut) {
  const a = asErc20(tokenIn)
  const b = asErc20(tokenOut)
  const key = [a.toLowerCase(), b.toLowerCase()].sort().join('-')
  const cached = directPoolCache.get(key)
  if (cached) return cached

  const contracts = [
    { address: V2_FACTORY, abi: v2FactoryAbi, functionName: 'getPair', args: [a, b] },
    ...FEE_TIERS.map(fee => ({
      address: POOL_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [a, b, fee],
    })),
  ]

  let results
  try {
    results = await client.multicall({ contracts, allowFailure: true })
  } catch {
    return []
  }

  const pools = []
  results.forEach((r, i) => {
    if (r.status !== 'success') return
    const addr = r.result
    if (!addr || addr.toLowerCase() === ETH_ADDRESS) return
    if (i === 0) pools.push({ kind: 0, address: addr })
    else pools.push({ kind: 1, address: addr, fee: FEE_TIERS[i - 1] })
  })

  directPoolCache.set(key, pools)
  return pools
}

/* ------------------------------------------------------------ state read */

// Pool state moves every block. Short enough that a stale snapshot can't linger
// behind a real trade, long enough that typing digits never refetches.
const STATE_TTL_MS = 12_000
const stateCache = new Map() // poolKey -> { at, state }

function cachedState(key) {
  const hit = stateCache.get(key)
  if (!hit || Date.now() - hit.at > STATE_TTL_MS) return null
  return hit.state
}

/** Reads reserves / sqrtPrice+liquidity for every pool in ONE Multicall3 batch. */
async function fetchStates(pools) {
  const missing = pools.filter(p => !cachedState(p.key))

  if (missing.length) {
    const contracts = []
    const slots = []   // one entry per pool, holding the indices of its calls

    for (const p of missing) {
      const at = contracts.length
      if (p.kind === 0) {
        contracts.push({ address: p.address, abi: v2PairAbi, functionName: 'getReserves' })
        slots.push({ pool: p, priceIdx: at, liqIdx: -1 })
      } else if (p.kind === 1) {
        contracts.push({ address: p.address, abi: v3PoolAbi, functionName: 'slot0' })
        contracts.push({ address: p.address, abi: v3PoolAbi, functionName: 'liquidity' })
        slots.push({ pool: p, priceIdx: at, liqIdx: at + 1 })
      } else {
        contracts.push({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [p.poolId] })
        contracts.push({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [p.poolId] })
        slots.push({ pool: p, priceIdx: at, liqIdx: at + 1 })
      }
    }

    let results = []
    try {
      results = await client.multicall({ contracts, allowFailure: true })
    } catch {
      results = []
    }

    const ok = i => i >= 0 && results[i]?.status === 'success'

    for (const { pool, priceIdx, liqIdx } of slots) {
      if (!ok(priceIdx)) continue

      if (pool.kind === 0) {
        const reserves = results[priceIdx].result
        const r0 = BigInt(reserves[0] ?? 0)
        const r1 = BigInt(reserves[1] ?? 0)
        if (r0 <= 0n || r1 <= 0n) continue
        stateCache.set(pool.key, { at: Date.now(), state: { kind: 0, reserve0: r0, reserve1: r1 } })
        continue
      }

      if (!ok(liqIdx)) continue
      const slot0 = results[priceIdx].result
      const sqrtPriceX96 = BigInt(Array.isArray(slot0) ? slot0[0] : slot0)
      const liquidity = BigInt(results[liqIdx].result)
      if (sqrtPriceX96 <= 0n || liquidity <= 0n) continue
      stateCache.set(pool.key, { at: Date.now(), state: { kind: pool.kind, sqrtPriceX96, liquidity } })
    }
  }

  return pools.map(p => ({ pool: p, state: cachedState(p.key) })).filter(x => x.state)
}

/* -------------------------------------------------------------- estimate */

/**
 * V4 pools touching either side.
 *
 * Two sources, because the engine uses both: the curated V4_POOLS list in
 * quoteConfig (which is what the main pairs actually route through — the
 * Initialize-event cache stays cold for them), plus event discovery for
 * anything long-tail. `background: true` keeps the latter from ever blocking:
 * a cold cache returns [] and warms itself for the next quote.
 */
async function collectV4Pools(tokenIn, tokenOut) {
  const currencies = [tokenIn, tokenOut]
    .map(t => (t.address === 'ETH' ? ETH_ADDRESS : t.address))
    .filter(a => a.toLowerCase() !== ETH_ADDRESS)

  const discovered = await Promise.all(
    [...new Set(currencies)].map(c =>
      discoverV4PoolsForCurrency(c, { background: true }).catch(() => []),
    ),
  )

  const seen = new Set()
  const out = []
  for (const pool of [...V4_POOLS, ...discovered.flat()]) {
    if (!pool?.currency0 || !pool?.currency1) continue
    const id = `${pool.currency0.toLowerCase()}-${pool.currency1.toLowerCase()}-${pool.fee}-${pool.tickSpacing}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(pool)
  }
  return out
}

/**
 * Best single-pool output computed locally.
 *
 * Returns null when nothing is priceable, so callers just fall through to the
 * normal engine path.
 */
export async function localEstimate({ tokenIn, tokenOut, amountIn, raw = false }) {
  if (!amountIn || amountIn <= 0n) return null

  const inAddr = asErc20(tokenIn).toLowerCase()
  const outAddr = asErc20(tokenOut).toLowerCase()
  if (inAddr === outAddr) return null

  const [direct, v4Pools] = await Promise.all([
    findDirectPools(tokenIn, tokenOut),
    collectV4Pools(tokenIn, tokenOut),
  ])

  const candidates = direct.map(p => ({
    ...p,
    key: `${p.kind}:${p.address.toLowerCase()}`,
    // V2/V3 order token0 by address; that decides the swap direction.
    zeroForOne: inAddr < outAddr,
    fee: p.fee ?? 3000,
    tickSpacing: 60,
  }))

  for (const p of v4Pools) {
    const c0 = p.currency0.toLowerCase()
    const c1 = p.currency1.toLowerCase()
    // V4 quotes native ETH as the zero address; map it back to WETH to match.
    const n0 = c0 === ETH_ADDRESS ? WETH.toLowerCase() : c0
    const n1 = c1 === ETH_ADDRESS ? WETH.toLowerCase() : c1
    if (!((n0 === inAddr && n1 === outAddr) || (n0 === outAddr && n1 === inAddr))) continue
    const poolId = v4PoolId(p)
    candidates.push({
      kind: 2,
      poolId,
      key: `2:${poolId}`,
      fee: Number(p.fee),
      tickSpacing: Number(p.tickSpacing),
      zeroForOne: n0 === inAddr,
    })
  }

  if (!candidates.length) return null

  const priced = await fetchStates(candidates)
  if (!priced.length) return null

  const debug = globalThis.__AETHER_LOCAL_DEBUG ? [] : null
  const usable = []

  for (const { pool, state } of priced) {
    if (state.kind === 0) {
      const [rIn, rOut] = pool.zeroForOne
        ? [state.reserve0, state.reserve1]
        : [state.reserve1, state.reserve0]
      const out = v2AmountOut(amountIn, rIn, rOut)
      debug?.push({ kind: 0, fee: 'v2', out: out.toString(), deep: rIn >= amountIn * DEPTH_SAFETY })
      if (out > 0n && rIn >= amountIn * DEPTH_SAFETY) {
        usable.push({ amountOut: out, approx: false, kind: 0, fee: 3000 })
      }
    } else {
      const res = v3AmountOut(
        { ...state, fee: pool.fee, tickSpacing: pool.tickSpacing },
        amountIn,
        pool.zeroForOne,
      )
      const deep = res ? depthSufficient(res.depthIn, amountIn) : false
      debug?.push({
        kind: state.kind, fee: pool.fee, out: res ? res.amountOut.toString() : null, deep,
      })
      if (res && deep && res.amountOut > 0n) {
        usable.push({ amountOut: res.amountOut, approx: res.approx, kind: state.kind, fee: pool.fee })
      }
    }
  }

  if (debug) {
    console.log('[local] candidates', candidates.length, 'priced', priced.length, debug)
  }

  if (!usable.length) return null

  // CONSENSUS, not maximum.
  //
  // Sepolia pools are not arbitraged, so any given pool can sit far off market
  // while still holding real depth. Picking the best-quoting pool therefore picks
  // the most mispriced one — measured live at 2.3x the executable number. The
  // median across pools quoting the same pair is the honest central estimate, and
  // it is immune to a broken pool in either direction.
  usable.sort((a, b) => (a.amountOut < b.amountOut ? -1 : a.amountOut > b.amountOut ? 1 : 0))
  const mid = usable[Math.floor((usable.length - 1) / 2)]

  if (raw) return { ...mid, sampled: usable.length }

  // Uncalibrated numbers are ~17% off, which would make the display jump every
  // time the real quote lands. Callers show the estimate only when it's calibrated.
  const bps = calibration.get(directionKey(tokenIn, tokenOut))
  if (!bps) return { ...mid, sampled: usable.length, calibrated: false }

  return {
    ...mid,
    amountOut: (mid.amountOut * bps) / 10_000n,
    sampled: usable.length,
    calibrated: true,
  }
}

/* ----------------------------------------------------------- calibration */

// The median pool is the TYPICAL price; the engine returns the BEST price after
// splitting. On unarbitraged testnet pools that spread is wide — measured at a
// steady 17-18% across a 2.5x range of trade sizes. Steady is the useful part:
// one ratio per direction, learned from the engine's own answer, closes it.
//
// Basis points, bigint throughout, so no float drift creeps into a displayed
// amount. Cleared with the state cache.
const calibration = new Map()

const directionKey = (tokenIn, tokenOut) =>
  `${asErc20(tokenIn).toLowerCase()}->${asErc20(tokenOut).toLowerCase()}`

/**
 * Teaches the estimator what the engine actually paid for this direction.
 * Called once per completed scan; costs nothing because pool state is cached.
 */
export async function calibrateLocal({ tokenIn, tokenOut, amountIn, engineOut }) {
  try {
    if (!engineOut || engineOut <= 0n) return
    const raw = await localEstimate({ tokenIn, tokenOut, amountIn, raw: true })
    if (!raw || raw.amountOut <= 0n) return
    const sample = (engineOut * 10_000n) / raw.amountOut
    // Ignore absurd ratios — a 10x gap means the sample was garbage, not a bias.
    if (sample < 1_000n || sample > 100_000n) return

    // Smooth instead of overwrite. The engine occasionally lands a one-off route
    // far above trend (measured: one amount paid 46.7k/ETH against a ~28.5k
    // baseline). Letting that single scan set the ratio would inflate every later
    // estimate, so a new sample only moves it 30% of the way.
    const key = directionKey(tokenIn, tokenOut)
    const prev = calibration.get(key)
    calibration.set(key, prev ? (prev * 7n + sample * 3n) / 10n : sample)
  } catch { /* calibration is best-effort */ }
}

/** Drops every cached snapshot and learned ratio — call after a swap confirms. */
export function invalidateLocalState() {
  stateCache.clear()
  calibration.clear()
}
