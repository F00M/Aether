"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { useReadContracts } from "wagmi";

import { PROTO_COLORS } from "@/config/theme";
import { TOKENS } from "@/config/tokens";
import type { Protocol, Quote, Route, Token } from "@/swap/types";

function protocolLabel(route: Route): string {
  if (route.type?.startsWith("mixed")) {
    const protocols = route.legs?.map((leg) => leg.protocol?.toUpperCase()).filter(Boolean);
    if (protocols?.length === 2) {
      return protocols[0] === protocols[1] ? (protocols[0] as string) : protocols.join("+");
    }
    return "Bridge";
  }
  if (route.type?.startsWith("v2")) return "V2";
  return route.type?.startsWith("v4") ? "V4" : "V3";
}

function feeLabel(route: Route): string {
  if (route.type === "multihop" || route.type === "v4_multihop" || route.type?.startsWith("mixed")) {
    return `${route.fee / 10000}% → ${(route.fee2 ?? 0) / 10000}%`;
  }
  return `${route.fee / 10000}%`;
}

function tokenByAddress(address?: string): Token | undefined {
  if (!address) return undefined;
  const normalized = address.toLowerCase();
  return (TOKENS as Token[]).find((token) => {
    const tokenAddress =
      token.address === "ETH"
        ? "0x0000000000000000000000000000000000000000"
        : token.address.toLowerCase();
    return tokenAddress === normalized;
  });
}

function routeUsesProtocol(route: Route, protocol: Protocol): boolean {
  if (route.type?.startsWith("mixed")) {
    return route.legs?.some((leg) => leg.protocol === protocol) ?? false;
  }
  if (protocol === "v2") return Boolean(route.type?.startsWith("v2"));
  return protocol === "v4"
    ? Boolean(route.type?.startsWith("v4"))
    : !route.type?.startsWith("v2") && !route.type?.startsWith("v4");
}

/** Mixed routes count fractionally, split evenly across their legs' protocols. */
function protocolShare(routes: Route[], protocol: Protocol): number {
  return Math.round(
    routes.reduce((sum, route) => {
      if (!route.type?.startsWith("mixed")) {
        return sum + (routeUsesProtocol(route, protocol) ? route.percent : 0);
      }
      const legs = route.legs?.filter((leg) => leg.protocol) ?? [];
      if (legs.length === 0) return sum;
      const matchingLegs = legs.filter((leg) => leg.protocol === protocol).length;
      return sum + (route.percent * matchingLegs) / legs.length;
    }, 0),
  );
}

function isHighImpactQuote(quote: Quote): boolean {
  return Number.parseFloat(quote?.priceImpactPct ?? "0") > 3;
}

/** One-line protocol summary, e.g. "V3 + V4" or "Balanced". */
function protocolSummary(quote: Quote, shares: Record<Protocol, number>): string {
  if (quote.isBalanced) return "Balanced";
  const active = (["v2", "v3", "v4"] as Protocol[])
    .filter((p) => shares[p] > 0)
    .map((p) => p.toUpperCase());
  return active.length ? active.join(" + ") : "V3";
}

function ProportionBar({ shares }: { shares: Record<Protocol, number> }) {
  const segments = (["v2", "v3", "v4"] as Protocol[])
    .map((p) => ({ p, value: shares[p] }))
    .filter((s) => s.value > 0);
  if (segments.length === 0) return null;

  return (
    <div className="flex h-[5px] gap-0.5 overflow-hidden rounded-full">
      {segments.map((s) => (
        <div
          key={s.p}
          title={`${s.p.toUpperCase()} ${s.value}%`}
          className="rounded-full"
          style={{ flex: s.value, backgroundColor: PROTO_COLORS[s.p] }}
        />
      ))}
    </div>
  );
}

function RouteRow({
  route,
  tokenIn,
  tokenOut,
  symbols = {},
}: {
  route: Route;
  tokenIn?: Token;
  tokenOut?: Token;
  symbols?: Record<string, string>;
}) {
  const inSymbol = tokenIn?.symbol ?? "IN";
  const outSymbol = tokenOut?.symbol ?? "OUT";
  const viaToken = tokenByAddress(route.via);
  const viaSymbol =
    viaToken?.symbol ??
    (route.via
      ? (symbols[route.via.toLowerCase()] ?? `${route.via.slice(0, 6)}…`)
      : null);
  const proto = protocolLabel(route);
  const protoKey: Protocol = proto.toLowerCase().includes("v2")
    ? "v2"
    : proto.toLowerCase().includes("v4")
      ? "v4"
      : "v3";

  return (
    <div className="flex items-center gap-2 py-2 text-[12px]">
      <span className="nums min-w-[38px] shrink-0 rounded-md border border-line bg-inset px-1.5 py-0.5 text-center text-[11px] font-medium">
        {route.percent}%
      </span>
      <span
        className="shrink-0 text-[11px] font-semibold"
        style={{ color: PROTO_COLORS[protoKey] }}
      >
        {proto}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-ink-2">
        <span className="font-medium text-ink">{inSymbol}</span>
        {(route.hops ?? 0) > 1 && viaSymbol ? (
          <>
            <span className="text-ink-3">→</span>
            <span>{viaSymbol}</span>
          </>
        ) : null}
        <span className="text-ink-3">→</span>
        <span className="font-medium text-ink">{outSymbol}</span>
      </span>
      <span className="nums shrink-0 text-[11px] text-ink-3">{feeLabel(route)}</span>
    </div>
  );
}

export function RouteDisplay({
  quote,
  tokenIn,
  tokenOut,
}: {
  quote: Quote | null;
  tokenIn?: Token;
  tokenOut?: Token;
}) {
  const [open, setOpen] = useState(false);

  // Corridors discovered from the pool graph are arbitrary tokens with no entry in the token list
  // — read their ERC-20 symbol so a hop reads "ETH → 0xD1 → USDC", not an address.
  const unknownVias = [
    ...new Set(
      (quote?.routes ?? [])
        .map((route) => route.via?.toLowerCase())
        .filter((via): via is string => Boolean(via) && !tokenByAddress(via)),
    ),
  ];
  const { data: symbolReads } = useReadContracts({
    contracts: unknownVias.map((address) => ({
      address: address as `0x${string}`,
      abi: erc20Abi,
      functionName: "symbol" as const,
    })),
    query: { enabled: unknownVias.length > 0, staleTime: Infinity },
  });
  const symbols: Record<string, string> = {};
  unknownVias.forEach((address, i) => {
    const read = symbolReads?.[i];
    if (read?.status === "success" && typeof read.result === "string" && read.result) symbols[address] = read.result;
  });

  if (!quote || !quote.routes || quote.routes.length === 0) return null;

  const routes = quote.routes;
  const shares: Record<Protocol, number> = {
    v2: protocolShare(routes, "v2"),
    v3: protocolShare(routes, "v3"),
    v4: protocolShare(routes, "v4"),
  };
  const summary = protocolSummary(quote, shares);
  const highImpact = isHighImpactQuote(quote);

  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-field border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-2"
      >
        <span className="size-[7px] shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold">
              {routes.length} route{routes.length > 1 ? "s" : ""}
            </span>
            <span className="text-[11px] text-ink-2">
              · {highImpact ? "best executable" : summary}
            </span>
          </span>
          <span className="mt-1.5 block">
            <ProportionBar shares={shares} />
          </span>
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="animate-fade -mt-px rounded-b-field border border-t-0 border-line bg-surface px-3 pb-2 pt-1">
          <div className="flex gap-3.5 py-1.5 text-[11px] text-ink-3">
            {(["v2", "v3", "v4"] as Protocol[]).map((p) => (
              <span key={p} className="flex items-center gap-1.5">
                <span
                  className="size-[7px] rounded-[2px]"
                  style={{ backgroundColor: PROTO_COLORS[p] }}
                />
                {p.toUpperCase()} {shares[p]}%
              </span>
            ))}
          </div>
          <div className="mt-1 border-t border-line">
            {routes.map((route, i) => (
              <RouteRow key={i} route={route} tokenIn={tokenIn} tokenOut={tokenOut} symbols={symbols} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
