/**
 * 中断任务保留与续跑（需求 E）。
 *
 * 插件被中断/关闭（fiber 销毁、插件禁用、DSH 退出）时：分支会话的持久日志保留，
 * 在途派发由 observe 的兜底结算标记为 interrupted（需求 D）。本模块回答恢复
 * 之后的两个问题——「哪些任务被中断了」（清单）与「用户决定继续哪些」（续跑）。
 *
 * 续跑优先续接被保留的分支会话：宿主 agents 服务支持 get（存活 agent）与
 * resume({resumeSessionId})（重载持久会话后续投，dsh-agent AgentRegistry），
 * 两者保持同一会话与同一段日志；只有会话无法恢复时才带「原始任务 + 已完成部分」
 * 上下文重派发到新分支（mode=new），台账用 resumeOf/resumedBy 双向关联
 * 原 dispatchId（均为可选字段，存储域保持 v1 兼容）。
 *
 * 启动检查结果经既有 relay 通道主动触达 hub：deliverRelay（observe 的
 * at-least-once 投递）把清单送进 hub 会话；hub 不在线则落 outbox pending，由
 * flushObserve 自愈重投。memory_resume 工具与 /memory resume 命令随时可查。
 * @module supermemory/resume
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage, createUserMessage as CreateUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEventLike } from './events.ts'
import { branchHandles, compositionSetup, hubComposition, runDispatch } from './dispatch.ts'
import { deliverRelay, type ObserveConfig, type ObserveDeps } from './observe.ts'
import { resolveCapabilities, type CapabilityProfile } from './capabilities.ts'
import { isOpenDispatch, relativeAgo, taskExcerpt } from './hub-branches.ts'
import { branchTagsFor, branchTitleFor } from './branch-meta.ts'
import type { Dispatch } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { updateMember } from './topicsets.ts'
import { loadHostModule } from './host.ts'
import { dispatchSource } from './chat-card.ts'
import { sessionTitleOf } from './title.ts'

export interface ResumeDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

/** One interrupted dispatch as the user picks from it. */
export interface InterruptedDispatchView {
  dispatchId: string
  topicSetId?: string
  topicSetTitle?: string
  task: string
  branchSessionId: string
  /** 分支标题（话题集成员名），缺省时用任务摘要。 */
  branchTitle: string
  hubSessionId: string
  status: Dispatch['status']
  /** 中断时刻：心跳停止的时间（lastActivityAt ?? updatedAt）。 */
  interruptedAt: number
  /** 已完成部分（来自中断回执摘要，可能为空）。 */
  partial: string
  groupId?: string
  /** 本任务是哪个中断任务的续跑（链式续跑时可见）。 */
  resumeOf?: string
}

/** Options of listInterruptedDispatches. */
export interface ListInterruptedOptions {
  /** Clock override for tests. */
  now?: number
  /** Workspace scope (tool/command layer); omitted = every workspace. */
  workspaceKey?: string
}

/** Options of resumeDispatch. */
export interface ResumeOptions {
  /** 调用方（中枢）agent：续跑派发的 relay 目标与组合信息来源。 */
  exec?: { agent?: { id?: string; session?: { header?: { cwd?: string } } } }
  /** 续跑分支的能力边界（默认 read-write，与 memory_dispatch 一致）。 */
  capabilities?: CapabilityProfile | string
  /** 测试/定制缝：重派发路径（默认 runDispatch mode=new）。 */
  redispatch?: (task: string) => Promise<{ status: string; dispatchId?: string; branchSessionId?: string; message?: string }>
  /** 测试缝：宿主消息工厂（默认经 host 锚加载 @deepseek-ai/dsh-llm）。 */
  createMessage?: typeof CreateUserMessage
}

/** Outcome of one resume (a receipt value, never a thrown exception). */
export interface ResumeResult {
  status: 'resumed' | 'error'
  /** 原（被中断）dispatchId。 */
  dispatchId: string
  /** continued=续接被保留会话；redispatched=带上下文重派发新分支。 */
  mode?: 'continued' | 'redispatched'
  newDispatchId?: string
  branchSessionId?: string
  message: string
}

/** Per-hub notice dedupe state (signature = 清单内容指纹)。 */
export interface NotifyState {
  signatures: Map<string, string>
}

/**
 * turnEndReason 中「被外力打断」的签名（区别于 max-tokens / dispatch-error 等
 * 自主失败）：分支终态 aborted（重载/禁用杀掉在途 turn）、branch-died（重启后
 * 分支消失）、中断巡检的 silent/重载/卸载/退出 文案。
 */
const CUT_OFF_REASON = /abort|branch-died|interrupt|silent|重载|卸载|退出/i

/** 默认中断判定时长（与 observe.interruptAfterMs 配置默认值一致）。 */
export const DEFAULT_INTERRUPT_AFTER_MS = 900000

/** True when a dispatch was cut off by an interruption (not an honest failure). */
export function isCutOffDispatch(record: Pick<Dispatch, 'status' | 'turnEndReason'>): boolean {
  if (record.status === 'interrupted') return true
  if (record.status === 'failed') return CUT_OFF_REASON.test(record.turnEndReason ?? '')
  return false
}

/**
 * Whether a resume successor actually replaced the original interruption.
 *
 * A still-running, delivered, or itself-cut-off successor owns the work now
 * (a cut-off successor appears in the list with its own `resumeOf` row). An
 * honest failure of the resume itself — `resume-wake-failed`, a dispatch error,
 * max-tokens — is NOT a takeover: the original must stay actionable so the user
 * can retry it instead of the task silently disappearing from the list.
 */
function successorSupersedes(next: Dispatch | undefined): boolean {
  if (!next) return false
  if (isOpenDispatch(next)) return true
  if (next.status === 'delivered') return true
  return isCutOffDispatch(next)
}

/** 已完成部分摘要：从中断回执（outbox dlv-<dispatchId>）里摘出。 */
function partialOfOutbox(store: Store, dispatchId: string): string {
  const payload = store.outbox.get('dlv-' + dispatchId)?.payload ?? ''
  const at = payload.indexOf('已完成部分：')
  if (at < 0) return ''
  const rest = payload.slice(at + '已完成部分：'.length)
  const line = rest.split('\n')[0] ?? ''
  return line.trim()
}

/** 分支视角（成员标题 → 任务摘要）。 */
function viewOf(store: Store, dispatchId: string, record: Dispatch): InterruptedDispatchView {
  const topicSet = record.topicSetId ? store.topicsets.get(record.topicSetId) : undefined
  const member = topicSet?.members.find((row) => row.sessionId === record.branchSessionId)
  const view: InterruptedDispatchView = {
    dispatchId,
    task: record.task,
    branchSessionId: record.branchSessionId,
    branchTitle: (member?.title ?? '').trim() || taskExcerpt(record.task, 20),
    hubSessionId: record.hubSessionId,
    status: record.status,
    interruptedAt: record.lastActivityAt ?? record.updatedAt,
    partial: partialOfOutbox(store, dispatchId),
  }
  if (record.topicSetId) view.topicSetId = record.topicSetId
  if (topicSet) view.topicSetTitle = topicSet.title
  if (record.groupId) view.groupId = record.groupId
  if (record.resumeOf) view.resumeOf = record.resumeOf
  return view
}

/**
 * 扫描台账，列出被中断且未终态完成的派发（需求：恢复后自动检查）。
 *
 * 收录两类「可证明被打断」的行：status=interrupted（静默巡检/dispose 兜底标记），
 * 以及 failed 且终态原因是打断签名（重载杀掉在途 turn → aborted、重启后分支消失
 * → branch-died）。已交付、自主失败（max-tokens/派发异常）与已被续跑接替的行
 * 都不出现——它们不是待决项。续跑接替的判定不能只看「续跑仍在途」：续跑完成
 * （delivered）后原派发必须一直保持隐藏，否则清单和中断提醒会永远重复列出它。
 * 同时扫描两个方向（原派发的 resumedBy、后继的 resumeOf），历史数据即使只写了
 * 单边关联也能被正确过滤，无需迁移。
 */
export function listInterruptedDispatches(store: Store, options: ListInterruptedOptions = {}): InterruptedDispatchView[] {
  // Reverse-link index: covers ledgers where the original never got resumedBy
  // (crash between the successor put and the original update) or older data.
  const superseded = new Set<string>()
  for (const [, candidate] of store.dispatches.entries()) {
    if (candidate.resumeOf && successorSupersedes(candidate)) superseded.add(candidate.resumeOf)
  }
  const out: InterruptedDispatchView[] = []
  for (const [dispatchId, record] of store.dispatches.entries()) {
    if (!record.branchSessionId) continue
    if (!isCutOffDispatch(record)) continue
    const topicSet = record.topicSetId ? store.topicsets.get(record.topicSetId) : undefined
    if (options.workspaceKey && topicSet?.workspaceKey !== options.workspaceKey) continue
    // Forward link: the successor took over (running/delivered/again cut off),
    // so this row is no longer the pending item the user should resume.
    if (record.resumedBy && successorSupersedes(store.dispatches.get(record.resumedBy))) continue
    if (superseded.has(dispatchId)) continue
    out.push(viewOf(store, dispatchId, record))
  }
  out.sort((a, b) => b.interruptedAt - a.interruptedAt)
  return out
}

/** 清单的用户可读文本（工具 message / 命令输出共用）。 */
export function renderInterruptedList(views: readonly InterruptedDispatchView[], now = Date.now()): string {
  if (views.length === 0) return '没有被中断的任务。'
  const lines = ['被中断的任务清单（' + views.length + '，分支会话已保留，可选择继续）：']
  views.forEach((view, index) => {
    lines.push(index + 1 + '. ' + view.dispatchId + ' · 话题集「' + (view.topicSetTitle ?? '（未命名）') + '」'
      + ' · 任务：' + taskExcerpt(view.task, 40)
      + ' · 分支 ' + view.branchSessionId + '（' + view.branchTitle + '）'
      + ' · 中断于 ' + relativeAgo(view.interruptedAt, now)
      + (view.groupId ? ' · 原属并行组 ' + view.groupId : '')
      + (view.resumeOf ? ' · 续跑自 ' + view.resumeOf : ''))
    if (view.partial) lines.push('   已完成部分：' + view.partial.slice(0, 160))
  })
  lines.push('用 memory_resume 带 dispatchId 续跑（可多选），或 /memory resume <dispatchId>。')
  return lines.join('\n')
}

/** Process-cached createUserMessage (loaded through the host anchor). */
let sharedFactory: typeof CreateUserMessage | undefined
async function messageFactory(): Promise<typeof CreateUserMessage> {
  if (!sharedFactory) {
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    sharedFactory = llm.createUserMessage as typeof CreateUserMessage
  }
  return sharedFactory
}

/** Read one session's durable log range through the persistence seam. */
async function coldRead(ctx: Context, sessionId: string, afterSeq: number): Promise<SessionEventLike[]> {
  const persistence = ctx.sessionPersistence as unknown as {
    open(id: string, access: 'read'): Promise<{
      read(offset?: number, length?: number): Promise<{ events: SessionEventLike[] }>
      close(): Promise<void>
    }>
  }
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(afterSeq + 1)
    return events
  } finally {
    await handle.close()
  }
}

/** Last assistant text of a log range (the branch's freshest work-in-progress). */
function lastAssistantText(events: readonly SessionEventLike[]): string {
  let text = ''
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
    const block = (data.message?.content ?? [])
      .map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
      .filter(Boolean).join('\n').trim()
    if (block) text = block
  }
  return text
}

/**
 * 续跑消息里的「已完成部分」：优先冷读分支日志（最新），失败时退回中断回执摘要。
 */
async function partialOfBranch(deps: ResumeDeps, dispatchId: string, record: Dispatch): Promise<string> {
  const persistence = (deps.ctx as unknown as { sessionPersistence?: unknown }).sessionPersistence
  if (persistence && record.branchSessionId) {
    try {
      const text = lastAssistantText(await coldRead(deps.ctx, record.branchSessionId, record.startSeq))
      if (text) return text.length > 1500 ? text.slice(0, 1500) + '…' : text
    } catch { /* persistence unreadable: fall back to the relay summary */ }
  }
  return partialOfOutbox(deps.store, dispatchId)
}

/** The wake message of a same-session continuation. */
function resumeMessage(originalId: string, record: Dispatch, partial: string, hubSessionId: string): string {
  const group = record.groupId
    ? '\n原任务来自并行组 ' + record.groupId + '（组汇总已另行交付），本次为单独续跑。'
    : ''
  // R30 需求⑥: 续跑消息同样点名中枢会话——relay 回送目标就是它（派发记录
  // hubSessionId 与调用方 agent id 一致时才续跑，见 resumeDispatch）。
  const hub = hubSessionId
    ? '\n中枢会话：' + hubSessionId + '（完成后结果经既有 relay 通道送回该会话）。'
    : ''
  return '[supermemory-resume ' + originalId + ']'
    + '\n本消息是被中断任务的续跑（原派发 ' + originalId + '，原分支 ' + record.branchSessionId + '）。' + group
    + hub
    + '\n原始任务：' + record.task
    + '\n已完成部分：' + (partial || '（无记录）')
    + '\n请先核对以上已完成部分与分支日志中已有的工作，再继续未完成的事项；不要从头重复已完成的工作。'
    + '\n遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。'
}

/** The re-dispatched task text (original task + continuation context). */
function redispatchTask(record: Dispatch, originalId: string, partial: string): string {
  const group = record.groupId ? '（原任务来自并行组 ' + record.groupId + '，组汇总已另行交付）' : ''
  return record.task
    + '\n\n【续跑上下文' + group + '】本任务此前被中断（原派发 ' + originalId + '，原分支 '
    + record.branchSessionId + '，原因：插件重载/关闭或 DSH 退出；分支会话已保留但无法续接）。'
    + '已完成部分：' + (partial || '（无记录）')
    + '。请先核对已完成部分再继续未完成的工作，不要从头重复。'
    + '遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。'
}

/** 台账双向关联：新派发 resumeOf=原派发，原派发 resumedBy=新派发。 */
async function linkResume(store: Store, originalId: string, newDispatchId: string): Promise<void> {
  const now = Date.now()
  if (store.dispatches.get(newDispatchId)) {
    await store.dispatches.update(newDispatchId, (row) => ({ ...row, resumeOf: originalId, updatedAt: now }))
  }
  await store.dispatches.update(originalId, (row) => ({ ...row, resumedBy: newDispatchId, updatedAt: now }))
}

/**
 * 续跑一个被中断的派发（需求：由用户决定哪些任务需要继续）。
 *
 * 顺序：优先续接被保留的分支会话（live handle → agents.get → agents.resume），
 * 续投「原始任务 + 已完成部分」；三条路都拿不到会话时才带同样上下文重派发到
 * 新分支。任何路径都会产生一个新派发行并通过 resumeOf/resumedBy 关联原派发，
 * 续跑完成后由既有 relay 通道把结果送回调用方（中枢）会话。
 */
export async function resumeDispatch(
  deps: ResumeDeps,
  dispatchId: string,
  options: ResumeOptions = {},
): Promise<ResumeResult> {
  const { ctx, store, logger } = deps
  const record = store.dispatches.get(dispatchId)
  if (!record) return { status: 'error', dispatchId, message: '派发 ' + dispatchId + ' 不存在。' }
  if (!record.branchSessionId) {
    return { status: 'error', dispatchId, message: '派发 ' + dispatchId + ' 没有分支会话记录（派发即失败），无需续跑。' }
  }
  if (record.status === 'delivered') {
    return { status: 'error', dispatchId, message: '派发 ' + dispatchId + ' 已交付，无需续跑。' }
  }
  if (!isCutOffDispatch(record)) {
    if (isOpenDispatch(record)) {
      return {
        status: 'error', dispatchId,
        message: '派发 ' + dispatchId + ' 仍在进行中（' + record.status + '），无需续跑；'
          + '若确认分支已死，等待中断巡检（默认 ' + Math.round(DEFAULT_INTERRUPT_AFTER_MS / 60000) + ' 分钟）标记后再续跑。',
      }
    }
    return { status: 'error', dispatchId, message: '派发 ' + dispatchId + '（' + record.status + '）不是被中断的任务。' }
  }
  if (record.resumedBy) {
    const next = store.dispatches.get(record.resumedBy)
    if (next && successorSupersedes(next)) {
      // Running OR already settled by the successor: resuming the original again
      // would duplicate finished work. Only an honest resume failure leaves the
      // original actionable.
      return {
        status: 'error', dispatchId,
        message: '该任务已有续跑' + (isOpenDispatch(next) ? '在进行' : '接替') + '（' + record.resumedBy + '）。',
      }
    }
  }
  const hubSessionId = String(options.exec?.agent?.id ?? record.hubSessionId)
  if (!hubSessionId) return { status: 'error', dispatchId, message: '无法确定中枢会话（续跑结果无处回送）。' }

  const capabilities = resolveCapabilities(options.capabilities)
  const partial = await partialOfBranch(deps, dispatchId, record)

  // ---- 1. 续接被保留的分支会话 ----
  const held = branchHandles.get(record.branchSessionId)
  let agent: Agent | undefined = held?.agent ?? (ctx.agents.get(record.branchSessionId as never) as Agent | undefined)
  if (!agent) {
    try {
      const composition = hubComposition(ctx, options.exec?.agent)
      const resumed = await ctx.agents.resume({
        resumeSessionId: record.branchSessionId as never,
        setup: compositionSetup(ctx, composition, logger, capabilities),
      })
      agent = resumed.agent
      branchHandles.set(record.branchSessionId, { agent: resumed.agent, dispose: () => resumed.dispose() })
      logger.info('supermemory: resume ' + dispatchId + ': reconnected preserved branch ' + record.branchSessionId.slice(0, 20))
    } catch (error) {
      logger.warn('supermemory: resume ' + dispatchId + ': branch ' + record.branchSessionId.slice(0, 13)
        + ' unrecoverable (' + String(error).slice(0, 140) + '); re-dispatching')
    }
  }

  if (agent) {
    const newDispatchId = newId('dsp')
    const now = Date.now()
    const seqBefore = (ctx.sessions.get(record.branchSessionId as never) as { seq?: number } | undefined)?.seq ?? 0
    await store.dispatches.put(newDispatchId, {
      topicSetId: record.topicSetId,
      branchSessionId: record.branchSessionId,
      task: record.task,
      hubSessionId,
      startSeq: seqBefore,
      status: 'dispatched',
      resumeOf: dispatchId,
      // R33 需求⑦: keep the granted profile on the resumed row (falls back to
      // the profile this resume applied).
      capability: record.capability || capabilities.profile,
      // R30 需求④: 续跑把标题/标签映射带前进（同一分支、同一身份词表）。
      title: record.title || branchTitleFor(record.task),
      tags: record.tags && record.tags.length > 0
        ? [...record.tags]
        : branchTagsFor({
            topicTags: record.topicSetId ? store.topicsets.get(record.topicSetId)?.keywords : undefined,
            task: record.task,
            capability: capabilities.profile,
          }),
      createdAt: now,
      updatedAt: now,
    })
    await store.dispatches.update(dispatchId, (row) => ({ ...row, resumedBy: newDispatchId, updatedAt: now }))
    if (record.topicSetId) {
      try {
        await updateMember(store, record.topicSetId, record.branchSessionId, { status: 'live' })
      } catch { /* membership is best-effort on resume */ }
    }
    try {
      const factory = options.createMessage ?? (await messageFactory())
      // R32 需求③: a resumed dispatch is still a hub→branch request and must use
      // the same card. kind stays 'user' for the R25 recency contract.
      const hubTitle = sessionTitleOf(ctx, store, hubSessionId)
      const topicSetTitle = record.topicSetId ? (store.topicsets.get(record.topicSetId)?.title ?? '') : ''
      agent.followup(factory({
        content: [{ type: 'text', text: resumeMessage(dispatchId, record, partial, hubSessionId) }],
        // R25: 续跑消息也以人类提示形态落账（kind 'user'，不再用 form
        // 'instructions'）：宿主会话列表的 recency 只认 kind 'user'，续跑一条
        // 已存在的分支才能回到列表顶部。归属由 kind 'user' + observe 的首个
        // 匹配扫描保证（与派发输入同一形态）。
        source: dispatchSource({
          fromSessionId: hubSessionId,
          ...(hubTitle ? { fromTitle: hubTitle } : {}),
          task: record.task,
          ...(topicSetTitle ? { topicSetTitle } : {}),
          capability: capabilities.profile,
          dispatchId: newDispatchId,
          status: 'dispatched',
        }) as never,
      }) as UserMessage)
      const seqAfter = (ctx.sessions.get(record.branchSessionId as never) as { seq?: number } | undefined)?.seq ?? seqBefore
      if (seqAfter > seqBefore) {
        await store.dispatches.update(newDispatchId, (row) => ({ ...row, startSeq: seqBefore, updatedAt: Date.now() }))
      }
      logger.info('supermemory: resume ' + dispatchId + ' → ' + newDispatchId + ' (continued on ' + record.branchSessionId.slice(0, 13) + ')')
      return {
        status: 'resumed', dispatchId, mode: 'continued', newDispatchId,
        branchSessionId: record.branchSessionId,
        message: '已续接被保留的分支 ' + record.branchSessionId + ' 继续任务（新派发 ' + newDispatchId
          + '）；完成后结果会主动送回本会话。',
      }
    } catch (error) {
      await store.dispatches.update(newDispatchId, (row) => ({
        ...row, status: 'failed', turnEndReason: 'resume-wake-failed', updatedAt: Date.now(),
      }))
      logger.warn('supermemory: resume ' + dispatchId + ' followup threw: ' + String(error).slice(0, 200))
      return {
        status: 'error', dispatchId, newDispatchId,
        message: '分支唤醒失败：' + String(error).slice(0, 200),
      }
    }
  }

  // ---- 2. 会话无法恢复：带上下文重派发到新分支 ----
  const redispatch = options.redispatch ?? ((task: string) => runDispatch(
    { ctx, store, logger },
    {
      ...(record.topicSetId ? { topicSetId: record.topicSetId } : {}),
      task,
      mode: 'new',
      capabilities: options.capabilities,
    },
    (options.exec ?? {}) as never,
  ))
  try {
    const result = await redispatch(redispatchTask(record, dispatchId, partial))
    if (result.status !== 'dispatched' || !result.dispatchId) {
      return { status: 'error', dispatchId, message: '重派发失败：' + (result.message ?? '未知原因') }
    }
    await linkResume(store, dispatchId, result.dispatchId)
    logger.info('supermemory: resume ' + dispatchId + ' → ' + result.dispatchId + ' (re-dispatched to a fresh branch)')
    return {
      status: 'resumed', dispatchId, mode: 'redispatched', newDispatchId: result.dispatchId,
      ...(result.branchSessionId ? { branchSessionId: result.branchSessionId } : {}),
      message: '原分支无法恢复，已带「原始任务 + 已完成部分」上下文重派发到新分支（新派发 ' + result.dispatchId
        + '）；完成后结果会主动送回本会话。',
    }
  } catch (error) {
    logger.warn('supermemory: resume ' + dispatchId + ' re-dispatch threw: ' + String(error).slice(0, 200))
    return { status: 'error', dispatchId, message: '重派发异常：' + String(error).slice(0, 200) }
  }
}

/**
 * 一批中断公告的稳定短键（同一批派发集合 → 同一键）。
 *
 * 只用确定性字符串散列（FNV-1a，base36）：不引入 crypto 依赖，键长短固定，
 * 足够把不同批次（新中断加入）区分开——它们的 outbox 行因此互不覆盖，
 * hub 不在线时各自 pending 自愈。
 */
function noticeBatchKey(signature: string): string {
  let hash = 0x811c9dc5
  const text = String(signature ?? '')
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * 启动/巡检时的中断清单主动触达（复用 observe 的 at-least-once relay 通道）。
 *
 * R42（relay 重复投递修复）：公告是**持久增量**——每条派发只在第一次进入清单时
 * 被公告一次（`dispatches.interruptNoticedAt` 落库标记），重载后签名表清空、
 * 清单刷新（新中断加入）都不会把已公告过的任务重新整批送来。旧的实现只有内存
 * 签名去重：插件每次重载后同一批中断任务会被再送达一次（真实 ledger 里同一个
 * hub 存在多条 dlv-resume-* 行，多条 pending 从未确认）。
 *
 * 幂等键按批次稳定：`dlv-resume-<hub>-<签名摘要>`。同一批（相同派发集合）重复
 * 触发时键相同 → deliver 的持久守卫直接跳过；不同批（新中断加入）键不同 →
 * 各自一行，hub 不在线时都可 pending 自愈，互不覆盖。
 */
export async function notifyInterruptedDispatches(
  deps: ResumeDeps & { config?: ObserveConfig },
  options: { now?: number; state?: NotifyState } = {},
): Promise<number> {
  const { ctx, store, logger } = deps
  const now = options.now ?? Date.now()
  // 持久增量：只取从未公告过的派发（interruptNoticedAt 未设置）。
  const pending = listInterruptedDispatches(store, { now })
    .filter((view) => !store.dispatches.get(view.dispatchId)?.interruptNoticedAt)
  const byHub = new Map<string, InterruptedDispatchView[]>()
  for (const view of pending) {
    const bucket = byHub.get(view.hubSessionId) ?? []
    bucket.push(view)
    byHub.set(view.hubSessionId, bucket)
  }
  let notified = 0
  for (const [hubSessionId, rows] of byHub) {
    const signature = rows.map((row) => row.dispatchId + '@' + row.interruptedAt).join('|')
    if (options.state) {
      if (options.state.signatures.get(hubSessionId) === signature) continue
      options.state.signatures.set(hubSessionId, signature)
    }
    const text = '[SuperMemory] 检测到 ' + rows.length + ' 个被中断的任务'
      + '（插件重载/关闭或 DSH 退出导致；分支会话已保留，可选择继续）：\n'
      + rows.map((row, index) => index + 1 + '. ' + row.dispatchId
        + ' · 话题集「' + (row.topicSetTitle ?? '（未命名）') + '」'
        + ' · 任务：' + taskExcerpt(row.task, 40)
        + ' · 分支 ' + row.branchSessionId
        + ' · 中断于 ' + relativeAgo(row.interruptedAt, now)
        + (row.partial ? '\n   已完成部分：' + row.partial.slice(0, 120) : '')).join('\n')
      + '\n\n用 memory_resume 查看并续跑（无参=清单；带 dispatchId=继续指定任务，可多选），或 /memory resume <dispatchId>。'
    try {
      // deliverRelay 只消费 ctx/store/logger（config 不参与投递），这里结构上转过去。
      await deliverRelay(deps as ObserveDeps, {
        deliveryId: 'dlv-resume-' + hubSessionId + '-' + noticeBatchKey(signature),
        dispatchId: rows[0].dispatchId,
        hubSessionId,
        text,
        // R32 需求③: this notice is about the whole hub, not one branch.
        fromKind: 'system',
        fromTitle: 'SuperMemory 中断巡检',
      })
      notified += 1
      // 持久增量标记：这一批从此不再公告（重载/清单刷新都跳过）。
      const stampedAt = Date.now()
      for (const row of rows) {
        try {
          await store.dispatches.update(row.dispatchId, (r) => (
            r.interruptNoticedAt ? r : { ...r, interruptNoticedAt: stampedAt }
          ))
        } catch { /* 标记失败不影响本次投递；下一批会自然重试 */ }
      }
      logger.info('supermemory: interrupted notice sent for hub ' + hubSessionId.slice(0, 13) + ' (' + rows.length + ' task(s))')
    } catch (error) {
      logger.warn('supermemory: interrupted notice for ' + hubSessionId.slice(0, 13)
        + ' failed: ' + String(error).slice(0, 160))
    }
  }
  return notified
}
