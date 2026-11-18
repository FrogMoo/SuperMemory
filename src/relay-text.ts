/**
 * Shared relay-text helpers (§1.3 / §2.2 / D6).
 *
 * An episode carries two forms of the branch's answer: `result` (the FULL final
 * text) and `summary` (a deliberately short memory-facing form read by recall
 * cards, topic-shape fingerprints and exports). The hub-facing relay must use
 * the full one — clipping the relay at 400 characters silently destroyed most
 * of a branch's work, which is what `result` exists to prevent.
 * @module supermemory/relay-text
 */
import type { Episode } from './schema.ts'

/**
 * Relay safety valve, NOT a content policy: an answer larger than this is a
 * runaway turn, and pushing it whole into the hub's context would crowd out
 * everything else. The marker says so and names where the rest lives, instead
 * of silently cutting the branch's work the way the old 400-char clip did.
 */
export const RELAY_RESULT_MAX_CHARS = 65536

/** The branch's full answer: `result`, falling back to the short `summary` for
 *  episodes written before `result` existed. */
export function episodeResult(episode: Episode | undefined): string {
  return episode?.result || episode?.summary || ''
}

/** Clip a relay body at the safety valve, saying so instead of cutting silently. */
export function clipRelayResult(text: string, branchSessionId: string): string {
  if (text.length <= RELAY_RESULT_MAX_CHARS) return text
  const kept = text.slice(0, RELAY_RESULT_MAX_CHARS)
  return `${kept}\n……（结果超过 ${RELAY_RESULT_MAX_CHARS} 字，已截断；完整内容见分支会话 ${branchSessionId} 的记录）`
}
