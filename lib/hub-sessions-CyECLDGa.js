import { r as workspaceKeyOf, t as newId } from "./store-DD2L3GDr.js";
import { g as updateMember, o as addMember, r as clipMarked } from "./clip-kqqR05NC.js";
import { b as injectionTitle } from "./model-Z4_-9sAj.js";
import { L as resolveRole } from "./capability-BllkKoRU.js";
/** Fallback title when both the topic-set title and the task are empty. */
const TITLE_FALLBACK = "新会话";
/**
* Ellipsis-clip: text longer than maxChars is cut and gets a trailing "…",
* and the marker counts toward the budget, so the result never exceeds
* maxChars characters. Use this for user-visible titles so an over-long
* value says it was clipped instead of ending mid-word.
*/
function clipEllipsis(text, maxChars) {
	const chars = Array.from(String(text ?? ""));
	if (chars.length <= maxChars) return chars.join("");
	if (maxChars <= 1) return "…";
	return chars.slice(0, maxChars - 1).join("") + "…";
}
/** First non-empty line of a text. */
function firstLine(text) {
	for (const line of String(text ?? "").split(String.fromCharCode(10))) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}
/**
* Strip the descriptive lead-ins users and older rounds put in front of a task:
* 「R31：」「R31-B · 」「R32 」「第 3 轮：」「Round 3 」「项目：」「背景：」
* 「任务：」「分支 · 」… Two shapes:
*   - a ROUND token («R32», «R41-B», «第 3 轮», «Round 3») strips after a
*     separator OR a single space, because dispatch titles are exactly
*     «R32 只读复核：…». It is anchored, so a round merely MENTIONED inside a
*     sentence («参考 R31 的实现») is never touched;
*   - a LABEL («项目：」「背景：」「仓库：」「任务：」「需求：」「派发：」
*     「请求：」…) keeps REQUIRING a separator, so a title that merely starts
*     with a label word («需求分析：…») stays whole.
* Repeats up to three times so stacked prefixes («R31：任务：…») collapse to
* the task itself.
*/
const LEADING_DESCRIPTION = /^(?:(?:(?:R|r)\d{1,3}(?:-[A-Za-z]{1,3})?|第\s*\d+\s*轮|Round\s*\d+)\s*(?:[：:·•・|\-—–]\s*|\s+)|(?:项目|背景|仓库|任务书|任务|工作内容|需求|派发|请求|分支)\s*(?:[：:·•・|\-—–]|\s{2,})\s*)/i;
/** Remove leading descriptive tokens (round / 任务 / 分支 …) from one line. */
function stripLeadingDescription(text) {
	let value = String(text ?? "").trim();
	for (let round = 0; round < 3; round += 1) {
		const next = value.replace(LEADING_DESCRIPTION, "").trim();
		if (next === value) break;
		value = next;
	}
	return value;
}
/**
* A session's display name as a DIRECT description of its work: markdown and
* brackets stripped, descriptive lead-ins removed, first line clipped with an
* ellipsis. An empty text falls back to the neutral {@link TITLE_FALLBACK}
* (「新会话」) — never a brand prefix and never an id token.
*/
function describeSessionTitle(text, maxChars = 48) {
	const cleaned = firstLine(stripLeadingDescription(cleanTitleText(text)));
	return cleaned ? clipEllipsis(cleaned, Math.max(4, Math.floor(maxChars))) : TITLE_FALLBACK;
}
/**
* Strip markdown and bracket markup before truncation: fences, inline code,
* emphasis markers, ATX headings, blockquotes, list bullets, task boxes and
* square/full-width bracket characters. Newlines are preserved so the caller can
* take the first meaningful line.
*/
function cleanTitleText(text) {
	let value = String(text ?? "").replace(/\r\n?/g, String.fromCharCode(10));
	value = value.replace(/```[\s\S]*?```/g, " ");
	value = value.replace(/`[^`]*`/g, " ");
	value = value.replace(/\*\*|__|~~/g, "");
	value = value.replace(/^\s{0,3}#{1,6}\s*/gm, "");
	value = value.replace(/^\s{0,3}>\s?/gm, "");
	value = value.replace(/^\s{0,3}(?:[-+*]|\d{1,3}[.)])\s+/gm, "");
	value = value.replace(/\[[ xX]?\]/g, " ");
	value = value.replace(/[\[\]【】〔〕]/g, " ");
	value = value.replace(/[ \t]+/g, " ");
	value = value.replace(/[ \t]*\n[ \t]*/g, String.fromCharCode(10));
	return value.trim();
}
/**
* Compute one session title from a topic-set title and the task text.
* @param topicTitle - owning topic-set title (may be empty).
* @param task - dispatch/reply text (may be empty).
* @param existing - titles already used in the same topic set (for de-duplication).
* @param options - character budgets (tests and future config).
* @returns title of at most maxChars characters.
*/
function sessionTitleFor(topicTitle, task, existing = [], options = {}) {
	const maxChars = Math.max(4, Math.floor(options.maxChars ?? 80));
	const snippetChars = Math.max(1, Math.floor(options.snippetChars ?? 48));
	const topic = firstLine(cleanTitleText(topicTitle));
	const snippet = clipEllipsis(firstLine(cleanTitleText(task)), snippetChars);
	const separator = " · ";
	let base;
	if (topic && snippet) base = clipEllipsis(topic, Math.max(4, maxChars - 3 - snippet.length)) + separator + snippet;
	else if (topic) base = clipEllipsis(topic, maxChars);
	else if (snippet) base = clipEllipsis(snippet, maxChars);
	else base = TITLE_FALLBACK;
	const used = /* @__PURE__ */ new Set();
	for (const title of existing) {
		const trimmed = String(title ?? "").trim();
		if (trimmed) used.add(trimmed);
	}
	if (!used.has(base)) return base;
	for (let index = 2; index <= 999; index += 1) {
		const suffix = "（" + index + "）";
		const candidate = clipEllipsis(base, Math.max(1, maxChars - suffix.length)) + suffix;
		if (!used.has(candidate)) return candidate;
	}
	return base;
}
/**
* Persist the member title for one topic-set branch, computing it only when the
* member has no title yet (a reused branch keeps its first stable name).
* @param store - plugin store.
* @param topicSetId - owning topic set.
* @param member - branch identity and kind.
* @param topicTitle - topic-set title fallback when the row is gone.
* @param task - task text used for the snippet.
* @param options - `taskOnly` names a WORK BRANCH: the title is the task
*   itself (no topic-set prefix), matching 「会话名称直接描述工作内容」.
*   R43 需求③ widened that budget to {@link TITLE_BRANCH_TASK_CHARS} so the
*   topic is not cut mid-clause.
* @returns the title now stored on the member.
*/
async function ensureMemberTitle(store, topicSetId, member, topicTitle, task, options = {}) {
	const record = store.topicsets.get(topicSetId);
	if (!record) return options.taskOnly ? describeSessionTitle(task, 60) : sessionTitleFor(topicTitle, task);
	const current = record.members.find((entry) => entry.sessionId === member.sessionId);
	if (current && current.title.trim()) return current.title;
	const others = record.members.filter((entry) => entry.sessionId !== member.sessionId).map((entry) => entry.title);
	const title = options.taskOnly ? describeSessionTitle(task, 60) : sessionTitleFor(record.title || topicTitle, task, others);
	if (current) await updateMember(store, topicSetId, member.sessionId, { title });
	else await addMember(store, topicSetId, {
		sessionId: member.sessionId,
		kind: member.kind,
		title
	});
	return title;
}
/**
* Apply a title to the HOST session so the GUI session list stops showing it
* unnamed. Prefers `ctx.sessionTitle.rename` (host-owned normalization + pin),
* falls back to the exact `session/title` log append, and never throws.
* @param ctx - host context (structural view).
* @param sessionId - live session to name.
* @param title - proposed title (normalized again here).
* @param logger - warning sink.
* @returns where the title landed.
*/
function applySessionTitle(ctx, sessionId, title, logger, options = {}) {
	const clean = clipEllipsis(firstLine(cleanTitleText(title)), 80);
	if (!clean) return "none";
	const session = ctx.sessions?.get(sessionId);
	if (!session) return "none";
	const service = (() => {
		try {
			return ctx.get?.("sessionTitle");
		} catch {
			return;
		}
	})();
	if (!options.force) try {
		if (service && typeof service.get === "function") {
			const current = service.get(session);
			if (current && typeof current.title === "string" && current.title.trim()) return "already";
		}
	} catch (error) {
		logger.warn("supermemory: session title read skipped: " + String(error).slice(0, 160));
	}
	try {
		if (service && typeof service.rename === "function") {
			service.rename(session, clean);
			return "host";
		}
	} catch (error) {
		logger.warn("supermemory: sessionTitle.rename failed, falling back to the log event: " + String(error).slice(0, 160));
	}
	try {
		const append = session.append;
		if (typeof append === "function") {
			append.call(session, "session/title", {
				title: clean,
				messageSeqs: [],
				source: { kind: "user" }
			});
			return "fallback";
		}
	} catch (error) {
		logger.warn("supermemory: session title log append failed: " + String(error).slice(0, 160));
	}
	return "none";
}
/**
* The live HOST title of one session, or undefined when the session is not
* tracked, carries no title, or the title service is unavailable. The
* one-time title migration uses it to detect a title that somebody else
* renamed, so it never overwrites a human's choice.
*/
function currentSessionTitle(ctx, sessionId) {
	const session = ctx.sessions?.get(sessionId);
	if (!session) return void 0;
	try {
		const current = (ctx.get?.("sessionTitle"))?.get?.(session);
		if (current && typeof current.title === "string" && current.title.trim()) return current.title;
	} catch {}
}
/**
* R32 需求③: the best available title for a message's SOURCE session.
*
* Reads the live host title first, then the plugin's durable branch title
* mapping (a branch can be detached/reloaded while its dispatch row still
* carries the name), and returns '' when neither knows one — the card then
* falls back to the id's last four characters (see chat-card.ts).
*
* @param ctx - host context (structural view; never throws).
* @param store - durable plugin store (optional).
* @param sessionId - session whose title should label a card.
* @returns a trimmed title, or ''.
*/
function sessionTitleOf(ctx, store, sessionId) {
	if (!sessionId) return "";
	const live = currentSessionTitle(ctx, sessionId);
	if (live && live.trim()) return live.trim();
	if (!store) return "";
	try {
		for (const [, topicSet] of store.topicsets.entries()) for (const member of topicSet.members) if (member.sessionId === sessionId && typeof member.title === "string" && member.title.trim()) return member.title.trim();
	} catch {}
	return "";
}
/** Dispatch states that still owe the hub a relay (see observe.ts settle rules). */
const OPEN_STATUSES = /* @__PURE__ */ new Set([
	"queued",
	"dispatched",
	"observed",
	"summarized"
]);
/** Terminal failure states: the branch is idle, but the work did NOT land. */
const FAILED_STATUSES = /* @__PURE__ */ new Set(["failed", "interrupted"]);
/** True while a branch still has work that must reach the hub. */
function isOpenDispatch(record) {
	return OPEN_STATUSES.has(record.status);
}
/** The first topic-set member row for a branch (archived sets included). */
function memberOf(store, branchSessionId) {
	for (const [topicSetId, topicSet] of store.topicsets.entries()) {
		const member = topicSet.members.find((row) => row.sessionId === branchSessionId);
		if (member) return {
			topicSetId,
			topicSet,
			member
		};
	}
}
/**
* A one-line task excerpt (the branch has no title yet / not a member).
*
* R47: delegates to the shared {@link clipMarked} so the cut lands on a
* sentence boundary (the old char-`slice` could stop mid-word) and always
* carries the `…` marker. The empty-text fallback is preserved.
*/
function taskExcerpt(task, max = 32) {
	const text = String(task ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "（无任务描述）";
	return clipMarked(text, max);
}
/** Human relative time for cards (coarse on purpose: the card is context, not a log). */
function relativeAgo(at, now = Date.now()) {
	if (!Number.isFinite(at) || at <= 0) return "未知时间";
	const delta = Math.max(0, now - at);
	const minute = 6e4;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (delta < minute) return "刚刚";
	if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
	if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
	return `${Math.floor(delta / day)} 天前`;
}
/**
* Project one group of dispatch rows into one branch row.
*
* `hubSessionId` only scopes the projection (which rows are considered); the
* resulting row still reports every hub that dispatched into the branch, so a
* shared branch is visibly shared rather than silently re-labelled per hub.
*/
function projectBranch(store, branchSessionId, rows) {
	if (rows.length === 0) return void 0;
	const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
	const latest = sorted[0];
	const memberInfo = memberOf(store, branchSessionId);
	const member = memberInfo?.member;
	const topicSetId = memberInfo?.topicSetId ?? latest.topicSetId;
	const topicSet = memberInfo?.topicSet ?? (topicSetId ? store.topicsets.get(topicSetId) : void 0);
	const hubs = [];
	for (const row of sorted) if (row.hubSessionId && !hubs.includes(row.hubSessionId)) hubs.push(row.hubSessionId);
	const openDispatches = rows.filter(isOpenDispatch).length;
	const lastTerminal = sorted.find((row) => !isOpenDispatch(row));
	const status = openDispatches > 0 ? "working" : lastTerminal && FAILED_STATUSES.has(lastTerminal.status) ? "failed" : "idle";
	const lastActivityAt = Math.max(...rows.map((row) => Math.max(Number(row.updatedAt) || 0, Number(row.lastActivityAt) || 0)), Number(member?.lastActiveAt) || 0);
	const titled = sorted.find((row) => String(row.title ?? "").trim());
	const tagged = sorted.find((row) => (row.tags ?? []).length > 0);
	const view = {
		branchSessionId,
		title: String(titled?.title ?? "").trim() || (member?.title ?? "").trim() || taskExcerpt(latest.task, 48),
		tags: [...tagged?.tags ?? []],
		task: latest.task,
		hubSessionId: latest.hubSessionId,
		status,
		openDispatches,
		dispatches: rows.length,
		lastActivityAt,
		hubs,
		shared: hubs.length > 1
	};
	if (topicSetId) view.topicSetId = topicSetId;
	if (topicSet) view.topicSetTitle = topicSet.title;
	if (latest.groupId) view.groupId = latest.groupId;
	return view;
}
/** Group dispatch rows by branch session id (insertion order of first sighting). */
function groupByBranch(rows) {
	const out = /* @__PURE__ */ new Map();
	for (const [, row] of rows) {
		const branchId = String(row.branchSessionId ?? "");
		if (!branchId) continue;
		const bucket = out.get(branchId);
		if (bucket) bucket.push(row);
		else out.set(branchId, [row]);
	}
	return out;
}
/** Every branch of the store, keyed by branch id, carrying ALL hubs' rows. */
function allBranches(store) {
	return groupByBranch([...store.dispatches.entries()]);
}
/**
* Project the selected branch ids against the COMPLETE row set of each branch.
*
* This is what makes sharing honest: `listHubBranches` selects branches by the
* caller's hub, but a branch's status/activity/hub set must include dispatches
* from every hub, otherwise a shared branch would look idle to hub B while hub A
* is still working in it (and `shared` would always be false).
*/
function projectSelected(store, all, branchIds, limit, cap) {
	const out = [];
	for (const branchSessionId of branchIds) {
		const view = projectBranch(store, branchSessionId, all.get(branchSessionId) ?? []);
		if (view) out.push(view);
	}
	out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	return out.slice(0, Math.max(1, Math.min(cap, Number(limit) || cap)));
}
/**
* Branches one hub dispatched into, newest activity first.
*
* @param store - plugin store (dispatch rows + topic-set membership).
* @param hubSessionId - the hub whose association is projected.
* @param limit - maximum rows (default {@link HUB_BRANCH_LIMIT}).
*/
function listHubBranches(store, hubSessionId, limit = 20) {
	const id = String(hubSessionId ?? "").trim();
	if (!store || !id) return [];
	const all = allBranches(store);
	const selected = /* @__PURE__ */ new Set();
	for (const [dispatchId, row] of store.dispatches.entries()) if (row.hubSessionId === id && row.branchSessionId) selected.add(String(row.branchSessionId));
	return projectSelected(store, all, selected, limit, 20);
}
/** Every branch of one topic set, whoever dispatched into it (共享视图). */
function listTopicSetBranches(store, topicSetId, limit = 20) {
	const id = String(topicSetId ?? "").trim();
	if (!store || !id) return [];
	const all = allBranches(store);
	const selected = /* @__PURE__ */ new Set();
	for (const [dispatchId, row] of store.dispatches.entries()) if (row.topicSetId === id && row.branchSessionId) selected.add(String(row.branchSessionId));
	return projectSelected(store, all, selected, limit, 20);
}
/**
* Every branch of one workspace's topic sets (the console's cross-hub view).
*
* A dispatch row carries a topicSetId, not a workspaceKey, so the workspace is
* resolved through the set (sets are workspace-scoped since v1).
*/
function listWorkspaceBranches(store, workspaceKey, limit = 100) {
	if (!store || !workspaceKey) return [];
	const all = allBranches(store);
	const selected = /* @__PURE__ */ new Set();
	for (const [dispatchId, row] of store.dispatches.entries()) {
		if (!row.topicSetId || !row.branchSessionId) continue;
		const topicSet = store.topicsets.get(row.topicSetId);
		if (!topicSet || topicSet.workspaceKey !== workspaceKey) continue;
		selected.add(String(row.branchSessionId));
	}
	return projectSelected(store, all, selected, limit, 1e3);
}
/**
* branchSessionId → the latest task dispatched into it (newest row wins).
*
* The panel's topic-set branch rows carry this excerpt so a preserved branch
* stays identifiable after a restart: title + owning set + task summary, read
* from the durable ledger alone (no live handle required).
*/
function latestTaskByBranch(store) {
	const latest = /* @__PURE__ */ new Map();
	if (store) for (const [, row] of store.dispatches.entries()) {
		const branchId = String(row.branchSessionId ?? "");
		if (!branchId) continue;
		const at = Math.max(Number(row.updatedAt) || 0, Number(row.createdAt) || 0);
		const current = latest.get(branchId);
		if (!current || at >= current.at) latest.set(branchId, {
			task: String(row.task ?? ""),
			at
		});
	}
	const out = /* @__PURE__ */ new Map();
	for (const [branchId, row] of latest) out.set(branchId, row.task);
	return out;
}
/** branchSessionId → the hubs that dispatched into it (panel branch cards). */
function hubsByBranch(store) {
	const map = /* @__PURE__ */ new Map();
	if (!store) return map;
	for (const [, row] of store.dispatches.entries()) {
		const branchId = String(row.branchSessionId ?? "");
		if (!branchId || !row.hubSessionId) continue;
		const list = map.get(branchId);
		if (list) {
			if (!list.includes(row.hubSessionId)) list.push(row.hubSessionId);
		} else map.set(branchId, [row.hubSessionId]);
	}
	return map;
}
/**
* The hub-facing context card (R19 需求②): "these are your branches right now".
*
* Deliberately terse and bounded: the card is appended on every user step, so a
* 20-branch list would tax every turn. It is omitted entirely when the hub has
* no associated branch, and it always ends with the dispatch rule that keeps the
* hub from re-dispatching a branch that is merely idle.
*
* R30 需求⑤.2: when the round's recall matched topic sets, the card also carries
* those sets' branch lists (标题/标签/状态/最后活动) — the "按话题集检索其下分支
* 会话" half of the retrieval routing, read from the durable ledger (no host
* call). Bounded like the hub section: at most the caller's sections, each
* capped at `maxItems` rows.
*/
function renderHubBranchesCard(rows, options = {}) {
	const now = options.now ?? Date.now();
	const maxItems = Math.max(1, Math.min(20, options.maxItems ?? 8));
	const setSections = (options.topicSets ?? []).filter((section) => section.rows.length > 0);
	if (rows.length === 0 && setSections.length === 0) return "";
	const lines = [];
	if (rows.length > 0) {
		const working = rows.filter((row) => row.status === "working").length;
		const failed = rows.filter((row) => row.status === "failed").length;
		lines.push(injectionTitle("branch") + " 本会话在该话题集拉起的分支：");
		for (const row of rows.slice(0, maxItems)) {
			const parts = [
				`${row.status === "working" ? "工作中" : row.status === "failed" ? "失败待处理" : "空闲"}`,
				row.topicSetTitle ? `话题集「${row.topicSetTitle}」` : "无话题集",
				relativeAgo(row.lastActivityAt, now)
			];
			if (row.tags.length > 0) parts.push(`标签 ${row.tags.join(" / ")}`);
			if (row.shared) parts.push(`与另外 ${row.hubs.length - 1} 个中枢共享`);
			lines.push(`- ${row.title}（${parts.join(" · ")}）`);
		}
		if (rows.length > maxItems) lines.push(`- …另有 ${rows.length - maxItems} 个分支（面板可查看全部）`);
		lines.push(`共 ${rows.length} 个分支：${working} 工作中 / ${failed} 失败 / ${rows.length - working - failed} 空闲。`);
		lines.push("继续同一分支用 mode=continue（忙则排队）；并行新任务用 tasks[]，每个任务独占一个分支并统一汇总。");
	}
	for (const section of setSections) {
		lines.push("");
		lines.push(`话题集「${section.title}」的分支（按话题集检索，可继续/复用）：`);
		for (const row of section.rows.slice(0, maxItems)) {
			const parts = [row.status === "working" ? "工作中" : row.status === "failed" ? "失败待处理" : "空闲", relativeAgo(row.lastActivityAt, now)];
			if (row.tags.length > 0) parts.push(`标签 ${row.tags.join(" / ")}`);
			if (row.shared) parts.push(`与另外 ${row.hubs.length - 1} 个中枢共享`);
			lines.push(`- ${row.title}（${parts.join(" · ")}）`);
		}
		if (section.rows.length > maxItems) lines.push(`- …另有 ${section.rows.length - maxItems} 个分支（面板可查看全部）`);
	}
	return lines.join("\n");
}
/**
* Is this agent a HUB session of its workspace?
*
* R33 需求②: a hub is a POSITIVE mark, never "a top-level session with no
* parentSession". That negation classified every ordinary conversation as a hub
* (the guard then denied bash/write/subagent in all of them) and contradicted
* the branch rule for a root member reused as a branch. {@link resolveRole}
* owns the single decision: branch facts win, hub marks are workspace-scoped,
* everything else is an ordinary session.
*
* Never throws: a store read failure answers `false` (ordinary), which keeps the
* prompt gate and the guard total.
*/
function isHubSession(store, agent) {
	try {
		return resolveRole(store, agent).role === "hub";
	} catch {
		return false;
	}
}
// src/memory-versions.ts
/** True when this store can persist memory history rows. */
function memoryVersionsSupported(store) {
	const table = store?.memoryVersions;
	return !!table && typeof table.put === "function" && typeof table.entries === "function";
}
/** 当前记忆的版本号（旧记录没有 version 字段时读作 1，与 zod 默认值一致）。 */
function currentVersionOf(memory) {
	const version = Number(memory?.version);
	return Number.isInteger(version) && version > 0 ? version : 1;
}
/**
* 版本化创建：写入 memories 行（version=1）并归档一条 v1 历史
* （changeType 'create'）。返回新记忆 id；没有历史表时只写 memories 行。
*/
async function createMemoryVersioned(store, workspaceKey, input, now = Date.now()) {
	const memoryId = newId("mem");
	const memory = {
		workspaceKey,
		title: input.title ?? "",
		text: input.text,
		keywords: [...input.tags ?? []],
		...input.key ? { key: input.key } : {},
		...input.collectionId ? { collectionId: input.collectionId } : {},
		sourceSessionId: input.sourceSessionId,
		sourceSeq: input.sourceSeq,
		status: "active",
		version: 1,
		createdAt: now,
		updatedAt: now
	};
	await store.memories.put(memoryId, memory);
	await archiveVersion(store, {
		workspaceKey,
		memoryId,
		version: 1,
		title: memory.title,
		text: memory.text,
		tags: memory.keywords,
		collectionId: input.collectionId,
		updatedAt: now,
		changeType: "create"
	});
	return memoryId;
}
function sameText(left, right) {
	return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}
function sameTags(left, right) {
	const a = (left ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
	const b = (right ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
	if (a.length !== b.length) return false;
	const set = new Set(b);
	return a.every((tag) => set.has(tag));
}
/** 内容是否变化（正文/标题/标签/集合任一不同即算变化，集合变更也记入历史）。 */
function contentChanged(memory, patch) {
	if (patch.text !== void 0 && !sameText(memory.text, patch.text)) return true;
	if (patch.title !== void 0 && (patch.title ?? "") !== (memory.title ?? "")) return true;
	if (patch.tags !== void 0 && !sameTags(memory.keywords, patch.tags)) return true;
	if (patch.collectionId !== void 0 && (patch.collectionId ?? "") !== (memory.collectionId ?? "")) return true;
	if (patch.key !== void 0 && (patch.key ?? "") !== (memory.key ?? "")) return true;
	return false;
}
/**
* 内容三要素（标题/正文/标签）是否都没变——集合归属另算。
*
* 写路径用它做「幂等快速判定」：内容没变时不必去解析集合归属，否则一次
* 完全相同内容的重写可能顺手新建一个空集合（记忆却没被挂上去）。
*/
function memoryContentUnchanged(memory, patch) {
	if (patch.text !== void 0 && !sameText(memory.text, patch.text)) return false;
	if (patch.title !== void 0 && (patch.title ?? "") !== (memory.title ?? "")) return false;
	if (patch.tags !== void 0 && !sameTags(memory.keywords, patch.tags)) return false;
	return true;
}
/**
* 版本化就地更新：同 key 不同内容时直接改当前记忆并 version+1，把新版本整体
* 归档进 memory_versions（旧版本从它创建/上一次更新起就已在档）。
*
* 幂等：内容完全相同 → 不升版、不写历史（status 'unchanged'）。
* 记忆不存在 / 不属于该工作区时返回 undefined（调用方自行报错）。
*/
async function updateMemoryVersioned(store, workspaceKey, memoryId, patch, now = Date.now()) {
	const memory = store.memories.get(memoryId);
	if (!memory || memory.workspaceKey !== workspaceKey) return void 0;
	const version = currentVersionOf(memory);
	if (!contentChanged(memory, patch)) return {
		status: "unchanged",
		version,
		memoryId
	};
	const next = {
		...memory,
		...patch.text !== void 0 ? { text: patch.text } : {},
		...patch.title !== void 0 ? { title: patch.title } : {},
		...patch.tags !== void 0 ? { keywords: [...patch.tags] } : {},
		...patch.collectionId !== void 0 ? patch.collectionId ? { collectionId: patch.collectionId } : { collectionId: void 0 } : {},
		...patch.key !== void 0 ? patch.key ? { key: patch.key } : { key: void 0 } : {},
		version: version + 1,
		updatedAt: now
	};
	await store.memories.update(memoryId, () => next);
	await archiveVersion(store, {
		workspaceKey,
		memoryId,
		version: next.version,
		title: next.title,
		text: next.text,
		tags: next.keywords,
		collectionId: next.collectionId,
		updatedAt: now,
		changeType: "update"
	});
	return {
		status: "updated",
		version: next.version,
		memoryId
	};
}
/** 归档一条历史版本（内部入口；没有历史表时静默跳过）。 */
async function archiveVersion(store, row) {
	const table = store.memoryVersions;
	if (!table) return;
	const record = {
		workspaceKey: row.workspaceKey,
		memoryId: row.memoryId,
		version: row.version,
		title: row.title ?? "",
		text: row.text,
		tags: [...row.tags ?? []],
		...row.collectionId ? { collectionId: row.collectionId } : {},
		updatedAt: row.updatedAt,
		changeType: row.changeType
	};
	await table.put(newId("memv"), record);
}
/** 一条记忆的全部历史版本（按版本号升序；没有历史表时返回空数组）。 */
function memoryHistoryOf(store, memoryId) {
	const table = store.memoryVersions;
	if (!table) return [];
	const rows = [];
	for (const [, row] of table.entries()) {
		if (row.memoryId !== memoryId) continue;
		rows.push(row);
	}
	rows.sort((a, b) => a.version - b.version || a.updatedAt - b.updatedAt);
	return rows;
}
/** 同一工作区、active、带该 key 的记忆（用于「同 key → 就地更新」判定）。 */
function findMemoryByKey(store, workspaceKey, key) {
	for (const entry of store.memories.entries()) {
		const [id, memory] = entry;
		if (memory.workspaceKey !== workspaceKey || memory.status !== "active") continue;
		if (memory.key !== key) continue;
		return [id, memory];
	}
}
/**
* 惰性迁移：给「没有任何历史行」的旧记忆补一条 v1 历史（changeType 'migrate'），
* 不改写正文/标题/标签/集合，也不动 version（旧记录读时即 version=1）。
*
* 判重按 memoryId 查历史表，所以天然幂等：新写入的记忆create 时已在档，
* 不会重复补；可以像 migrateFlatMemories 一样在 recall/remember 前调用。
*/
async function migrateMemoryVersions(store, workspaceKey, now = Date.now()) {
	const table = store.memoryVersions;
	if (!table) return { migrated: 0 };
	const seen = /* @__PURE__ */ new Set();
	for (const [, row] of table.entries()) {
		if (row.workspaceKey !== workspaceKey) continue;
		seen.add(row.memoryId);
	}
	let migrated = 0;
	for (const [id, memory] of store.memories.entries()) {
		if (memory.workspaceKey !== workspaceKey) continue;
		if (seen.has(id)) continue;
		await archiveVersion(store, {
			workspaceKey,
			memoryId: id,
			version: currentVersionOf(memory),
			title: memory.title ?? "",
			text: memory.text,
			tags: memory.keywords ?? [],
			collectionId: memory.collectionId,
			updatedAt: memory.updatedAt ?? now,
			changeType: "migrate"
		});
		migrated += 1;
	}
	return { migrated };
}
/** Prefix of every host-native session the plugin creates as a hub (`newId('session')` in panel.ts). */
const HUB_ID_PREFIX = "session-";
/**
* R31 需求①: the historical flavour prefix of plugin hub titles
* (`SuperMemory 中枢 · <id4>`). R41 stopped GENERATING it — a session name is now
* a direct description of its work — but the constant stays because the one-time
* migrations still recognize those old rows (hub records + rename pass).
*/
const HUB_TITLE_PREFIX = "SuperMemory 中枢";
/** The pre-R31 hub title prefix ('新会话 · <id4>'); hub-title-migration renames it. */
const LEGACY_HUB_TITLE_PREFIX = "新会话";
/**
* R42: does this HOST title still carry a legacy shape the plugin no longer
* generates? Two patterns: the brand prefix (SuperMemory 中枢 · <id4>, with or
* without the id token) and the pre-R31 neutral format (新会话 · <id4>). A bare
* 「新会话」 is the CURRENT neutral name (R41) and is NOT legacy — this
* distinction keeps the rail fallback from fighting an already-clean title.
*/
function isLegacyHubTitle(title) {
	const value = String(title ?? "").trim();
	if (!value) return false;
	if (value.startsWith("SuperMemory 中枢")) return true;
	return (/* @__PURE__ */ new RegExp("^新会话\\s*·\\s*.+$")).test(value);
}
/**
* R42: the DURABLE title the plugin recorded for one hub session — the
* positive hub_sessions row first, the topic-set root member title second. A
* pure store read (no live session, no host seam), so the rail can show the
* recorded name even while the host still carries a legacy title for a session
* that has not been opened since the rename.
*/
function durableHubTitle(store, sessionId) {
	if (!store || !sessionId) return "";
	try {
		const row = store.hubs.get(sessionId);
		if (row && typeof row.title === "string" && row.title.trim()) return row.title.trim();
	} catch {}
	try {
		for (const [, topicSet] of store.topicsets.entries()) for (const member of topicSet.members) {
			if (member.sessionId !== sessionId || member.kind !== "root") continue;
			if (typeof member.title === "string" && member.title.trim()) return member.title.trim();
		}
	} catch {}
	return "";
}
/** The readable label of a workspace path: its last segment (no drive/UNC). */
function workspaceLabel(cwd) {
	const value = String(cwd ?? "").replace(/[\\/]+$/, "");
	if (!value) return "";
	const segments = value.split(/[\\/]/).filter((segment) => segment.length > 0);
	return segments.length > 0 ? segments[segments.length - 1] : "";
}
/**
* R41 需求③ / R43 需求②③: the title a plugin-created hub session gets.
*
* R41 named it after the work alone, so a hub opened before its first message
* (sidebar 新建会话 / 「＋新中枢会话」 with an empty composer) showed the bare
* neutral 「新会话」 — which says nothing about the session, and (see R43 ①)
* even made the shell's New-session capture interceptor treat the chat card of
* such a hub as a 新建会话 control. R43 makes the name meaningful by default:
*
*   `<工作区名> · <主题/首条消息摘要>`   (clipped to {@link HUB_TITLE_MAX_CHARS})
*   `<工作区名> · 新会话`                (no topic yet — still says WHICH workspace)
*
* No brand prefix and no id token. When no workspace path is available the
* shape degrades to the topic alone / the bare fallback, exactly as R41 did.
*
* @param _sessionId - kept in the signature for callers/tests; an id suffix is
*   not a description and is never part of the title.
* @param firstMessage - opening message used as the work summary.
* @param cwd - workspace path (or its canonical key) for the label.
*/
function hubSessionTitle(sessionId, firstMessage = "", cwd = "") {
	const workspace = workspaceLabel(cwd);
	const topic = describeSessionTitle(firstMessage, 48);
	if (topic && topic !== "新会话") return workspace ? clipEllipsis(`${workspace} · ${topic}`, 60) : topic;
	return workspace ? `${workspace} · ${TITLE_FALLBACK}` : TITLE_FALLBACK;
}
/**
* R43 需求②: does this title carry NO topic — i.e. is it the neutral default of
* ANY generation? The upgrade paths (panel send, first-message event hook and
* the startup rename pass) use it so they never overwrite a name a person or
* the host title service chose. Recognised neutral shapes:
*   - empty / the bare fallback 「新会话」;
*   - the R31 brand prefix 「SuperMemory 中枢 …」 and the pre-R31 「新会话 · id」;
*   - the R43 default `<工作区名> · 新会话` (with the caller's workspace, or any
*     workspace when the path is unknown).
*/
function isNeutralHubTitle(title, cwd = "") {
	const value = String(title ?? "").trim();
	if (!value) return true;
	if (value === "新会话") return true;
	if (value.startsWith("SuperMemory 中枢")) return true;
	if (/^新会话\s*·/.test(value)) return true;
	const workspace = workspaceLabel(cwd);
	if (workspace) return value === `${workspace} · ${TITLE_FALLBACK}`;
	return /·\s*新会话$/.test(value);
}
/**
* Is this id minted by the plugin as a WORK BRANCH? Fresh dispatches use
* `branch-*` and forks `fork-*`. This is the static half of the hub/branch
* rule: dispatch records a fresh branch with `kind:'root'` (it is a root of its
* own new session, not a fork), so `kind` alone cannot distinguish it from a
* topic-set hub. The prefix can.
*/
function isPluginBranchId(sessionId) {
	return sessionId.startsWith("branch-") || sessionId.startsWith("fork-");
}
function serviceOf(ctx, name) {
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
/**
* Build the "is this session running right now?" probe for the rail's dot.
*
* `Agent.status` is the host's ONLY positive activity signal (`idle` ⇄
* `running`; agent disposal removes the registry entry — see dsh-agent
* runtime-types). Session attachment (`ctx.sessions` / `sessionQuery` `live`) is
* NOT activity: a session that ended its turn stays attached, which is exactly
* why the old `live` mapping showed green dots on ended conversations.
*
* One `agents.list()` enumeration is preferred (O(sessions)); a host that only
* exposes `agents.get()` degrades to one lookup per row. Every failure mode —
* no agents service, a thrown lookup, a malformed value — answers `false`,
* because the requirement is "unknown stays dark".
*/
function runningProbe(ctx) {
	if (!ctx) return () => false;
	const agents = serviceOf(ctx, "agents");
	if (!agents) return () => false;
	try {
		if (typeof agents.list === "function") {
			const rows = agents.list();
			if (Array.isArray(rows)) {
				const running = /* @__PURE__ */ new Set();
				for (const agent of rows) {
					if (agent?.status !== "running") continue;
					const id = String(agent.id ?? "");
					if (id) running.add(id);
				}
				return (sessionId) => running.has(sessionId);
			}
		}
	} catch {}
	const get = agents.get;
	if (typeof get !== "function") return () => false;
	return (sessionId) => {
		try {
			return get.call(agents, sessionId)?.status === "running";
		} catch {
			return false;
		}
	};
}
/**
* Every FORK member id of any topic set (archived sets included) — the actual
* branch sessions. Root members are the topic-set's own hub conversation and
* must stay in the rail.
*/
function topicSetBranchIds(store) {
	const ids = /* @__PURE__ */ new Set();
	if (!store) return ids;
	for (const [, topicSet] of store.topicsets.entries()) for (const member of topicSet.members) if (member.kind === "fork") ids.add(member.sessionId);
	return ids;
}
/**
* The active topic set that owns one session as its ROOT member, newest
* `lastActiveAt` first. Used to badge a hub conversation with its set.
*/
function topicSetOfRootMember(store, sessionId) {
	if (!store) return void 0;
	let best;
	for (const [id, topicSet] of store.topicsets.entries()) {
		if (topicSet.status !== "active") continue;
		for (const member of topicSet.members) {
			if (member.sessionId !== sessionId || member.kind !== "root") continue;
			if (!best || member.lastActiveAt > best.at) best = {
				id,
				title: topicSet.title,
				at: member.lastActiveAt
			};
		}
	}
	return best ? {
		id: best.id,
		title: best.title
	} : void 0;
}
/** A fallback title when the title seam is unavailable. */
function fallbackTitle(sessionId) {
	return `未命名会话 ${sessionId.slice(-4)}`;
}
/**
* Distinct branch sessions one hub dispatched into, and how many of those still
* have an open dispatch. Reads the dispatch table (the existing hub↔branch
* relation) instead of adding a second bookkeeping row.
*/
function branchStatsOf(store, hubSessionId) {
	if (!store) return {
		total: 0,
		working: 0
	};
	const all = /* @__PURE__ */ new Set();
	const working = /* @__PURE__ */ new Set();
	for (const [, row] of store.dispatches.entries()) {
		if (row.hubSessionId !== hubSessionId) continue;
		const branchId = String(row.branchSessionId ?? "");
		if (!branchId) continue;
		all.add(branchId);
		if (isOpenDispatch(row)) working.add(branchId);
	}
	return {
		total: all.size,
		working: working.size
	};
}
/**
* List the hub sessions of one workspace, newest activity first.
*
* R35: despite the historical name/field (`origin: 'hub'`), this is a discovery
* list — see the module header ("DISCOVERY VIEW, NOT ROLE AUTHORITY"). Role
* authority is resolveRole only.
*
* @param ctx - host context (sessionQuery/sessions are read with `get`).
* @param store - the plugin store (topic-set membership + workspace facts).
* @param cwd - workspace root the panel currently points at.
* @param limit - maximum rows (default {@link HUB_SESSION_LIMIT}).
*/
async function listHubSessions(ctx, store, cwd, limit = 50) {
	if (!ctx || !cwd) return [];
	const workspaceKey = workspaceKeyOf(cwd);
	const branchIds = topicSetBranchIds(store);
	let records;
	const query = serviceOf(ctx, "sessionQuery");
	if (query && typeof query.listSessions === "function") try {
		records = await query.listSessions();
	} catch {
		records = void 0;
	}
	if (!records) try {
		const live = serviceOf(ctx, "sessions");
		records = (typeof live?.list === "function" ? live.list() : []).map((session) => ({
			header: session.header ?? { id: session.id },
			live: true,
			persisted: false
		}));
	} catch {
		records = [];
	}
	const hubs = [];
	for (const record of records) {
		const header = record?.header ?? {};
		const sessionId = String(header.id ?? "");
		if (!sessionId) continue;
		if (!header.cwd || workspaceKeyOf(header.cwd) !== workspaceKey) continue;
		if (header.parentSession) continue;
		if (header.origin === "subagent") continue;
		if (isPluginBranchId(sessionId)) continue;
		if (branchIds.has(sessionId)) continue;
		hubs.push({
			record,
			sessionId
		});
	}
	if (hubs.length === 0) return [];
	const titles = /* @__PURE__ */ new Map();
	if (query && typeof query.readTitleSnapshots === "function") try {
		const observations = await query.readTitleSnapshots(hubs.map((hub) => hub.sessionId));
		for (const observation of observations) {
			if (!observation || observation.status !== "fulfilled") continue;
			const sessionId = String(observation.sessionId ?? "");
			const title = observation.value?.title?.title;
			if (!sessionId || typeof title !== "string" || !title.trim()) continue;
			titles.set(sessionId, {
				title: title.trim(),
				...typeof observation.value?.title?.updatedAt === "number" ? { updatedAt: observation.value.title.updatedAt } : {}
			});
		}
	} catch {}
	const isRunning = runningProbe(ctx);
	const rows = hubs.map(({ record, sessionId }) => {
		const title = titles.get(sessionId);
		const createdAt = typeof record.header.createdAt === "number" ? record.header.createdAt : 0;
		const sessionCwd = String(record.header.cwd ?? cwd);
		const owner = topicSetOfRootMember(store, sessionId);
		const branchStats = branchStatsOf(store, sessionId);
		const hostTitle = title?.title ?? fallbackTitle(sessionId);
		const durable = durableHubTitle(store, sessionId);
		return {
			sessionId,
			title: (isLegacyHubTitle(hostTitle) || isNeutralHubTitle(hostTitle, sessionCwd)) && durable ? describeSessionTitle(durable) || hostTitle : hostTitle,
			live: isRunning(sessionId),
			online: record.live === true,
			updatedAt: title?.updatedAt ?? createdAt,
			createdAt,
			origin: "hub",
			cwd: sessionCwd,
			workspaceKey: workspaceKeyOf(sessionCwd),
			...owner ? {
				topicSetId: owner.id,
				topicSetTitle: owner.title
			} : {},
			branches: branchStats.total,
			workingBranches: branchStats.working
		};
	});
	rows.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
	const cap = Math.max(1, Math.min(50, Number(limit) || 50));
	return rows.slice(0, cap);
}
export { currentSessionTitle as A, listWorkspaceBranches as C, applySessionTitle as D, taskExcerpt as E, sessionTitleOf as F, ensureMemberTitle as M, firstLine as N, cleanTitleText as O, sessionTitleFor as P, listTopicSetBranches as S, renderHubBranchesCard as T, hubsByBranch as _, isLegacyHubTitle as a, latestTaskByBranch as b, listHubSessions as c, findMemoryByKey as d, memoryContentUnchanged as f, updateMemoryVersioned as g, migrateMemoryVersions as h, hubSessionTitle as i, describeSessionTitle as j, clipEllipsis as k, createMemoryVersioned as l, memoryVersionsSupported as m, HUB_TITLE_PREFIX as n, isNeutralHubTitle as o, memoryHistoryOf as p, LEGACY_HUB_TITLE_PREFIX as r, isPluginBranchId as s, HUB_ID_PREFIX as t, currentVersionOf as u, isHubSession as v, relativeAgo as w, listHubBranches as x, isOpenDispatch as y };
