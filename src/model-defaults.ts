/**
 * R41 需求①b: DEFAULT MODELS for new hub / branch sessions (one row per
 * workspace, table `model_defaults`).
 *
 * Why a table (not a meta marker): like the hub whitelist, a default model is
 * WORKSPACE-SCOPED DATA the user edits — not a process fact. The panel's 设置
 * tab reads/writes it through the plugin service; the creation paths read it
 * synchronously on the host side.
 *
 * Precedence (unchanged for existing overrides):
 *   branch: per-member override > topic-set default > branch default > hub's
 *           current selection > deployment default.
 *   hub:    explicit composer choice > hub default > host default.
 *
 * A missing row / unreadable table degrades to "no default" (follow the existing
 * chain) — never an error, never a made-up model.
 * @module supermemory/model-defaults
 */
import type { ModelSelection } from './model.ts'
import type { ModelDefaults } from './schema.ts'
import type { Store } from './store.ts'

/** One workspace's default models (both absent = follow the existing chain). */
export interface ModelDefaultsView {
  workspaceKey: string
  hub?: ModelSelection
  branch?: ModelSelection
  /** stored = a workspace row exists; default = no row (host/default chain). */
  source: 'stored' | 'default'
}

const ROW_PREFIX = 'model-defaults-'

/** Defensive copy: only a complete provider+model pair is a selection. */
function selectionOf(value: { provider?: string; model?: string; reasoningEffort?: string } | undefined): ModelSelection | undefined {
  if (!value || !value.provider || !value.model) return undefined
  return {
    provider: String(value.provider),
    model: String(value.model),
    ...(value.reasoningEffort ? { reasoningEffort: String(value.reasoningEffort) } : {}),
  }
}

function findRow(store: Store, workspaceKey: string): { id: string; row: ModelDefaults } | undefined {
  try {
    const table = store.modelDefaults
    if (!table || typeof table.entries !== 'function') return undefined
    for (const [id, row] of table.entries()) {
      if (row && row.workspaceKey === workspaceKey) return { id, row }
    }
  } catch { /* unreadable table = no stored default */ }
  return undefined
}

/** Read one workspace's defaults. Never throws. */
export function readModelDefaults(store: Store | undefined, workspaceKey: string | undefined): ModelDefaultsView {
  const key = String(workspaceKey ?? '')
  const fallback: ModelDefaultsView = { workspaceKey: key, source: 'default' }
  if (!store || !key) return fallback
  const found = findRow(store, key)
  if (!found) return fallback
  const hub = selectionOf(found.row.hub)
  const branch = selectionOf(found.row.branch)
  return { workspaceKey: key, ...(hub ? { hub } : {}), ...(branch ? { branch } : {}), source: 'stored' }
}

/** The default for one session kind, or undefined (follow the existing chain). */
export function defaultModelFor(
  store: Store | undefined,
  workspaceKey: string | undefined,
  kind: 'hub' | 'branch',
): ModelSelection | undefined {
  const view = readModelDefaults(store, workspaceKey)
  return kind === 'hub' ? view.hub : view.branch
}

/**
 * Save a partial patch:
 *   - a complete selection replaces that kind's default;
 *   - `null` clears it (falls back to the existing chain);
 *   - an omitted key keeps the stored value;
 *   - `reset: true` clears both (the row is deleted, so source returns default).
 */
export async function writeModelDefaults(
  store: Store,
  workspaceKey: string,
  patch: { hub?: ModelSelection | null; branch?: ModelSelection | null; reset?: boolean },
  now = Date.now(),
): Promise<ModelDefaultsView> {
  const key = String(workspaceKey ?? '').trim()
  if (!key) throw new Error('缺少工作区键，无法保存默认模型。')
  const table = store.modelDefaults
  if (!table) throw new Error('model_defaults 表不可用（存储域缺少该表）')
  const found = findRow(store, key)
  if (patch.reset) {
    if (found) await table.delete(found.id)
    return { workspaceKey: key, source: 'default' }
  }
  const existing = found?.row
  const hub = patch.hub === null ? undefined : selectionOf(patch.hub) ?? selectionOf(existing?.hub)
  const branch = patch.branch === null ? undefined : selectionOf(patch.branch) ?? selectionOf(existing?.branch)
  const record: ModelDefaults = {
    workspaceKey: key,
    ...(hub ? { hub } : {}),
    ...(branch ? { branch } : {}),
    updatedAt: now,
  }
  if (!record.hub && !record.branch) {
    // Nothing left to store: drop the row so "source" honestly reads default.
    if (found) await table.delete(found.id)
    return { workspaceKey: key, source: 'default' }
  }
  if (found) await table.update(found.id, () => record)
  else await table.put(ROW_PREFIX + key, record)
  return readModelDefaults(store, key)
}
