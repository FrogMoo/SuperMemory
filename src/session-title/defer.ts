/**
 * R59: the ONLY scheduler for host-title writes.
 *
 * The host forbids appending while it publishes an event
 * (`session append cannot reenter while another append is being published`),
 * so a listener that calls the title service inline loses every write — that
 * was the R43 bug. Everything that writes a host title goes through
 * {@link deferTitleTask}: the write starts after the current stack unwinds, and
 * a write that still lands inside a publication retries on a macrotask.
 * @module supermemory/session-title/defer
 */

/** Maximum attempts of one host write (first try + two re-entrant retries). */
export const MAX_TITLE_WRITE_ATTEMPTS = 3

/**
 * Run one task AFTER the current synchronous stack (microtask first, macrotask
 * when microtasks are unavailable). Never runs the task inline: that is the
 * whole point of this module.
 */
export async function deferTitleTask<T>(task: () => Promise<T> | T): Promise<T> {
  await new Promise<void>((resolve) => {
    try {
      queueMicrotask(resolve)
    } catch {
      setTimeout(resolve, 0)
    }
  })
  return task()
}

/** A result that can report the host's re-entrant-append refusal. */
export interface ReentrantResult {
  reentrant?: boolean
}

/**
 * Retry one synchronous write attempt while it reports a re-entrant append.
 *
 * The first retry waits a macrotask (setTimeout 0), which is past the host's
 * publication stack; the loop is bounded so a permanently hostile host can
 * never spin. Returns the last result and how many attempts it took.
 */
export async function retryReentrant<T extends ReentrantResult>(
  attempt: () => T,
  options: { maxAttempts?: number } = {},
): Promise<{ result: T; tries: number }> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? MAX_TITLE_WRITE_ATTEMPTS))
  let result = attempt()
  let tries = 1
  while (result.reentrant && tries < maxAttempts) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    result = attempt()
    tries += 1
  }
  return { result, tries }
}
