/**
 * Requirement extraction (P2): rule-based pull of standing requirements from
 * user text, persisted per workspace. There is no one-shot LLM API on the host
 * runtime, so the rules are deliberately conservative — an explicit marker
 * (必须/需要/要求/待办/TODO/不能/禁止) plus a terse clause. LLM-based lifting
 * stays a documented upgrade path.
 * @module supermemory/requirements
 */
import type { Requirement } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { workspaceKeyOf } from './store.ts'

const PATTERNS: RegExp[] = [
  /(?:必须|一定要|务必|需要|要求|应该|应当|不能|不可以|禁止|千万别|一律)[:：\s]*([^。！？!?\n"'"』」]{4,120})/,
  /(?:待办|TODO|todo)[:：\s]+([^。！？!?\n"'"』」]{4,120})/,
  /(?:^|\s)(?:must|should|need to|required to|cannot|can't|do not|don't)\s+([^。！？!?\n"'"』」]{4,120})/i,
]

/** Extract requirement clauses from one user message. */
export function extractRequirements(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const clean = raw.trim().replace(/\s+/g, ' ').replace(/["'」』]+$/, '').slice(0, 200)
    if (clean.length < 4) return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(clean)
  }
  for (const pattern of PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
      // R27: 疑问句不是需求——捕获的子句后面紧跟问号（"是否需要导出功能？"），
      // 或子句本身以疑问词开头。需求与记忆共用 recall 面，疑问句同样污染检索。
      const tail = text.slice(m.index + m[0].length)
      const stop = tail.search(/[。！？!?\n]/)
      if (/^[？?]/.test((stop < 0 ? '' : tail.slice(stop)).trimStart())) continue
      if (/^(?:是否|能不能|可不可以|怎么|怎样|如何|为什么|为啥|啥|哪些|哪个|有没有|是不是)/.test(m[1].trim())) continue
      push(m[1])
    }
  }
  return out
}

/** Persist extracted requirements for one workspace turn (dedup by text). */
export async function rememberRequirements(
  store: Store,
  workspaceKey: string,
  texts: string[],
  sourceSessionId: string,
  sourceSeq: number,
  now: number,
): Promise<string[]> {
  const created: string[] = []
  for (const text of texts) {
    const normalized = text.trim().toLowerCase()
    let duplicate = false
    for (const [reqId, record] of store.requirements.entries()) {
      if (record.workspaceKey === workspaceKey && record.status === 'open'
        && record.text.trim().toLowerCase() === normalized) {
        duplicate = true
        void reqId
        break
      }
    }
    if (duplicate) continue
    const reqId = newId('req')
    const record: Requirement = {
      workspaceKey,
      text,
      constraints: [],
      status: 'open',
      sourceSessionId,
      sourceSeq,
      createdAt: now,
    }
    await store.requirements.put(reqId, record)
    created.push(reqId)
  }
  return created
}

/** Open requirements of one workspace, newest first. */
export function openRequirements(store: Store, workspaceKey: string): Array<[string, Requirement]> {
  const out: Array<[string, Requirement]> = []
  for (const entry of store.requirements.entries()) {
    if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'open') out.push(entry)
  }
  out.sort((a, b) => b[1].createdAt - a[1].createdAt)
  return out
}

export { workspaceKeyOf }
