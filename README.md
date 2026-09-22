# Aether — a Uniswap aggregator for Sepolia

One router over Uniswap V2, V3 and V4. Aether indexes every pool on all three
protocols, splits an order across whichever ones pay best, compares the result
against LI.FI and the Uniswap Trading API, and executes the exact set of legs it
quoted — in a single transaction, through an EIP-2535 diamond.

Sepolia only: that is where the diamond and the pools it scans live.

- Routing engine: pool indexing, corridor screening, split optimisation
- Execution: one `execute(SwapParams)` call, V2/V3/V4 legs in any mix
- Direct-pool legs that swap against the pool itself, no router, no approval
- Every API key server-side — nothing in the browser bundle

```bash
npm install
cp .env.example .env.local     # fill in at least one RPC endpoint
npm run dev
```

## Environment

Only the RPC line is required; everything else degrades gracefully.

| Variable | Side | What it does |
|---|---|---|
| `SEPOLIA_RPC_URLS` | server | Comma-separated Sepolia endpoints, keys included. Read only by `/api/rpc/<shard>`. |
| `NEXT_PUBLIC_SEPOLIA_RPC_URLS` | browser | What the browser calls — proxy paths (`/api/rpc/0,/api/rpc/1,…`), one per upstream. |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` | browser | Single endpoint for the wallet transport; `/api/rpc/0` in a proxied setup. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | browser | Needed for WalletConnect and mobile wallets. Injected wallets work without it. |
| `NEXT_PUBLIC_AETHER_AGGREGATOR_ADDRESS` | browser | Diamond address. Defaults to the deployed one in `src/swap/quoteConfig.js`. |
| `NEXT_PUBLIC_AETHER_DIRECT_POOL_LEGS` | browser | `0` forces every leg through the Universal Router. On by default. |
| `LIFI_API_KEY`, `LIFI_INTEGRATOR` | server | Raises LI.FI's rate limit (75 → 12,000 per 2h). Optional. |
| `UNISWAP_API_KEY` | server | Enables the "Uniswap API" reference route. Optional. |

A single quote fires hundreds of `eth_call`s, so one public endpoint will
throttle and quietly degrade the routes that get found. Give it several.

```bash
npm run rpc:health              # probe every configured endpoint: working / limited / dead + why
npm run rpc:health -- --verbose
```

In the browser console, `aetherRpcHealth()` shows what live traffic has seen and
`aetherHubs()` the bridge tokens currently detected.

## Server-side proxies

Keys never reach the browser: `NEXT_PUBLIC_*` values are inlined into the client
bundle at build time, so anything secret is read by a route handler instead.

| Route | Upstream | Guard |
|---|---|---|
| `POST /api/rpc/<shard>` | `SEPOLIA_RPC_URLS[shard]` | read-only JSON-RPC methods, 1 MB bodies, 1200 req/min per IP |
| `GET /api/lifi/quote` | `li.quest/v1/quote` | Sepolia only, known parameters, 60 req/min per IP |
| `POST /api/uniswap/quote`, `/api/uniswap/swap` | `trade-api.gateway.uniswap.org/v1/…` | known endpoints, 256 KB bodies, 60 req/min per IP |

Each shard maps to its own upstream, so the engine keeps spreading a burst of
calls across every provider without being told which ones they are. A failing
upstream fails over to the next and is skipped for a minute. Every proxy refuses
cross-site callers (`Sec-Fetch-Site` / `Origin`) and relays the upstream body
and status with none of its headers. The RPC proxy accepts reads only — the
wallet broadcasts its own transactions through its own provider.

This is not authentication. A public deployment should add the host's rate
limiting on top.

## How routing works

```
src/swap/poolFeed.js          global index of every V2/V3/V4 pool ever created
src/swap/poolIndex.js         V4 pool discovery
src/swap/corridorScreen.js    prices A→X→B corridors from pool state
src/swap/autoHubs.js          detects the bridge tokens, ranked by what they pay
src/swap/quoteEngine.js       split optimisation, Uniswap API reference
src/swap/quoteProviders.js    RPC sharding, endpoint benching
src/swap/aetherBuilder.js     diamond + Universal Router calldata
src/swap/lifi.js              LI.FI quote for the same trade
src/hooks/useQuote.js         quote orchestration
```

Routing is only as good as the pools it can see:

- **Pool feed** — one index of every pool *created* on V2, V3 and V4 (V4 from
  the PoolManager's deployment, V2/V3 over the last 1.2M blocks). ~17k pools,
  built once in a few seconds, persisted to `localStorage`, then kept current
  with one `getLogs` per protocol. It covers what per-token scans can't: the
  ETH/WETH side of a corridor, and V4 pools with fee tiers no guess list
  contains — Sepolia's ETH/USDC alone has 35 no-hook pools across 32 tiers. Of
  375 static poolKey guesses only 63 exist, and the feed has all 63.
- **Corridor screening** — every candidate A→X→B is priced from pool state (one
  Multicall round for addresses, one for state), then the leaders are re-priced
  with the real quoters. Transit tokens are ranked by what they pay, not by how
  many pools they have.
- **Auto hubs** — the bridge tokens are detected, not listed. Every token paired
  with both WETH and USDC is scored by routing through it in *both* directions
  (`min` of the two ratios to the direct rate); the best five that keep ≥50%
  both ways become the hubs, re-detected every 10 minutes.
- **Shared-pool accounting** — two routes that touch the same pool can't both be
  counted at a fresh quote. The optimiser treats them as mutually exclusive, and
  any split that still shares a pool is collapsed before it is compared or shown.
- **Endpoint benching** — an endpoint that keeps failing (dead key, 429, CORS)
  is benched with backoff (1 → 2 → 4 … minutes, 30 max) and cleared on the first
  success, so a quota that resets is picked up without editing anything. A 400
  never benches: some free tiers answer wide `eth_getLogs` with 400 while
  serving `eth_call` perfectly.

LI.FI is quoted alongside and shown in the routes panel, best return first; the
best executes unless another is picked. On Sepolia LI.FI routes through Fly,
whose router only accepts calldata signed by Fly's backend, so LI.FI routes are
always executed from `li.quest` calldata re-fetched for the connected wallet at
click time, never built locally. LI.FI's price filter refuses native ETH ↔ USDC,
so native legs are quoted as WETH and executed as explicit steps — wrap →
approve → swap → unwrap — each shown in the execution tracker.

## The Aether diamond

An EIP-2535 diamond (`contracts/src/diamond/Aether.sol`, Foundry project in
`contracts/`, solc 0.8.26 / 200 runs): one permanent address, logic in facets
that `diamondCut` adds, replaces or removes. Users approve the diamond once;
upgrades never change the address.

Live on Sepolia at
[`0xD21D6bCF47e8b7a0611C0d1d2f718c94B0aC3334`](https://eth-sepolia.blockscout.com/address/0xD21D6bCF47e8b7a0611C0d1d2f718c94B0aC3334)
(facet addresses in `contracts/deployments/sepolia.json`).

| Facet | Functions |
|---|---|
| `DiamondCutFacet` | `diamondCut` (owner) |
| `DiamondLoupeFacet` | `facets`, `facetAddress`, `facetAddresses`, `facetFunctionSelectors`, `supportsInterface` |
| `OwnershipFacet` | two-step `transferOwnership` / `acceptOwnership`, `cancelOwnershipTransfer`, `owner`, `pendingOwner` |
| `DexManagerFacet` | router whitelist (`setExternalTarget`), `setRouter`, router getters |
| `EmergencyPauseFacet` | `setPaused`, `paused` |
| `ConfigFacet` | fee, strict token list, allowed tokens |
| `WithdrawFacet` | `rescueToken` |
| `AetherSwapFacet` | `execute(SwapParams)`, `VERSION` |
| `PoolCallbackFacet` | `uniswapV3SwapCallback` (pays a direct pool swap) |

Config lives in diamond storage (`LibAether`, append-only) and `AetherInit` sets
it in the first `diamondCut`. Swap legs may only call whitelisted routers, which
is what keeps approvals to the diamond safe. `AetherSwapFacet` approves Permit2
only when the allowance is short, so tokens that pin Permit2 at max — such as
"Sepolia" `0x95c8…`, which reverts any lower approve — route like any other.

Leg types 6 (`V3_POOL`) and 7 (`V2_PAIR`) swap against the pool itself instead
of a router: `LibPoolSwap` derives the pool address with CREATE2 and pays inside
the callback, so no approval is needed and the caller check costs nothing — a
caller that isn't the derived pool reverts `PoolSwapUnauthorized`. Measured on a
fork of the current chain: identical output, 4–11.5% less gas than the router
path.

The Solidity sources carry no comments at all, SPDX line included (the owner's
choice); the MIT license is declared when the deploy script verifies them, and
the flattened source it publishes is stripped the same way
(`scripts/lib/strip-solidity-comments.mjs`).

```bash
npm run deploy:aggregator -- --dry-run                   # plan + simulated deploys, no key needed
npm run deploy:aggregator                                # deploy diamond + facets, verify on Blockscout
npm run deploy:aggregator -- --upgrade AetherSwapFacet   # new facet version, same address
npm run deploy:aggregator -- --configure <address>       # apply any missing configuration
npm run deploy:aggregator -- --verify-etherscan          # verify on Etherscan
```

The owner key goes in `.env.deploy` (copy `.env.deploy.example`; Next.js never
loads that file) or `DEPLOYER_PRIVATE_KEY` in the environment; without either
the script asks at a hidden prompt. It is never printed or stored elsewhere.
Addresses are written to `contracts/deployments/sepolia.json`.

## Deploying the app

Any Node host works; on Vercel, import the repository and set the environment
variables above — `SEPOLIA_RPC_URLS` without the `NEXT_PUBLIC_` prefix, so the
keys stay on the server, and the `NEXT_PUBLIC_SEPOLIA_RPC_URL(S)` pointing at
`/api/rpc/<n>`. `NEXT_PUBLIC_*` values are baked in at build time, so changing
one takes effect on the next build, not on the next request.

Fixing something after it is live is the ordinary loop: push to the default
branch and the host rebuilds; push to any other branch first for a preview URL
that runs the same code against the same variables. A bad deploy rolls back to
the previous build without touching the contract — and a contract fix is a
`--upgrade` cut, which the running app picks up without a redeploy, because the
diamond address never changes.

## Notes

- Pools and Activity in the nav are placeholders.
- `eslint.config.mjs` scopes off React's newer `set-state-in-effect` / `purity`
  rules for the routing modules. Restructuring those effects to satisfy a lint
  rule is how the bugs they already fix come back.
- Testnet only. Nothing here has been audited.
