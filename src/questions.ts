/**
 * Branch-raised questions (R20).
 *
 * A branch must not stop and ask the user itself: the hub owns the single
 * conversation with the user, so a branch that needs a decision records a
 * STRUCTURED question here (`memory_raise_question`), keeps working under its
 * best interpretation unless `blocking` is true, and reports its assumptions.
 *
 * The hub then aggregates every open question — from finished AND still-running
 * branches — into one user-facing question (`memory_questions` +
 * `ask_user_question`). Questions travel to the hub three ways, all reading this
 * one table:
 *   - the single dispatch relay (`[supermemory-questions]` block in observe.ts);
 *   - the one-shot parallel-group relay (`group.ts`);
 *   - the hub's explicit `memory_questions` listing.
 *
 * Storage is a dedicated table (not a field on the dispatch record): dispatch
 * status/cursor logic stays untouched, a branch may raise several questions,
 * and an existing medium stays readable (no rows, every default fills on read).
 * @module supermemory/questions
 */
import type { Dispatch, Question } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { topicSetIdsOf } from './topicsets.ts'

/** Severity vocabulary of a raised question. */
export type QuestionSeverity = 'low' | 'medium' | 'high'

/** Dispatch states that no longer own the branch's work. */
const TERMINAL = new Set(['delivered', 'failed', 'interrupted'])

/**
 * Structural view of the questions table that tolerates a partial store
 * (older test double / a medium opened before the table existed). Every reader
 * goes through this instead of assuming `store.questions`.
 */
function questionsOf(store: Store | undefined): Store['questions'] | undefined {
  return (store as { questions?: Store['questions'] } | undefined)?.questions
}

/** True when this store can persist questions. */
export function questionsSupported(store: Store | undefined): boolean {
  const table = questionsOf(store)
  return !!table && typeof table.put === 'function' && typeof table.entries === 'function'
}

/** One branch's question as the hub sees it (id + record). */
export interface QuestionRow {
  id: string
  question: Question
}

/** The dispatch a branch currently belongs to, preferring a still-open one. */
export function dispatchOfBranch(store: Store, branchSessionId: string): [string, Dispatch] | undefined {
  let newest: [string, Dispatch] | undefined
  let newestOpen: [string, Dispatch] | undefined
  for (const [dispatchId, record] of store.dispatches.entries()) {
    if (record.branchSessionId !== branchSessionId) continue
    if (!newest || record.createdAt >= newest[1].createdAt) newest = [dispatchId, record]
    if (TERMINAL.has(String(record.status))) continue
    if (!newestOpen || record.createdAt >= newestOpen[1].createdAt) newestOpen = [dispatchId, record]
  }
  return newestOpen ?? newest
}

/** Open questions of one dispatch, oldest first. */
export function openQuestionsOfDispatch(store: Store | undefined, dispatchId: string): Question[] {
  const table = questionsOf(store)
  if (!table || !store) return []
  const rows: Question[] = []
  for (const [, question] of table.entries()) {
    if (question.status !== 'open' || question.dispatchId !== dispatchId) continue
    rows.push(question)
  }
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

/** Open questions of one parallel group (all members), oldest first. */
export function openQuestionsOfGroup(store: Store | undefined, groupId: string): Question[] {
  const table = questionsOf(store)
  if (!table || !store) return []
  const rows: Question[] = []
  for (const [, question] of table.entries()) {
    if (question.status !== 'open' || question.groupId !== groupId) continue
    rows.push(question)
  }
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

/** Open questions of one branch, oldest first. */
export function openQuestionsOfBranch(store: Store | undefined, branchSessionId: string): Question[] {
  const table = questionsOf(store)
  if (!table || !store) return []
  const rows: Question[] = []
  for (const [, question] of table.entries()) {
    if (question.status !== 'open' || question.branchSessionId !== branchSessionId) continue
    rows.push(question)
  }
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

/**
 * Open questions visible to one hub: everything whose topic set belongs to the
 * hub's workspace, plus anything dispatched by this very hub (a dispatch always
 * resolves a topic set, so the second arm is only a safety net).
 */
export function questionsForHub(
  store: Store | undefined,
  workspaceKey: string,
  hubSessionId?: string,
  status: 'open' | 'resolved' | 'all' = 'open',
): QuestionRow[] {
  const table = questionsOf(store)
  if (!table || !store) return []
  const ownSets = topicSetIdsOf(store, workspaceKey)
  const rows: QuestionRow[] = []
  for (const [id, question] of table.entries()) {
    if (status !== 'all' && question.status !== status) continue
    const inWorkspace = question.topicSetId ? ownSets.has(question.topicSetId) : false
    if (!inWorkspace && (!hubSessionId || question.hubSessionId !== hubSessionId)) continue
    rows.push({ id, question })
  }
  rows.sort((a, b) => a.question.createdAt - b.question.createdAt)
  return rows
}

/** Open questions visible to one hub (the aggregation queue). */
export function openQuestionsForHub(
  store: Store | undefined,
  workspaceKey: string,
  hubSessionId?: string,
): QuestionRow[] {
  return questionsForHub(store, workspaceKey, hubSessionId, 'open')
}

/** Input accepted by {@link raiseQuestion} (already trimmed/validated by the tool). */
export interface RaiseQuestionInput {
  title: string
  question: string
  options?: string[]
  severity?: QuestionSeverity | string
  blocking?: boolean
  progress?: string
  defaultPlan?: string
}

/** Outcome of raising one question. */
export interface RaiseQuestionResult {
  status: 'recorded' | 'error'
  questionId?: string
  dispatchId?: string
  blocking?: boolean
  message: string
}

function normalizeSeverity(raw: unknown): QuestionSeverity {
  return raw === 'low' || raw === 'high' ? raw : 'medium'
}

function clip(raw: unknown, max: number): string {
  return String(raw ?? '').trim().slice(0, max)
}

/**
 * Persist one branch question against the dispatch that owns the branch.
 *
 * Refuses when the caller is not a branch: a hub that needs a user decision
 * must use `ask_user_question` directly, never this channel (the hub is the one
 * that aggregates, so a hub question stored here would never be asked).
 */
export async function raiseQuestion(
  store: Store,
  branchSessionId: string,
  input: RaiseQuestionInput,
): Promise<RaiseQuestionResult> {
  const table = questionsOf(store)
  if (!table) {
    return { status: 'error', message: '问题存储不可用（存储域未打开），问题未上交；请把该问题写进最终汇报。' }
  }
  const found = dispatchOfBranch(store, branchSessionId)
  if (!found) {
    return {
      status: 'error',
      message: 'memory_raise_question 仅分支会话使用：当前会话没有对应的派发记录。'
        + '中枢需要用户裁决时直接用 ask_user_question；不需要裁决时按最合理解释继续。',
    }
  }
  const [dispatchId, dispatch] = found
  const title = clip(input.title, 80)
  const text = clip(input.question, 2000)
  if (!title) return { status: 'error', message: 'title 不能为空：给出一句可扫读的问题标题。' }
  if (!text) return { status: 'error', message: 'question 不能为空：写清要用户裁决什么。' }
  const options = (input.options ?? []).map((option) => clip(option, 120)).filter(Boolean).slice(0, 8)
  const blocking = input.blocking === true
  const now = Date.now()
  const questionId = newId('q')
  const record: Question = {
    dispatchId,
    ...(dispatch.groupId ? { groupId: dispatch.groupId } : {}),
    ...(dispatch.topicSetId ? { topicSetId: dispatch.topicSetId } : {}),
    branchSessionId,
    ...(dispatch.hubSessionId ? { hubSessionId: dispatch.hubSessionId } : {}),
    branchTask: clip(dispatch.task, 200),
    title,
    question: text,
    options,
    severity: normalizeSeverity(input.severity),
    blocking,
    progress: clip(input.progress, 1500),
    defaultPlan: clip(input.defaultPlan, 1000),
    status: 'open',
    createdAt: now,
    updatedAt: now,
  }
  await table.put(questionId, record)
  return {
    status: 'recorded',
    questionId,
    dispatchId,
    blocking,
    message: blocking
      ? `已上交中枢（${questionId}）。这是阻塞问题：中枢汇总所有分支的问题后一次性向用户提问。`
        + '请结束本轮并在汇报里写清已完成的进度与默认备选方案，不要在本分支里等待用户。'
      : `已上交中枢（${questionId}）。blocking=false：不要等待用户，继续按最合理解释推进并完成实质工作，把做出的假设写进最终汇报。`,
  }
}

/** Mark questions resolved, optionally recording the user's answer. */
export async function resolveQuestions(
  store: Store,
  ids: readonly string[],
  answer?: string,
): Promise<number> {
  const table = questionsOf(store)
  if (!table) return 0
  let resolved = 0
  const takenAnswer = clip(answer, 2000)
  for (const id of ids) {
    const row = table.get(id)
    if (!row || row.status === 'resolved') continue
    await table.update(id, (record) => ({
      ...record,
      status: 'resolved',
      ...(takenAnswer ? { answer: takenAnswer } : {}),
      updatedAt: Date.now(),
    }))
    resolved++
  }
  return resolved
}

/** One rendered line block per question, shared by relays and the hub listing. */
function questionLines(question: Question): string[] {
  const tag = question.blocking ? '[阻塞]' : '[非阻塞]'
  const lines = [`- ${tag} ${question.title}：${question.question}`]
  if (question.options.length > 0) lines.push(`  可选：${question.options.join(' / ')}`)
  if (question.progress) lines.push(`  已完成：${question.progress}`)
  if (question.defaultPlan) lines.push(`  默认备选：${question.defaultPlan}`)
  return lines
}

/**
 * The relay block a hub sees after a dispatch/group settles. Empty when the
 * branch raised nothing, so existing relay texts stay byte-identical.
 */
export function renderQuestionsBlock(
  questions: readonly Question[],
  title = '本分支上交的问题（中枢汇总后统一向用户提问）：',
): string {
  if (questions.length === 0) return ''
  const blocking = questions.filter((question) => question.blocking).length
  const lines = [`[supermemory-questions] ${title} 共 ${questions.length} 个（阻塞 ${blocking} / 非阻塞 ${questions.length - blocking}）。`]
  for (const question of questions) lines.push(...questionLines(question))
  lines.push('请中枢调用 memory_questions 汇总所有分支的问题，用 ask_user_question 一次向用户提问；不要逐个转发。')
  return lines.join('\n')
}

/** Hub-facing listing rows of `memory_questions`, including the source branch. */
export function renderQuestionList(rows: readonly QuestionRow[]): string {
  if (rows.length === 0) return '（当前工作区没有待处理的已上交问题）'
  const blocking = rows.filter((row) => row.question.blocking).length
  const lines = [`待处理问题 ${rows.length} 个（阻塞 ${blocking} / 非阻塞 ${rows.length - blocking}）：`]
  for (const row of rows) {
    const question = row.question
    const task = question.branchTask ? ` · 分支任务「${question.branchTask.slice(0, 40)}」` : ''
    lines.push(`${question.blocking ? '⛔' : '•'} ${question.title}（${question.branchSessionId}${task}）`)
    lines.push(`  ${question.question}`)
    if (question.options.length > 0) lines.push(`  可选：${question.options.join(' / ')}`)
    if (question.progress) lines.push(`  已完成：${question.progress}`)
    if (question.defaultPlan) lines.push(`  默认备选：${question.defaultPlan}`)
    if (question.severity !== 'medium') lines.push(`  严重度：${question.severity}`)
  }
  lines.push('请去重、按主题合并后，用一次 ask_user_question 向用户提问；用户答复后把裁决派回对应分支（memory_dispatch）。')
  return lines.join('\n')
}
