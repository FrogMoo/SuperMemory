/**
 * Session naming (requirement C): every session the plugin CREATES gets a
 * stable, readable title instead of showing up unnamed in the GUI session list.
 *
 * R59: HOST TITLE WRITES NO LONGER LIVE HERE. The whole write path moved to
 * `src/session-title/` (policy composes under the host's 80-byte budget, the
 * gate is the single write entry, the observer defers every write out of the
 * `session/event` publication stack). This module keeps only the PURE text
 * helpers and the durable topic-set member title (`ensureMemberTitle`).
 *
 * Host facts the naming service relies on (verified against the running host): the host
 * exposes `ctx.sessionTitle.rename` (writes `session/title` with
 * `source:{kind:'user'}`, which PINS the session), requires a LIVE session,
 * silently truncates to `maxTitleBytes: 80`, and rejects an append made while
 * it is publishing an event.
 *
 * Naming rule (stable, readable, bounded):
 *   <topic-set title> · <first line of the task, markdown/brackets stripped>
 * A task of up to TITLE_TASK_SNIPPET_CHARS characters is shown whole; a
 * longer one is clipped with a trailing "…" (the marker counts toward the
 * budget), so an over-long title says it was clipped instead of ending
 * mid-word. Duplicated titles inside one topic set get a full-width ordinal
 * suffix （2）,（3）…; the final title is capped at TITLE_MAX_CHARS characters.
 * @module supermemory/title
 */
import type { Store } from './store.ts'
import { addMember, updateMember } from './topicsets.ts'
import { readHostTitle } from './session-title/host.ts'

/**
 * Hard character cap of a plugin-assigned session title. The host rename
 * API normalizes the text but documents no shorter limit, and the GUI
 * sidebar row ellipsizes a long title visually while the stored title stays
 * complete — so this is a runaway guard, not a display budget. 80 characters
 * keep "<topic-set> · <task>" informative; the previous 40 cut the task at
 * 16 characters, which users reported as over-truncated.
 */
export const TITLE_MAX_CHARS = 80

/**
 * Characters kept from the task's first line. A task of up to this many
 * characters is shown whole; a longer one is clipped with "…". 48 characters
 * cover a normal one-line task sentence without wrapping the sidebar row.
 */
export const TITLE_TASK_SNIPPET_CHARS = 48

/** Fallback title when both the topic-set title and the task are empty. */
export const TITLE_FALLBACK = '新会话'

/**
 * Character cap for a TOPIC-SET title (not a session title). A topic-set
 * title is an index label shown in lists, cards and /memory output, all of
 * which ellipsize visually; 60 characters keep a descriptive title whole and
 * only clip a runaway one, with "…" marking the cut. Every creation path
 * used to slice to 12–40 characters with no marker at all.
 */
export const TOPIC_SET_TITLE_MAX_CHARS = 60

/** One topic-set member identity. */
export interface NamedMember {
  sessionId: string
  kind: 'root' | 'fork'
}

/** Character-safe truncation (surrogate pairs stay intact). */
export function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= maxChars) return chars.join('')
  return chars.slice(0, Math.max(0, maxChars)).join('')
}

/**
 * Ellipsis-clip: text longer than maxChars is cut and gets a trailing "…",
 * and the marker counts toward the budget, so the result never exceeds
 * maxChars characters. Use this for user-visible titles so an over-long
 * value says it was clipped instead of ending mid-word.
 */
export function clipEllipsis(text: string, maxChars: number): string {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= maxChars) return chars.join('')
  if (maxChars <= 1) return '…'
  return chars.slice(0, maxChars - 1).join('') + '…'
}

/** First non-empty line of a text. */
export function firstLine(text: string): string {
  for (const line of String(text ?? '').split(String.fromCharCode(10))) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * Strip the descriptive lead-ins users and older rounds put in front of a task:
 * 「R31：」「R31-B · 」「R32 」「第 3 轮：」「Round 3 」「项目：」「背景：」
 * 「任务：」「分支 · 」… Two shapes:
 *   - a ROUND token («R32», «R41-B», «第 3 轮», «Round 3») strips after a
 *     separator OR a single space, because dispatch titles are exactly
 *     «R32 只读复核：…». It is anchored, so a round merely MENTIONED inside a
 *     sentence («参考 R31 的实现») is never touched;
 *   - a LABEL («项目：」「背景：」「仓库：」「任务：」「需求：」「派发：」
 *     「请求：」…) keeps REQUIRING a separator, so a title that merely starts
 *     with a label word («需求分析：…») stays whole.
 * Repeats up to three times so stacked prefixes («R31：任务：…») collapse to
 * the task itself.
 */
const LEADING_DESCRIPTION = /^(?:(?:(?:R|r)\d{1,3}(?:-[A-Za-z]{1,3})?|第\s*\d+\s*轮|Round\s*\d+)\s*(?:[：:·•・|\-—–]\s*|\s+)|(?:项目|背景|仓库|任务书|任务|工作内容|需求|派发|请求|分支)\s*(?:[：:·•・|\-—–]|\s{2,})\s*)/i

/** Remove leading descriptive tokens (round / 任务 / 分支 …) from one line. */
export function stripLeadingDescription(text: string): string {
  let value = String(text ?? '').trim()
  for (let round = 0; round < 3; round += 1) {
    const next = value.replace(LEADING_DESCRIPTION, '').trim()
    if (next === value) break
    value = next
  }
  return value
}

/**
 * A session's display name as a DIRECT description of its work: markdown and
 * brackets stripped, descriptive lead-ins removed, first line clipped with an
 * ellipsis. An empty text falls back to the neutral {@link TITLE_FALLBACK}
 * (「新会话」) — never a brand prefix and never an id token.
 */
export function describeSessionTitle(text: string, maxChars = TITLE_TASK_SNIPPET_CHARS): string {
  const cleaned = firstLine(stripLeadingDescription(cleanTitleText(text)))
  return cleaned ? clipEllipsis(cleaned, Math.max(4, Math.floor(maxChars))) : TITLE_FALLBACK
}

/**
 * Strip markdown and bracket markup before truncation: fences, inline code,
 * emphasis markers, ATX headings, blockquotes, list bullets, task boxes and
 * square/full-width bracket characters. Newlines are preserved so the caller can
 * take the first meaningful line.
 */
export function cleanTitleText(text: string): string {
  let value = String(text ?? '').replace(/\r\n?/g, String.fromCharCode(10))
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`[^`]*`/g, ' ')
  value = value.replace(/\*\*|__|~~/g, '')
  value = value.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  value = value.replace(/^\s{0,3}>\s?/gm, '')
  value = value.replace(/^\s{0,3}(?:[-+*]|\d{1,3}[.)])\s+/gm, '')
  value = value.replace(/\[[ xX]?\]/g, ' ')
  value = value.replace(/[\[\]【】〔〕]/g, ' ')
  value = value.replace(/[ \t]+/g, ' ')
  value = value.replace(/[ \t]*\n[ \t]*/g, String.fromCharCode(10))
  return value.trim()
}

/**
 * Compute one session title from a topic-set title and the task text.
 * @param topicTitle - owning topic-set title (may be empty).
 * @param task - dispatch/reply text (may be empty).
 * @param existing - titles already used in the same topic set (for de-duplication).
 * @param options - character budgets (tests and future config).
 * @returns title of at most maxChars characters.
 */
export function sessionTitleFor(
  topicTitle: string,
  task: string,
  existing: Iterable<string> = [],
  options: { maxChars?: number; snippetChars?: number } = {},
): string {
  const maxChars = Math.max(4, Math.floor(options.maxChars ?? TITLE_MAX_CHARS))
  const snippetChars = Math.max(1, Math.floor(options.snippetChars ?? TITLE_TASK_SNIPPET_CHARS))
  const topic = firstLine(cleanTitleText(topicTitle))
  const snippet = clipEllipsis(firstLine(cleanTitleText(task)), snippetChars)
  const separator = ' · '
  let base: string
  if (topic && snippet) {
    const room = Math.max(4, maxChars - separator.length - snippet.length)
    base = clipEllipsis(topic, room) + separator + snippet
  } else if (topic) {
    base = clipEllipsis(topic, maxChars)
  } else if (snippet) {
    base = clipEllipsis(snippet, maxChars)
  } else {
    base = TITLE_FALLBACK
  }
  const used = new Set<string>()
  for (const title of existing) {
    const trimmed = String(title ?? '').trim()
    if (trimmed) used.add(trimmed)
  }
  if (!used.has(base)) return base
  for (let index = 2; index <= 999; index += 1) {
    const suffix = '（' + index + '）'
    const candidate = clipEllipsis(base, Math.max(1, maxChars - suffix.length)) + suffix
    if (!used.has(candidate)) return candidate
  }
  return base
}

/**
 * R59: read-only compatibility surface for the legacy callers that still ask
 * "what does the host show?" and "what should a card label this session?".
 * WRITES are forbidden here — every host title write goes through
 * `src/session-title/gate.ts`; this module only reads.
 */
export interface TitleHost {
  get?(name: string): unknown
  sessions?: {
    get(id: string): unknown
  }
}

/**
 * The live HOST title of one session, or undefined when the session is not
 * tracked, carries no title, or the title service is unavailable.
 */
export function currentSessionTitle(ctx: TitleHost, sessionId: string): string | undefined {
  return readHostTitle(ctx as unknown as Parameters<typeof readHostTitle>[0], sessionId)?.title
}
