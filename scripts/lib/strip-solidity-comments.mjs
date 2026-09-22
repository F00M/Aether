// Removes every comment from Solidity source — line (//), block (/* */) and NatSpec, SPDX line
// included — while leaving string literals untouched. Lines that held only a comment are dropped,
// trailing whitespace is trimmed and runs of blank lines collapse to one. Comments never reach the
// bytecode, so the compiled code is identical before and after.
const BACKSLASH = String.fromCharCode(92)
const LF = String.fromCharCode(10)

export function stripSolidityComments(source) {
  const kept = []
  let inBlock = false
  for (const line of source.split(LF)) {
    let code = ''
    let quote = null
    let hadComment = inBlock
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i)
        if (end === -1) break
        inBlock = false
        i = end + 2
        continue
      }
      const char = line[i]
      const next = line[i + 1]
      if (quote) {
        code += char
        if (char === BACKSLASH && next !== undefined) {
          code += next
          i += 2
          continue
        }
        if (char === quote) quote = null
        i++
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        code += char
        i++
        continue
      }
      if (char === '/' && next === '/') {
        hadComment = true
        break
      }
      if (char === '/' && next === '*') {
        hadComment = true
        inBlock = true
        i += 2
        continue
      }
      code += char
      i++
    }
    code = code.trimEnd()
    if (hadComment && code.trim() === '') continue
    kept.push(code)
  }

  const tidy = []
  for (const line of kept) {
    if (line === '' && (tidy.length === 0 || tidy[tidy.length - 1] === '')) continue
    tidy.push(line)
  }
  while (tidy.length && tidy[tidy.length - 1] === '') tidy.pop()
  return `${tidy.join(LF)}${LF}`
}
