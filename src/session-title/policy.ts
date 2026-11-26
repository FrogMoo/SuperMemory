/**
 * R59: pure naming policy — no host, no store, no I/O.
 *
 * This module is the ONLY place that composes a session title. It exists
 * because the host enforces a hard byte budget and the plugin used to budget
 * in CHARACTERS, so a 60-character Chinese title (up to 180 bytes) was silently
 * cut by the host at 80 bytes — the stored copy and the rendered copy then
 * disagreed (Phase 0 evidence: a branch title of 89 bytes rendered as 80).
 *
 * Rules:
 *   - hub:   `<workspace label> · <topic>`; no topic => `<label> · 新会话`;
 *   - branch: the task's first line;
 *   - topic-set root: the same as the recorded member title (caller passes it);
 *   - ANY composed title is clipped to {@link TITLE_MAX_BYTES} UTF-8 bytes by
 *     cutting whole code points and appending "…" (the marker counts toward
 *     the budget), so the host never re-clips and never splits a character.
 * @module supermemory/session-title/policy
 */
import {
  TITLE_BRANCH_TASK_CHARS,
  TITLE_FALLBACK,
  cleanTitleText,
  describeSessionTitle,
  firstLine,
  stripLeadingDescription,
} from '../title.ts'

/**
 * The host's hard title budget in UTF-8 bytes (`maxTitleBytes: 80`,
 * @deepseek-ai/dsh-base cordis.patch.yml). The host truncates silently and
 * without an ellipsis, so every title this plugin writes is composed under
 * THIS budget and clipped here — the marker is ours, not the host's.
 */
export const TITLE_MAX_BYTES = 80

/** The clip marker (also the reason the budget reserves 3 bytes). */
export const TITLE_ELLIPSIS = '…'

/** The brand prefix older rounds generated (still recognized as neutral). */
export const LEGACY_BRAND_PREFIX = 'SuperMemory 中枢'

/** The neutral topic-less fallback (`新会话`). */
export const NEUTRAL_TOPIC = TITLE_FALLBACK

/** UTF-8 byte length of one string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/**
 * The readable label of a workspace path: its last segment (drive/UNC aware).
 * Kept here (not in hub-sessions) so the policy has no store dependency;
 * hub-sessions re-exports it for its existing callers.
 */
export function workspaceLabel(cwd: string): string {
  const value = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (!value) return ''
  const segments = value.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : ''
}

/**
 * Clip one already-clean title to a UTF-8 byte budget.
 *
 * Cuts whole code points (never half a character), trims a dangling
 * separator/space, and appends {@link TITLE_ELLIPSIS} when it had to cut.
 * The marker counts toward the budget, so the result never exceeds it.
 */
export function clipTitleBytes(text: string, maxBytes = TITLE_MAX_BYTES): string {
  const value = firstLine(cleanTitleText(String(text ?? ''))).trim()
  if (!value) return ''
  const budget = Math.max(1, Math.floor(maxBytes))
  if (byteLength(value) <= budget) return value
  const marker = TITLE_ELLIPSIS
  const markerBytes = byteLength(marker)
  const room = Math.max(0, budget - markerBytes)
  let used = 0
  let output = ''
  for (const character of value) {
    const bytes = byteLength(character)
    if (used + bytes > room) break
    output += character
    used += bytes
  }
  output = output.replace(/[\s·]+$/u, '').trimEnd()
  return output ? output + marker : marker
}

/** The cleaned topic text of a raw message/task, or '' when nothing is left. */
export function topicOf(text: string): string {
  const cleaned = firstLine(stripLeadingDescription(cleanTitleText(String(text ?? ''))))
  return cleaned
}

/**
 * The UNCLIPPED hub composition (`<workspace label> · <topic>`). Diagnostics
 * only — never written to the host; {@link composeHubTitle} clips it.
 */
export function composeHubTitleFull(workspace: string, topicText: string): string {
  const label = workspaceLabel(workspace)
  const rawTopic = topicOf(topicText)
  const topic = rawTopic ? describeSessionTitle(rawTopic, 96) : ''
  if (!topic || topic === TITLE_FALLBACK) return label ? label + ' · ' + TITLE_FALLBACK : TITLE_FALLBACK
  return label ? label + ' · ' + topic : topic
}

/**
 * Compose a hub title: `<workspace label> · <topic>`.
 *
 * @param workspace - workspace path or canonical key (the label is its tail).
 * @param topicText - raw topic/first message; empty means "no topic yet".
 * @returns the final byte-clipped title (the SAME string the host holds).
 */
export function composeHubTitle(workspace: string, topicText: string): string {
  return clipTitleBytes(composeHubTitleFull(workspace, topicText))
}

/** The UNCLIPPED branch composition (diagnostics only). */
export function composeBranchTitleFull(task: string): string {
  const topic = topicOf(task)
  return topic ? describeSessionTitle(topic, TITLE_BRANCH_TASK_CHARS) : TITLE_FALLBACK
}

/** Compose a work-branch title: the task's first line, byte-clipped. */
export function composeBranchTitle(task: string): string {
  return clipTitleBytes(composeBranchTitleFull(task))
}

/** Compose a topic-set root title: `<set> · <task>` (or the set title alone). */
export function composeTopicSetTitle(setTitle: string, task = ''): string {
  const set = topicOf(setTitle)
  const snippet = topicOf(task)
  if (set && snippet) return clipTitleBytes(set + ' · ' + snippet)
  if (set) return clipTitleBytes(set)
  return snippet ? clipTitleBytes(snippet) : clipTitleBytes(TITLE_FALLBACK)
}

/**
 * Is this title a LEGACY shape (an old generation's brand/neutral format)?
 * Both are "carries no topic" for upgrade purposes.
 */
export function isLegacyTitle(title: string): boolean {
  const value = String(title ?? '').trim()
  if (!value) return false
  if (value.startsWith(LEGACY_BRAND_PREFIX)) return true
  return new RegExp('^' + TITLE_FALLBACK + '\\s*·\\s*.+$').test(value)
}

/**
 * Does this title carry NO topic — the neutral default of ANY generation?
 * Used by every upgrade path so a name a person or the host chose is kept.
 * (The host itself writes `新会话`? No: the host's own fallback is derived from
 * the first prompt; `新会话` is the plugin's neutral token.)
 */
export function isNeutralTitle(title: string, workspace = ''): boolean {
  const value = String(title ?? '').trim()
  if (!value) return true
  if (value === TITLE_FALLBACK) return true
  if (value.startsWith(LEGACY_BRAND_PREFIX)) return true
  if (/^新会话\s*·/.test(value)) return true
  const label = workspaceLabel(workspace)
  if (label) return value === label + ' · ' + TITLE_FALLBACK
  return /·\s*新会话$/.test(value)
}

/** A title the plugin may freely (re)write: neutral, legacy, or absent. */
export function isUpgradeableTitle(title: string, workspace = ''): boolean {
  return isNeutralTitle(title, workspace) || isLegacyTitle(title)
}

/** Validate a MANUAL title. Too long is an explicit error, never a silent cut. */
export function validateManualTitle(input: string): { ok: true; title: string } | { ok: false; error: string } {
  const value = firstLine(cleanTitleText(String(input ?? ''))).trim()
  if (!value) return { ok: false, error: '标题不能为空' }
  if (value.length > 500) return { ok: false, error: '标题过长（上限 500 字）' }
  if (byteLength(value) > TITLE_MAX_BYTES) {
    return {
      ok: false,
      error: '标题超过 ' + TITLE_MAX_BYTES + ' 个 UTF-8 字节（当前 ' + byteLength(value) + ' 字节，约 '
        + Math.max(1, Math.floor(TITLE_MAX_BYTES / 3)) + ' 个汉字），请缩短',
    }
  }
  return { ok: true, title: value }
}
