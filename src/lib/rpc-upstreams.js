// The Sepolia upstreams behind /api/rpc/<shard>, also probed by `npm run rpc:health`.
//
// SEPOLIA_RPC_URLS lists them as full URLs. When many of them differ only by a key, the keys can
// be listed alone in SEPOLIA_RPC_KEYS, with SEPOLIA_RPC_KEY_URL as the address each one completes
// (the key replaces `{key}`, or is appended when there is no placeholder). Keyed endpoints come
// first, in the order given, then the URLs — shard N is entry N of that combined list.
//
// Server-only: these values are secrets and must never be imported from client code.
const entries = value =>
  String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)

const isUrl = value => /^https?:\/\//.test(value)

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function rpcUpstreams(env) {
  const template = String(env.SEPOLIA_RPC_KEY_URL ?? '').trim()
  const keyed = entries(env.SEPOLIA_RPC_KEYS)
    // A full URL pasted among the keys still works; a bare key with nothing to complete is skipped.
    .filter(key => isUrl(key) || isUrl(template))
    .map(key => (isUrl(key) ? key : template.includes('{key}') ? template.replace('{key}', key) : template + key))
  return [...keyed, ...entries(env.SEPOLIA_RPC_URLS)]
}

/** Keys that cannot be used because SEPOLIA_RPC_KEY_URL is missing: worth a warning, not a crash. */
export function unusedRpcKeys(env) {
  if (isUrl(String(env.SEPOLIA_RPC_KEY_URL ?? '').trim())) return 0
  return entries(env.SEPOLIA_RPC_KEYS).filter(key => !isUrl(key)).length
}
