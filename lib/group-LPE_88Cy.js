import { t as __exportAll } from "./rolldown-runtime-BJohB4LM.js";
import { t as newId } from "./store-DegBEROs.js";
// src/group.ts
var group_exports = /* @__PURE__ */ __exportAll({ groupMembers: () => groupMembers });
/** Members of one group, in creation order. */
function groupMembers(store, groupId) {
	const out = [];
	for (const [dispatchId, record] of store.dispatches.entries()) if (record.groupId === groupId) out.push([dispatchId, record]);
	out.sort((a, b) => a[1].createdAt - b[1].createdAt);
	return out;
}
/** True when every member reached a terminal state. */
function groupComplete(store, groupId) {
	const members = groupMembers(store, groupId);
	if (members.length === 0) return false;
	return members.every(([, record]) => record.status === "delivered" || record.status === "failed");
}
/** The hub-facing group relay text: one line per member, failures annotated. */
function groupRelayText(store, groupId, episodes) {
	const members = groupMembers(store, groupId);
	const lines = [`[supermemory-group-relay ${groupId}]`, `共 ${members.length} 个分支任务：`];
	let ok = 0;
	let failed = 0;
	members.forEach(([, record], index) => {
		const label = record.task.slice(0, 40);
		if (record.status === "delivered") {
			ok++;
			const summary = episodes.get(record.branchSessionId) ?? "（已完成）";
			lines.push(`${index + 1}. ✅ ${label}\n   ${summary}`);
		} else {
			failed++;
			lines.push(`${index + 1}. ❌ ${label}\n   失败终态：${record.turnEndReason ?? "unknown"}（未伪装成答案）`);
		}
	});
	lines.push(`汇总：${ok} 成功 / ${failed} 失败。`);
	return lines.join("\n");
}
/** Collect the episode summaries of a group's delivered members. */
function groupEpisodeSummaries(store, groupId) {
	const out = /* @__PURE__ */ new Map();
	const members = groupMembers(store, groupId);
	const branchIds = new Set(members.map(([, r]) => r.branchSessionId));
	for (const [, episode] of store.episodes.entries()) if (episode.branchSessionId && branchIds.has(episode.branchSessionId) && episode.summary) out.set(episode.branchSessionId, episode.summary);
	return out;
}
/** Whether a group relay was already enqueued (idempotency guard). */
function groupRelayExists(store, groupId) {
	for (const [, item] of store.outbox.entries()) if (item.groupId === groupId) return true;
	return false;
}
/** Stable group id for a dispatch round. */
function newGroupId() {
	return newId("grp");
}
export { groupRelayText as a, groupRelayExists as i, groupEpisodeSummaries as n, group_exports as o, groupMembers as r, newGroupId as s, groupComplete as t };
