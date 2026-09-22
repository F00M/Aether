// LI.FI as a second quote source — compared side by side with Aether's own split, and executable
// when it pays more.
//
// Sepolia specifics, all measured against the live API (2026-09):
//   • The Diamond is deployed at LIFI_DIAMOND; the only same-chain swap tool behind it is Fly,
//     whose router accepts nothing but calldata signed by Fly's backend — so LI.FI routes can only
//     ever be executed with calldata fetched from li.quest, never built locally.
//   • Native ETH ↔ blue chips (ETH/USDC) is refused ("positive price impact too high for blue chip
//     route"): the API prices testnet pools against MAINNET USD. The same pools are reachable as
//     WETH, so a native leg that gets no quote is retried as WETH with an explicit wrap / unwrap.
//   • Every quote carries LI.FI's fixed 0.25% fee, already deducted from toAmount.
//
// Like the Uniswap API path, nothing from the response is trusted blindly: the transaction must
// target the Diamond on Sepolia, the approval must name the Diamond, and the calldata is always
// re-fetched for the connected wallet (a quote fetched for the placeholder address would send the
// output to that address).
import { ETH_ADDRESS, WETH } from './quoteConfig'

export const LIFI_DIAMOND = '0xeCeC3970Ca674278DA8D9B1c484ACaF6B20181F5'
// In the browser, quotes go through the app's own proxy (src/app/api/lifi/quote), which adds the
// API key and integrator on the server so neither ships in the client bundle. Outside a browser
// (Node scripts) there's no app server to ask, so the public keyless API is called directly.
const LIFI_API = typeof window === 'undefined' ? 'https://li.quest/v1' : '/api/lifi'
const SEPOLIA_CHAIN_ID = 11155111
// Quotes need a `fromAddress`; without a connected wallet this stands in. Its calldata is never sent.
export const LIFI_QUOTE_PLACEHOLDER = '0x000000000000000000000000000000000000dEaD'
const LIFI_TIMEOUT_MS = 12_000

const lower = address => address?.toLowerCase?.() ?? ''
const lifiTokenAddress = token => (token.address === 'ETH' ? ETH_ADDRESS : token.address)

async function requestQuote({ fromToken, toToken, amountRaw, fromAddress, slippage }) {
  const params = new URLSearchParams({
    fromChain: String(SEPOLIA_CHAIN_ID),
    toChain: String(SEPOLIA_CHAIN_ID),
    fromToken,
    toToken,
    fromAmount: String(amountRaw),
    fromAddress,
    slippage: String(Number.parseFloat(slippage) / 100),
  })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LIFI_TIMEOUT_MS)
  try {
    const response = await fetch(`${LIFI_API}/quote?${params}`, { signal: ctrl.signal })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function normalizeQuote(json, attempt, tokenOut, fromAddress) {
  const tx = json.transactionRequest
  const estimate = json.estimate
  if (!tx?.to || !tx?.data || !estimate?.toAmount) return null
  // Allowlist, same stance as fetchUniswapApiSwap: never send funds to a target an API chose.
  if (lower(tx.to) !== lower(LIFI_DIAMOND)) throw new Error(`LI.FI quote targets unexpected contract ${tx.to}`)
  if (tx.chainId && Number(tx.chainId) !== SEPOLIA_CHAIN_ID) throw new Error(`LI.FI quote is for chain ${tx.chainId}`)
  const approvalAddress = estimate.approvalAddress ?? null
  if (approvalAddress && lower(approvalAddress) !== lower(LIFI_DIAMOND)) {
    throw new Error(`LI.FI quote asks to approve unexpected spender ${approvalAddress}`)
  }

  const toAmount = BigInt(estimate.toAmount)
  const feeCosts = (estimate.feeCosts ?? []).map(fee => ({
    name: fee.name,
    percentage: Number(fee.percentage ?? 0),
    included: fee.included !== false,
  }))
  const gasWei = (estimate.gasCosts ?? []).reduce((sum, gas) => sum + BigInt(gas.amount ?? 0), 0n)

  return {
    source: 'lifi',
    amountOut: toAmount.toString(),
    amountOutMin: String(estimate.toAmountMin ?? estimate.toAmount),
    amountOutFormatted: (Number(toAmount) / 10 ** tokenOut.decimals).toFixed(6),
    tool: json.toolDetails?.name ?? json.tool ?? 'LI.FI',
    toolKey: json.tool ?? null,
    steps: (json.includedSteps ?? []).map(step => ({
      type: step.type,
      tool: step.toolDetails?.name ?? step.tool,
    })),
    feeCosts,
    feePct: feeCosts.reduce((sum, fee) => sum + (fee.included ? fee.percentage : 0), 0),
    gasWei: gasWei.toString(),
    durationSec: Number(estimate.executionDuration ?? 0),
    approvalAddress,
    fromToken: attempt.fromToken,
    toToken: attempt.toToken,
    wrapInput: attempt.wrapInput,
    unwrapOutput: attempt.unwrapOutput,
    fromAddress,
    transactionRequest: {
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? 0),
      gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    },
    at: Date.now(),
  }
}

/**
 * Best LI.FI quote for the pair, or `{ unavailable: true, reason }` when LI.FI has no route.
 * `fromAddress` should be the connected wallet; without one the placeholder is used and the
 * result is display-only (`forWallet: false`).
 */
export async function fetchLifiQuote({ tokenIn, tokenOut, amountRaw, slippage, fromAddress }) {
  const from = fromAddress ?? LIFI_QUOTE_PLACEHOLDER
  const nativeIn = tokenIn.address === 'ETH'
  const nativeOut = tokenOut.address === 'ETH'
  const attempts = [{
    fromToken: lifiTokenAddress(tokenIn),
    toToken: lifiTokenAddress(tokenOut),
    wrapInput: false,
    unwrapOutput: false,
  }]
  if (nativeIn || nativeOut) {
    attempts.push({
      fromToken: nativeIn ? WETH : tokenIn.address,
      toToken: nativeOut ? WETH : tokenOut.address,
      wrapInput: nativeIn,
      unwrapOutput: nativeOut,
    })
  }

  let reason = 'No LI.FI route'
  for (const attempt of attempts) {
    let json
    try {
      json = await requestQuote({ ...attempt, amountRaw, fromAddress: from, slippage })
    } catch (error) {
      reason = error?.name === 'AbortError' ? 'LI.FI timed out' : 'LI.FI unreachable'
      continue
    }
    if (json?.transactionRequest && json?.estimate) {
      try {
        const quote = normalizeQuote(json, attempt, tokenOut, from)
        if (quote) return { ...quote, forWallet: Boolean(fromAddress) }
      } catch (error) {
        // An allowlist violation is a refusal, not a transport error — report it, don't retry.
        return { source: 'lifi', unavailable: true, reason: error.message, at: Date.now() }
      }
    }
    if (json?.message) reason = json.message
  }
  return { source: 'lifi', unavailable: true, reason, at: Date.now() }
}
