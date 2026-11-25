/**
 * Unified capability (R50): ONE record, TWO faces — knowledge (SKILL.md) and
 * execution (sm_cap_<name>).
 *
 * R50 (2026-11-26) replaced the old split between "composite tools" (tool
 * sequences compiled into one call), "capabilities" (entry command + doc +
 * scope) and the separate auto-generated skill list. A capability is now a
 * single durable record:
 *
 *   kind='capability'  executable + knowledge face (entry command);
 *   kind='knowledge'   knowledge face only (SKILL.md, no entry);
 *   kind='proposal'    pending auto knowledge draft (accept -> capability).
 *
 * The old sequence pipeline is GONE: no compile/register/rebuild path exists
 * for sm_composite_* tools. Legacy rows are migrated lazily and idempotently:
 *   - old capability rows (kind='composite' + spec.kind='capability') become
 *     capabilities, renamed sm_composite_<x> -> sm_cap_<x>, with a SKILL.md;
 *   - old kind='skill' rows become knowledge (no entry);
 *   - old tool-sequence rows become status='retired' (audit only, never registered).
 *
 * Execution semantics are unchanged: scope/workspace gate, default dry-run
 * (dryRunArg), writeConfirm requires confirm=true, output clipped and
 * time-limited. One tool per capability, named sm_cap_<name>, with a fixed
 * entry (no arbitrary argument passthrough); it only accepts dry_run/confirm.
 *
 * @module supermemory/capability
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type * as Tools from '@deepseek-ai/dsh-tools'
import { loadHostModule } from './host.ts'
import type { TaskSample } from './task-signature.ts'
import type { ToolMemory } from './schema.ts'
import { newId, workspaceKeyOf, type Store } from './store.ts'
import { BUILTIN_CAPABILITIES } from './builtin-capabilities.ts'
import { charCount, clipAtBoundary } from './clip.ts'
import { CAPABILITY_ROUTING_RULES } from './route.ts'
import {
  adoptCapabilityDocVersion, archiveCapabilityDoc, archiveCapabilitySkill, archiveShellSkills,
  archivedCapabilityDocFiles, bodyHashOf, buildCapabilitySkill, capabilityDocFileName, capabilityDocPath,
  capabilitySkillNames, isShellIdentity, parseSkillMarkdown, readSkillVersionAt,
  resolveCapabilityRoot, resolveSkillRoot, splitFactsBlock, upsertCapabilitySkill,
  type CapabilityFacts,
} from './skill-forge.ts'

export type { CapabilityFacts } from './skill-forge.ts'

/** Serialized record marker (distinguishes new JSON from legacy CompositeSpec). */
export const CAPABILITY_SCHEMA = 'sm.capability/1'

/** Tool prefix of the execution face. sm_composite_* is retired for good. */
export const CAPABILITY_PREFIX = 'sm_cap_'

/** Backtick helper kept as a constant so generated Markdown can use code spans. */
const BT = String.fromCharCode(96)

/** Logical name -> registered tool name (git-sync-supermemory -> sm_cap_git_sync_supermemory). */
export function capabilityToolName(name: string): string {
  const slug = String(name ?? '').replace(/^sm_cap_|^sm_composite_|^sm-/, '').trim()
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 41)
  return CAPABILITY_PREFIX + (slug || 'capability')
}

/** Logical name -> skill name (git-sync-supermemory -> sm-git-sync-supermemory). */
export function capabilitySkillName(name: string): string {
  return capabilitySkillNames(name).skillName
}

/** Normalise any historical name form to the logical kebab slug. */
export function capabilityLogicalName(name: string): string {
  const raw = String(name ?? '').trim()
  const stripped = raw.replace(/^sm_cap_|^sm_composite_|^sm-/, '')
  const slug = stripped.replace(/_/g, '-').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return slug || 'capability'
}

export type CapabilityKind = 'capability' | 'knowledge' | 'proposal'
export type CapabilitySource = 'builtin' | 'manual' | 'auto' | 'migrated'

/**
 * One unified capability definition (persisted as JSON in tool_memory.entry).
 * Row-level mirrors (kind/status/enabled/loadCount/runCount/skillPath/source/
 * taskKey/bodyHash/factsHash) are written by rowOfRecord for cheap listing; this
 * JSON stays authoritative for the full definition.
 */
export interface CapabilityRecord {
  schema: string
  /** Logical kebab name, e.g. git-sync-supermemory / fix-skill-forge. */
  name: string
  kind: CapabilityKind
  title: string
  description: string
  tags: string[]
  /** Entry command; '' for knowledge-only capabilities. */
  entry: string
  /** High-confidence auto-drafted entry (never executed until verified). */
  entryDraft: string
  /** True only after a human enabled the drafted entry. */
  entryVerified: boolean
  doc: string
  /** Execution directory (a capability with scope is workspace-bound). */
  scope: string
  runnable: boolean
  /** Enabled/disabled BOTH faces at once. */
  enabled: boolean
  dryRunArg: string
  writeConfirm: boolean
  routeNote: string
  source: CapabilitySource
  /** Task signature this capability aggregates (auto proposals/accepted). */
  taskKey: string
  version: number
  updatedAt: number
  changelog: string[]
  /** SKILL.md absolute path (knowledge face). */
  skillPath: string
  /** Hash of the human prose (facts block excluded). */
  bodyHash: string
  /** Hash of the last generated facts block. */
  factsHash: string
  facts: CapabilityFacts
  loadCount: number
  runCount: number
  successCount: number
  failCount: number
  consecutiveFailures: number
  lastUsedAt?: number
  lastStatus?: 'completed' | 'failed'
  lastDryRun?: boolean
  lastExitCode?: number
  lastSummary?: string
  builtin: boolean
  builtinVersion?: number
  /** Proposal-only fields. */
  proposalStatus?: 'pending' | 'accepted' | 'declined'
  expiresAt?: number
  draftBody?: string
  acceptedId?: string
}

/** A row plus its parsed record (the listing/projection unit). */
export interface CapabilityRow {
  id: string
  row: ToolMemory
  record: CapabilityRecord
}

const CHANGELOG_MAX = 20
const PROPOSAL_TTL_MS = 30 * 86400000
const PROPOSAL_MAX = 20

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Normalise a record read from any historical shape (never throws). */
export function normalizeCapabilityRecord(raw: Record<string, unknown>, row?: ToolMemory): CapabilityRecord {
  const isNew = raw.schema === CAPABILITY_SCHEMA
  const kind: CapabilityKind = raw.kind === 'proposal' || raw.kind === 'knowledge' || row?.kind === 'knowledge' || row?.kind === 'proposal'
    ? (raw.kind === 'proposal' || row?.kind === 'proposal' ? 'proposal' : 'knowledge')
    : 'capability'
  const name = isNew
    ? capabilityLogicalName(str(raw.name))
    : capabilityLogicalName(str(raw.name) || str(row?.trigger) || 'capability')
  const usage = (raw.usage && typeof raw.usage === 'object' ? raw.usage : {}) as Record<string, unknown>
  const facts = (raw.facts && typeof raw.facts === 'object' ? raw.facts : {}) as CapabilityFacts
  const entryDraft = str(raw.entryDraft ?? row?.entryDraft)
  const entry = kind === 'capability' || raw.kind === 'capability' ? str(raw.entry) : str(raw.entry)
  const enabled = raw.enabled === undefined
    ? (row?.enabled === false ? false : row?.status !== 'retired')
    : Boolean(raw.enabled)
  return {
    schema: CAPABILITY_SCHEMA,
    name,
    kind,
    title: str(raw.title) || name,
    description: str(raw.description) || str(row?.description),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)).slice(0, 8) : (row?.tags ?? []),
    entry,
    entryDraft,
    entryVerified: Boolean(raw.entryVerified ?? row?.entryVerified ?? (entry && !entryDraft)),
    doc: str(raw.doc),
    scope: str(raw.scope),
    runnable: raw.runnable === undefined ? Boolean(entry) : Boolean(raw.runnable),
    enabled,
    dryRunArg: str(raw.dryRunArg),
    writeConfirm: Boolean(raw.writeConfirm),
    routeNote: str(raw.routeNote),
    source: (str(raw.source) as CapabilitySource) || (str(row?.source) as CapabilitySource) || 'manual',
    taskKey: str(raw.taskKey ?? row?.taskKey),
    version: Math.max(1, num(raw.version, 1)),
    updatedAt: num(raw.updatedAt ?? row?.createdAt, Date.now()),
    changelog: Array.isArray(raw.changelog) ? raw.changelog.map((line) => String(line)).slice(0, CHANGELOG_MAX) : [],
    skillPath: str(raw.skillPath ?? row?.skillPath),
    bodyHash: str(raw.bodyHash ?? row?.bodyHash),
    factsHash: str(raw.factsHash ?? row?.factsHash),
    facts,
    loadCount: Math.max(0, num(raw.loadCount, num(row?.loadCount))),
    runCount: Math.max(0, num(raw.runCount, num(row?.runCount, num(row?.useCount)))),
    successCount: Math.max(0, num(raw.successCount, num(usage.successCount))),
    failCount: Math.max(0, num(raw.failCount, num(usage.failCount))),
    consecutiveFailures: Math.max(0, num(raw.consecutiveFailures, num(usage.consecutiveFailures))),
    ...(num(raw.lastUsedAt ?? usage.lastUsedAt) > 0 ? { lastUsedAt: num(raw.lastUsedAt ?? usage.lastUsedAt) } : {}),
    ...((raw.lastStatus ?? usage.lastStatus) ? { lastStatus: (raw.lastStatus ?? usage.lastStatus) as 'completed' | 'failed' } : {}),
    ...(raw.lastDryRun !== undefined ? { lastDryRun: Boolean(raw.lastDryRun) } : (usage.lastDryRun !== undefined ? { lastDryRun: Boolean(usage.lastDryRun) } : {})),
    ...(raw.lastExitCode !== undefined ? { lastExitCode: num(raw.lastExitCode) } : (usage.lastExitCode !== undefined ? { lastExitCode: num(usage.lastExitCode) } : {})),
    ...(typeof (raw.lastSummary ?? usage.lastSummary) === 'string' ? { lastSummary: String(raw.lastSummary ?? usage.lastSummary).slice(0, 200) } : {}),
    builtin: Boolean(raw.builtin),
    ...(raw.builtinVersion !== undefined ? { builtinVersion: num(raw.builtinVersion) } : {}),
    ...(raw.proposalStatus ? { proposalStatus: raw.proposalStatus as CapabilityRecord['proposalStatus'] } : {}),
    ...(raw.expiresAt !== undefined ? { expiresAt: num(raw.expiresAt) } : {}),
    ...(typeof raw.draftBody === 'string' ? { draftBody: raw.draftBody } : {}),
    ...(typeof raw.acceptedId === 'string' ? { acceptedId: raw.acceptedId } : {}),
  }
}

/** Convert one legacy CompositeSpec capability definition (pre-R50). */
export function legacyCapabilityRecord(spec: Record<string, unknown>, row?: ToolMemory): CapabilityRecord {
  return normalizeCapabilityRecord({
    ...spec,
    schema: CAPABILITY_SCHEMA,
    kind: 'capability',
    entry: spec.entry,
    entryVerified: true,
    source: 'migrated',
  }, row)
}

function skillPathOfLegacyRow(row: ToolMemory): string {
  const entry = str(row.entry)
  if (!entry) return ''
  if (entry.startsWith('{')) {
    try {
      const parsed = JSON.parse(entry) as Record<string, unknown>
      return str(parsed.skillPath) || str(parsed.entryPath)
    } catch { return '' }
  }
  return entry
}

function skillNameOfLegacyRow(row: ToolMemory): string {
  const trigger = str(row.trigger)
  const fromTrigger = /skill\/(.+)$/.exec(trigger)?.[1]
  if (fromTrigger) return fromTrigger
  const path = skillPathOfLegacyRow(row)
  const match = /[\\/]([^\\/]+)[\\/]SKILL\.md$/.exec(path)
  return match ? match[1] : (str(row.title) || 'skill')
}

/** Parse one row into a unified record; undefined for legacy sequence/unknown rows. */
export function readCapabilityRow(row: ToolMemory | undefined, id = ''): CapabilityRow | undefined {
  if (!row) return undefined
  if (row.kind === 'proposal') {
    let raw: Record<string, unknown>
    try { raw = JSON.parse(row.entry) as Record<string, unknown> } catch { return undefined }
    const record = normalizeCapabilityRecord(raw, row)
    record.kind = 'proposal'
    record.proposalStatus = (raw.proposalStatus as CapabilityRecord['proposalStatus']) ?? 'pending'
    return { id, row, record }
  }
  if (row.kind === 'knowledge' || row.kind === 'skill') {
    const path = row.kind === 'skill' ? skillPathOfLegacyRow(row) : (row.skillPath ?? '')
    // R50: a migrated/new knowledge row carries the full record JSON and is
    // authoritative; the file only fills gaps for legacy path-only rows.
    if (row.entry.startsWith('{')) {
      try {
        const raw = JSON.parse(row.entry) as Record<string, unknown>
        if (raw.schema === CAPABILITY_SCHEMA) {
          const record = normalizeCapabilityRecord(raw, row)
          record.kind = 'knowledge'
          if (!record.skillPath && path) record.skillPath = path
          return { id, row, record }
        }
      } catch { /* fall through to file parsing */ }
    }
    let file: ReturnType<typeof parseSkillMarkdown>
    if (path) {
      try { file = parseSkillMarkdown(readFileSync(path, 'utf8'), '') } catch { file = undefined }
    }
    const name = file?.name || skillNameOfLegacyRow(row)
    const record = normalizeCapabilityRecord({
      schema: CAPABILITY_SCHEMA,
      name,
      kind: 'knowledge',
      title: row.title || name,
      description: file?.description || row.description,
      entry: '',
      entryVerified: false,
      runnable: false,
      source: str(row.source) || 'migrated',
      taskKey: file?.taskKey ?? row.taskKey,
      version: file?.version ?? 1,
      changelog: file?.changelog ?? [],
      bodyHash: file?.bodyHash ?? row.bodyHash,
      factsHash: file?.factsHash ?? row.factsHash,
      skillPath: path,
    }, row)
    return { id, row, record }
  }
  if (row.kind !== 'capability' && row.kind !== 'composite' && row.kind !== 'workflow') return undefined
  let raw: Record<string, unknown>
  try { raw = JSON.parse(row.entry) as Record<string, unknown> } catch { return undefined }
  if (!raw || typeof raw !== 'object') return undefined
  if (raw.schema === CAPABILITY_SCHEMA) return { id, row, record: normalizeCapabilityRecord(raw, row) }
  if (raw.kind !== 'capability' || !str(raw.entry)) return undefined
  return { id, row, record: legacyCapabilityRecord(raw, row) }
}

/** Build the durable row projection for one record. */
export function rowOfRecord(record: CapabilityRecord, workspaceKey?: string, createdAt?: number): ToolMemory {
  return {
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    kind: record.kind,
    title: record.title,
    tags: record.tags.slice(0, 8),
    trigger: record.kind === 'proposal' ? ('proposal/' + record.name) : ('capability/' + record.name),
    description: record.description,
    entry: JSON.stringify(record),
    useCount: record.runCount,
    status: record.kind === 'proposal'
      ? (record.proposalStatus === 'pending' ? 'active' : 'retired')
      : (record.enabled === false ? 'retired' : 'active'),
    ...(record.skillPath ? { skillPath: record.skillPath } : {}),
    enabled: record.enabled !== false,
    loadCount: record.loadCount,
    runCount: record.runCount,
    source: record.source,
    ...(record.taskKey ? { taskKey: record.taskKey } : {}),
    entryDraft: record.entryDraft,
    entryVerified: record.entryVerified,
    ...(record.bodyHash ? { bodyHash: record.bodyHash } : {}),
    ...(record.factsHash ? { factsHash: record.factsHash } : {}),
  } as ToolMemory
}

/** True when the record has a usable execution face. */
export function isExecutable(record: CapabilityRecord): boolean {
  return record.kind === 'capability' && Boolean(record.entry) && record.runnable !== false && record.enabled !== false
}

/** Every unified record (capability/knowledge/proposal), broken rows skipped. */
export function capabilityRows(store: Store, workspaceKey?: string): CapabilityRow[] {
  const out: CapabilityRow[] = []
  for (const [id, row] of store.toolMemory.entries()) {
    if (!row || !['capability', 'knowledge', 'proposal', 'composite', 'skill', 'workflow'].includes(row.kind)) continue
    const parsed = readCapabilityRow(row, id)
    if (!parsed) continue
    if (workspaceKey !== undefined && !capabilityAppliesToWorkspace(parsed.record, workspaceKey, row.workspaceKey)) continue
    out.push(parsed)
  }
  return out.sort((left, right) => left.record.name.localeCompare(right.record.name))
}

/** Compatibility projection for the old capability list surface. */
export function capabilityRecordsOf(store: Store, workspaceKey?: string): Array<{ id: string; spec: CapabilityRecord; useCount: number; status: string; createdAt?: number }> {
  return capabilityRows(store, workspaceKey)
    .filter((entry) => entry.record.kind === 'capability')
    .map((entry) => ({
      id: entry.id,
      spec: entry.record,
      useCount: entry.record.runCount,
      status: entry.row.status,
      ...(entry.row.createdAt !== undefined ? { createdAt: entry.row.createdAt } : {}),
    }))
}

/** A capability belongs to a workspace via row ownership or scope. */
export function capabilityAppliesToWorkspace(
  record: Pick<CapabilityRecord, 'scope'>,
  callerWorkspace: string | undefined,
  rowWorkspaceKey?: string,
): boolean {
  if (!callerWorkspace) return true
  const own = rowWorkspaceKey || (record.scope ? workspaceKeyOf(record.scope) : undefined)
  if (!own) return true
  return own === callerWorkspace
}

/** A caller cwd is inside the capability scope (equal or descendant). */
export function scopeContains(scope: string | undefined, cwd: string | undefined): boolean {
  if (!scope || !cwd) return true
  try {
    const base = resolve(scope).replace(/[\\/]+$/, '').toLowerCase()
    const target = resolve(cwd).replace(/[\\/]+$/, '').toLowerCase()
    return target === base || target.startsWith(base + sep)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Durable read/write helpers
// ---------------------------------------------------------------------------

export function findCapabilityRow(store: Store, options: { id?: string; name?: string; workspaceKey?: string }): CapabilityRow | undefined {
  if (options.id) return readCapabilityRow(store.toolMemory.get(options.id), options.id)
  if (!options.name) return undefined
  const target = capabilityLogicalName(options.name)
  for (const candidate of capabilityRows(store)) {
    if (candidate.record.name !== target) continue
    if (options.workspaceKey && candidate.row.workspaceKey && candidate.row.workspaceKey !== options.workspaceKey) continue
    return candidate
  }
  return undefined
}

export async function saveCapabilityRecord(store: Store, record: CapabilityRecord, options: { id?: string; workspaceKey?: string; createdAt?: number } = {}): Promise<string> {
  if (options.id) {
    await store.toolMemory.update(options.id, (row) => ({
      ...row,
      ...rowOfRecord(record, options.workspaceKey ?? row.workspaceKey, row.createdAt ?? options.createdAt),
    }))
    return options.id
  }
  const id = newId('tm')
  await store.toolMemory.put(id, rowOfRecord(record, options.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : undefined), options.createdAt ?? Date.now()))
  return id
}

// ---------------------------------------------------------------------------
// Lazy, idempotent migration (old rows -> unified records)
// ---------------------------------------------------------------------------

export interface CapabilityMigrationReport {
  migratedCapabilities: number
  migratedKnowledge: number
  retiredComposites: number
  linkedSkills: number
  generatedSkills: number
  expiredProposals: number
  /** R51: shell skill directories archived during this pass. */
  archivedShells: number
  /** R51: adopted shell units retired (knowledge rows that were shells). */
  retiredShellUnits: number
  /** R51: knowledge rows that merely mirrored an executable capability. */
  dedupedKnowledge: number
  /** R52: knowledge faces moved from a skill root into .dsh/capabilities. */
  movedDocs: number
  /** R52: old skill directories archived after their knowledge file moved. */
  archivedDocDirs: number
  /** R52: manual/third-party skill files deliberately left in the skill root. */
  skippedManualDocs: number
  /** R54: knowledge-face versions restored/raised to max(record, file, archive). */
  versionsReconciled: number
  /** R54: legacy health counters folded into a coherent runCount/lastStatus. */
  healthReconciled: number
  changed: boolean
}

/**
 * R51: a unit that is really a legacy tool-order shell, even after R50 rewrote
 * its SKILL.md face from `sm-source: sequence` to `sm-source: capability`.
 * Executable capabilities are never shells — only knowledge-only units qualify.
 */
export function isShellUnit(record: Pick<CapabilityRecord, 'name' | 'description' | 'source' | 'kind' | 'entry' | 'draftBody'>): boolean {
  if (record.kind === 'capability' && String(record.entry ?? '').trim()) return false
  return isShellIdentity({
    name: record.name,
    description: record.description,
    source: record.source,
    body: record.draftBody,
  })
}

/** Retire one unit row without deleting it (audit + rollback stay possible). */
async function retireUnitRow(store: Store, id: string): Promise<void> {
  await store.toolMemory.update(id, (row) => ({ ...row, status: 'retired', enabled: false }))
}

/**
 * R51: idempotently retire every adopted tool-order shell unit.
 * Used by migration, boot cleanup and `memory_toolize cleanup`; never deletes.
 */
export async function retireShellUnits(store: Store, options: { dryRun?: boolean } = {}): Promise<Array<{ id: string; name: string }>> {
  const retired: Array<{ id: string; name: string }> = []
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind === 'proposal') continue
    if (entry.row.status === 'retired') continue
    if (!isShellUnit(entry.record)) continue
    retired.push({ id: entry.id, name: entry.record.name })
    if (!options.dryRun) {
      try { await retireUnitRow(store, entry.id) } catch { /* one broken row never blocks cleanup */ }
    }
  }
  return retired
}

function normalizePathKey(path: string): string {
  try { return resolve(path).replace(/\\/g, '/').toLowerCase() } catch { return String(path ?? '').replace(/\\/g, '/').toLowerCase() }
}

/**
 * R52: move capability knowledge faces OUT of every host skill root.
 *
 * Only capability-owned files move. A manual/third-party skill (frontmatter
 * source not `capability`) and a legacy tool-order shell are left alone; the
 * shell is archived by R51's pass, not here. Moving is copy-then-archive, so a
 * failed archive leaves the old path in the row and the next boot retries.
 */
export interface CapabilityDocMigrationReport {
  moved: number
  archivedDirs: number
  skippedManual: number
  skippedShells: number
  changed: boolean
  entries: Array<{ name: string; from: string; to: string; archivePath?: string }>
}

function skillRootOf(file: string): string | undefined {
  try {
    const normalized = resolve(file).replace(/\\/g, '/')
    const lower = normalized.toLowerCase()
    const marker = '/.dsh/skills/'
    const index = lower.lastIndexOf(marker)
    if (index >= 0) return resolve(normalized.slice(0, index + marker.length - 1))
    const homeSkills = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills').replace(/\\/g, '/')
    if (lower.startsWith(homeSkills.toLowerCase() + '/')) return resolve(homeSkills)
  } catch { /* a broken path is not a skill root */ }
  return undefined
}

export async function migrateCapabilityDocs(store: Store, options: {
  capabilityRoot?: string
  now?: number
  logger?: { info: (msg: string) => void }
} = {}): Promise<CapabilityDocMigrationReport> {
  const now = options.now ?? Date.now()
  const report: CapabilityDocMigrationReport = {
    moved: 0, archivedDirs: 0, skippedManual: 0, skippedShells: 0, changed: false, entries: [],
  }
  for (const entry of capabilityRows(store)) {
    const record = entry.record
    if (record.kind === 'proposal' || entry.row.status === 'retired') continue
    const oldPath = String(record.skillPath ?? '').trim()
    if (!oldPath) continue
    const oldRoot = skillRootOf(oldPath)
    if (!oldRoot) continue
    const owned = entry.row.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : undefined)
    if (!owned || owned === 'unknown' || !isAbsolute(owned) || !existsSync(owned)) continue
    const newRoot = options.capabilityRoot ?? resolveCapabilityRoot(owned).root
    const newPath = capabilityDocPath(newRoot, record.name)
    const oldExists = existsSync(oldPath)
    const newExists = existsSync(newPath)
    if (oldExists) {
      let parsed: ReturnType<typeof parseSkillMarkdown>
      try { parsed = parseSkillMarkdown(readFileSync(oldPath, 'utf8'), capabilitySkillName(record.name)) } catch { parsed = undefined }
      if (!parsed) continue
      if (parsed.source === 'sequence' || isShellIdentity({ name: parsed.name, description: parsed.description, source: parsed.source, body: parsed.body })) {
        report.skippedShells += 1
        continue
      }
      // A human/third-party skill is not capability property. `memory_toolize`
      // manual capabilities write sm-source: capability, so they still migrate.
      // Only files stamped `sm-source: capability` belong to the capability
      // knowledge plane. Manual/third-party/task skills stay in the DSH catalog
      // even when R50 adopted a row for them.
      if (parsed.source !== 'capability') {
        report.skippedManual += 1
        continue
      }
      if (!newExists) {
        try {
          mkdirSync(newRoot, { recursive: true })
          copyFileSync(oldPath, newPath)
        } catch (error) {
          options.logger?.info('supermemory: capability doc copy failed ' + oldPath + ': ' + String(error).slice(0, 120))
          continue
        }
      }
      const oldSkillRoot = dirname(dirname(oldPath))
      const oldSkillName = basename(dirname(oldPath))
      let archivePath: string | undefined
      try {
        const archived = await archiveCapabilitySkill(oldSkillRoot, oldSkillName, {
          now,
          reason: 'R52 能力知识面迁移：从宿主 skill 目录移出到 .dsh/capabilities（可回滚）',
        })
        archivePath = archived?.archivePath
        if (archived) report.archivedDirs += 1
      } catch { /* archive failure keeps the old row path for the next pass */ }
      if (!archivePath) continue
      const next: CapabilityRecord = { ...record, skillPath: newPath }
      await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
      report.moved += 1
      report.changed = true
      report.entries.push({ name: record.name, from: oldPath, to: newPath, archivePath })
      options.logger?.info('supermemory: capability doc moved ' + record.name + ' -> ' + newPath)
      continue
    }
    if (newExists) {
      const next: CapabilityRecord = { ...record, skillPath: newPath }
      await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
      report.moved += 1
      report.changed = true
      report.entries.push({ name: record.name, from: oldPath, to: newPath })
    }
  }
  return report
}

/**
 * R54: per-row migration report for the version/health reconciliations.
 */
export interface VersionReconcileReport {
  reconciled: number
  changed: boolean
  entries: Array<{ name: string; version: number; path?: string; restoredFrom?: string }>
}

/** R54: one-line explanation written into the knowledge face when a version is restored. */
export function versionRestoreLine(version: number, restoredFrom?: string): string {
  if (!restoredFrom) return 'v' + version + ': 知识面版本与能力记录对齐（R54 单调化）'
  let source = ''
  try { source = basename(dirname(restoredFrom)) } catch { source = '' }
  return 'v' + version + ': R52 迁移到 .dsh/capabilities，保留归档版本' + (source ? '（源自归档 ' + source + '）' : '')
}

/**
 * R54: enforce the monotonic knowledge-face version ledger.
 *
 * R52's migration could regenerate `.dsh/capabilities/<name>.md` from a stale
 * record version (6) while the pre-R52 archive still carried the newer file
 * (8) — the live document then regressed two versions. The rule is now
 * max(record.version, live file version, every archived version); when the max
 * comes from somewhere else, the live file is rewritten AT that version (prose
 * untouched) and the restoration is recorded in both the file and the record.
 * Idempotent: a second pass finds every ledger aligned and reports changed=false.
 */
export async function reconcileCapabilityVersions(store: Store, options: {
  capabilityRoot?: string
  skillsRoot?: string
  now?: number
  logger?: { info: (msg: string) => void }
} = {}): Promise<VersionReconcileReport> {
  const now = options.now ?? Date.now()
  const report: VersionReconcileReport = { reconciled: 0, changed: false, entries: [] }
  for (const entry of capabilityRows(store)) {
    const record = entry.record
    if (record.kind === 'proposal' || entry.row.status === 'retired') continue
    const owned = entry.row.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : undefined)
    let root = options.capabilityRoot
    let skillsRoot = options.skillsRoot
    const usable = owned && owned !== 'unknown' && isAbsolute(owned) && existsSync(owned)
    if (!root && usable) {
      try { root = resolveCapabilityRoot(owned).root } catch { root = undefined }
    }
    if (!skillsRoot && usable) {
      try { skillsRoot = resolveSkillRoot(owned).root } catch { skillsRoot = undefined }
    }
    if (!root) continue
    const livePath = String(record.skillPath ?? '').trim()
    const docPath = livePath && existsSync(livePath) ? livePath : capabilityDocPath(root, record.name)
    const archived = archivedCapabilityDocFiles(root, record.name, skillsRoot)
      .map((file) => ({ file, version: readSkillVersionAt(file) }))
      .filter((row) => row.version > 0)
      .sort((left, right) => right.version - left.version)
    if (!existsSync(docPath)) {
      // No live face at all: restore the best archived copy so its version and
      // changelog survive, then align below.
      if (archived.length === 0) continue
      try {
        mkdirSync(dirname(docPath), { recursive: true })
        copyFileSync(archived[0].file, docPath)
      } catch { continue }
    }
    const fileVersion = readSkillVersionAt(docPath)
    const preserved = Math.max(record.version, fileVersion, archived[0]?.version ?? 0)
    if (preserved <= record.version && preserved <= fileVersion) continue
    const restoredFrom = (archived[0] && archived[0].version > Math.max(record.version, fileVersion)) ? archived[0].file : undefined
    const line = versionRestoreLine(preserved, restoredFrom)
    let restoredHistory: string[] = []
    if (restoredFrom) {
      try {
        const parsed = parseSkillMarkdown(readFileSync(restoredFrom, 'utf8'), capabilitySkillNames(record.name).skillName)
        restoredHistory = parsed?.changelog ?? []
      } catch { restoredHistory = [] }
    }
    const adopted = adoptCapabilityDocVersion({
      path: docPath,
      name: record.name,
      title: record.title,
      tags: record.tags,
      version: preserved,
      changelogLine: line,
      ...(restoredHistory.length > 0 ? { extraChangelog: restoredHistory } : {}),
      now,
    })
    if (adopted.status === 'error') {
      options.logger?.info('supermemory: capability version reconcile failed ' + record.name + ': ' + adopted.message)
      continue
    }
    // The record follows the restored ledger, so later boots (and the builtin
    // merge) never fall back to the stale number.
    const next: CapabilityRecord = {
      ...record,
      version: adopted.version,
      updatedAt: now,
      changelog: (record.changelog[0] === line ? record.changelog : [line, ...record.changelog]).slice(0, CHANGELOG_MAX),
      skillPath: docPath,
      ...(adopted.bodyHash ? { bodyHash: adopted.bodyHash } : {}),
      ...(adopted.factsHash ? { factsHash: adopted.factsHash } : {}),
    }
    // A row that mirrors a builtin definition keeps tracking that definition's
    // version separately; R54's restored ledger must not block future upgrades.
    const builtin = BUILTIN_CAPABILITIES.find((candidate) => capabilityLogicalName(candidate.name) === record.name)
    if (builtin) {
      next.builtin = true
      next.builtinVersion = builtin.version
    }
    await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
    report.reconciled += 1
    report.changed = true
    report.entries.push({ name: record.name, version: adopted.version, path: docPath, ...(restoredFrom ? { restoredFrom } : {}) })
    options.logger?.info('supermemory: capability version reconciled ' + record.name + ' -> v' + adopted.version + (restoredFrom ? '（恢复归档版本）' : ''))
  }
  return report
}

/** R54: one coherent health reading for a record (legacy stats folded in). */
export interface HealthReconcileResult {
  record: CapabilityRecord
  changed: boolean
  /** True when legacy success/fail counters had been kept OUTSIDE runCount. */
  legacyFolded: boolean
}

/**
 * R54: make the health counters tell ONE story.
 *
 * Legacy rows can carry successCount=13 / failCount=9 / consecutiveFailures=2 /
 * lastStatus='failed' while runCount stayed 0 (the old `usage` object was
 * carried into the record without its denominator). The panel then renders
 * "0 runs, 0 loads→runs, 13 successes, 9 failures", which reads as a bug.
 *
 * Chosen rule (documented in CHANGELOG/DEV-NOTES): PRESERVE the history instead
 * of discarding it — runCount = max(runCount, successCount + failCount), the
 * success rate keeps its real denominator, and lastStatus is forced to agree
 * with the most recent outcome (a non-zero consecutive-failure streak means the
 * last run failed). Everything is derived, so the pass is idempotent.
 */
export function reconcileCapabilityHealth(record: CapabilityRecord): HealthReconcileResult {
  const successCount = Math.max(0, Number(record.successCount) || 0)
  const failCount = Math.max(0, Number(record.failCount) || 0)
  const runs = successCount + failCount
  const previousRuns = Math.max(0, Number(record.runCount) || 0)
  const runCount = Math.max(previousRuns, runs)
  const legacyFolded = runs > previousRuns
  // A streak can never exceed the recorded failures; no failures means no streak.
  const consecutiveFailures = failCount === 0
    ? 0
    : Math.min(Math.max(0, Number(record.consecutiveFailures) || 0), failCount)
  let lastStatus: 'completed' | 'failed' | undefined = record.lastStatus
  if (consecutiveFailures > 0) lastStatus = 'failed'
  else if (lastStatus === 'failed' && successCount > 0) lastStatus = 'completed'
  else if (!lastStatus && runCount > 0) lastStatus = successCount > 0 ? 'completed' : 'failed'
  const changed = runCount !== record.runCount
    || consecutiveFailures !== record.consecutiveFailures
    || lastStatus !== record.lastStatus
  if (!changed) return { record, changed: false, legacyFolded: false }
  return {
    record: {
      ...record,
      runCount,
      consecutiveFailures,
      ...(lastStatus ? { lastStatus } : {}),
    },
    changed: true,
    legacyFolded,
  }
}

/**
 * Lazy, idempotent migration: convert every legacy row exactly once.
 *
 * R51 order is load-bearing: shell skills are ARCHIVED (and their mirror rows
 * retired) before any row is turned into a unit. R50 refreshed every row's
 * knowledge face, which re-created archived shells under their canonical path
 * with `sm-source: capability` — the next scan then saw a brand-new unit.
 * Old sequence rows are retired (never registered); old capability rows become
 * executable capabilities; old skill rows become knowledge capabilities; skill
 * files without a row become knowledge capabilities — unless they are shells.
 */
export async function migrateCapabilities(store: Store, options: {
  /** Legacy skill root override (shell archiving only). */
  root?: string
  /** R52: capability knowledge root override (defaults to resolveCapabilityRoot). */
  capabilityRoot?: string
  now?: number
  logger?: { info: (msg: string) => void }
} = {}): Promise<CapabilityMigrationReport> {
  const now = options.now ?? Date.now()
  const report: CapabilityMigrationReport = {
    migratedCapabilities: 0, migratedKnowledge: 0, retiredComposites: 0,
    linkedSkills: 0, generatedSkills: 0, expiredProposals: 0,
    archivedShells: 0, retiredShellUnits: 0, dedupedKnowledge: 0,
    movedDocs: 0, archivedDocDirs: 0, skippedManualDocs: 0,
    versionsReconciled: 0, healthReconciled: 0, changed: false,
  }
  // R51: archive shell skill directories before migrating rows. archiveShellSkills
  // also retires their mirror rows (kind skill/knowledge) when a store is given.
  const roots = new Set<string>()
  if (options.root) roots.add(options.root)
  for (const [, row] of store.toolMemory.entries()) {
    // Only a REAL workspace directory may contribute a root: resolveSkillRoot()
    // walks up to the nearest .git, so a synthetic key ("ws-r50") would point at
    // the caller's own checkout. Never let a fixture touch a real skill root.
    if (!row.workspaceKey || row.workspaceKey === 'unknown' || !isAbsolute(row.workspaceKey) || !existsSync(row.workspaceKey)) continue
    try { roots.add(resolveSkillRoot(row.workspaceKey).root) } catch { /* no project root */ }
  }
  try {
    const archived = await archiveShellSkills({ roots: [...roots], store, now })
    report.archivedShells = archived.totalArchived
    if (archived.totalArchived > 0) report.changed = true
  } catch { /* archiving never blocks migration */ }
  const seen = new Map<string, string>()
  for (const [id, row] of [...store.toolMemory.entries()]) {
    // R51: a retired row is audit history — never revive it (R50 turned retired
    // shell rows into knowledge units and regenerated their SKILL.md).
    if (row.status === 'retired' && (row.kind === 'skill' || row.kind === 'knowledge')) continue
    if (row.kind === 'composite' || row.kind === 'workflow') {
      let raw: Record<string, unknown> | undefined
      try { raw = JSON.parse(row.entry) as Record<string, unknown> } catch { raw = undefined }
      if (!raw || raw.kind !== 'capability' || !str(raw.entry)) {
        if (row.status !== 'retired') {
          await store.toolMemory.update(id, (record) => ({ ...record, status: 'retired' }))
          report.retiredComposites += 1
          report.changed = true
        }
        continue
      }
      const record = legacyCapabilityRecord(raw, row)
      const key = (row.workspaceKey ?? 'global') + '|' + record.name
      if (seen.has(key)) {
        await store.toolMemory.update(id, (r) => ({ ...r, status: 'retired' }))
        report.retiredComposites += 1
        continue
      }
      seen.set(key, id)
      await saveCapabilityRecord(store, record, { id, workspaceKey: row.workspaceKey, createdAt: row.createdAt ?? now })
      report.migratedCapabilities += 1
      report.changed = true
      options.logger?.info('supermemory: migrated capability ' + record.name + ' -> ' + capabilityToolName(record.name))
      continue
    }
    if (row.kind === 'proposal') {
      const parsed = readCapabilityRow(row, id)
      if (parsed && parsed.record.expiresAt !== undefined && parsed.record.expiresAt < now && parsed.record.proposalStatus === 'pending') {
        parsed.record.proposalStatus = 'declined'
        await saveCapabilityRecord(store, parsed.record, { id, workspaceKey: row.workspaceKey, createdAt: row.createdAt })
        report.expiredProposals += 1
      }
      continue
    }
    if (row.kind === 'skill') {
      const parsed = readCapabilityRow(row, id)
      if (!parsed) continue
      const record = parsed.record
      if (isShellUnit(record)) {
        await retireUnitRow(store, id)
        report.retiredShellUnits += 1
        report.changed = true
        continue
      }
      record.kind = 'knowledge'
      record.entry = ''
      record.runnable = false
      record.source = record.source === 'manual' ? 'manual' : 'migrated'
      const key = (row.workspaceKey ?? 'global') + '|' + record.name
      if (seen.has(key)) continue
      seen.set(key, id)
      await saveCapabilityRecord(store, record, { id, workspaceKey: row.workspaceKey, createdAt: row.createdAt })
      report.migratedKnowledge += 1
      report.changed = true
      continue
    }
    if (row.kind === 'knowledge' || row.kind === 'capability') {
      const parsed = readCapabilityRow(row, id)
      if (!parsed) continue
      if (isShellUnit(parsed.record)) {
        await retireUnitRow(store, id)
        report.retiredShellUnits += 1
        report.changed = true
        continue
      }
      const key = (row.workspaceKey ?? 'global') + '|' + parsed.record.name
      if (seen.has(key)) continue
      seen.set(key, id)
      // Legacy-shaped JSON (no schema marker) gets rewritten once.
      let legacy = false
      try { legacy = (JSON.parse(row.entry) as Record<string, unknown>).schema !== CAPABILITY_SCHEMA } catch { legacy = true }
      if (legacy) {
        await saveCapabilityRecord(store, parsed.record, { id, workspaceKey: row.workspaceKey, createdAt: row.createdAt })
        report.changed = true
      }
      continue
    }
  }
  // R52: capability knowledge leaves every host skill root. Manual and
  // third-party skills keep living in the DSH skill catalog — this pass only
  // moves files owned by a capability row (frontmatter sm-source: capability).
  try {
    const docs = await migrateCapabilityDocs(store, { now, ...(options.capabilityRoot ? { capabilityRoot: options.capabilityRoot } : {}), ...(options.logger ? { logger: options.logger } : {}) })
    report.movedDocs = docs.moved
    report.archivedDocDirs = docs.archivedDirs
    report.skippedManualDocs = docs.skippedManual
    if (docs.changed) report.changed = true
  } catch (error) {
    options.logger?.info('supermemory: capability doc migration failed: ' + String(error).slice(0, 160))
  }
  // R54: the knowledge-face version ledger is monotonic. Take the max of the
  // record, the live file and every archived copy, then rewrite the live file AT
  // that version with the restoration recorded in its changelog (idempotent).
  try {
    const versions = await reconcileCapabilityVersions(store, {
      now,
      ...(options.capabilityRoot ? { capabilityRoot: options.capabilityRoot } : {}),
      ...(options.root ? { skillsRoot: options.root } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    })
    report.versionsReconciled = versions.reconciled
    if (versions.changed) report.changed = true
  } catch (error) {
    options.logger?.info('supermemory: capability version reconcile failed: ' + String(error).slice(0, 160))
  }
  // R54: fold legacy success/fail counters into runCount so the health reading
  // (runCount / loadsToRuns / successRate / lastStatus) is internally coherent.
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind === 'proposal' || entry.row.status === 'retired') continue
    const health = reconcileCapabilityHealth(entry.record)
    if (!health.changed) continue
    await saveCapabilityRecord(store, health.record, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
    report.healthReconciled += 1
    report.changed = true
  }
  // R51: one record, two faces. A knowledge row that mirrors the exact SKILL.md
  // of an executable capability is a duplicate left by R50's row + file walks;
  // retire it instead of listing it as a second unit.
  const capabilityPaths = new Map<string, string>()
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind !== 'capability' || !entry.record.skillPath) continue
    capabilityPaths.set(normalizePathKey(entry.record.skillPath), entry.record.name)
  }
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind !== 'knowledge' || entry.row.status === 'retired' || !entry.record.skillPath) continue
    if (!capabilityPaths.has(normalizePathKey(entry.record.skillPath))) continue
    await retireUnitRow(store, entry.id)
    report.dedupedKnowledge += 1
    report.changed = true
  }
  // Refresh/generate the knowledge face of every capability. For LINKED manual
  // skills (no markers yet) this is the first touch: only the facts block is
  // appended, the human prose stays byte-identical.
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind === 'proposal') continue
    // R51: retired rows stay untouched (no file regeneration), and a shell unit
    // is retired instead of being given a fresh knowledge face.
    if (entry.row.status === 'retired') continue
    if (isShellUnit(entry.record)) {
      await retireUnitRow(store, entry.id)
      report.retiredShellUnits += 1
      report.changed = true
      continue
    }
    let root = options.capabilityRoot
    const owned = entry.row.workspaceKey
    if (!root && owned && owned !== 'unknown' && isAbsolute(owned) && existsSync(owned)) {
      try { root = resolveCapabilityRoot(owned).root } catch { root = undefined }
    }
    if (!root) continue
    try {
      const result = await syncCapabilitySkill(store, entry, root, { now })
      if (result && result.status === 'created') report.generatedSkills += 1
      if (result && result.status !== 'unchanged') report.changed = true
    } catch { /* a broken skill root never blocks migration */ }
  }
  return report
}

/** Synchronise one capability's SKILL.md (knowledge face). */
export async function syncCapabilitySkill(
  store: Store,
  entry: CapabilityRow,
  root: string,
  options: { now?: number; changelog?: string; draftBody?: string } = {},
): Promise<{ status: string; version: number; path?: string; bodyHash?: string; factsHash?: string; body?: string; factsBlock?: string } | undefined> {
  const record = entry.record
  if (record.kind === 'proposal') return undefined
  // R51: never materialise a knowledge face for a tool-order shell — that is how
  // an archived R45 shell came back as a brand-new unit under R50.
  if (isShellUnit(record)) return undefined
  const input = {
    name: record.name,
    title: record.title,
    description: record.description,
    ...(record.entry ? { entry: record.entry } : {}),
    ...(!record.entry && record.entryDraft ? { entryDraft: record.entryDraft } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.doc ? { doc: record.doc } : {}),
    ...(record.dryRunArg ? { dryRunArg: record.dryRunArg } : {}),
    writeConfirm: record.writeConfirm,
    runnable: record.runnable,
    ...(record.taskKey ? { taskKey: record.taskKey } : {}),
    tags: record.tags,
    source: record.source,
    version: record.version,
    ...(record.routeNote ? { routeNote: record.routeNote } : {}),
    facts: record.facts,
  }
  const result = await upsertCapabilitySkill({
    store,
    workspaceKey: entry.row.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : 'unknown'),
    root,
    input,
    ...(options.draftBody ?? record.draftBody ? { draftBody: options.draftBody ?? record.draftBody } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.changelog ? { changelog: options.changelog } : {}),
    ...(record.bodyHash ? { previousBodyHash: record.bodyHash } : {}),
  })
  const next: CapabilityRecord = {
    ...record,
    skillPath: result.path ?? record.skillPath,
    bodyHash: result.bodyHash ?? record.bodyHash,
    factsHash: result.factsHash ?? record.factsHash,
    // R54: mirror the file's (now monotonic) version into the record so the two
    // ledgers never drift and the next boot never "restores" a stale number.
    version: Math.max(record.version, Math.floor(Number(result.version) || 0)),
  }
  if (result.status !== 'error') {
    await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
  }
  return result
}

// ---------------------------------------------------------------------------
// Registration (manual / proposal acceptance / builtin seeding)
// ---------------------------------------------------------------------------

export interface CapabilityInput {
  /** Logical name (git-sync-supermemory). Tool name is derived. */
  name: string
  title?: string
  description: string
  /** Entry command. Empty = knowledge-only. */
  entry?: string
  entryDraft?: string
  doc?: string
  scope?: string
  runnable?: boolean
  dryRunArg?: string
  writeConfirm?: boolean
  routeNote?: string
  tags?: string[]
  changelog?: string
  source?: CapabilitySource
  taskKey?: string
  /** Optional six-section body; absent = generated skeleton. */
  body?: string
}

export function isValidCapabilityName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(String(name ?? ''))
}

/** Build + validate one capability record (pure). */
export function buildCapabilityRecord(input: CapabilityInput): { status: 'ok'; record: CapabilityRecord } | { status: 'error'; message: string } {
  const rawName = String(input.name ?? '').trim()
  // Reject non-slug input as given; historical tool names are normalised by the
  // migration path (legacyCapabilityRecord), not by new registrations.
  if (!isValidCapabilityName(rawName)) {
    return { status: 'error', message: '能力名称只能包含字母/数字/-/_（≤41 字符）且以字母或数字开头。' }
  }
  const logical = capabilityLogicalName(rawName)
  const description = String(input.description ?? '').trim()
  if (!description) return { status: 'error', message: '描述不能为空（模型靠它路由到本能力）。' }
  if (description.length > 500) return { status: 'error', message: '描述过长（≤500 字符）。' }
  const entry = String(input.entry ?? '').trim()
  const entryDraft = String(input.entryDraft ?? '').trim()
  if (entry.length > 300 || entryDraft.length > 300) return { status: 'error', message: '入口命令过长（≤300 字符）。' }
  const kind: 'capability' | 'knowledge' = entry || entryDraft ? 'capability' : 'knowledge'
  const record: CapabilityRecord = {
    schema: CAPABILITY_SCHEMA,
    name: logical,
    kind,
    title: String(input.title ?? '').trim().slice(0, 80) || logical,
    description,
    tags: (input.tags && input.tags.length > 0 ? input.tags : [logical]).map((tag) => String(tag).slice(0, 24)).slice(0, 8),
    entry,
    entryDraft,
    entryVerified: Boolean(entry) && !entryDraft,
    doc: String(input.doc ?? '').trim().slice(0, 300),
    scope: String(input.scope ?? '').trim().slice(0, 300),
    runnable: Boolean(entry) && (input.runnable === undefined ? true : Boolean(input.runnable)),
    enabled: true,
    dryRunArg: String(input.dryRunArg ?? '').trim().slice(0, 80),
    writeConfirm: Boolean(input.writeConfirm),
    routeNote: String(input.routeNote ?? '').trim().slice(0, 500),
    source: input.source ?? 'manual',
    taskKey: String(input.taskKey ?? '').trim().slice(0, 120),
    version: 1,
    updatedAt: Date.now(),
    changelog: [],
    skillPath: '',
    bodyHash: '',
    factsHash: '',
    facts: {},
    loadCount: 0,
    runCount: 0,
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    builtin: false,
  }
  if (kind === 'capability' && entryDraft && !entry) {
    record.entryVerified = false
    record.runnable = false
  }
  return { status: 'ok', record }
}

/** Live registrations of the execution face (tool name -> disposer). */
const liveCapabilities = new Map<string, () => void>()
export const liveCapabilityToolNames = new Set<string>()

export function liveCapabilityNames(): string[] {
  return [...liveCapabilityToolNames]
}

export function disposeCapabilityTool(toolName: string): void {
  const dispose = liveCapabilities.get(toolName)
  if (dispose) { try { dispose() } catch { /* already gone */ } }
  liveCapabilities.delete(toolName)
  liveCapabilityToolNames.delete(toolName)
}

/** One capability execution result (tool output and the webui endpoint share it). */
export interface CapabilityRunResult {
  status: 'completed' | 'failed' | 'needs-confirm'
  exitCode?: number
  stdout: string
  stderr: string
  durationMs: number
  dryRun: boolean
  command: string
  summary: string
}

const OUTPUT_CLIP = 8000
const TIMEOUT_MS = 120000
const PATH_SEP = process.platform === 'win32' ? ';' : ':'

function clipOutput(text: string): string {
  return text.length > OUTPUT_CLIP ? text.slice(0, OUTPUT_CLIP) + '\n…（输出过长已截断，原 ' + text.length + ' 字符）' : text
}

/** PATH fallback so node/pnpm resolve even when the host inherited a stripped PATH. */
export function capabilityExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const variants = Object.keys(env).filter((name) => name.toLowerCase() === 'path')
  const key = variants[0] ?? 'PATH'
  for (const variant of variants.slice(1)) delete env[variant]
  const parts = String(env[key] ?? '').split(PATH_SEP).map((part) => part.trim()).filter(Boolean)
  const seen = new Set(parts.map((part) => (process.platform === 'win32' ? part.toLowerCase() : part)))
  const candidates: string[] = []
  const add = (dir: string | undefined): void => { if (dir && isAbsolute(dir)) candidates.push(dir) }
  add(dirname(process.execPath))
  add(env.PNPM_HOME)
  if (process.platform === 'win32') {
    if (env.APPDATA) add(join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'pnpm'))
    if (env.ProgramFiles) add(join(env.ProgramFiles, 'nodejs'))
    if (env['ProgramFiles(x86)']) add(join(env['ProgramFiles(x86)'], 'nodejs'))
  }
  for (const dir of candidates) {
    const dedupe = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(dedupe) || !existsSync(dir)) continue
    seen.add(dedupe)
    parts.push(dir)
  }
  env[key] = parts.join(PATH_SEP)
  return env
}

/** Execute one capability entry inside its scope (default dry-run; writeConfirm gate). */
export function runCapability(record: CapabilityRecord, options: { dryRun?: boolean; confirm?: boolean } = {}): CapabilityRunResult {
  if (record.kind !== 'capability' || !record.entry) {
    return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: Boolean(options.dryRun), command: '', summary: '不是可执行的能力（缺少入口命令）。' }
  }
  if (record.runnable === false || record.enabled === false) {
    return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: Boolean(options.dryRun), command: record.entry, summary: '该能力未开放执行（runnable/enabled=false）。' }
  }
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : (options.confirm === true ? false : Boolean(record.dryRunArg))
  const command = dryRun && record.dryRunArg ? record.entry + ' ' + record.dryRunArg : record.entry
  if (dryRun && record.writeConfirm && !record.dryRunArg) {
    return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun, command, summary: '该能力标记了写操作确认但未定义预演参数，无法预演；确认执行请显式传 confirm=true。' }
  }
  if (!dryRun && record.writeConfirm && options.confirm !== true) {
    return { status: 'needs-confirm', stdout: '', stderr: '', durationMs: 0, dryRun, command, summary: '该能力真实执行可能写远端/改状态：确认执行请显式传 confirm=true；只要预演可保持缺省。' }
  }
  const started = Date.now()
  const child = spawnSync(command, {
    shell: true,
    cwd: record.scope && record.scope.trim() ? record.scope : process.cwd(),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: capabilityExecEnv(),
  })
  const durationMs = Date.now() - started
  const exitCode = typeof child.status === 'number' ? child.status : undefined
  const failed = Boolean(child.error) || exitCode === undefined
  return {
    status: failed ? 'failed' : (exitCode === 0 ? 'completed' : 'failed'),
    exitCode,
    stdout: clipOutput(String(child.stdout ?? '')),
    stderr: clipOutput(String(child.stderr ?? '')),
    durationMs,
    dryRun,
    command,
    summary: command + ' → ' + (child.error ? '启动失败：' + String(child.error).slice(0, 120) : 'exit ' + exitCode) + '（' + (dryRun ? '预演' : '实跑') + '，' + durationMs + 'ms）',
  }
}

/** R52: how many capabilities the pre-step index card may carry. */
export const CAPABILITY_INDEX_MAX = 8

/** R52: default character budget for the capability index card. */
export const CAPABILITY_INDEX_BUDGET = 1600

export interface CapabilityIndexInput {
  name: string
  title: string
  description: string
  scope?: string
  whenToUse?: string
  entry?: string
  runnable?: boolean
  entryDraft?: string
  entryVerified?: boolean
  enabled?: boolean
  kind?: string
  status?: string
}

/**
 * R54: the index line's「何时用」sentence prefers the human TITLE.
 *
 * R52 rendered whatever `whenToUse` the caller passed, so a hint that named the
 * MACHINE name (git-sync-supermemory) contradicted the human title shown by the
 * panel (「git 同步/提交/推送（SuperMemory 仓库）」). The card now derives the
 * subject from `title`; a supplied sentence is kept only when it already names
 * that title (it usually also carries the scope), and rows without a title fall
 * back to description/whenToUse exactly as before.
 */
export function capabilityIndexHint(row: CapabilityIndexInput): string {
  const title = String(row.title ?? '').trim()
  const name = String(row.name ?? '').trim()
  const supplied = String(row.whenToUse ?? '').replace(/\s+/g, ' ').trim()
  if (title && title !== name) {
    if (supplied && supplied.includes(title)) return supplied
    const scope = String(row.scope ?? '').trim()
    return scope ? '在 ' + scope + ' 内遇到「' + title + '」类任务时加载。' : '遇到「' + title + '」类任务时加载。'
  }
  return supplied || String(row.description ?? '').replace(/\s+/g, ' ').trim()
}

/** 徽标：可执行 / 仅知识 / 入口待验证。 */
export function capabilityIndexBadge(row: CapabilityIndexInput): string {
  if (row.entryDraft && !row.entryVerified) return '入口待验证'
  if (row.entry && row.runnable !== false) return '可执行'
  return '仅知识'
}

/**
 * R52: the compact capability index injected into hub/branch sessions. The body
 * is NOT here — the model calls `sm_cap_doc` for it. Budget-aware (R47): rows
 * degrade with an explicit omission note instead of being hard-sliced.
 */
export function renderCapabilityIndex(rows: CapabilityIndexInput[], options: {
  maxItems?: number
  budget?: number
} = {}): { text: string; included: number; omitted: number; truncated: boolean } {
  const maxItems = Math.max(1, Math.min(options.maxItems ?? CAPABILITY_INDEX_MAX, CAPABILITY_INDEX_MAX))
  const budget = Math.max(160, options.budget ?? CAPABILITY_INDEX_BUDGET)
  const eligible = rows
    .filter((row) => row.enabled !== false && row.status !== 'retired' && row.kind !== 'proposal')
    .sort((left, right) => left.name.localeCompare(right.name))
  if (eligible.length === 0) return { text: '', included: 0, omitted: 0, truncated: false }
  const header = '[SuperMemory 可用能力]（仅中枢/分支会话注入；正文按需读取）'
  const footer = '正文用 sm_cap_doc 加载：sm_cap_doc { name: "<能力名>" }；第三方 skill 仍走宿主 skill 目录。'
  const lines = eligible.map((row) => {
    const hint = capabilityIndexHint(row)
    const clipped = clipAtBoundary(hint, 80) || hint.slice(0, 80)
    return '- ' + row.name + ' [' + capabilityIndexBadge(row) + ']：' + clipped
  })
  let kept = lines.slice(0, maxItems)
  let omitted = lines.length - kept.length
  const build = (): string => [
    header,
    ...kept,
    ...(omitted > 0 ? ['… 省略 ' + omitted + ' 条（sm_cap_doc 可逐个读取）'] : []),
    footer,
  ].join('\n')
  while (kept.length > 0 && charCount(build()) > budget) {
    kept = kept.slice(0, -1)
    omitted += 1
  }
  const text = build()
  if (kept.length === 0 && charCount(text) > budget) {
    return { text: clipAtBoundary(header + '…（预算不足，正文用 sm_cap_doc 读取）', budget), included: 0, omitted: lines.length, truncated: true }
  }
  return { text, included: kept.length, omitted, truncated: omitted > 0 }
}

/** Derive the "when to use" sentence for one capability. */
export function capabilityWhenToUse(record: Pick<CapabilityRecord, 'title' | 'description' | 'scope'>): string {
  if (record.scope) return '在 ' + record.scope + ' 内遇到「' + record.title + '」类任务时加载。'
  return record.description
}

/** Extract one `## <section>` block from a capability body. */
export function extractCapabilitySection(body: string, section: string): { text: string; headings: string[] } | undefined {
  const wanted = String(section ?? '').trim().replace(/^#+\s*/, '').toLowerCase()
  if (!wanted) return undefined
  const lines = String(body ?? '').split(/\r?\n/)
  const headings: string[] = []
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (!match) continue
    headings.push(match[1])
    if (start < 0 && match[1].toLowerCase() === wanted) start = index
  }
  if (start < 0) return { text: '', headings }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? '')) { end = index; break }
  }
  return { text: lines.slice(start, end).join('\n').trim(), headings }
}

export interface CapabilityDocLoad {
  status: 'ok' | 'error'
  message: string
  name?: string
  title?: string
  body?: string
  factsBlock?: string
  entry?: string
  scope?: string
  dryRunArg?: string
  writeConfirm?: boolean
  whenToUse?: string
  headings?: string[]
  loadCount?: number
}

/**
 * R52: load one capability knowledge body on demand (the `sm_cap_doc` tool's
 * single source of truth). Only enabled, non-retired units whose file exists are
 * readable; a successful load increments loadCount (conversion-rate denominator).
 */
export async function loadCapabilityDoc(store: Store, workspaceKey: string | undefined, rawName: string, section?: string): Promise<CapabilityDocLoad> {
  const raw = String(rawName ?? '').trim()
  if (!raw) return { status: 'error', message: '缺少能力名。' }
  const logical = capabilityLogicalName(raw)
  const rows = capabilityRows(store, workspaceKey)
  const entry = rows.find((row) => row.record.name === logical)
    ?? rows.find((row) => capabilityToolName(row.record.name) === raw)
    ?? rows.find((row) => capabilitySkillName(row.record.name) === raw)
  if (!entry) return { status: 'error', message: '能力不存在：' + raw + '（可在「固化能力」面板查看可用能力）。' }
  const record = entry.record
  if (record.kind === 'proposal') return { status: 'error', message: '能力「' + record.name + '」还是待接受提案，尚未生成知识面。' }
  if (record.enabled === false || entry.row.status === 'retired') return { status: 'error', message: '能力「' + record.name + '」已停用：不加载知识面。' }
  if (record.kind === 'capability' && record.runnable === false) return { status: 'error', message: '能力「' + record.name + '」的执行面尚未启用（入口待验证）：先人工启用执行。' }
  const path = String(record.skillPath ?? '').trim()
  if (!path || !existsSync(path)) return { status: 'error', message: '能力「' + record.name + '」的知识面文件缺失：' + (path || '（未生成）') + '；在面板保存正文可重建。' }
  let parsed: ReturnType<typeof parseSkillMarkdown>
  try { parsed = parseSkillMarkdown(readFileSync(path, 'utf8'), capabilitySkillName(record.name)) } catch { parsed = undefined }
  if (!parsed) return { status: 'error', message: '能力「' + record.name + '」的知识面文件解析失败：' + path }
  const fullBody = parsed.body
  let body = fullBody
  let headings: string[] | undefined
  if (section !== undefined && String(section).trim() !== '') {
    const found = extractCapabilitySection(fullBody, section)
    if (!found) {
      headings = extractCapabilitySection(fullBody, '__none__')?.headings ?? []
      return { status: 'error', message: '知识面没有小节「' + String(section).trim() + '」；可用小节：' + (headings.join('、') || '（无二级标题）'), headings }
    }
    if (!found.text) {
      headings = found.headings
      return { status: 'error', message: '知识面没有小节「' + String(section).trim() + '」；可用小节：' + (found.headings.join('、') || '（无二级标题）'), headings: found.headings }
    }
    body = found.text
    headings = found.headings
  }
  const next: CapabilityRecord = { ...record, loadCount: record.loadCount + 1 }
  try {
    await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
  } catch { /* the readable body is more important than one counter */ }
  return {
    status: 'ok',
    message: '已加载能力「' + record.name + '」的知识面（sm_cap_doc）。',
    name: record.name,
    title: record.title,
    body,
    factsBlock: splitFactsBlock(fullBody).facts,
    entry: record.entry,
    scope: record.scope,
    dryRunArg: record.dryRunArg,
    writeConfirm: Boolean(record.writeConfirm),
    whenToUse: capabilityWhenToUse(record),
    ...(headings ? { headings } : {}),
    loadCount: next.loadCount,
  }
}

/** R52: current knowledge-face body (frontmatter stripped) for the panel editor. */
export function capabilityBodyOf(record: Pick<CapabilityRecord, 'name' | 'skillPath'>): string {
  const path = String(record.skillPath ?? '').trim()
  if (!path || !existsSync(path)) return ''
  try {
    return parseSkillMarkdown(readFileSync(path, 'utf8'), capabilitySkillName(record.name))?.body ?? ''
  } catch {
    return ''
  }
}

/** Model-visible description of one capability (routing note + semantics + rules). */
export function capabilityToolDescription(record: CapabilityRecord): string {
  const semantics = '（能力：在适用范围 ' + (record.scope || '当前目录') + ' 内执行入口命令 ' + record.entry + ' 的固定入口；'
    + (record.dryRunArg ? '默认追加预演参数 ' + record.dryRunArg + '（只读不改）；' : '')
    + (record.writeConfirm ? '真实执行可能写远端/改状态：confirm=true 表示确认真实执行；' : '')
    + (record.doc ? '详细流程见 ' + record.doc + '；' : '')
    + '返回 exitCode/stdout/stderr/durationMs。）'
  return record.description + (record.routeNote ? '。' + record.routeNote : '') + semantics + '\n' + CAPABILITY_ROUTING_RULES
}

function callerCwd(exec: { agent?: unknown }): string | undefined {
  const cwd = (exec.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** The single model-visible tool of one capability (fixed entry, dry_run/confirm only). */
export function capabilityToolDef(store: Store, record: CapabilityRecord, rowId: string, workspaceKey?: string) {
  return {
    name: capabilityToolName(record.name),
    description: capabilityToolDescription(record),
    parameters: {
      dry_run: { type: 'boolean', description: 'true=强制预演；缺省时若能力定义了预演参数则自动预演' },
      confirm: { type: 'boolean', description: '真实执行写操作能力（writeConfirm）时的二次确认，必须为 true' },
    } as never,
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['completed', 'failed', 'needs-confirm'], required: true },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          durationMs: { type: 'integer' },
          dryRun: { type: 'boolean' },
          command: { type: 'string' },
          summary: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { status?: string; summary?: string }
        return [{ type: 'text', text: (v.status === 'needs-confirm' ? '需要确认：' : '') + String(v.summary ?? '') }]
      },
    },
    async execute(args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown; toolSet?: unknown }) {
      const parsed = readCapabilityRow(store.toolMemory.get(rowId), rowId)
      if (!parsed || !isExecutable(parsed.record)) {
        return { status: 'failed' as const, stdout: '', stderr: '', durationMs: 0, dryRun: false, command: '', summary: '能力不存在或已停用。' }
      }
      const recordNow = parsed.record
      const cwd = callerCwd(exec)
      // Scope is the stronger, more specific rule: a caller outside the scope is
      // refused even before the workspace-key comparison.
      if (cwd && recordNow.scope && !scopeContains(recordNow.scope, cwd)) {
        return { status: 'failed' as const, stdout: '', stderr: '', durationMs: 0, dryRun: false, command: recordNow.entry, summary: '当前目录不在能力适用范围 ' + recordNow.scope + ' 内：不执行（scope 外拒绝）。' }
      }
      if (cwd && workspaceKey && !capabilityAppliesToWorkspace(recordNow, workspaceKeyOf(cwd), workspaceKey)) {
        return { status: 'failed' as const, stdout: '', stderr: '', durationMs: 0, dryRun: false, command: recordNow.entry, summary: '该能力适用于其他工作区：不执行（工作区隔离）。' }
      }
      const result = runCapability(recordNow, {
        ...(typeof args.dry_run === 'boolean' ? { dryRun: args.dry_run } : {}),
        ...(typeof args.dryRun === 'boolean' ? { dryRun: args.dryRun } : {}),
        ...(typeof args.confirm === 'boolean' ? { confirm: args.confirm } : {}),
      })
      if (result.status !== 'needs-confirm') await bumpCapabilityRun(store, rowId, result)
      if (result.status === 'failed') {
        const latest = readCapabilityRow(store.toolMemory.get(rowId), rowId)
        const failures = latest?.record.consecutiveFailures ?? 0
        if (failures >= 2) {
          return { ...result, summary: result.summary + '\n连续失败 ' + failures + ' 次：请更新本能力的事实块/文档（version+1、changelog 记录原因），不要绕过闸门。' }
        }
      }
      return result
    },
  }
}

/** Register one capability tool; returns its disposer. Replaces a previous handle. */
export async function registerCapabilityTool(ctx: Context, store: Store, entry: CapabilityRow, workspaceKey?: string): Promise<() => void> {
  const toolName = capabilityToolName(entry.record.name)
  disposeCapabilityTool(toolName)
  const tools = await loadHostModule('@deepseek-ai/dsh-tools') as typeof Tools
  const disposer = ctx.tools.register(
    tools.defineTool(capabilityToolDef(store, entry.record, entry.id, workspaceKey) as never),
    { when: capabilityWhenGate(entry.record, workspaceKey) },
  )
  liveCapabilities.set(toolName, disposer)
  liveCapabilityToolNames.add(toolName)
  return disposer
}

/** Registration-side visibility gate (same semantics as execute). */
export function capabilityWhenGate(record: Pick<CapabilityRecord, 'scope'>, rowWorkspaceKey: string | undefined): (context: unknown) => boolean {
  return (context: unknown): boolean => {
    try {
      const cwd = (context as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent?.session?.header?.cwd
      if (!cwd || typeof cwd !== 'string') return true
      return capabilityAppliesToWorkspace(record, workspaceKeyOf(cwd), rowWorkspaceKey)
    } catch {
      return true
    }
  }
}

/** Record one actual execution (needs-confirm does not count). */
export async function bumpCapabilityRun(store: Store, id: string, result: CapabilityRunResult): Promise<void> {
  const parsed = readCapabilityRow(store.toolMemory.get(id), id)
  if (!parsed) return
  const record = parsed.record
  const succeeded = result.status === 'completed'
  const next: CapabilityRecord = {
    ...record,
    runCount: record.runCount + 1,
    successCount: succeeded ? record.successCount + 1 : record.successCount,
    failCount: succeeded ? record.failCount : record.failCount + 1,
    consecutiveFailures: succeeded ? 0 : record.consecutiveFailures + 1,
    lastUsedAt: Date.now(),
    lastStatus: succeeded ? 'completed' : 'failed',
    lastDryRun: result.dryRun,
    ...(typeof result.exitCode === 'number' ? { lastExitCode: result.exitCode } : {}),
    ...(result.summary ? { lastSummary: result.summary.slice(0, 200) } : {}),
  }
  try { await saveCapabilityRecord(store, next, { id, workspaceKey: parsed.row.workspaceKey, createdAt: parsed.row.createdAt }) } catch { /* counters are advisory */ }
}

/** Record one model-side skill load (knowledge face). */
export async function bumpCapabilityLoad(store: Store, callerWorkspaceKey: string | undefined, skillName: string): Promise<boolean> {
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind === 'proposal') continue
    if (capabilitySkillName(entry.record.name) !== skillName) continue
    if (callerWorkspaceKey && entry.row.workspaceKey && callerWorkspaceKey !== entry.row.workspaceKey) continue
    const next: CapabilityRecord = { ...entry.record, loadCount: entry.record.loadCount + 1 }
    try {
      await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
      return true
    } catch { return false }
  }
  return false
}

// ---------------------------------------------------------------------------
// register / edit / enable / delete
// ---------------------------------------------------------------------------

export interface CapabilityDeps {
  register: (ctx: Context, store: Store, entry: CapabilityRow, workspaceKey?: string) => Promise<() => void>
}

export function defaultCapabilityDeps(): CapabilityDeps {
  return { register: registerCapabilityTool }
}

async function ensureSkillFor(store: Store, entry: CapabilityRow, workspaceKey: string | undefined, options: { draftBody?: string; changelog?: string } = {}): Promise<CapabilityRow> {
  if (!workspaceKey || workspaceKey === 'unknown' || !isAbsolute(workspaceKey) || !existsSync(workspaceKey)) return entry
  let root: string
  try { root = resolveCapabilityRoot(workspaceKey).root } catch { return entry }
  try { await syncCapabilitySkill(store, entry, root, options) } catch { /* knowledge face is best-effort */ }
  return readCapabilityRow(store.toolMemory.get(entry.id), entry.id) ?? entry
}

async function registerIfExecutable(ctx: Context | undefined, store: Store, entry: CapabilityRow, workspaceKey: string | undefined, deps?: CapabilityDeps): Promise<void> {
  if (!ctx) return
  if (!isExecutable(entry.record)) {
    disposeCapabilityTool(capabilityToolName(entry.record.name))
    return
  }
  const hasRegistry = typeof (ctx as unknown as { tools?: { register?: unknown } }).tools?.register === 'function'
  if (!hasRegistry) return
  try {
    const seam = deps ?? defaultCapabilityDeps()
    await seam.register(ctx, store, entry, workspaceKey)
  } catch { /* a host without a registry keeps the durable row */ }
}

/**
 * Register one capability (manual path and builtin seed). Same logical name =
 * update in place: version+1, changelog, statistics and knowledge face kept.
 */
export async function registerCapability(
  ctx: Context | undefined,
  store: Store,
  input: CapabilityInput,
  workspaceKey?: string,
  deps?: CapabilityDeps,
): Promise<{ status: 'ok' | 'error'; message: string; id?: string; name?: string; tool?: string }> {
  const built = buildCapabilityRecord(input)
  if (built.status === 'error') return { status: 'error', message: built.message }
  const record = built.record
  const own = workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : undefined)
  const existing = findCapabilityRow(store, { name: record.name, ...(own ? { workspaceKey: own } : {}) })
  let id: string
  let next: CapabilityRecord
  if (existing) {
    const changeLine = String(input.changelog ?? '').trim().slice(0, 200)
      || ('更新能力定义（入口 ' + (record.entry || '无') + (record.doc ? '，文档 ' + record.doc : '') + '）')
    next = {
      ...record,
      loadCount: existing.record.loadCount,
      runCount: existing.record.runCount,
      successCount: existing.record.successCount,
      failCount: existing.record.failCount,
      consecutiveFailures: existing.record.consecutiveFailures,
      ...(existing.record.lastUsedAt !== undefined ? { lastUsedAt: existing.record.lastUsedAt } : {}),
      ...(existing.record.lastStatus ? { lastStatus: existing.record.lastStatus } : {}),
      ...(existing.record.lastDryRun !== undefined ? { lastDryRun: existing.record.lastDryRun } : {}),
      ...(existing.record.lastExitCode !== undefined ? { lastExitCode: existing.record.lastExitCode } : {}),
      ...(existing.record.lastSummary ? { lastSummary: existing.record.lastSummary } : {}),
      version: existing.record.version + 1,
      updatedAt: Date.now(),
      changelog: [changeLine, ...existing.record.changelog].slice(0, CHANGELOG_MAX),
    }
    id = await saveCapabilityRecord(store, next, { id: existing.id, workspaceKey: own ?? existing.row.workspaceKey, createdAt: existing.row.createdAt })
  } else {
    next = {
      ...record,
      version: 1,
      updatedAt: Date.now(),
      changelog: [String(input.changelog ?? '').trim().slice(0, 200) || ('注册能力（入口 ' + (record.entry || '仅知识') + '）')],
    }
    id = await saveCapabilityRecord(store, next, { workspaceKey: own })
  }
  let entry = readCapabilityRow(store.toolMemory.get(id), id) as CapabilityRow
  entry = await ensureSkillFor(store, entry, own ?? entry.row.workspaceKey, { ...(input.body ? { draftBody: input.body } : {}), ...(input.changelog ? { changelog: input.changelog } : {}) })
  await registerIfExecutable(ctx, store, entry, own ?? entry.row.workspaceKey, deps)
  const toolName = capabilityToolName(entry.record.name)
  return {
    status: 'ok',
    id,
    name: entry.record.name,
    tool: entry.record.kind === 'capability' ? toolName : capabilitySkillName(entry.record.name),
    message: (existing ? '已更新能力 ' : '已注册能力 ') + entry.record.name
      + '（v' + entry.record.version + '，' + (entry.record.entry ? '入口 ' + entry.record.entry : '仅知识') + '；'
      + (entry.record.kind === 'capability' ? '执行面工具 ' + toolName : '无执行面') + '；知识面 ' + (entry.record.skillPath || '待生成') + '）。',
  }
}

/** Enable/disable BOTH faces of one capability. */
export async function setCapabilityEnabled(ctx: Context | undefined, store: Store, id: string, enabled: boolean): Promise<{ status: 'ok' | 'error'; message: string; name?: string }> {
  const entry = readCapabilityRow(store.toolMemory.get(id), id)
  if (!entry) return { status: 'error', message: '能力不存在。' }
  const next: CapabilityRecord = {
    ...entry.record,
    enabled,
    updatedAt: Date.now(),
    version: entry.record.version + 1,
    changelog: [(enabled ? '启用' : '停用') + '（知识面与执行面同时生效）', ...entry.record.changelog].slice(0, CHANGELOG_MAX),
  }
  const row: ToolMemory = rowOfRecord(next, entry.row.workspaceKey, entry.row.createdAt)
  row.status = enabled ? 'active' : 'retired'
  await store.toolMemory.update(id, () => row)
  if (next.skillPath) {
    try {
      const { writeFileSync } = await import('node:fs')
      const text = readFileSync(next.skillPath, 'utf8').replace(/disable-model-invocation: (true|false)/, 'disable-model-invocation: ' + String(!enabled))
      writeFileSync(next.skillPath, text, 'utf8')
    } catch { /* file edit is best-effort; row status is authoritative */ }
  }
  if (enabled) await registerIfExecutable(ctx, store, entry, entry.row.workspaceKey)
  else disposeCapabilityTool(capabilityToolName(entry.record.name))
  return { status: 'ok', message: (enabled ? '已启用 ' : '已停用 ') + entry.record.name + '（知识面与执行面已同步）。', name: entry.record.name }
}

/** Human gate for an auto-drafted entry: draft becomes the verified entry. */
export async function enableCapabilityEntryDraft(ctx: Context | undefined, store: Store, id: string): Promise<{ status: 'ok' | 'error'; message: string; name?: string }> {
  const entry = readCapabilityRow(store.toolMemory.get(id), id)
  if (!entry) return { status: 'error', message: '能力不存在。' }
  if (!entry.record.entryDraft) return { status: 'error', message: '该能力没有待启用的入口草稿。' }
  const next: CapabilityRecord = {
    ...entry.record,
    kind: 'capability',
    entry: entry.record.entryDraft,
    entryDraft: '',
    entryVerified: true,
    runnable: true,
    version: entry.record.version + 1,
    updatedAt: Date.now(),
    changelog: ['人工启用执行：入口草稿已确认为入口命令（entryVerified=true）', ...entry.record.changelog].slice(0, CHANGELOG_MAX),
  }
  const row: ToolMemory = rowOfRecord(next, entry.row.workspaceKey, entry.row.createdAt)
  await store.toolMemory.update(id, () => row)
  let updated = readCapabilityRow(store.toolMemory.get(id), id) as CapabilityRow
  updated = await ensureSkillFor(store, updated, entry.row.workspaceKey, { changelog: '人工启用执行（入口草稿已验证）' })
  await registerIfExecutable(ctx, store, updated, entry.row.workspaceKey)
  return { status: 'ok', message: '已启用执行：' + updated.record.name + ' → ' + updated.record.entry + '。', name: updated.record.name }
}

/** Edit one capability definition (panel / memory_toolize). */
export async function editCapability(
  ctx: Context | undefined,
  store: Store,
  id: string,
  patch: {
    title?: string
    tags?: string[]
    description?: string
    entry?: string
    doc?: string
    scope?: string
    runnable?: boolean
    dryRunArg?: string
    writeConfirm?: boolean
    routeNote?: string
    status?: string
    enabled?: boolean
    body?: string
    changelog?: string
  },
): Promise<{ status: 'ok' | 'error'; message: string; id?: string }> {
  const entry = readCapabilityRow(store.toolMemory.get(id), id)
  if (!entry) return { status: 'error', message: '能力不存在。' }
  const record: CapabilityRecord = { ...entry.record }
  if (patch.title !== undefined) record.title = String(patch.title).slice(0, 80)
  if (patch.tags !== undefined) record.tags = patch.tags.map((tag) => String(tag)).slice(0, 8)
  if (patch.description !== undefined) record.description = String(patch.description).slice(0, 500)
  if (patch.entry !== undefined) {
    record.entry = String(patch.entry).slice(0, 300)
    if (record.entry) { record.entryVerified = true; record.kind = 'capability' }
    record.runnable = Boolean(record.entry)
  }
  if (patch.doc !== undefined) record.doc = String(patch.doc).slice(0, 300)
  if (patch.scope !== undefined) record.scope = String(patch.scope).slice(0, 300)
  if (patch.runnable !== undefined) record.runnable = Boolean(patch.runnable) && Boolean(record.entry)
  if (patch.dryRunArg !== undefined) record.dryRunArg = String(patch.dryRunArg).slice(0, 80)
  if (patch.writeConfirm !== undefined) record.writeConfirm = Boolean(patch.writeConfirm)
  if (patch.routeNote !== undefined) record.routeNote = String(patch.routeNote).slice(0, 500)
  if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'retired') {
    return { status: 'error', message: 'status 仅支持 active / retired。' }
  }
  if (patch.enabled !== undefined) record.enabled = Boolean(patch.enabled)
  if (patch.status !== undefined) record.enabled = patch.status === 'active'
  record.version = record.version + 1
  record.updatedAt = Date.now()
  record.changelog = [String(patch.changelog ?? '').trim().slice(0, 200) || '更新能力定义', ...record.changelog].slice(0, CHANGELOG_MAX)
  const row = rowOfRecord(record, entry.row.workspaceKey, entry.row.createdAt)
  await store.toolMemory.update(id, () => row)
  let updated = readCapabilityRow(store.toolMemory.get(id), id) as CapabilityRow
  updated = await ensureSkillFor(store, updated, entry.row.workspaceKey, { ...(patch.changelog ? { changelog: patch.changelog } : {}), ...(patch.body ? { draftBody: patch.body } : {}) })
  if (updated.record.enabled === false || !isExecutable(updated.record)) disposeCapabilityTool(capabilityToolName(updated.record.name))
  else await registerIfExecutable(ctx, store, updated, entry.row.workspaceKey)
  return { status: 'ok', message: '已更新能力 ' + updated.record.name + '（v' + updated.record.version + '）。', id }
}

/** Edit the human prose of one capability's knowledge face (facts block preserved). */
export async function updateCapabilitySkillBody(store: Store, id: string, body: string): Promise<{ status: 'ok' | 'error'; message: string }> {
  const entry = readCapabilityRow(store.toolMemory.get(id), id)
  if (!entry) return { status: 'error', message: '能力不存在。' }
  if (!entry.record.skillPath) return { status: 'error', message: '该能力还没有知识面文件。' }
  try {
    const { writeFileSync } = await import('node:fs')
    const text = readFileSync(entry.record.skillPath, 'utf8')
    const parsed = parseSkillMarkdown(text, capabilitySkillName(entry.record.name))
    if (!parsed) return { status: 'error', message: '知识面文件解析失败，未修改。' }
    const endOfFrontmatter = text.indexOf(parsed.body)
    const frontmatter = endOfFrontmatter >= 0 ? text.slice(0, endOfFrontmatter) : ''
    const split = splitFactsBlock(parsed.body)
    const nextBody = (String(body).trim() + (split.hasBlock ? '\n\n' + split.facts : '')).trim()
    writeFileSync(entry.record.skillPath, frontmatter + nextBody + '\n', 'utf8')
    const next: CapabilityRecord = {
      ...entry.record,
      bodyHash: bodyHashOf(nextBody),
      version: entry.record.version + 1,
      updatedAt: Date.now(),
      changelog: ['人工编辑知识面正文（事实块保留）', ...entry.record.changelog].slice(0, CHANGELOG_MAX),
    }
    await saveCapabilityRecord(store, next, { id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
    return { status: 'ok', message: '正文已保存（事实块保留）。' }
  } catch (error) {
    return { status: 'error', message: '保存正文失败：' + String(error).slice(0, 160) }
  }
}

/** Delete one capability: archive its knowledge file (never hard-delete), unregister, drop row. */
export async function deleteCapability(ctx: Context | undefined, store: Store, id: string): Promise<{ status: 'ok' | 'error'; message: string; archivePath?: string }> {
  const entry = readCapabilityRow(store.toolMemory.get(id), id)
  if (!entry) return { status: 'error', message: '能力不存在。' }
  disposeCapabilityTool(capabilityToolName(entry.record.name))
  let archivePath: string | undefined
  if (entry.record.skillPath) {
    if (/\.md$/i.test(entry.record.skillPath)) {
      const archived = await archiveCapabilityDoc(dirname(entry.record.skillPath), entry.record.name, { reason: '能力删除：知识面归档' })
      archivePath = archived?.archivePath
    } else {
      // Pre-R52 row still pointing at a skill directory: archive the directory.
      const root = dirname(dirname(entry.record.skillPath))
      const archived = await archiveCapabilitySkill(root, capabilitySkillName(entry.record.name), { reason: '能力删除：知识面归档' })
      archivePath = archived?.archivePath
    }
  }
  await store.toolMemory.delete(id)
  return { status: 'ok', message: '已删除能力 ' + entry.record.name + (archivePath ? '（知识面已归档到 ' + archivePath + '，可回滚）' : '') + '。', ...(archivePath ? { archivePath } : {}) }
}

// ---------------------------------------------------------------------------
// Builtin merge + rebuild + health
// ---------------------------------------------------------------------------

export interface BuiltinMergeReport {
  seeded: string[]
  upgraded: string[]
  current: string[]
  localNewer: string[]
  changed: CapabilityRow[]
}

export async function mergeBuiltinCapabilities(store: Store, options: { logger?: { info: (msg: string) => void } } = {}): Promise<BuiltinMergeReport> {
  const report: BuiltinMergeReport = { seeded: [], upgraded: [], current: [], localNewer: [], changed: [] }
  for (const builtin of BUILTIN_CAPABILITIES) {
    const target = capabilityLogicalName(builtin.name)
    const existing = capabilityRows(store).find((entry) => entry.record.name === target)
    if (!existing) {
      const { changelog: builtinChangelog, ...builtinBase } = builtin
      const built = buildCapabilityRecord({ ...builtinBase, source: 'builtin', ...(builtinChangelog?.[0] ? { changelog: builtinChangelog[0] } : {}) })
      if (built.status === 'error') continue
      built.record.version = builtin.version
      built.record.changelog = [...(builtin.changelog ?? [])]
      built.record.builtin = true
      built.record.builtinVersion = builtin.version
      built.record.entryVerified = true
      built.record.source = 'builtin'
      const id = await saveCapabilityRecord(store, built.record, { workspaceKey: builtin.scope ? workspaceKeyOf(builtin.scope) : undefined })
      const entry = readCapabilityRow(store.toolMemory.get(id), id) as CapabilityRow
      const synced = await ensureSkillFor(store, entry, entry.row.workspaceKey, { changelog: '内置能力播种：生成知识面' })
      report.seeded.push(synced.record.name)
      report.changed.push(synced)
      continue
    }
    // R54: the restored knowledge-face ledger may sit ABOVE the builtin
    // definition version (a v8 document for a v6 definition is legitimate). The
    // definition lineage is tracked separately in builtinVersion, so upgrades are
    // still applied when the builtin definition itself moved forward.
    const builtinSeen = existing.record.builtinVersion
    const definitionOlder = existing.record.version < builtin.version
      || (builtinSeen !== undefined && builtinSeen < builtin.version)
    if (!definitionOlder) {
      if (builtinSeen === undefined && existing.record.version > builtin.version) report.localNewer.push(existing.record.name)
      else report.current.push(existing.record.name)
      continue
    }
    const { changelog: upgradeChangelog, ...upgradeBase } = builtin
    const built = buildCapabilityRecord({ ...upgradeBase, source: 'builtin', ...(upgradeChangelog?.[0] ? { changelog: upgradeChangelog[0] } : {}) })
    if (built.status === 'error') continue
    const next: CapabilityRecord = {
      ...existing.record,
      ...built.record,
      loadCount: existing.record.loadCount,
      runCount: existing.record.runCount,
      successCount: existing.record.successCount,
      failCount: existing.record.failCount,
      consecutiveFailures: existing.record.consecutiveFailures,
      ...(existing.record.lastUsedAt !== undefined ? { lastUsedAt: existing.record.lastUsedAt } : {}),
      ...(existing.record.lastStatus ? { lastStatus: existing.record.lastStatus } : {}),
      // Never downgrade a restored knowledge-face version on upgrade.
      version: Math.max(existing.record.version, builtin.version),
      updatedAt: Date.now(),
      changelog: [...(builtin.changelog ?? []), ...existing.record.changelog].slice(0, CHANGELOG_MAX),
      builtin: true,
      builtinVersion: builtin.version,
      entryVerified: true,
    }
    const previousScopeKey = existing.record.scope ? workspaceKeyOf(existing.record.scope) : undefined
    const nextScopeKey = next.scope ? workspaceKeyOf(next.scope) : undefined
    const inherited = Boolean(existing.row.workspaceKey && previousScopeKey && existing.row.workspaceKey === previousScopeKey)
    const workspaceKey = inherited && nextScopeKey ? nextScopeKey : existing.row.workspaceKey
    await saveCapabilityRecord(store, next, { id: existing.id, workspaceKey, createdAt: existing.row.createdAt })
    const updated = readCapabilityRow(store.toolMemory.get(existing.id), existing.id) as CapabilityRow
    const synced = await ensureSkillFor(store, updated, workspaceKey, { changelog: '内置能力升级：刷新知识面事实块' })
    report.upgraded.push(synced.record.name)
    report.changed.push(synced)
  }
  return report
}

/** Boot/refresh rebuild: migrate, merge builtins, register every executable face. */
export async function rebuildCapabilities(
  ctx: Context,
  store: Store,
  deps?: {
    register?: (ctx: Context, store: Store, entry: CapabilityRow, workspaceKey?: string) => Promise<() => void>
    logger?: { info: (msg: string) => void; warn?: (msg: string) => void }
  },
): Promise<number> {
  try {
    const migration = await migrateCapabilities(store, { ...(deps?.logger ? { logger: deps.logger } : {}) })
    if (migration.changed) deps?.logger?.info('supermemory: capability migration — caps ' + migration.migratedCapabilities + ', knowledge ' + migration.migratedKnowledge + ', retired sequences ' + migration.retiredComposites + ', linked skills ' + migration.linkedSkills + ', archived shells ' + migration.archivedShells + ', retired shell units ' + migration.retiredShellUnits + ', deduped knowledge ' + migration.dedupedKnowledge)
  } catch (error) {
    deps?.logger?.warn?.('supermemory: capability migration failed: ' + String(error).slice(0, 160))
  }
  try {
    const merged = await mergeBuiltinCapabilities(store, { ...(deps?.logger ? { logger: deps.logger } : {}) })
    if (merged.seeded.length > 0 || merged.upgraded.length > 0) {
      deps?.logger?.info('supermemory: builtin capabilities — seeded ' + merged.seeded.join(',') + '; upgraded ' + merged.upgraded.join(','))
    }
  } catch { /* merge failure never blocks boot */ }
  const seam = deps?.register ?? registerCapabilityTool
  let registered = 0
  for (const entry of capabilityRows(store)) {
    if (!isExecutable(entry.record)) { disposeCapabilityTool(capabilityToolName(entry.record.name)); continue }
    try {
      await seam(ctx, store, entry, entry.row.workspaceKey)
      registered += 1
    } catch { /* a broken definition is skipped, never blocks boot */ }
  }
  return registered
}

/** One capability's maintenance snapshot. */
export interface CapabilityHealth {
  id: string
  name: string
  title?: string
  kind: 'capability' | 'knowledge'
  entry: string
  entryDraft?: string
  entryVerified: boolean
  doc?: string
  scope?: string
  status: string
  enabled: boolean
  live: boolean
  builtin: boolean
  builtinVersion?: number
  version: number
  loadCount: number
  runCount: number
  loadsToRuns: number
  successRate: number
  successCount: number
  failCount: number
  consecutiveFailures: number
  lastUsedAt?: number
  lastStatus?: 'completed' | 'failed'
  lastDryRun?: boolean
  lastSummary?: string
  skillPath?: string
  bodyHash?: string
  factsHash?: string
  docMissing: boolean
  scopeMissing: boolean
  notes: string[]
}

export function capabilityHealthOf(store: Store, workspaceKey?: string): CapabilityHealth[] {
  const out: CapabilityHealth[] = []
  for (const entry of capabilityRows(store, workspaceKey)) {
    if (entry.record.kind === 'proposal') continue
    // R54: project ONE coherent reading even before the boot migration writes the
    // legacy counters back — the panel must never show "0 runs, 13 successes".
    const health = reconcileCapabilityHealth(entry.record)
    const record = health.record
    if (record.kind === 'proposal') continue
    const builtin = BUILTIN_CAPABILITIES.find((candidate) => capabilityLogicalName(candidate.name) === record.name)
    const scopeMissing = Boolean(record.scope && !existsSync(record.scope))
    const docMissing = Boolean(record.doc && record.scope && !scopeMissing && !existsSync(join(record.scope, record.doc)))
    const notes: string[] = []
    if (record.consecutiveFailures >= 2) notes.push('连续失败 ' + record.consecutiveFailures + ' 次：更新能力定义/事实块/文档（version+1、changelog 记录原因），不要绕过')
    if (record.runCount > 0 && record.successCount === 0 && record.failCount > 0) notes.push('从未成功执行过：入口命令或适用范围需要修订')
    if (scopeMissing) notes.push('适用范围目录不存在：' + record.scope)
    if (docMissing) notes.push('文档缺失：' + record.doc)
    if (record.runCount === 0 && record.loadCount === 0) notes.push('零使用/零加载：确认路由描述是否说清何时用它')
    if (record.loadCount > 0 && record.runCount === 0) notes.push('有加载无执行：检查知识面是否说清执行面入口')
    if (record.kind === 'capability' && !liveCapabilityToolNames.has(capabilityToolName(record.name))) notes.push('执行面未注册（重启或 refresh-builtin 后生效）')
    if (record.entryDraft && !record.entryVerified) notes.push('入口草稿未验证：人工在面板点「启用执行」后才会 runnable=true')
    if (health.changed) notes.push('历史统计已校正（R54：runCount=success+fail，lastStatus 与最近结果一致）')
    // R54: the builtin DEFINITION version is tracked by builtinVersion; the
    // restored knowledge-face ledger may legitimately sit above it.
    const builtinSeen = record.builtinVersion
    if (builtin && (builtinSeen !== undefined ? builtinSeen < builtin.version : record.version < builtin.version)) notes.push('现场版本旧于内置 v' + builtin.version + '：memory_toolize refresh-builtin 可升级')
    if (builtin && builtinSeen === undefined && record.version > builtin.version) notes.push('现场版本新于内置 v' + builtin.version + '（本地维护中）')
    const successRate = record.runCount > 0 ? record.successCount / record.runCount : 0
    const loadsToRuns = record.loadCount > 0 ? record.runCount / record.loadCount : 0
    out.push({
      id: entry.id,
      name: record.name,
      ...(record.title ? { title: record.title } : {}),
      kind: record.kind,
      entry: record.entry,
      ...(record.entryDraft ? { entryDraft: record.entryDraft } : {}),
      entryVerified: record.entryVerified,
      ...(record.doc ? { doc: record.doc } : {}),
      ...(record.scope ? { scope: record.scope } : {}),
      status: entry.row.status,
      enabled: record.enabled !== false,
      live: liveCapabilityToolNames.has(capabilityToolName(record.name)),
      builtin: Boolean(builtin),
      ...(builtin ? { builtinVersion: builtin.version } : {}),
      version: record.version,
      loadCount: record.loadCount,
      runCount: record.runCount,
      loadsToRuns,
      successRate,
      successCount: record.successCount,
      failCount: record.failCount,
      consecutiveFailures: record.consecutiveFailures,
      ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
      ...(record.lastStatus ? { lastStatus: record.lastStatus } : {}),
      ...(record.lastDryRun !== undefined ? { lastDryRun: record.lastDryRun } : {}),
      ...(record.lastSummary ? { lastSummary: record.lastSummary } : {}),
      ...(record.skillPath ? { skillPath: record.skillPath } : {}),
      ...(record.bodyHash ? { bodyHash: record.bodyHash } : {}),
      ...(record.factsHash ? { factsHash: record.factsHash } : {}),
      docMissing,
      scopeMissing,
      notes,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Proposals (auto knowledge drafts; acceptance is the only growth path)
// ---------------------------------------------------------------------------

export interface ProposalInput {
  workspaceKey: string
  name: string
  title: string
  description: string
  body: string
  facts?: CapabilityFacts
  taskKey?: string
  scope?: string
  entryDraft?: string
  dryRunArg?: string
  writeConfirm?: boolean
  source?: CapabilitySource
  now?: number
}

export interface ProposalResult {
  status: 'created' | 'updated' | 'rejected' | 'unchanged'
  id?: string
  name: string
  message: string
}

export function pendingProposalsOf(store: Store, workspaceKey?: string): CapabilityRow[] {
  return capabilityRows(store)
    .filter((entry) => entry.record.kind === 'proposal'
      && entry.record.proposalStatus === 'pending'
      && (!workspaceKey || !entry.row.workspaceKey || entry.row.workspaceKey === workspaceKey))
}

/** Create/update one pending proposal. Pending proposals never consume the 8-skill cap. */
export async function createProposal(store: Store, input: ProposalInput): Promise<ProposalResult> {
  const now = input.now ?? Date.now()
  const logical = capabilityLogicalName(input.name)
  if (!isValidCapabilityName(logical)) return { status: 'rejected', name: logical, message: '提案名称不合法：' + logical }
  const existing = capabilityRows(store).find((entry) => entry.record.kind === 'proposal'
    && entry.record.name === logical
    && (entry.row.workspaceKey ?? '') === (input.workspaceKey ?? ''))
  const record: CapabilityRecord = normalizeCapabilityRecord({
    schema: CAPABILITY_SCHEMA,
    name: logical,
    kind: 'proposal',
    title: input.title,
    description: input.description,
    entry: '',
    entryDraft: input.entryDraft ?? '',
    entryVerified: false,
    runnable: false,
    scope: input.scope ?? '',
    source: input.source ?? 'auto',
    taskKey: input.taskKey ?? '',
    version: 1,
    updatedAt: now,
    changelog: ['自动知识草稿（待接受）'],
    draftBody: input.body,
    facts: input.facts ?? {},
    proposalStatus: 'pending',
    expiresAt: now + PROPOSAL_TTL_MS,
  })
  record.kind = 'proposal'
  if (existing) {
    const merged: CapabilityRecord = { ...record, version: existing.record.version, changelog: existing.record.changelog }
    await saveCapabilityRecord(store, merged, { id: existing.id, workspaceKey: input.workspaceKey, createdAt: existing.row.createdAt })
    return { status: 'updated', id: existing.id, name: logical, message: '已刷新待接受的知识草稿。' }
  }
  if (pendingProposalsOf(store, input.workspaceKey).length >= PROPOSAL_MAX) {
    return { status: 'rejected', name: logical, message: '待处理提案已达上限 ' + PROPOSAL_MAX + ' 条：先接受/拒绝或清空。' }
  }
  const id = await saveCapabilityRecord(store, record, { workspaceKey: input.workspaceKey })
  return { status: 'created', id, name: logical, message: '已写入待接受提案（知识草稿，无执行面）。' }
}

/** Accept a pending proposal -> a real capability (knowledge only, or entryDraft pending verification). */
export async function acceptProposal(
  ctx: Context | undefined,
  store: Store,
  id: string,
  options: { root?: string; now?: number } = {},
): Promise<{ status: 'ok' | 'error'; message: string; id?: string; name?: string; entryDraft?: boolean }> {
  const proposal = readCapabilityRow(store.toolMemory.get(id), id)
  if (!proposal || proposal.record.kind !== 'proposal') return { status: 'error', message: '提案不存在。' }
  if (proposal.record.proposalStatus !== 'pending') return { status: 'error', message: '提案已处理（不是待接受状态）。' }
  const workspaceKey = proposal.row.workspaceKey ?? 'unknown'
  // R52: options.root is the capability knowledge root (not the old skill root).
  let root = options.root
  if (!root && workspaceKey !== 'unknown') {
    try { root = resolveCapabilityRoot(workspaceKey).root } catch { root = undefined }
  }
  if (root) {
    const autoCount = capabilityRows(store).filter((entry) => entry.record.source === 'auto'
      && entry.record.kind !== 'proposal'
      && Boolean(entry.record.skillPath)
      && resolve(entry.record.skillPath).toLowerCase().startsWith(resolve(root).toLowerCase())).length
    if (autoCount >= 8) return { status: 'error', message: '该 skills 根自动生成上限 8 个已满：先停用/删除一个再接受。' }
  }
  const now = options.now ?? Date.now()
  const record = proposal.record
  const kind: 'capability' | 'knowledge' = record.entryDraft ? 'capability' : 'knowledge'
  const accepted: CapabilityRecord = {
    ...record,
    kind,
    version: 1,
    updatedAt: now,
    changelog: ['接受自动提案（' + (record.entryDraft ? '入口草稿待人工验证' : '仅知识') + '）', ...record.changelog].slice(0, CHANGELOG_MAX),
    proposalStatus: 'accepted',
    entry: '',
    entryVerified: false,
    runnable: false,
    enabled: true,
    source: record.source === 'manual' ? 'manual' : 'auto',
  }
  const capId = await saveCapabilityRecord(store, accepted, { workspaceKey })
  const entry = readCapabilityRow(store.toolMemory.get(capId), capId) as CapabilityRow
  let synced = entry
  if (root) {
    try {
      await syncCapabilitySkill(store, entry, root, { draftBody: record.draftBody, now, changelog: '接受自动提案：生成知识面' })
    } catch { /* skill write failure does not lose the capability row */ }
    synced = readCapabilityRow(store.toolMemory.get(capId), capId) as CapabilityRow
  }
  const done: CapabilityRecord = { ...record, proposalStatus: 'accepted', acceptedId: capId }
  await saveCapabilityRecord(store, done, { id, workspaceKey, createdAt: proposal.row.createdAt })
  return { status: 'ok', message: '已接受提案：创建' + (kind === 'capability' ? '可执行能力（入口草稿待人工「启用执行」）' : '仅知识能力') + ' ' + synced.record.name + '。', id: capId, name: synced.record.name, entryDraft: kind === 'capability' }
}

export async function declineProposal(store: Store, id: string): Promise<{ status: 'ok' | 'error'; message: string }> {
  const proposal = readCapabilityRow(store.toolMemory.get(id), id)
  if (!proposal || proposal.record.kind !== 'proposal') return { status: 'error', message: '提案不存在。' }
  const record: CapabilityRecord = { ...proposal.record, proposalStatus: 'declined', updatedAt: Date.now() }
  await saveCapabilityRecord(store, record, { id, workspaceKey: proposal.row.workspaceKey, createdAt: proposal.row.createdAt })
  return { status: 'ok', message: '已拒绝提案 ' + record.name + '。' }
}

/** Expire stale pending proposals (30 days). Idempotent. */
export async function expireProposals(store: Store, now = Date.now()): Promise<number> {
  let expired = 0
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind !== 'proposal' || entry.record.proposalStatus !== 'pending') continue
    if (entry.record.expiresAt !== undefined && entry.record.expiresAt >= now) continue
    const record: CapabilityRecord = { ...entry.record, proposalStatus: 'declined', updatedAt: now, changelog: ['提案超 30 天未处理：自动过期', ...entry.record.changelog].slice(0, CHANGELOG_MAX) }
    await saveCapabilityRecord(store, record, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt })
    expired += 1
  }
  return expired
}

// ---------------------------------------------------------------------------
// High-confidence auto entry draft
//
// The ONLY automatic execution-face proposal: a normalised command that appeared
// in >=3 samples across >=2 sessions, always exit 0, is non-interactive, belongs
// to an allowed family (pnpm/npm script, repo scripts/*.mjs|sh, git sync), has no
// placeholders/temp paths, and whose scope is the repository root. It is stored
// as entryDraft (verified:false) and can never run until a human enables it.
// ---------------------------------------------------------------------------

export interface EntryDraftDecision {
  status: 'ok' | 'none'
  reason: string
  entry?: string
  dryRunArg?: string
  writeConfirm?: boolean
  samples?: number
  sessions?: number
}

/** Collapse whitespace and strip the dry-run suffix so samples group together. */
export function normalizeCommand(command: string): { command: string; dryRunArg?: string } {
  let value = String(command ?? '').replace(/\s+/g, ' ').trim()
  let dryRunArg: string | undefined
  const match = /\s(--dry-run|--preview|-n)$/.exec(value)
  if (match) {
    dryRunArg = match[1]
    value = value.slice(0, match.index).trim()
  }
  value = value.replace(/^pnpm\s+run\s+/, 'pnpm ').replace(/^npm\s+run\s+/, 'npm run ')
  return { command: value, ...(dryRunArg ? { dryRunArg } : {}) }
}

function isInteractive(command: string): boolean {
  if (/(^|\s)-[a-z]*i[a-z]*(\s|$)/.test(command)) return true
  if (/\b(vim?|nvim|nano|notepad|code|emacs)\b/.test(command)) return true
  if (/(^|\s)(read|select|pause)(\s|$)/.test(command)) return true
  if (/set\s+\/p/i.test(command)) return true
  if (/[<>]/.test(command)) return true
  return false
}

function hasPlaceholderOrTemp(command: string): boolean {
  if (/[{}]/.test(command)) return true
  if (/\$\{/.test(command)) return true
  if (/(^|[\s/"'])(\/tmp|%temp%|\$tmp|c:\\users\\[^\\]+\\appdata\\local\\temp)/i.test(command)) return true
  if (/\.tmp\b|\.temp\b|mkdtemp/i.test(command)) return true
  return false
}

function allowedCommandFamily(command: string, scriptNames: string[]): boolean {
  if (/^pnpm\s+git:sync(\s|$)/.test(command)) return true
  const script = /^(?:pnpm|npm)(?:\s+run)?\s+([a-zA-Z0-9:_.-]+)(?:\s|$)/.exec(command)
  if (script) return scriptNames.includes(script[1])
  if (/^(?:node\s+)?(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.(?:mjs|cjs|js|sh)(?:\s|$)/.test(command)) return true
  if (/^bash\s+(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.sh(?:\s|$)/.test(command)) return true
  return false
}

function readScriptNames(scope: string | undefined): string[] {
  if (!scope) return []
  try {
    const pkg = JSON.parse(readFileSync(join(scope, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return Object.keys(pkg.scripts ?? {})
  } catch {
    return []
  }
}

/**
 * Decide whether the samples justify one auto-drafted entry command. Pure over
 * the recorded samples plus an optional scope/workspace root (filesystem read of
 * package.json only to validate the script family).
 */
export function highConfidenceEntryDraft(
  samples: TaskSample[],
  options: { scope?: string; workspaceRoot?: string; scriptNames?: string[] } = {},
): EntryDraftDecision {
  const scope = options.scope ? resolve(options.scope) : undefined
  if (scope && options.workspaceRoot && resolve(options.workspaceRoot).toLowerCase() !== scope.toLowerCase()) {
    return { status: 'none', reason: 'scope 不是仓库根（' + scope + ' ≠ ' + resolve(options.workspaceRoot) + '）' }
  }
  const scriptNames = options.scriptNames ?? readScriptNames(scope)
  const stats = new Map<string, { samples: number; sessions: Set<string>; dryRunArg?: string }>()
  for (const [index, sample] of samples.entries()) {
    if (sample.ok !== true) continue
    const session = sample.sessionId ?? ('sample-' + index)
    for (const arg of sample.args) {
      const raw = typeof arg.command === 'string' ? arg.command : ''
      if (!raw) continue
      const normalized = normalizeCommand(raw)
      const bucket = stats.get(normalized.command) ?? { samples: 0, sessions: new Set<string>(), ...(normalized.dryRunArg ? { dryRunArg: normalized.dryRunArg } : {}) }
      bucket.samples += 1
      bucket.sessions.add(session)
      if (normalized.dryRunArg && !bucket.dryRunArg) bucket.dryRunArg = normalized.dryRunArg
      stats.set(normalized.command, bucket)
    }
  }
  const candidates = [...stats.entries()]
    .filter(([command, bucket]) => bucket.samples >= 3 && bucket.sessions.size >= 2 && allowedCommandFamily(command, scriptNames)
      && !isInteractive(command) && !hasPlaceholderOrTemp(command))
    .sort((left, right) => right[1].samples - left[1].samples)
  if (candidates.length === 0) {
    return { status: 'none', reason: '没有满足高置信条件的命令（≥3 样本、≥2 会话、全部 exit 0、非交互、允许的命令家族、无占位符/临时路径）' }
  }
  const [command, bucket] = candidates[0]
  const readOnly = /(?:^|\s)(typecheck|smoke|test|lint|check|status|log|diff|verify)(?:\s|$)/.test(command)
  return {
    status: 'ok',
    reason: '高置信候选：' + bucket.samples + ' 个样本、' + bucket.sessions.size + ' 个会话、全部 exit 0；命令家族在允许列表',
    entry: command,
    ...(bucket.dryRunArg ? { dryRunArg: bucket.dryRunArg } : {}),
    writeConfirm: !readOnly,
    samples: bucket.samples,
    sessions: bucket.sessions.size,
  }
}

// ---------------------------------------------------------------------------
// Small helpers used across panel/webui/tools
// ---------------------------------------------------------------------------

export function capabilityRate(runCount: number, loadCount: number): number {
  return loadCount > 0 ? Math.round((runCount / loadCount) * 100) / 100 : 0
}
