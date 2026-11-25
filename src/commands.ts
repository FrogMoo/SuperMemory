/**
 * Slash commands: the `/memory` family (`5). Command names are lowercase
 * without the leading slash; sub-arguments arrive verbatim in
 * `invocation.rawInput` and are parsed by the handler.
 *
 * Every subcommand is ALSO registered as its own command (`/memory-ui`,
 * `/memory-status`, …) so the composer's command picker lists the whole
 * family for quick selection: the registry is flat (name + rawInput) with no
 * subcommand concept, and a space after `/memory` drops the picker.
 * `/memory <sub> <args>` keeps working unchanged.
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
import { listInterruptedDispatches, renderInterruptedList, resumeDispatch } from './resume.ts'
import { fillTopicShapeOnCreate, noteTopicSetActivated } from './topic-shape.ts'
import { TOPIC_SET_TITLE_MAX_CHARS, clipEllipsis, firstLine } from './title.ts'
import { clipMarked } from './clip.ts'
import { migrateTruncatedTitles, renderTitlesMigrationReport } from './title-migration.ts'
import { mergeTopicSets, renderMergeReport } from './topicset-merge.ts'
import { applyMemoryOrganize, previewMemoryOrganize, renderMemoryOrganizeReport } from './memory-organize.ts'

export interface CommandsDeps {
  ctx: Context
  store: Store | undefined
  model: ModelDeps
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  workspaceKeyOfCwd: (cwd: string | undefined) => string
}

type Result = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** Subcommand -> picker description (doubles as the `/memory-<name>` description). */
const SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['ui', '打开 SuperMemory 可视化管理台（返回带令牌链接，侧边栏 browser tab 可直接打开）'],
  ['status', 'SuperMemory 状态总览（工作区、活跃话题集、各类计数、维护游标）'],
  ['topicsets', '列出当前工作区的话题集（标题/梗概/分支/默认模型）'],
  ['switch', '激活话题集：/memory-switch <话题集名>'],
  ['new', '新建话题集：/memory-new <标题>'],
  ['model', '话题集/分支模型管理：/memory-model <provider> <model> [effort]'],
  ['tools', '组合工具管理：/memory-tools 列表；edit <id> <JSON> 修改；desc <id> <文本> 改简介；retire <id> 停用'],
  ['reqs', '列出未完成需求'],
  ['resume', '继续被中断的任务：/memory-resume 查看清单；/memory-resume <dispatchId...> 续跑（可多个）'],
  ['wrap', '更新当前话题集梗概'],
  ['scan', '扫描工作区，刷新项目文件地图'],
  ['export', '导出 .supermemory-export.md 到工作区根目录'],
  ['titles', '补正刷新被旧截断逻辑损坏的话题集/分支标题（dry-run 只预览不写库）'],
  ['merge', '话题集合并治理：/memory-merge [dry-run|apply] [--rename <标题>]（默认 dry-run 不写库；--rename 只改「已有主集」簇的目标标题）'],
  ['organize', '整理记忆集合：/memory-organize [preview|apply]（默认查看整理后状态；preview 只预演不写库）'],
  ['help', '查看 /memory 命令族全部用法'],
]

/** Attach the /memory command family; returns the effect disposer. */
export function attachCommands(ctx: Context, deps: CommandsDeps): () => void {
  const disposers: Array<() => void> = []
  disposers.push(ctx.commands.register({
    name: 'memory',
    description: 'SuperMemory 命令族：ui 可视化管理台 · status 状态 · topicsets 话题集 · switch 激活 · new 新建 · '
      + 'model 模型 · tools 组合工具 · reqs 需求 · resume 续跑中断任务 · wrap 梗概 · scan 扫描 · export 导出（每个子命令也可直接输 /memory-<名> 快速选择）',
    handler: async (invocation): Promise<Result> => {
      const raw = (invocation.rawInput ?? '').trim()
      const [sub, ...rest] = raw.split(/\s+/)
      return runMemory(deps, sub ?? '', rest.join(' ').trim(), invocation)
    },
  }))
  for (const [name, description] of SUBCOMMANDS) {
    disposers.push(ctx.commands.register({
      name: `memory-${name}`,
      description,
      handler: async (invocation): Promise<Result> => runMemory(deps, name, (invocation.rawInput ?? '').trim(), invocation),
    }))
  }
  return () => { for (const dispose of disposers) dispose() }
}

/** The /memory command body, shared by the family command and every sibling. */
async function runMemory(
  deps: CommandsDeps,
  sub: string,
  arg: string,
  invocation: { agent?: { id?: string; session?: { header?: { cwd?: string } } } },
): Promise<Result> {
  const store = deps.store
  if (!store) return { kind: 'error', text: 'SuperMemory 存储域未打开，记忆功能不可用。' }
  const agent = invocation.agent as { id?: string; session?: { header?: { cwd?: string } } } | undefined
  const sessionId = String(agent?.id ?? '')
  const workspaceKey = deps.workspaceKeyOfCwd(agent?.session?.header?.cwd)

  switch (sub) {
    case '':
    case 'status':
      return statusText(deps, sessionId, workspaceKey)
    case 'titles': {
      // One-time repair of titles damaged by the pre-2026-11-18 truncation.
      // dry-run previews; a plain run writes the store AND renames live host
      // sessions. The startup pass is marker-guarded; this manual path always
      // re-plans (after a successful run the plan is empty anyway).
      const dryRun = /dry[-_ ]?run|预览|预演/i.test(arg)
      if (arg && !dryRun) return { kind: 'error', text: '用法：/memory titles [dry-run]（dry-run 只预览不写库）' }
      const result = await migrateTruncatedTitles({ ctx: deps.ctx, store, logger: deps.logger }, { dryRun, ignoreMarker: true })
      return { kind: 'success', text: renderTitlesMigrationReport(result) }
    }
    case 'merge': {
      // R23: 存量话题集合并。默认 dry-run 只渲染清单；apply 必须显式才写库。
      // --rename <标题>（子命令前后均可）只改「已有主集」簇的目标标题：聚类仍按当前
      // 标题进行，改名在 plan 之后生效，dry-run 预览即最终形态。
      const raw = arg.trim()
      let rename: string | undefined
      let rest = raw
      const flag = rest.match(/--rename(?:=|\s+)([\s\S]+)$/)
      if (flag) {
        rename = flag[1].trim()
        rest = rest.slice(0, flag.index).trim()
      }
      const apply = /^(apply|执行|应用)$/i.test(rest)
      const dryRun = !rest || /^(dry[-_ ]?run|预览|预演)$/i.test(rest)
      if (!apply && !dryRun) {
        return { kind: 'error', text: '用法：/memory merge [dry-run|apply] [--rename <标题>]（默认 dry-run 只预览不写库；apply 才写库；--rename 仅改「已有主集」簇的目标标题，存在多个已有主集簇时请分批或用管理台逐个改名）' }
      }
      let result
      try {
        result = await mergeTopicSets(
          { ctx: deps.ctx, store, logger: deps.logger },
          { dryRun, ...(rename === undefined ? {} : { rename }) },
        )
      } catch (error) {
        return { kind: 'error', text: String((error as { message?: string })?.message ?? error).slice(0, 300) }
      }
      return { kind: 'success', text: renderMergeReport(result) }
    }
    case 'organize': {
      // R23: 一次性整理（集合重排 / 合并近重复 / 清理占位）。启动时已按标记
      // 自动执行过一次；这里提供报告与手动重跑（preview 只读、不改库）。
      const mode = arg.trim().toLowerCase()
      if (mode === 'preview' || mode === 'dry-run' || mode === '预演') {
        return { kind: 'success', text: renderMemoryOrganizeReport(await previewMemoryOrganize(store, workspaceKey)) }
      }
      if (mode === 'apply' || mode === '执行' || mode === '应用') {
        const result = await applyMemoryOrganize(store, workspaceKey, { ignoreMarker: true, logger: deps.logger })
        return { kind: 'success', text: renderMemoryOrganizeReport(result) }
      }
      if (mode) return { kind: 'error', text: '用法：/memory-organize [preview|apply]（默认查看当前集合状态；preview 只预演；apply 手动重跑并写库）' }
      const result = await applyMemoryOrganize(store, workspaceKey, { logger: deps.logger })
      return { kind: 'success', text: renderMemoryOrganizeReport(result) }
    }
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
      // R19 需求⑥: activation regenerates the index only when content changed.
      noteTopicSetActivated({ ctx: deps.ctx, store, logger: deps.logger }, found[0])
      return { kind: 'success', text: `已激活话题集『${found[1].title}』。\n${renderCard(found[1])}` }
    }
    case 'new': {
      if (!arg) return { kind: 'error', text: '用法：/memory new <标题>' }
      const model = await askDefaultModel(deps.model, agent)
      // An explicit title is shown whole up to TOPIC_SET_TITLE_MAX_CHARS
      // and clipped with "…" beyond that (the old slice(0, 40) cut with no marker).
      const title = clipEllipsis(firstLine(arg), TOPIC_SET_TITLE_MAX_CHARS)
      const id = await createTopicSet(store, { workspaceKey, title, ...(model ? { defaultModel: model } : {}) })
      // R19 需求⑥: a bare title is enough for /memory new — the model fills the
      // tags/body index (falling back to what was written on any failure).
      try {
        await fillTopicShapeOnCreate({ ctx: deps.ctx, store, logger: deps.logger }, id, '', { tags: true, summary: true })
      } catch (error) {
        deps.logger.warn('supermemory: topic-set shape generation skipped: ' + String(error).slice(0, 160))
      }
      await setRouting(store, sessionId, { activeTopicSetId: id, driftCount: 0 })
      noteTopicSetActivated({ ctx: deps.ctx, store, logger: deps.logger }, id)
      const stored = getTopicSet(store, id)
      return {
        kind: 'success',
        text: `已创建并激活话题集『${stored?.title ?? title}』${stored && stored.keywords.length ? `（标签：${stored.keywords.join('、')}）` : ''}${model ? `（默认模型 ${model.provider}/${model.model}）` : ''}`,
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
    case 'tools':
      return toolsCommand(deps, arg)
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
      const { buildExport } = await import('./export.ts')
      const active = getRouting(store, sessionId)?.activeTopicSetId
      const result = buildExport(store, workspaceKey, active)
      const target = `${cwdFor(agent)}/.supermemory-export.md`
      writeFileSync(target, result.text, 'utf8')
      return { kind: 'success', text: `已导出到 ${target}（${result.memories} 条记忆、${result.requirements} 条需求、${result.files} 个文件条目）。` }
    }
    case 'ui': {
      const { getWebui } = await import('./webui.ts')
      const webui = getWebui()
      if (!webui?.enabled) {
        return { kind: 'error', text: 'Web 管理台未启用（ui.enabled=false）。' }
      }
      const url = webui.url(sessionId, workspaceKey)
      return {
        kind: 'success',
        text: `记忆管理台：\n${url}\n\n直接点击链接，或粘贴进侧边栏 browser tab（管理台与 GUI 不同源，侧边栏可正常嵌入；系统浏览器也可）。令牌仅本次运行有效；宿主重启后请重新执行 /memory ui。`,
      }
    }
    case 'resume': {
      // E: 被中断的任务由用户决定继续哪些。无参=清单；带 dispatchId（可多个）=续跑。
      const ids = arg ? arg.split(/\s+/).map((row) => row.trim()).filter(Boolean) : []
      if (ids.length === 0) {
        return { kind: 'success', text: renderInterruptedList(listInterruptedDispatches(store, { workspaceKey })) }
      }
      const lines: string[] = []
      for (const id of ids) {
        const row = await resumeDispatch({ ctx: deps.ctx, store, logger: deps.logger }, id, { exec: { agent } })
        lines.push((row.status === 'resumed' ? '✅ ' : '❌ ') + row.dispatchId + '：' + row.message)
      }
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'wrap': {
      const active = getRouting(store, sessionId)?.activeTopicSetId
      if (!active) return { kind: 'error', text: '当前没有激活的话题集。' }
      const topicSet = getTopicSet(store, active)
      if (!topicSet) return { kind: 'error', text: '话题集不存在。' }
      const bits: string[] = []
      if (topicSet.summary) bits.push(topicSet.summary)
      for (const [, episode] of store.episodes.entries()) {
        if (episode.topicSetId === active && episode.summary) bits.push(clipMarked(episode.summary, 120))
      }
      // Stored summary: clip at a sentence boundary WITH the marker (a hard
      // slice here persisted a half-sentence into the topic set forever).
      const summary = clipMarked(bits.slice(-6).join(' / '), 500)
      await updateTopicSetSummary(store, active, summary || topicSet.summary)
      return { kind: 'success', text: `已更新话题集梗概：\n${summary || '（暂无素材）'}` }
    }
    default:
      return { kind: 'error', text: `未知子命令 /memory ${sub}；可用：${HELP}` }
  }
}

const HELP = 'status 状态总览 · topicsets 话题集列表 · switch <名> 激活 · new <标题> 新建 · '
  + 'model 模型管理 · tools 组合工具 · reqs 需求 · resume 续跑中断任务 · wrap 更新梗概 · scan/export（P2） · ui 可视化管理台（Plan A）\n'
  + 'merge：存量话题集合并治理（相似簇→主集，源集 archived 不删）。/memory-merge 预览清单（dry-run 不写库）；/memory-merge apply 执行；\n'
  + '  --rename <标题>：同时把「已有主集」簇的目标集改名（dry-run 预览即最终形态；存在多个已有主集簇时请分批或用管理台）。\n'
  + 'organize：记忆集合整理（集合重排 / 合并近重复 / 清理占位）。/memory-organize 查看整理后状态；/memory-organize preview 预演不写库；apply 手动重跑；启动时已标记守卫自动执行一次。\n'
  + 'resume：被中断的任务（插件重载/关闭或 DSH 退出导致，分支会话已保留）。'
  + '/memory-resume 查看清单；/memory-resume <dispatchId...> 续跑指定任务（优先续接原分支会话）。\n'
  + '快捷方式：每个子命令都是独立命令，输入 /memory 后可在列表里直接选择'
  + '（如 /memory-ui、/memory-status、/memory-topicsets）；也可用 /memory <子命令> <参数>。'

/** R6: /memory tools — list / edit / describe / retire composite tools. */
async function toolsCommand(deps: CommandsDeps, arg: string): Promise<Result> {
  const store = deps.store
  if (!store) return { kind: 'error', text: 'SuperMemory 存储域未打开，记忆功能不可用。' }
  const { SupermemoryPanelService } = await import('./panel.ts')
  const service = new SupermemoryPanelService(store, deps.ctx)
  const [verb, ...rest] = arg.split(/\s+/)
  const target = rest.join(' ').trim()
  if (!verb) {
    const rows = service.listTools()
    if (rows.length === 0) {
      return { kind: 'success', text: '（暂无组合工具；R49 起自动路径不再生成组合工具，可用 memory_toolize accept 接受有业务对象的待处理提议，或用 memory_toolize register 登记能力）' }
    }
    const lines = rows.map((row) => [
      `- ${row.name}（${row.status}${row.live ? '' : '，未注册'}，使用 ${row.useCount} 次）`,
      `  简介：${row.description || '（无）'}`,
      `  步骤：${row.steps.join(' → ') || '（无）'}`,
      row.parameters.length > 0 ? `  参数：${row.parameters.join('、')}` : '  参数：（无）',
      `  id=${row.id}`,
    ].join('\n'))
    return {
      kind: 'success',
      text: ['组合工具（自行生成，可编辑）：', ...lines,
        '',
        '编辑：/memory tools edit <id> {"description":"…","steps":[{"tool":"…","arguments":{}}],"parameters":[…]}',
        '改简介：/memory tools desc <id> <文本> · 停用：/memory tools retire <id>'].join('\n'),
    }
  }
  if (verb === 'desc') {
    const [id, ...textParts] = target.split(/\s+/)
    const text = textParts.join(' ').trim()
    if (!id || !text) return { kind: 'error', text: '用法：/memory tools desc <id> <简介文本>' }
    const result = await service.editTool(id, { description: text })
    return result.status === 'ok' ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
  }
  if (verb === 'retire') {
    if (!target) return { kind: 'error', text: '用法：/memory tools retire <id>' }
    const result = await service.editTool(target.trim(), { status: 'retired' })
    return result.status === 'ok' ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
  }
  if (verb === 'edit') {
    const space = target.indexOf(' ')
    if (space <= 0) return { kind: 'error', text: '用法：/memory tools edit <id> <JSON 补丁>' }
    const id = target.slice(0, space)
    const raw = target.slice(space + 1).trim()
    let patch: Record<string, unknown>
    try {
      patch = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return { kind: 'error', text: 'JSON 补丁解析失败。' }
    }
    const result = await service.editTool(id, patch as never)
    return result.status === 'ok' ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
  }
  return { kind: 'error', text: `未知操作 /memory tools ${verb}；可用：（无参）列表 · edit <id> <JSON> · desc <id> <文本> · retire <id>` }
}

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

function topicsetsText(store: Store, workspaceKey: string): Result {
  const list = listTopicSets(store, workspaceKey)
  if (list.length === 0) return { kind: 'success', text: '（当前工作区暂无话题集；发送消息时将按需询问新建）' }
  const lines = list.map(([id, t]) => {
    const branches = t.members.map((m) => `${m.title || m.sessionId.slice(0, 8)}(${m.status})`).join('、') || '无分支'
    return `- ${t.title}${t.defaultModel ? ` [${t.defaultModel.provider}/${t.defaultModel.model}]` : ''}\n  ${t.summary || '（暂无梗概）'}\n  分支：${branches}\n  id=${id}`
  })
  return { kind: 'success', text: lines.join('\n') }
}
