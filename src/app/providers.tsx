"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider, useConfig, type Connector } from "wagmi";
import { getConnectors, reconnect, watchConnectors } from "wagmi/actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";

import { config } from "@/lib/wagmi";

const meridianTheme = lightTheme({
  accentColor: "#14805e",
  accentColorForeground: "#ffffff",
  borderRadius: "large",
  fontStack: "system",
  // No blur behind the wallet dialog: a backdrop filter repaints the whole page every frame.
  overlayBlur: "none",
});

// Connectors whose provider is an SDK that has to be downloaded and started before it can even
// say whether a session exists.
const SDK_TYPES = new Set(["walletConnect", "baseAccount", "coinbaseWallet"]);

/** Whether asking this connector for a session on page load is worth what it costs. */
function worthAsking(connector: Connector, recent: string | null | undefined): boolean {
  // Whatever was used last is always asked: that is how a WalletConnect or Base session comes back.
  if (connector.id === recent) return true;
  if (SDK_TYPES.has(connector.type)) return false;
  // RainbowKit reaches MetaMask through MetaMask's SDK. With MetaMask in the page — the extension,
  // or its in-app browser — that is the wallet itself and it is asked like any other; without it,
  // the SDK would only be loaded to find that nothing is there.
  if (connector.type === "metaMask") return Boolean((window as { ethereum?: { isMetaMask?: boolean } }).ethereum?.isMetaMask);
  // Wallets already in the page (extensions, a wallet's own browser, Safe): asking costs nothing.
  return true;
}

/**
 * Brings the wallet session back on page load.
 *
 * wagmi's own reconnect asks every configured connector for its provider, and for the SDK-backed
 * ones that means downloading the SDK: on every page load, connected or not, the browser fetched
 * and ran WalletConnect/AppKit, the MetaMask SDK and the Base Account SDK — 1.7 MB of script and
 * two calls to WalletConnect's servers before the visitor had touched anything.
 *
 * This asks the same question of every wallet that is actually present in the page, exactly as
 * wagmi would, and of the connector used last — and leaves the SDKs nobody used alone. A wallet in
 * the page therefore reconnects as it always did; only the downloads are gone.
 */
function RestoreWallet() {
  const config = useConfig();

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let stopWatching = () => {};

    const restore = async () => {
      const recent = await config.storage?.getItem("recentConnectorId");
      if (cancelled) return;
      const present = getConnectors(config).filter((connector) => worthAsking(connector, recent));
      if (present.length) await reconnect(config, { connectors: present });
      if (cancelled || !recent || getConnectors(config).some((connector) => connector.id === recent)) return;

      // The wallet used last is a browser extension that hasn't announced itself yet (EIP-6963):
      // it gets its turn when it does.
      stopWatching = watchConnectors(config, {
        onChange: (connectors) => {
          const late = connectors.find((connector) => connector.id === recent);
          if (!late || cancelled) return;
          stopWatching();
          void reconnect(config, { connectors: [late] });
        },
      });
    };

    // WagmiProvider's own mount work comes first: it rehydrates its store, adds the announced
    // extensions and — with reconnectOnMount off — clears the stored connections. A session
    // restored before that would be wiped by it, so this waits for the store to be hydrated and
    // then one more turn of the event loop.
    const begin = () => {
      if (cancelled) return;
      // wagmi types this store loosely; all that is read is zustand's own "has it loaded" flag.
      const store = config._internal.store as unknown as { persist?: { hasHydrated?: () => boolean } };
      const hydrated = store.persist?.hasHydrated?.() ?? true;
      timer = window.setTimeout(hydrated ? () => void restore() : begin, hydrated ? 0 : 20);
    };
    begin();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stopWatching();
    };
  }, [config]);

  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session, created lazily so it is never shared
  // across requests during SSR.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Kept for half an hour after a page is left, so coming back to it shows what was
          // there at once and refreshes underneath instead of starting from a skeleton.
          queries: { staleTime: 30_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <RestoreWallet />
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={meridianTheme} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
