/**
 * R59: session-naming vocabulary shared by the whole naming service.
 *
 * The naming service owns ONE durable fact per session — what the plugin
 * intends the name to be — and ONE host write path. Everything else (panel,
 * dispatch, migration, observers) passes intents through {@link gate}.
 * @module supermemory/session-title/types
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from '../store.ts'

/** What kind of session a name belongs to (drives the composition rule). */
export type TitleKind = 'hub' | 'branch' | 'other'

/**
 * The naming state machine:
 *   - provisional — a name exists without a topic (「<workspace> · 新会话」);
 *     the first user message may finalize it ONCE;
 *   - named — a topic-bearing name was written (plugin intent);
 *   - user-locked — a human renamed it (panel or host GUI); automatic events
 *     are no-ops until {@link resetAutoTitle};
 *   - deferred — the intent exists but the host write failed / the session was
 *     cold; the next reconcile or live event retries.
 */
export type TitleState = 'provisional' | 'named' | 'user-locked' | 'deferred'

/** How a write ended. `deferred` = the intent is stored, the host is not written yet. */
export type TitleOutcome = 'host' | 'fallback' | 'already' | 'none' | 'deferred' | 'locked' | 'skipped'

/** Who produced an intent / owned the last write (diagnostics + audit). */
export type TitleSource =
  | 'panel'
  | 'topicset-root'
  | 'dispatch'
  | 'first-message'
  | 'migration'
  | 'reconcile'
  | 'manual'
  | 'reset'
  | 'observer'
  | 'title-migration'
  | 'topicset-merge'
  | 'restore'

/** Minimal logger seam (never a no-op on a write path). */
export interface TitleLogger {
  warn: (msg: string) => void
  info: (msg: string) => void
}

/** Everything the naming service needs from the host/plugin. */
export interface TitleDeps {
  ctx: Context | undefined
  store: Store | undefined
  logger: TitleLogger
}

/**
 * One naming request. Callers pass raw topic text when they have it; the
 * service composes the final string (never the caller).
 */
export interface TitleIntent {
  sessionId: string
  /** Workspace path/key of the session (used for the hub prefix). */
  workspaceKey?: string
  kind?: TitleKind
  /** Raw topic / task text the title is composed from. */
  topicText?: string
  /** First user message (same role as topicText for hubs). */
  firstMessage?: string
  /** An explicit FINAL title (only for already-composed names: migration/repair). */
  explicitTitle?: string
  source?: TitleSource
  /** manual = human rename (user-locked); reset = drop the lock and recompose. */
  mode?: 'auto' | 'manual' | 'reset'
  /** Allow overwriting a non-neutral host title (repair/migration/manual). */
  force?: boolean
  /** Defer the host write out of the current event-publication stack. */
  defer?: boolean
  /** Mirror the accepted title into hub_sessions (default: true for hubs). */
  mirror?: boolean
}

/** Result of one naming request (outcome + the title now in force). */
export interface TitleResult {
  outcome: TitleOutcome
  /** The title landed on the host (or the intent title when deferred). */
  title: string
  state?: TitleState
  /** Human-readable reason for a skip/lock/defer. */
  reason?: string
}
