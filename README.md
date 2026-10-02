# Aether

DEX aggregator on Sepolia.

## Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Environment

| Variable | Side | Purpose |
|---|---|---|
| `SEPOLIA_RPC_URLS` | server | RPC endpoints as full URLs, comma-separated. |
| `SEPOLIA_RPC_KEYS`, `SEPOLIA_RPC_KEY_URL` | server | Optional shorthand: the keys alone, and the URL each one completes. |
| `NEXT_PUBLIC_SEPOLIA_RPC_URLS` | browser | Proxy paths, one per endpoint: `/api/rpc/0,/api/rpc/1,…` |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` | browser | Proxy path for the wallet transport: `/api/rpc/0` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | browser | WalletConnect and mobile wallets. |
| `NEXT_PUBLIC_AETHER_AGGREGATOR_ADDRESS` | browser | Router address. Defaults to the deployed one. |
| `LIFI_API_KEY`, `LIFI_INTEGRATOR` | server | Optional. |
| `UNISWAP_API_KEY` | server | Optional. |

Only an RPC endpoint is required. Keys stay on the server: the browser talks to the
routes under `/api`, which accept same-site, read-only requests.

`NEXT_PUBLIC_*` values are fixed at build time, so changing one needs a rebuild.

## Scripts

```bash
npm run build && npm start        # production
npm run lint
npm run rpc:health                # check every configured endpoint
```

## Layout

```
src/app          pages and API routes
src/components   interface
src/swap         routing, quoting, liquidity
contracts        router contract (EIP-2535 diamond, Foundry)
scripts          deploy and health check
```

## Contract

Sepolia: [`0xD21D6bCF47e8b7a0611C0d1d2f718c94B0aC3334`](https://eth-sepolia.blockscout.com/address/0xD21D6bCF47e8b7a0611C0d1d2f718c94B0aC3334).
Facet addresses are in `contracts/deployments/sepolia.json`.

```bash
npm run deploy:aggregator -- --dry-run               # plan only, no key needed
npm run deploy:aggregator                            # deploy and verify
npm run deploy:aggregator -- --upgrade <Facet>       # replace one facet
npm run deploy:aggregator -- --configure <address>   # apply missing configuration
```

The deployer key goes in `.env.deploy` (see `.env.deploy.example`). An upgrade keeps the
address, so the app needs no redeploy.

## Notes

- `package.json` pins `qr` to 0.5.5: the wallet dialog's QR code fails on 0.6.
- `eslint.config.mjs` relaxes two React hook rules for the routing modules.
- Testnet only. Not audited.
