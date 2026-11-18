/**
 * Session naming (requirement C): every session the plugin CREATES gets a
 * stable, readable title instead of showing up unnamed in the GUI session list.
 *
 * Host capability (verified against the @deepseek-ai/dsh 0.2.2-rc.3 docs and the
 * running 0.2.2-rc.3 host, sources under app.asar/dsh):
 * - There IS a title write API: `ctx.sessionTitle.rename(session, title)`
 *   (`@deepseek-ai/dsh-session-title`) appends the log-only `session/title`
 *   event with `source: { kind: 'user' }`, which also PINS the title so automatic
 *   title generation stops overwriting it. `ctx.sessionTitle.get(session)` reads
 *   the latest folded title. The GUI session list renders the `title` projection
 *   row (`session_projcache/.../title.val`), which is folded from that event, so a
 *   host rename is what actually removes the "unnamed" state in the sidebar.
 * - The AGENT API GATEWAY also exposes `SessionService.rename(request)` (Remote
 *   'rename', "rename one Session after explicitly resuming it") for client-side
 *   renames; a plugin should use the host service instead of the client Remote.
 * - The session HEADER has no writable title: it is the immutable creation header
 *   (version/id/createdAt/cwd/lineage). Title lives only in the log event fold.
 * - Degraded path: when the title service is absent (headless/minimal profile),
 *   `session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })`
 *   writes the exact shape `rename` writes. If even `append` is unavailable the
 *   plugin still names the topic-set member (panel + /memory output), but the GUI
 *   list keeps showing it unnamed; that limitation is reported, never faked.
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

/** Lifecycle access the title path needs from the host context. */
export interface TitleSessionLike {
  append?(type: string, data: unknown): unknown
}

/** Structural view of the host context (compile-time only; never shadows it). */
export interface TitleHost {
  get?(name: string): unknown
  sessions?: {
    get(id: string): (TitleSessionLike & Record<string, unknown>) | undefined
  }
}

/** Where a title ended up: host event, direct log append, or nowhere. */
export type SessionTitleOutcome = 'already' | 'host' | 'fallback' | 'none'

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
 * Persist the member title for one topic-set branch, computing it only when the
 * member has no title yet (a reused branch keeps its first stable name).
 * @param store - plugin store.
 * @param topicSetId - owning topic set.
 * @param member - branch identity and kind.
 * @param topicTitle - topic-set title fallback when the row is gone.
 * @param task - task text used for the snippet.
 * @returns the title now stored on the member.
 */
export async function ensureMemberTitle(
  store: Store,
  topicSetId: string,
  member: NamedMember,
  topicTitle: string,
  task: string,
): Promise<string> {
  const record = store.topicsets.get(topicSetId)
  if (!record) return sessionTitleFor(topicTitle, task)
  const current = record.members.find((entry) => entry.sessionId === member.sessionId)
  if (current && current.title.trim()) return current.title
  const others = record.members
    .filter((entry) => entry.sessionId !== member.sessionId)
    .map((entry) => entry.title)
  const title = sessionTitleFor(record.title || topicTitle, task, others)
  if (current) {
    await updateMember(store, topicSetId, member.sessionId, { title })
  } else {
    await addMember(store, topicSetId, { sessionId: member.sessionId, kind: member.kind, title })
  }
  return title
}

/**
 * Apply a title to the HOST session so the GUI session list stops showing it
 * unnamed. Prefers `ctx.sessionTitle.rename` (host-owned normalization + pin),
 * falls back to the exact `session/title` log append, and never throws.
 * @param ctx - host context (structural view).
 * @param sessionId - live session to name.
 * @param title - proposed title (normalized again here).
 * @param logger - warning sink.
 * @returns where the title landed.
 */
export function applySessionTitle(
  ctx: TitleHost,
  sessionId: string,
  title: string,
  logger: { warn: (msg: string) => void },
  options: { force?: boolean } = {},
): SessionTitleOutcome {
  const clean = clipEllipsis(firstLine(cleanTitleText(title)), TITLE_MAX_CHARS)
  if (!clean) return 'none'
  const session = ctx.sessions?.get(sessionId)
  if (!session) return 'none'
  const service = (() => {
    try { return ctx.get?.('sessionTitle') } catch { return undefined }
  })() as
    | { get?(session: unknown): { title?: string } | undefined; rename?(session: unknown, text: string): unknown }
    | undefined
  // The 'already' guard keeps a first naming from overwriting an existing
  // title; the one-time title migration passes force to refresh a stale one.
  if (!options.force) {
    try {
      if (service && typeof service.get === 'function') {
        const current = service.get(session)
        if (current && typeof current.title === 'string' && current.title.trim()) return 'already'
      }
    } catch (error) {
      logger.warn('supermemory: session title read skipped: ' + String(error).slice(0, 160))
    }
  }
  try {
    if (service && typeof service.rename === 'function') {
      service.rename(session, clean)
      return 'host'
    }
  } catch (error) {
    logger.warn('supermemory: sessionTitle.rename failed, falling back to the log event: ' + String(error).slice(0, 160))
  }
  try {
    const append = session.append
    if (typeof append === 'function') {
      append.call(session, 'session/title', { title: clean, messageSeqs: [], source: { kind: 'user' } })
      return 'fallback'
    }
  } catch (error) {
    logger.warn('supermemory: session title log append failed: ' + String(error).slice(0, 160))
  }
  return 'none'
}

/**
 * The live HOST title of one session, or undefined when the session is not
 * tracked, carries no title, or the title service is unavailable. The
 * one-time title migration uses it to detect a title that somebody else
 * renamed, so it never overwrites a human's choice.
 */
export function currentSessionTitle(ctx: TitleHost, sessionId: string): string | undefined {
  const session = ctx.sessions?.get(sessionId)
  if (!session) return undefined
  try {
    const service = ctx.get?.('sessionTitle') as
      | { get?(target: unknown): { title?: string } | undefined }
      | undefined
    const current = service?.get?.(session)
    if (current && typeof current.title === 'string' && current.title.trim()) return current.title
  } catch { /* no title service: treat as untitled */ }
  return undefined
}
