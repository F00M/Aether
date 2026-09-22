import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { sepolia } from "wagmi/chains";

/**
 * Sepolia only — the Aether aggregator and every pool the quote engine scans
 * are deployed there.
 *
 * Injected wallets work out of the box. WalletConnect / mobile deep-linking
 * needs a project id from https://cloud.reown.com (see .env.example).
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "aether-dex-demo";

const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
// A public deployment points this at the server proxy (/api/rpc/0) so the RPC key never reaches the
// browser. wagmi is also built during SSR, where a relative path has no origin to resolve against,
// so the public endpoint stands in there.
const configuredRpc = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? PUBLIC_RPC;
const rpcUrl = /^https?:\/\//.test(configuredRpc)
  ? configuredRpc
  : typeof globalThis.location?.origin === "string"
    ? `${globalThis.location.origin}${configuredRpc}`
    : PUBLIC_RPC;

export const config = getDefaultConfig({
  appName: "Aether",
  appDescription: "Aggregating Uniswap V2 · V3 · V4 on Sepolia.",
  projectId,
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
