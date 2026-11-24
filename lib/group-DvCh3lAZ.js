import { a as __exportAll, t as newId } from "./store-DXRBkPpa.js";
import { l as topicSetIdsOf } from "./topicsets-COOiMU67.js";
// src/questions.ts
/** Dispatch states that no longer own the branch's work. */
const TERMINAL = /* @__PURE__ */ new Set([
	"delivered",
	"failed",
	"interrupted"
]);
/**
* Structural view of the questions table that tolerates a partial store
* (older test double / a medium opened before the table existed). Every reader
* goes through this instead of assuming `store.questions`.
*/
function questionsOf(store) {
	return store?.questions;
}
/** The dispatch a branch currently belongs to, preferring a still-open one. */
function dispatchOfBranch(store, branchSessionId) {
	let newest;
	let newestOpen;
	for (const [dispatchId, record] of store.dispatches.entries()) {
		if (record.branchSessionId !== branchSessionId) continue;
		if (!newest || record.createdAt >= newest[1].createdAt) newest = [dispatchId, record];
		if (TERMINAL.has(String(record.status))) continue;
		if (!newestOpen || record.createdAt >= newestOpen[1].createdAt) newestOpen = [dispatchId, record];
	}
	return newestOpen ?? newest;
}
/** Open questions of one dispatch, oldest first. */
function openQuestionsOfDispatch(store, dispatchId) {
	const table = questionsOf(store);
	if (!table || !store) return [];
	const rows = [];
	for (const [, question] of table.entries()) {
		if (question.status !== "open" || question.dispatchId !== dispatchId) continue;
		rows.push(question);
	}
	rows.sort((a, b) => a.createdAt - b.createdAt);
	return rows;
}
/** Open questions of one parallel group (all members), oldest first. */
function openQuestionsOfGroup(store, groupId) {
	const table = questionsOf(store);
	if (!table || !store) return [];
	const rows = [];
	for (const [, question] of table.entries()) {
		if (question.status !== "open" || question.groupId !== groupId) continue;
		rows.push(question);
	}
	rows.sort((a, b) => a.createdAt - b.createdAt);
	return rows;
}
/**
* Open questions visible to one hub: everything whose topic set belongs to the
* hub's workspace, plus anything dispatched by this very hub (a dispatch always
* resolves a topic set, so the second arm is only a safety net).
*/
function questionsForHub(store, workspaceKey, hubSessionId, status = "open") {
	const table = questionsOf(store);
	if (!table || !store) return [];
	const ownSets = topicSetIdsOf(store, workspaceKey);
	const rows = [];
	for (const [id, question] of table.entries()) {
		if (status !== "all" && question.status !== status) continue;
		if (!(question.topicSetId ? ownSets.has(question.topicSetId) : false) && (!hubSessionId || question.hubSessionId !== hubSessionId)) continue;
		rows.push({
			id,
			question
		});
	}
	rows.sort((a, b) => a.question.createdAt - b.question.createdAt);
	return rows;
}
function normalizeSeverity(raw) {
	return raw === "low" || raw === "high" ? raw : "medium";
}
function clip(raw, max) {
	return String(raw ?? "").trim().slice(0, max);
}
/**
* Persist one branch question against the dispatch that owns the branch.
*
* Refuses when the caller is not a branch: a hub that needs a user decision
* must use `ask_user_question` directly, never this channel (the hub is the one
* that aggregates, so a hub question stored here would never be asked).
*/
async function raiseQuestion(store, branchSessionId, input) {
	const table = questionsOf(store);
	if (!table) return {
		status: "error",
		message: "问题存储不可用（存储域未打开），问题未上交；请把该问题写进最终汇报。"
	};
	const found = dispatchOfBranch(store, branchSessionId);
	if (!found) return {
		status: "error",
		message: "memory_raise_question 仅分支会话使用：当前会话没有对应的派发记录。中枢需要用户裁决时直接用 ask_user_question；不需要裁决时按最合理解释继续。"
	};
	const [dispatchId, dispatch] = found;
	const title = clip(input.title, 80);
	const text = clip(input.question, 2e3);
	if (!title) return {
		status: "error",
		message: "title 不能为空：给出一句可扫读的问题标题。"
	};
	if (!text) return {
		status: "error",
		message: "question 不能为空：写清要用户裁决什么。"
	};
	const options = (input.options ?? []).map((option) => clip(option, 120)).filter(Boolean).slice(0, 8);
	const blocking = input.blocking === true;
	const now = Date.now();
	const questionId = newId("q");
	const record = {
		dispatchId,
		...dispatch.groupId ? { groupId: dispatch.groupId } : {},
		...dispatch.topicSetId ? { topicSetId: dispatch.topicSetId } : {},
		branchSessionId,
		...dispatch.hubSessionId ? { hubSessionId: dispatch.hubSessionId } : {},
		branchTask: clip(dispatch.task, 200),
		title,
		question: text,
		options,
		severity: normalizeSeverity(input.severity),
		blocking,
		progress: clip(input.progress, 1500),
		defaultPlan: clip(input.defaultPlan, 1e3),
		status: "open",
		createdAt: now,
		updatedAt: now
	};
	await table.put(questionId, record);
	return {
		status: "recorded",
		questionId,
		dispatchId,
		blocking,
		message: blocking ? `已上交中枢（${questionId}）。这是阻塞问题：中枢汇总所有分支的问题后一次性向用户提问。请结束本轮并在汇报里写清已完成的进度与默认备选方案，不要在本分支里等待用户。` : `已上交中枢（${questionId}）。blocking=false：不要等待用户，继续按最合理解释推进并完成实质工作，把做出的假设写进最终汇报。`
	};
}
/** Mark questions resolved, optionally recording the user's answer. */
async function resolveQuestions(store, ids, answer) {
	const table = questionsOf(store);
	if (!table) return 0;
	let resolved = 0;
	const takenAnswer = clip(answer, 2e3);
	for (const id of ids) {
		const row = table.get(id);
		if (!row || row.status === "resolved") continue;
		await table.update(id, (record) => ({
			...record,
			status: "resolved",
			...takenAnswer ? { answer: takenAnswer } : {},
			updatedAt: Date.now()
		}));
		resolved++;
	}
	return resolved;
}
/** One rendered line block per question, shared by relays and the hub listing. */
function questionLines(question) {
	const lines = [`- ${question.blocking ? "[阻塞]" : "[非阻塞]"} ${question.title}：${question.question}`];
	if (question.options.length > 0) lines.push(`  可选：${question.options.join(" / ")}`);
	if (question.progress) lines.push(`  已完成：${question.progress}`);
	if (question.defaultPlan) lines.push(`  默认备选：${question.defaultPlan}`);
	return lines;
}
/**
* The relay block a hub sees after a dispatch/group settles. Empty when the
* branch raised nothing, so existing relay texts stay byte-identical.
*/
function renderQuestionsBlock(questions, title = "本分支上交的问题（中枢汇总后统一向用户提问）：") {
	if (questions.length === 0) return "";
	const blocking = questions.filter((question) => question.blocking).length;
	const lines = [`[supermemory-questions] ${title} 共 ${questions.length} 个（阻塞 ${blocking} / 非阻塞 ${questions.length - blocking}）。`];
	for (const question of questions) lines.push(...questionLines(question));
	lines.push("请中枢调用 memory_questions 汇总所有分支的问题，用 ask_user_question 一次向用户提问；不要逐个转发。");
	return lines.join("\n");
}
/** Hub-facing listing rows of `memory_questions`, including the source branch. */
function renderQuestionList(rows) {
	if (rows.length === 0) return "（当前工作区没有待处理的已上交问题）";
	const blocking = rows.filter((row) => row.question.blocking).length;
	const lines = [`待处理问题 ${rows.length} 个（阻塞 ${blocking} / 非阻塞 ${rows.length - blocking}）：`];
	for (const row of rows) {
		const question = row.question;
		const task = question.branchTask ? ` · 分支任务「${question.branchTask.slice(0, 40)}」` : "";
		lines.push(`${question.blocking ? "⛔" : "•"} ${question.title}（${question.branchSessionId}${task}）`);
		lines.push(`  ${question.question}`);
		if (question.options.length > 0) lines.push(`  可选：${question.options.join(" / ")}`);
		if (question.progress) lines.push(`  已完成：${question.progress}`);
		if (question.defaultPlan) lines.push(`  默认备选：${question.defaultPlan}`);
		if (question.severity !== "medium") lines.push(`  严重度：${question.severity}`);
	}
	lines.push("请去重、按主题合并后，用一次 ask_user_question 向用户提问；用户答复后把裁决派回对应分支（memory_dispatch）。");
	return lines.join("\n");
}
// src/relay-text.ts
/**
* Relay safety valve, NOT a content policy: an answer larger than this is a
* runaway turn, and pushing it whole into the hub's context would crowd out
* everything else. The marker says so and names where the rest lives, instead
* of silently cutting the branch's work the way the old 400-char clip did.
*/
const RELAY_RESULT_MAX_CHARS = 65536;
/** The branch's full answer: `result`, falling back to the short `summary` for
*  episodes written before `result` existed. */
function episodeResult(episode) {
	return episode?.result || episode?.summary || "";
}
/** Clip a relay body at the safety valve, saying so instead of cutting silently. */
function clipRelayResult(text, branchSessionId) {
	if (text.length <= 65536) return text;
	return `${text.slice(0, RELAY_RESULT_MAX_CHARS)}\n……（结果超过 ${RELAY_RESULT_MAX_CHARS} 字，已截断；完整内容见分支会话 ${branchSessionId} 的记录）`;
}
// src/group.ts
var group_exports = /* @__PURE__ */ __exportAll({ groupMembers: () => groupMembers });
/** Members of one group, in creation order. */
function groupMembers(store, groupId) {
	const out = [];
	for (const [dispatchId, record] of store.dispatches.entries()) if (record.groupId === groupId) out.push([dispatchId, record]);
	out.sort((a, b) => a[1].createdAt - b[1].createdAt);
	return out;
}
/**
* Dispatch states that end a member's life. `interrupted` (timeout / stop /
* plugin reload) is terminal exactly like `failed`: excluding it kept
* `groupComplete` false forever, so one silent member withheld the WHOLE group's
* single relay. It is still annotated as an interruption, never as success.
*/
const TERMINAL_MEMBER_STATUSES = /* @__PURE__ */ new Set([
	"delivered",
	"failed",
	"interrupted"
]);
/** True when every member reached a terminal state. */
function groupComplete(store, groupId) {
	const members = groupMembers(store, groupId);
	if (members.length === 0) return false;
	return members.every(([, record]) => TERMINAL_MEMBER_STATUSES.has(record.status));
}
/** The hub-facing group relay text: one line per member, failures/interrupts annotated. */
function groupRelayText(store, groupId, episodes) {
	const members = groupMembers(store, groupId);
	const lines = [`[supermemory-group-relay ${groupId}]`, `共 ${members.length} 个分支任务：`];
	let ok = 0;
	let failed = 0;
	let interrupted = 0;
	members.forEach(([, record], index) => {
		const label = record.task.slice(0, 40);
		if (record.status === "delivered") {
			ok++;
			const summary = episodes.get(record.branchSessionId) ?? "（已完成）";
			lines.push(`${index + 1}. ✅ ${label}\n   ${summary}`);
		} else if (record.status === "interrupted") {
			interrupted++;
			lines.push(`${index + 1}. ⏹ ${label}\n   中断终态：${record.turnEndReason ?? "unknown"}（未伪装成答案）`);
		} else {
			failed++;
			lines.push(`${index + 1}. ❌ ${label}\n   失败终态：${record.turnEndReason ?? "unknown"}（未伪装成答案）`);
		}
	});
	lines.push(`汇总：${ok} 成功 / ${failed} 失败 / ${interrupted} 中断。`);
	const questions = renderQuestionsBlock(openQuestionsOfGroup(store, groupId), "并行组各分支上交的问题（中枢汇总后统一向用户提问）：");
	if (questions) lines.push("", questions);
	return lines.join("\n");
}
/** Collect the episode results (full answers) of a group's delivered members. */
function groupEpisodeSummaries(store, groupId) {
	const out = /* @__PURE__ */ new Map();
	const members = groupMembers(store, groupId);
	const branchIds = new Set(members.map(([, r]) => r.branchSessionId));
	for (const [, episode] of store.episodes.entries()) {
		const text = episodeResult(episode);
		if (episode.branchSessionId && branchIds.has(episode.branchSessionId) && text) out.set(episode.branchSessionId, clipRelayResult(text, episode.branchSessionId));
	}
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
export { groupRelayText as a, clipRelayResult as c, questionsForHub as d, raiseQuestion as f, resolveQuestions as h, groupRelayExists as i, episodeResult as l, renderQuestionsBlock as m, groupEpisodeSummaries as n, group_exports as o, renderQuestionList as p, groupMembers as r, newGroupId as s, groupComplete as t, openQuestionsOfDispatch as u };
