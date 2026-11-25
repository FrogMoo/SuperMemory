/**
 * Budget-aware clipping for every model-facing injection (R47 需求②).
 *
 * The old rule was a raw `text.slice(0, cap)` at each call site: the injected
 * card could stop mid-sentence, mid-tag or mid-id with no sign that anything
 * was missing — the hub then answered from half a conclusion and had no way to
 * know (or to recover) the rest. That is what this module replaces.
 *
 * Contract:
 *  - **Key fields are never clipped here.** Titles, tags, ids and versions are
 *    short by construction (title.ts / retrieval.ts caps) and are rendered
 *    whole by the caller; only BODIES are budgeted.
 *  - A body that exceeds its budget is cut at a **sentence/paragraph
 *    boundary** (never mid-sentence) and carries an explicit note naming the
 *    original size, the omitted size and how to re-fetch the rest
 *    (`memory_recall <query>`), so a cut is visible and recoverable.
 *  - Every helper keeps its output within the given budget (the note counts
 *    toward it) and never throws.
 *
 * Host-side check (R47 需求④): the DSH host does NOT truncate injected text —
 * dsh-agent's own pre-step consumer appends whole messages
 * (dsh-agent/src/model-selection.ts:170) and the only host cap found is
 * `boundContextSummary` (dsh-llm/src/message.ts:122, 120 chars, marked with …)
 * on a notice's one-line `summary`, which SuperMemory notices stay under.
 * @module supermemory/clip
 */

/** Sentence/paragraph terminators (CJK + latin). The terminator is kept. */
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '\n', '…'])

/** Latin clause separators, used only when a sentence has no terminator. */
const CLAUSE_END = new Set(['，', ',', '、', '：', ':', '—'])

/**
 * Cut at the last sentence boundary within `max` characters.
 *
 * Search window: from `minRatio` of the budget to its end (default 40%). A
 * boundary before that window is ignored, so one long preamble cannot swallow
 * the whole budget; `clipMarked` raises the ratio (0.6) because a short label
 * (a 40-char task name) must stay recognisable. When the text has no terminator
 * at all (one huge sentence), fall back to a clause separator, then to
 * whitespace (latin word edge), and only then to a hard cut — which the
 * caller's note or "…" marker still makes visible. Surrogates stay intact.
 */
export function clipAtBoundary(text: string, max: number, minRatio = 0.4): string {
  const source = String(text ?? '')
  const chars = Array.from(source)
  const budget = Math.floor(max)
  if (!Number.isFinite(budget) || budget <= 0) return ''
  if (chars.length <= budget) return source
  const ratio = Math.min(0.9, Math.max(0, Number(minRatio) || 0))
  const window = chars.slice(0, budget)
  const searchFrom = Math.max(0, Math.ceil(window.length * ratio) - 1)
  const lastIndexOf = (set: Set<string>): number => {
    for (let index = window.length - 1; index >= searchFrom; index -= 1) {
      if (set.has(window[index])) return index + 1
    }
    return -1
  }
  let cut = lastIndexOf(SENTENCE_END)
  if (cut < 0) cut = lastIndexOf(CLAUSE_END)
  if (cut < 0) {
    for (let index = window.length - 1; index >= searchFrom; index -= 1) {
      if (/\s/.test(window[index])) { cut = index + 1; break }
    }
  }
  if (cut < 0) cut = window.length
  return window.slice(0, cut).join('')
}

/** Character count in code points (what every budget below counts). */
export function charCount(text: string): number {
  return Array.from(String(text ?? '')).length
}

/** The default omission note: visible, sized, and re-fetchable.
 *
 * `hint`: `undefined` = the default `memory_recall` clue; `''` = no clue
 * (a stored field, where re-fetching makes no sense); anything else is quoted
 * verbatim after the sizes.
 */
export function omissionNote(total: number, omitted: number, hint?: string): string {
  const tail = hint === undefined
    ? '，可用 memory_recall 复取'
    : hint
      ? `，${hint}`
      : ''
  return `…（原文 ${total} 字，已省略 ${omitted} 字${tail}）`
}

/**
 * Clip one body to `max` characters (note included) at a sentence boundary.
 *
 * `hint` overrides the re-fetch clue (e.g. `复取：memory_recall 「标题」`).
 * The result never exceeds `max` characters: the note is measured and the body
 * re-clipped until the pair fits (at most a few iterations — the note's length
 * only moves by digit count). Below ~48 characters the note itself does not
 * fit and the caller should drop the record instead of calling this.
 */
export function clipWithNote(text: string, max: number, hint?: string): string {
  const source = String(text ?? '')
  const budget = Math.floor(max)
  if (!Number.isFinite(budget) || budget <= 0) return ''
  const total = Array.from(source).length
  if (total <= budget) return source
  // 48 ≈ the shortest note shape; start there and converge on the real one.
  let bodyBudget = Math.max(1, budget - 48)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const kept = clipAtBoundary(source, bodyBudget)
    const combined = `${kept} ${omissionNote(total, total - Array.from(kept).length, hint)}`
    const combinedLength = Array.from(combined).length
    if (combinedLength <= budget) return combined
    bodyBudget = Math.max(1, bodyBudget - (combinedLength - budget))
  }
  // Absolute fallback (tiny budget): keep the ≤max contract even if the note
  // cannot fit — callers are expected to drop the record instead.
  return Array.from(source).slice(0, budget).join('')
}

/**
 * The card-level degradation note: how many records were dropped and how to
 * see them. Appended as the last line of an over-budget card.
 */
export function dropNote(dropped: number, hint?: string): string {
  if (dropped <= 0) return ''
  const tail = hint ? `，${hint}` : '，可用 memory_recall 复取'
  return `…（已省略 ${dropped} 项${tail}）`
}

/**
 * A compact marked clip for LABELS and other short fields: boundary-aware cut
 * plus a bare `…`. Used where the verbose {@link clipWithNote} note would
 * overwhelm the field itself (a 40-char task label, a 20-char branch name).
 */
export function clipMarked(text: string, max: number): string {
  const source = String(text ?? '')
  const budget = Math.floor(max)
  if (!Number.isFinite(budget) || budget <= 0) return ''
  if (Array.from(source).length <= budget) return source
  if (budget === 1) return '…'
  // 0.6: a label clipped at 40% of its budget ("提交第…") says nothing useful.
  const kept = clipAtBoundary(source, budget - 1, 0.6)
  return `${kept}…`
}
