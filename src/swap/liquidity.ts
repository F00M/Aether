import { encodeFunctionData, parseAbi, zeroAddress } from "viem";

import { TOKENS } from "../config/tokens";
import { loadToken } from "./activity";
import { POOL_FACTORY, V3_POSITION_MANAGER, WETH } from "./quoteConfig";
import { client } from "./quoteProviders";
import type { Token } from "./types";
import { amountsForLiquidity, liquidityForAmounts, rangeSides, sqrtRatioAtTick } from "./v3Math";

/**
 * Uniswap V3 liquidity through the official NonfungiblePositionManager: reading the pools and a
 * wallet's positions, and encoding the three things a position owner does — open, withdraw,
 * collect. Nothing here is Aether's own contract; a position made on this page is an ordinary
 * Uniswap V3 NFT.
 */
export const V3_FEE_TIERS = [
  { fee: 100, tickSpacing: 1, label: "0.01%" },
  { fee: 500, tickSpacing: 10, label: "0.05%" },
  { fee: 3000, tickSpacing: 60, label: "0.3%" },
  { fee: 10000, tickSpacing: 200, label: "1%" },
] as const;

const MAX_UINT128 = (1n << 128n) - 1n;
// Reading more than this many position NFTs for one wallet isn't worth the RPC round.
const MAX_POSITIONS = 60;

const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
export const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export const POSITION_MANAGER_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function refundETH() payable",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
]);

export type Pool = {
  address: `0x${string}`;
  /** Sorted by address, as the pool has them. */
  token0: Token;
  token1: Token;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  /** Liquidity active at the current price; 0 means nothing is in range right now. */
  liquidity: bigint;
  /** What the pool contract holds of each token. */
  balance0: bigint;
  balance1: bigint;
};

export type Position = {
  tokenId: bigint;
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** What the liquidity is worth at the current price. */
  amount0: bigint;
  amount1: bigint;
  /** Fees (and anything already withdrawn but not collected) waiting to be collected. */
  fees0: bigint;
  fees1: bigint;
  inRange: boolean;
};

export type Call = { to: `0x${string}`; data: `0x${string}`; value: bigint };

const isWeth = (token: Token) => token.address.toLowerCase() === WETH.toLowerCase();
export const poolHasWeth = (pool: Pool) => isWeth(pool.token0) || isWeth(pool.token1);
const tickSpacingOf = (fee: number) => V3_FEE_TIERS.find((tier) => tier.fee === fee)?.tickSpacing ?? 60;

async function readPoolState(addresses: `0x${string}`[], tokens: [Token, Token][], fees: number[]): Promise<Pool[]> {
  if (!addresses.length) return [];
  const state = await client.multicall({
    allowFailure: false,
    contracts: addresses.flatMap((address, index) => [
      { address, abi: POOL_ABI, functionName: "slot0" } as const,
      { address, abi: POOL_ABI, functionName: "liquidity" } as const,
      { address: tokens[index][0].address as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [address] } as const,
      { address: tokens[index][1].address as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [address] } as const,
    ]),
  });
  return addresses.map((address, index) => {
    const slot0 = state[index * 4] as readonly [bigint, number, ...unknown[]];
    return {
      address,
      token0: tokens[index][0],
      token1: tokens[index][1],
      fee: fees[index],
      tickSpacing: tickSpacingOf(fees[index]),
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      liquidity: state[index * 4 + 1] as bigint,
      balance0: state[index * 4 + 2] as bigint,
      balance1: state[index * 4 + 3] as bigint,
    };
  });
}

const byAddress = (a: Token, b: Token): [Token, Token] =>
  a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

/** Every V3 pool that exists between the listed tokens, across the four fee tiers. */
export async function loadPools(): Promise<Pool[]> {
  // ETH trades through WETH pools, so it is not a pool token of its own.
  const listed = (TOKENS as Token[]).filter((token) => token.address !== "ETH");
  const candidates = listed.flatMap((a, index) =>
    listed.slice(index + 1).flatMap((b) => V3_FEE_TIERS.map((tier) => ({ tokens: byAddress(a, b), fee: tier.fee }))),
  );
  const addresses = await client.multicall({
    allowFailure: false,
    contracts: candidates.map(
      ({ tokens, fee }) =>
        ({
          address: POOL_FACTORY as `0x${string}`,
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [tokens[0].address as `0x${string}`, tokens[1].address as `0x${string}`, fee],
        }) as const,
    ),
  });
  const existing = candidates
    .map((candidate, index) => ({ ...candidate, address: addresses[index] as `0x${string}` }))
    .filter((candidate) => candidate.address !== zeroAddress);
  return readPoolState(
    existing.map((pool) => pool.address),
    existing.map((pool) => pool.tokens),
    existing.map((pool) => pool.fee),
  );
}

/**
 * One pool by its address — listed tokens or not. The address is checked against the factory: a
 * contract that merely answers like a pool is not one, and nobody should be shown a deposit form
 * for it.
 */
export async function loadPool(address: `0x${string}`): Promise<Pool> {
  const shape = await client.multicall({
    allowFailure: true,
    contracts: [
      { address, abi: POOL_ABI, functionName: "token0" },
      { address, abi: POOL_ABI, functionName: "token1" },
      { address, abi: POOL_ABI, functionName: "fee" },
    ] as const,
  });
  const [token0, token1, fee] = shape.map((entry) => entry.result) as [`0x${string}` | undefined, `0x${string}` | undefined, number | undefined];
  if (!token0 || !token1 || fee === undefined) throw new Error("Not a Uniswap V3 pool");
  const official = await client.readContract({ address: POOL_FACTORY as `0x${string}`, abi: FACTORY_ABI, functionName: "getPool", args: [token0, token1, fee] });
  if ((official as string).toLowerCase() !== address.toLowerCase()) throw new Error("Not a Uniswap V3 pool");

  const tokens = (await Promise.all([loadToken(token0), loadToken(token1)])) as [Token, Token];
  const [pool] = await readPoolState([address], [tokens], [fee]);
  return pool;
}

/**
 * The wallet's V3 positions that still hold something (liquidity, or fees left to collect), newest
 * first. Positions in pools between unlisted tokens are included: they are the wallet's all the same.
 */
export async function loadPositions(account: `0x${string}`): Promise<Position[]> {
  const manager = V3_POSITION_MANAGER as `0x${string}`;
  const count = Number(await client.readContract({ address: manager, abi: POSITION_MANAGER_ABI, functionName: "balanceOf", args: [account] }));
  if (!count) return [];

  // The newest NFTs are at the highest indexes.
  const indexes = Array.from({ length: Math.min(count, MAX_POSITIONS) }, (_, offset) => BigInt(count - 1 - offset));
  const tokenIds = (await client.multicall({
    allowFailure: false,
    contracts: indexes.map((index) => ({ address: manager, abi: POSITION_MANAGER_ABI, functionName: "tokenOfOwnerByIndex", args: [account, index] }) as const),
  })) as bigint[];
  const raw = await client.multicall({
    allowFailure: false,
    contracts: tokenIds.map((tokenId) => ({ address: manager, abi: POSITION_MANAGER_ABI, functionName: "positions", args: [tokenId] }) as const),
  });

  const open = raw
    .map((entry, index) => {
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , owed0, owed1] = entry as readonly [bigint, string, `0x${string}`, `0x${string}`, number, number, number, bigint, bigint, bigint, bigint, bigint];
      return { tokenId: tokenIds[index], token0, token1, fee, tickLower, tickUpper, liquidity, owed0, owed1 };
    })
    .filter((position) => position.liquidity > 0n || position.owed0 > 0n || position.owed1 > 0n);
  if (!open.length) return [];

  const [tokens, poolAddresses, collectable] = await Promise.all([
    Promise.all(open.map((position) => Promise.all([loadToken(position.token0), loadToken(position.token1)]))),
    client.multicall({
      allowFailure: false,
      contracts: open.map((position) => ({ address: POOL_FACTORY as `0x${string}`, abi: FACTORY_ABI, functionName: "getPool", args: [position.token0, position.token1, position.fee] }) as const),
    }) as Promise<`0x${string}`[]>,
    // collect() as a static call from the owner is the only way to see fees that haven't been
    // checkpointed into tokensOwed yet.
    Promise.all(
      open.map((position) =>
        client
          .simulateContract({
            account,
            address: manager,
            abi: POSITION_MANAGER_ABI,
            functionName: "collect",
            args: [{ tokenId: position.tokenId, recipient: account, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
          })
          .then(({ result }) => result as readonly [bigint, bigint])
          .catch(() => [position.owed0, position.owed1] as const),
      ),
    ),
  ]);
  const pools = await readPoolState(poolAddresses, tokens as [Token, Token][], open.map((position) => position.fee));

  return open.map((position, index) => {
    const pool = pools[index];
    const held = amountsForLiquidity(pool.sqrtPriceX96, sqrtRatioAtTick(position.tickLower), sqrtRatioAtTick(position.tickUpper), position.liquidity);
    return {
      tokenId: position.tokenId,
      pool,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity,
      amount0: held.amount0,
      amount1: held.amount1,
      fees0: collectable[index][0],
      fees1: collectable[index][1],
      inRange: pool.tick >= position.tickLower && pool.tick < position.tickUpper,
    };
  });
}

/**
 * The deposit a range needs when the user fixes the amount of one token: the liquidity that amount
 * funds at the current price, and what the other token then has to be. A range entirely on one
 * side of the price takes a single token, so fixing the other one yields nothing.
 */
export function planDeposit({
  pool,
  tickLower,
  tickUpper,
  amount,
  side,
}: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amount: bigint;
  /** Which token `amount` is of. */
  side: 0 | 1;
}): { liquidity: bigint; amount0: bigint; amount1: bigint } {
  const lower = sqrtRatioAtTick(tickLower);
  const upper = sqrtRatioAtTick(tickUpper);
  // "As much as needed" of the token that isn't fixed, so only the fixed one limits the liquidity.
  const unbounded = 1n << 200n;
  const liquidity = liquidityForAmounts(pool.sqrtPriceX96, lower, upper, side === 0 ? amount : unbounded, side === 1 ? amount : unbounded);
  // A range that needs none of the fixed token would be funded entirely by the unbounded one.
  const { needs0, needs1 } = rangeSides(pool.tick, tickLower, tickUpper);
  if (liquidity === 0n || (side === 0 && !needs0) || (side === 1 && !needs1)) return { liquidity: 0n, amount0: 0n, amount1: 0n };
  const held = amountsForLiquidity(pool.sqrtPriceX96, lower, upper, liquidity);
  // The pool rounds what it takes up; one unit of headroom on the derived side covers it.
  return {
    liquidity,
    amount0: side === 0 ? amount : held.amount0 > 0n ? held.amount0 + 1n : 0n,
    amount1: side === 1 ? amount : held.amount1 > 0n ? held.amount1 + 1n : 0n,
  };
}

/** Unix time a transaction signed now stays valid until. Called when the user acts, never while rendering. */
export const deadlineIn = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds);

/** `amount` less a tolerance in basis points — the floor a transaction is allowed to settle at. */
export const withTolerance = (amount: bigint, bps: bigint) => (amount * (10_000n - bps)) / 10_000n;

const encode = (functionName: string, args: readonly unknown[]) =>
  // The ABI is a fixed list; the names passed below are all in it.
  encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]);

/**
 * Opens a position. With `payWithEth`, the WETH side is sent as ETH: the manager wraps what the
 * position needs and `refundETH` returns the rest in the same transaction.
 */
export function buildMintCall({
  pool,
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  amount0Min,
  amount1Min,
  recipient,
  deadline,
  payWithEth,
}: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
  payWithEth: boolean;
}): Call {
  const mint = encode("mint", [
    {
      token0: pool.token0.address,
      token1: pool.token1.address,
      fee: pool.fee,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient,
      deadline,
    },
  ]);
  const to = V3_POSITION_MANAGER as `0x${string}`;
  if (!payWithEth || !poolHasWeth(pool)) return { to, data: mint, value: 0n };
  return {
    to,
    data: encode("multicall", [[mint, encode("refundETH", [])]]),
    value: isWeth(pool.token0) ? amount0Desired : amount1Desired,
  };
}

/**
 * Withdraws `liquidity` from a position and collects everything that is then owed — the withdrawn
 * tokens plus accrued fees. With `receiveEth`, the WETH side arrives as ETH. `burn` deletes the
 * (then empty) NFT, so it only belongs on a full withdrawal.
 */
export function buildRemoveCall({
  position,
  liquidity,
  amount0Min,
  amount1Min,
  recipient,
  deadline,
  receiveEth,
  burn,
}: {
  position: Position;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
  receiveEth: boolean;
  burn: boolean;
}): Call {
  const calls = [
    ...(liquidity > 0n ? [encode("decreaseLiquidity", [{ tokenId: position.tokenId, liquidity, amount0Min, amount1Min, deadline }])] : []),
    ...collectCalls(position, recipient, receiveEth),
    ...(burn ? [encode("burn", [position.tokenId])] : []),
  ];
  return { to: V3_POSITION_MANAGER as `0x${string}`, data: encode("multicall", [calls]), value: 0n };
}

/** Collects the fees without touching the liquidity. */
export function buildCollectCall({ position, recipient, receiveEth }: { position: Position; recipient: `0x${string}`; receiveEth: boolean }): Call {
  return { to: V3_POSITION_MANAGER as `0x${string}`, data: encode("multicall", [collectCalls(position, recipient, receiveEth)]), value: 0n };
}

function collectCalls(position: Position, recipient: `0x${string}`, receiveEth: boolean): `0x${string}`[] {
  const { pool, tokenId } = position;
  if (!receiveEth || !poolHasWeth(pool)) {
    return [encode("collect", [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }])];
  }
  // Collect to the manager itself (the zero address means exactly that), unwrap the WETH to the
  // owner as ETH and sweep the other token along.
  const other = isWeth(pool.token0) ? pool.token1 : pool.token0;
  return [
    encode("collect", [{ tokenId, recipient: zeroAddress, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]),
    encode("unwrapWETH9", [0n, recipient]),
    encode("sweepToken", [other.address, 0n, recipient]),
  ];
}
