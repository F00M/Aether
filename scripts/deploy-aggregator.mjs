#!/usr/bin/env node
// Deploys the Aether aggregator to Sepolia as an EIP-2535 diamond (contracts/src/diamond), the
// same pattern as the LI.FI Diamond: one permanent address, logic in facets that are replaced
// with diamondCut. CONFIG below (routers, router whitelist, fee, token list) is applied in the same
// transaction that wires the facets.
//
//   npm run deploy:aggregator                                  deploy the diamond (all facets)
//   npm run deploy:aggregator -- --dry-run                     plan + simulated deploys, no key
//   npm run deploy:aggregator -- --upgrade <Facet>             deploy a new version of one facet and
//                                [--diamond <address>]         cut it in (same address, no re-approvals)
//                                [--facet-address <address>]    reuse a facet already deployed
//   npm run deploy:aggregator -- --configure <address>         apply any missing configuration
//   npm run deploy:aggregator -- --verify-etherscan            verify the recorded deployment on Etherscan
//   ... --rpc <url> --no-verify                                e.g. against a local anvil fork
//
// The owner key is read from DEPLOYER_PRIVATE_KEY — set in the environment or in .env.deploy (see
// .env.deploy.example; Next.js never loads that file, so the key can't reach the app) — otherwise
// from a hidden terminal prompt. It is never printed or written anywhere.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { stripSolidityComments } from './lib/strip-solidity-comments.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY_ENV = resolve(ROOT, '.env.deploy')
const CONTRACTS_DIR = resolve(ROOT, 'contracts')
const RECORD = resolve(CONTRACTS_DIR, 'deployments/sepolia.json')
const PUBLIC_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const BLOCKSCOUT = 'https://eth-sepolia.blockscout.com'
const SOLC = 'v0.8.26+commit.8a97fa7a'

// Facets cut into the diamond, in order. DiamondCutFacet goes in through the diamond's constructor.
const FACETS = [
  'DiamondLoupeFacet',
  'OwnershipFacet',
  'DexManagerFacet',
  'EmergencyPauseFacet',
  'ConfigFacet',
  'WithdrawFacet',
  'AetherSwapFacet',
  'PoolCallbackFacet',
]
const SOURCES = {
  Aether: 'src/diamond/Aether.sol',
  AetherInit: 'src/diamond/init/AetherInit.sol',
  DiamondCutFacet: 'src/diamond/facets/DiamondCutFacet.sol',
  ...Object.fromEntries(FACETS.map(name => [name, `src/diamond/facets/${name}.sol`])),
}

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const option = name => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const dryRun = flag('--dry-run')
const verify = !flag('--no-verify')

// foundryup installs forge in ~/.foundry/bin and only adds it to the shell profile it knows
// (e.g. Git Bash), so PowerShell/cmd — where npm scripts run on Windows — often can't find it.
function findForge() {
  const candidates = [
    process.env.FORGE_BIN,
    'forge',
    resolve(homedir(), '.foundry/bin/forge.exe'),
    resolve(homedir(), '.foundry/bin/forge'),
  ].filter(Boolean)
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' })
      return bin
    } catch {
      // try the next location
    }
  }
  return null
}

const FORGE = findForge()
if (FORGE) {
  try {
    execFileSync(FORGE, ['build'], { cwd: CONTRACTS_DIR, stdio: 'pipe' })
  } catch (error) {
    console.error(String(error.stdout ?? ''), String(error.stderr ?? ''))
    throw new Error('Compile kontrak gagal (forge build).')
  }
} else if (!existsSync(resolve(CONTRACTS_DIR, 'out/Aether.sol/Aether.json'))) {
  throw new Error('forge (Foundry) tidak ditemukan dan kontrak belum pernah di-compile. Install Foundry atau set FORGE_BIN.')
} else {
  console.log('  (forge tidak ditemukan — memakai hasil compile yang ada; verifikasi Blockscout dilewati.)')
}

const artifactOf = name => JSON.parse(readFileSync(resolve(CONTRACTS_DIR, `out/${name}.sol/${name}.json`), 'utf8'))
const selectorsOf = name => Object.values(artifactOf(name).methodIdentifiers).map(selector => `0x${selector}`)

// Every facet's ABI behind the one diamond address (functions, events and errors, deduplicated).
const DIAMOND_ABI = [...new Map(['DiamondCutFacet', ...FACETS]
  .flatMap(name => artifactOf(name).abi)
  .map(item => [JSON.stringify(item), item])).values()]

const rpcUrl = option('--rpc') ?? PUBLIC_RPC
const rpcNote = rpcUrl === PUBLIC_RPC ? '' : ` (RPC: ${new URL(rpcUrl).host})`
// Reads go out as one multicall: sequential calls to the public RPC stalled tens of seconds behind
// its throttling.
const client = createPublicClient({
  chain: sepolia,
  batch: { multicall: true },
  transport: http(rpcUrl, { timeout: 60_000 }),
})

// What the diamond is configured with. The routers are Sepolia's; `externalTargets` are the
// contracts a swap leg may call or receive native ETH from (the Universal Router is allowed by
// AetherInit itself). Fee off, no token allowlist: every pool the engine finds stays routable.
const CONFIG = {
  weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  v3Router: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b',
  externalTargets: [
    '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3', // Uniswap V2 router
    '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543', // Uniswap V4 PoolManager
  ],
  feeBps: 0,
  feeRecipient: zeroAddress, // only used when feeBps > 0; the deployer is set as recipient at init
  strictTokenList: false,
  allowedTokens: [],
  paused: false,
}

// Control characters for the raw-mode prompt.
const CTRL_C = String.fromCharCode(3)
const BACKSPACE = String.fromCharCode(8)
const DELETE = String.fromCharCode(127)
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)

async function readHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error('Tidak ada terminal interaktif: set DEPLOYER_PRIVATE_KEY di environment.')
  process.stdout.write(prompt)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise(done => {
    let value = ''
    const onData = chunk => {
      for (const char of chunk) {
        if (char === CTRL_C) {
          stdin.setRawMode(false)
          process.stdout.write(LF)
          process.exit(130)
        }
        if (char === CR || char === LF) {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write(LF)
          done(value.trim())
          return
        }
        if (char === DELETE || char === BACKSPACE) value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer.trim().toLowerCase()
}

// A secret from the environment, else from .env.deploy.
function deployEnv(name) {
  if (process.env[name]?.trim()) return process.env[name].trim()
  if (!existsSync(DEPLOY_ENV)) return ''
  for (const line of readFileSync(DEPLOY_ENV, 'utf8').split(LF)) {
    const [key, ...rest] = line.split('=')
    if (key.trim() !== name) continue
    const value = rest.join('=').trim().replace(/^['"]|['"]$/g, '').split('#')[0].trim()
    if (value) return value
  }
  return ''
}

async function signer(prompt) {
  const fromFile = deployEnv('DEPLOYER_PRIVATE_KEY')
  if (fromFile) console.log(`${LF}  Key owner dibaca dari ${process.env.DEPLOYER_PRIVATE_KEY ? 'environment' : '.env.deploy'}.`)
  const key = fromFile || (await readHidden(prompt))
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  return { account, wallet: createWalletClient({ account, chain: sepolia, transport: http(rpcUrl, { timeout: 60_000 }) }) }
}

// Nonces are counted here, not asked for per transaction: the public RPC is load balanced, and a
// node that hadn't seen the previous transaction yet handed out its nonce again — the next send
// came back "replacement transaction underpriced" (the PoolCallbackFacet cut, 2026-09-23).
let nextNonce = null
async function takeNonce(account) {
  if (nextNonce === null) {
    nextNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  }
  return nextNonce++
}

async function sendTracked(account, send) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(await takeNonce(account))
    } catch (error) {
      const text = String(error?.details ?? error?.shortMessage ?? error?.message ?? '')
      if (attempt >= 2 || !/nonce|underpriced|already known/i.test(text)) throw error
      console.log(`  (nonce bentrok di RPC — mengambil ulang nonce dan mencoba lagi)`)
      nextNonce = null
      await new Promise(done => setTimeout(done, 4_000))
    }
  }
}

async function deployContract(wallet, name, args = []) {
  const artifact = artifactOf(name)
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args })
  const hash = await sendTracked(wallet.account, nonce => wallet.sendTransaction({ data, nonce }))
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deploy ${name} gagal: ${hash}`)
  console.log(`  ${name.padEnd(20)} ${receipt.contractAddress}  (gas ${receipt.gasUsed})`)
  return { address: getAddress(receipt.contractAddress), hash, gasUsed: receipt.gasUsed }
}

async function sendWrite(wallet, address, functionName, args) {
  const hash = await sendTracked(wallet.account, nonce =>
    wallet.writeContract({ address, abi: DIAMOND_ABI, functionName, args, nonce }))
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${functionName} gagal: ${hash}`)
  return receipt
}

// An already-deployed facet (e.g. a cut that failed after the deploy went through) is reused with
// --facet-address, but only when its runtime bytecode is the one this repo builds.
async function facetForUpgrade(wallet, name) {
  const given = option('--facet-address')
  if (!given) return deployContract(wallet, name)
  const address = getAddress(given)
  const onchain = await client.getCode({ address })
  const stripMetadata = code => code.toLowerCase().slice(0, code.length - (parseInt(code.slice(-4), 16) + 2) * 2)
  const local = artifactOf(name).deployedBytecode.object
  if (!onchain || stripMetadata(onchain) !== stripMetadata(local)) {
    throw new Error(`Bytecode di ${address} bukan hasil build ${name} yang sekarang — deploy ulang saja (tanpa --facet-address).`)
  }
  console.log(`  ${name.padEnd(20)} ${address}  (dipakai ulang, bytecode cocok)`)
  return { address, hash: null, gasUsed: 0n }
}

// Owner calls that bring the contract at `address` in line with CONFIG — only the
// ones still missing, so a re-run (or a contract set up some other way) gets exactly the gap.
async function missingWrites(address) {
  const read = (functionName, args) => client.readContract({ address, abi: DIAMOND_ABI, functionName, args })
  const [targetsSet, tokensSet, strictTokenList, feeBps, feeRecipient, paused] = await Promise.all([
    Promise.all(CONFIG.externalTargets.map(target => read('allowedExternalTarget', [target]))),
    Promise.all(CONFIG.allowedTokens.map(token => read('allowedToken', [token]))),
    read('strictTokenList'),
    read('feeBps'),
    read('feeRecipient'),
    read('paused'),
  ])
  const writes = []
  CONFIG.externalTargets.forEach((target, index) => {
    if (!targetsSet[index]) writes.push(['setExternalTarget', [target, true]])
  })
  CONFIG.allowedTokens.forEach((token, index) => {
    if (!tokensSet[index]) writes.push(['setAllowedToken', [token, true]])
  })
  if (CONFIG.strictTokenList && !strictTokenList) writes.push(['setStrictTokenList', [true]])
  const feeDiffers = feeBps !== CONFIG.feeBps ||
    (CONFIG.feeBps > 0 && feeRecipient.toLowerCase() !== CONFIG.feeRecipient.toLowerCase())
  if (feeDiffers) writes.push(['setFee', [CONFIG.feeRecipient, CONFIG.feeBps]])
  if (paused !== CONFIG.paused) writes.push(['setPaused', [CONFIG.paused]])
  return writes
}

async function applyWrites(wallet, address, writes) {
  for (const [functionName, args] of writes) {
    await sendWrite(wallet, address, functionName, args)
    console.log(`  ${functionName}(${args.join(', ')}) ✓`)
  }
  const left = await missingWrites(address)
  console.log(`  Konfigurasi: ${left.length ? `MASIH KURANG ${left.length}` : 'lengkap ✓'}`)
}

async function verifyOnBlockscout(name, address) {
  let source
  try {
    // forge flatten adds "// src/…" file markers; the published source stays comment-free like the repo's.
    if (!FORGE) throw new Error('forge unavailable')
    source = stripSolidityComments(execFileSync(FORGE, ['flatten', SOURCES[name]], { cwd: CONTRACTS_DIR, encoding: 'utf8' }))
  } catch {
    console.log(`  ${name}: forge flatten gagal — verifikasi manual.`)
    return false
  }
  // Blockscout indexes a fresh contract a few seconds after its block and rate-limits bursts (429):
  // retry the submission with backoff.
  let response
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(done => setTimeout(done, 5_000 * (attempt + 1)))
    response = await fetch(`${BLOCKSCOUT}/api/v2/smart-contracts/${address}/verification/via/flattened-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        compiler_version: SOLC,
        source_code: source,
        contract_name: name,
        is_optimization_enabled: true,
        optimization_runs: 200,
        evm_version: 'default',
        autodetect_constructor_args: true,
        license_type: 'mit',
      }),
    }).catch(() => null)
    if (response?.ok) break
  }
  if (!response?.ok) {
    console.log(`  ${name}: Blockscout menolak (${response?.status ?? 'network error'}) — verifikasi manual.`)
    return false
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(done => setTimeout(done, 6_000))
    const info = await fetch(`${BLOCKSCOUT}/api/v2/smart-contracts/${address}`).then(r => r.json()).catch(() => null)
    if (info?.is_verified) {
      console.log(`  ${name}: terverifikasi ✓`)
      return true
    }
  }
  console.log(`  ${name}: belum terverifikasi — cek manual di Blockscout.`)
  return false
}

const readRecord = () => (existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : null)
function writeRecord(record) {
  mkdirSync(dirname(RECORD), { recursive: true })
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}${LF}`)
}

// --verify-etherscan: verify every contract of the recorded deployment on Etherscan with forge, from
// the exact multi-file sources (exact match). Needs ETHERSCAN_API_KEY (environment or .env.deploy).
if (flag('--verify-etherscan')) {
  const record = readRecord()
  if (!record?.diamond) throw new Error('contracts/deployments/sepolia.json tidak ada — deploy dulu.')
  const apiKey = deployEnv('ETHERSCAN_API_KEY')
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY belum diisi di .env.deploy (buat gratis di etherscan.io/myapikey).')
  if (!FORGE) throw new Error('forge (Foundry) tidak ditemukan.')
  const targets = [
    ['Aether', record.diamond, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [record.owner, record.facets.DiamondCutFacet])],
    ...Object.entries(record.facets).map(([name, address]) => [name, address, null]),
    ['AetherInit', record.init, null],
  ]
  console.log(`${LF}Verifikasi ${targets.length} kontrak di Etherscan (Sepolia)...`)
  let verified = 0
  for (const [name, address, constructorArgs] of targets) {
    const args = ['verify-contract', address, `${SOURCES[name]}:${name}`, '--chain', 'sepolia', '--watch']
    if (constructorArgs) args.push('--constructor-args', constructorArgs)
    try {
      const out = execFileSync(FORGE, args, {
        cwd: CONTRACTS_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, ETHERSCAN_API_KEY: apiKey },
      })
      const already = /already verified/i.test(out)
      verified++
      console.log(`  ${name.padEnd(20)} ${address} ${already ? 'sudah terverifikasi ✓' : 'terverifikasi ✓'}`)
    } catch (error) {
      const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
      if (/already verified/i.test(text)) {
        verified++
        console.log(`  ${name.padEnd(20)} ${address} sudah terverifikasi ✓`)
      } else {
        const reason = text.split(LF).map(line => line.trim()).filter(Boolean).slice(-2).join(' ')
        console.log(`  ${name.padEnd(20)} ${address} GAGAL — ${reason.slice(0, 160)}`)
      }
    }
  }
  console.log(`${LF}${verified}/${targets.length} kontrak terverifikasi di Etherscan.`)
  process.exit(verified === targets.length ? 0 : 1)
}


// --configure <address>: apply the configuration above to an existing deployment.
const configureAddress = option('--configure')
if (configureAddress) {
  const address = getAddress(configureAddress)
  const read = functionName => client.readContract({ address, abi: DIAMOND_ABI, functionName })
  const [owner, version] = await Promise.all([read('owner'), read('VERSION').catch(() => '?')])
  const writes = await missingWrites(address)
  console.log(`${LF}Konfigurasi ${address}${rpcNote} — VERSION ${version}, owner ${owner}`)
  if (!writes.length) {
    console.log('  Konfigurasinya sudah lengkap. Tidak ada yang perlu dikirim.')
    process.exit(0)
  }
  console.log(`  Yang belum diatur:`)
  for (const [functionName, args] of writes) console.log(`    - ${functionName}(${args.join(', ')})`)
  if (dryRun) {
    console.log('[dry-run] Tidak ada transaksi yang dikirim.')
    process.exit(0)
  }
  const { account, wallet } = await signer(`${LF}Private key owner ${owner} (tidak ditampilkan): `)
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Key ini milik ${account.address}, bukan owner ${owner}. Hanya owner yang bisa mengatur.`)
  }
  if ((await confirm(`  Ketik 'configure' untuk mengirim ${writes.length} transaksi: `)) !== 'configure') {
    console.log('Dibatalkan. Tidak ada transaksi yang dikirim.')
    process.exit(0)
  }
  await applyWrites(wallet, address, writes)
  process.exit(0)
}

// --upgrade <Facet>: deploy a new version of one facet and cut it in. Selectors the new version
// has are added or replaced; selectors only the old version had are removed.
const upgradeFacet = option('--upgrade')
if (upgradeFacet) {
  if (![...FACETS, 'DiamondCutFacet'].includes(upgradeFacet)) {
    throw new Error(`Facet tidak dikenal: ${upgradeFacet}. Pilihan: ${[...FACETS, 'DiamondCutFacet'].join(', ')}`)
  }
  const record = readRecord()
  const diamond = getAddress(option('--diamond') ?? record?.diamond ?? zeroAddress)
  if (diamond === zeroAddress) throw new Error('Alamat diamond tidak diketahui: pakai --diamond <address>.')
  const read = functionName => client.readContract({ address: diamond, abi: DIAMOND_ABI, functionName })
  const [owner, facets] = await Promise.all([read('owner'), read('facets')])
  const servedBy = new Map(facets.flatMap(facet => facet.functionSelectors.map(selector => [selector, facet.facetAddress])))
  const next = selectorsOf(upgradeFacet)
  const oldFacets = new Set(next.map(selector => servedBy.get(selector)).filter(Boolean))
  const oldSelectors = facets.filter(facet => oldFacets.has(facet.facetAddress)).flatMap(facet => facet.functionSelectors)
  const add = next.filter(selector => !servedBy.has(selector))
  const replace = next.filter(selector => servedBy.has(selector))
  const remove = oldSelectors.filter(selector => !next.includes(selector))

  console.log(`${LF}Upgrade ${upgradeFacet} di diamond ${diamond}${rpcNote} (owner ${owner})`)
  console.log(`  facet lama: ${[...oldFacets].join(', ') || '-'}`)
  console.log(`  tambah ${add.length} · ganti ${replace.length} · hapus ${remove.length} fungsi`)
  if (dryRun) {
    const gas = await client.estimateGas({ account: owner, data: artifactOf(upgradeFacet).bytecode.object })
    console.log(`[dry-run] Deploy facet baru ~${gas} gas, lalu satu diamondCut. Tidak ada transaksi yang dikirim.`)
    process.exit(0)
  }
  const { account, wallet } = await signer(`${LF}Private key owner ${owner} (tidak ditampilkan): `)
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Key ini milik ${account.address}, bukan owner ${owner}. Hanya owner yang bisa upgrade.`)
  }
  if ((await confirm("  Ketik 'upgrade' untuk lanjut: ")) !== 'upgrade') {
    console.log('Dibatalkan. Tidak ada transaksi yang dikirim.')
    process.exit(0)
  }
  const deployed = await facetForUpgrade(wallet, upgradeFacet)
  const cut = [
    add.length && { facetAddress: deployed.address, action: 0, functionSelectors: add },
    replace.length && { facetAddress: deployed.address, action: 1, functionSelectors: replace },
    remove.length && { facetAddress: zeroAddress, action: 2, functionSelectors: remove },
  ].filter(Boolean)
  await sendWrite(wallet, diamond, 'diamondCut', [cut, zeroAddress, '0x'])
  const now = await client.readContract({ address: diamond, abi: DIAMOND_ABI, functionName: 'facetAddress', args: [next[0]] })
  console.log(`  diamondCut ✓ — ${upgradeFacet} sekarang dilayani ${now}`)
  if (record?.diamond && getAddress(record.diamond) === diamond) {
    record.history = [...(record.history ?? []), { facet: upgradeFacet, from: [...oldFacets], to: deployed.address, at: new Date().toISOString() }]
    record.facets[upgradeFacet] = deployed.address
    writeRecord(record)
  }
  if (verify) await verifyOnBlockscout(upgradeFacet, deployed.address)
  process.exit(0)
}

// Default: deploy the whole diamond.
const initArgs = [CONFIG.weth, CONFIG.v3Router, CONFIG.permit2, CONFIG.universalRouter, CONFIG.externalTargets]
console.log(`${LF}Aether Diamond (EIP-2535) — deploy ke Sepolia${rpcNote}`)
console.log(`  Facet: DiamondCutFacet, ${FACETS.join(', ')} + AetherInit`)
console.log(`  Konfigurasi:`)
console.log(`    weth ${CONFIG.weth}`)
console.log(`    v3Router ${CONFIG.v3Router}`)
console.log(`    permit2 ${CONFIG.permit2}`)
console.log(`    universalRouter ${CONFIG.universalRouter}`)
console.log(`    target eksternal tambahan: ${CONFIG.externalTargets.join(', ') || '-'}`)
console.log(`    fee ${CONFIG.feeBps} bps, strictTokenList ${CONFIG.strictTokenList}, token diizinkan ${CONFIG.allowedTokens.length}, paused ${CONFIG.paused}`)

const creations = ['DiamondCutFacet', ...FACETS, 'AetherInit']
if (dryRun) {
  const gasPrice = await client.getGasPrice()
  let total = 0n
  for (const name of creations) {
    const gas = await client.estimateGas({ data: artifactOf(name).bytecode.object })
    total += gas
    console.log(`  ${name.padEnd(20)} ~${gas} gas`)
  }
  console.log(`${LF}[dry-run] ${creations.length} kontrak ~${total} gas (~${formatEther(total * gasPrice)} ETH di gas price sekarang),`)
  console.log('[dry-run] ditambah kontrak Aether (diamond) + satu diamondCut. Tidak ada transaksi yang dikirim.')
  process.exit(0)
}

const { account, wallet } = await signer(`${LF}Private key deployer (tidak ditampilkan): `)
const balance = await client.getBalance({ address: account.address })
console.log(`${LF}  Deployer = owner diamond: ${account.address} (saldo ${formatEther(balance)} ETH)`)
console.log(`  ${creations.length + 2} transaksi: ${creations.length} kontrak, Aether (diamond), lalu diamondCut + init.`)
if ((await confirm("  Ketik 'deploy' untuk lanjut: ")) !== 'deploy') {
  console.log('Dibatalkan. Tidak ada transaksi yang dikirim.')
  process.exit(0)
}

const deployed = {}
for (const name of creations) deployed[name] = await deployContract(wallet, name)
const diamondDeploy = await deployContract(wallet, 'Aether', [account.address, deployed.DiamondCutFacet.address])
const diamond = diamondDeploy.address

const cut = FACETS.map(name => ({ facetAddress: deployed[name].address, action: 0, functionSelectors: selectorsOf(name) }))
const initCalldata = encodeFunctionData({ abi: artifactOf('AetherInit').abi, functionName: 'init', args: initArgs })
const cutReceipt = await sendWrite(wallet, diamond, 'diamondCut', [cut, deployed.AetherInit.address, initCalldata])
console.log(`  diamondCut + init ✓ (gas ${cutReceipt.gasUsed})`)

await applyWrites(wallet, diamond, await missingWrites(diamond))
const readDiamond = functionName => client.readContract({ address: diamond, abi: DIAMOND_ABI, functionName })
const [version, owner, facets] = await Promise.all([readDiamond('VERSION'), readDiamond('owner'), readDiamond('facets')])
console.log(`  Cek: VERSION ${version}, owner ${owner}, ${facets.length} facet terpasang`)

writeRecord({
  type: 'EIP-2535 diamond',
  version,
  diamond,
  owner,
  deployTx: diamondDeploy.hash,
  cutTx: cutReceipt.transactionHash,
  facets: Object.fromEntries(['DiamondCutFacet', ...FACETS].map(name => [name, deployed[name].address])),
  init: deployed.AetherInit.address,
  deployedAt: new Date().toISOString(),
})

if (verify) {
  console.log('  Verifikasi source di Blockscout...')
  for (const name of [...creations, 'Aether']) {
    await verifyOnBlockscout(name, name === 'Aether' ? diamond : deployed[name].address)
  }
}

console.log(`${LF}Selesai. Alamat aggregator (diamond): ${diamond}`)
console.log(`Set di .env.local lalu restart dev server:${LF}  NEXT_PUBLIC_AETHER_AGGREGATOR_ADDRESS=${diamond}${LF}`)
process.exit(0)
