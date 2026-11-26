/**
 * Branch title/tags (R30 需求④): the durable 「分支会话 → 标题/标签」 mapping.
 *
 * DSH session metadata is native for TITLES only: `ctx.sessionTitle.rename`
 * writes the log-only `session/title` event (verified against the running host,
 * see title.ts and the dsh-session-title README) and the immutable session
 * header carries no writable label at all — there is NO native session-tag
 * concept (checked in the shipped session/session-title sources: no tags /
 * label / category field). Tags therefore live on the DISPATCH record
 * (schema.ts `dispatches.title` / `dispatches.tags`, defaults keep v1 media
 * readable) and this module is the single place that derives and projects them:
 *
 *  - dispatch.ts / resume.ts write them at dispatch time;
 *  - hub-branches.ts projects the newest row of each branch into
 *    {@link HubBranchView} (title + tags), which feeds the hub card, the panel
 *    branch rows and the web console — one vocabulary, three surfaces.
 *
 * Title rule: the task's first line, markup stripped, ellipsis-clipped. The
 * host session title keeps its own rule (`<话题集> · <任务首行>`, title.ts) so
 * the GUI sidebar is unchanged; this title is what the memory surfaces show.
 * Tag rule: 话题集标签 + 轮次令牌（R30 / R30-B …）+ 任务性质 + 能力档位,
 * de-duplicated and bounded (the card is injected on every turn).
 * @module supermemory/branch-meta
 */
import type { Dispatch } from './schema.ts'
import type { Store } from './store.ts'
import { clipEllipsis } from './title.ts'
import { composeBranchTitle } from './session-title/policy.ts'

/**
 * R59 Phase 1b: the branch budget is {@link TITLE_MAX_BYTES} (80 UTF-8 bytes),
 * composed ONCE by the policy — the same string the host title and the topic-set
 * member carry. The R43 60-character budget is gone: it could cut a title that
 * the host then clipped differently, so durable and host copies disagreed.
 */

/** Maximum tags carried per branch (index, not a taxonomy). */
export const BRANCH_TAGS_MAX = 8

/** Maximum characters of one tag (a runaway token must not blow up a row). */
export const BRANCH_TAG_MAX_CHARS = 24

/** Round tokens of a task text: `R30`, `R30-B`, … (the round's own label). */
const ROUND_TOKEN = /(?:^|[^A-Za-z0-9])((?:R|r)\d{1,3}(?:-[A-Za-z]{1,3})?)/g

/**
 * The explicit branch title for one dispatch: the task's first line, markup
 * stripped, descriptive lead-ins (「R31：」「任务：」「分支 · 」…) removed, and
 * byte-clipped to 80 UTF-8 bytes ({@link TITLE_MAX_BYTES}) by the naming policy.
 * When the task carries no readable line the neutral 「新会话」 fallback is
 * returned.
 */
export function branchTitleFor(task: string): string {
  return composeBranchTitle(task)
}

/**
 * Round tokens of a task text, upper-cased and de-duplicated (R30, R30-B…).
 *
 * A suffixed token also yields its bare round (`R30-B` → `R30-B`, `R30`): the
 * requirement's tag shape is 话题集标签 + 轮次 + 任务性质 + 能力档位, and the
 * bare round is what a hub filters by when a round fans out into A/B/C tasks.
 */
export function roundTokensOf(task: string): string[] {
  const out: string[] = []
  const text = String(task ?? '')
  const push = (token: string): void => {
    if (token && !out.includes(token)) out.push(token)
  }
  ROUND_TOKEN.lastIndex = 0
  for (let match = ROUND_TOKEN.exec(text); match; match = ROUND_TOKEN.exec(text)) {
    const token = match[1].toUpperCase()
    push(token)
    const dash = token.indexOf('-')
    if (dash > 0) push(token.slice(0, dash))
  }
  return out
}

/**
 * The branch's tags: 话题集标签 + 轮次令牌 + 任务性质 + 能力档位.
 *
 * `kind` is the dispatch's nature (`verify` → 验证); `capability` the granted
 * profile name (full / read / read-write / minimal). Order is stable so the
 * chips read the same everywhere; the cap keeps a card bounded.
 */
export function branchTagsFor(input: {
  topicTags?: readonly string[]
  task?: string
  kind?: string
  capability?: string
}): string[] {
  const out: string[] = []
  const push = (tag: string | undefined): void => {
    const clean = String(tag ?? '').trim()
    if (!clean) return
    const clipped = clipEllipsis(clean, BRANCH_TAG_MAX_CHARS)
    if (!out.includes(clipped) && out.length < BRANCH_TAGS_MAX) out.push(clipped)
  }
  for (const tag of input.topicTags ?? []) push(tag)
  for (const token of roundTokensOf(input.task ?? '')) push(token)
  push(input.kind === 'verify' ? '验证' : undefined)
  push(input.capability)
  return out
}

/** One branch's newest title/tags projection (R30 需求④). */
export interface BranchMeta {
  title: string
  tags: string[]
}

/**
 * branchSessionId → the newest dispatch's explicit title + tags.
 *
 * Same newest-row-wins rule as `latestTaskByBranch` (hub-branches.ts): a
 * branch's identity is its latest dispatch, and a resumed dispatch carries the
 * mapping forward (resume.ts copies it). One pass over the dispatch table.
 */
export function latestBranchMeta(store: Store | undefined): Map<string, BranchMeta> {
  const latest = new Map<string, { title: string; tags: string[]; at: number }>()
  if (store) {
    for (const [, row] of store.dispatches.entries()) {
      const branchId = String((row as Dispatch).branchSessionId ?? '')
      if (!branchId) continue
      const at = Math.max(Number(row.updatedAt) || 0, Number(row.createdAt) || 0)
      const current = latest.get(branchId)
      if (current && at < current.at) continue
      latest.set(branchId, { title: String(row.title ?? ''), tags: [...(row.tags ?? [])], at })
    }
  }
  const out = new Map<string, BranchMeta>()
  for (const [branchId, row] of latest) out.set(branchId, { title: row.title, tags: row.tags })
  return out
}
