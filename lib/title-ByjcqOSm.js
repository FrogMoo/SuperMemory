import { r as workspaceKeyOf } from "./store-DmWKwFTx.js";
import { c as setTopicSetModel, d as updateMember, f as updateTopicSetShape, t as addMember } from "./topicsets-BHqGEJQ3.js";
import { i as normalizeTags } from "./retrieval-CyfG1iBH.js";
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
/**
* Card-title fallback length for a branch that has no member title yet. 48
* characters match the session-title task budget, and taskExcerpt already
* marks a cut with "…" (the previous call site passed 20, which clipped most
* one-line tasks mid-word).
*/
const BRANCH_CARD_EXCERPT_CHARS = 48;
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
	const view = {
		branchSessionId,
		title: (member?.title ?? "").trim() || taskExcerpt(latest.task, BRANCH_CARD_EXCERPT_CHARS),
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
*/
function renderHubBranchesCard(rows, options = {}) {
	if (rows.length === 0) return "";
	const now = options.now ?? Date.now();
	const maxItems = Math.max(1, Math.min(20, options.maxItems ?? 8));
	const working = rows.filter((row) => row.status === "working").length;
	const failed = rows.filter((row) => row.status === "failed").length;
	const lines = ["[supermemory 关联分支] 本会话在该话题集拉起的分支："];
	for (const row of rows.slice(0, maxItems)) {
		const parts = [
			`${row.status === "working" ? "工作中" : row.status === "failed" ? "失败待处理" : "空闲"}`,
			row.topicSetTitle ? `话题集「${row.topicSetTitle}」` : "无话题集",
			relativeAgo(row.lastActivityAt, now)
		];
		if (row.shared) parts.push(`与另外 ${row.hubs.length - 1} 个中枢共享`);
		lines.push(`- ${row.title}（${parts.join(" · ")}）`);
	}
	if (rows.length > maxItems) lines.push(`- …另有 ${rows.length - maxItems} 个分支（面板可查看全部）`);
	lines.push(`共 ${rows.length} 个分支：${working} 工作中 / ${failed} 失败 / ${rows.length - working - failed} 空闲。`);
	lines.push("继续同一分支用 mode=continue（忙则排队）；并行新任务用 tasks[]，每个任务独占一个分支并统一汇总。");
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
	const rows = hubs.map(({ record, sessionId }) => {
		const title = titles.get(sessionId);
		const createdAt = typeof record.header.createdAt === "number" ? record.header.createdAt : 0;
		const sessionCwd = String(record.header.cwd ?? cwd);
		const owner = topicSetOfRootMember(store, sessionId);
		const branchStats = branchStatsOf(store, sessionId);
		return {
			sessionId,
			title: title?.title ?? fallbackTitle(sessionId),
			live: record.live === true,
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
* @returns the title now stored on the member.
*/
async function ensureMemberTitle(store, topicSetId, member, topicTitle, task) {
	const record = store.topicsets.get(topicSetId);
	if (!record) return sessionTitleFor(topicTitle, task);
	const current = record.members.find((entry) => entry.sessionId === member.sessionId);
	if (current && current.title.trim()) return current.title;
	const others = record.members.filter((entry) => entry.sessionId !== member.sessionId).map((entry) => entry.title);
	const title = sessionTitleFor(record.title || topicTitle, task, others);
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
export { taskExcerpt as C, renderHubBranchesCard as S, isHubSession as _, ensureMemberTitle as a, listWorkspaceBranches as b, fillTopicShapeOnCreate as c, askDefaultModel as d, enumerateModels as f, hubsByBranch as g, listHubSessions as h, currentSessionTitle as i, noteTopicSetActivated as l, isPluginBranchId as m, cleanTitleText as n, firstLine as o, hubSelection as p, clipEllipsis as r, sessionTitleFor as s, applySessionTitle as t, applyModelSelection as u, isOpenDispatch as v, relativeAgo as x, listHubBranches as y };
