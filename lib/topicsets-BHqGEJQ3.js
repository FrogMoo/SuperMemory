import { t as newId } from "./store-DmWKwFTx.js";
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
export { listTopicSets as a, setTopicSetModel as c, updateMember as d, updateTopicSetShape as f, getTopicSet as i, topicSetIdsOf as l, createTopicSet as n, rankMembers as o, updateTopicSetSummary as p, getRouting as r, setRouting as s, addMember as t, touchTopicSet as u };
