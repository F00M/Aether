import { AETHER_AGGREGATOR } from './quoteConfig'

// The diamond's protocol fee (ConfigFacet.feeBps, capped at 100 = 1%). execute() keeps it from the
// output before paying the recipient, and since AetherSwapFacet 3.2.0 both its minAmountOut check
// and its return value are net of it. So every Aether amount that is shown, compared against
// another venue or sent as a minimum must be net as well. Read from the chain rather than
// configured, so the owner switching the fee on or off needs no frontend release.
const FEE_ABI = [
  { name: 'feeBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
]
const FEE_TTL_MS = 60_000

let feeBps = 0n
let loadedAt = 0
let inFlight = null

export function aetherFeeBps() {
  return feeBps
}

// Same rounding as the contract: the fee is floored, the recipient gets the rest.
export function netOfAetherFee(amount) {
  const gross = BigInt(amount)
  return gross - (gross * feeBps) / 10000n
}

// Resolves once the fee is current. A failed read keeps the last known value and is retried on the
// next call, so a flaky RPC never blocks a quote.
export function loadAetherFee(publicClient) {
  if (!publicClient || Date.now() - loadedAt < FEE_TTL_MS) return Promise.resolve(feeBps)
  inFlight ??= publicClient
    .readContract({ address: AETHER_AGGREGATOR, abi: FEE_ABI, functionName: 'feeBps' })
    .then(value => {
      feeBps = BigInt(value)
      loadedAt = Date.now()
    })
    .catch(() => {})
    .then(() => {
      inFlight = null
      return feeBps
    })
  return inFlight
}
