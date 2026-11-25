import { t as newId } from "./store-DD2L3GDr.js";
// src/topicsets.ts
async function createTopicSet(store, input) {
	const now = Date.now();
	const topicSetId = newId("ts");
	const record = {
		workspaceKey: input.workspaceKey,
		title: input.title,
		summary: input.summary ?? "",
		keywords: input.keywords ?? [],
		status: "active",
		defaultModel: input.defaultModel,
		members: [],
		shapeFingerprint: "",
		shapeGeneratedAt: 0,
		createdAt: now,
		updatedAt: now,
		lastActiveAt: now
	};
	await store.topicsets.put(topicSetId, record);
	return topicSetId;
}
function getTopicSet(store, topicSetId) {
	return store.topicsets.get(topicSetId);
}
function listTopicSets(store, workspaceKey) {
	const out = [];
	for (const entry of store.topicsets.entries()) if (entry[1].workspaceKey === workspaceKey && entry[1].status === "active") out.push(entry);
	out.sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt);
	return out;
}
/** Topic-set ids of one workspace (episodes/dispatches join through them). */
function topicSetIdsOf(store, workspaceKey) {
	const ids = /* @__PURE__ */ new Set();
	for (const [id, record] of store.topicsets.entries()) if (record.workspaceKey === workspaceKey) ids.add(id);
	return ids;
}
async function touchTopicSet(store, topicSetId) {
	if (!store.topicsets.get(topicSetId)) return;
	await store.topicsets.update(topicSetId, (record) => ({
		...record,
		lastActiveAt: Date.now(),
		updatedAt: Date.now()
	})).catch(() => {});
}
/**
* R19 需求⑥: write the LLM-generated title + tags + body back to one set.
*
* The title is only overwritten when the generator produced a non-empty one;
* an absent field keeps the current value, so a partially parsed model answer
* can never blank the index. `fingerprint`/`generatedAt` are recorded only on a
* successful generation (see topic-shape.ts) — the caller decides that.
*/
async function updateTopicSetShape(store, topicSetId, shape) {
	await store.topicsets.update(topicSetId, (record) => ({
		...record,
		...shape.title ? { title: shape.title } : {},
		...shape.summary !== void 0 ? { summary: shape.summary } : {},
		...shape.keywords !== void 0 ? { keywords: shape.keywords } : {},
		...shape.fingerprint !== void 0 ? { shapeFingerprint: shape.fingerprint } : {},
		...shape.generatedAt !== void 0 ? { shapeGeneratedAt: shape.generatedAt } : {},
		updatedAt: Date.now()
	})).catch(() => {});
}
async function updateTopicSetSummary(store, topicSetId, summary, keywords) {
	await store.topicsets.update(topicSetId, (record) => ({
		...record,
		summary,
		...keywords ? { keywords } : {},
		updatedAt: Date.now()
	})).catch(() => {});
}
async function setTopicSetModel(store, topicSetId, model) {
	await store.topicsets.update(topicSetId, (record) => ({
		...record,
		defaultModel: model,
		updatedAt: Date.now()
	})).catch(() => {});
}
async function addMember(store, topicSetId, member) {
	await store.topicsets.update(topicSetId, (record) => {
		if (record.members.some((m) => m.sessionId === member.sessionId)) return record;
		const now = Date.now();
		return {
			...record,
			members: [...record.members, {
				sessionId: member.sessionId,
				kind: member.kind,
				title: member.title ?? "",
				summary: "",
				status: "live",
				model: member.model,
				modelOverridden: false,
				lastActiveAt: now
			}],
			lastActiveAt: now,
			updatedAt: now
		};
	});
}
async function updateMember(store, topicSetId, sessionId, patch) {
	await store.topicsets.update(topicSetId, (record) => ({
		...record,
		members: record.members.map((m) => m.sessionId === sessionId ? {
			...m,
			...patch,
			lastActiveAt: Date.now()
		} : m),
		updatedAt: Date.now()
	})).catch(() => {});
}
/** Routing table: one row per session. */
function getRouting(store, sessionId) {
	return store.routing.get(sessionId);
}
async function setRouting(store, sessionId, patch) {
	const existing = store.routing.get(sessionId);
	const next = {
		activeTopicSetId: patch.activeTopicSetId !== void 0 ? patch.activeTopicSetId : existing?.activeTopicSetId,
		driftCount: patch.driftCount !== void 0 ? patch.driftCount : existing?.driftCount ?? 0,
		updatedAt: Date.now()
	};
	await store.routing.put(sessionId, next);
}
/** Members of one topic set that look relevant to a task (rule: keyword overlap). */
function rankMembers(topicSet, taskTokens) {
	return [...topicSet.members].sort((a, b) => {
		const score = (m) => {
			const bag = new Set([m.title, m.summary].join(" ").toLowerCase().split(/[\s,，。.;；:：]+/).filter(Boolean));
			let hits = 0;
			for (const token of taskTokens) if (bag.has(token)) hits++;
			return hits;
		};
		return score(b) - score(a) || b.lastActiveAt - a.lastActiveAt;
	});
}
// src/clip.ts
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
const SENTENCE_END = /* @__PURE__ */ new Set([
	"。",
	"！",
	"？",
	"!",
	"?",
	"；",
	";",
	"\n",
	"…"
]);
/** Latin clause separators, used only when a sentence has no terminator. */
const CLAUSE_END = /* @__PURE__ */ new Set([
	"，",
	",",
	"、",
	"：",
	":",
	"—"
]);
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
function clipAtBoundary(text, max, minRatio = .4) {
	const source = String(text ?? "");
	const chars = Array.from(source);
	const budget = Math.floor(max);
	if (!Number.isFinite(budget) || budget <= 0) return "";
	if (chars.length <= budget) return source;
	const ratio = Math.min(.9, Math.max(0, Number(minRatio) || 0));
	const window = chars.slice(0, budget);
	const searchFrom = Math.max(0, Math.ceil(window.length * ratio) - 1);
	const lastIndexOf = (set) => {
		for (let index = window.length - 1; index >= searchFrom; index -= 1) if (set.has(window[index])) return index + 1;
		return -1;
	};
	let cut = lastIndexOf(SENTENCE_END);
	if (cut < 0) cut = lastIndexOf(CLAUSE_END);
	if (cut < 0) {
		for (let index = window.length - 1; index >= searchFrom; index -= 1) if (/\s/.test(window[index])) {
			cut = index + 1;
			break;
		}
	}
	if (cut < 0) cut = window.length;
	return window.slice(0, cut).join("");
}
/** Character count in code points (what every budget below counts). */
function charCount(text) {
	return Array.from(String(text ?? "")).length;
}
/** The default omission note: visible, sized, and re-fetchable.
*
* `hint`: `undefined` = the default `memory_recall` clue; `''` = no clue
* (a stored field, where re-fetching makes no sense); anything else is quoted
* verbatim after the sizes.
*/
function omissionNote(total, omitted, hint) {
	return `…（原文 ${total} 字，已省略 ${omitted} 字${hint === void 0 ? "，可用 memory_recall 复取" : hint ? `，${hint}` : ""}）`;
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
function clipWithNote(text, max, hint) {
	const source = String(text ?? "");
	const budget = Math.floor(max);
	if (!Number.isFinite(budget) || budget <= 0) return "";
	const total = Array.from(source).length;
	if (total <= budget) return source;
	let bodyBudget = Math.max(1, budget - 48);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const kept = clipAtBoundary(source, bodyBudget);
		const combined = `${kept} ${omissionNote(total, total - Array.from(kept).length, hint)}`;
		const combinedLength = Array.from(combined).length;
		if (combinedLength <= budget) return combined;
		bodyBudget = Math.max(1, bodyBudget - (combinedLength - budget));
	}
	return Array.from(source).slice(0, budget).join("");
}
/**
* The card-level degradation note: how many records were dropped and how to
* see them. Appended as the last line of an over-budget card.
*/
function dropNote(dropped, hint) {
	if (dropped <= 0) return "";
	return `…（已省略 ${dropped} 项${hint ? `，${hint}` : "，可用 memory_recall 复取"}）`;
}
/**
* A compact marked clip for LABELS and other short fields: boundary-aware cut
* plus a bare `…`. Used where the verbose {@link clipWithNote} note would
* overwhelm the field itself (a 40-char task label, a 20-char branch name).
*/
function clipMarked(text, max) {
	const source = String(text ?? "");
	const budget = Math.floor(max);
	if (!Number.isFinite(budget) || budget <= 0) return "";
	if (Array.from(source).length <= budget) return source;
	if (budget === 1) return "…";
	return `${clipAtBoundary(source, budget - 1, .6)}…`;
}
export { updateTopicSetShape as _, dropNote as a, getRouting as c, rankMembers as d, setRouting as f, updateMember as g, touchTopicSet as h, clipWithNote as i, getTopicSet as l, topicSetIdsOf as m, clipAtBoundary as n, addMember as o, setTopicSetModel as p, clipMarked as r, createTopicSet as s, charCount as t, listTopicSets as u, updateTopicSetSummary as v };
