/**
 * The retrieval shape shared by every SuperMemory record (R10).
 *
 * A record is **title + tags + body**, never one undifferentiated blob:
 * - `title` is what a human scans and what recall scores highest;
 * - `tags` (stored as `keywords` on memories/topic sets, `tags` on tools) are
 *   the cheap index a query matches before any body text is read;
 * - the body stays the authoritative content.
 *
 * Keeping the derivation here means the tool layer, the maintenance pass, and
 * both UIs agree on what "title from a body" and "tags from free text" mean.
 * @module supermemory/retrieval
 */
import { keywordsOf } from './extract.ts'

/** Hard caps shared by stores, UIs, and export. */
export const TITLE_MAX = 48
export const TAG_MAX = 12
export const TAG_LENGTH_MAX = 24

/**
 * R19 需求⑧: a memory is a CONCLUSION, not a transcript.
 *
 * The write path is the last line of defence after the tool description and
 * the hub/system prompts: a body above {@link MEMORY_TEXT_MAX} characters, one
 * that is a wall of numbered steps/commands, or a long fenced command dump is
 * rejected with an actionable message. Everything else (a multi-line
 * conclusion, a bulleted decision list) is accepted — the heuristic is
 * deliberately conservative so a legitimate fact is never lost.
 */
export const MEMORY_TEXT_MAX = 1500

/** Step-line markers that signal a process log rather than a conclusion. */
const STEP_LINE = /^\s*(?:步骤\s*\d+|第[一二三四五六七八九十0-9]+步|step\s*\d+|\d{1,2}[.)、]\s+)/i

export type ConclusionAssessment = { ok: true } | { ok: false; message: string }

/** Classify one memory body before it is written. */
export function assessConclusion(input: string): ConclusionAssessment {
  const text = String(input ?? '').trim()
  if (!text) return { ok: false, message: '正文不能为空。' }
  if (Array.from(text).length > MEMORY_TEXT_MAX) {
    return {
      ok: false,
      message: `正文过长（${Array.from(text).length} 字，上限 ${MEMORY_TEXT_MAX}）：记忆只存结论，请压缩为可复用的事实/决策；过程步骤请留在会话里。`,
    }
  }
  const lines = text.split(/\r?\n/)
  const stepLines = lines.filter((line) => STEP_LINE.test(line)).length
  if (stepLines >= 3) {
    return {
      ok: false,
      message: '这段内容像过程流水账（多条编号步骤）：记忆只存结论性、可复用的事实/决策，请改写为结论。',
    }
  }
  if (lines.length >= 25) {
    return {
      ok: false,
      message: `正文行数过多（${lines.length} 行）：请只保留结论性事实/决策，过程记录不必写入记忆。`,
    }
  }
  if (text.includes('```') && Array.from(text).length > 700) {
    return {
      ok: false,
      message: '长代码块看起来是过程材料：记忆只存结论（命令结论、约定、决策），不要粘贴大段输出。',
    }
  }
  return { ok: true }
}

/**
 * Derive a human title from a body when the caller supplied none.
 * The first sentence/clause is used (Chinese full stop, semicolon, newline),
 * trimmed to {@link TITLE_MAX} characters, so old-style `memory_remember`
 * calls still produce a scannable index.
 */
export function deriveTitle(body: string, fallback = ''): string {
  const clean = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return fallback.slice(0, TITLE_MAX)
  const clause = clean.split(/[。！？；;.!?\n]/)[0]?.trim() || clean
  const base = clause.length <= TITLE_MAX ? clause : `${clause.slice(0, TITLE_MAX - 1)}…`
  return base
}

/** Normalise whatever a caller passed as tags (array, comma text, undefined). */
export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，、;；|\s]+/)
      : []
  const out: string[] = []
  for (const entry of raw) {
    const tag = String(entry ?? '').trim().replace(/^#+/, '')
    if (!tag) continue
    const capped = tag.slice(0, TAG_LENGTH_MAX)
    if (out.includes(capped)) continue
    out.push(capped)
    if (out.length >= TAG_MAX) break
  }
  return out
}

/**
 * The record's tag list: the caller's tags when it supplied any, otherwise the
 * auto-extracted keywords of the body.
 *
 * Deliberately NOT a union: the point of the title + tags + body shape is that
 * the tag space stays a human-chosen index. Mixing CJK bigrams into explicitly
 * tagged records made every record look tagged with noise ("新记", "记忆", …)
 * and pushed real tags out of the display. Records with no tags at all still
 * fall back to the body vocabulary, so old flows stay findable.
 */
export function mergeTags(tags: string[], autoKeywords: string[]): string[] {
  const explicit = normalizeTags(tags)
  return explicit.length > 0 ? explicit : normalizeTags(autoKeywords)
}

/** Tags of a free-form body, normalised (used when a record carries none). */
export function tagsOfBody(body: string): string[] {
  return normalizeTags(keywordsOf(body))
}

/** The card line every UI and the model-facing render share. */
export function renderRecordLine(record: { title?: string; text: string; tags?: readonly string[] }): string {
  const title = record.title?.trim()
  const tags = (record.tags ?? []).filter(Boolean)
  const head = title && title !== record.text.trim() ? `【${title}】` : ''
  const tail = tags.length > 0 ? ` ｜标签: ${tags.join('、')}` : ''
  return `${head}${record.text}${tail}`
}
