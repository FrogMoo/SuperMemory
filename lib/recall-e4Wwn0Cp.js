// src/extract.ts
const REMEMBER_PATTERNS = [/(?:记住|记一下|请记住|帮忙记住|牢记)[:：\s]+(.{2,200})/, /(?:remember|note that|don'?t forget|keep in mind)\b[:：\s]+(.{2,200})/i];
const DEFINITION_PATTERNS = [/^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)(?:是|为|等于)(.{4,200})$/, /^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)\s+(?:is|are)\s+(.{4,200})$/i];
const STOP_WORDS = /* @__PURE__ */ new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"and",
	"or",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"这个",
	"那个",
	"一下",
	"什么",
	"怎么",
	"如何",
	"请",
	"帮我把",
	"记得"
]);
/** Extract keywords from a fact text (latin words + CJK bigrams, stop-words dropped). */
function keywordsOf(text) {
	const tokens = [];
	const lower = text.toLowerCase();
	for (const m of lower.matchAll(/[a-z0-9_+#.\-]{2,}/g)) if (!STOP_WORDS.has(m[0])) tokens.push(m[0]);
	const chars = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i + 1 < chars.length; i++) {
		const bigram = chars[i] + chars[i + 1];
		if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
	}
	return [...new Set(tokens)].slice(0, 24);
}
/**
* Extract memory-worthy facts from one user message.
* @param text - the user message's plain text.
* @returns zero or more facts; empty when nothing is memory-worthy.
*/
function extractFacts(text) {
	const facts = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (raw) => {
		const clean = raw.trim().replace(/\s+/g, " ").replace(/["'」』]+$/, "").slice(0, 300);
		if (clean.length < 2) return;
		const key = clean.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		facts.push({
			text: clean,
			keywords: keywordsOf(clean)
		});
	};
	for (const pattern of REMEMBER_PATTERNS) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		for (const m of text.matchAll(new RegExp(pattern.source, flags))) push(m[1]);
	}
	for (const line of text.split(/\n+/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.length > 80) continue;
		for (const pattern of DEFINITION_PATTERNS) {
			const m = trimmed.match(pattern);
			if (m && m[1].length >= 2) push(`${m[1].trim()}是${m[2].trim()}`);
		}
	}
	return facts;
}
/**
* R19 需求⑧: a memory is a CONCLUSION, not a transcript.
*
* The write path is the last line of defence after the tool description and
* the hub/system prompts: a body above {@link MEMORY_TEXT_MAX} characters, one
* that is a wall of numbered steps/commands, or a long fenced command dump is
* rejected with an actionable message. Everything else (a multi-line
* conclusion, a bulleted decision list) is accepted — the heuristic is
* deliberately conservative so a legitimate fact is never lost.
*/
const MEMORY_TEXT_MAX = 1500;
/** Step-line markers that signal a process log rather than a conclusion. */
const STEP_LINE = /^\s*(?:步骤\s*\d+|第[一二三四五六七八九十0-9]+步|step\s*\d+|\d{1,2}[.)、]\s+)/i;
/** Classify one memory body before it is written. */
function assessConclusion(input) {
	const text = String(input ?? "").trim();
	if (!text) return {
		ok: false,
		message: "正文不能为空。"
	};
	if (Array.from(text).length > 1500) return {
		ok: false,
		message: `正文过长（${Array.from(text).length} 字，上限 ${MEMORY_TEXT_MAX}）：记忆只存结论，请压缩为可复用的事实/决策；过程步骤请留在会话里。`
	};
	const lines = text.split(/\r?\n/);
	if (lines.filter((line) => STEP_LINE.test(line)).length >= 3) return {
		ok: false,
		message: "这段内容像过程流水账（多条编号步骤）：记忆只存结论性、可复用的事实/决策，请改写为结论。"
	};
	if (lines.length >= 25) return {
		ok: false,
		message: `正文行数过多（${lines.length} 行）：请只保留结论性事实/决策，过程记录不必写入记忆。`
	};
	if (text.includes("```") && Array.from(text).length > 700) return {
		ok: false,
		message: "长代码块看起来是过程材料：记忆只存结论（命令结论、约定、决策），不要粘贴大段输出。"
	};
	return { ok: true };
}
/**
* Derive a human title from a body when the caller supplied none.
* The first sentence/clause is used (Chinese full stop, semicolon, newline),
* trimmed to {@link TITLE_MAX} characters, so old-style `memory_remember`
* calls still produce a scannable index.
*/
function deriveTitle(body, fallback = "") {
	const clean = String(body ?? "").replace(/\s+/g, " ").trim();
	if (!clean) return fallback.slice(0, 48);
	const clause = clean.split(/[。！？；;.!?\n]/)[0]?.trim() || clean;
	return clause.length <= 48 ? clause : `${clause.slice(0, 47)}…`;
}
/** Normalise whatever a caller passed as tags (array, comma text, undefined). */
function normalizeTags(input) {
	const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,，、;；|\s]+/) : [];
	const out = [];
	for (const entry of raw) {
		const tag = String(entry ?? "").trim().replace(/^#+/, "");
		if (!tag) continue;
		const capped = tag.slice(0, 24);
		if (out.includes(capped)) continue;
		out.push(capped);
		if (out.length >= 12) break;
	}
	return out;
}
/**
* The record's tag list: the caller's tags when it supplied any, otherwise the
* auto-extracted keywords of the body.
*
* Deliberately NOT a union: the point of the title + tags + body shape is that
* the tag space stays a human-chosen index. Mixing CJK bigrams into explicitly
* tagged records made every record look tagged with noise ("新记", "记忆", …)
* and pushed real tags out of the display. Records with no tags at all still
* fall back to the body vocabulary, so old flows stay findable.
*/
function mergeTags(tags, autoKeywords) {
	const explicit = normalizeTags(tags);
	return explicit.length > 0 ? explicit : normalizeTags(autoKeywords);
}
/** Tags of a free-form body, normalised (used when a record carries none). */
function tagsOfBody(body) {
	return normalizeTags(keywordsOf(body));
}
/**
* The card line every UI and the model-facing render share.
*
* R22 需求④: an entry may name its memory collection — the collection is part of
* the record's context (like a topic set for episodes), so the line carries it
* only when the caller knows it. Existing callers pass nothing and are unchanged.
*/
function renderRecordLine(record) {
	const title = record.title?.trim();
	const tags = (record.tags ?? []).filter(Boolean);
	const head = title && title !== record.text.trim() ? `【${title}】` : "";
	const tail = tags.length > 0 ? ` ｜标签: ${tags.join("、")}` : "";
	const collection = record.collection?.trim() ? ` ｜集合: ${record.collection.trim()}` : "";
	return `${head}${record.text}${tail}${collection}`;
}
// src/recall.ts
/**
* Rule-based recall: keyword overlap plus time decay (P0 简化版).
*
* Tokenisation handles mixed Chinese/Latin text: ASCII word tokens plus CJK
* character bigrams, so 「构建命令」 and "build command" both produce matchable
* units without any LLM call. LLM failure can never degrade this path because
* there is no LLM in it.
* @module supermemory/recall
*/
/**
* Field weights for one record's token bag (R10).
*
* The whole point of the title + tags + body shape is that a query can be
* answered from the index: a title hit is worth four body hits, a tag hit
* three, so an exact title/tag match outranks a record that merely mentions
* the word once deep in its prose.
*/
const TITLE_WEIGHT = 4;
const TAG_WEIGHT = 3;
const BODY_WEIGHT = 1;
const LATIN = /[a-zA-Z0-9_+#.\-]{2,}/g;
const CJK = /[\u4e00-\u9fff]/g;
/** Split text into matchable tokens (latin words + CJK bigrams). */
function tokenize(text) {
	const tokens = [];
	const lower = text.toLowerCase();
	for (const m of lower.matchAll(LATIN)) tokens.push(m[0]);
	const chars = text.match(CJK) ?? [];
	for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
	if (chars.length === 1) tokens.push(chars[0]);
	return tokens;
}
function decay(createdAt, now, halfLifeDays) {
	const ageDays = Math.max(0, (now - createdAt) / 864e5);
	return Math.pow(.5, ageDays / Math.max(1, halfLifeDays));
}
/**
* Raw match score of one memory against weighted query tokens (no decay).
* `minScore: 1` therefore means "at least one matched token", independent of
* the record's age — decay only reorders the survivors.
*/
function rawScore(memory, queryTokens) {
	if (memory.status !== "active") return 0;
	const fold = (text) => {
		const bag = /* @__PURE__ */ new Map();
		for (const token of tokenize(text)) bag.set(token, (bag.get(token) ?? 0) + 1);
		return bag;
	};
	const titleBag = fold(memory.title ?? "");
	const tagBag = fold((memory.keywords ?? []).join(" "));
	const bodyBag = fold(memory.text ?? "");
	if (titleBag.size + tagBag.size + bodyBag.size === 0) return 0;
	let raw = 0;
	for (const [token, weight] of queryTokens) {
		const titleHits = titleBag.get(token) ?? 0;
		const tagHits = tagBag.get(token) ?? 0;
		const bodyHits = bodyBag.get(token) ?? 0;
		raw += weight * TITLE_WEIGHT * Math.min(titleHits, 2);
		raw += weight * TAG_WEIGHT * Math.min(tagHits, 2);
		raw += weight * BODY_WEIGHT * Math.min(bodyHits, 2);
	}
	return raw;
}
/** Query token weights: tokens rarer in the query corpus weigh more. */
function queryWeights(query) {
	const tokens = tokenize(query);
	const counts = /* @__PURE__ */ new Map();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	const weights = /* @__PURE__ */ new Map();
	for (const [token, count] of counts) weights.set(token, 1 / Math.sqrt(count));
	return weights;
}
/** Rank active memories of one workspace against a query. */
function recallMemories(memories, query, options) {
	const weights = queryWeights(query);
	if (weights.size === 0) return [];
	const scored = [];
	for (const [memoryId, memory] of memories) {
		const raw = rawScore(memory, weights);
		if (raw < options.minScore) continue;
		scored.push({
			memoryId,
			title: memory.title ?? "",
			text: memory.text,
			score: raw * decay(memory.createdAt, options.now, options.halfLifeDays),
			createdAt: memory.createdAt,
			keywords: memory.keywords
		});
	}
	scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
	return scored.slice(0, options.limit);
}
/**
* R19 需求⑧: when a user need matches memories, surface the topic set those
* conclusions belong to, so the hub can answer from — or activate — the right
* set immediately instead of searching again.
*
* Matching is the same index-weighted rule as memory recall (title ×3, tags ×2,
* body ×1), and archived sets are ignored. It is pure and LLM-free.
*/
function matchTopicSets(topicSets, query, limit = 3) {
	const weights = queryWeights(query);
	if (weights.size === 0) return [];
	const matches = [];
	for (const [id, topicSet] of topicSets) {
		if (topicSet.status && topicSet.status !== "active") continue;
		const fold = (text) => {
			const bag = /* @__PURE__ */ new Map();
			for (const token of tokenize(text)) bag.set(token, (bag.get(token) ?? 0) + 1);
			return bag;
		};
		const titleBag = fold(topicSet.title ?? "");
		const tagBag = fold((topicSet.keywords ?? []).join(" "));
		const bodyBag = fold(topicSet.summary ?? "");
		let score = 0;
		for (const [token, weight] of weights) {
			score += weight * 3 * Math.min(titleBag.get(token) ?? 0, 2);
			score += weight * 2 * Math.min(tagBag.get(token) ?? 0, 2);
			score += weight * 1 * Math.min(bodyBag.get(token) ?? 0, 2);
		}
		if (score <= 0) continue;
		matches.push({
			id,
			title: topicSet.title,
			tags: [...topicSet.keywords ?? []],
			score
		});
	}
	matches.sort((a, b) => b.score - a.score);
	return matches.slice(0, Math.max(1, Math.min(limit, 8)));
}
/** Build the model-facing recall card text (温和起步, injectStyle 可配置). */
function renderRecallCard(items, style, topicSets = []) {
	if (items.length === 0) return "";
	const lines = items.map((item, index) => `${index + 1}. ${renderRecordLine({
		title: item.title,
		text: item.text,
		tags: item.keywords
	})}`);
	const hints = topicSets.length > 0 ? [`相关话题集：${topicSets.map((topicSet) => topicSet.title).join("、")}（命中记忆时可直接激活或派发到该集）`] : [];
	if (style === "plain") return [
		"[SuperMemory 相关记忆]",
		...lines,
		...hints
	].join("\n");
	return [
		"[SuperMemory 相关记忆]",
		"以下记忆可能与本话题相关，仅供参考；与当前指令冲突时以当前指令为准。",
		"记忆只存结论性事实/决策（不是过程流水账）。",
		...lines,
		...hints
	].join("\n");
}
export { renderRecallCard as a, deriveTitle as c, renderRecordLine as d, tagsOfBody as f, recallMemories as i, mergeTags as l, queryWeights as n, tokenize as o, extractFacts as p, rawScore as r, assessConclusion as s, matchTopicSets as t, normalizeTags as u };
