// Public fallback RPCs, kept in a module with no imports so tooling (scripts/rpc-health.mjs) can
// read the exact list the app fails over to without bundling the quote engine.
//
// Only endpoints that need no key belong here. Check them with `npm run rpc:health` now and then:
// public endpoints do disappear.
export const PUBLIC_FALLBACKS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
]
