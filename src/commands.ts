/**
 * Slash commands: the `/memory` family (§5). Command names are lowercase
 * without the leading slash; sub-arguments arrive verbatim in
 * `invocation.rawInput` and are parsed by the handler.
 * @module supermemory/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { getRouting, getTopicSet, listTopicSets, setRouting, touchTopicSet, createTopicSet, updateTopicSetSummary } from './topicsets.ts'
import { renderCard } from './route.ts'
import type { ModelDeps } from './model.ts'
import { askDefaultModel, applyModelSelection } from './model.ts'
import { openRequirements } from './requirements.ts'

export interface CommandsDeps {
  ctx: Context
  store: Store | undefined
  model: ModelDeps
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  workspaceKeyOfCwd: (cwd: string | undefined) => string
}

type Result = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** Attach the /memory command; returns the effect disposer. */
export function attachCommands(ctx: Context, deps: CommandsDeps): () => void {
  return ctx.commands.register({
    name: 'memory',
    description: 'SuperMemory：/memory status 状态、topicsets 话题集、switch 切换、new 新建、reqs 需求、scan 扫描、export 导出、wrap 小结、model 模型',
    handler: async (invocation): Promise<Result> => {
      const store = deps.store
      if (!store) return { kind: 'error', text: 'SuperMemory 存储域未打开，记忆功能不可用。' }
      const raw = (invocation.rawInput ?? '').trim()
      const [sub, ...rest] = raw.split(/\s+/)
      const arg = rest.join(' ').trim()
      const agent = invocation.agent as { id?: string; session?: { header?: { cwd?: string } } } | undefined
      const sessionId = String(agent?.id ?? '')
      const workspaceKey = deps.workspaceKeyOfCwd(agent?.session?.header?.cwd)

      switch (sub ?? '') {
        case '':
        case 'status':
          return statusText(deps, sessionId, workspaceKey)
        case 'help':
          return { kind: 'success', text: HELP }
        case 'topicsets':
          return topicsetsText(store, workspaceKey)
        case 'switch': {
          if (!arg) return { kind: 'error', text: '用法：/memory switch <话题集名>' }
          const found = listTopicSets(store, workspaceKey).find(([, t]) => t.title === arg || t.title.includes(arg))
          if (!found) return { kind: 'error', text: `未找到话题集『${arg}』。` }
          await setRouting(store, sessionId, { activeTopicSetId: found[0], driftCount: 0 })
          await touchTopicSet(store, found[0])
          return { kind: 'success', text: `已激活话题集『${found[1].title}』。\n${renderCard(found[1])}` }
        }
        case 'new': {
          if (!arg) return { kind: 'error', text: '用法：/memory new <标题>' }
          const model = await askDefaultModel(deps.model, agent)
          const id = await createTopicSet(store, { workspaceKey, title: arg.slice(0, 40), ...(model ? { defaultModel: model } : {}) })
          await setRouting(store, sessionId, { activeTopicSetId: id, driftCount: 0 })
          return {
            kind: 'success',
            text: `已创建并激活话题集『${arg.slice(0, 40)}』${model ? `（默认模型 ${model.provider}/${model.model}）` : ''}`,
          }
        }
        case 'model': {
          if (!arg) {
            const active = getRouting(store, sessionId)?.activeTopicSetId
            const topicSet = active ? getTopicSet(store, active) : undefined
            const lines = topicSet?.defaultModel
              ? [`当前话题集默认模型：${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}`]
              : ['当前话题集未设置默认模型（跟随分支创建时的选择）。']
            for (const m of topicSet?.members ?? []) {
              lines.push(`- ${m.title || m.sessionId}：${m.model ?? '默认'}${m.modelOverridden ? '（覆盖）' : ''}`)
            }
            lines.push('用法：/memory model <provider> <model> [effort]（按话题集）或 /memory model branch <sessionId> <provider> <model>')
            return { kind: 'success', text: lines.join('\n') }
          }
          const parts = arg.split(/\s+/)
          if (parts[0] === 'branch' && parts.length >= 4) {
            const result = await applyModelSelection(deps.model, { branchSessionId: parts[1] }, {
              provider: parts[2], model: parts[3], ...(parts[4] ? { reasoningEffort: parts[4] } : {}),
            })
            return result.applied
              ? { kind: 'success', text: `已覆盖分支 ${parts[1]} 的模型为 ${parts[2]}/${parts[3]}${result.live ? '' : '（分支不在线，已记录，恢复后生效）'}` }
              : { kind: 'error', text: '未找到该分支。' }
          }
          if (parts.length >= 2) {
            const active = getRouting(store, sessionId)?.activeTopicSetId
            if (!active) return { kind: 'error', text: '当前没有激活的话题集。' }
            const result = await applyModelSelection(deps.model, { topicSetId: active }, {
              provider: parts[0], model: parts[1], ...(parts[2] ? { reasoningEffort: parts[2] } : {}),
            })
            return { kind: 'success', text: `已设置默认模型 ${parts[0]}/${parts[1]}${result.live ? '（已应用到在线分支）' : ''}` }
          }
          return { kind: 'error', text: '用法：/memory model <provider> <model> [effort]' }
        }
        case 'reqs': {
          const open: string[] = []
          for (const [, record] of store.requirements.entries()) {
            if (record.workspaceKey === workspaceKey && record.status === 'open') open.push(`- ${record.text}`)
          }
          return { kind: 'success', text: open.length ? `未完成需求：\n${open.join('\n')}` : '（暂无未完成需求）' }
        }
        case 'scan': {
          const { scanWorkspace, filemapEntries } = await import('./filemap.ts')
          const cwd = agent?.session?.header?.cwd
          if (!cwd) return { kind: 'error', text: '无法确定当前工作区。' }
          const result = await scanWorkspace(store, cwd)
          const total = filemapEntries(store, workspaceKey).length
          return {
            kind: 'success',
            text: `项目地图扫描完成：扫描 ${result.scanned} 个文件，新增 ${result.added}，失效/更新 ${result.stale}，当前共 ${total} 条。`,
          }
        }
        case 'export': {
          const { writeFileSync } = await import('node:fs')
          const { filemapEntries } = await import('./filemap.ts')
          const { listTopicSets: list, getTopicSet: getTs } = await import('./topicsets.ts')
          const active = getRouting(store, sessionId)?.activeTopicSetId
          const topicSet = active ? getTs(store, active) : undefined
          const lines: string[] = ['# SuperMemory 导出', '']
          if (topicSet) {
            lines.push(`## 话题集：${topicSet.title}`, '', topicSet.summary || '（暂无梗概）', '')
          }
          const mems: string[] = []
          for (const [, record] of store.memories.entries()) {
            if (record.workspaceKey === workspaceKey && record.status === 'active') mems.push(`- ${record.text}`)
          }
          if (mems.length) lines.push('## 事实记忆', '', ...mems, '')
          const reqs = openRequirements(store, workspaceKey)
          if (reqs.length) lines.push('## 未完成需求', '', ...reqs.map(([, r]) => `- ${r.text}`), '')
          const eps: string[] = []
          for (const [, episode] of store.episodes.entries()) {
            if (episode.summary) eps.push(`- ${episode.summary}`)
          }
          if (eps.length) lines.push('## 归档梗概', '', ...eps.slice(-20), '')
          const files = filemapEntries(store, workspaceKey)
          if (files.length) {
            lines.push('## 项目文件地图', '')
            for (const [, entry] of files) lines.push(`- \`${entry.path}\` — ${entry.role}${entry.summary ? '：' + entry.summary : ''}`)
            lines.push('')
          }
          const target = `${cwdFor(agent)}/.supermemory-export.md`
          writeFileSync(target, lines.join('\n'), 'utf8')
          return { kind: 'success', text: `已导出到 ${target}（${mems.length} 条记忆、${reqs.length} 条需求、${files.length} 个文件条目）。` }
        }
        case 'wrap': {
          const active = getRouting(store, sessionId)?.activeTopicSetId
          if (!active) return { kind: 'error', text: '当前没有激活的话题集。' }
          const topicSet = getTopicSet(store, active)
          if (!topicSet) return { kind: 'error', text: '话题集不存在。' }
          const bits: string[] = []
          if (topicSet.summary) bits.push(topicSet.summary)
          for (const [, episode] of store.episodes.entries()) {
            if (episode.topicSetId === active && episode.summary) bits.push(episode.summary.slice(0, 120))
          }
          const summary = bits.slice(-6).join(' / ').slice(0, 500)
          await updateTopicSetSummary(store, active, summary || topicSet.summary)
          return { kind: 'success', text: `已更新话题集梗概：\n${summary || '（暂无素材）'}` }
        }
        default:
          return { kind: 'error', text: `未知子命令 /memory ${sub}；可用：${HELP}` }
      }
    },
  })
}

const HELP = 'status 状态总览 · topicsets 话题集列表 · switch <名> 激活 · new <标题> 新建 · '
  + 'model 模型管理 · reqs 需求 · wrap 更新梗概 · scan/export（P2）'

function statusText(deps: CommandsDeps, sessionId: string, workspaceKey: string): Result {
  const store = deps.store!
  let memories = 0
  let ownMemories = 0
  let episodes = 0
  let requirements = 0
  let signals = 0
  for (const [, record] of store.memories.entries()) {
    memories++
    if (record.workspaceKey === workspaceKey && record.status === 'active') ownMemories++
  }
  episodes = store.episodes.size
  for (const [, record] of store.requirements.entries()) {
    if (record.workspaceKey === workspaceKey && record.status === 'open') requirements++
  }
  for (const [, record] of store.signals.entries()) {
    if (record.workspaceKey === workspaceKey) signals++
  }
  const hot = store.hotcache.get(sessionId)
  const cursor = hot?.lastMaintainedSeq !== undefined ? String(hot.lastMaintainedSeq) : '无'
  const active = getRouting(store, sessionId)?.activeTopicSetId
  const topicSet = active ? getTopicSet(store, active) : undefined
  const lines = [
    'SuperMemory 状态',
    `- 工作区：${workspaceKey}`,
    `- 活跃话题集：${topicSet ? topicSet.title : '（未激活）'}`,
    `- 事实记忆：${ownMemories} 条（全库 ${memories} 条）`,
    `- 归档梗概：${episodes} 条`,
    `- 未完成需求：${requirements} 条`,
    `- 重复模式信号：${signals} 个`,
    `- 本会话维护游标：${cursor}`,
  ]
  return { kind: 'success', text: lines.join('\n') }
}

/** The session cwd of a command invocation, for file-targeting commands. */
function cwdFor(agent: unknown): string {
  return (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd ?? process.cwd()
}

function topicsetsText(store: Store, workspaceKey: string): Result {  const list = listTopicSets(store, workspaceKey)
  if (list.length === 0) return { kind: 'success', text: '（当前工作区暂无话题集；发送消息时将按需询问新建）' }
  const lines = list.map(([id, t]) => {
    const branches = t.members.map((m) => `${m.title || m.sessionId.slice(0, 8)}(${m.status})`).join('、') || '无分支'
    return `- ${t.title}${t.defaultModel ? ` [${t.defaultModel.provider}/${t.defaultModel.model}]` : ''}\n  ${t.summary || '（暂无梗概）'}\n  分支：${branches}\n  id=${id}`
  })
  return { kind: 'success', text: lines.join('\n') }
}
