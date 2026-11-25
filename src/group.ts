/**
 * Parallel dispatch groups (decision D6): one round of `memory_dispatch` with
 * `tasks[]` becomes a fixed member set sharing a `groupId`. Every member keeps
 * its own terminal state and cursor; only after ALL members reach ANY terminal
 * state does a single group relay go out, with failed members annotated.
 * @module supermemory/group
 */
import type { Store } from './store.ts'
import type { Dispatch } from './schema.ts'
import { newId } from './store.ts'
import { openQuestionsOfGroup, renderQuestionsBlock } from './questions.ts'
import { clipMarked } from './clip.ts'
import { clipRelayResult, episodeResult } from './relay-text.ts'

/** Members of one group, in creation order. */
export function groupMembers(store: Store, groupId: string): Array<[string, Dispatch]> {
  const out: Array<[string, Dispatch]> = []
  for (const [dispatchId, record] of store.dispatches.entries()) {
    if (record.groupId === groupId) out.push([dispatchId, record])
  }
  out.sort((a, b) => a[1].createdAt - b[1].createdAt)
  return out
}

/**
 * Dispatch states that end a member's life. `interrupted` (timeout / stop /
 * plugin reload) is terminal exactly like `failed`: excluding it kept
 * `groupComplete` false forever, so one silent member withheld the WHOLE group's
 * single relay. It is still annotated as an interruption, never as success.
 */
const TERMINAL_MEMBER_STATUSES = new Set<Dispatch['status']>([
  'delivered',
  'failed',
  'interrupted',
])

/** True when every member reached a terminal state. */
export function groupComplete(store: Store, groupId: string): boolean {
  const members = groupMembers(store, groupId)
  if (members.length === 0) return false
  return members.every(([, record]) => TERMINAL_MEMBER_STATUSES.has(record.status))
}

/** The hub-facing group relay text: one line per member, failures/interrupts annotated. */
export function groupRelayText(store: Store, groupId: string, episodes: Map<string, string>): string {
  const members = groupMembers(store, groupId)
  const lines: string[] = [`[supermemory-group-relay ${groupId}]`, `共 ${members.length} 个分支任务：`]
  let ok = 0
  let failed = 0
  let interrupted = 0
  members.forEach(([, record], index) => {
    // R47: the one-line label is clipped at a boundary and SAYS so — the old
    // `.slice(0, 40)` cut the task mid-word with no marker.
    const label = clipMarked(record.task, 40)
    if (record.status === 'delivered') {
      ok++
      const summary = episodes.get(record.branchSessionId) ?? '（已完成）'
      lines.push(`${index + 1}. ✅ ${label}\n   ${summary}`)
    } else if (record.status === 'interrupted') {
      interrupted++
      // R19 fix: an interrupted member is terminal, and saying so is the point:
      // the hub must be able to tell "timed out / stopped" from "run failed".
      lines.push(`${index + 1}. ⏹ ${label}\n   中断终态：${record.turnEndReason ?? 'unknown'}（未伪装成答案）`)
    } else {
      failed++
      lines.push(`${index + 1}. ❌ ${label}\n   失败终态：${record.turnEndReason ?? 'unknown'}（未伪装成答案）`)
    }
  })
  lines.push(`汇总：${ok} 成功 / ${failed} 失败 / ${interrupted} 中断。`)
  // R20: every member's open questions travel with the ONE group relay, so the
  // hub can aggregate them without polling each branch separately.
  const questions = renderQuestionsBlock(openQuestionsOfGroup(store, groupId), '并行组各分支上交的问题（中枢汇总后统一向用户提问）：')
  if (questions) lines.push('', questions)
  return lines.join('\n')
}

/** Collect the episode results (full answers) of a group's delivered members. */
export function groupEpisodeSummaries(store: Store, groupId: string): Map<string, string> {
  const out = new Map<string, string>()
  const members = groupMembers(store, groupId)
  const branchIds = new Set(members.map(([, r]) => r.branchSessionId))
  for (const [, episode] of store.episodes.entries()) {
    // The full answer (`result`), not the 400-char `summary`: the group relay is
    // these members' ONLY delivery, so it must carry their actual work.
    const text = episodeResult(episode)
    if (episode.branchSessionId && branchIds.has(episode.branchSessionId) && text) {
      out.set(episode.branchSessionId, clipRelayResult(text, episode.branchSessionId))
    }
  }
  return out
}

/** Whether a group relay was already enqueued (idempotency guard). */
export function groupRelayExists(store: Store, groupId: string): boolean {
  for (const [, item] of store.outbox.entries()) {
    if (item.groupId === groupId) return true
  }
  return false
}

/** Stable group id for a dispatch round. */
export function newGroupId(): string {
  return newId('grp')
}
