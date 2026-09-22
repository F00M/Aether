// Auto-detected bridge tokens ("hubs") — replaces the hand-maintained bridge list.
//
// A hub is a token the router can pass THROUGH on the way between the anchors without bleeding
// value. Pool count says nothing about that (measured 2026-09-22: the most-connected token on
// Sepolia, AUD with 301 pools, paid 0 as a corridor, and three of the four old hardcoded bridges
// — tBTC, SOL, PEPE — were dead). So every token that pairs with both WETH and USDC is scored by
// actually routing a trade through it, both ways:
//
//   score = min( out(WETH→X→USDC) / out(WETH→USDC),  out(USDC→X→WETH) / out(USDC→WETH) )
//
// The min matters: a mispriced pool pays 40x one way and nothing the other — great for one trade
// (the per-trade corridor screen still finds it) but useless as a standing hub. Tokens that keep
// at least MIN_HUB_SCORE of the direct rate in BOTH directions qualify; the best HUB_COUNT win.
//
// Detection runs in the background (throttled, persisted), so quotes never wait on it. Until the
// first result exists, SEED_BRIDGE_ADDRESSES stands in.
import { SEED_BRIDGE_ADDRESSES, USDC_ADDRESS, WETH } from './quoteConfig'
import { feedNeighbors, loadPoolFeed } from './poolFeed'
import { screenCorridors } from './corridorScreen'

const STORE_KEY = 'aether_auto_hubs_v1'
const HUB_COUNT = 5
const MIN_HUB_SCORE = 0.5
const REFRESH_MS = 10 * 60_000
// Representative size: 0.1 WETH (the screen prices a tenth of it), and the same value back in USDC.
const PROBE_WETH = 10n ** 17n
// The first pass prices every candidate with local math; this many leaders are re-screened so all
// of them get real quoter numbers before any is admitted.
const VERIFY_SHORTLIST = 12

const lower = address => address.toLowerCase()
const SEEDS = SEED_BRIDGE_ADDRESSES.map(lower)
const ANCHORS = new Set([lower(WETH), lower(USDC_ADDRESS)])

function load() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? 'null')
    return Array.isArray(parsed?.hubs) ? parsed : null
  } catch {
    return null
  }
}

function persist(value) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(value))
  } catch { /* unavailable — the in-memory copy still serves this session */ }
}

let state = load()   // { hubs: [address], scores: { address: score }, at }
let inflight = null
let lastAttemptAt = 0
// A detection that couldn't finish (cold feed, RPC trouble) is retried, but not on every quote.
const RETRY_MS = 60_000

/** Current bridge tokens (lowercase): auto-detected when available, the seed list before that. */
export function bridgeTokens() {
  return state?.hubs?.length ? state.hubs : SEEDS
}

/** For the console / debugging: where the list came from and each hub's score. */
export function autoHubStatus() {
  return {
    source: state?.hubs?.length ? 'auto' : 'seed',
    hubs: bridgeTokens(),
    scores: state?.scores ?? {},
    detectedAt: state?.at ? new Date(state.at).toISOString() : null,
  }
}
globalThis.aetherHubs = autoHubStatus

/** Kicks a background re-detection when the last one is older than REFRESH_MS. Never throws. */
export function refreshAutoHubs() {
  if (inflight || (state?.at && Date.now() - state.at < REFRESH_MS)) return inflight
  if (Date.now() - lastAttemptAt < RETRY_MS) return null
  lastAttemptAt = Date.now()
  inflight = detect()
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
}

async function scoreCorridors(candidates, feed) {
  const forward = await screenCorridors({
    addrIn: WETH, addrOut: USDC_ADDRESS, amountRaw: PROBE_WETH.toString(), candidates, feed,
  })
  if (!forward.directOut) return null
  const reverse = await screenCorridors({
    addrIn: USDC_ADDRESS, addrOut: WETH, amountRaw: (forward.directOut * 10n).toString(), candidates, feed,
  })
  if (!reverse.directOut) return null
  const ratio = (screen, address) => {
    const corridor = screen.corridors.find(c => c.address === address)
    return corridor ? Number((corridor.out * 10_000n) / screen.directOut) / 10_000 : 0
  }
  return new Map(candidates.map(address => [address, Math.min(ratio(forward, address), ratio(reverse, address))]))
}

async function detect() {
  const feed = await loadPoolFeed({ timeoutMs: 20_000 })
  if (!feed?.toBlock) return null

  const wethSide = feedNeighbors(feed, WETH)
  const usdcSide = feedNeighbors(feed, USDC_ADDRESS)
  const twoSided = [...usdcSide.keys()].filter(address => wethSide.has(address) && !ANCHORS.has(address))
  // Seeds and the current hubs are always re-evaluated, so a hub keeps its place only by earning it.
  const candidates = [...new Set([...twoSided, ...SEEDS, ...(state?.hubs ?? [])])]

  const rough = await scoreCorridors(candidates, feed)
  if (!rough) return null
  const shortlist = [...rough]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, VERIFY_SHORTLIST)
    .map(([address]) => address)
  const verified = shortlist.length ? await scoreCorridors(shortlist, feed) : new Map()
  if (!verified) return null

  const ranked = [...verified].sort((a, b) => b[1] - a[1])
  const hubs = ranked.filter(([, score]) => score >= MIN_HUB_SCORE).slice(0, HUB_COUNT).map(([address]) => address)
  state = {
    hubs,
    scores: Object.fromEntries(ranked.map(([address, score]) => [address, Number(score.toFixed(3))])),
    at: Date.now(),
  }
  persist(state)

  if (globalThis.__AETHER_DEBUG) {
    console.log('[dbg] auto hubs:', hubs.map(h => `${h.slice(0, 8)}=${state.scores[h]}`).join(' '),
      `| candidates ${candidates.length}, shortlisted ${shortlist.length}`)
  }
  return state
}
