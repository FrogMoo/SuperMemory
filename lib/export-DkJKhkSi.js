import { t as __exportAll } from "./rolldown-runtime-BJohB4LM.js";
import { t as filemapEntries } from "./filemap-CzdzQyWA.js";
import { t as newId } from "./store-CO7R3HU-.js";
import { l as getTopicSet, m as topicSetIdsOf } from "./clip-ClfN2vYl.js";
import { g as renderRecordLine } from "./model-C7X6bwj4.js";
import { a as listCollections } from "./memory-collections-fd6_lxkA.js";
// src/requirements.ts
const PATTERNS = [
	/(?:必须|一定要|务必|需要|要求|应该|应当|不能|不可以|禁止|千万别|一律)[:：\s]*([^。！？!?\n"'"』」]{4,120})/,
	/(?:待办|TODO|todo)[:：\s]+([^。！？!?\n"'"』」]{4,120})/,
	/(?:^|\s)(?:must|should|need to|required to|cannot|can't|do not|don't)\s+([^。！？!?\n"'"』」]{4,120})/i
];
/** Extract requirement clauses from one user message. */
function extractRequirements(text) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (raw) => {
		const clean = raw.trim().replace(/\s+/g, " ").replace(/["'」』]+$/, "").slice(0, 200);
		if (clean.length < 4) return;
		const key = clean.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(clean);
	};
	for (const pattern of PATTERNS) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
			const tail = text.slice(m.index + m[0].length);
			const stop = tail.search(/[。！？!?\n]/);
			if (/^[？?]/.test((stop < 0 ? "" : tail.slice(stop)).trimStart())) continue;
			if (/^(?:是否|能不能|可不可以|怎么|怎样|如何|为什么|为啥|啥|哪些|哪个|有没有|是不是)/.test(m[1].trim())) continue;
			push(m[1]);
		}
	}
	return out;
}
/** Persist extracted requirements for one workspace turn (dedup by text). */
async function rememberRequirements(store, workspaceKey, texts, sourceSessionId, sourceSeq, now) {
	const created = [];
	for (const text of texts) {
		const normalized = text.trim().toLowerCase();
		let duplicate = false;
		for (const [reqId, record] of store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open" && record.text.trim().toLowerCase() === normalized) {
			duplicate = true;
			break;
		}
		if (duplicate) continue;
		const reqId = newId("req");
		const record = {
			workspaceKey,
			text,
			constraints: [],
			status: "open",
			sourceSessionId,
			sourceSeq,
			createdAt: now
		};
		await store.requirements.put(reqId, record);
		created.push(reqId);
	}
	return created;
}
/** Open requirements of one workspace, newest first. */
function openRequirements(store, workspaceKey) {
	const out = [];
	for (const entry of store.requirements.entries()) if (entry[1].workspaceKey === workspaceKey && entry[1].status === "open") out.push(entry);
	out.sort((a, b) => b[1].createdAt - a[1].createdAt);
	return out;
}
// src/export.ts
var export_exports = /* @__PURE__ */ __exportAll({ buildExport: () => buildExport });
/**
* Build the export document for one workspace.
*
* @param store - the open domain store
* @param workspaceKey - workspace isolation key (D4)
* @param activeTopicSetId - optional topic set rendered as the document head
*/
function buildExport(store, workspaceKey, activeTopicSetId) {
	const topicSet = activeTopicSetId ? getTopicSet(store, activeTopicSetId) : void 0;
	const lines = ["# SuperMemory 导出", ""];
	if (topicSet) {
		const tags = topicSet.keywords.length > 0 ? `

标签：${topicSet.keywords.join("、")}` : "";
		lines.push(`## 话题集：${topicSet.title}${tags}`, "", topicSet.summary || "（暂无梗概）", "");
	}
	const collections = new Map(listCollections(store, workspaceKey));
	const grouped = /* @__PURE__ */ new Map();
	const loose = [];
	let memoryCount = 0;
	for (const [, record] of store.memories.entries()) {
		if (record.workspaceKey !== workspaceKey || record.status !== "active") continue;
		const line = `- ${renderRecordLine({
			title: record.title,
			text: record.text,
			tags: record.keywords
		})}`;
		const collectionId = record.collectionId && collections.has(record.collectionId) ? record.collectionId : "";
		if (!collectionId) {
			loose.push(line);
			memoryCount += 1;
			continue;
		}
		const bucket = grouped.get(collectionId) ?? [];
		bucket.push(line);
		grouped.set(collectionId, bucket);
		memoryCount += 1;
	}
	if (memoryCount > 0) {
		lines.push("## 事实记忆", "");
		for (const [collectionId, rows] of grouped) {
			const collection = collections.get(collectionId);
			const tags = collection && collection.keywords.length > 0 ? `（标签：${collection.keywords.join("、")}）` : "";
			lines.push(`### 记忆集合：${collection?.title ?? collectionId}${tags}`, "");
			if (collection?.summary) lines.push(collection.summary, "");
			lines.push(...rows, "");
		}
		if (loose.length > 0) lines.push("### 未归集", "", ...loose, "");
	}
	const reqs = openRequirements(store, workspaceKey);
	if (reqs.length) lines.push("## 未完成需求", "", ...reqs.map(([, r]) => `- ${r.text}`), "");
	const ownTopicSetIds = topicSetIdsOf(store, workspaceKey);
	const eps = [];
	for (const [, episode] of store.episodes.entries()) {
		if (!episode.topicSetId || !ownTopicSetIds.has(episode.topicSetId)) continue;
		if (episode.summary) eps.push(`- ${episode.summary}`);
	}
	if (eps.length) lines.push("## 归档梗概", "", ...eps.slice(-20), "");
	const files = filemapEntries(store, workspaceKey);
	if (files.length) {
		lines.push("## 项目文件地图", "");
		for (const [, entry] of files) lines.push(`- \`${entry.path}\` — ${entry.role}${entry.summary ? "：" + entry.summary : ""}`);
		lines.push("");
	}
	return {
		text: lines.join("\n"),
		memories: memoryCount,
		requirements: reqs.length,
		files: files.length,
		collections: grouped.size
	};
}
export { rememberRequirements as i, export_exports as n, extractRequirements as r, buildExport as t };
