#!/usr/bin/env node
// RPC health check — `npm run rpc:health` (add `-- --verbose` for raw error text).
//
// Probes every endpoint the quote engine can use — SEPOLIA_RPC_URLS (and the NEXT_PUBLIC_ ones,
// when those still hold real URLs) from .env.local (or .env) plus the app's public fallbacks — the
// same way the engine uses them: chain id, head freshness, eth_call, JSON-RPC batching, and
// eth_getLogs at the ranges pool discovery needs. Keys are never printed, only the provider host
// and the last 4 characters of the URL.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PUBLIC_FALLBACKS } from '../src/swap/rpcEndpoints.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
const TIMEOUT_MS = 10_000
const SEPOLIA_CHAIN_ID = '0xaa36a7'
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'
const V4_INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'
const SYMBOL_SELECTOR = '0x95d89b41'

function readEnv() {
  const env = {}
  for (const file of ['.env', '.env.local']) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].trim()
    }
  }
  return env
}

const env = readEnv()
const configured = [
  ...(env.SEPOLIA_RPC_URLS ?? '').split(','),
  ...(env.NEXT_PUBLIC_SEPOLIA_RPC_URLS ?? '').split(','),
  env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? '',
]
  .map(s => s.trim())
  // Proxy paths (/api/rpc/N) point back at the app, not at a provider.
  .filter(url => url.startsWith('http'))
const configuredSet = new Set(configured)
const duplicates = configured.length - configuredSet.size
const urls = [...new Set([...configured, ...PUBLIC_FALLBACKS])]

const provider = url => {
  const host = new URL(url).host
  for (const name of ['alchemy', 'infura', 'drpc', 'tenderly', 'publicnode', 'nodies', 'getblock', 'w3node', 'etherspot', '1rpc', 'ankr', 'blast', 'quicknode', 'chainstack']) {
    if (host.includes(name)) return name
  }
  return host
}
const mask = url => {
  const tail = url.replace(/\/+$/, '').slice(-4)
  return `${provider(url)} …${tail}`
}

// One retry on timeout: a public endpoint that's merely slow for a moment shouldn't read as dead.
async function rpc(url, body) {
  const first = await rpcOnce(url, body)
  return first.text === 'timeout' ? rpcOnce(url, body) : first
}

async function rpcOnce(url, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON error page */ }
    return { status: res.status, ok: res.ok, json, text, ms: Date.now() - t0 }
  } catch (error) {
    return { status: 0, ok: false, json: null, text: error.name === 'AbortError' ? 'timeout' : String(error.message), ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

const call = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params })

function errorText(r) {
  if (!r) return ''
  if (r.json?.error) return `${r.json.error.message ?? ''} (${r.json.error.code ?? ''})`
  if (Array.isArray(r.json)) {
    const e = r.json.find(x => x?.error)?.error
    if (e) return `${e.message ?? ''} (${e.code ?? ''})`
  }
  return r.ok ? '' : `HTTP ${r.status} ${r.text.slice(0, 160)}`
}

// Plain-language reason for a dead endpoint.
function reasonOf(text) {
  if (/capacity|monthly|quota|exceeded your/i.test(text)) return 'monthly quota spent'
  if (/inactive|disabled|suspended/i.test(text)) return 'app/key disabled'
  if (/authenticated|unauthorized|invalid api key|api key|401/i.test(text)) return 'invalid key / auth required'
  if (/whitelist|not allowed|forbidden|403/i.test(text)) return 'IP/origin not whitelisted'
  if (/rate|too many|429/i.test(text)) return 'rate limit'
  if (/timeout/i.test(text)) return 'timeout'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(text)) return 'unreachable'
  if (/^HTTP 404/.test(text)) return 'no such endpoint (404)'
  const http = text.match(/^HTTP (\d{3})/)
  if (http) return `HTTP ${http[1]}`
  return text.slice(0, 60) || 'failed'
}

async function probe(url) {
  const out = { url, label: mask(url), configured: configuredSet.has(url) }

  const chain = await rpc(url, call('eth_chainId'))
  if (chain.json?.result !== SEPOLIA_CHAIN_ID) {
    const text = errorText(chain) || `chainId ${chain.json?.result}`
    return { ...out, alive: false, reason: chain.json?.result ? `not Sepolia (${chain.json.result})` : reasonOf(text), raw: text }
  }

  const head = await rpc(url, call('eth_blockNumber'))
  if (!head.json?.result) return { ...out, alive: false, reason: reasonOf(errorText(head)), raw: errorText(head) }
  out.head = Number(BigInt(head.json.result))
  out.latencyMs = head.ms

  const ethCall = await rpc(url, call('eth_call', [{ to: WETH, data: SYMBOL_SELECTOR }, 'latest']))
  out.ethCall = Boolean(ethCall.json?.result && ethCall.json.result !== '0x')
  if (!out.ethCall) out.ethCallErr = errorText(ethCall)

  const batch = await rpc(url, [call('eth_blockNumber', [], 1), call('eth_chainId', [], 2)])
  out.batch = Array.isArray(batch.json) && batch.json.length === 2 && batch.json.every(r => r.result)
  if (!out.batch) out.batchErr = errorText(batch)

  // getLogs capability, narrow → wide. Pool discovery wants wide ranges; 10 blocks is the floor
  // several free tiers allow.
  const logsAt = async span => {
    const from = Math.max(0, out.head - span + 1)
    const r = await rpc(url, call('eth_getLogs', [{ address: POOL_MANAGER, topics: [V4_INITIALIZE_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${out.head.toString(16)}` }]))
    return { ok: Array.isArray(r.json?.result), status: r.status, err: errorText(r) }
  }
  out.logs = 'none'
  for (const [span, label] of [[10, '≤10 blocks'], [5_000, '≤5k blocks'], [50_000, '≤50k blocks'], [200_000, '≥200k blocks']]) {
    const r = await logsAt(span)
    if (!r.ok) {
      out.logsErr = `${label}: HTTP ${r.status} ${r.err.slice(0, 120)}`
      break
    }
    out.logs = label
  }
  return { ...out, alive: true }
}

async function pool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

const results = await pool(urls, 8, probe)
const bestHead = Math.max(0, ...results.filter(r => r.alive).map(r => r.head))
for (const r of results) {
  if (r.alive) r.lag = bestHead - r.head
}

const full = results.filter(r => r.alive && r.ethCall && r.batch && r.lag <= 5)
const limited = results.filter(r => r.alive && !full.includes(r))
const dead = results.filter(r => !r.alive)

const pad = (s, n) => String(s).padEnd(n)
const line = r => {
  if (!r.alive) return `  ✗ ${pad(r.label, 22)} ${pad(r.configured ? 'env' : 'fallback', 9)} ${r.reason}${VERBOSE ? `  [${r.raw.replace(/\s+/g, ' ').slice(0, 140)}]` : ''}`
  const notes = [
    r.ethCall ? null : 'eth_call failed',
    r.batch ? null : 'batch refused',
    r.lag > 5 ? `${r.lag} blocks behind` : null,
  ].filter(Boolean)
  return `  ${full.includes(r) ? '✓' : '~'} ${pad(r.label, 22)} ${pad(r.configured ? 'env' : 'fallback', 9)} ${pad(`${r.latencyMs}ms`, 7)} getLogs ${pad(r.logs, 11)}${notes.length ? ' · ' + notes.join(', ') : ''}${VERBOSE && r.logsErr ? `  [${r.logsErr}]` : ''}`
}

console.log(`\nRPC health — ${urls.length} unique endpoints (${configuredSet.size} from env` +
  `${duplicates ? `, ${duplicates} duplicates ignored` : ''}, ${urls.length - configuredSet.size} public fallbacks), Sepolia head #${bestHead}\n`)
console.log(`FULLY WORKING (${full.length})`)
full.sort((a, b) => a.latencyMs - b.latencyMs).forEach(r => console.log(line(r)))
if (limited.length) {
  console.log(`\nLIMITED (${limited.length})`)
  limited.forEach(r => console.log(line(r)))
}
console.log(`\nDEAD (${dead.length})`)
dead.forEach(r => console.log(line(r)))

const reasons = dead.reduce((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }), {})
const wideLogs = results.filter(r => r.alive && r.logs === '≥200k blocks').length
console.log(`\nSummary: ${full.length + limited.length} working / ${dead.length} dead` +
  (dead.length ? ` — ${Object.entries(reasons).map(([k, v]) => `${v}× ${k}`).join(', ')}` : ''))
console.log(`Wide getLogs range (≥200k blocks, what pool discovery needs): ${wideLogs} endpoints`)
