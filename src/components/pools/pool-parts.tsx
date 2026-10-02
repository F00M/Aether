"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { formatUnits } from "viem";

import { currentPrice, feeLabel, formatPriceValue, formatTokenAmount, isFullRange, isListed, orientationOf, shownRange } from "@/components/pools/pool-format";
import { RangeTrack } from "@/components/pools/range-track";
import { TokenIcon } from "@/components/ui/token-icon";
import { compact, shortenAddress } from "@/lib/format";
import type { Pool, Position } from "@/swap/liquidity";
import type { Token } from "@/swap/types";

/** The pieces the pool list and a pool's own page both draw. */

export const card = "rounded-card border border-line bg-surface shadow-card";
/** Sibling index for the staggered entrance (see .animate-rise). */
export const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

export function PairIcons({ pool, size = "lg" }: { pool: Pool; size?: "md" | "lg" }) {
  const { base, quote } = orientationOf(pool);
  return (
    <span className="flex shrink-0 items-center">
      <TokenIcon token={base} size={size} />
      <TokenIcon token={quote} size={size} className="-ml-2 rounded-full ring-2 ring-surface" />
    </span>
  );
}

/** An unlisted token is named by its deployer, so its contract is shown beside the name. */
export function TokenName({ token }: { token: Token }) {
  if (isListed(token)) return <>{token.symbol}</>;
  return (
    <>
      {token.symbol} <span className="nums text-[11.5px] font-normal text-ink-3">{shortenAddress(token.address, 3)}</span>
    </>
  );
}

export function PairTitle({ pool }: { pool: Pool }) {
  const { base, quote } = orientationOf(pool);
  return (
    <span className="min-w-0">
      <span className="block text-[15px] font-semibold tracking-tight text-ink">
        <TokenName token={base} /> / <TokenName token={quote} />
      </span>
      <span className="block text-[12px] text-ink-3">Uniswap V3 · {feeLabel(pool.fee)} fee</span>
    </span>
  );
}

/** `linked` makes the pair a link to the pool's page — for everywhere but that page itself. */
export function PositionCard({ position, linked = false, onRemove, onCollect }: { position: Position; linked?: boolean; onRemove: () => void; onCollect: () => void }) {
  const { pool } = position;
  const orientation = orientationOf(pool);
  const [low, high] = shownRange(pool, orientation, position.tickLower, position.tickUpper);
  const fullRange = isFullRange(pool, position.tickLower, position.tickUpper);
  const hasFees = position.fees0 > 0n || position.fees1 > 0n;
  const closed = position.liquidity === 0n;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        {linked ? (
          <Link href={`/pools/${pool.address}`} className="pressable flex min-w-0 items-center gap-3 rounded-lg hover:opacity-80">
            <PairIcons pool={pool} />
            <PairTitle pool={pool} />
          </Link>
        ) : (
          <span className="flex min-w-0 items-center gap-3">
            <PairIcons pool={pool} />
            <PairTitle pool={pool} />
          </span>
        )}
        <StatusChip position={position} />
      </div>

      <div className="mt-4 rounded-field bg-inset px-3.5 pb-1.5 pt-3">
        <dl className="grid grid-cols-3 gap-2 text-[11.5px] text-ink-3">
          <RangeFigure label="Min" value={fullRange ? "0" : formatPriceValue(low)} />
          <RangeFigure label="Current" value={formatPriceValue(currentPrice(pool, orientation))} align="center" />
          <RangeFigure label="Max" value={fullRange ? "∞" : formatPriceValue(high)} align="right" />
        </dl>
        <div className="mt-2">
          <RangeTrack low={low} high={high} price={currentPrice(pool, orientation)} fullRange={fullRange} tone={closed ? "muted" : position.inRange ? "accent" : "warn"} />
        </div>
        <p className="text-center text-[11px] text-ink-3">
          {orientation.quote.symbol} per {orientation.base.symbol}
          {fullRange ? " · full range" : ""}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Holdings label="Liquidity" pool={pool} amount0={position.amount0} amount1={position.amount1} />
        <Holdings label="Unclaimed fees" pool={pool} amount0={position.fees0} amount1={position.fees1} highlight={hasFees} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onCollect} disabled={!hasFees} className={hasFees ? accentButton : `${outlineButton} disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-surface`}>
          Collect fees
        </button>
        <button type="button" onClick={onRemove} className={outlineButton}>
          Remove
        </button>
        <span className="nums ml-auto text-[11.5px] text-ink-3" title="Uniswap V3 position NFT">
          #{position.tokenId.toString()}
        </span>
      </div>
    </>
  );
}

function RangeFigure({ label, value, align = "left" }: { label: string; value: string; align?: "left" | "center" | "right" }) {
  return (
    <div className={`min-w-0 ${align === "center" ? "text-center" : align === "right" ? "text-right" : ""}`}>
      <dt>{label}</dt>
      <dd className="nums truncate text-[13.5px] text-ink">{value}</dd>
    </div>
  );
}

/** Two of these boxes share a phone's width: past six figures the amount is abbreviated rather than cut off. */
function formatHolding(amount: bigint, decimals: number): string {
  const value = Number(formatUnits(amount, decimals));
  return value >= 100_000 && value < 1e15 ? compact(value) : formatTokenAmount(amount, decimals);
}

function Holdings({ label, pool, amount0, amount1, highlight = false }: { label: string; pool: Pool; amount0: bigint; amount1: bigint; highlight?: boolean }) {
  const rows = [
    { token: pool.token0, amount: amount0 },
    { token: pool.token1, amount: amount1 },
  ];
  return (
    <div className={`min-w-0 rounded-field border px-3 py-2.5 ${highlight ? "border-accent/25 bg-accent-wash" : "border-line bg-surface"}`}>
      <p className="text-[11.5px] text-ink-2">{label}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map(({ token, amount }) => (
          <li key={token.address} className="flex min-w-0 items-center gap-1.5 text-[13px]">
            <TokenIcon token={token} size="sm" />
            <span className="nums truncate text-ink">{formatHolding(amount, token.decimals)}</span>
            <span className="shrink-0 text-ink-3">{token.symbol}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** State is carried by the label and the dot together, not by colour alone. */
function StatusChip({ position }: { position: Position }) {
  const tone =
    position.liquidity === 0n
      ? { label: "Fees only", dot: "bg-ink-3", wrap: "border-line bg-inset text-ink-2" }
      : position.inRange
        ? { label: "In range", dot: "bg-accent", wrap: "border-accent/25 bg-accent-wash text-accent" }
        : { label: "Out of range", dot: "bg-warn", wrap: "border-warn/25 bg-warn/8 text-warn" };
  return (
    <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${tone.wrap}`}>
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      {tone.label}
    </span>
  );
}

export const solidButton = "pressable h-10 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink/88";
export const outlineButton = "pressable h-9 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-medium text-ink hover:bg-inset";
export const accentButton = "pressable h-9 rounded-xl bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-hover";

export function Notice({ icon, text, action }: { icon?: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className={`${card} flex flex-col items-center gap-4 px-5 py-12 text-center`}>
      {icon ? <span className="flex size-11 items-center justify-center rounded-2xl bg-inset text-ink-2">{icon}</span> : null}
      <p className="max-w-sm text-[14px] leading-relaxed text-ink-2">{text}</p>
      {action}
    </div>
  );
}
