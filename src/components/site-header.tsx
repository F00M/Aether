"use client";

import Link from "next/link";

import { ConnectWallet } from "@/components/connect-wallet";

// Pools and Activity are placeholders in the original build too — shown so the
// shape of the product is visible, but not linked anywhere that doesn't exist.
const NAV = [
  { label: "Swap", href: "/", active: true },
  { label: "Pools", href: null, active: false },
  { label: "Activity", href: null, active: false },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-6 px-5 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Aether</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
          {NAV.map((item) =>
            item.href ? (
              <Link
                key={item.label}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className="rounded-lg bg-inset px-3 py-1.5 text-[14px] font-medium text-ink"
              >
                {item.label}
              </Link>
            ) : (
              <span
                key={item.label}
                aria-disabled="true"
                title="Coming soon"
                className="cursor-default rounded-lg px-3 py-1.5 text-[14px] font-medium text-ink-3"
              >
                {item.label}
              </span>
            ),
          )}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 sm:flex">
            <span className="size-[7px] rounded-full bg-accent" />
            Sepolia
          </span>
          <ConnectWallet />
        </div>
      </div>
    </header>
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
