/**
 * "Open the dispatch card" signal (派发改回卡片, requirement ①): the shell's
 * 新建会话 control no longer opens a modal choice layer — client/new-session
 * intercepts the click, asks the host layout service to open THIS plugin's
 * panel in the main column, and then broadcasts this signal so an
 * already-mounted panel page switches to the hub tab, where the dispatch card
 * lives (task text, workspace, agent preset, model, permission, topic-set
 * chips, ＋新话题集, 开始对话/仅创建会话, Ctrl/Cmd+Enter, in-place receipt).
 *
 * A plain module-level broadcast, not a host service: the panel page may not be
 * mounted yet when the signal fires (a fresh panel mount defaults to the hub
 * tab anyway), so a signal with no listener is simply a no-op. Zero
 * dependencies and no document/window reference at module scope, which keeps
 * the module SSR-safe and harmless inside the wrapped client bundle.
 * @module supermemory/client/open-dispatch
 */

type OpenDispatchListener = () => void

const listeners = new Set<OpenDispatchListener>()

/**
 * Subscribe to the open-dispatch signal. Returns the unsubscribe function;
 * call it from the effect cleanup so a remount never leaks a listener.
 */
export function subscribeOpenDispatch(listener: OpenDispatchListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Ask every live listener (each mounted panel page) to show the dispatch card:
 * hub tab, no stale receipt. One throwing listener never blocks the others.
 */
export function broadcastOpenDispatch(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A broken consumer is its own problem; the shell click already happened.
    }
  }
}
