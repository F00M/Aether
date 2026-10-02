"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";

import { baseShare, currentPrice, formatPriceValue, formatTokenAmount, orientationOf } from "@/components/pools/pool-format";
import { Notice, PairIcons, PairTitle, PositionCard, card, outlineButton, solidButton, stagger } from "@/components/pools/pool-parts";
import { RemoveLiquidityModal } from "@/components/pools/remove-liquidity-modal";
import { Segmented } from "@/components/ui/segmented";
import { poolsQuery, positionsQuery } from "@/lib/queries";
import { V3_FEE_TIERS, type Pool, type Position } from "@/swap/liquidity";
import type { Token } from "@/swap/types";

const REFRESH_MS = 60_000;

type Tab = "pools" | "positions";
type Dialog = { kind: "remove" | "collect"; position: Position } | null;

export function PoolsView() {
  const { address } = useAccount();
  const [tab, setTab] = useState<Tab>("pools");
  const [dialog, setDialog] = useState<Dialog>(null);

  const pools = useQuery({ ...poolsQuery(), refetchInterval: REFRESH_MS });
  const positions = useQuery({
    ...positionsQuery(address),
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
  });

  const owned = address ? positions.data : undefined;
  const liquid = pools.data?.filter((pool) => pool.liquidity > 0n).length;
  const earning = owned?.filter((position) => position.inRange && position.liquidity > 0n).length;

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-3 gap-3 sm:gap-4">
        <Summary label="Pools" value={pools.data ? String(pools.data.length) : null} note="between the listed tokens" />
        <Summary label="Liquid now" value={liquid === undefined ? null : String(liquid)} note="have liquidity at the current price" />
        <Summary
          label="Your positions"
          shortLabel="Yours"
          value={!address ? "—" : owned ? String(owned.length) : null}
          note={!address ? "connect a wallet to see them" : owned?.length ? `${earning} earning fees right now` : "none open yet"}
        />
      </dl>

      <Segmented
        kind="tabs"
        label="What to show"
        value={tab}
        onChange={setTab}
        className="w-full sm:w-fit"
        options={[
          { value: "pools", label: "All pools" },
          {
            value: "positions",
            label: (
              <>
                My positions
                {owned?.length ? <span className="nums rounded-full bg-accent-wash px-1.5 text-[11px] leading-[18px] text-accent">{owned.length}</span> : null}
              </>
            ),
          },
        ]}
      />

      {/* Keyed so the panel that arrives plays its entrance. */}
      <div key={tab} className="animate-rise" role="tabpanel">
        {tab === "pools" ? (
          <PoolBrowser
            pools={pools.data}
            loading={pools.isPending}
            failed={pools.isError}
            refreshing={pools.isFetching && !pools.isPending}
            onRetry={() => pools.refetch()}
          />
        ) : (
          <Positions
            connected={Boolean(address)}
            loading={positions.isPending && Boolean(address)}
            failed={positions.isError}
            positions={owned ?? []}
            onRetry={() => positions.refetch()}
            onBrowse={() => setTab("pools")}
            onRemove={(position) => setDialog({ kind: "remove", position })}
            onCollect={(position) => setDialog({ kind: "collect", position })}
          />
        )}
      </div>

      {dialog ? <RemoveLiquidityModal position={dialog.position} feesOnly={dialog.kind === "collect"} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function Summary({ label, shortLabel, value, note }: { label: string; shortLabel?: string; value: string | null; note: string }) {
  return (
    <div className={`${card} px-3.5 py-3 sm:px-4 sm:py-3.5`}>
      <dt className="text-[12px] text-ink-2 sm:text-[12.5px]">
        {/* Three tiles share a phone's width, so a long label gets a short form there. */}
        {shortLabel ? (
          <>
            <span className="sm:hidden">{shortLabel}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </dt>
      <dd className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[26px]">
        {value ?? <span className="skeleton inline-block h-6 w-10 rounded align-middle" aria-label="Loading" />}
      </dd>
      <dd className="mt-1 hidden text-[12px] leading-snug text-ink-3 sm:block">{note}</dd>
    </div>
  );
}

// ------------------------------------------------------------------ all pools

const FEE_OPTIONS = [{ value: "all", label: "All" }, ...V3_FEE_TIERS.map((tier) => ({ value: String(tier.fee), label: tier.label }))];

function PoolBrowser({
  pools,
  loading,
  failed,
  refreshing,
  onRetry,
}: {
  pools: Pool[] | undefined;
  loading: boolean;
  failed: boolean;
  refreshing: boolean;
  onRetry: () => void;
}) {
  const [search, setSearch] = useState("");
  const [fee, setFee] = useState("all");
  const [liquidOnly, setLiquidOnly] = useState(false);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = (token: Token) => token.symbol.toLowerCase().includes(term) || token.name.toLowerCase().includes(term) || token.address.toLowerCase() === term;
    return (pools ?? [])
      .filter((pool) => (fee === "all" || pool.fee === Number(fee)) && (!liquidOnly || pool.liquidity > 0n) && (!term || matches(pool.token0) || matches(pool.token1)))
      // Pools that can trade right now come first; within each group the list order is kept.
      .sort((a, b) => Number(b.liquidity > 0n) - Number(a.liquidity > 0n));
  }, [pools, search, fee, liquidOnly]);

  if (loading) return <PoolSkeletons />;
  if (!pools) {
    return (
      <Notice
        text={failed ? "The pools could not be loaded from the RPC." : "No pools found."}
        action={
          <button type="button" onClick={onRetry} className={outlineButton}>
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <label className="flex h-10 min-w-0 flex-1 basis-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 transition-colors focus-within:border-accent sm:max-w-[260px] sm:basis-auto">
          <SearchIcon />
          <span className="sr-only">Search pools by token</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search a token"
            autoComplete="off"
            spellCheck={false}
            // 16px on a phone: iOS Safari zooms the page into any field with smaller text.
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-ink-3 sm:text-[14px]"
          />
        </label>
        <Segmented label="Fee tier" size="sm" value={fee} onChange={setFee} options={FEE_OPTIONS} className="w-full sm:w-auto" />
        <button
          type="button"
          role="switch"
          aria-checked={liquidOnly}
          onClick={() => setLiquidOnly((value) => !value)}
          className="pressable flex h-9 items-center gap-2 rounded-xl px-1 text-[13px] font-medium text-ink-2 hover:text-ink"
        >
          <span className={`relative h-5 w-9 rounded-full transition-colors ${liquidOnly ? "bg-accent" : "bg-inset-2"}`}>
            <span className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-surface shadow-sm transition-transform duration-200 ${liquidOnly ? "translate-x-4" : ""}`} />
          </span>
          Liquid only
        </button>
        <p className="nums ml-auto flex items-center gap-2 text-[12.5px] text-ink-3" aria-live="polite">
          {refreshing ? <span className="size-1.5 animate-pulse rounded-full bg-accent" title="Refreshing" /> : null}
          {shown.length} of {pools.length}
        </p>
      </div>

      {shown.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {shown.map((pool, index) => (
            <li key={pool.address} className="animate-rise min-w-0" style={stagger(index)}>
              <PoolCard pool={pool} />
            </li>
          ))}
        </ul>
      ) : (
        <Notice
          text="No pool matches these filters."
          action={
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFee("all");
                setLiquidOnly(false);
              }}
              className={outlineButton}
            >
              Clear filters
            </button>
          }
        />
      )}
    </div>
  );
}

/** The whole card is the link to the pool's own page; everything inside is phrasing content for that reason. */
function PoolCard({ pool }: { pool: Pool }) {
  const orientation = orientationOf(pool);
  const liquid = pool.liquidity > 0n;

  return (
    <Link href={`/pools/${pool.address}`} className={`${card} card-interactive group block w-full p-4 text-left sm:p-5`}>
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <PairIcons pool={pool} />
          <PairTitle pool={pool} />
        </span>
        <span
          title={liquid ? "Liquidity is in range at the current price" : "No liquidity at the current price: swaps can't cross this pool right now"}
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${
            liquid ? "border-accent/25 bg-accent-wash text-accent" : "border-line bg-inset text-ink-2"
          }`}
        >
          <span className={`size-1.5 rounded-full ${liquid ? "bg-accent" : "bg-ink-3"}`} />
          {liquid ? "Liquid" : "Idle"}
        </span>
      </span>

      <span className="mt-5 block">
        <span className="block text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">Price</span>
        <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
          <span className="nums text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink">{formatPriceValue(currentPrice(pool, orientation))}</span>
          <span className="text-[12.5px] text-ink-2">
            {orientation.quote.symbol} per {orientation.base.symbol}
          </span>
        </span>
      </span>

      <Composition pool={pool} />

      <span className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[13px] font-medium text-ink">
        Add liquidity
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-inset text-ink-2 transition-[transform,background-color,color] duration-200 group-hover:translate-x-0.5 group-hover:bg-ink group-hover:text-white">
          <ArrowIcon />
        </span>
      </span>
    </Link>
  );
}

/**
 * What the pool holds, split by value at its own price. Two parts of one whole: each wears its
 * own colour, is separated by a gap, and is named with its amount and share right below.
 */
function Composition({ pool }: { pool: Pool }) {
  const orientation = orientationOf(pool);
  const share = baseShare(pool, orientation);
  const baseIs0 = !orientation.inverted;
  const parts = [
    { token: orientation.base, amount: baseIs0 ? pool.balance0 : pool.balance1, share: share ?? 0, fill: "bg-accent" },
    { token: orientation.quote, amount: baseIs0 ? pool.balance1 : pool.balance0, share: share === null ? 0 : 1 - share, fill: "bg-series-2" },
  ];
  const percent = (value: number) => (value > 0 && value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`);

  return (
    <span className="mt-4 block">
      <span className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-inset-2" aria-hidden="true">
        {share === null
          ? null
          : parts.map((part) => (part.share > 0 ? <span key={part.token.address} className={`h-full rounded-full ${part.fill}`} style={{ width: `${Math.max(part.share * 100, 2)}%` }} /> : null))}
      </span>
      <span className="mt-2 flex items-start justify-between gap-3 text-[12px]">
        {share === null ? (
          <span className="text-ink-3">The pool holds no tokens yet</span>
        ) : (
          parts.map((part, index) => (
            <span key={part.token.address} className={`flex min-w-0 items-center gap-1.5 ${index === 1 ? "text-right" : ""}`}>
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-[3px] ${part.fill}`} />
              <span className="nums truncate text-ink">
                {formatTokenAmount(part.amount, part.token.decimals)} {part.token.symbol}
              </span>
              <span className="nums shrink-0 text-ink-3">{percent(part.share)}</span>
            </span>
          ))
        )}
      </span>
    </span>
  );
}

function PoolSkeletons() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading pools">
      <div className="flex gap-3">
        <span className="skeleton h-10 w-full max-w-[260px] rounded-xl" />
        <span className="skeleton hidden h-10 w-64 rounded-xl sm:block" />
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className={`${card} p-4 sm:p-5`}>
            <div className="flex items-center gap-3">
              <span className="skeleton size-[34px] rounded-full" />
              <span className="flex-1 space-y-2">
                <span className="skeleton block h-4 w-28 rounded" />
                <span className="skeleton block h-3 w-20 rounded" />
              </span>
            </div>
            <span className="skeleton mt-6 block h-7 w-36 rounded" />
            <span className="skeleton mt-5 block h-2 w-full rounded-full" />
            <span className="skeleton mt-3 block h-3 w-full rounded" />
            <span className="skeleton mt-5 block h-7 w-full rounded" />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ positions

function Positions({
  connected,
  loading,
  failed,
  positions,
  onRetry,
  onBrowse,
  onRemove,
  onCollect,
}: {
  connected: boolean;
  loading: boolean;
  failed: boolean;
  positions: Position[];
  onRetry: () => void;
  onBrowse: () => void;
  onRemove: (position: Position) => void;
  onCollect: (position: Position) => void;
}) {
  const { openConnectModal } = useConnectModal();

  if (!connected) {
    return (
      <Notice
        icon={<WalletIcon />}
        text="Connect a wallet to see and manage its liquidity positions."
        action={
          <button type="button" onClick={() => openConnectModal?.()} className={solidButton}>
            Connect wallet
          </button>
        }
      />
    );
  }
  if (loading) {
    return (
      <ul className="grid gap-3 sm:gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading positions">
        {Array.from({ length: 2 }, (_, index) => (
          <li key={index} className={`${card} p-4 sm:p-5`}>
            <div className="flex items-center gap-3">
              <span className="skeleton size-[34px] rounded-full" />
              <span className="flex-1 space-y-2">
                <span className="skeleton block h-4 w-32 rounded" />
                <span className="skeleton block h-3 w-20 rounded" />
              </span>
            </div>
            <span className="skeleton mt-5 block h-[88px] w-full rounded-field" />
            <span className="skeleton mt-3 block h-[64px] w-full rounded-field" />
          </li>
        ))}
      </ul>
    );
  }
  if (failed && !positions.length) {
    return (
      <Notice
        text="Your positions could not be loaded from the RPC."
        action={
          <button type="button" onClick={onRetry} className={outlineButton}>
            Try again
          </button>
        }
      />
    );
  }
  if (!positions.length) {
    return (
      <Notice
        icon={<LayersIcon />}
        text="This wallet has no open positions. Pick a pool, choose a price range, and it will show up here."
        action={
          <button type="button" onClick={onBrowse} className={solidButton}>
            Browse pools
          </button>
        }
      />
    );
  }

  return (
    <ul className="grid gap-3 sm:gap-4 lg:grid-cols-2">
      {positions.map((position, index) => (
        <li key={position.tokenId.toString()} className={`${card} animate-rise min-w-0 p-4 sm:p-5`} style={stagger(index)}>
          <PositionCard position={position} linked onRemove={() => onRemove(position)} onCollect={() => onCollect(position)} />
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ shared bits

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-ink-3">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="5" width="15" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 5V4.5A1.5 1.5 0 0 1 6.5 3h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="13.5" cy="10.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m10 3 7 3.6-7 3.6-7-3.6L10 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m3 10.2 7 3.6 7-3.6M3 13.6l7 3.6 7-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
