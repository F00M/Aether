// Public fallback RPCs, kept in a module with no imports so tooling (scripts/rpc-health.mjs) can
// read the exact list the app fails over to without bundling the quote engine.
//
// Removed 2026-09-22 after `npm run rpc:health`: rpc.sepolia.org (HTTP 404 — the endpoint is gone)
// and a hardcoded Alchemy key ("App is inactive"). Neither recovers with a monthly quota reset.
export const PUBLIC_FALLBACKS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
]
