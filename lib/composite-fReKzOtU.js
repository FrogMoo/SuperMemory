import { a as __exportAll, i as loadHostModule, r as workspaceKeyOf, t as newId } from "./store-D0oTD58E.js";
import { h as normalizeTags, i as hubSelection, p as deriveTitle, r as enumerateModels, u as tokenize } from "./model-B66vk3xN.js";
import { a as listTopicSets, f as updateTopicSetShape, i as getTopicSet, r as getRouting, s as setRouting, u as touchTopicSet } from "./topicsets-CqAT8J2a.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
/** A one-line task excerpt (the branch has no title yet / not a member). */
function taskExcerpt(task, max = 32) {
	const text = String(task ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "（无任务描述）";
	return Array.from(text).length > max ? `${Array.from(text).slice(0, max).join("")}…` : text;
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
		lines.push("[supermemory 关联分支] 本会话在该话题集拉起的分支：");
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
* Hub = top-level (no `parentSession`), not a subagent child (`origin`), not a
* plugin-minted branch id, and not a topic-set FORK member (archived sets
* included — an archived set still owns its branches). Root members stay hubs:
* they are a topic set's own conversation, not a dispatched branch.
*
* Anything unknown is `false`: a wrong hub classification would make a branch
* refuse to work (the hub role prompt is not injected) or make a hub skip work.
* Shared with `index.ts` so the prompt gate and the branch card cannot drift.
*/
function isHubSession(store, agent) {
	if (!store) return false;
	const shaped = agent;
	const session = shaped?.session;
	const header = session?.header;
	if (!header) return false;
	const sessionId = String(shaped?.id ?? session?.id ?? "");
	if (!sessionId) return false;
	if (header.parentSession) return false;
	if (header.origin === "subagent") return false;
	if (sessionId.startsWith("branch-") || sessionId.startsWith("fork-")) return false;
	for (const [, topicSet] of store.topicsets.entries()) if (topicSet.members.some((member) => member.sessionId === sessionId && member.kind === "fork")) return false;
	return true;
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
		return {
			sessionId,
			title: title?.title ?? fallbackTitle(sessionId),
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
/** Last attempt per set id (throttle, including failures). */
const lastAttemptAt = /* @__PURE__ */ new Map();
/** In-flight regenerations, so two activations do not call twice. */
const inflight = /* @__PURE__ */ new Map();
/** FNV-1a 32-bit, hex — a cheap stable digest for the content snapshot. */
function fnv1a(text) {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}
/**
* Content snapshot of one set: everything a regeneration would read. The
* persisted row's own title/tags/body participate, so a manual edit also marks
* the set stale (the next activation refines it once).
*/
function topicSetFingerprint(store, topicSetId, overrides = {}) {
	const record = store.topicsets.get(topicSetId);
	if (!record) return "";
	const topicSet = {
		...record,
		...overrides
	};
	const parts = [
		topicSet.title,
		topicSet.summary,
		topicSet.keywords.join(",")
	];
	for (const member of topicSet.members) parts.push(`m:${member.sessionId}:${member.kind}:${member.title}:${member.summary}:${member.status}:${member.lastActiveAt}`);
	for (const [id, episode] of store.episodes.entries()) {
		if (episode.topicSetId !== topicSetId) continue;
		parts.push(`e:${id}:${episode.timeEnd}:${episode.summary}:${episode.decisions.join("|")}`);
	}
	for (const [id, requirement] of store.requirements.entries()) {
		if (requirement.topicSetId !== topicSetId) continue;
		parts.push(`r:${id}:${requirement.status}:${requirement.text}`);
	}
	for (const [id, dispatch] of store.dispatches.entries()) {
		if (dispatch.topicSetId !== topicSetId) continue;
		parts.push(`d:${id}:${dispatch.status}:${dispatch.updatedAt ?? dispatch.createdAt}:${dispatch.task}`);
	}
	const joined = parts.join("\n");
	return `${fnv1a(joined)}-${joined.length}`;
}
/**
* Bounded textual corpus of one set's current content. Recent episodes and
* open requirements come first (they are the durable conclusions), then member
* titles and recent dispatch tasks.
*/
function buildTopicCorpus(store, topicSetId, maxChars = 4e3) {
	const topicSet = store.topicsets.get(topicSetId);
	if (!topicSet) return "";
	const lines = [
		`话题集：${topicSet.title}`,
		...topicSet.keywords.length ? [`现有标签：${topicSet.keywords.join("、")}`] : [],
		...topicSet.summary ? [`现有正文：${topicSet.summary}`] : []
	];
	const episodes = [...store.episodes.entries()].filter(([, episode]) => episode.topicSetId === topicSetId).sort((a, b) => b[1].timeEnd - a[1].timeEnd).slice(0, 5);
	if (episodes.length > 0) {
		lines.push("最近归档结论：");
		for (const [, episode] of episodes) lines.push(`- ${episode.summary || "（无梗概）"}${episode.decisions.length ? `；决策：${episode.decisions.join("；")}` : ""}`);
	}
	const requirements = [...store.requirements.entries()].filter(([, requirement]) => requirement.topicSetId === topicSetId).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 5);
	if (requirements.length > 0) {
		lines.push("需求：");
		for (const [, requirement] of requirements) lines.push(`- [${requirement.status}] ${requirement.text}`);
	}
	const members = topicSet.members.slice(0, 10);
	if (members.length > 0) {
		lines.push("会话：");
		for (const member of members) lines.push(`- ${member.kind === "fork" ? "分支" : "中枢"} ${member.title || member.sessionId}${member.summary ? `：${member.summary}` : ""}`);
	}
	const dispatches = [...store.dispatches.entries()].filter(([, dispatch]) => dispatch.topicSetId === topicSetId).sort((a, b) => (b[1].updatedAt ?? b[1].createdAt) - (a[1].updatedAt ?? a[1].createdAt)).slice(0, 6);
	if (dispatches.length > 0) {
		lines.push("最近派发：");
		for (const [, dispatch] of dispatches) lines.push(`- [${dispatch.status}] ${dispatch.task.slice(0, 160)}`);
	}
	return lines.join("\n").slice(0, maxChars);
}
/**
* Resolve the route used for generation: the set's own default model, the hub
* model of the acting session, then the first enumerated route. `undefined`
* means "no model available" — callers then keep the old shape.
*/
async function resolveTopicShapeModel(ctx, store, topicSetId, sessionId) {
	if (!ctx) return void 0;
	const topicSet = store.topicsets.get(topicSetId);
	if (topicSet?.defaultModel?.provider && topicSet.defaultModel.model) return { ...topicSet.defaultModel };
	if (sessionId) try {
		const agent = ctx.agents?.get?.(sessionId);
		const hub = hubSelection(agent);
		if (hub) return hub;
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
/** Strip code fences/quotes and collapse the title to one line. */
function cleanTitle(value, fallback) {
	let text = String(value ?? "").trim();
	text = text.replace(/^```[a-z]*\s*|```$/gi, "").replace(/^["'「『]+|["'」』]+$/g, "").trim();
	text = text.split(/\r?\n/)[0]?.trim() || "";
	if (!text) return fallback.slice(0, 48);
	return Array.from(text).slice(0, 48).join("");
}
/** Validate one parsed answer; an unusable answer yields undefined. */
function normalizeTopicShape(raw, fallbackTitle) {
	if (!raw || typeof raw !== "object") return void 0;
	const record = raw;
	const title = cleanTitle(String(record.title ?? ""), fallbackTitle);
	const tags = normalizeTags(record.tags).slice(0, 8);
	const summary = String(record.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
	if (!title && tags.length === 0 && !summary) return void 0;
	return {
		title,
		tags,
		summary
	};
}
/** Extract the first JSON object from a model answer (fences tolerated). */
function parseTopicShapeText(text, fallbackTitle) {
	const clean = String(text ?? "").replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
	const start = clean.indexOf("{");
	const end = clean.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	try {
		return normalizeTopicShape(JSON.parse(clean.slice(start, end + 1)), fallbackTitle);
	} catch {
		return;
	}
}
/**
* One model call. Returns undefined when there is no model, the call fails, it
* times out (20 s), or the answer does not contain a usable JSON object — the
* caller keeps the old shape in every one of those cases.
*/
async function generateTopicShape(deps, input, route) {
	const { ctx, store } = deps;
	if (!ctx) return void 0;
	let llm;
	try {
		llm = ctx.get?.("llm");
	} catch {
		llm = void 0;
	}
	if (!llm || typeof llm.stream !== "function") return void 0;
	const selected = route ?? (input.topicSetId ? await resolveTopicShapeModel(ctx, store, input.topicSetId) : void 0);
	if (!selected) return void 0;
	const context = [
		input.topicSetId ? buildTopicCorpus(store, input.topicSetId) : "",
		input.seedText ? `补充说明：${input.seedText}` : "",
		`当前标题：${input.title}`,
		input.tags && input.tags.length ? `当前标签：${input.tags.join("、")}` : "当前标签：（无）",
		`当前正文：${input.summary || "（无）"}`
	].filter(Boolean).join("\n").slice(0, 6e3);
	const system = [
		"你在维护 SuperMemory 话题集的检索索引。只输出一个 JSON 对象，不要代码围栏、不要解释。",
		"字段：{\"title\":\"一句话可扫读的标题（≤40字）\",\"tags\":[\"3–8个短词\"],\"summary\":\"这个话题集要做什么、已经形成的结论与决策（≤300字）\"}",
		"内容必须是结论性、可复用的事实或决策；禁止过程流水账（谁先做了什么、执行了哪些命令、第几步、工具调用日志）。",
		"标题要稳定：除非旧标题明显跑题，否则沿用它的措辞。"
	].join("\n");
	const user = `请根据以下材料重新生成话题集索引：\n\n${context}\n\n只返回 JSON。`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2e4);
	let text = "";
	try {
		const stream = llm.stream({
			provider: selected.provider,
			model: selected.model,
			...selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {},
			system,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: user
				}]
			}],
			maxTokens: 600,
			temperature: .2,
			signal: controller.signal
		});
		for await (const chunk of stream) if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
	} catch (error) {
		deps.logger?.warn(`supermemory: topic-shape generation failed: ${String(error).slice(0, 160)}`);
		return;
	} finally {
		clearTimeout(timer);
	}
	const shape = parseTopicShapeText(text, input.title);
	if (!shape) deps.logger?.warn("supermemory: topic-shape answer did not contain usable JSON; keeping the old shape");
	return shape;
}
/**
* Fill a freshly created set. The creator-supplied title is authoritative; only
* empty tags/body are filled, so an explicit seeding is never overwritten.
* Both layers already present = no model call at all.
*/
async function fillTopicShapeOnCreate(deps, topicSetId, seedText = "", fill = {}) {
	const { store } = deps;
	const topicSet = store.topicsets.get(topicSetId);
	if (!topicSet) return void 0;
	const needTags = fill.tags ?? topicSet.keywords.length === 0;
	const needSummary = fill.summary ?? !topicSet.summary.trim();
	if (!needTags && !needSummary) return void 0;
	const shape = await generateTopicShape(deps, {
		title: topicSet.title,
		tags: topicSet.keywords,
		summary: topicSet.summary,
		seedText,
		topicSetId
	});
	if (!shape) return void 0;
	const summary = needSummary ? shape.summary || topicSet.summary : topicSet.summary;
	const keywords = needTags ? shape.tags.length ? shape.tags : topicSet.keywords : topicSet.keywords;
	const fingerprint = topicSetFingerprint(store, topicSetId, {
		title: topicSet.title,
		summary,
		keywords
	});
	await updateTopicSetShape(store, topicSetId, {
		title: topicSet.title,
		summary,
		keywords,
		fingerprint,
		generatedAt: Date.now()
	});
	return shape;
}
/**
* Regenerate one set after an activation **only when its content changed**.
*
* Guards: archived sets are skipped; an unchanged fingerprint is skipped; a
* changed set is regenerated at most once per {@link TOPIC_SHAPE_MIN_INTERVAL_MS};
* concurrent callers share one in-flight promise. Failure keeps the old
* title/tags/body and the old fingerprint (the next activation retries, still
* under the throttle).
*/
function maybeRefreshTopicShape(deps, topicSetId, reason = "activation") {
	const { store } = deps;
	const topicSet = store.topicsets.get(topicSetId);
	if (!topicSet || topicSet.status !== "active") return Promise.resolve();
	const fingerprint = topicSetFingerprint(store, topicSetId);
	if (topicSet.shapeFingerprint && topicSet.shapeFingerprint === fingerprint) return Promise.resolve();
	const now = Date.now();
	if (now - (lastAttemptAt.get(topicSetId) ?? 0) < 18e4) return Promise.resolve();
	const running = inflight.get(topicSetId);
	if (running) return running;
	lastAttemptAt.set(topicSetId, now);
	const run = (async () => {
		try {
			const shape = await generateTopicShape(deps, {
				title: topicSet.title,
				tags: topicSet.keywords,
				summary: topicSet.summary,
				seedText: "",
				topicSetId
			});
			if (!shape) return;
			const latest = store.topicsets.get(topicSetId);
			if (!latest) return;
			const title = shape.title || latest.title;
			const summary = shape.summary || latest.summary;
			const keywords = shape.tags.length ? shape.tags : latest.keywords;
			const fingerprint = topicSetFingerprint(store, topicSetId, {
				title,
				summary,
				keywords
			});
			await updateTopicSetShape(store, topicSetId, {
				title,
				summary,
				keywords,
				fingerprint,
				generatedAt: Date.now()
			});
			deps.logger?.info?.(`supermemory: refreshed topic shape for ${latest.title} (${reason})`);
		} catch (error) {
			deps.logger?.warn(`supermemory: topic-shape refresh skipped: ${String(error).slice(0, 160)}`);
		} finally {
			inflight.delete(topicSetId);
		}
	})();
	inflight.set(topicSetId, run);
	return run;
}
/** Activation hook: fire-and-forget, never blocks or fails the routing write. */
function noteTopicSetActivated(deps, topicSetId) {
	maybeRefreshTopicShape(deps, topicSetId, "activation").catch(() => {});
}
// src/route.ts
/**
* 固化能力（capability）的路由规则——模型可见文案的单一事实来源：
* memory_toolize 的工具描述与每个能力工具的描述都引用它（src/tools.ts /
* src/composite.ts）。规则要点：scope 内高频事务优先固化/更新能力，不要每次
* 现敲命令；能力连续失败或文档与现状不符时必须更新能力，而不是绕过它。
*/
const CAPABILITY_ROUTING_RULES = "固化能力（capability）路由规则：① 在能力适用范围（scope）内遇到高频事务（git 同步/提交/推送、构建、验证、测试、发布等）时，优先调用已固化能力（sm_composite_*，默认预演、写操作 confirm=true 确认真实执行），不要每次现敲命令；② 没有现成能力时，用 memory_toolize register 固化一个（入口命令 + 文档 + 适用范围 + 路由描述），不要满足于一次性命令；③ 能力执行连续失败、或文档与现状不符时，必须用 memory_toolize register 同名更新能力（version+1、changelog 记录原因），不要绕过它手敲命令；④ 用 memory_toolize refresh-builtin 刷新内置能力并查看差异报告与健康度（使用次数、成败分列、连续失败、文档/适用范围缺失、零使用），按信号决定更新还是停用。";
function textOf(message) {
	return (message.content ?? []).map((block) => block.type === "text" ? String(block.text ?? "") : "").filter(Boolean).join("\n");
}
/** Score one topic set against the query tokens (title + summary + keywords). */
function scoreTopicSet(topicSet, tokens) {
	if (tokens.size === 0) return 0;
	const bag = new Set(tokenize(`${topicSet.title} ${topicSet.summary} ${topicSet.keywords.join(" ")}`));
	let hits = 0;
	for (const token of tokens) if (bag.has(token)) hits++;
	return hits / Math.sqrt(bag.size || 1);
}
/**
* Run routing for one user batch. Returns the outcome (possibly empty when
* routing declines); never throws — a routing failure must not block the hub.
*
* Only hub sessions route: branches (plugin-created topicset members) and
* delegated sessions (subagents, `delegationDepth > 0`) are skipped, so a
* worker is never parked on a routing confirmation.
*/
async function routeBatch(ctx, deps, agent, sessionId, text, signal) {
	const { store, config, logger } = deps;
	if (!config.enabled || !text.trim()) return {};
	const header = agent?.session?.header;
	const workspaceKey = workspaceKeyOf(header?.cwd);
	if ((header?.delegationDepth ?? 0) > 0) return {};
	if (isBranchSession(store, sessionId)) return {};
	const tokens = new Set(tokenize(text));
	const mention = text.match(/(?:^|[^\w@])@([^\s@,，。;；]{1,30})/);
	if (mention) {
		const name = mention[1];
		for (const [id, topicSet] of listTopicSets(store, workspaceKey)) {
			const title = topicSet.title.trim();
			if (title.length < 2) continue;
			if (title === name || title.includes(name) || name.includes(title)) {
				await setRouting(store, sessionId, {
					activeTopicSetId: id,
					driftCount: 0
				});
				await touchTopicSet(store, id);
				if (deps.ctx) noteTopicSetActivated({
					ctx: deps.ctx,
					store,
					logger: deps.logger
				}, id);
				return {
					topicSetId: id,
					card: renderCard(getTopicSet(store, id))
				};
			}
		}
	}
	const routing = getRouting(store, sessionId);
	if (routing?.activeTopicSetId) {
		const active = getTopicSet(store, routing.activeTopicSetId);
		if (active && active.status === "active") {
			if (scoreTopicSet(active, tokens) >= config.driftThreshold) {
				await setRouting(store, sessionId, { driftCount: 0 });
				await touchTopicSet(store, routing.activeTopicSetId);
				return {
					topicSetId: routing.activeTopicSetId,
					card: renderCard(active)
				};
			}
			const drift = routing.driftCount + 1;
			if (drift < config.driftTurns) {
				await setRouting(store, sessionId, { driftCount: drift });
				return {
					topicSetId: routing.activeTopicSetId,
					card: renderCard(active)
				};
			}
			await setRouting(store, sessionId, { driftCount: 0 });
		}
	}
	if (!config.hint) return {};
	const candidates = listTopicSets(store, workspaceKey).map(([id, topicSet]) => ({
		id,
		topicSet,
		score: scoreTopicSet(topicSet, tokens)
	})).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
	if (candidates.length === 0) return {};
	return { card: [
		"[SuperMemory 话题提示]",
		"检测到可能与当前对话相关的历史话题（未切换，当前对话继续）：",
		...candidates.map((c) => `- 『${c.topicSet.title}』${c.topicSet.summary ? `：${c.topicSet.summary.slice(0, 80)}` : ""}`),
		"需要切换时：在消息里 @话题集名，或在 SuperMemory 面板中点击激活。"
	].join("\n") };
}
/** True when the session is one of this plugin's branch sessions. */
function isBranchSession(store, sessionId) {
	if (isPluginBranchId(sessionId)) return true;
	for (const [, topicSet] of store.topicsets.entries()) if (topicSet.members.some((m) => m.sessionId === sessionId && m.kind === "fork")) return true;
	return false;
}
/** The model-facing topicset context card (§1.2 final step). */
function renderCard(topicSet) {
	if (!topicSet) return "";
	const lines = [`[SuperMemory 话题集] ${topicSet.title}`, topicSet.summary ? `梗概：${topicSet.summary}` : "梗概：（暂无，随对话滚动更新）"];
	if (topicSet.defaultModel) lines.push(`默认模型：${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}`);
	if (topicSet.members.length > 0) {
		lines.push("分支：");
		for (const m of topicSet.members) lines.push(`- ${m.title || m.sessionId}（${m.status}${m.model ? " · " + m.model : ""}）`);
	}
	lines.push("如需把实质工作分派到分支，调用 memory_dispatch；本会话是中枢，只做判断与整合；派发回执后立即结束本轮回复，分支完成后 relay 会自动开启新一轮对话。");
	return lines.join("\n");
}
/**
* Attach routing to the pre-step waterfall. `next()` is always called and the
* full decision passed through; only the context message is appended.
*/
function attachRoute(ctx, deps) {
	if (!deps.config.enabled) return () => {};
	let createMessage;
	const ensureFactory = async () => {
		if (!createMessage) createMessage = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
		return createMessage;
	};
	return ctx.on("agent/pre-step", async (payload, next) => {
		let decision;
		try {
			decision = await next();
		} catch (error) {
			deps.logger.warn(`supermemory: route next() failed: ${String(error)}`);
			throw error;
		}
		if (decision.kind !== "enter") return decision;
		const messages = decision.messages ?? [];
		if (!messages.some((m) => m.source?.kind === "user")) return decision;
		try {
			const sessionId = String(payload.agent?.id ?? "");
			const text = messages.map(textOf).filter(Boolean).join("\n");
			const outcome = await routeBatch(ctx, deps, payload.agent, sessionId, text, payload.signal);
			if (!outcome.card) return decision;
			const card = (await ensureFactory())({
				content: [{
					type: "text",
					text: outcome.card
				}],
				source: {
					kind: "supermemory",
					form: "recall"
				}
			});
			return {
				...decision,
				messages: [...decision.messages, card]
			};
		} catch (error) {
			deps.logger.warn(`supermemory: routing skipped: ${String(error).slice(0, 200)}`);
			return decision;
		}
	});
}
// src/builtin-capabilities.ts
/**
* 内置能力（builtin capabilities）：随插件源码一起分发的固化能力定义。
*
* 背景（2026-11-18）：git-sync 能力原先由中枢在插件重载后经 memory_toolize
* register 手工录入——清库或全新安装后插件不带这个能力，定义也只存在于
* store 里、不随代码维护。内置能力把定义收进源码：rebuildComposites 启动
* 重建时与 store 合并（缺失→播种、旧版→升级、现场更新→保留），能力定义从此
* 随插件代码一起被维护（改入口/文档/路由描述 = 改这个文件 + version+1）。
*
* 合并/升级策略（mergeBuiltinCapabilities，src/composite.ts）：
* - store 缺失        → 播种（落库 + 注册），版本 = 内置版本；
* - store 版本 < 内置  → 升级：用内置定义覆盖 entry/doc/scope/routeNote/
*                       dryRunArg/writeConfirm/runnable/title/description/tags，
*                       保留 useCount/usage 与 workspaceKey。理由：内置定义随
*                       插件代码和文档一起发布，旧版本定义本身就是「文档与现状
*                       不符」的故障形态；唯一有意的本地修改路径是
*                       memory_toolize register，它会 version+1 超过内置版本，
*                       因此版本旧于内置的行不可能是认真的本地编辑——覆盖可恢复
*                       受管行为，且不丢任何使用数据；
* - store 版本 >= 内置 → 保留现场（本地维护中的版本，或更新版插件已播种）。
*
* 维护方式：新增内置能力 = 往 BUILTIN_CAPABILITIES 加一条（version: 1）；
* 修改现有能力 = 改定义 + version+1 + changelog 追加一行（最新在前）。
* @module supermemory/builtin-capabilities
*/
/**
* 从插件自身位置推导出**本仓库根目录**。
*
* 为什么需要它：内置能力的 scope 原先写成绝对路径（'G:\09 - dsh\SuperMemory'），
* 换机器/换克隆目录后该目录不存在——能力对当前工作区不生效、健康报告持续报
* 「适用范围目录不存在」。scope 的正确含义是「入口命令的执行目录」，也就是本插件
* 所在的源码仓库，它应当随插件位置自动跟随。
*
* 推导链（宿主产物是 ESM，见 tsdown.config.ts format:'esm'，所以 import.meta.url
* 在 lib/supermemory.js 与各 chunk 里都可用；DSH profile 里的
* node_modules/dsh-supermemory 是指向源码仓库的符号链接，Node 默认解析 realpath）：
* import.meta.url → lib/<file>.js → 逐级向上找到含 package.json(name=dsh-supermemory)
* 的目录即仓库根；找不到时退回「模块目录的上一级」（lib/ 的父目录）。
*
* 兜底说明：安装成副本（非符号链接）时推导值是副本包根——此时该能力本就不适用
* （入口脚本与 docs 在副本里，不是 git 仓库），能力描述已要求调用前先确认是本仓库。
*/
function resolvePluginRepoRoot(moduleUrl = import.meta.url) {
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	let dir = moduleDir;
	for (let depth = 0; depth < 4; depth += 1) {
		try {
			if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.name === "dsh-supermemory") return dir;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(moduleDir, "..");
}
/** 本插件源码仓库根目录（scope 的推导来源，模块加载时求值一次）。 */
const PLUGIN_REPO_ROOT = resolvePluginRepoRoot();
/**
* The built-in capability catalogue (stable order = seed order).
*
* scope 由 PLUGIN_REPO_ROOT 运行时推导，跟随插件的安装/克隆位置（v2 起）：
* 不再需要在换机器后手工 memory_toolize register 修正。合并升级时若某行的
* 行级归属恰好等于「旧 scope 推导值」（即由内置定义自己播种/继承而来），
* 该行归属会随之迁移到新 scope 的工作区键；现场显式指定别的工作区的行保持不动
* （见 mergeBuiltinCapabilities）。
*/
const BUILTIN_CAPABILITIES = Object.freeze([{
	name: "git-sync-supermemory",
	version: 5,
	title: "git 同步/提交/推送（SuperMemory 仓库）",
	description: "SuperMemory 仓库 git 同步/提交/推送固化流程。先确认工作区是本仓库（有 scripts/git-sync-push.sh），否则不触发。优先 pnpm git:sync，不要手敲 fetch/rebase/push。凭据走仓库本地 GCM（helper=manager）；GIT_TERMINAL_PROMPT=0，失败找用户，勿改全局 config/remote。推送（2026-11-23 起双远程）：origin push = GitHub（FrogMoo/SuperMemory，首位）+ Gitee（zrynas.7766.org:8418/Zry/SuperMemory），fetch/pull 只走 Gitee；首个 push URL 失败即中止后续推送，故远程排位即韧性。Gitea 2026-11-22 晚曾重置、已恢复（帐号改名 旧帐号名→Zry）。日常=跑入口；预演=加 --dry-run；提交前闸门 pnpm typecheck + pnpm smoke，提交信息写文件后 commit -F。凭据键坑与恢复流程见 docs/git-sync.md。",
	entry: "pnpm git:sync",
	doc: "docs/git-sync.md",
	scope: PLUGIN_REPO_ROOT,
	runnable: true,
	dryRunArg: "--dry-run",
	writeConfirm: true,
	tags: [
		"git",
		"同步",
		"推送",
		"流程固化"
	],
	routeNote: "在本仓库范围内遇到 git 同步/提交/推送类事务时优先用本能力：先默认预演（--dry-run）看计划，确认后 confirm=true 真实执行；不要手敲 git fetch/rebase/push。",
	changelog: [
		"v5: 描述压回 500 字上限内并更新为现状。根因：v4 描述 725 字超过 buildCapabilitySpec 的 500 字上限，mergeBuiltinCapabilities 静默跳过播种（report.seeded=[]），capability-smoke C3 与 workspace-scope W5 因此失败、内置能力计数差 1。内容更新：Gitea 2026-11-22 晚重置后已恢复（帐号改名 旧帐号名→Zry，非重建）、origin push = GitHub（首位）+ Gitee Zry/SuperMemory、fetch/pull 只走 Gitee、凭据走仓库本地 GCM（git http 传输的凭据键 host 带端口，换帐号时该键与 host+port 分开写法都要 approve、旧键要 reject）。",
		"v4: 双远程同时推送（origin push URL = GitHub 优先 + Gitee，fetch 仍只走 Gitee；git 2.55 首个 push URL 失败即中止后续推送，故 GitHub 排首位保障 Gitee 故障期推送不落空）；记录 Gitee 服务器 2026-11-22 重置、旧 旧帐号名 仓 404 的现状与恢复后 URL 更新方法。",
		"v3: 凭据改为走仓库本地 GCM（manager + Windows 凭据存储）；旧 store 方案（~/.git-credentials）已失效（文件不存在，fetch 必报 could not read Username），脚本与 docs 同步更新。",
		"v2: scope 改为从插件位置自动推导（原硬编码 G:\\09 - dsh\\SuperMemory），修复仓库迁移后「适用范围目录不存在」导致能力对当前工作区失效；升级时由旧 scope 继承的行级归属一并迁移。",
		"v1: 能力内置化（原由 memory_toolize register 手工录入）：随插件分发，清库/全新安装后自动播种；附带使用统计（成败分列/连续失败/最近一次结果）与刷新入口 memory_toolize refresh-builtin。"
	]
}]);
// src/composite.ts
/**
* Composite tools (P3 / §2.3): repeated tool sequences become ONE call.
*
* The maintenance loop counts tool-call sequence signatures; past the
* threshold the plugin PROPOSES固化 at the next user interaction (never
* interrupting). On confirmation the sequence is compiled into a composite
* tool whose varying arguments become parameters, registered through the
* host's `defineTool` and persisted in the `tool_memory` table — so a restart
* rebuilds the registration from durable JSON.
*
* Nested dispatch reuses `ctx.tools.execute`, so member calls keep the full
* pre/post-execute policy chain, guards and durable tool/result events.
*
* R22 能力（capability）：同一张表也承载"固化的能力"——入口命令 + 文档 +
* 适用范围 + 路由描述 + 可一键执行（见文末 capability 区）。序列回答"按什么
* 顺序调哪些工具"，能力回答"这件事现在怎么做"，由 memory_toolize register
* 录入、rebuildComposites 重建、管理台一键执行（默认预演，写操作二次确认）。
* @module supermemory/composite
*/
var composite_exports = /* @__PURE__ */ __exportAll({
	capabilityHealthOf: () => capabilityHealthOf,
	capabilityRecordsOf: () => capabilityRecordsOf,
	compileComposite: () => compileComposite,
	liveCompositeSpecs: () => liveCompositeSpecs,
	mergeBuiltinCapabilities: () => mergeBuiltinCapabilities,
	parseArgs: () => parseArgs,
	persistComposite: () => persistComposite,
	rebuildComposites: () => rebuildComposites,
	registerCapability: () => registerCapability,
	registerComposite: () => registerComposite
});
/** changelog 上限：最新在前，超出丢弃最旧的（register 更新与内置升级共用）。 */
const CAP_CHANGELOG_MAX = 20;
/** Parse one recorded arguments value (events may carry a JSON string). */
function parseArgs(value) {
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/**
* Compile a composite spec from a signal's recorded samples: steps come from
* the latest sample; parameters are the scalar arguments that varied.
*/
function compileComposite(signal, samples) {
	const latest = samples[samples.length - 1] ?? {
		tools: [],
		args: []
	};
	const steps = latest.tools.map((tool, index) => ({
		tool,
		arguments: parseArgs(latest.args[index])
	}));
	const parameters = [];
	steps.forEach((step, stepIndex) => {
		for (const [key, value] of Object.entries(step.arguments)) {
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
			if (samples.some((sample) => {
				const other = parseArgs(sample.args[stepIndex])[key];
				return other !== void 0 && other !== value;
			})) parameters.push({
				name: `p${stepIndex}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_"),
				step: stepIndex,
				key,
				description: `${step.tool} 的 ${key}`
			});
		}
	});
	const name = `sm_composite_${signal.pattern.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24) || "seq"}`;
	return {
		name,
		title: deriveTitle(`组合工具：${latest.tools.join(" → ")}`, name),
		tags: normalizeTags([...new Set(latest.tools)]),
		description: `组合工具：${latest.tools.join(" → ")}（由重复流程 ${signal.count} 次后固化）`,
		steps,
		parameters
	};
}
/** Live composite registrations: spec name -> disposer (for edit/re-register). */
const liveComposites = /* @__PURE__ */ new Map();
/** Names of currently registered composite tools (for panel liveness). */
const liveCompositeSpecs = /* @__PURE__ */ new Set();
/**
* Increment one composite's durable use counter (matched by spec name).
*
* R26 使用统计：能力每次执行都落库——预演（dry-run）与真实执行都算，执行失败
* （非零退出/启动失败）也计；needs-confirm 没有执行，调用方不会进来。明细写进
* spec.usage（成败分列、连续失败、lastUsedAt、最近一次结果），行级 useCount 同步
* +1（面板/控制台/memory_toolize 直读它）。传入 result 时记明细；不传（旧调用点：
* 面板/控制台）只计总数。返回 Promise 供测试等待；内部 catch 保证计数写库失败
* 永远不会让一次本来成功的执行失败。
*/
function bumpCompositeUse(store, name, result) {
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		let spec;
		try {
			spec = JSON.parse(record.entry);
		} catch {
			continue;
		}
		if (spec.name !== name) continue;
		const useCount = (Number(record.useCount) || 0) + 1;
		let entry = record.entry;
		if (spec.kind === "capability") entry = JSON.stringify({
			...spec,
			usage: mergeCapabilityUsage(spec.usage, record.useCount, result)
		});
		return store.toolMemory.update(id, (r) => ({
			...r,
			useCount,
			entry
		})).catch(() => {});
	}
	return Promise.resolve();
}
/**
* Merge one run outcome into the durable usage stats (pure).
* result 缺省（旧调用点）只计总数，不动成败明细；连续失败在成功后归零。
*/
function mergeCapabilityUsage(previous, rowUseCount, result) {
	const base = previous ?? {
		useCount: Number(rowUseCount) || 0,
		successCount: 0,
		failCount: 0,
		consecutiveFailures: 0
	};
	const succeeded = result ? result.status === "completed" : void 0;
	return {
		...base,
		useCount: base.useCount + 1,
		successCount: succeeded === true ? base.successCount + 1 : base.successCount,
		failCount: succeeded === false ? base.failCount + 1 : base.failCount,
		consecutiveFailures: succeeded === void 0 ? base.consecutiveFailures : succeeded ? 0 : base.consecutiveFailures + 1,
		lastUsedAt: Date.now(),
		...result && result.status !== "needs-confirm" ? {
			lastStatus: result.status === "completed" ? "completed" : "failed",
			lastDryRun: result.dryRun,
			...typeof result.exitCode === "number" ? { lastExitCode: result.exitCode } : {},
			...result.summary ? { lastSummary: result.summary.slice(0, 200) } : {}
		} : {}
	};
}
/** Register one composite tool; returns its disposer. */
async function registerComposite(ctx, store, spec, workspaceKey) {
	const previous = liveComposites.get(spec.name);
	if (previous) {
		try {
			previous();
		} catch {}
		liveComposites.delete(spec.name);
		liveCompositeSpecs.delete(spec.name);
	}
	const tools = await loadHostModule("@deepseek-ai/dsh-tools");
	if (spec.kind === "capability" && spec.entry) {
		const capSpec = spec;
		const disposer = ctx.tools.register(tools.defineTool(capabilityToolDef(store, capSpec, workspaceKey)), { when: compositeWhenGate(spec, workspaceKey) });
		liveComposites.set(spec.name, disposer);
		liveCompositeSpecs.add(spec.name);
		return disposer;
	}
	const steps = spec.steps.map((step) => ({
		tool: step.tool,
		arguments: parseArgs(step.arguments)
	}));
	const properties = {};
	for (const parameter of spec.parameters) properties[parameter.name] = {
		type: "string",
		description: parameter.description
	};
	const disposer = ctx.tools.register(tools.defineTool({
		name: spec.name,
		description: spec.description + "（一次调用完成整个确定性子序列）",
		parameters: properties,
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["completed", "failed"],
						required: true
					},
					steps: {
						type: "integer",
						required: true
					},
					summary: {
						type: "string",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.summary ?? "")
			}]
		},
		async execute(args, exec) {
			const texts = [];
			let completed = 0;
			for (const [index, step] of steps.entries()) {
				const arguments_ = { ...step.arguments };
				for (const parameter of spec.parameters) {
					if (parameter.step !== index) continue;
					const override = args[parameter.name];
					if (override !== void 0) arguments_[parameter.key] = override;
				}
				try {
					const result = (await ctx.tools.execute({
						calls: [{
							callId: `${spec.name}:${index}`,
							name: step.tool,
							arguments: arguments_
						}],
						signal: exec.signal,
						...exec.agent ? { agent: exec.agent } : {},
						...exec.toolSet !== void 0 ? { toolSet: exec.toolSet } : {}
					})).results[0];
					if (result?.isError) return {
						status: "failed",
						steps: completed,
						summary: `第 ${index + 1} 步 ${step.tool} 失败：${result.content?.map((c) => c.text ?? "").join("") || "未知错误"}`
					};
					completed++;
					texts.push(`${step.tool} ✓`);
				} catch (error) {
					return {
						status: "failed",
						steps: completed,
						summary: `第 ${index + 1} 步 ${step.tool} 异常：${String(error).slice(0, 160)}`
					};
				}
			}
			bumpCompositeUse(store, spec.name);
			return {
				status: "completed",
				steps: completed,
				summary: `${spec.description}：${texts.join("，")}`
			};
		}
	}), { when: compositeWhenGate(spec, workspaceKey) });
	liveComposites.set(spec.name, disposer);
	liveCompositeSpecs.add(spec.name);
	return disposer;
}
/** Persist a composite spec into tool_memory (durable definition JSON). */
async function persistComposite(store, spec, signalKey, workspaceKey, logger) {
	const id = newId("tm");
	const own = workspaceKey ?? workspaceKeyFromSignalKey(signalKey);
	if (!own) logger?.info("supermemory: persistComposite 未解析到工作区归属（trigger=" + signalKey + "），按全局记录");
	const record = {
		kind: "composite",
		...own ? { workspaceKey: own } : {},
		title: spec.title ?? deriveTitle(spec.description, spec.name),
		tags: normalizeTags(spec.tags ?? spec.name),
		trigger: signalKey,
		description: spec.description,
		entry: JSON.stringify(spec),
		useCount: 0,
		status: "active",
		createdAt: Date.now()
	};
	await store.toolMemory.put(id, record);
	return id;
}
/**
* 启动回填（R28，幂等的一次性迁移）：补齐 R26/R28 之前写入的行。
* ① 归属：无 workspaceKey 的行从 trigger 前缀 `ws/<workspaceKey>/seq/` 推导写回
*    （宿主工具注册表进程全局 + persist 不落归属 = 跨工作区泄漏的两个根因）；
*    推导不到且 spec 无 scope 的行保持全局，info 日志如实记录。
* ② createdAt：缺失的行按 `spec.updatedAt ?? Date.now()` 回填（面板「增加时间」
*    对旧行也有值），info 日志；已有值的一行不动——第二次启动起不再写、不再记。
* 回填写库失败不阻塞启动（try/catch：旧介质/只读场景下降级为下次重启再试）。
*/
async function backfillToolMemoryAttribution(store, logger) {
	for (const [id, record] of [...store.toolMemory.entries()]) {
		if (record.kind !== "composite") continue;
		let spec;
		try {
			spec = JSON.parse(record.entry);
		} catch {}
		const patch = {};
		if (!record.workspaceKey) {
			const derived = record.trigger ? workspaceKeyFromSignalKey(record.trigger) : void 0;
			if (derived) {
				patch.workspaceKey = derived;
				logger?.info("supermemory: tool_memory " + id + " 归属回填为 " + derived + "（trigger 前缀推导）");
			} else if (!spec?.scope) logger?.info("supermemory: tool_memory " + id + " 无归属信息（trigger 不可推导且 spec 无 scope），保持全局");
		}
		if (record.createdAt === void 0) {
			patch.createdAt = Number(spec?.updatedAt) || Date.now();
			logger?.info("supermemory: tool_memory " + id + " 回填 createdAt=" + patch.createdAt);
		}
		if (Object.keys(patch).length === 0) continue;
		try {
			await store.toolMemory.update(id, (r) => ({
				...r,
				...patch
			}));
		} catch {}
	}
}
/** Rebuild-register every active composite from durable JSON (P3 restart). */
async function rebuildComposites(ctx, store, deps) {
	const register = deps?.register ?? registerComposite;
	try {
		await backfillToolMemoryAttribution(store, deps?.logger);
	} catch {}
	try {
		const merged = await mergeBuiltinCapabilities(store, { logger: deps?.logger });
		if (merged.seeded.length > 0 || merged.upgraded.length > 0) deps?.logger?.info("supermemory: builtin capabilities merged — seeded " + merged.seeded.join(",") + "; upgraded " + merged.upgraded.join(","));
	} catch {}
	let registered = 0;
	for (const [, record] of [...store.toolMemory.entries()]) {
		if (record.kind !== "composite" || record.status !== "active" || !record.entry) continue;
		try {
			await register(ctx, store, JSON.parse(record.entry), record.workspaceKey);
			registered++;
		} catch {}
	}
	return registered;
}
/**
* R6: edit one composite tool in place. Applies the patch to the durable
* definition, re-registers the tool (so the model sees the new description
* and behaviour immediately) and persists the change. The tool NAME is
* stable — renaming a registered tool is not supported.
*/
async function editCompositeTool(ctx, store, id, patch) {
	const record = store.toolMemory.get(id);
	if (!record || record.kind !== "composite") return {
		status: "error",
		message: "组合工具不存在。"
	};
	let spec;
	try {
		spec = JSON.parse(record.entry);
	} catch {
		return {
			status: "error",
			message: "工具定义损坏，无法编辑。"
		};
	}
	if (!spec) return {
		status: "error",
		message: "工具定义损坏，无法编辑。"
	};
	if (spec.kind === "capability") {
		if (!spec.entry) return {
			status: "error",
			message: "能力定义缺少入口命令，无法编辑。"
		};
	} else if (!Array.isArray(spec.steps) || spec.steps.length === 0) return {
		status: "error",
		message: "工具定义缺少步骤，无法编辑。"
	};
	const next = {
		...spec,
		...patch.title !== void 0 ? { title: String(patch.title).slice(0, 80) } : {},
		...patch.tags !== void 0 ? { tags: normalizeTags(patch.tags) } : {},
		...patch.description !== void 0 ? { description: String(patch.description).slice(0, 500) } : {},
		...patch.entry !== void 0 ? { entry: String(patch.entry).slice(0, 300) } : {},
		...patch.doc !== void 0 ? { doc: String(patch.doc).slice(0, 300) } : {},
		...patch.scope !== void 0 ? { scope: String(patch.scope).slice(0, 300) } : {},
		...patch.runnable !== void 0 ? { runnable: Boolean(patch.runnable) } : {},
		...patch.dryRunArg !== void 0 ? { dryRunArg: String(patch.dryRunArg).slice(0, 80) } : {},
		...patch.writeConfirm !== void 0 ? { writeConfirm: Boolean(patch.writeConfirm) } : {},
		...patch.routeNote !== void 0 ? { routeNote: String(patch.routeNote).slice(0, 500) } : {},
		...patch.steps !== void 0 ? { steps: patch.steps.map((step) => ({
			tool: String(step.tool ?? ""),
			arguments: parseArgs(step.arguments ?? {})
		})) } : {},
		...patch.parameters !== void 0 ? { parameters: patch.parameters.map((p) => ({
			name: String(p.name ?? ""),
			step: Number(p.step) || 0,
			key: String(p.key ?? ""),
			description: String(p.description ?? "")
		})) } : {}
	};
	if (next.kind !== "capability" && (next.steps.length === 0 || next.steps.some((step) => !step.tool))) return {
		status: "error",
		message: "步骤不能为空，且每步都需要工具名。"
	};
	if (patch.status !== void 0 && patch.status !== "active" && patch.status !== "retired") return {
		status: "error",
		message: "status 仅支持 active / retired。"
	};
	if (patch.status === "retired") {
		const dispose = liveComposites.get(next.name);
		if (dispose) try {
			dispose();
		} catch {}
		liveComposites.delete(next.name);
		liveCompositeSpecs.delete(next.name);
		await store.toolMemory.update(id, (r) => ({
			...r,
			status: "retired",
			description: next.description,
			entry: JSON.stringify(next),
			...next.title !== void 0 ? { title: next.title } : {},
			...next.tags !== void 0 ? { tags: next.tags } : {}
		}));
		return {
			status: "ok",
			message: `已停用${next.kind === "capability" ? "能力" : "组合工具"} ${next.name}（重启后不会重新注册）。`,
			id
		};
	}
	try {
		const previous = liveComposites.get(next.name);
		if (previous) try {
			previous();
		} catch {}
		liveComposites.delete(next.name);
		liveCompositeSpecs.delete(next.name);
		const dispose = await registerComposite(ctx, store, next, record.workspaceKey);
		liveComposites.set(next.name, dispose);
		liveCompositeSpecs.add(next.name);
	} catch (error) {
		return {
			status: "error",
			message: `重新注册失败：${String(error).slice(0, 200)}`
		};
	}
	await store.toolMemory.update(id, (r) => ({
		...r,
		title: next.title ?? r.title,
		tags: next.tags ?? r.tags,
		description: next.description,
		entry: JSON.stringify(next),
		status: "active"
	}));
	return {
		status: "ok",
		message: `已更新${next.kind === "capability" ? "能力" : "组合工具"} ${next.name}。`,
		id
	};
}
/**
* R6+: delete one composite tool for good. Unregisters the live tool when it
* is registered, drops the durable definition, and drops the sequence signal
* that created it — so the same flow must cross the threshold AGAIN before a
* new composite may be registered (a delete is not a silent retire).
*/
async function deleteCompositeTool(ctx, store, id) {
	const record = store.toolMemory.get(id);
	if (!record || record.kind !== "composite") return {
		status: "error",
		message: "组合工具不存在。"
	};
	let name = id;
	try {
		name = JSON.parse(record.entry).name ?? id;
	} catch {}
	const dispose = liveComposites.get(name);
	if (dispose) try {
		dispose();
	} catch {}
	liveComposites.delete(name);
	liveCompositeSpecs.delete(name);
	await store.toolMemory.delete(id);
	if (record.trigger) try {
		await store.signals.delete(record.trigger);
	} catch {}
	return {
		status: "ok",
		message: `已删除组合工具 ${name}。`,
		id
	};
}
/** 合法逻辑名：字母/数字/-/_，≤41 字符（工具名再派生 sm_composite_ 前缀）。 */
function isValidCapabilityName(name) {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(name);
}
/** 逻辑名 → 注册工具名（沿用 sm_composite_ 命名约定）。 */
function capabilityToolName(name) {
	return "sm_composite_" + (String(name).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "capability");
}
/**
* Build + validate one capability spec (pure: no host, no IO).
* 入参刻意不含 changelog：本函数不读它（changelog 由 register/内置合并各自记账），
* 这样 BuiltinCapability（changelog: string[] 版本史）也能直接传入。
*/
function buildCapabilitySpec(input) {
	const name = String(input.name ?? "").trim();
	if (!isValidCapabilityName(name)) return {
		status: "error",
		message: "能力名称只能包含字母/数字/-/_（≤41 字符）且以字母或数字开头。"
	};
	const entry = String(input.entry ?? "").trim();
	if (!entry) return {
		status: "error",
		message: "入口命令（entry）不能为空。"
	};
	if (entry.length > 300) return {
		status: "error",
		message: "入口命令过长（≤300 字符）。"
	};
	const description = String(input.description ?? "").trim();
	if (!description) return {
		status: "error",
		message: "描述不能为空（模型靠它路由到本能力）。"
	};
	if (description.length > 500) return {
		status: "error",
		message: "描述过长（≤500 字符）。"
	};
	const toolName = capabilityToolName(name);
	return {
		status: "ok",
		spec: {
			name: toolName,
			kind: "capability",
			title: String(input.title ?? "").trim().slice(0, 80) || deriveTitle(description, toolName),
			tags: normalizeTags(input.tags ?? [name]),
			description,
			steps: [],
			parameters: [],
			entry,
			runnable: input.runnable === void 0 ? true : Boolean(input.runnable),
			...String(input.doc ?? "").trim() ? { doc: String(input.doc).trim().slice(0, 300) } : {},
			...String(input.scope ?? "").trim() ? { scope: String(input.scope).trim().slice(0, 300) } : {},
			...String(input.dryRunArg ?? "").trim() ? { dryRunArg: String(input.dryRunArg).trim().slice(0, 80) } : {},
			...input.writeConfirm !== void 0 ? { writeConfirm: Boolean(input.writeConfirm) } : {},
			...String(input.routeNote ?? "").trim() ? { routeNote: String(input.routeNote).trim().slice(0, 500) } : {}
		}
	};
}
/**
* 调用方会话的工作区 key（宿主 exec.agent.session.header.cwd）。
* 取不到返回 undefined——没有工作区事实时不做隔离判定（测试/headless 放行）。
*/
function callerWorkspaceKey(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	if (!cwd || typeof cwd !== "string") return void 0;
	try {
		return workspaceKeyOf(cwd);
	} catch {
		return;
	}
}
/**
* 能力是否适用于某个工作区（A3 工作区隔离的单一判定）：
* - 行级归属（tool_memory.workspaceKey）优先；
* - 无行级归属时用 spec.scope 推导；
* - 两者都没有 = 全局能力（旧数据/无 scope 的注册），任何工作区适用。
*/
function capabilityAppliesToWorkspace(spec, callerWorkspace, rowWorkspaceKey) {
	if (!callerWorkspace) return true;
	const own = rowWorkspaceKey || (spec.scope ? workspaceKeyOf(spec.scope) : void 0);
	if (!own) return true;
	return own === callerWorkspace;
}
/**
* 序列 trigger 里的工作区键：`ws/<workspaceKey>/seq/<tools>` → `<workspaceKey>`
* （sequenceKey / toolize 的 persist 键都是这个形状）。不是这个形状（能力行
* `capability/<name>`、旧格式、空串）返回 undefined——归属保持缺失，由调用方
* 决定是显式传参还是留空（全局）。
*/
function workspaceKeyFromSignalKey(signalKey) {
	if (typeof signalKey !== "string") return void 0;
	const index = signalKey.indexOf("/seq/");
	if (index <= 0) return void 0;
	const prefix = signalKey.slice(0, index);
	return prefix.startsWith("ws/") && prefix.length > 3 ? prefix.slice(3) : void 0;
}
/**
* 注册门禁 context 里取调用方工作区（宿主 ToolsService.register 的 options.when）。
* 宿主按 step 解析：对每个可见工具 await registration.when(context)，context.agent
* 是 preparing agent。取不到（宿主未注入/形状不符/抛错）一律 undefined = 放行——
* 与 execute 门禁「无工作区事实时放行」语义一致。
*/
function registrationWorkspaceKey(context) {
	try {
		const cwd = (context?.agent)?.session?.header?.cwd;
		if (!cwd || typeof cwd !== "string") return void 0;
		return workspaceKeyOf(cwd);
	} catch {
		return;
	}
}
/**
* 模型可见性门禁（A3 工作区隔离的检索侧）：注册时随定义交给宿主，宿主在每个
* step 解析工具集时调用——返回 false 的工具不进 admitted set（模型不可见，调用
* 报 UNKNOWN_TOOL）。此前只有 execute 门禁（挡调用不挡检索）：跨工作区会话仍能
* 在工具列表里看到别的工作区固化的能力/序列；本门禁把「检索」也挡住。
*
* 语义与 execute 门禁一致：调用方工作区不可知时放行（true）；取到则按
* capabilityAppliesToWorkspace 判定（行级归属优先，其次 spec.scope，都没有=全局）。
* 永不抛出：宿主会把 when 的异常升级为 ToolActivationError 导致整个 step 失败，
* 因此整个判定包在 try/catch 里，任何坏形状/坏 spec 都退化为放行。
*/
function compositeWhenGate(spec, rowWorkspaceKey) {
	return (context) => {
		try {
			const caller = registrationWorkspaceKey(context);
			if (!caller) return true;
			return capabilityAppliesToWorkspace(spec, caller, rowWorkspaceKey);
		} catch {
			return true;
		}
	};
}
/** 输出截断：工具结果/HTTP 响应都不该无上限增长。 */
const CAP_OUTPUT_CLIP = 8e3;
/** 默认超时：同步子进程，120s 足够一次同步/构建类命令。 */
const CAP_TIMEOUT_MS = 12e4;
function clipCapOutput(text) {
	return text.length > CAP_OUTPUT_CLIP ? text.slice(0, CAP_OUTPUT_CLIP) + `\n…（输出过长已截断，原 ${text.length} 字符）` : text;
}
/** PATH 分隔符与键名（Windows 上 env 里可能是 `Path`）。 */
const PATH_SEP = process.platform === "win32" ? ";" : ":";
/**
* 能力执行环境的 PATH 兜底（R27）。
*
* 子进程继承 `process.env`，但桌面宿主/服务启动方式的差异会让 PATH 缺少 node 或
* pnpm 所在目录（注册表 PATH 里通常有 `%APPDATA%\npm`、`%ProgramFiles%\nodejs`）。
* 这里把「确实存在」的可执行目录**追加**进 PATH：
*   - `dirname(process.execPath)`（当前宿主用的 node/Electron 目录）；
*   - `PNPM_HOME`（pnpm 自己的约定变量）；
*   - Windows 上再由 `APPDATA/ProgramFiles/LOCALAPPDATA` 推导 npm/nodejs/pnpm 目录。
* 全部由环境变量与实际存在性推导，不硬编码盘符；原 PATH 顺序保持不变，大小写不敏感
* 去重。找不到目录时原样返回（不影响调用方）。
*/
function capabilityExecEnv(base = process.env) {
	const env = { ...base };
	const variants = Object.keys(env).filter((name) => name.toLowerCase() === "path");
	const key = variants[0] ?? "PATH";
	for (const variant of variants.slice(1)) delete env[variant];
	const parts = String(env[key] ?? "").split(PATH_SEP).map((part) => part.trim()).filter(Boolean);
	const seen = new Set(parts.map((part) => process.platform === "win32" ? part.toLowerCase() : part));
	const candidates = [];
	const add = (dir) => {
		if (dir && isAbsolute(dir)) candidates.push(dir);
	};
	add(dirname(process.execPath));
	add(env.PNPM_HOME);
	if (process.platform === "win32") {
		if (env.APPDATA) add(join(env.APPDATA, "npm"));
		if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, "pnpm"));
		if (env.ProgramFiles) add(join(env.ProgramFiles, "nodejs"));
		if (env["ProgramFiles(x86)"]) add(join(env["ProgramFiles(x86)"], "nodejs"));
	}
	for (const dir of candidates) {
		const dedupe = process.platform === "win32" ? dir.toLowerCase() : dir;
		if (seen.has(dedupe)) continue;
		if (!existsSync(dir)) continue;
		seen.add(dedupe);
		parts.push(dir);
	}
	env[key] = parts.join(PATH_SEP);
	return env;
}
/**
* Execute one capability's entry command inside its scope directory.
*
* 安全闸：① runnable=false 直接拒绝；② 定义了 dryRunArg 且调用方未显式关闭时
* 默认预演；③ writeConfirm 能力的真实执行必须 confirm=true，否则返回
* needs-confirm 且不执行。
*/
function runCapability(spec, options = {}) {
	if (spec.kind !== "capability" || !spec.entry) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun: false,
		command: "",
		summary: "不是可执行的能力定义（缺少 entry）。"
	};
	if (spec.runnable === false) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun: Boolean(options.dryRun),
		command: spec.entry,
		summary: "该能力未开放执行（runnable=false）。"
	};
	const dryRun = options.dryRun !== void 0 ? Boolean(options.dryRun) : options.confirm === true ? false : Boolean(spec.dryRunArg);
	const command = dryRun && spec.dryRunArg ? `${spec.entry} ${spec.dryRunArg}` : spec.entry;
	if (dryRun && spec.writeConfirm && !spec.dryRunArg) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun,
		command,
		summary: "该能力标记了写操作确认（writeConfirm）但未定义预演参数（dryRunArg），无法预演；确认执行请显式传 confirm=true。"
	};
	if (!dryRun && spec.writeConfirm && options.confirm !== true) return {
		status: "needs-confirm",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun,
		command,
		summary: `该能力真实执行可能写远端/改状态（writeConfirm）：确认执行请显式传 confirm=true；只要预演可保持缺省（自动追加 ${spec.dryRunArg ?? "预演参数"}）。`
	};
	const started = Date.now();
	const child = spawnSync(command, {
		shell: true,
		cwd: spec.scope && spec.scope.trim() ? spec.scope : process.cwd(),
		encoding: "utf8",
		timeout: CAP_TIMEOUT_MS,
		maxBuffer: 16777216,
		env: capabilityExecEnv()
	});
	const durationMs = Date.now() - started;
	const stdout = clipCapOutput(String(child.stdout ?? ""));
	const stderr = clipCapOutput(String(child.stderr ?? ""));
	const exitCode = typeof child.status === "number" ? child.status : void 0;
	return {
		status: Boolean(child.error) || exitCode === void 0 ? "failed" : exitCode === 0 ? "completed" : "failed",
		exitCode,
		stdout,
		stderr,
		durationMs,
		dryRun,
		command,
		summary: `${command} → ${child.error ? `启动失败：${String(child.error).slice(0, 120)}` : `exit ${exitCode}`}（${dryRun ? "预演" : "实跑"}，${durationMs}ms）`
	};
}
/**
* The model-visible description of one capability (pure; asserted by the
* capability smoke). Carries the routing note (when to prefer it), the entry
* command, the dry-run default, the write-confirm rule and the capability
* routing rules, so the model never has to guess the semantics.
*/
function capabilityToolDescription(spec) {
	const semantics = "（能力：在适用范围 " + (spec.scope || "当前目录") + " 内执行入口命令 `" + spec.entry + "`；" + (spec.dryRunArg ? `默认追加预演参数 ${spec.dryRunArg}（只读不改）；` : "") + (spec.writeConfirm ? "真实执行可能写远端/改状态：confirm=true 表示确认真实执行（自动脱离预演缺省）；" : "") + (spec.doc ? `详细流程见 ${spec.doc}；` : "") + (spec.runnable === false ? "当前未开放执行。" : "") + "返回 exitCode/stdout/stderr/durationMs。）";
	return spec.description + (spec.routeNote ? "。" + spec.routeNote : "") + semantics + "\n固化能力（capability）路由规则：① 在能力适用范围（scope）内遇到高频事务（git 同步/提交/推送、构建、验证、测试、发布等）时，优先调用已固化能力（sm_composite_*，默认预演、写操作 confirm=true 确认真实执行），不要每次现敲命令；② 没有现成能力时，用 memory_toolize register 固化一个（入口命令 + 文档 + 适用范围 + 路由描述），不要满足于一次性命令；③ 能力执行连续失败、或文档与现状不符时，必须用 memory_toolize register 同名更新能力（version+1、changelog 记录原因），不要绕过它手敲命令；④ 用 memory_toolize refresh-builtin 刷新内置能力并查看差异报告与健康度（使用次数、成败分列、连续失败、文档/适用范围缺失、零使用），按信号决定更新还是停用。";
}
/**
* The model-visible tool definition of one capability. Exported so tests (and
* headless drivers) can call execute() without a live tool registry.
*
* `workspaceKey` = 持久行的工作区归属（undefined=全局能力）：execute 时按调用方
* 会话的 cwd 判定适用性，跨工作区调用直接拒绝——不执行、不计数（A3 隔离）。
*/
function capabilityToolDef(store, spec, workspaceKey) {
	return {
		name: spec.name,
		description: capabilityToolDescription(spec),
		parameters: {
			dryRun: {
				type: "boolean",
				description: "true=强制预演；缺省时若能力定义了预演参数（dryRunArg）则自动预演"
			},
			confirm: {
				type: "boolean",
				description: "真实执行写操作能力（writeConfirm）时的二次确认，必须为 true"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"completed",
							"failed",
							"needs-confirm"
						],
						required: true
					},
					exitCode: { type: "integer" },
					stdout: { type: "string" },
					stderr: { type: "string" },
					durationMs: { type: "integer" },
					dryRun: { type: "boolean" },
					command: { type: "string" },
					summary: {
						type: "string",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: (v.status === "needs-confirm" ? "需要确认：" : "") + String(v.summary ?? "")
				}];
			}
		},
		async execute(args, exec) {
			const callerWorkspace = callerWorkspaceKey(exec);
			if (callerWorkspace && !capabilityAppliesToWorkspace(spec, callerWorkspace, workspaceKey)) {
				const own = workspaceKey || (spec.scope ? workspaceKeyOf(spec.scope) : "");
				return {
					status: "failed",
					stdout: "",
					stderr: "",
					durationMs: 0,
					dryRun: false,
					command: spec.entry,
					summary: `该能力适用于工作区 ${own || "（未知）"}，当前会话工作区是 ${callerWorkspace}：不执行（工作区隔离）。`
				};
			}
			const result = runCapability(spec, {
				...typeof args.dryRun === "boolean" ? { dryRun: args.dryRun } : {},
				...typeof args.confirm === "boolean" ? { confirm: args.confirm } : {}
			});
			if (result.status !== "needs-confirm") bumpCompositeUse(store, spec.name, result);
			return result;
		}
	};
}
/** Default seam: the real host registry and the real durable table. */
function defaultCapabilityDeps() {
	return {
		register: registerComposite,
		persist: persistComposite,
		toolExists: (ctx, name) => Boolean(ctx.tools.get(name))
	};
}
/** Dispose one live registration by tool name (best-effort; re-register replaces). */
function disposeComposite(name) {
	const dispose = liveComposites.get(name);
	if (dispose) try {
		dispose();
	} catch {}
	liveComposites.delete(name);
	liveCompositeSpecs.delete(name);
}
/**
* Register one capability: validate → durable-record lookup (same tool name =
* UPDATE in place, so re-registering the seed is idempotent) → host-tool
* conflict check (only for NEW names) → register the live tool → persist.
*/
async function registerCapability(ctx, store, input, workspaceKey, deps) {
	const built = buildCapabilitySpec(input);
	if (built.status === "error") return {
		status: "error",
		message: built.message
	};
	const spec = built.spec;
	const seam = deps ?? defaultCapabilityDeps();
	let existingId;
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		try {
			if (JSON.parse(record.entry).name !== spec.name) continue;
			if (workspaceKey && record.workspaceKey && record.workspaceKey !== workspaceKey) continue;
			if (workspaceKey && !record.workspaceKey && spec.scope && workspaceKeyOf(spec.scope) !== workspaceKey) continue;
			existingId = id;
			break;
		} catch {}
	}
	if (!existingId) try {
		if (seam.toolExists(ctx, spec.name)) return {
			status: "error",
			message: `工具名 ${spec.name} 已被占用（宿主已有同名工具）。`
		};
	} catch {}
	const hasRegistry = typeof ctx.tools?.register === "function";
	try {
		if (existingId) {
			let previous;
			try {
				previous = JSON.parse(store.toolMemory.get(existingId)?.entry ?? "");
			} catch {}
			const version = (Number(previous?.version) || 0) + 1;
			const changeLine = String(input.changelog ?? "").trim().slice(0, 200) || `更新能力定义（入口 ${spec.entry}${spec.doc ? `，文档 ${spec.doc}` : ""}）`;
			const changelog = [changeLine, ...previous?.changelog ?? []].slice(0, CAP_CHANGELOG_MAX);
			const next = {
				...spec,
				version,
				updatedAt: Date.now(),
				changelog,
				...previous?.usage ? { usage: previous.usage } : {}
			};
			disposeComposite(next.name);
			const ownWorkspace = workspaceKey ?? store.toolMemory.get(existingId)?.workspaceKey;
			if (hasRegistry) await seam.register(ctx, store, next, ownWorkspace);
			await store.toolMemory.update(existingId, (r) => ({
				...r,
				title: next.title ?? r.title,
				tags: next.tags ?? r.tags,
				description: next.description,
				entry: JSON.stringify(next),
				...workspaceKey ? { workspaceKey } : {}
			}));
			return {
				status: "ok",
				message: `已更新能力 ${next.name}（v${version}，入口 ${next.entry}）：${changeLine}`,
				id: existingId,
				name: next.name
			};
		}
		const changeLine = String(input.changelog ?? "").trim().slice(0, 200) || `注册能力（入口 ${spec.entry}${spec.doc ? `，文档 ${spec.doc}` : ""}）`;
		const stamped = {
			...spec,
			version: 1,
			updatedAt: Date.now(),
			changelog: [changeLine]
		};
		if (hasRegistry) await seam.register(ctx, store, stamped, workspaceKey);
		const id = await seam.persist(store, stamped, "capability/" + stamped.name, workspaceKey);
		return {
			status: "ok",
			message: hasRegistry ? `已注册能力 ${stamped.name}（v1，入口 ${stamped.entry}${stamped.dryRunArg ? `，默认预演 ${stamped.dryRunArg}` : ""}${stamped.writeConfirm ? "，写操作需 confirm=true" : ""}）。` : `已保存能力 ${stamped.name}（宿主未提供工具注册器，重启/重载后生效）。`,
			id,
			name: stamped.name
		};
	} catch (error) {
		return {
			status: "error",
			message: `注册失败：${String(error).slice(0, 200)}`
		};
	}
}
/** Every durable capability record (broken JSON skipped) — for list surfaces. */
function capabilityRecordsOf(store, workspaceKey) {
	const out = [];
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		try {
			const spec = JSON.parse(record.entry);
			if (spec?.kind !== "capability" || !spec.entry) continue;
			if (!capabilityAppliesToWorkspace(spec, workspaceKey, record.workspaceKey)) continue;
			out.push({
				id,
				spec,
				useCount: record.useCount,
				status: record.status,
				...record.createdAt !== void 0 ? { createdAt: record.createdAt } : {}
			});
		} catch {}
	}
	return out;
}
/**
* 把内置能力合并进 store（幂等）：缺失播种、旧版升级、现场版本保留。
*
* 升级策略（覆盖而非保留现场定义）：内置定义随插件代码与文档一起发布，旧版
* 定义本身就是「文档与现状不符」的故障形态；唯一有意的本地修改路径是
* memory_toolize register（version+1 超过内置），因此版本旧于内置的行不可能是
* 认真的本地编辑。升级保留 useCount/usage——不丢任何使用数据。
*
* 行级归属（workspaceKey）是唯一例外：若它恰好等于「旧 scope 推导出的工作区键」
* （说明是内置定义自己播种/继承的，不是现场指定），而新定义的 scope 指向别处
* （v2 起 scope 由插件位置推导，换克隆目录就会变），归属随之迁移；现场显式登记到
* 其他工作区的行不会被改写。
*
* opts.ctx + opts.register 提供时，变化的 spec 立即重新注册（refresh-builtin
* 运行时刷新用）；rebuildComposites 只做数据合并，注册交给随后的统一循环。
*/
async function mergeBuiltinCapabilities(store, opts) {
	const report = {
		seeded: [],
		upgraded: [],
		current: [],
		localNewer: [],
		changed: []
	};
	for (const builtin of BUILTIN_CAPABILITIES) {
		const toolName = capabilityToolName(builtin.name);
		let rowId;
		let row;
		for (const [id, record] of store.toolMemory.entries()) {
			if (record.kind !== "composite" || !record.entry) continue;
			try {
				if (JSON.parse(record.entry).name === toolName) {
					rowId = id;
					row = record;
					break;
				}
			} catch {}
		}
		if (!rowId || !row) {
			const built = buildCapabilitySpec(builtin);
			if (built.status === "error") continue;
			const spec = {
				...built.spec,
				version: builtin.version,
				...builtin.changelog?.length ? { changelog: [...builtin.changelog] } : {}
			};
			const seedWorkspace = builtin.scope ? workspaceKeyOf(builtin.scope) : void 0;
			await persistComposite(store, spec, "capability/" + toolName, seedWorkspace, opts?.logger);
			report.seeded.push(toolName);
			report.changed.push({
				spec,
				workspaceKey: seedWorkspace
			});
			continue;
		}
		let spec;
		try {
			spec = JSON.parse(row.entry);
		} catch {}
		if (spec && spec.kind !== "capability") continue;
		const storeVersion = Number(spec?.version) || 0;
		if (spec && storeVersion >= builtin.version) {
			if (storeVersion > builtin.version) report.localNewer.push(toolName);
			else report.current.push(toolName);
			continue;
		}
		const built = buildCapabilitySpec(builtin);
		if (built.status === "error") continue;
		const next = {
			...built.spec,
			version: builtin.version,
			updatedAt: Date.now(),
			changelog: [...builtin.changelog ?? [], ...spec?.changelog ?? []].slice(0, CAP_CHANGELOG_MAX),
			usage: spec?.usage ?? {
				useCount: Number(row.useCount) || 0,
				successCount: 0,
				failCount: 0,
				consecutiveFailures: 0
			}
		};
		const previousScopeKey = spec?.scope ? workspaceKeyOf(spec.scope) : void 0;
		const nextScopeKey = next.scope ? workspaceKeyOf(next.scope) : void 0;
		const workspaceKey = Boolean(row.workspaceKey && previousScopeKey && row.workspaceKey === previousScopeKey) && nextScopeKey ? nextScopeKey : row.workspaceKey;
		await store.toolMemory.update(rowId, (r) => ({
			...r,
			title: next.title ?? r.title,
			tags: next.tags ?? r.tags,
			description: next.description,
			entry: JSON.stringify(next),
			...workspaceKey !== r.workspaceKey ? { workspaceKey } : {},
			...r.createdAt === void 0 ? { createdAt: Number(spec?.updatedAt) || Date.now() } : {}
		}));
		report.upgraded.push(toolName);
		report.changed.push({
			spec: next,
			workspaceKey
		});
	}
	if (opts?.ctx && opts?.register) for (const entry of report.changed) try {
		await opts.register(opts.ctx, store, entry.spec, entry.workspaceKey);
	} catch {}
	return report;
}
/**
* Every durable capability's health snapshot — the data behind
* memory_toolize refresh-builtin. Pure read (existsSync 只读文件系统)。
*/
function capabilityHealthOf(store, workspaceKey) {
	const out = [];
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		let spec;
		try {
			spec = JSON.parse(record.entry);
		} catch {
			continue;
		}
		if (spec?.kind !== "capability" || !spec.entry) continue;
		if (!capabilityAppliesToWorkspace(spec, workspaceKey, record.workspaceKey)) continue;
		const usage = spec.usage;
		const builtin = BUILTIN_CAPABILITIES.find((b) => capabilityToolName(b.name) === spec.name);
		const version = Number(spec.version) || 0;
		const useCount = Number(record.useCount) || 0;
		const successCount = usage?.successCount ?? 0;
		const failCount = usage?.failCount ?? 0;
		const consecutiveFailures = usage?.consecutiveFailures ?? 0;
		const scopeMissing = Boolean(spec.scope && !existsSync(spec.scope));
		const docMissing = Boolean(spec.doc && spec.scope && !scopeMissing && !existsSync(join(spec.scope, spec.doc)));
		const notes = [];
		if (consecutiveFailures >= 2) notes.push(`连续失败 ${consecutiveFailures} 次：必须用 memory_toolize register 同名更新能力（或修订 ${spec.doc ?? "文档"}），不要绕过`);
		if (useCount > 0 && successCount === 0 && failCount > 0) notes.push("从未成功执行过：入口命令或适用范围需要修订");
		if (scopeMissing) notes.push(`适用范围目录不存在：${spec.scope}（换机器/换克隆目录时会出现，register 同名更新可修正）`);
		if (docMissing) notes.push(`文档缺失：${spec.doc}（scope 内找不到）——文档与现状不符，必须更新能力`);
		if (useCount === 0) notes.push("零使用：确认路由描述是否说清何时用它，否则更新或停用");
		if (!liveCompositeSpecs.has(spec.name)) notes.push("未注册（重启或 refresh-builtin 后生效）");
		if (builtin && version < builtin.version) notes.push(`现场版本旧于内置 v${builtin.version}：memory_toolize refresh-builtin 可升级`);
		if (builtin && version > builtin.version) notes.push(`现场版本新于内置 v${builtin.version}（本地维护中，内置升级不会覆盖）`);
		out.push({
			id,
			name: spec.name,
			...spec.title ? { title: spec.title } : {},
			entry: spec.entry,
			...spec.doc ? { doc: spec.doc } : {},
			...spec.scope ? { scope: spec.scope } : {},
			status: record.status,
			live: liveCompositeSpecs.has(spec.name),
			builtin: Boolean(builtin),
			...builtin ? { builtinVersion: builtin.version } : {},
			version,
			useCount,
			successCount,
			failCount,
			consecutiveFailures,
			...usage?.lastUsedAt !== void 0 ? { lastUsedAt: usage.lastUsedAt } : {},
			...usage?.lastStatus ? { lastStatus: usage.lastStatus } : {},
			...usage?.lastDryRun !== void 0 ? { lastDryRun: usage.lastDryRun } : {},
			...usage?.lastSummary ? { lastSummary: usage.lastSummary } : {},
			docMissing,
			scopeMissing,
			notes
		});
	}
	return out;
}
export { taskExcerpt as A, isOpenDispatch as C, listWorkspaceBranches as D, listTopicSetBranches as E, relativeAgo as O, isHubSession as S, listHubBranches as T, fillTopicShapeOnCreate as _, composite_exports as a, listHubSessions as b, liveCompositeSpecs as c, registerComposite as d, runCapability as f, renderCard as g, attachRoute as h, compileComposite as i, renderHubBranchesCard as k, persistComposite as l, CAPABILITY_ROUTING_RULES as m, capabilityAppliesToWorkspace as n, deleteCompositeTool as o, PLUGIN_REPO_ROOT as p, capabilityHealthOf as r, editCompositeTool as s, bumpCompositeUse as t, registerCapability as u, noteTopicSetActivated as v, latestTaskByBranch as w, hubsByBranch as x, isPluginBranchId as y };
