/**
 * Client half of the SuperMemory panel wire contract. Mirrors the host-side
 * PANEL_DESCRIPTORS in src/panel.ts (registered through
 * ctx.get('typert').register with face 'host'); mounted here so the browser can call the
 * panel service. The id set must stay identical on both halves —
 * scripts/mechanism-smoke.mjs asserts that parity.
 * Shape follows the dsh-ops runtime-host pattern ({package, descriptors}).
 * @module supermemory/client/remote
 */

/** Passthrough codec: values are plain JSON produced by the host service. */
const jsonCodec = (symbol: string) => ({
  mode: 'strict' as const,
  typeSymbol: `dsh-supermemory#${symbol}`,
  create: () => ({ parse: (value: unknown) => value }),
})

const param = (name: string, optional = false) => ({
  name,
  wire: name,
  source: 'json' as const,
  ...(optional ? { acceptsUndefined: true as const } : {}),
  codec: jsonCodec(name),
})

const method = (name: string, parameters: unknown[] = []) => ({
  id: `dsh-supermemory#supermemoryPanel/${name}`,
  service: 'supermemoryPanel',
  namespace: 'supermemoryPanel',
  method: name,
  invocation: { kind: 'direct' as const },
  result: jsonCodec(`${name}:result`),
  parameters,
})

/** The mountable contribution for `ctx.remote.$mount`. */
export const PANEL_REMOTE = Object.freeze({
  package: 'dsh-supermemory',
  descriptors: Object.freeze([
    method('listTopicSets', [param('cwd')]),
    method('activate', [param('sessionId'), param('topicSetId')]),
    method('activeTopicSet', [param('sessionId')]),
    method('hubState', [param('cwd'), param('sessionId')]),
    method('listMemories', [param('cwd'), param('query', true), param('limit', true)]),
    method('createMemory', [param('cwd'), param('text'), param('key', true), param('title', true), param('tags', true)]),
    method('updateMemory', [param('cwd'), param('id'), param('text'), param('key', true), param('title', true), param('tags', true)]),
    method('deleteMemory', [param('cwd'), param('id')]),
    method('setMemoryStatus', [param('cwd'), param('id'), param('status')]),
    // R30 需求②: 记忆页签两级页——集合卡片统计 / 集合内条目 / 记忆详情（含历史版本）。
    method('listMemoryCollections', [param('cwd')]),
    method('listMemoriesByCollection', [param('cwd'), param('collectionId'), param('query', true), param('limit', true)]),
    method('getMemoryDetail', [param('cwd'), param('id')]),
    // R36 需求②: 「中枢权限」页签——白名单快照 / 保存（含 reset）。两端参数
    // 个数必须一致（历史教训：arity 漂移会让客户端 api 直接拒调）。
    method('getHubPolicy', [param('cwd')]),
    method('setHubPolicy', [param('cwd'), param('patch')]),
    // R39: 一键清理白名单里运行时已不存在的条目（动态目录的失效组）。
    method('cleanupStaleHubPolicy', [param('cwd')]),
    // R41 需求①b: 设置页签的默认模型（中枢/分支，按工作区）。
    method('getModelDefaults', [param('cwd')]),
    method('setModelDefaults', [param('cwd'), param('patch')]),
    // R45: 设置页签「已生成的 skills」——快照 / 启用停用 / 改路由描述。
    method('listSkills', [param('cwd')]),
    method('updateSkill', [param('cwd'), param('name'), param('patch')]),
    method('createTopicSet', [param('cwd'), param('title'), param('tags', true), param('summary', true)]),
    method('suggestMemoryShape', [param('text')]),
    method('listHubSessions', [param('cwd')]),
    // R59 Phase 1b-2: 会话标题管理（重命名 / 恢复自动命名 / 修复）。
    method('renameSessionTitle', [param('cwd'), param('sessionId'), param('title')]),
    method('resetSessionTitle', [param('cwd'), param('sessionId')]),
    method('repairSessionTitle', [param('cwd'), param('sessionId')]),
    // R19 协同②: hub → branches association (name / state / shared / set).
    method('listHubBranches', [param('cwd'), param('hubSessionId'), param('limit', true)]),
    // R30 需求③: 中枢管理全部话题集（含归档）+ 查看全部分支会话（跨话题集）。
    method('listAllTopicSets', [param('cwd')]),
    method('listAllBranches', [param('cwd'), param('topicSetId', true), param('limit', true)]),
    // R19 需求⑤: in-panel conversation (read surface + send followup).
    method('readSessionMessages', [param('sessionId'), param('limit', true)]),
    method('sendSessionMessage', [param('sessionId'), param('text')]),
    method('updateTopicSetSummary', [param('id'), param('summary'), param('tags', true)]),
    method('createTopicSetSession', [param('cwd'), param('topicSetIds'), param('options', true), param('firstMessage', true)]),
    method('createHubSession', [param('cwd'), param('options', true), param('firstMessage', true)]),
    method('listAgentPresets', []),
    method('listModelCatalog', []),
    method('listPermissions', []),
    method('followupTopicSet', [param('cwd'), param('topicSetId'), param('text')]),
    // A3: the panel scopes the tool list to the current workspace, so the
    // declaration must accept the cwd the call site passes (0-arity here made
    // the mounted client api reject the call: "expected 0 argument(s), got 1").
    method('listTools', [param('cwd', true)]),
    method('editTool', [param('id'), param('patch')]),
    method('deleteTool', [param('id')]),
    // R22: 一键执行能力（默认预演；writeConfirm 能力需 options.confirm=true）。
    method('runTool', [param('id'), param('options', true)]),
    // R50: 待处理提案的接受/拒绝（接受 -> 能力；入口草稿仍需「启用执行」）。
    method('acceptProposal', [param('cwd'), param('id')]),
    method('declineProposal', [param('cwd'), param('id')]),
    method('sessionBadge', [param('sessionId')]),
  ]),
})
