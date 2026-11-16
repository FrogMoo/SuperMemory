/**
 * Rule-based fact extraction from user text (P0: no LLM in the loop).
 *
 * Conservative on purpose: only explicit "remember this" instructions and
 * clear "X 是 Y" definitions become memories. Everything else stays out of the
 * memories table — a wrong fact is worse than a missing one, and the hub model
 * can always call memory_remember explicitly.
 * @module supermemory/extract
 */
export interface ExtractedFact {
  text: string
  keywords: string[]
}

const REMEMBER_PATTERNS: RegExp[] = [
  /(?:记住|记一下|请记住|帮忙记住|牢记)[:：\s]+(.{2,200})/,
  /(?:remember|note that|don'?t forget|keep in mind)\b[:：\s]+(.{2,200})/i,
]

const DEFINITION_PATTERNS: RegExp[] = [
  /^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)(?:是|为|等于)(.{4,200})$/,
  /^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)\s+(?:is|are)\s+(.{4,200})$/i,
]

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  '这个', '那个', '一下', '什么', '怎么', '如何', '请', '帮我把', '记得',
])

/** Extract keywords from a fact text (latin words + CJK bigrams, stop-words dropped). */
export function keywordsOf(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_+#.\-]{2,}/g)) {
    if (!STOP_WORDS.has(m[0])) tokens.push(m[0])
  }
  const chars = text.match(/[\u4e00-\u9fff]/g) ?? []
  for (let i = 0; i + 1 < chars.length; i++) {
    const bigram = chars[i] + chars[i + 1]
    if (!STOP_WORDS.has(bigram)) tokens.push(bigram)
  }
  return [...new Set(tokens)].slice(0, 24)
}

/**
 * Extract memory-worthy facts from one user message.
 * @param text - the user message's plain text.
 * @returns zero or more facts; empty when nothing is memory-worthy.
 */
export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const clean = raw.trim().replace(/\s+/g, ' ').replace(/["'」』]+$/, '').slice(0, 300)
    if (clean.length < 2) return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    facts.push({ text: clean, keywords: keywordsOf(clean) })
  }
  for (const pattern of REMEMBER_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    for (const m of text.matchAll(new RegExp(pattern.source, flags))) push(m[1])
  }
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim()
    // Definition patterns only trust SHORT lines: real "X 是 Y" statements are
    // terse, while long prompt/instruction lines produce junk fragments.
    if (!trimmed || trimmed.length > 80) continue
    for (const pattern of DEFINITION_PATTERNS) {
      const m = trimmed.match(pattern)
      if (m && m[1].length >= 2) push(`${m[1].trim()}是${m[2].trim()}`)
    }
  }
  return facts
}
