"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContracts, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";

import { LiquidityRange } from "@/components/pools/liquidity-range";
import {
  currentPrice,
  formatPriceValue,
  formatTokenAmount,
  isFullRange,
  orientationOf,
  shownPriceAtTick,
  shownRange,
  tickAtShownPrice,
} from "@/components/pools/pool-format";
import { TxNotice, describeError, type TxState } from "@/components/pools/tx-state";
import { Segmented } from "@/components/ui/segmented";
import { notify } from "@/components/ui/toaster";
import { TokenIcon } from "@/components/ui/token-icon";
import { TOKENS } from "@/config/tokens";
import { sanitizeAmount, trimDecimals } from "@/lib/amount-input";
import { buildMintCall, deadlineIn, planDeposit, poolHasWeth, withTolerance, type Pool } from "@/swap/liquidity";
import { liquidityAt, type LiquidityProfile } from "@/swap/poolData";
import { V3_POSITION_MANAGER, WETH } from "@/swap/quoteConfig";
import type { Token } from "@/swap/types";
import { fullRangeTicks, nearestUsableTick, rangeSides, tickAtPrice } from "@/swap/v3Math";

const SEPOLIA_ID = 11155111;
const MANAGER = V3_POSITION_MANAGER as `0x${string}`;
// How far the price may move between signing and landing before the deposit reverts instead.
const TOLERANCE_BPS = 100n;
// Kept back when ETH pays for a deposit: the transaction's own gas.
const ETH_GAS_RESERVE = 5_000_000_000_000_000n;
const PRESETS = [
  { id: "full", label: "Full", spread: null },
  { id: "50", label: "±50%", spread: 0.5 },
  { id: "25", label: "±25%", spread: 0.25 },
  { id: "10", label: "±10%", spread: 0.1 },
  { id: "5", label: "±5%", spread: 0.05 },
] as const;
type PresetId = (typeof PRESETS)[number]["id"];
type Side = 0 | 1;
type Edge = "low" | "high";

const isWeth = (token: Token) => token.address.toLowerCase() === WETH.toLowerCase();
const ETH = (TOKENS as Token[]).find((token) => token.address === "ETH") as Token;

/** Ticks for a band of ±spread around the current price, snapped to the pool's spacing. */
function ticksAround(pool: Pool, spread: number): [number, number] {
  const orientation = orientationOf(pool);
  const price = currentPrice(pool, orientation);
  const a = nearestUsableTick(tickAtShownPrice(pool, orientation, price * (1 - spread)), pool.tickSpacing);
  const b = nearestUsableTick(tickAtShownPrice(pool, orientation, price * (1 + spread)), pool.tickSpacing);
  const [lower, upper] = a < b ? [a, b] : [b, a];
  return upper > lower ? [lower, upper] : [lower, lower + pool.tickSpacing];
}

/** The liquidity curve is kept by tick; the plot asks for it by shown price. */
function curveLookup(profile: LiquidityProfile, pool: Pool) {
  const { inverted } = orientationOf(pool);
  return (shown: number) => Number(liquidityAt(profile, tickAtPrice(inverted ? 1 / shown : shown, pool.token0.decimals, pool.token1.decimals)));
}

/**
 * Opens a Uniswap V3 position in `pool`: pick the range on the pool's liquidity curve, fix the
 * amount of one token, and the other follows.
 */
export function AddLiquidityForm({ pool, profile }: { pool: Pool; profile: LiquidityProfile | undefined }) {
  const { address, chain } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const orientation = orientationOf(pool);
  const price = currentPrice(pool, orientation);
  const tokens: [Token, Token] = [pool.token0, pool.token1];
  // The base token is entered first: that is the one the price is quoted for.
  const order: [Side, Side] = orientation.inverted ? [1, 0] : [0, 1];

  const [preset, setPreset] = useState<PresetId | null>("10");
  const [[tickLower, tickUpper], setTicks] = useState<[number, number]>(() => ticksAround(pool, 0.1));
  const [fixed, setFixed] = useState<{ side: Side; text: string }>({ side: order[0], text: "" });
  const [payWithEth, setPayWithEth] = useState(true);
  const [tx, setTx] = useState<TxState>({ kind: "idle" });

  const usesEth = payWithEth && poolHasWeth(pool);
  const paysEth = (side: Side) => usesEth && isWeth(tokens[side]);

  const native = useBalance({ address, query: { enabled: Boolean(address) } });
  const account = address ?? "0x0000000000000000000000000000000000000000";
  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: pool.token0.address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: pool.token1.address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: pool.token0.address as `0x${string}`, abi: erc20Abi, functionName: "allowance", args: [account, MANAGER] },
      { address: pool.token1.address as `0x${string}`, abi: erc20Abi, functionName: "allowance", args: [account, MANAGER] },
    ],
    query: { enabled: Boolean(address) },
  });
  const balanceOf = (side: Side): bigint | null => {
    if (!address) return null;
    if (paysEth(side)) {
      if (native.data?.value === undefined) return null;
      return native.data.value > ETH_GAS_RESERVE ? native.data.value - ETH_GAS_RESERVE : 0n;
    }
    return reads.data ? (reads.data[side] as bigint) : null;
  };
  const allowanceOf = (side: Side): bigint => (reads.data ? (reads.data[2 + side] as bigint) : 0n);

  const { needs0, needs1 } = rangeSides(pool.tick, tickLower, tickUpper);
  const needs = [needs0, needs1] as const;
  let fixedAmount = 0n;
  try {
    fixedAmount = fixed.text ? parseUnits(fixed.text, tokens[fixed.side].decimals) : 0n;
  } catch {
    // More decimals than the token has: treated as no amount until it is corrected.
  }
  const plan = planDeposit({ pool, tickLower, tickUpper, amount: fixedAmount, side: fixed.side });
  const amounts: [bigint, bigint] = [plan.amount0, plan.amount1];
  const shownAmount = (side: Side) =>
    fixed.side === side ? fixed.text : amounts[side] > 0n ? trimDecimals(formatUnits(amounts[side], tokens[side].decimals), 8) : "";

  const [low, high] = shownRange(pool, orientation, tickLower, tickUpper);
  const fullRange = isFullRange(pool, tickLower, tickUpper);
  const unit = `${orientation.quote.symbol} per ${orientation.base.symbol}`;

  /** Moves one edge of the range to a tick, keeping the range at least one spacing wide. */
  const setEdge = (edge: Edge, tick: number) => {
    // On an inverted pool the lower shown price is the upper tick.
    const isLowerTick = (edge === "low") !== orientation.inverted;
    const snapped = nearestUsableTick(tick, pool.tickSpacing);
    setPreset(null);
    setTicks(([lower, upper]) =>
      isLowerTick ? [Math.min(snapped, upper - pool.tickSpacing), upper] : [lower, Math.max(snapped, lower + pool.tickSpacing)],
    );
  };
  const edgeTick = (edge: Edge) => ((edge === "low") !== orientation.inverted ? tickLower : tickUpper);
  /** One spacing step in the direction that raises (+1) or lowers (−1) the shown price. */
  const nudge = (edge: Edge, direction: 1 | -1) => setEdge(edge, edgeTick(edge) + direction * (orientation.inverted ? -1 : 1) * pool.tickSpacing);

  const choosePreset = (id: PresetId) => {
    const chosen = PRESETS.find((entry) => entry.id === id)!;
    setPreset(id);
    setTicks(chosen.spread == null ? fullRangeTicks(pool.tickSpacing) : ticksAround(pool, chosen.spread));
  };

  const liquidityAtPrice = useMemo(() => (profile ? curveLookup(profile, pool) : undefined), [profile, pool]);

  const wrongNetwork = Boolean(address) && chain?.id !== SEPOLIA_ID;
  const short = ([0, 1] as const).find((side) => {
    const balance = balanceOf(side);
    return amounts[side] > 0n && balance !== null && amounts[side] > balance;
  });
  const needsApproval = (side: Side) => amounts[side] > 0n && !paysEth(side) && allowanceOf(side) < amounts[side];
  const busy = tx.kind === "working";

  const submit = async () => {
    if (!address) return openConnectModal?.();
    if (!publicClient) return;
    try {
      if (wrongNetwork) {
        setTx({ kind: "working", label: "Switch to Sepolia in your wallet…" });
        await switchChainAsync({ chainId: SEPOLIA_ID });
        setTx({ kind: "idle" });
        return;
      }

      for (const side of [0, 1] as const) {
        if (!needsApproval(side)) continue;
        const token = tokens[side];
        setTx({ kind: "working", label: `Approve ${token.symbol} in your wallet…` });
        // Exactly what this deposit takes: the position manager is left with no standing allowance.
        const hash = await writeContractAsync({ address: token.address as `0x${string}`, abi: erc20Abi, functionName: "approve", args: [MANAGER, amounts[side]] });
        setTx({ kind: "working", label: `Waiting for the ${token.symbol} approval to confirm…` });
        notify({ id: hash, hash, status: "pending", title: "Approval submitted", detail: token.symbol });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        notify({ id: hash, hash, status: receipt.status === "success" ? "success" : "error", title: receipt.status === "success" ? "Approval confirmed" : "Approval failed" });
        if (receipt.status !== "success") throw new Error(`The ${token.symbol} approval reverted`);
      }

      setTx({ kind: "working", label: "Checking the deposit…" });
      const call = buildMintCall({
        pool,
        tickLower,
        tickUpper,
        amount0Desired: amounts[0],
        amount1Desired: amounts[1],
        amount0Min: withTolerance(amounts[0], TOLERANCE_BPS),
        amount1Min: withTolerance(amounts[1], TOLERANCE_BPS),
        recipient: address,
        deadline: deadlineIn(1200),
        payWithEth: usesEth,
      });
      // A dry run from the wallet's own address: a deposit that would revert is caught here, not on-chain.
      try {
        await publicClient.call({ account: address, to: call.to, data: call.data, value: call.value });
      } catch {
        throw new Error("This deposit would fail right now — the pool price has just moved. Try again.");
      }

      setTx({ kind: "working", label: "Confirm the deposit in your wallet…" });
      const hash = await sendTransactionAsync({ to: call.to, data: call.data, value: call.value });
      setTx({ kind: "working", label: "Adding liquidity…" });
      const pair = `${orientation.base.symbol} / ${orientation.quote.symbol}`;
      notify({ id: hash, hash, status: "pending", title: "Deposit submitted", detail: pair });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      notify({ id: hash, hash, status: receipt.status === "success" ? "success" : "error", title: receipt.status === "success" ? "Position opened" : "Deposit failed" });
      if (receipt.status !== "success") throw new Error("The deposit reverted on-chain");
      setTx({ kind: "idle" });
      setFixed((current) => ({ ...current, text: "" }));
      queryClient.invalidateQueries({ queryKey: ["aether-pools"] });
      queryClient.invalidateQueries({ queryKey: ["aether-pool"] });
      queryClient.invalidateQueries({ queryKey: ["aether-positions"] });
      reads.refetch();
      native.refetch();
    } catch (error) {
      setTx({ kind: "error", message: describeError(error, "The deposit could not be sent.") });
    }
  };

  const actionLabel = () => {
    if (!address) return "Connect wallet";
    if (wrongNetwork) return "Switch to Sepolia";
    if (plan.liquidity === 0n) return needs[fixed.side] ? "Enter an amount" : `Enter a ${tokens[fixed.side === 0 ? 1 : 0].symbol} amount`;
    if (short !== undefined) return `Insufficient ${paysEth(short) ? "ETH" : tokens[short].symbol}`;
    const approvals = ([0, 1] as const).filter(needsApproval);
    return approvals.length ? `Approve ${approvals.map((side) => tokens[side].symbol).join(" + ")} & add liquidity` : "Add liquidity";
  };
  const disabled = busy || (Boolean(address) && !wrongNetwork && (plan.liquidity === 0n || short !== undefined));

  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-center justify-between gap-3 rounded-field border border-line px-3.5 py-2.5 text-[13px]">
          <span className="text-ink-2">Current price</span>
          <span className="nums text-ink">
            1 {orientation.base.symbol} = {formatPriceValue(price)} {orientation.quote.symbol}
          </span>
        </div>

        <div className="mt-3">
          <LiquidityRange
            low={low}
            high={high}
            price={price}
            fullRange={fullRange}
            inRange={needs0 && needs1}
            liquidityAtPrice={liquidityAtPrice}
            onChange={(edge, value) => setEdge(edge, tickAtShownPrice(pool, orientation, value))}
            onNudge={nudge}
          />
        </div>

        <Segmented label="Range presets" size="sm" className="mt-3" value={preset} onChange={choosePreset} options={PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))} />

        <div className="mt-3 grid grid-cols-2 gap-3">
          {(["low", "high"] as const).map((edge) => (
            <PriceField
              key={edge}
              label={edge === "low" ? "Min price" : "Max price"}
              unit={unit}
              value={edge === "low" ? low : high}
              current={price}
              unbounded={fullRange}
              onCommit={(value) => setEdge(edge, tickAtShownPrice(pool, orientation, value))}
              onNudge={(direction) => nudge(edge, direction)}
            />
          ))}
        </div>

        {needs0 && needs1 ? null : (
          <p className="mt-2.5 rounded-field border border-warn/25 bg-warn/8 px-3 py-2 text-[12px] leading-relaxed text-warn">
            The price is {shownPriceAtTick(pool, orientation, pool.tick) < low ? "below" : "above"} this range: the position takes only {tokens[needs0 ? 0 : 1].symbol} and earns nothing until the
            price enters it.
          </p>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[12.5px] font-medium text-ink-2">Deposit</h3>
          {poolHasWeth(pool) ? (
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
              <input type="checkbox" checked={payWithEth} onChange={(event) => setPayWithEth(event.target.checked)} className="size-3.5 accent-accent" />
              Pay with ETH
            </label>
          ) : null}
        </div>
        <div className="mt-2 space-y-2">
          {order.map((side) => {
            const token = tokens[side];
            const balance = balanceOf(side);
            const symbol = paysEth(side) ? "ETH" : token.symbol;
            return (
              <div key={side} className={`rounded-field border border-line bg-inset px-3.5 py-2.5 ${needs[side] ? "focus-within:border-line-2" : "opacity-60"}`}>
                <div className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
                  <span>{needs[side] ? symbol : `${symbol} — not needed in this range`}</span>
                  {balance !== null ? (
                    <button
                      type="button"
                      disabled={!needs[side] || balance === 0n}
                      onClick={() => setFixed({ side, text: formatUnits(balance, token.decimals) })}
                      className="nums transition-colors hover:text-accent disabled:hover:text-ink-2"
                    >
                      Balance: {formatTokenAmount(balance, token.decimals)}
                    </button>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <input
                    aria-label={`${symbol} amount`}
                    value={needs[side] ? shownAmount(side) : ""}
                    onChange={(event) => setFixed({ side, text: sanitizeAmount(event.target.value) })}
                    disabled={!needs[side]}
                    placeholder="0.0"
                    inputMode="decimal"
                    autoComplete="off"
                    className="amount-input min-w-0 flex-1 bg-transparent text-[22px] outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
                  />
                  <span className="flex shrink-0 items-center gap-1.5 text-[14px] font-medium">
                    <TokenIcon token={paysEth(side) ? ETH : token} size="sm" />
                    {symbol}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="space-y-2.5">
        <TxNotice state={tx} />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className={`h-[50px] w-full rounded-field text-[15px] font-medium transition-colors ${disabled ? "cursor-not-allowed bg-inset-2 text-ink-3" : "bg-ink text-white hover:bg-ink/88"}`}
        >
          {actionLabel()}
        </button>
      </div>
    </div>
  );
}

/** A price that can be typed or stepped by one tick spacing; commits on blur or Enter. */
function PriceField({
  label,
  unit,
  value,
  current,
  unbounded,
  onCommit,
  onNudge,
}: {
  label: string;
  unit: string;
  value: number;
  /** The pool's price now: the field says how far from it this edge sits. */
  current: number;
  unbounded: boolean;
  onCommit: (value: number) => void;
  onNudge: (direction: 1 | -1) => void;
}) {
  // While the field is being edited its text is the user's; otherwise it shows the snapped price.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = unbounded ? (label === "Min price" ? "0" : "∞") : formatPriceValue(value);
  const commit = () => {
    const parsed = Number(draft);
    if (draft !== null && Number.isFinite(parsed) && parsed > 0) onCommit(parsed);
    setDraft(null);
  };
  const away = current > 0 ? (value / current - 1) * 100 : 0;
  const step = "flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-[15px] leading-none text-ink-2 transition-colors hover:border-line-2 hover:text-ink";

  return (
    <div className="rounded-field border border-line bg-inset px-3 py-2.5 focus-within:border-line-2">
      <label className="block text-[12px] text-ink-2">
        <span className="flex items-center justify-between gap-2">
          {label}
          {unbounded || !Number.isFinite(away) ? null : (
            <span className="nums text-[11px] text-ink-3">
              {away >= 0 ? "+" : "−"}
              {Math.abs(away) >= 1000 ? Math.round(Math.abs(away)).toLocaleString("en-US") : Math.abs(away).toFixed(1)}%
            </span>
          )}
        </span>
        <input
          value={draft ?? shown}
          onFocus={() => setDraft(unbounded ? "" : String(Number(value.toPrecision(8))))}
          onChange={(event) => setDraft(sanitizeAmount(event.target.value))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          inputMode="decimal"
          autoComplete="off"
          className="amount-input mt-1 block w-full min-w-0 bg-transparent text-[18px] text-ink outline-none"
        />
      </label>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] leading-tight text-ink-3">{unit}</span>
        <span className="flex gap-1">
          <button type="button" aria-label={`Lower the ${label.toLowerCase()}`} onClick={() => onNudge(-1)} className={step}>
            −
          </button>
          <button type="button" aria-label={`Raise the ${label.toLowerCase()}`} onClick={() => onNudge(1)} className={step}>
            +
          </button>
        </span>
      </div>
    </div>
  );
}
