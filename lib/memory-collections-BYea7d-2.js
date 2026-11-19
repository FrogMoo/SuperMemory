import { c as deriveTitle, n as queryWeights, o as tokenize, r as rawScore, u as normalizeTags } from "./recall-e4Wwn0Cp.js";
import { t as newId } from "./store-Bc5DmUnL.js";
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
* 3. 自动匹配：高/中相似 → 复用（回执里注明相似档位），低相似/无匹配 → 新建集合，
*    新集合标题 = 条目标题、标签 = 条目标签、正文 = 条目正文（截断），与话题集同形。
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
export { migrateFlatMemories as a, touchCollection as c, listCollections as i, collectionRows as n, recallEntriesWithCollections as o, findMemoryConflict as r, resolveCollectionForEntry as s, bestCollectionFor as t };
