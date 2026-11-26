import { a as dropNote, g as updateMember, i as clipWithNote, p as setTopicSetModel, t as charCount } from "./clip-DqI2q7mY.js";
// src/injection-titles.ts
/**
* R56/R57: the ONE registry of context-injection card names.
*
* Every card this plugin injects into a model context carries TWO visible names,
* and both come from the same registry entry:
*
*   1. 卡片标题（宿主「上下文注入 <label>」行的 label）= 注入消息的 source.kind
*      = injectionLabel(kind)（不带方括号）。
*   2. 内容首行标题 = [label] = injectionTitle(kind)（带方括号）。
*
* 宿主证据（DSH 0.2.2，详见 DEV-NOTES §70.2）：
*   - dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:60
*     `contextProducer(source)` 的 default 分支 label = source.kind（宿主注释
*     明确「keep an unknown producer visible by its durable kind」）；
*   - dsh-client-ui-chat/src/client/chat/ContextInjectionRow.tsx:57 折叠行标题是
*     固定的「上下文注入」（locale `message.contextInjection`，role 'recall' 时
*     为「跨会话召回」）；
*   - 同文件 :69 把 producer.label 渲染成标题里的来源段；:70-73 只对
*     form='notice' 再追加 source.summary。
* 因此「让每类注入用不同卡片标题」= 让每类注入的 source.kind 不同。
*
* ## 命名约定（新增注入卡必须遵守）
*
* 1. 所有上下文注入卡名字以 supermemory- 开头。
* 2. 相关内容类用 supermemory-相关<主题>（话题 / 记忆 / 分支会话 / 能力…）：
*    同族前缀 + 卡片所讲的主题；话题候选是相关话题族的子卡。
* 3. 功能性卡用 supermemory-<功能>（小写 kebab，如 hub-role / plugin-prompt /
*    notice），保持 ASCII——约定测试锁定
*    ^\[supermemory-(相关.+|[a-z][a-z-]*)\]$ 与同形裸名正则。
* 4. 禁止在渲染处手写标题字符串：一律 injectionTitle(kind)（枚举用
*    injectionTitles()）；注入 source 一律 injectionSource(kind, form?)
*    （src/source.ts）——手写 `kind: 'supermemory'` 作为卡片 label 就是回归，
*    R57 冒烟会扫描 prestep.ts / route.ts 判失败。
* 5. 新增注入卡必须「先登记」：本文件加常量与 kind，再渲染、再测试（精确匹配 +
*    约定正则 + source.kind 断言）、最后写文档——登记 → 渲染 → 测试 → 文档。
*
* ## 例外：relay / 消息传输前缀不是注入卡
*
* [supermemory-relay <branch>]、[supermemory-group-relay <group>]、
* [supermemory-dispatch <id>]、[supermemory-resume <id>]、
* [supermemory-questions]、[supermemory-panel-reply]、[supermemory-topic-set]
* 是消息头：在会话之间传输，relay 管线会解析它们并携带 id/载荷。它们不经过本
* 注册表、不改名，改了会破坏回送。见 DEV-NOTES §69.2。
*
* relay 消息的 source.kind 也保持 'supermemory'（observe.ts 用
* source.deliveryId + kind 'supermemory' 确认投递）——那些卡由插件自己的
* 客户端卡片渲染，不走宿主的「上下文注入 <label>」行。
* @module supermemory/injection-titles
*/
/** 卡片种类 → 裸名（不带方括号）。新增卡片在这里登记一个 kind。 */
const INJECTION_TITLES = {
	/** 相关话题集（激活话题集的上下文卡）。 */
	topic: "supermemory-相关话题",
	/** 候选话题集——只提示、从不切换（相关话题族的子卡）。 */
	topicCandidate: "supermemory-相关话题候选",
	/** 相关记忆（开场召回卡）。 */
	memory: "supermemory-相关记忆",
	/** 同一请求内后补的相关记忆（过程内补充卡）。 */
	memoryRepeat: "supermemory-相关记忆补充",
	/** 关联分支会话：中枢的分支 + 命中话题集的分支清单。 */
	branch: "supermemory-相关分支会话",
	/** 固化能力精简索引（正文用 sm_cap_doc 按需读取）。 */
	capability: "supermemory-相关能力",
	/** 中枢角色提示（功能性卡）。 */
	hubRole: "supermemory-hub-role",
	/** 插件记忆使用约定（功能性卡）。 */
	pluginPrompt: "supermemory-plugin-prompt",
	/** 中断任务公告（功能性卡）。 */
	notice: "supermemory-notice"
};
/** 带方括号的卡片标题（内容首行），例如 [supermemory-相关记忆]。 */
function injectionTitle(kind) {
	return "[" + INJECTION_TITLES[kind] + "]";
}
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
	"这些",
	"那些",
	"一下",
	"什么",
	"怎么",
	"如何",
	"请",
	"帮我把",
	"记得",
	"可以",
	"需要",
	"已经",
	"还有",
	"以及",
	"之后",
	"之前",
	"如果",
	"因为",
	"所以",
	"但是",
	"而且",
	"并且",
	"或者",
	"对于",
	"关于",
	"通过",
	"根据",
	"按照",
	"其中",
	"其它",
	"其他",
	"是否",
	"能否",
	"我们",
	"你们",
	"他们",
	"的一",
	"是一",
	"是不",
	"不是"
]);
/**
* CJK 功能字：CJK 关键词按这些字切段（替代逐字双字滑窗）。滑窗会跨词产出
* 「本任/务是/是并」式碎片，切段取词至少保证每个关键词落在一个词的内部。
*/
const CJK_STOP_CHARS = /* @__PURE__ */ new Set([..."的了和是在与及或等之于为以对这那又还就都也只再没不很被把将从向让其呢吗吧呀啊哦之乎者也"]);
/** 段长上限：更长的段按前几个字截断（避免把整句当一个标签）。 */
const CJK_SEGMENT_MAX = 4;
/** CJK 关键词只从前 N 个汉字里取（限制来源，长文不无限产出标签）。 */
const CJK_SOURCE_CHARS = 120;
/** CJK 关键词数量上限。 */
const CJK_KEYWORD_MAX = 8;
/**
* 派发/续跑的包装文本与元数据：这些行是插件自己的信封，不是用户结论。
* （命中任意一条即整条跳过，不再进入任何 pattern。）
*/
const WRAPPER_PATTERNS = [
	/本任务是并行组/i,
	/并行组的一员/i,
	/只负责这一个任务/i,
	/全部成员到达终态/i,
	/原派发\s*dsp-/i,
	/派发Id/i,
	/dispatchId/i,
	/\bdsp-[a-z0-9]{4,}/i,
	/\bbranch-[a-z0-9]{4,}/i,
	/分支会话[:：]/,
	/supermemory-dispatch/i,
	/越界请汇报/i
];
/** 命令行头（纯命令行/版本行判定：整行无汉字且以这些词开头）。 */
const COMMAND_HEADS = /^(?:git|pnpm|npm|npx|node|python3?|pip3?|cmd|powershell?|bash|sh|zsh|docker|kubectl|adb|tsc|eslint|prettier|vitest|jest|make|curl|wget|ssh|scp|rsync|sudo|cd|ls|cat|echo|grep|find|rm|cp|mv|mkdir|touch|chmod|chown|export|set|source)\b/i;
/** 纯版本行：v1.2.3 / 1.2.3。 */
const VERSION_LINE = /^\s*v?\d+(?:\.\d+)+\s*$/;
/** 疑问句尾巴。 */
const QUESTION_END = /[？?]\s*$/;
/** 疑问句开头（且句中没有任何陈述动词时才算疑问）。 */
const QUESTION_HEAD = /^(?:怎么|怎样|如何|为什么|为啥|啥|哪些|哪个|哪几|是否|能不能|可不可以|可不可|请问|我想问|想问|问一下|帮忙问|有没有|是不是)/;
const STATEMENT_MARK = /(?:是|为|等于|应该是|应当|应该|需要|必须|可以|要用|使用|采用|默认|约定|禁止|不要|支持|一律|务必)/;
/** 定义主语必须至少有 2 个汉字或 3 个以上拉丁字符（避免 "1"/"12" 当标题）。 */
function subjectUsable(subject) {
	if ((subject.match(/[\u4e00-\u9fff]/g) ?? []).length >= 2) return true;
	return (subject.match(/[a-z0-9]/gi) ?? []).length >= 3;
}
/** 纯命令行 / 版本行：去掉可选的行首编号后整行是 ASCII 且以命令词开头。 */
function isCommandLine(line) {
	const stripped = line.replace(/^\s*\d{1,2}[.)、]\s*/, "");
	return COMMAND_HEADS.test(stripped) && !/[\u4e00-\u9fff]/.test(stripped);
}
/** 非结论文本：派发包装、纯命令行/版本行、疑问句——一律不进记忆。 */
function isNonConclusion(clean) {
	if (WRAPPER_PATTERNS.some((pattern) => pattern.test(clean))) return true;
	if (isCommandLine(clean)) return true;
	if (VERSION_LINE.test(clean)) return true;
	if (QUESTION_END.test(clean)) return true;
	return QUESTION_HEAD.test(clean.trim()) && !STATEMENT_MARK.test(clean);
}
/**
* Extract keywords from a fact text (latin words + CJK segment words).
*
* R27: CJK 取词从「逐字双字滑窗」改为「功能字切段取词」——滑窗会跨功能字产出
* 「本任/务是」式碎片；切段后每个关键词都落在一个词的内部，并限制来源长度
* （前 {@link CJK_SOURCE_CHARS} 个汉字）与数量（{@link CJK_KEYWORD_MAX} 个）。
*/
function keywordsOf(text) {
	const body = String(text ?? "");
	const latin = [];
	const lower = body.toLowerCase();
	for (const m of lower.matchAll(/[a-z0-9_+#.\-]{2,}/g)) if (!STOP_WORDS.has(m[0])) latin.push(m[0]);
	const chars = (body.match(/[\u4e00-\u9fff]/g) ?? []).slice(0, CJK_SOURCE_CHARS);
	const cjk = [];
	let segment = "";
	const flush = () => {
		if (segment.length >= 2) cjk.push(segment.slice(0, CJK_SEGMENT_MAX));
		segment = "";
	};
	for (const char of chars) if (CJK_STOP_CHARS.has(char)) flush();
	else segment += char;
	flush();
	return [.../* @__PURE__ */ new Set([...latin.slice(0, 12), ...cjk.slice(0, CJK_KEYWORD_MAX)])].slice(0, 24);
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
		if (isNonConclusion(clean)) return;
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
			if (m && subjectUsable(m[1])) push(`${m[1].trim()}是${m[2].trim()}`);
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
/** The topic-set hint is kept only while this much room remains for records. */
const HINT_MIN_ROOM = 96;
/** Build the model-facing recall card text (温和起步, injectStyle 可配置).
*
* R47 需求②: `options.budget` makes the card budget-aware instead of letting
* the caller hard-`slice` it (the old `.slice(0, maxChars)` in prestep.ts cut
* mid-sentence, mid-tag, with no sign that anything was missing). Degradation
* is by PRIORITY, never mid-body:
*   1. the header is paid for first; the topic-set hint is kept only while it
*      still leaves room for a record — a card must not become all preamble;
*   2. records are kept whole while they fit (score order = relevance order);
*   3. a record that no longer fits whole has its BODY clipped at a sentence
*      boundary with an explicit omission note (title/tags stay whole);
*   4. a record whose remaining share cannot hold a meaningful body
*      (`RECALL_BODY_MIN`) is dropped WHOLE, and a later, smaller record may
*      still take its place;
*   5. the card ends with `…（已省略 k 项…）` when anything was dropped.
*
* Accounting counts CODE POINTS and reserves one newline per line, so the
* assembled card never exceeds `options.budget`; the note is budgeted too (an
* overflow retries with the note's real length reserved, bounded attempts).
*/
function renderRecallCard(items, style, topicSets = [], options = {}) {
	if (items.length === 0) return "";
	const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : 0;
	const header = style === "plain" ? [injectionTitle("memory")] : [
		injectionTitle("memory"),
		"以下记忆可能与本话题相关，仅供参考；与当前指令冲突时以当前指令为准。",
		"记忆只存结论性事实/决策（不是过程流水账）。"
	];
	const hints = topicSets.length > 0 ? [`相关话题集：${topicSets.map((topicSet) => topicSet.title).join("、")}（命中记忆时可直接激活或派发到该集）`] : [];
	if (!budget) {
		const lines = items.map((item, index) => `${index + 1}. ${renderRecordLine({
			title: item.title,
			text: item.text,
			tags: item.keywords
		})}`);
		return [
			...header,
			...lines,
			...hints
		].join("\n");
	}
	const minimal = [injectionTitle("memory")];
	if (budget - minimal.reduce((sum, line) => sum + charCount(line) + 1, 0) < 116) {
		header.length = 0;
		header.push(...minimal);
	}
	const headerCost = header.reduce((sum, line) => sum + charCount(line) + 1, 0);
	const hintCostAll = hints.reduce((sum, line) => sum + charCount(line) + 1, 0);
	const compose = (reserve, withHint = true) => {
		const hintLines = budget - headerCost - hintCostAll - reserve >= HINT_MIN_ROOM ? hints : [];
		const hintCost = hintLines.reduce((sum, line) => sum + charCount(line) + 1, 0);
		let remaining = budget - headerCost - hintCost - reserve;
		const lines = [];
		let dropped = 0;
		for (const [index, item] of items.entries()) {
			const prefix = `${index + 1}. `;
			const tail = item.keywords.length > 0 ? ` ｜标签: ${item.keywords.join("、")}` : "";
			const head = item.title && item.title !== item.text.trim() ? `【${item.title}】` : "";
			const overhead = charCount(prefix) + charCount(head) + charCount(tail) + 1;
			const whole = `${prefix}${head}${item.text}${tail}`;
			const wholeCost = charCount(whole) + 1;
			if (wholeCost <= remaining) {
				lines.push(whole);
				remaining -= wholeCost;
				continue;
			}
			const bodyShare = remaining - overhead;
			if (bodyShare >= 64) {
				const line = `${prefix}${head}${clipWithNote(item.text, bodyShare, item.title ? `复取：memory_recall 「${item.title}」` : void 0)}${tail}`;
				lines.push(line);
				remaining -= charCount(line) + 1;
				if (remaining <= 0) {
					dropped += items.length - index - 1;
					break;
				}
				continue;
			}
			dropped += 1;
		}
		const note = dropNote(dropped, withHint ? options.hint : void 0);
		return {
			text: [
				...header,
				...hintLines,
				...lines,
				...note ? [note] : []
			].join("\n"),
			note,
			count: dropped
		};
	};
	let pass = compose(0);
	for (let attempt = 0; attempt < 3 && pass.note; attempt += 1) {
		if (charCount(pass.text) <= budget) break;
		pass = compose(charCount(pass.note) + 1);
	}
	if (charCount(pass.text) > budget && pass.count > 0) {
		pass = compose(charCount(dropNote(pass.count)) + 1, false);
		if (charCount(pass.text) > budget) return "";
	}
	return pass.text;
}
// src/model.ts
/** The hub agent's current selection, when readable. */
function hubSelection(agent) {
	const current = agent?.model?.current?.();
	if (current?.provider && current?.model) return {
		provider: current.provider,
		model: current.model,
		...current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}
	};
}
/** Runtime enumeration of provider/model options for the question UI. */
async function enumerateModels(ctx) {
	let llm;
	try {
		llm = ctx.get?.("llm");
	} catch {
		llm = void 0;
	}
	if (!llm) return {
		providers: [],
		models: []
	};
	const providers = llm.listProviders();
	const models = [];
	for (const provider of providers) try {
		const list = await llm.listModels(provider.id);
		for (const m of list) models.push({
			provider: m.provider || provider.id,
			id: m.id,
			name: m.name || m.id
		});
	} catch {}
	return {
		providers,
		models
	};
}
/**
* Ask for a topic-set default model. Falls back to the hub model when the
* question channel is unavailable (headless / no client).
*/
async function askDefaultModel(deps, agent) {
	const { ctx, logger } = deps;
	const hub = hubSelection(agent);
	try {
		const { models } = await enumerateModels(ctx);
		const options = [...hub ? [{
			label: "跟随中枢模型",
			description: `${hub.provider}/${hub.model}`
		}] : [], ...models.slice(0, 12).map((m) => ({
			label: `${m.provider}/${m.id}`,
			description: m.name
		}))];
		if (options.length === 0) {
			const answer = await ctx.userQuestions.ask({
				questions: [{
					id: "supermemory-model",
					header: "默认模型",
					question: "该话题集使用哪个默认模型？当前没有可用目录，请直接输入 provider 与 model（如 step step-5-preview）。"
				}],
				...agent ? { agent } : {}
			});
			return parseFreeInput(answer?.answers?.[0]?.custom ?? answer?.answers?.[0]?.selected?.[0]);
		}
		const answer = await ctx.userQuestions.ask({
			questions: [{
				id: "supermemory-model",
				header: "默认模型",
				question: "该话题集使用哪个默认模型？",
				options
			}],
			...agent ? { agent } : {}
		});
		const selected = answer?.answers?.[0]?.selected?.[0] ?? "";
		const custom = answer?.answers?.[0]?.custom;
		if (selected === "跟随中枢模型" && hub) return { ...hub };
		const fromSelected = selected.includes("/") ? selected.split("/", 2) : void 0;
		if (fromSelected) return {
			provider: fromSelected[0],
			model: fromSelected[1]
		};
		return parseFreeInput(custom) ?? (hub ? { ...hub } : void 0);
	} catch (error) {
		logger.warn(`supermemory: default-model question unavailable: ${String(error).slice(0, 160)}`);
		return hub ? { ...hub } : void 0;
	}
}
function parseFreeInput(raw) {
	if (!raw) return void 0;
	const parts = raw.trim().split(/[\s,，/]+/).filter(Boolean);
	if (parts.length >= 2) return {
		provider: parts[0],
		model: parts[1]
	};
}
/** The topic set that lists one session as a branch (undefined when none). */
function findMemberTopicSet(store, sessionId) {
	for (const [topicSetId, record] of store.topicsets.entries()) if (record.members.some((member) => member.sessionId === sessionId)) return topicSetId;
}
/** Apply a model selection to a live agent and/or persist it as an override. */
async function applyModelSelection(deps, target, selection) {
	const { ctx, store, logger } = deps;
	let live = false;
	if (target.branchSessionId) {
		const agent = ctx.agents.get(target.branchSessionId);
		const owner = (target.topicSetId && store.topicsets.get(target.topicSetId) ? target.topicSetId : void 0) ?? findMemberTopicSet(store, target.branchSessionId);
		if (!agent && !owner) return {
			applied: "",
			live: false
		};
		if (agent) {
			agent.model.select(selection);
			live = true;
		}
		if (owner) await updateMember(store, owner, target.branchSessionId, {
			model: `${selection.provider}/${selection.model}`,
			modelOverridden: true
		});
		return {
			applied: target.branchSessionId,
			live
		};
	}
	if (target.topicSetId) {
		if (!store.topicsets.get(target.topicSetId)) return {
			applied: "",
			live: false
		};
		await setTopicSetModel(store, target.topicSetId, { ...selection });
		const topicSet = store.topicsets.get(target.topicSetId);
		for (const member of topicSet?.members ?? []) {
			if (member.modelOverridden) continue;
			const agent = ctx.agents.get(member.sessionId);
			if (agent) {
				agent.model.select(selection);
				live = true;
			}
			await updateMember(store, target.topicSetId, member.sessionId, { model: `${selection.provider}/${selection.model}` });
		}
		return {
			applied: target.topicSetId,
			live
		};
	}
	logger.warn("supermemory: applyModelSelection without target");
	return {
		applied: "",
		live
	};
}
export { tagsOfBody as _, matchTopicSets as a, injectionTitle as b, recallMemories as c, MEMORY_TEXT_MAX as d, assessConclusion as f, renderRecordLine as g, normalizeTags as h, hubSelection as i, renderRecallCard as l, mergeTags as m, askDefaultModel as n, queryWeights as o, deriveTitle as p, enumerateModels as r, rawScore as s, applyModelSelection as t, tokenize as u, extractFacts as v, INJECTION_TITLES as y };
