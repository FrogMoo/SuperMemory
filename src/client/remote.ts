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
    method('createMemory', [param('cwd'), param('text'), param('key', true)]),
    method('updateMemory', [param('cwd'), param('id'), param('text'), param('key', true)]),
    method('deleteMemory', [param('cwd'), param('id')]),
    method('setMemoryStatus', [param('cwd'), param('id'), param('status')]),
    method('createTopicSet', [param('cwd'), param('title')]),
    method('updateTopicSetSummary', [param('id'), param('summary')]),
    method('createTopicSetSession', [param('cwd'), param('topicSetIds'), param('options', true)]),
    method('createHubSession', [param('cwd'), param('options', true)]),
    method('listAgentPresets', []),
    method('listModelCatalog', []),
    method('listPermissions', []),
    method('followupTopicSet', [param('cwd'), param('topicSetId'), param('text')]),
    method('listTools', []),
    method('editTool', [param('id'), param('patch')]),
    method('deleteTool', [param('id')]),
    method('sessionBadge', [param('sessionId')]),
  ]),
})
