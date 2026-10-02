"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { ConnectWallet } from "@/components/connect-wallet";

const NAV = [
  { label: "Swap", href: "/" },
  { label: "Pools", href: "/pools" },
  { label: "Stats", href: "/stats" },
] as const;

export function SiteHeader() {
  return (
    // Solid, not frosted: a backdrop blur on a sticky bar re-blurs the page under it on every
    // scrolled frame, and that was the scroll's biggest cost on a phone.
    <header className="sticky top-0 z-40 border-b border-line bg-canvas">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-6 px-5 lg:px-8">
        <Link href="/" className="pressable flex h-9 items-center gap-2.5">
          <Mark />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Aether</span>
        </Link>

        <PrimaryNav className="hidden w-[252px] md:grid" />

        <div className="ml-auto flex items-center gap-2">
          <NetworkPill />
          <ConnectWallet />
        </div>
      </div>

      {/* Below a tablet the top row has no room for the links, so they get a row of their own. */}
      <div className="border-t border-line px-3 py-1 md:hidden">
        <PrimaryNav className="grid" />
      </div>
    </header>
  );
}

/** Which network the app is on — until a wallet is connected, when its own chain button says so. */
function NetworkPill() {
  const { isConnected } = useAccount();
  if (isConnected) return null;
  return (
    <span className="hidden items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 sm:flex">
      <span className="size-[7px] rounded-full bg-accent" />
      Sepolia
    </span>
  );
}

function PrimaryNav({ className }: { className: string }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { address } = useAccount();
  const active = NAV.findIndex((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)));

  // The pointer (or a finger, or keyboard focus) reaching a link is the cue to start reading that
  // page's data, so it is usually there by the time the page is. The query module is loaded on
  // demand: the header ships on every page and shouldn't carry the pool and history readers.
  const warm = (href: string) => {
    if (href === "/") return;
    void import("@/lib/queries").then(({ poolsQuery, positionsQuery, statsQuery }) => {
      if (href === "/pools") {
        void queryClient.prefetchQuery(poolsQuery());
        if (address) void queryClient.prefetchQuery(positionsQuery(address));
      }
      if (href === "/stats") void queryClient.prefetchQuery(statsQuery());
    });
  };

  return (
    <nav
      aria-label="Primary"
      className={`segmented ${className}`}
      style={{ "--segments": NAV.length, "--active": Math.max(active, 0) } as CSSProperties}
    >
      <span aria-hidden="true" className={`segmented-thumb rounded-lg bg-inset ${active < 0 ? "opacity-0" : ""}`} />
      {NAV.map((item, index) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={index === active ? "page" : undefined}
          onPointerEnter={() => warm(item.href)}
          onFocus={() => warm(item.href)}
          className={`pressable relative z-10 rounded-lg py-1.5 text-center text-[14px] font-medium ${
            index === active ? "text-ink" : "text-ink-2 hover:text-ink"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function Mark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="7" stroke="var(--color-ink)" strokeWidth="1.6" />
      <path
        d="M7 17 12 6.5 17 17"
        stroke="var(--color-accent)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.3 13.4h5.4" stroke="var(--color-ink)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
