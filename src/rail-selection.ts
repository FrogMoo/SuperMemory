/**
 * R41 需求②: which rail row is the SELECTED one.
 *
 * The old rail expression OR-ed two state sources:
 *   `sessionId === row.id || (view.kind === 'chat' && view.id === row.id)`
 * so opening a hub in the panel highlighted that row AND the shell's current
 * session row — two highlights for one selection. A radio list has exactly one
 * truth: while the in-panel chat is open its id wins; otherwise the shell's
 * current session is the selection. Pure and exported so it is testable.
 * @module supermemory/rail-selection
 */

export interface RailViewLike {
  kind: string
  id?: string
}

/**
 * @param view - current panel view.
 * @param hubSessionId - the rail row being tested.
 * @param shellSessionId - the host session the panel was opened for.
 * @returns true for exactly one row in any given state.
 */
export function isRailCurrent(view: RailViewLike, hubSessionId: string, shellSessionId: string): boolean {
  if (view.kind === 'chat') return !!view.id && view.id === hubSessionId
  return !!shellSessionId && shellSessionId === hubSessionId
}
