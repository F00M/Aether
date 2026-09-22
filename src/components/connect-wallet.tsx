"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

/**
 * RainbowKit handles the wallet list, chain switching and session state; this
 * wraps it in `ConnectButton.Custom` so the trigger matches our surface
 * language instead of RainbowKit's default pill.
 */
export function ConnectWallet() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        // `mounted` guards the SSR pass, where wallet state is unknowable.
        const ready = mounted;
        const connected = ready && account && chain;

        return (
          <div
            aria-hidden={!ready}
            className={ready ? "flex items-center gap-2" : "pointer-events-none opacity-0"}
          >
            {!connected ? (
              <button
                type="button"
                onClick={openConnectModal}
                className="h-9 rounded-xl bg-ink px-4 text-[14px] font-medium text-white transition-colors hover:bg-ink/88"
              >
                Connect wallet
              </button>
            ) : chain.unsupported ? (
              <button
                type="button"
                onClick={openChainModal}
                className="h-9 rounded-xl border border-neg/30 bg-neg/8 px-3.5 text-[14px] font-medium text-neg"
              >
                Wrong network
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={openChainModal}
                  className="hidden h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[14px] font-medium text-ink-2 transition-colors hover:border-line-2 hover:text-ink sm:flex"
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: "var(--color-pos)" }}
                  />
                  {chain.name}
                  <Chevron />
                </button>

                <button
                  type="button"
                  onClick={openAccountModal}
                  className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface pl-2.5 pr-3 text-[14px] font-medium transition-colors hover:border-line-2"
                >
                  <span className="size-2 rounded-full bg-accent" />
                  <span className="nums">{account.displayName}</span>
                </button>
              </>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M2.5 4l2.5 2.5L7.5 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
