/**
 * R59 Phase 1b: the durable MEMBER/branch title composer.
 *
 * A session the plugin creates has THREE title copies: the host title (the GUI
 * authority), the topic-set member title and the dispatch title. R43 budgeted
 * them in CHARACTERS (60), which could produce a 180-byte durable string while
 * the host silently clipped at 80 bytes — the copies then disagreed.
 *
 * This module composes ONCE, under {@link TITLE_MAX_BYTES}, so every copy is the
 * same byte string: task branches use {@link composeBranchTitle}; topic-set
 * members use the existing "set · task" rule and are byte-clipped afterwards.
 * @module supermemory/session-title/member
 */
import type { Store } from '../store.ts'
import { addMember, updateMember } from '../topicsets.ts'
import { sessionTitleFor, type NamedMember } from '../title.ts'
import { clipTitleBytes, composeBranchTitle } from './policy.ts'

/** How a member title is composed. */
export interface MemberTitleOptions {
  /**
   * Name a WORK BRANCH: the title is the task itself (no topic-set prefix),
   * matching 「会话名称直接描述工作内容」.
   */
  taskOnly?: boolean
}

/**
 * Persist the member title for one topic-set branch, computing it only when the
 * member has no title yet (a reused branch / continue / resume keeps its first
 * stable name — never renamed automatically).
 *
 * @param store - plugin store.
 * @param topicSetId - owning topic set.
 * @param member - branch identity and kind.
 * @param topicTitle - topic-set title fallback when the row is gone.
 * @param task - task text used for the snippet.
 * @param options - `taskOnly` for plugin work branches.
 * @returns the title now stored on the member (≤ 80 UTF-8 bytes).
 */
export async function ensureMemberTitle(
  store: Store,
  topicSetId: string,
  member: NamedMember,
  topicTitle: string,
  task: string,
  options: MemberTitleOptions = {},
): Promise<string> {
  const record = store.topicsets.get(topicSetId)
  if (!record) {
    return options.taskOnly
      ? composeBranchTitle(task)
      : clipTitleBytes(sessionTitleFor(topicTitle, task))
  }
  const current = record.members.find((entry) => entry.sessionId === member.sessionId)
  if (current && current.title.trim()) return current.title
  const others = record.members
    .filter((entry) => entry.sessionId !== member.sessionId)
    .map((entry) => entry.title)
  const title = options.taskOnly
    ? composeBranchTitle(task)
    : clipTitleBytes(sessionTitleFor(record.title || topicTitle, task, others))
  if (current) {
    await updateMember(store, topicSetId, member.sessionId, { title })
  } else {
    await addMember(store, topicSetId, { sessionId: member.sessionId, kind: member.kind, title })
  }
  return title
}
