/**
 * Hub-session receipt signal (需求①: 点击「新会话」立即创建中枢会话).
 *
 * The shell's 新建会话 control used to pop this plugin's choice dialog (R3–R27)
 * and, after R28, merely opened the panel and switched to the hub tab — it
 * created NOTHING, so on an already-open hub tab the click had no visible
 * effect at all. Both entries now CREATE a hub session with host defaults and
 * hand the result to the panel, which renders it as the same in-place receipt
 * the composer produces (message + session id + 「打开会话」).
 *
 * A plain module-level broadcast, not a host service: the shell click can fire
 * while the panel page is not mounted (fresh panel mount defaults to the hub
 * tab), so when nobody is listening the receipt is kept as `pending` and the
 * next panel mount consumes it through {@link takePendingHubReceipt}. Zero
 * dependencies and no document/window reference at module scope, which keeps
 * the module SSR-safe and harmless inside the wrapped client bundle.
 * @module supermemory/client/open-dispatch
 */

/** One in-place launch receipt: created session id, host message, flavour. */
export interface HubSessionReceipt {
  /** Created session id; '' when creation failed (message-only receipt). */
  id: string
  /** Host confirmation / failure text, rendered verbatim. */
  message: string
  kind: 'hub' | 'sets'
}

type HubReceiptListener = (receipt: HubSessionReceipt) => void

const listeners = new Set<HubReceiptListener>()

/** The receipt a not-yet-mounted panel should show on mount. */
let pending: HubSessionReceipt | undefined

/**
 * Deliver one receipt to every live listener (each mounted panel page) and
 * keep it for the next mount when nobody is listening yet. One throwing
 * listener never blocks the others.
 */
export function publishHubReceipt(receipt: HubSessionReceipt): void {
  if (listeners.size === 0) pending = receipt
  for (const listener of [...listeners]) {
    try {
      listener(receipt)
    } catch {
      // A broken consumer is its own problem; the session already exists.
    }
  }
}

/**
 * Subscribe to receipts. Returns the unsubscribe function; call it from the
 * effect cleanup so a remount never leaks a listener.
 */
export function subscribeHubReceipt(listener: HubReceiptListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Take the receipt published before this panel mounted (and clear it, so a
 * later remount never shows a stale creation). Undefined when there is none.
 */
export function takePendingHubReceipt(): HubSessionReceipt | undefined {
  const receipt = pending
  pending = undefined
  return receipt
}
