// Multicall3 for large, uniform reads, with the ABI work done by hand.
//
// The corridor screen re-reads the state of ~600 pools every time it goes stale (each block), and
// the generic encoder paid for that per call: it re-derives the function selector — a keccak — and
// walks the ABI for every one of ~1,200 calls, then decodes every result through a cursor. That
// held the main thread for 75-170ms a time in the browser. These calls are all "selector plus a
// few 32-byte words" and the answers are read as words, so both directions are string slicing.
import { toFunctionSelector } from 'viem'
import { sepolia } from 'viem/chains'
import { client } from './quoteProviders'

const MULTICALL3 = sepolia.contracts.multicall3.address
const AGGREGATE3 = toFunctionSelector('function aggregate3((address target, bool allowFailure, bytes callData)[] calls)')
// Raw calldata per eth_call, the same budget the screen used with the generic client: about 450
// state reads, well inside what the endpoints accept.
const CHUNK_BYTES = 16_384

const WORD = 64
const word = value => value.toString(16).padStart(WORD, '0')

/** `function name(types)` → its 4-byte selector, worked out once by the caller. */
export const selector = signature => toFunctionSelector(signature)
export const addressWord = address => address.slice(2).toLowerCase().padStart(WORD, '0')
export const uintWord = value => word(BigInt(value))

/** Word `index` of a call's return data, as a bigint. */
export const resultWord = (data, index) => BigInt(`0x${data.slice(index * WORD, (index + 1) * WORD)}`)

/** aggregate3 calldata for `calls` ({ target, data }), every call allowed to fail. */
export function encodeAggregate3(calls) {
  const offsets = []
  const tuples = []
  let at = calls.length * 32
  for (const { target, data } of calls) {
    const bytes = (data.length - 2) / 2
    const padded = data.slice(2).padEnd(Math.ceil(bytes / 32) * WORD, '0')
    offsets.push(word(at))
    // target, allowFailure = true, offset of callData inside the tuple, then callData itself.
    tuples.push(addressWord(target) + word(1) + word(0x60) + word(bytes) + padded)
    at += 4 * 32 + padded.length / 2
  }
  return AGGREGATE3 + word(0x20) + word(calls.length) + offsets.join('') + tuples.join('')
}

/** aggregate3's answer → [{ success, data }] (`data` is hex without the 0x). Throws if malformed. */
export function decodeAggregate3(hex, count) {
  const body = hex.slice(2)
  const number = at => {
    const text = body.slice(at * 2, at * 2 + WORD)
    if (text.length !== WORD) throw new Error('aggregate3 answer is truncated')
    return parseInt(text, 16)
  }
  const array = number(0)
  if (number(array) !== count) throw new Error('aggregate3 answered a different number of calls')
  const base = array + 32
  const results = new Array(count)
  for (let i = 0; i < count; i++) {
    const tuple = base + number(base + i * 32)
    const bytes = tuple + number(tuple + 32)
    const size = number(bytes)
    const data = body.slice((bytes + 32) * 2, (bytes + 32 + size) * 2)
    if (data.length !== size * 2) throw new Error('aggregate3 answer is truncated')
    results[i] = { success: number(tuple) === 1, data }
  }
  return results
}

/**
 * Reads `calls` ({ target, data }) through Multicall3. One entry per call, in order:
 * { success, data } — or null when that call's chunk could not be read at all, which is a
 * transport problem and not an answer.
 */
export async function readCalls(calls) {
  const chunks = []
  let size = 0
  for (const call of calls) {
    const bytes = (call.data.length - 2) / 2
    if (!chunks.length || size + bytes > CHUNK_BYTES) {
      chunks.push([])
      size = 0
    }
    chunks[chunks.length - 1].push(call)
    size += bytes
  }
  const answers = await Promise.all(chunks.map(chunk =>
    client.request({ method: 'eth_call', params: [{ to: MULTICALL3, data: encodeAggregate3(chunk) }, 'latest'] })
      .then(hex => decodeAggregate3(hex, chunk.length))
      .catch(() => null)))
  return chunks.flatMap((chunk, i) => answers[i] ?? chunk.map(() => null))
}
