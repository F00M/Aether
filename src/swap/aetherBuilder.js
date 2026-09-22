// Pure swap-encoding logic for the Aether aggregator + Universal Router.
// Extracted from SwapCard.jsx so the component holds only UI/state. No React here.
import { encodeFunctionData, encodePacked, encodeAbiParameters } from 'viem'
import { UNIVERSAL_ROUTER, resolveAddress, resolveCurrency, routeExecutionKey } from './quoteEngine'
import { AETHER_AGGREGATOR, DIRECT_POOL_LEGS, V2_ROUTER } from './quoteConfig'
import { TOKENS, getToken } from '../config/tokens'

const SLIPPAGE_OPTIONS   = ['0.1', '0.5', '1.0']
const PERMIT2            = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const WETH_ADDRESS      = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'
const ETH_ADDRESS        = '0x0000000000000000000000000000000000000000'
const MAX_UINT256        = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const MAX_UINT160        = BigInt('0xffffffffffffffffffffffffffffffffffffffff')
const PERMIT2_EXPIRATION = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365
const AETHER_PREFLIGHT_TIMEOUT_MS = 9000
// Real on-chain gas limits for a swap. Preflight runs through eth_call, which nodes allow ~50M gas,
// so without a limit it "passes" swaps no transaction can carry: Sepolia caps a transaction at
// 16,777,216 gas (EIP-7825), and tx 0x0b111e4d… (2026-09-22) preflighted fine, needed ~24.6M, and
// reverted out of gas when the wallet — unable to estimate it — fell back to 2M. Preflight now
// simulates within AETHER_GAS_BUDGET, so a set that only works with more gas fails HERE and the
// swap card rebuilds the split without it; the send uses our own estimate, padded, under the cap.
const AETHER_GAS_BUDGET = 12_000_000n
const TX_GAS_CAP = 16_777_216n
// Auto-slippage (mirrors Uniswap's "Auto"): preflight tries the user's min-out first, then
// progressively looser levels, executing at the FIRST that actually simulates. A swap that is
// executable at a higher tolerance (high price impact, thin/imbalanced pools, tiny rounding-
// fragile amounts) goes through instead of failing at a tight default. Trades that simulate at
// the user's slippage on the first try (extraBps = 0) are never widened, so best price is kept.
const AUTO_SLIPPAGE_EXTRA_BPS = [0n, 75n, 200n, 400n, 700n]
const UR_COMMANDS = {
  V3_SWAP_EXACT_IN: 0x00,
  PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
}
const SUPPORTED_UR_COMMANDS = new Set(Object.values(UR_COMMANDS))
const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: '06',
  SWAP_EXACT_IN: '07',
  SETTLE: '0b',
  SETTLE_ALL: '0c',
  TAKE: '0e',
  TAKE_ALL: '0f',
}
// V4 ActionConstants.OPEN_DELTA: tells TAKE to pull the full positive delta (entire swap
// output) rather than a fixed amount. Slippage is still enforced by the swap action's
// amountOutMinimum. A fixed take amount below the real output leaves an unsettled delta
// and reverts with CurrencyNotSettled().
const V4_OPEN_DELTA = 0n
// Universal Router Constants.CONTRACT_BALANCE: tells WRAP_ETH to wrap the router's entire
// native balance (the full swap proceeds) instead of a fixed amount, so nothing is stranded.
const UR_CONTRACT_BALANCE = 1n << 255n

const UNIVERSAL_ROUTER_ABI = [{
  name: 'execute', type: 'function', stateMutability: 'payable',
  inputs: [
    { name: 'commands', type: 'bytes'   },
    { name: 'inputs',   type: 'bytes[]' },
    { name: 'deadline', type: 'uint256' },
  ],
  outputs: [],
}]

const V2_ROUTER_ABI = [
  { name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }] },
  { name: 'swapExactETHForTokens', type: 'function', stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }] },
]

const ERC20_ABI = [
  { name: 'approve',   type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
]

const WETH_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
]

const PERMIT2_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token',      type: 'address' },
      { name: 'spender',    type: 'address' },
      { name: 'amount',     type: 'uint160' },
      { name: 'expiration', type: 'uint48'  },
    ],
    outputs: [] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'token',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount',     type: 'uint160' },
      { name: 'expiration', type: 'uint48'  },
      { name: 'nonce',      type: 'uint48'  },
    ] },
]

const AETHER_EXECUTE_PARAMS = {
  name: 'params',
  type: 'tuple',
  components: [
    { name: 'tokenIn',      type: 'address' },
    { name: 'tokenOut',     type: 'address' },
    { name: 'amountIn',     type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'recipient',    type: 'address' },
    { name: 'unwrapWeth',   type: 'bool' },
    { name: 'deadline',     type: 'uint256' },
    {
      name: 'routes',
      type: 'tuple[]',
      components: [
        { name: 'amountIn',     type: 'uint256' },
        { name: 'minAmountOut', type: 'uint256' },
        {
          name: 'legs',
          type: 'tuple[]',
          components: [
            { name: 'legType',      type: 'uint8' },
            { name: 'tokenIn',      type: 'address' },
            { name: 'tokenOut',     type: 'address' },
            { name: 'amountIn',     type: 'uint256' },
            { name: 'minAmountOut', type: 'uint256' },
            { name: 'target',       type: 'address' },
            { name: 'path',         type: 'bytes' },
            {
              name: 'v3Single',
              type: 'tuple',
              components: [
                { name: 'tokenIn',           type: 'address' },
                { name: 'tokenOut',          type: 'address' },
                { name: 'fee',               type: 'uint24' },
                { name: 'sqrtPriceLimitX96', type: 'uint160' },
              ],
            },
            { name: 'callData', type: 'bytes' },
            { name: 'value',    type: 'uint256' },
          ],
        },
      ],
    },
    { name: 'dustTokens', type: 'address[]' },
  ],
}

const AETHER_AGGREGATOR_ABI = [
  {
    name: 'execute', type: 'function', stateMutability: 'payable',
    inputs: [AETHER_EXECUTE_PARAMS],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  { name: 'v3Router', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'permit2', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'universalRouter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'weth', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  // Every custom error the diamond's facets can revert with, so viem decodes reverts by name.
  { name: 'ApproveFailed', type: 'error', inputs: [] },
  { name: 'DeadlineExpired', type: 'error', inputs: [] },
  { name: 'ExternalCallFailed', type: 'error', inputs: [{ name: 'reason', type: 'bytes' }] },
  { name: 'InsufficientOutput', type: 'error', inputs: [] },
  { name: 'InvalidAmount', type: 'error', inputs: [] },
  { name: 'InvalidRecipient', type: 'error', inputs: [] },
  { name: 'InvalidRoute', type: 'error', inputs: [] },
  { name: 'InvalidTarget', type: 'error', inputs: [] },
  { name: 'NativeTransferFailed', type: 'error', inputs: [] },
  { name: 'NotOwner', type: 'error', inputs: [] },
  { name: 'Paused', type: 'error', inputs: [] },
  { name: 'Reentered', type: 'error', inputs: [] },
  { name: 'TokenNotAllowed', type: 'error', inputs: [{ name: 'token', type: 'address' }] },
  { name: 'TransferFailed', type: 'error', inputs: [] },
  { name: 'UnexpectedNativeTransfer', type: 'error', inputs: [] },
  { name: "PoolSwapUnauthorized", type: 'error', inputs: [] },
  { name: "PoolSwapNothingOwed", type: 'error', inputs: [] },
  { name: "PoolSwapOverpay", type: 'error', inputs: [] },
  { name: "PoolDoesNotExist", type: 'error', inputs: [] },
  { name: "InsufficientLiquidity", type: 'error', inputs: [] },
]

// V3 calldata

function encodeSinglePath(addrIn, fee, addrOut) {
  return encodePacked(['address', 'uint24', 'address'], [addrIn, fee, addrOut])
}
function encodeMultiPath(addrIn, fee1, addrMid, fee2, addrOut) {
  return encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [addrIn, fee1, addrMid, fee2, addrOut])
}
function buildV3RouteInput({ route, addrIn, addrOut, amountOutMin, recipient, payerIsUser, isOutputETH }) {
  const path = route.type === 'multihop'
    ? encodeMultiPath(addrIn, route.fee, route.via, route.fee2, addrOut)
    : encodeSinglePath(addrIn, route.fee, addrOut)
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [isOutputETH ? UNIVERSAL_ROUTER : recipient, BigInt(route.amountIn), amountOutMin, path, payerIsUser]
  )
}

// V4 calldata
// Actions follow @uniswap/v4-sdk V4Planner values for Universal Router V4_SWAP.

function buildPoolKey(poolLike, suffix = '') {
  return {
    currency0:   poolLike[`currency0${suffix}`],
    currency1:   poolLike[`currency1${suffix}`],
    fee:         poolLike[`fee${suffix}`],
    tickSpacing: poolLike[`tickSpacing${suffix}`],
    hooks:       poolLike[`hooks${suffix}`],
  }
}

function buildPathKey(route, suffix, intermediateCurrency) {
  return {
    intermediateCurrency,
    fee:         route[`fee${suffix}`],
    tickSpacing: route[`tickSpacing${suffix}`],
    hooks:       route[`hooks${suffix}`],
    hookData:    '0x',
  }
}

function encodeV4SwapActions(route, amountIn, amountOutMin, currencyIn, currencyOut, options = {}) {
  const isMultiHop = route.type === 'v4_multihop'
  // Balance-relative mode (options.settleContractBalance): SETTLE the router's ACTUAL balance of
  // currencyIn first (CONTRACT_BALANCE), then swap the full credit (amountIn = OPEN_DELTA). Used
  // for the second leg of mixed routes, where the real intermediate amount routinely lands under
  // the quoted one (other routes in the same execute() move the same pools) — a fixed amountIn
  // there reverts the whole swap.
  const settleFirst = !!options.settleContractBalance
  const swapAmountIn = settleFirst ? V4_OPEN_DELTA : BigInt(amountIn)
  const swapParams = isMultiHop
    ? encodeAbiParameters(
      [{
        type: 'tuple', components: [
          { name: 'currencyIn', type: 'address' },
          { name: 'path', type: 'tuple[]', components: [
            { name: 'intermediateCurrency', type: 'address' },
            { name: 'fee',                  type: 'uint24'  },
            { name: 'tickSpacing',          type: 'int24'   },
            { name: 'hooks',                type: 'address' },
            { name: 'hookData',             type: 'bytes'   },
          ]},
          { name: 'amountIn',         type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
        ]
      }],
      [{
        currencyIn,
        path: [
          buildPathKey(route, '', route.via),
          buildPathKey(route, '2', currencyOut),
        ],
        amountIn:         swapAmountIn,
        amountOutMinimum: BigInt(amountOutMin),
      }]
    )
    : encodeAbiParameters(
      [{
        type: 'tuple', components: [
          { name: 'poolKey', type: 'tuple', components: [
            { name: 'currency0',   type: 'address' },
            { name: 'currency1',   type: 'address' },
            { name: 'fee',         type: 'uint24'  },
            { name: 'tickSpacing', type: 'int24'   },
            { name: 'hooks',       type: 'address' },
          ]},
          { name: 'zeroForOne',       type: 'bool'    },
          { name: 'amountIn',         type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData',         type: 'bytes'   },
        ]
      }],
      [{
        poolKey:          buildPoolKey(route),
        zeroForOne:       route.zeroForOne,
        amountIn:         swapAmountIn,
        amountOutMinimum: BigInt(amountOutMin),
        hookData:         '0x',
      }]
    )

  const swapAction = isMultiHop ? V4_ACTIONS.SWAP_EXACT_IN : V4_ACTIONS.SWAP_EXACT_IN_SINGLE
  const useExplicitPayments = settleFirst || options.takeRecipient || options.settlePayerIsUser !== undefined
  const settleAction = useExplicitPayments ? V4_ACTIONS.SETTLE : V4_ACTIONS.SETTLE_ALL
  const takeAction = useExplicitPayments ? V4_ACTIONS.TAKE : V4_ACTIONS.TAKE_ALL
  const settleParams = useExplicitPayments
    ? encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
      [currencyIn, settleFirst ? UR_CONTRACT_BALANCE : BigInt(amountIn), settleFirst ? false : (options.settlePayerIsUser ?? true)]
    )
    : encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [currencyIn, BigInt(amountIn)]
    )
  const takeParams = useExplicitPayments
    ? encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [currencyOut, options.takeRecipient ?? UNIVERSAL_ROUTER, V4_OPEN_DELTA]
    )
    : encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [currencyOut, BigInt(amountOutMin)]
    )
  // Settle-first: pay the router's whole balance into the PoolManager as credit, THEN swap the
  // full credit (OPEN_DELTA). Normal order (swap first, settle the debt after) needs a fixed
  // swap amount, which is exactly what balance-relative mode avoids.
  const actions = settleFirst
    ? `0x${settleAction}${swapAction}${takeAction}`
    : `0x${swapAction}${settleAction}${takeAction}`
  const params = settleFirst
    ? [settleParams, swapParams, takeParams]
    : [swapParams, settleParams, takeParams]

  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, params]
  )
}

function routeMinOut(route, totalAmountOutMin, totalAmountOut) {
  if (!totalAmountOut || totalAmountOut === 0n) return 0n
  return BigInt(route.amountOut) * totalAmountOutMin / totalAmountOut
}

function routeSplitMinOut(route, totalAmountOutMin, totalAmountOut) {
  const proportionalMin = routeMinOut(route, totalAmountOutMin, totalAmountOut)
  return proportionalMin * 9500n / 10000n
}

function buildPermit2TransferFromInput(token, recipient, amount) {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }],
    [token, recipient, BigInt(amount)]
  )
}

function buildSweepInput(token, recipient, amountMin = 0n) {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [token, recipient, BigInt(amountMin)]
  )
}

function encodeRouterCommands(commands) {
  return `0x${commands.map(command => command.toString(16).padStart(2, '0')).join('')}`
}

function routeTokenAddress(token) {
  return token.address === 'ETH' ? ETH_ADDRESS : token.address
}

function emptyV3Single() {
  return {
    tokenIn: ETH_ADDRESS,
    tokenOut: ETH_ADDRESS,
    fee: 0,
    sqrtPriceLimitX96: 0n,
  }
}

// The V2 aggregator is the only deployment now, and it executes V4 legs, so every
// route shape the engine produces is executable by it. (V1 could not, which is why
// this used to be gated behind AETHER_AGGREGATOR_V2_ENABLED.)
function routeCanUseAether(route) {
  if (
    route.type === 'direct' ||
    route.type === 'multihop' ||
    route.type === 'v2_direct' ||
    route.type === 'v2_multihop' ||
    route.type === 'v4_direct' ||
    route.type === 'v4_multihop'
  ) return true

  // A mixed route is only encodable when both of its legs are present.
  if (route.type?.startsWith('mixed')) {
    const [firstLeg, secondLeg] = route.legs ?? []
    return Boolean(firstLeg && secondLeg)
  }

  return false
}

function buildV2Path(route, tokenIn, tokenOut) {
  const addrIn = resolveAddress(tokenIn)
  const addrOut = resolveAddress(tokenOut)
  return route.type === 'v2_multihop'
    ? [addrIn, route.via, addrOut]
    : [addrIn, addrOut]
}

function buildAetherV2RouterLeg({ route, tokenIn, tokenOut, amountIn, minAmountOut, deadline }) {
  const inputAmount = BigInt(amountIn)
  const outputMin = BigInt(minAmountOut)
  const isNativeInput = tokenIn.address === 'ETH'
  const path = buildV2Path(route, tokenIn, tokenOut)
  const callData = isNativeInput
    ? encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactETHForTokens',
      args: [outputMin, path, AETHER_AGGREGATOR, deadline],
    })
    : encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [inputAmount, outputMin, path, AETHER_AGGREGATOR, deadline],
    })

  return {
    legType: 3,
    tokenIn: routeTokenAddress(tokenIn),
    tokenOut: routeTokenAddress(tokenOut),
    amountIn: inputAmount,
    minAmountOut: outputMin,
    target: V2_ROUTER,
    path: '0x',
    v3Single: emptyV3Single(),
    callData,
    value: isNativeInput ? inputAmount : 0n,
  }
}

// A V3 leg that swaps against the pool itself (legType 6). The facet derives the pool address from
// (tokenIn, tokenOut, fee) and pays inside uniswapV3SwapCallback, so no router and no approval.
function buildAetherV3PoolLeg({ tokenIn, tokenOut, fee, amountIn, minAmountOut }) {
  return {
    legType: 6,
    tokenIn: routeTokenAddress(tokenIn),
    tokenOut: routeTokenAddress(tokenOut),
    amountIn: BigInt(amountIn),
    minAmountOut: BigInt(minAmountOut),
    target: ETH_ADDRESS,
    path: '0x',
    v3Single: {
      tokenIn: resolveAddress(tokenIn),
      tokenOut: resolveAddress(tokenOut),
      fee,
      sqrtPriceLimitX96: 0n,
    },
    callData: '0x',
    value: 0n,
  }
}

function buildAetherV3Leg({ route, tokenIn, tokenOut, amountIn, minAmountOut }) {
  const inputAmount = BigInt(amountIn)
  const outputMin = BigInt(minAmountOut)
  const addrIn = resolveAddress(tokenIn)
  const addrOut = resolveAddress(tokenOut)
  const isMultihop = route.type === 'multihop'

  if (DIRECT_POOL_LEGS) {
    if (!isMultihop) {
      return [buildAetherV3PoolLeg({ tokenIn, tokenOut, fee: route.fee, amountIn: inputAmount, minAmountOut: outputMin })]
    }
    // Two pool swaps instead of one router path call; the second leg takes whatever the first
    // produced (amountIn 0 = the aggregator's balance of the intermediate token).
    const bridge = tokenForRouteAddress(route.via, 'BRIDGE')
    return [
      buildAetherV3PoolLeg({ tokenIn, tokenOut: bridge, fee: route.fee, amountIn: inputAmount, minAmountOut: 0n }),
      buildAetherV3PoolLeg({ tokenIn: bridge, tokenOut, fee: route.fee2, amountIn: 0n, minAmountOut: outputMin }),
    ]
  }

  return {
    legType: isMultihop ? 1 : 0,
    tokenIn: routeTokenAddress(tokenIn),
    tokenOut: routeTokenAddress(tokenOut),
    amountIn: inputAmount,
    minAmountOut: outputMin,
    target: ETH_ADDRESS,
    path: isMultihop ? encodeMultiPath(addrIn, route.fee, route.via, route.fee2, addrOut) : '0x',
    v3Single: isMultihop
      ? emptyV3Single()
      : {
        tokenIn: addrIn,
        tokenOut: addrOut,
        fee: route.fee,
        sqrtPriceLimitX96: 0n,
      },
    callData: '0x',
    value: 0n,
  }
}

function quoteCanUseAether(quote) {
  if (!quote?.routes?.length) return false
  return quote.routes.every(route => routeCanUseAether(route))
}

function tokenForRouteAddress(address, fallbackSymbol = 'TOKEN') {
  if (!address || address === ETH_ADDRESS || address === 'ETH') return TOKENS.find(token => token.address === 'ETH')
  const token = getToken(address)
  return token ?? {
    symbol: fallbackSymbol,
    name: fallbackSymbol,
    address,
    decimals: 18,
    chainId: 11155111,
    color: '#7d8bff',
  }
}

function buildAetherUniversalRouterLeg({ route, tokenIn, tokenOut, amountIn, minAmountOut, deadline }) {
  const inputAmount = BigInt(amountIn)
  const outputMin = BigInt(minAmountOut)
  // The aggregator accounts each leg's proceeds in `tokenOut`. When it collects WETH but a
  // V4 leg yields native ETH, force a wrap so the proceeds land as WETH and get counted.
  // Mixed routes carry the output currency on their SECOND leg, not the route object.
  const collectAsWeth = tokenOut.address?.toLowerCase?.() === WETH_ADDRESS.toLowerCase()
  const routeCurrencyOut = route.currencyOut ?? route.legs?.[1]?.currencyOut ?? ''
  const outputsNativeEth = routeCurrencyOut.toLowerCase() === ETH_ADDRESS.toLowerCase()
  const routed = {
    ...route,
    amountIn: inputAmount.toString(),
    wrapEthOutput: collectAsWeth && outputsNativeEth ? true : route.wrapEthOutput,
  }
  const built = buildSwapCalldata({
    routes: [routed],
    tokenIn,
    tokenOut,
    totalAmountIn: inputAmount,
    totalAmountOutMin: outputMin,
    recipient: AETHER_AGGREGATOR,
    forceExplicitV4Payments: true,
  })

  return {
    legType: 2,
    tokenIn: routeTokenAddress(tokenIn),
    tokenOut: routeTokenAddress(tokenOut),
    amountIn: inputAmount,
    minAmountOut: outputMin,
    target: UNIVERSAL_ROUTER,
    path: '0x',
    v3Single: emptyV3Single(),
    callData: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [built.commands, built.inputs, deadline],
    }),
    value: built.value,
  }
}

// Returns one leg or several (a direct-pool V3 multihop is two pool swaps); callers flatten.
function buildAetherLeg({ route, tokenIn, tokenOut, amountIn, minAmountOut, deadline }) {
  if (route.type === 'v2_direct' || route.type === 'v2_multihop') {
    // Native input keeps the router path: swapExactETHForTokens wraps on the way in.
    if (DIRECT_POOL_LEGS && route.type === 'v2_direct' && tokenIn.address !== 'ETH') {
      return [{
        legType: 7,
        tokenIn: routeTokenAddress(tokenIn),
        tokenOut: routeTokenAddress(tokenOut),
        amountIn: BigInt(amountIn),
        minAmountOut: BigInt(minAmountOut),
        target: ETH_ADDRESS,
        path: '0x',
        v3Single: emptyV3Single(),
        callData: '0x',
        value: 0n,
      }]
    }
    return buildAetherV2RouterLeg({ route, tokenIn, tokenOut, amountIn, minAmountOut, deadline })
  }

  if (
    route.type === 'v4_direct' ||
    route.type === 'v4_multihop' ||
    route.protocol === 'v4'
  ) {
    return buildAetherUniversalRouterLeg({ route, tokenIn, tokenOut, amountIn, minAmountOut, deadline })
  }

  if (route.type === 'direct' || route.type === 'multihop' || route.protocol === 'v3') {
    return buildAetherV3Leg({ route, tokenIn, tokenOut, amountIn, minAmountOut })
  }

  throw new Error('Unsupported Aether route')
}

// Native ETH input is held by the aggregator as ETH (msg.value). V3 legs swap WETH and never
// wrap it themselves (unlike V2/V4 legs, which receive native ETH via leg.value), so a pure-V3
// ETH-input swap reverts. Prepend a WRAP_ETH leg (LegType 4) to convert this route's ETH portion
// to WETH first. Contract-compatible — no redeploy needed.
function buildAetherWrapEthLeg(amountIn) {
  return {
    legType: 4,
    tokenIn: ETH_ADDRESS,
    tokenOut: WETH_ADDRESS,
    amountIn: BigInt(amountIn),
    minAmountOut: 0n,
    target: ETH_ADDRESS,
    path: '0x',
    v3Single: emptyV3Single(),
    callData: '0x',
    value: 0n,
  }
}

function routeFirstLegIsV3(route) {
  if (route.type?.startsWith('mixed')) {
    return route.legs?.[0]?.protocol === 'v3'
  }
  return route.type === 'direct' || route.type === 'multihop' || route.protocol === 'v3'
}

function buildAetherRoute({ route, tokenIn, tokenOut, amountOutMin, deadline }) {
  const needsEthWrap = tokenIn.address === 'ETH' && routeFirstLegIsV3(route)

  if (route.type?.startsWith('mixed')) {
    const [firstLeg, secondLeg] = route.legs ?? []
    if (!firstLeg || !secondLeg || !route.via) {
      throw new Error('Invalid Aether mixed route')
    }

    // Any V4-involving V3/V4 mix executes as ONE Universal Router leg: the input pull is exact
    // (route.amountIn — exact by definition), everything after is balance-relative inside
    // buildSwapCalldata's mixed branch (CONTRACT_BALANCE / OPEN_DELTA / full-balance unwraps).
    // The old two-contract-leg split baked the QUOTED intermediate into the UR calldata (Permit2
    // pull + swap amount), which hard-reverted the whole swap (TRANSFER_FROM_FAILED) whenever
    // sibling routes in the same execute() moved the shared first-hop pool.
    const protocols = [firstLeg.protocol, secondLeg.protocol]
    if (protocols.includes('v4') && protocols.every(p => p === 'v3' || p === 'v4')) {
      return {
        amountIn: BigInt(route.amountIn),
        minAmountOut: BigInt(amountOutMin),
        legs: [
          buildAetherUniversalRouterLeg({
            route,
            tokenIn,
            tokenOut,
            amountIn: route.amountIn,
            minAmountOut: amountOutMin,
            deadline,
          }),
        ],
      }
    }

    const bridgeToken = tokenForRouteAddress(route.via, 'BRIDGE')
    const legs = []

    if (needsEthWrap) legs.push(buildAetherWrapEthLeg(route.amountIn))

    legs.push(
      ...[].concat(buildAetherLeg({
        route: firstLeg,
        tokenIn,
        tokenOut: bridgeToken,
        amountIn: route.amountIn,
        minAmountOut: 0n,
        deadline,
      })),
    )

    // For a contract-built second leg (V3), encode amountIn=0 so the aggregator feeds the
    // ACTUAL intermediate-token balance received from leg 1 (AetherSwapFacet leg loop:
    // legAmountIn==0 -> _balanceOfAsset). Passing the quoted amount reverts STF whenever leg 1's
    // real output is a touch below quote (the common case) — this is the mixed_v3_v3 bug.
    const secondLegIsV3 = secondLeg.protocol === 'v3' || secondLeg.type === 'direct' || secondLeg.type === 'multihop'
    legs.push(
      ...[].concat(buildAetherLeg({
        route: secondLeg,
        tokenIn: bridgeToken,
        tokenOut,
        amountIn: secondLegIsV3 ? 0 : (secondLeg.amountIn ?? firstLeg.amountOut),
        minAmountOut: amountOutMin,
        deadline,
      })),
    )

    return {
      amountIn: BigInt(route.amountIn),
      minAmountOut: BigInt(amountOutMin),
      legs,
    }
  }

  const legs = []

  if (needsEthWrap) legs.push(buildAetherWrapEthLeg(route.amountIn))

  legs.push(
    ...[].concat(buildAetherLeg({
      route,
      tokenIn,
      tokenOut,
      amountIn: route.amountIn,
      minAmountOut: amountOutMin,
      deadline,
    })),
  )

  return {
    amountIn: BigInt(route.amountIn),
    minAmountOut: BigInt(amountOutMin),
    legs,
  }
}

function buildAetherParams({ routes, tokenIn, tokenOut, totalAmountIn, totalAmountOutMin, recipient, deadline }) {
  const executableAmountIn = routes.reduce((sum, route) => sum + BigInt(route.amountIn), 0n)
  // Always collect every route's output as WETH (one consistent output asset) and unwrap
  // once at the end. Mixing native-ETH (V4) and WETH (V2/V3) outputs in a single execute
  // leaves part of the proceeds unaccounted and reverts with InsufficientOutput.
  const useContractFinalUnwrap = tokenOut.address === 'ETH'
  const outputToken = useContractFinalUnwrap ? { ...tokenOut, address: WETH_ADDRESS } : tokenOut
  return {
    tokenIn: routeTokenAddress(tokenIn),
    tokenOut: routeTokenAddress(outputToken),
    amountIn: executableAmountIn > 0n ? executableAmountIn : totalAmountIn,
    minAmountOut: totalAmountOutMin,
    recipient,
    unwrapWeth: useContractFinalUnwrap,
    deadline,
    routes: routes.map(route => {
      // Multi-route splits are protected by the TOTAL minAmountOut only. Routes in one
      // execute() move each other's pools (many share a hop), so later routes land under their
      // own quote even when the TOTAL is fine — per-route minimums then revert whale splits
      // ("Too little received") that the user would happily take. Value only shifts BETWEEN
      // routes; the total check (ladder-controlled) is what the displayed number promises.
      const amountOutMin = routes.length === 1 ? totalAmountOutMin : 0n
      return buildAetherRoute({ route, tokenIn, tokenOut: outputToken, amountOutMin, deadline })
    }),
    dustTokens: collectDustTokens(routes, tokenIn, tokenOut),
  }
}

function slippageBps(slippageValue) {
  const parsed = Number.parseFloat(slippageValue)
  if (!Number.isFinite(parsed) || parsed < 0) return 50n
  return BigInt(Math.round(parsed * 100))
}

function subsetMinOut(routes, tokenOut, slippageValue) {
  const totalOut = routes.reduce((sum, route) => sum + BigInt(route.amountOut ?? 0), 0n)
  const bps = slippageBps(slippageValue)
  return totalOut * (10000n - bps) / 10000n
}

function routeDebugLabel(route) {
  if (route.type?.startsWith('mixed')) {
    const via = tokenForRouteAddress(route.via, 'BRIDGE')?.symbol ?? 'BRIDGE'
    return `${route.type} via ${via}`
  }
  return route.label || route.type || 'route'
}

function withPreflightTimeout(promise, label = 'Preflight timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), AETHER_PREFLIGHT_TIMEOUT_MS)
    }),
  ])
}

// Execute exactly what is displayed: the FULL route set simulates or this throws. There is no
// route-drop fallback — executing a silently reduced subset (part of the input left in the
// wallet, output below the number on screen) burned the owner's trust; the caller re-quotes and
// asks for a re-click on an honest number instead.
async function findExecutableAetherParams({
  publicClient,
  account,
  quote,
  tokenIn,
  tokenOut,
  totalAmountIn,
  totalAmountOutMin,
  recipient,
  deadline,
}) {
  const params = buildAetherParams({
    routes: quote.routes,
    tokenIn,
    tokenOut,
    totalAmountIn,
    totalAmountOutMin,
    recipient,
    deadline,
  })
  if (!publicClient) throw new Error('Public client unavailable')
  const { result } = await withPreflightTimeout(publicClient.simulateContract({
    account,
    address: AETHER_AGGREGATOR,
    abi: AETHER_AGGREGATOR_ABI,
    functionName: 'execute',
    args: [params],
    value: tokenIn.address === 'ETH' ? params.amountIn : 0n,
    gas: AETHER_GAS_BUDGET,
  }))
  // result = the contract's actual amountOut for this exact set at current pool state — the
  // honest number a min=1 measurement call reads.
  return { params, result }
}

// Solo-simulate every route of a quote in parallel and report the ones that revert on their own.
// Used when the full set can't execute even fresh: the caller blocks these keys and re-quotes so
// the WHOLE input is reallocated across live routes — never a reduced-subset execution. Call with
// a loose slippage (ladder max) so only genuinely dead routes get blocked, not tight-min-out ones.
async function classifyFailingRoutes({
  publicClient,
  account,
  quote,
  tokenIn,
  tokenOut,
  totalAmountIn,
  recipient,
  deadline,
  slippage,
}) {
  if (!publicClient) throw new Error('Public client unavailable')
  const soloSimulate = async route => {
    const params = buildAetherParams({
      routes: [route],
      tokenIn,
      tokenOut,
      totalAmountIn,
      totalAmountOutMin: subsetMinOut([route], tokenOut, slippage),
      recipient,
      deadline,
    })
    await withPreflightTimeout(publicClient.simulateContract({
      account,
      address: AETHER_AGGREGATOR,
      abi: AETHER_AGGREGATOR_ABI,
      functionName: 'execute',
      args: [params],
      value: tokenIn.address === 'ETH' ? params.amountIn : 0n,
      gas: AETHER_GAS_BUDGET,
    }))
  }
  const results = await Promise.allSettled(quote.routes.map(soloSimulate))
  return quote.routes
    .filter((_, index) => results[index].status === 'rejected')
    .map(route => ({ key: routeExecutionKey(route), label: routeDebugLabel(route) }))
}

function collectDustTokens(routes, tokenIn, tokenOut) {
  const skip = new Set([
    routeTokenAddress(tokenIn).toLowerCase(),
    routeTokenAddress(tokenOut).toLowerCase(),
    WETH_ADDRESS.toLowerCase(),
    ETH_ADDRESS.toLowerCase(),
  ])
  const tokens = new Set()
  const add = value => {
    if (!value || value === 'ETH') return
    const address = value.toLowerCase()
    if (!skip.has(address)) tokens.add(value)
  }

  for (const route of routes) {
    add(route.via)
    add(route.currencyIn)
    add(route.currencyOut)
    for (const leg of route.legs ?? []) {
      add(leg.via)
      add(leg.tokenIn)
      add(leg.tokenOut)
      add(leg.currencyIn)
      add(leg.currencyOut)
    }
  }

  return [...tokens]
}

function buildSwapCalldata({ routes, tokenIn, tokenOut, totalAmountIn, totalAmountOutMin, recipient, forceExplicitV4Payments = false }) {
  const addrIn = resolveAddress(tokenIn)
  const addrOut = resolveAddress(tokenOut)
  const currencyIn = resolveCurrency(tokenIn)
  const currencyOut = resolveCurrency(tokenOut)
  const isInputETH = tokenIn.address === 'ETH'
  const isOutputETH = tokenOut.address === 'ETH'
  const totalAmountOut = routes.reduce((sum, route) => sum + BigInt(route.amountOut), 0n)
  const commands = []
  const inputs = []
  const value = isInputETH ? totalAmountIn : 0n
  let v3EthOutputMin = 0n

  const v3EthInput = routes
    .filter(route => route.type === 'direct' || route.type === 'multihop')
    .reduce((sum, route) => sum + BigInt(route.amountIn), 0n)
  if (isInputETH && v3EthInput > 0n) {
    commands.push(UR_COMMANDS.WRAP_ETH)
    inputs.push(encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [UNIVERSAL_ROUTER, v3EthInput]
    ))
  }

  for (const route of routes) {
    const amountOutMin = routes.length === 1
      ? totalAmountOutMin
      : routeSplitMinOut(route, totalAmountOutMin, totalAmountOut)

    if (route.type?.startsWith('mixed')) {
      const [firstLeg, secondLeg] = route.legs ?? []
      if (!firstLeg || !secondLeg || !route.via) throw new Error('Invalid mixed route')

      const intermediateAmount = BigInt(firstLeg.amountOut)
      // Aggregator-leg mode: every INTERMEDIATE amount is balance-relative. Sibling routes in the
      // same execute() move the same pools, so the real intermediate routinely lands under the
      // quoted one — any fixed intermediate amount (Permit2 pull, swap amountIn, unwrap minimum)
      // hard-reverts the whole swap (the TRANSFER_FROM_FAILED whale failure). The input pull
      // stays exact (route.amountIn is exact by definition) and the route-level minAmountOut,
      // enforced by the aggregator contract, protects the output. The standalone Universal
      // Router path keeps its original fixed-amount encoding.
      const balanceRelative = forceExplicitV4Payments
      const firstLegMin = balanceRelative ? 0n : intermediateAmount
      // v4 native-out -> v4 native-in via a WETH-listed bridge: skip the wrap+unwrap pair.
      const bridgeCancels = balanceRelative && firstLeg.wrapEthOutput && secondLeg.unwrapWethInput

      if (firstLeg.protocol === 'v4') {
        if (isInputETH && firstLeg.wrapEthInput) {
          commands.push(UR_COMMANDS.WRAP_ETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [UNIVERSAL_ROUTER, BigInt(firstLeg.amountIn || route.amountIn)]
          ))
        } else if (firstLeg.unwrapWethInput) {
          // The input is WETH but this V4 pool is native-ETH: move the WETH to the router and
          // unwrap it there, or the pool's settle finds no ETH ("insufficient balance for
          // transfer"). Same sequence the standalone V4 route path uses.
          const firstLegIn = BigInt(firstLeg.amountIn || route.amountIn)
          commands.push(UR_COMMANDS.PERMIT2_TRANSFER_FROM)
          inputs.push(buildPermit2TransferFromInput(WETH_ADDRESS, UNIVERSAL_ROUTER, firstLegIn.toString()))
          commands.push(UR_COMMANDS.UNWRAP_WETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [UNIVERSAL_ROUTER, firstLegIn]
          ))
        }
        commands.push(UR_COMMANDS.V4_SWAP)
        inputs.push(encodeV4SwapActions(
          firstLeg,
          firstLeg.amountIn || route.amountIn || totalAmountIn.toString(),
          firstLegMin.toString(),
          firstLeg.currencyIn,
          firstLeg.currencyOut,
          { takeRecipient: UNIVERSAL_ROUTER, settlePayerIsUser: true }
        ))
        if (balanceRelative && firstLeg.wrapEthOutput && !bridgeCancels) {
          // The pool paid native ETH but the bridge/second leg expects WETH at the router.
          commands.push(UR_COMMANDS.WRAP_ETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [UNIVERSAL_ROUTER, UR_CONTRACT_BALANCE]
          ))
        }
      } else {
        if (isInputETH) {
          commands.push(UR_COMMANDS.WRAP_ETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [UNIVERSAL_ROUTER, BigInt(firstLeg.amountIn || route.amountIn)]
          ))
        }
        commands.push(UR_COMMANDS.V3_SWAP_EXACT_IN)
        inputs.push(buildV3RouteInput({
          route: firstLeg,
          addrIn,
          addrOut: route.via,
          amountOutMin: firstLegMin,
          recipient: UNIVERSAL_ROUTER,
          payerIsUser: !isInputETH,
          isOutputETH: false,
        }))
      }

      const wrapOutSecond = secondLeg.wrapEthOutput || route.wrapEthOutput
      const unwrapOutSecond = secondLeg.unwrapWethOutput || route.unwrapWethOutput
      if (secondLeg.protocol === 'v4') {
        if (balanceRelative && secondLeg.unwrapWethInput && !bridgeCancels) {
          // Intermediate arrived as WETH but the V4 pool is native-ETH: unwrap the router's FULL
          // WETH balance (UNWRAP_WETH always unwraps the whole balance; the param is a minimum).
          commands.push(UR_COMMANDS.UNWRAP_WETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [UNIVERSAL_ROUTER, 0n]
          ))
        } else if (balanceRelative && secondLeg.wrapEthInput && !bridgeCancels) {
          commands.push(UR_COMMANDS.WRAP_ETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [UNIVERSAL_ROUTER, UR_CONTRACT_BALANCE]
          ))
        }
        commands.push(UR_COMMANDS.V4_SWAP)
        inputs.push(encodeV4SwapActions(
          secondLeg,
          intermediateAmount.toString(),
          amountOutMin.toString(),
          secondLeg.currencyIn,
          secondLeg.currencyOut,
          {
            takeRecipient: wrapOutSecond || unwrapOutSecond ? UNIVERSAL_ROUTER : recipient,
            settlePayerIsUser: false,
            settleContractBalance: balanceRelative,
          }
        ))

        if (wrapOutSecond) {
          commands.push(UR_COMMANDS.WRAP_ETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [recipient, balanceRelative ? UR_CONTRACT_BALANCE : amountOutMin]
          ))
        }
        if (unwrapOutSecond) {
          commands.push(UR_COMMANDS.UNWRAP_WETH)
          inputs.push(encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [recipient, balanceRelative ? 0n : amountOutMin]
          ))
        }
      } else {
        commands.push(UR_COMMANDS.V3_SWAP_EXACT_IN)
        inputs.push(buildV3RouteInput({
          route: {
            ...secondLeg,
            // CONTRACT_BALANCE: the Universal Router swaps its ACTUAL balance of the bridge token.
            amountIn: (balanceRelative ? UR_CONTRACT_BALANCE : intermediateAmount).toString(),
          },
          addrIn: route.via,
          addrOut,
          amountOutMin,
          recipient,
          payerIsUser: false,
          isOutputETH,
        }))

        if (isOutputETH) {
          v3EthOutputMin += amountOutMin
        }
      }

      commands.push(UR_COMMANDS.SWEEP)
      inputs.push(buildSweepInput(route.via, recipient, 0n))
      continue
    }

    if (route.type === 'v4_direct' || route.type === 'v4_multihop') {
      const routeCurrencyIn = route.currencyIn ?? currencyIn
      const routeCurrencyOut = route.currencyOut ?? currencyOut
      if (isInputETH && route.wrapEthInput) {
        commands.push(UR_COMMANDS.WRAP_ETH)
        inputs.push(encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [UNIVERSAL_ROUTER, BigInt(route.amountIn || totalAmountIn.toString())]
        ))
      }
      if (route.unwrapWethInput) {
        commands.push(UR_COMMANDS.PERMIT2_TRANSFER_FROM)
        inputs.push(buildPermit2TransferFromInput(WETH_ADDRESS, UNIVERSAL_ROUTER, route.amountIn || totalAmountIn.toString()))
        commands.push(UR_COMMANDS.UNWRAP_WETH)
        inputs.push(encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [UNIVERSAL_ROUTER, BigInt(route.amountIn || totalAmountIn.toString())]
        ))
      }

      commands.push(UR_COMMANDS.V4_SWAP)
      const v4TakeRecipient = route.wrapEthOutput || route.unwrapWethOutput ? UNIVERSAL_ROUTER : recipient
      inputs.push(encodeV4SwapActions(
        route,
        route.amountIn || totalAmountIn.toString(),
        amountOutMin.toString(),
        routeCurrencyIn,
        routeCurrencyOut,
        forceExplicitV4Payments || route.wrapEthOutput || route.unwrapWethOutput
          ? { takeRecipient: v4TakeRecipient, settlePayerIsUser: true }
          : {}
      ))

      if (route.wrapEthOutput) {
        // In the aggregator path each leg is its own Universal Router call, so wrapping the
        // router's full native balance captures the entire swap output without stranding dust.
        const wrapAmount = forceExplicitV4Payments
          ? UR_CONTRACT_BALANCE
          : (routes.length === 1
            ? totalAmountOutMin
            : routeMinOut(route, totalAmountOutMin, totalAmountOut))
        commands.push(UR_COMMANDS.WRAP_ETH)
        inputs.push(encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [recipient, wrapAmount]
        ))
      }
      if (route.unwrapWethOutput) {
        const unwrapAmount = routes.length === 1
          ? totalAmountOutMin
          : routeMinOut(route, totalAmountOutMin, totalAmountOut)
        commands.push(UR_COMMANDS.UNWRAP_WETH)
        inputs.push(encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [recipient, unwrapAmount]
        ))
      }
    } else {
      commands.push(UR_COMMANDS.V3_SWAP_EXACT_IN)
      inputs.push(buildV3RouteInput({
        route,
        addrIn,
        addrOut,
        amountOutMin,
        recipient,
        payerIsUser: !isInputETH,
        isOutputETH,
      }))

      if (isOutputETH) {
        v3EthOutputMin += amountOutMin
      }
    }
  }

  if (isOutputETH && v3EthOutputMin > 0n) {
    commands.push(UR_COMMANDS.UNWRAP_WETH)
    inputs.push(encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [recipient, v3EthOutputMin]
    ))
  }

  const invalidCommand = commands.find(command => !SUPPORTED_UR_COMMANDS.has(command))
  if (invalidCommand !== undefined) {
    throw new Error(`Unsupported Universal Router command: 0x${invalidCommand.toString(16)}`)
  }

  return { commands: encodeRouterCommands(commands), inputs, value }
}

export {
  SLIPPAGE_OPTIONS,
  PERMIT2,
  AETHER_AGGREGATOR,
  AETHER_GAS_BUDGET,
  TX_GAS_CAP,
  WETH_ADDRESS,
  MAX_UINT256,
  MAX_UINT160,
  PERMIT2_EXPIRATION,
  AUTO_SLIPPAGE_EXTRA_BPS,
  ERC20_ABI,
  PERMIT2_ABI,
  WETH_ABI,
  AETHER_AGGREGATOR_ABI,
  UNIVERSAL_ROUTER_ABI,
  quoteCanUseAether,
  buildAetherParams,
  findExecutableAetherParams,
  classifyFailingRoutes,
  buildSwapCalldata,
}
