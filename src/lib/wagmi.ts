import { connectorsForWallets, type Wallet } from "@rainbow-me/rainbowkit";
import {
  baseAccount,
  binanceWallet,
  bitgetWallet,
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  rabbyWallet,
  rainbowWallet,
  safeWallet,
  safepalWallet,
  tokenPocketWallet,
  trustWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { sepolia } from "wagmi/chains";

/**
 * Sepolia only — the Aether aggregator and every pool the quote engine scans
 * are deployed there.
 *
 * Injected wallets work out of the box. WalletConnect / mobile deep-linking
 * needs a project id from https://cloud.reown.com (see .env.example).
 */
// `||`, not `??`: a dashboard that copies .env.example sets these to "", which must count as unset.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "aether-dex-demo";

const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
// A public deployment points this at the server proxy (/api/rpc/0) so the RPC key never reaches the
// browser. wagmi is also built during SSR, where a relative path has no origin to resolve against,
// so the public endpoint stands in there.
const configuredRpc = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || PUBLIC_RPC;
const rpcUrl = /^https?:\/\//.test(configuredRpc)
  ? configuredRpc
  : typeof globalThis.location?.origin === "string"
    ? `${globalThis.location.origin}${configuredRpc}`
    : PUBLIC_RPC;

// A wallet's in-app browser injects its provider, but RainbowKit's mobile sheet only lists wallets
// named here (EIP-6963 "Installed" ones are desktop-only). This catches wallets not in the list,
// and stays hidden in a plain mobile browser, where there is nothing to connect to.
const browserWallet = (): Wallet => ({
  ...injectedWallet(),
  hidden: () => typeof window === "undefined" || !(window as { ethereum?: unknown }).ethereum,
});

const APP_NAME = "Aether";
const APP_DESCRIPTION = "DEX aggregator on Sepolia.";

/**
 * wagmi runs every connector's `setup()` the moment the config is created, and WalletConnect's
 * setup downloads and starts its SDK: about 1 MB of script, a relay connection and two calls to
 * WalletConnect's servers on every page load, for visitors who never open the wallet dialog.
 * Here the setup waits until the connector is actually used — a WalletConnect wallet is picked, or
 * a previous WalletConnect session is being restored — and then runs first, as it always did.
 */
const deferSetup =
  (create: CreateConnectorFn): CreateConnectorFn =>
  (parameters) => {
    const connector = create(parameters);
    if (connector.type !== "walletConnect" || !connector.setup) return connector;

    const setup = connector.setup.bind(connector);
    let started: Promise<void> | undefined;
    const start = () => (started ??= setup());

    return {
      ...connector,
      setup: async () => {},
      connect: (async (options) => {
        await start();
        return connector.connect(options);
      }) as typeof connector.connect,
      isAuthorized: async () => {
        await start();
        return connector.isAuthorized();
      },
    };
  };

// The default list is only Safe, Rainbow, Base, MetaMask and WalletConnect; every other wallet sat
// behind the WalletConnect button. Each entry connects in its own in-app browser and deep-links
// through WalletConnect elsewhere.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [metaMaskWallet, trustWallet, okxWallet, bitgetWallet, binanceWallet, rabbyWallet],
    },
    {
      groupName: "More",
      wallets: [safepalWallet, tokenPocketWallet, rainbowWallet, baseAccount, safeWallet, browserWallet, walletConnectWallet],
    },
  ],
  {
    projectId,
    appName: APP_NAME,
    appDescription: APP_DESCRIPTION,
    walletConnectParameters: {
      // What a wallet shows when it is asked to connect.
      metadata: {
        name: APP_NAME,
        description: APP_DESCRIPTION,
        url: typeof window !== "undefined" ? window.location.origin : "",
        icons: [],
      },
    },
  },
).map(deferSetup);

// Built with wagmi's own `createConfig` rather than RainbowKit's `getDefaultConfig`, which is the
// same call with no way to reach the connectors in between.
export const config = createConfig({
  connectors,
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(rpcUrl),
  },
  ssr: true,
});

export const SEPOLIA_CHAIN_ID = sepolia.id;

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
