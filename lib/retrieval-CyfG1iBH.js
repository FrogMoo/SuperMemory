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
/** The card line every UI and the model-facing render share. */
function renderRecordLine(record) {
	const title = record.title?.trim();
	const tags = (record.tags ?? []).filter(Boolean);
	const head = title && title !== record.text.trim() ? `【${title}】` : "";
	const tail = tags.length > 0 ? ` ｜标签: ${tags.join("、")}` : "";
	return `${head}${record.text}${tail}`;
}
export { renderRecordLine as a, normalizeTags as i, deriveTitle as n, tagsOfBody as o, mergeTags as r, extractFacts as s, assessConclusion as t };
