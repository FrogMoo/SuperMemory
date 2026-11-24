import { h as normalizeTags, i as hubSelection, o as queryWeights, p as deriveTitle, r as enumerateModels, s as rawScore, u as tokenize } from "./model-LOgQOG1d.js";
import { t as newId } from "./store-DXRBkPpa.js";
/**
* The route a memory decision uses: the acting session's hub model first, then
* the first enumerated catalog entry. `undefined` means "no model available" —
* every caller then keeps its heuristic behaviour (and burns no tokens).
*/
async function resolveLlmRoute(ctx, sessionId) {
	if (!ctx) return void 0;
	if (sessionId) try {
		const agent = ctx.agents?.get?.(sessionId);
		const hub = hubSelection(agent);
		if (hub) return {
			provider: hub.provider,
			model: hub.model,
			...hub.reasoningEffort ? { reasoningEffort: hub.reasoningEffort } : {}
		};
	} catch {}
	try {
		const { models } = await enumerateModels(ctx);
		const first = models[0];
		if (first) return {
			provider: first.provider,
			model: first.id
		};
	} catch {}
}
/** The `llm` service through `ctx.get` (never the property: see model.ts). */
function llmServiceOf(ctx) {
	try {
		return ctx?.get?.("llm");
	} catch {
		return;
	}
}
/** Strip code fences/quotes and parse the first JSON object of an answer. */
function parseJsonObject(text) {
	const clean = String(text ?? "").replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
	const start = clean.indexOf("{");
	const end = clean.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	try {
		return JSON.parse(clean.slice(start, end + 1));
	} catch {
		return;
	}
}
/**
* One model call whose answer must be a JSON object. Returns `undefined` when
* there is no model, the call fails, it times out, or the answer carries no
* usable JSON — the caller degrades silently in every one of those cases.
*/
async function askLlmJson(deps, request) {
	const { ctx, logger, sessionId } = deps;
	if (!ctx) return void 0;
	const llm = llmServiceOf(ctx);
	if (!llm || typeof llm.stream !== "function") return void 0;
	const route = await resolveLlmRoute(ctx, sessionId);
	if (!route) return void 0;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 2e4);
	let text = "";
	try {
		const stream = llm.stream({
			provider: route.provider,
			model: route.model,
			...route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {},
			system: request.system,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: request.user
				}]
			}],
			maxTokens: request.maxTokens ?? 600,
			temperature: .2,
			signal: controller.signal
		});
		for await (const chunk of stream) if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
	} catch (error) {
		logger?.warn(`supermemory: llm-json call failed: ${String(error).slice(0, 160)}`);
		return;
	} finally {
		clearTimeout(timer);
	}
	const parsed = parseJsonObject(text);
	if (parsed === void 0) logger?.warn("supermemory: llm-json answer did not contain a JSON object; degrading to the heuristic");
	return parsed;
}
/** Every collection row (empty when the medium predates the table). */
function collectionRows(store) {
	const table = store.memoryCollections;
	if (!table || typeof table.entries !== "function") return [];
	return [...table.entries()];
}
/** Collections of one workspace (archived excluded by default). */
function listCollections(store, workspaceKey, options = {}) {
	return collectionRows(store).filter(([, row]) => row.workspaceKey === workspaceKey && (options.includeArchived || row.status !== "archived"));
}
/** Title/id of the collection one entry belongs to ('' when uncollected). */
function collectionOfEntry(store, memory) {
	const id = memory.collectionId;
	if (!id) return void 0;
	return collectionRows(store).find(([rowId]) => rowId === id);
}
function tokenSet(text) {
	return new Set(tokenize(String(text ?? "")));
}
/** Bounded overlap: |A∩B| / min(|A|,|B|) — a subset counts fully. */
function overlapRatio(left, right) {
	if (left.size === 0 || right.size === 0) return 0;
	let hit = 0;
	for (const token of left) if (right.has(token)) hit += 1;
	return hit / Math.min(left.size, right.size);
}
/** Tag overlap: exact (case-insensitive) tag hits, falling back to token overlap. */
function tagOverlap(left, right) {
	const a = normalizeTags(left).map((tag) => tag.toLowerCase());
	const b = normalizeTags(right).map((tag) => tag.toLowerCase());
	if (a.length === 0 || b.length === 0) return 0;
	let hits = 0;
	for (const tag of a) if (b.includes(tag)) hits += 1;
	const exact = hits / Math.min(a.length, b.length);
	const tokens = overlapRatio(tokenSet(a.join(" ")), tokenSet(b.join(" ")));
	return Math.max(exact, tokens);
}
/**
* 相似度分值（0–8）：标题×4 + 标签×3 + 正文×1，各项是**重合率**而不是命中次数，
* 所以分值与标题/标签长度无关，阈值可解释：>=4 高相似、>=1.75 中等、其余低。
*/
function shapeScore(entry, collection) {
	const title = overlapRatio(tokenSet(entry.title), tokenSet(collection.title));
	const tags = tagOverlap(entry.keywords ?? [], collection.keywords ?? []);
	const body = overlapRatio(tokenSet(entry.summary), tokenSet(collection.summary));
	return 4 * title + 3 * tags + 1 * body;
}
/** 分值 → 三档。 */
function tierOfScore(score) {
	if (!(score > 0)) return "low";
	if (score >= 4) return "high";
	if (score >= 1.75) return "medium";
	return "low";
}
function foldCounts(text) {
	const bag = /* @__PURE__ */ new Map();
	for (const token of tokenize(text)) bag.set(token, (bag.get(token) ?? 0) + 1);
	return bag;
}
/**
* 集合级匹配（读取侧第一级，也是写入侧候选来源）：与记忆评分同一套权重
* （标题×4、标签×3、正文×1），但作用在集合的三个字段上，所以「上次结论所在的
* 集合」会被同一条查询命中，从而把该集合的条目一起带出来。
*/
function matchCollections(collections, query, limit = 3, minScore = 0) {
	const weights = queryWeights(query);
	if (weights.size === 0) return [];
	const matches = [];
	for (const [collectionId, row] of collections) {
		if (row.status === "archived") continue;
		const titleBag = foldCounts(row.title ?? "");
		const tagBag = foldCounts((row.keywords ?? []).join(" "));
		const bodyBag = foldCounts(row.summary ?? "");
		let score = 0;
		for (const [token, weight] of weights) {
			score += weight * 4 * Math.min(titleBag.get(token) ?? 0, 2);
			score += weight * 3 * Math.min(tagBag.get(token) ?? 0, 2);
			score += weight * 1 * Math.min(bodyBag.get(token) ?? 0, 2);
		}
		if (score <= minScore) continue;
		matches.push({
			collectionId,
			title: row.title,
			keywords: [...row.keywords ?? []],
			score,
			tier: tierOfScore(score)
		});
	}
	matches.sort((a, b) => b.score - a.score);
	return matches.slice(0, Math.max(1, Math.min(limit, 8)));
}
/** Best collection for an incoming entry, with its tier (null when none matches). */
function bestCollectionFor(entry, collections) {
	let best = null;
	for (const [collectionId, row] of collections) {
		if (row.status === "archived") continue;
		const score = shapeScore(entry, {
			title: row.title,
			keywords: row.keywords,
			summary: row.summary
		});
		if (score <= 0) continue;
		if (!best || score > best.score) best = {
			collectionId,
			title: row.title,
			keywords: [...row.keywords ?? []],
			score,
			tier: tierOfScore(score)
		};
	}
	return best;
}
function decay(createdAt, now, halfLifeDays) {
	const ageDays = Math.max(0, (now - createdAt) / 864e5);
	return Math.pow(.5, ageDays / Math.max(1, halfLifeDays));
}
/** 集合上下文对条目的加成上限（避免一条弱命中被集合分淹没）。 */
const COLLECTION_BOOST = .5;
const COLLECTION_BOOST_CAP = 12;
/**
* 两级检索：先按查询给集合打分（一级），再在「命中集合的条目 ∪ 直接命中阈值
* 的条目」里精选（二级）。
*
* 排序分 = 直接分（标题×4/标签×3/正文×1）+ 0.5×集合分（封顶 12），再乘时间衰减：
* - 直接在正文里命中一次也可能进入结果（与旧行为一致）；
* - 只被集合上下文带出的条目（直接分 0）只有在集合足够强（≥ 高相似阈值）时才算候选，
*   否则集合命中会把整集条目都倒出来，精确度反而下降。
*/
function recallEntriesWithCollections(collections, memories, query, options, collectionLimit = 3) {
	const weights = queryWeights(query);
	if (weights.size === 0) return {
		items: [],
		collections: []
	};
	const matched = matchCollections(collections, query, collectionLimit);
	const boost = /* @__PURE__ */ new Map();
	for (const match of matched) boost.set(match.collectionId, match);
	const items = [];
	for (const [memoryId, memory] of memories) {
		if (memory.status !== "active") continue;
		const direct = rawScore(memory, weights);
		const collection = memory.collectionId ? boost.get(memory.collectionId) : void 0;
		const contextual = collection !== void 0 && (direct > 0 || collection.score >= 4);
		if (direct < options.minScore && !contextual) continue;
		const contextScore = collection ? Math.min(collection.score, COLLECTION_BOOST_CAP) : 0;
		const combined = direct + COLLECTION_BOOST * contextScore;
		items.push({
			memoryId,
			title: memory.title ?? "",
			text: memory.text,
			keywords: memory.keywords ?? [],
			createdAt: memory.createdAt,
			score: combined * decay(memory.createdAt, options.now, options.halfLifeDays),
			directScore: direct,
			collectionId: collection?.collectionId ?? "",
			collectionTitle: collection?.title ?? "",
			collectionTags: collection ? [...collection.keywords] : []
		});
	}
	items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
	return {
		items: items.slice(0, options.limit),
		collections: matched
	};
}
/**
* Every active collection of the workspace ranked against one entry (best
* first, capped at {@link COLLECTION_CANDIDATE_LIMIT}). Zero-similarity rows
* stay in the list on purpose: the model may still reuse a collection the
* heuristic cannot see (different wording, same project), and it is the one
* that decides "new set" — so the candidate list must not pre-decide that.
*/
function rankCollectionsFor(entry, collections, limit = 12) {
	const ranked = [];
	for (const [collectionId, row] of collections) {
		if (row.status === "archived") continue;
		const score = shapeScore(entry, {
			title: row.title,
			keywords: row.keywords,
			summary: row.summary
		});
		ranked.push({
			collectionId,
			title: row.title,
			keywords: [...row.keywords ?? []],
			summary: clip(row.summary ?? "", 200),
			score,
			tier: tierOfScore(score)
		});
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, Math.max(1, limit));
}
const DECISION_SYSTEM = [
	"你在维护 SuperMemory 的「记忆集合」归属。只输出一个 JSON 对象，不要代码围栏、不要解释。",
	"字段：{\"collectionId\":\"复用的候选集合 id（不新建时必填）\",\"createNew\":false,\"title\":\"新建时的集合标题（≤48字，必填）\",\"tags\":[\"新建时的 3–8 个检索短词\"],\"reason\":\"一句话理由（≤60字）\"}",
	"规则：",
	"- collectionId 必须是候选清单里的 id，不能编造；无法判断时也要按格式二选一回答。",
	"- 候选集合主题相近（同一项目/同一类约定/同一命令族）就复用，哪怕标题字面不同。",
	"- 只有当候选都不相关时才 createNew=true，并给出 title/tags。",
	"- reason 要短，说明为什么归入该集合或为什么另起一个。"
].join("\n");
/** The user half of the decision prompt (exported for smoke assertions). */
function buildCollectionDecisionPrompt(entry, candidates) {
	const lines = candidates.map((candidate, index) => {
		const tags = candidate.keywords.length ? ` ｜标签: ${candidate.keywords.join("、")}` : "";
		const summary = candidate.summary ? ` ｜梗概: ${clip(candidate.summary, 200)}` : "";
		return `${index + 1}. [${candidate.collectionId}] ${candidate.title}${tags}${summary}`;
	});
	return [
		`候选记忆集合（按相关度预排序，共 ${candidates.length} 个）：`,
		...lines,
		"",
		"待写入的记忆：",
		`标题：${clip(entry.title ?? "", 48) || "（无）"}`,
		`标签：${(entry.keywords ?? []).join("、") || "（无）"}`,
		`正文：${clip(entry.summary ?? "", 400) || "（无）"}`,
		"",
		"判断这条记忆应归入哪个候选集合，还是新建集合。只返回 JSON。"
	].join("\n");
}
/**
* Validate one model answer. An unusable answer (no object, an id outside the
* candidate list, createNew without a title, neither branch) yields undefined
* so the caller degrades to the similarity heuristic.
*/
function normalizeCollectionDecision(raw, candidates) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const record = raw;
	const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 120) : "";
	const wanted = typeof record.collectionId === "string" ? record.collectionId.trim() : "";
	if (wanted) {
		const hit = candidates.find((candidate) => candidate.collectionId === wanted);
		if (!hit) return void 0;
		return {
			kind: "reuse",
			collectionId: hit.collectionId,
			score: hit.score,
			reason
		};
	}
	if (record.createNew === true) {
		const title = String(record.title ?? "").trim();
		if (!title) return void 0;
		return {
			kind: "create",
			title,
			tags: normalizeTags(record.tags).slice(0, 8),
			reason
		};
	}
}
/**
* One model call deciding where an entry goes. Returns undefined — caller keeps
* the heuristic — when there is no ctx/llm/route, the call fails or times out,
* or the answer is not a valid decision.
*/
async function decideCollectionWithLlm(deps, entry, candidates) {
	if (!deps?.ctx || candidates.length === 0) return void 0;
	const answer = await askLlmJson({
		ctx: deps.ctx,
		logger: deps.logger,
		sessionId: deps.sessionId
	}, {
		system: DECISION_SYSTEM,
		user: buildCollectionDecisionPrompt(entry, candidates),
		maxTokens: 400
	});
	if (answer === void 0) return void 0;
	const decision = normalizeCollectionDecision(answer, candidates);
	if (!decision) {
		deps.logger?.warn("supermemory: collection decision answer was unusable; falling back to similarity");
		return;
	}
	return decision;
}
/**
* 回执里的一句话集合归属说明（tools.ts 的 memory_remember 与 panel.ts 的
* createMemory 共用，保证两条写入路径同一套词汇）。title 为空（老存储域没有
* 集合表）时返回 null，调用方按「未归集」渲染。
*/
function collectionTierNote(assignment) {
	if (!assignment.title) return null;
	if (assignment.created) return `新建记忆集合并写入：「${assignment.title}」${assignment.tier === "llm" ? "（模型判定）" : ""}`;
	if (assignment.tier === "high") return `归入记忆集合「${assignment.title}」（高相似复用）`;
	if (assignment.tier === "medium") return `归入相关记忆集合「${assignment.title}」（中等相似复用）`;
	if (assignment.tier === "llm") return `归入记忆集合「${assignment.title}」（模型判定）`;
	return `已写入指定记忆集合「${assignment.title}」`;
}
function clip(text, max) {
	const value = String(text ?? "").trim();
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
function newCollectionRecord(workspaceKey, title, keywords, summary, now) {
	return {
		workspaceKey,
		title: clip(title, 48) || "记忆集合",
		keywords: normalizeTags(keywords).slice(0, 12),
		summary: clip(summary, 240),
		status: "active",
		createdAt: now,
		updatedAt: now
	};
}
async function putCollection(store, record) {
	const id = newId("mc");
	const table = store.memoryCollections;
	if (!table) throw new Error("memory_collections 表不可用（存储域缺少该表）");
	await table.put(id, record);
	return id;
}
/**
* 为一条新条目决定归属集合（需求⑤：有相关集合就先加进去）。
*
* 决策顺序：
* 1. `collectionId` 显式指定：必须已存在，否则报错并列出候选；
* 2. `collection`（标题）显式指定：同名（忽略大小写/首尾空白）或相似度 ≥ 中等 → 复用，
*    否则以该标题新建集合；
* 3. 自动匹配（R27 需求④.3 起优先问模型）：
*    a. `options.deps.ctx` 可用且存在候选集合 → 让模型在候选里挑一个复用，或判定新建
*       （一次调用；校验失败/无模型/超时都静默降级到 b）；
*    b. 相似度启发式：高/中相似 → 复用（回执里注明相似档位），低相似/无匹配 → 新建集合，
*       新集合标题 = 条目标题、标签 = 条目标签、正文 = 条目正文（截断），与话题集同形。
*/
async function resolveCollectionForEntry(store, workspaceKey, entry, options = {}) {
	const now = options.now ?? Date.now();
	const shape = {
		title: entry.title,
		keywords: entry.keywords,
		summary: entry.summary ?? entry.text
	};
	if (!store.memoryCollections) {
		if (options.collectionId || options.collection && options.collection.trim()) return { error: "存储域缺少记忆集合表（memory_collections），无法写入指定集合。" };
		return {
			collectionId: "",
			title: "",
			tier: "low",
			created: false,
			explicit: false,
			score: 0
		};
	}
	const collections = listCollections(store, workspaceKey);
	if (options.collectionId) {
		const found = collections.find(([id]) => id === options.collectionId);
		if (!found) {
			const candidates = bestCollectionFor(shape, collections);
			return {
				error: `指定的记忆集合 ${options.collectionId} 不存在（或不属于当前工作区）。` + (candidates ? `最接近的是「${candidates.title}」。` : ""),
				...candidates ? { candidates: [candidates] } : {}
			};
		}
		return {
			collectionId: found[0],
			title: found[1].title,
			tier: "explicit",
			created: false,
			explicit: true,
			score: 1
		};
	}
	if (options.collection && options.collection.trim()) {
		const wanted = options.collection.trim().toLowerCase();
		const exact = collections.find(([, row]) => row.title.trim().toLowerCase() === wanted);
		if (exact) return {
			collectionId: exact[0],
			title: exact[1].title,
			tier: "explicit",
			created: false,
			explicit: true,
			score: 1
		};
		const similar = bestCollectionFor({
			...shape,
			title: options.collection
		}, collections);
		if (similar && similar.tier !== "low") return {
			collectionId: similar.collectionId,
			title: similar.title,
			tier: "medium",
			created: false,
			explicit: true,
			score: similar.score
		};
		const record = newCollectionRecord(workspaceKey, options.collection, shape.keywords ?? [], shape.summary ?? "", now);
		return {
			collectionId: await putCollection(store, record),
			title: record.title,
			tier: "explicit",
			created: true,
			explicit: true,
			score: 1
		};
	}
	const ranked = rankCollectionsFor(shape, collections);
	if (ranked.length > 0) {
		const decision = await decideCollectionWithLlm(options.deps, shape, ranked);
		if (decision?.kind === "reuse") {
			const found = collections.find(([id]) => id === decision.collectionId);
			if (found) {
				options.deps?.logger?.info?.(`supermemory: memory collection decided by model → ${found[1].title}${decision.reason ? ` (${decision.reason})` : ""}`);
				return {
					collectionId: found[0],
					title: found[1].title,
					tier: "llm",
					created: false,
					explicit: false,
					score: decision.score
				};
			}
		}
		if (decision?.kind === "create") {
			const record = newCollectionRecord(workspaceKey, decision.title, decision.tags.length > 0 ? decision.tags : shape.keywords ?? [], shape.summary ?? "", now);
			const id = await putCollection(store, record);
			options.deps?.logger?.info?.(`supermemory: memory collection created by model: ${record.title}${decision.reason ? ` (${decision.reason})` : ""}`);
			return {
				collectionId: id,
				title: record.title,
				tier: "llm",
				created: true,
				explicit: false,
				score: 0
			};
		}
	}
	const match = bestCollectionFor(shape, collections);
	if (match && match.tier !== "low") return {
		collectionId: match.collectionId,
		title: match.title,
		tier: match.tier,
		created: false,
		explicit: false,
		score: match.score
	};
	const record = newCollectionRecord(workspaceKey, shape.title ?? "", shape.keywords ?? [], shape.summary ?? "", now);
	return {
		collectionId: await putCollection(store, record),
		title: record.title,
		tier: match ? match.tier : "low",
		created: true,
		explicit: false,
		score: match?.score ?? 0
	};
}
/** Touch a collection's updatedAt (a new entry was appended). */
async function touchCollection(store, collectionId, now = Date.now()) {
	const table = store.memoryCollections;
	if (!table || typeof table.update !== "function") return;
	if (!table.get(collectionId)) return;
	await table.update(collectionId, (row) => ({
		...row,
		updatedAt: now
	}));
}
/** 迁移后条目的集合归属是否已失效（集合被删/跨工作区）。 */
function collectionIdValid(store, workspaceKey, memory) {
	if (!memory.collectionId) return false;
	return collectionRows(store).some(([id, row]) => id === memory.collectionId && row.workspaceKey === workspaceKey);
}
/** 标签重合（Jaccard）用于聚类：旧记录往往只有标签可用。 */
function jaccard(left, right) {
	const a = new Set(normalizeTags(left).map((tag) => tag.toLowerCase()));
	const b = new Set(normalizeTags(right).map((tag) => tag.toLowerCase()));
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const tag of a) if (b.has(tag)) inter += 1;
	return inter / (a.size + b.size - inter);
}
/** 聚类：共享标签（Jaccard ≥ 0.34）或标题 token 重合 ≥ 0.5 的旧条目归为一簇。 */
function clusterFlatMemories(flat) {
	const clusters = [];
	for (const [id, memory] of flat) {
		const tags = normalizeTags(memory.keywords);
		const titleTokens = tokenSet(memory.title);
		let best = null;
		for (const cluster of clusters) {
			const tagScore = jaccard(tags, cluster.tags);
			const titleScore = overlapRatio(titleTokens, cluster.titleTokens);
			const score = Math.max(tagScore, titleScore);
			if (score < .34) continue;
			if (!best || score > best.score) best = {
				cluster,
				score
			};
		}
		if (best) {
			best.cluster.entries.push([id, memory]);
			best.cluster.tags = normalizeTags([...best.cluster.tags, ...tags]);
			for (const token of titleTokens) best.cluster.titleTokens.add(token);
			continue;
		}
		clusters.push({
			entries: [[id, memory]],
			tags: [...tags],
			titleTokens
		});
	}
	return clusters;
}
/** 簇的集合标题：主导标签 + 「记忆」，无标签时用条目标题。 */
function clusterTitle(cluster) {
	const tags = cluster.tags;
	if (tags.length > 0) return `${tags[0]} 记忆`;
	const first = cluster.entries[0]?.[1];
	return deriveTitle(first?.title || first?.text || "", "记忆集合");
}
/**
* 惰性迁移：把当前工作区里「没有集合归属」的旧记忆按标签/标题聚类，补建集合并回写
* `collectionId`。只做加法（新建集合 + 补一个字段），**不删除、不改写正文/标题/标签**，
* 已有有效归属的条目直接跳过，所以可以安全地在每次 recall/remember/export 前调用。
*/
async function migrateFlatMemories(store, workspaceKey, now = Date.now()) {
	const table = store.memoryCollections;
	if (!table) return {
		collections: 0,
		entries: 0
	};
	const flat = [];
	for (const entry of store.memories.entries()) {
		const [id, memory] = entry;
		if (memory.workspaceKey !== workspaceKey) continue;
		if (memory.status !== "active") continue;
		if (collectionIdValid(store, workspaceKey, memory)) continue;
		flat.push([id, memory]);
	}
	if (flat.length === 0) return {
		collections: 0,
		entries: 0
	};
	let created = 0;
	let assigned = 0;
	for (const cluster of clusterFlatMemories(flat)) {
		const title = clusterTitle(cluster);
		const keywords = normalizeTags(cluster.tags).slice(0, 12);
		const summary = String(cluster.entries[0]?.[1].text ?? "").trim();
		const existing = [...table.entries()].find(([, row]) => row.workspaceKey === workspaceKey && row.title === clip(title, 48));
		let collectionId;
		if (existing) collectionId = existing[0];
		else {
			collectionId = await putCollection(store, newCollectionRecord(workspaceKey, title, keywords, summary, now));
			created += 1;
		}
		for (const [id] of cluster.entries) {
			await store.memories.update?.(id, (row) => ({
				...row,
				collectionId
			}));
			assigned += 1;
		}
	}
	return {
		collections: created,
		entries: assigned
	};
}
/**
* 同 key / 重复写入判定（`memory_remember` 的唯一实现，抽出来便于单测）：
* 1. 同工作区、active、key 相同：
*    - 正文相同 → duplicate（未重复写入）；
*    - 正文不同 → conflict（不覆盖，交用户裁决）；
* 2. 无 key 时：同工作区 active 且正文相同 → duplicate。
* 返回时带上条目所属集合，回执可以说清「已存在于哪个集合」。
*/
function findMemoryConflict(store, workspaceKey, input) {
	const text = String(input.text ?? "").trim().toLowerCase();
	const withCollection = (memoryId, memory) => {
		const found = collectionOfEntry(store, memory);
		return {
			memoryId,
			title: memory.title ?? "",
			tags: [...memory.keywords ?? []],
			text: memory.text,
			...found ? {
				collectionId: found[0],
				collectionTitle: found[1].title
			} : {}
		};
	};
	if (input.key) for (const [memoryId, memory] of store.memories.entries()) {
		if (memory.workspaceKey !== workspaceKey || memory.status !== "active" || memory.key !== input.key) continue;
		const same = String(memory.text ?? "").trim().toLowerCase() === text;
		return {
			...withCollection(memoryId, memory),
			kind: same ? "duplicate" : "conflict"
		};
	}
	for (const [memoryId, memory] of store.memories.entries()) {
		if (memory.workspaceKey !== workspaceKey || memory.status !== "active") continue;
		if (String(memory.text ?? "").trim().toLowerCase() === text) return {
			...withCollection(memoryId, memory),
			kind: "duplicate"
		};
	}
	return null;
}
export { listCollections as a, resolveCollectionForEntry as c, findMemoryConflict as i, touchCollection as l, collectionRows as n, migrateFlatMemories as o, collectionTierNote as r, recallEntriesWithCollections as s, bestCollectionFor as t, askLlmJson as u };
