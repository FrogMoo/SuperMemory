import { a as listTopicSets, d as updateMember, i as getTopicSet, l as topicSetIdsOf, n as createTopicSet, o as rankMembers, p as updateTopicSetSummary, r as getRouting, s as setRouting, t as addMember, u as touchTopicSet } from "./topicsets-BHqGEJQ3.js";
import { a as __exportAll, i as loadHostModule, n as openStoreWithRetry, r as workspaceKeyOf, t as newId } from "./store-DmWKwFTx.js";
import { a as renderRecordLine, i as normalizeTags, n as deriveTitle, o as tagsOfBody, r as mergeTags, s as extractFacts, t as assessConclusion } from "./retrieval-CyfG1iBH.js";
import { C as taskExcerpt, S as renderHubBranchesCard, _ as isHubSession, a as ensureMemberTitle, b as listWorkspaceBranches, c as fillTopicShapeOnCreate, d as askDefaultModel, f as enumerateModels, g as hubsByBranch, h as listHubSessions, i as currentSessionTitle, l as noteTopicSetActivated, m as isPluginBranchId, n as cleanTitleText, o as firstLine, p as hubSelection, r as clipEllipsis, s as sessionTitleFor, t as applySessionTitle, u as applyModelSelection, v as isOpenDispatch, x as relativeAgo, y as listHubBranches } from "./title-ByjcqOSm.js";
import { a as groupRelayText, c as clipRelayResult, d as questionsForHub, f as raiseQuestion, h as resolveQuestions, i as groupRelayExists, l as episodeResult, m as renderQuestionsBlock, n as groupEpisodeSummaries, p as renderQuestionList, r as groupMembers, s as newGroupId, t as groupComplete, u as openQuestionsOfDispatch } from "./group-DvHNIRs9.js";
import { i as rememberRequirements, r as extractRequirements, t as buildExport } from "./export-BpBKNibH.js";
import { a as editCompositeTool, c as registerCapability, i as deleteCompositeTool, l as registerComposite, n as compileComposite, o as liveCompositeSpecs, s as persistComposite, t as bumpCompositeUse, u as runCapability } from "./composite-Cttx-LIx.js";
import { r as scanWorkspace } from "./filemap-BHeNYxCh.js";
import Schema from "@deepseek-ai/schemastery";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
/** Build the model-facing recall card text (温和起步, injectStyle 可配置). */
function renderRecallCard(items, style, topicSets = []) {
	if (items.length === 0) return "";
	const lines = items.map((item, index) => `${index + 1}. ${renderRecordLine({
		title: item.title,
		text: item.text,
		tags: item.keywords
	})}`);
	const hints = topicSets.length > 0 ? [`相关话题集：${topicSets.map((topicSet) => topicSet.title).join("、")}（命中记忆时可直接激活或派发到该集）`] : [];
	if (style === "plain") return [
		"[SuperMemory 相关记忆]",
		...lines,
		...hints
	].join("\n");
	return [
		"[SuperMemory 相关记忆]",
		"以下记忆可能与本话题相关，仅供参考；与当前指令冲突时以当前指令为准。",
		"记忆只存结论性事实/决策（不是过程流水账）。",
		...lines,
		...hints
	].join("\n");
}
// src/route.ts
function textOf$1(message) {
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
			const text = messages.map(textOf$1).filter(Boolean).join("\n");
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
/** Suffix of the per-workspace verification set (dispatch kind: 'verify'). */
const VERIFY_TOPIC_SET_SUFFIX = " · 验证";
/** One query text for the matcher (a parallel group joins its tasks). */
function matchQueryText(input) {
	const single = String(input.task ?? "").trim();
	if (single) return single;
	return (input.tasks ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean).join("\n");
}
/** Last path segment of a workspace key (both separators), e.g. 'SuperMemory'. */
function workspaceDirName(workspaceKey) {
	const raw = String(workspaceKey ?? "");
	const parts = raw.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : raw;
}
/** Title of the per-workspace verification set, e.g. 「SuperMemory · 验证」. */
function verifyTopicSetTitle(workspaceKey) {
	return clipEllipsis(`${workspaceDirName(workspaceKey)}${VERIFY_TOPIC_SET_SUFFIX}`, 60);
}
/**
* Find the workspace's verification set: an exact title match first, then a
* containment match (either direction) so a hand-renamed variant still counts.
* Archived sets never match. Read-only.
*/
function findVerifyTopicSet(store, workspaceKey) {
	const expected = verifyTopicSetTitle(workspaceKey);
	let contained;
	for (const [id, record] of store.topicsets.entries()) {
		if (record.workspaceKey !== workspaceKey) continue;
		if (record.status !== "active") continue;
		const title = String(record.title ?? "").trim();
		if (title === expected) return id;
		if (!contained && title.length >= 4 && (title.includes(expected) || expected.includes(title))) contained = id;
	}
	return contained;
}
/**
* Score a dispatch task against the existing topic sets of ONE workspace and
* dispose by tier. Guardrails: same workspaceKey only (cross-workspace never
* matches), archived sets skipped, the hub's active set and recently active
* sets get a small bonus. Never writes.
*/
function matchTopicSetForTask(store, input) {
	const query = matchQueryText(input);
	const workspaceKey = String(input.workspaceKey ?? "");
	if (!query || !workspaceKey || workspaceKey === "unknown") return {
		tier: "none",
		score: 0,
		candidates: [],
		reason: "没有可匹配的任务文本，或工作区未知。"
	};
	const pool = [];
	for (const entry of store.topicsets.entries()) {
		const record = entry[1];
		if (record.workspaceKey !== workspaceKey) continue;
		if (record.status !== "active") continue;
		pool.push(entry);
	}
	if (pool.length === 0) return {
		tier: "none",
		score: 0,
		candidates: [],
		reason: "同工作区内没有可匹配的话题集。"
	};
	const now = input.now ?? Date.now();
	const scored = matchTopicSets(pool, query, 8).map((hit) => {
		const record = store.topicsets.get(hit.id);
		let score = hit.score;
		if (input.activeTopicSetId && hit.id === input.activeTopicSetId) score += 2;
		if (record && record.lastActiveAt >= now - 6048e5) score += 1;
		return {
			id: hit.id,
			title: hit.title,
			score
		};
	});
	scored.sort((a, b) => b.score - a.score);
	const candidates = scored.map((row) => ({
		id: row.id,
		title: row.title,
		score: Math.round(row.score * 100) / 100
	}));
	const top = candidates[0];
	if (!top || top.score < 2) return {
		tier: "none",
		score: top?.score ?? 0,
		candidates,
		reason: top ? `最高相似度 ${top.score} 低于中等阈值 2，按现状自动新建。` : "任务与同工作区话题集没有关键词重叠，按现状自动新建。"
	};
	if (top.score >= 6) return {
		tier: "high",
		topicSetId: top.id,
		score: top.score,
		candidates,
		reason: `与话题集『${top.title}』高相似（${top.score} ≥ 6），直接复用、不新建。`
	};
	return {
		tier: "medium",
		score: top.score,
		candidates,
		reason: `与话题集『${top.title}』中等相似（${top.score}，处于 2~6 之间），不派发也不新建，等用户裁决。`
	};
}
/** The hub-facing need-confirm text (directly transcribable to the user). */
function renderTopicSetConfirm(result) {
	const lines = [`任务与现有话题集中等相似（最高分 ${result.score}），尚未派发、也未新建话题集。`, "候选话题集："];
	result.candidates.slice(0, 5).forEach((row, index) => {
		lines.push(`${index + 1}. 『${row.title}』（${row.id}，分数 ${row.score}）`);
	});
	lines.push("请用户裁决后重试：复用某个候选（带 topicSetId 派发）、强制新建（forceNewTopicSet=true），或改述任务。");
	return lines.join("\n");
}
// src/workspace.ts
/**
* Workspace visibility for branch sessions (§1.5 / P1): plugin-created
* sessions do NOT join the project grouping automatically — `attachSession`
* must be called explicitly, and it validates the session header's cwd
* against the workspace's canonical path (which is why branches are created
* with the hub's cwd).
* @module supermemory/workspace
*/
async function attachBranchToWorkspace(ctx, branchSessionId, cwd, logger) {
	const registry = ctx.workspaceRegistry;
	if (!registry) {
		logger.warn("supermemory: workspaceRegistry unavailable; branch stays ungrouped");
		return;
	}
	let path;
	try {
		path = realpathSync(cwd);
	} catch {
		path = cwd;
	}
	let workspace = await registry.resolveByPath(path);
	if (!workspace) {
		workspace = await registry.create(path);
		logger.info(`supermemory: created workspace for ${path}`);
	}
	await workspace.attachSession(branchSessionId);
}
// src/capabilities.ts
/** Anything that is not one of the profiles falls back to the default. */
const DEFAULT_CAPABILITY = "read-write";
/** Tools a minimal branch keeps (plus every `memory_*` tool). */
const MINIMAL_ALLOWED = Object.freeze([
	"read",
	"send_message",
	"wait_agent"
]);
/**
* The static vocabulary. `minimal` denies everything the other profiles deny
* (an exhaustive deny list is impossible without the live registry, so the
* restriction step below additionally removes every visible tool that is not
* on {@link MINIMAL_ALLOWED} or `memory_*`).
*/
const CAPABILITY_PROFILES = Object.freeze({
	minimal: Object.freeze({
		profile: "minimal",
		deny: Object.freeze([
			"write",
			"edit",
			"apply_patch",
			"bash",
			"terminal_open",
			"terminal_read",
			"terminal_close",
			"terminal_signal",
			"job_kill",
			"job_output",
			"job_list",
			"memory_dispatch",
			"web_search",
			"web_fetch",
			"subagent",
			"subagent_fork",
			"workflow",
			"present",
			"todo_write",
			"glob",
			"grep",
			"read_image",
			"office_render",
			"office_convert",
			"office_recalculate",
			"inspect",
			"session_search",
			"session_trace"
		]),
		label: "最小（只读文件 + 记忆/汇总）",
		description: "只能 read 文件与调用 memory_* / send_message / wait_agent，不能写文件、不能执行命令、不能继续派发"
	}),
	read: Object.freeze({
		profile: "read",
		deny: Object.freeze([
			"write",
			"edit",
			"apply_patch",
			"bash",
			"terminal_open",
			"terminal_read",
			"terminal_close",
			"terminal_signal",
			"job_kill",
			"job_output",
			"job_list",
			"memory_dispatch"
		]),
		label: "只读审阅",
		description: "可读文件、检索记忆、汇报结果；不能写文件、不能执行 shell/终端命令、不能继续派发"
	}),
	"read-write": Object.freeze({
		profile: "read-write",
		deny: Object.freeze([
			"bash",
			"apply_patch",
			"terminal_open",
			"terminal_read",
			"terminal_close",
			"terminal_signal"
		]),
		label: "读写代码（无命令）",
		description: "可读改文件（write/edit），不能执行 shell/终端命令；需要跑命令时请让中枢用 full 派发"
	}),
	full: Object.freeze({
		profile: "full",
		deny: Object.freeze([]),
		label: "完全能力",
		description: "与中枢一致：可读改文件、执行命令（含 shell/终端）"
	})
});
/**
* Resolve an untrusted profile name (`memory_dispatch.capabilities`).
* Unknown/omitted values resolve to the default (`read-write`).
*/
function resolveCapabilities(name) {
	const raw = typeof name === "string" ? name.trim().toLowerCase() : "";
	const profile = raw in CAPABILITY_PROFILES ? raw : DEFAULT_CAPABILITY;
	return CAPABILITY_PROFILES[profile];
}
/**
* Recover the names a failed `tools.restrict()` refused.
*
* The registry's message names every unknown/scope-local tool in the first
* segment (`… names unknown global tool "a", "b"; known global tools: …`).
* Parsing it is preferable to dropping the whole profile: one scope-local name
* (a preset that registers `bash` itself) would otherwise lift every
* restriction on the branch.
*/
function refusedNames(message) {
	return [...(message.split("; known global tools:")[0] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter(Boolean);
}
/** A tool the minimal profile keeps: `memory_*` plus the explicit allow list. */
function minimalAllowed(name) {
	return name.startsWith("memory_") || MINIMAL_ALLOWED.includes(name);
}
/**
* Restrict one branch agent scope to a profile.
*
* DSH's `tools.restrict()` rejects unknown names outright (it validates against
* the scope's restrictable set), so the static deny list is intersected with the
* names the live registry reports through `definitions(agent)`. Without that
* projection the raw list is attempted and a rejection is reported, never
* thrown: capability degradation must not lose a dispatch that is already
* recorded.
*
* @param tools - `agentCtx.tools` of the branch's creation/resume scope.
* @param agent - the branch Agent (definitions' viewing scope).
* @param resolved - profile from {@link resolveCapabilities}.
* @param logger - warning sink; `applied`/`unsupported` log nothing.
*/
function applyCapabilities(tools, agent, resolved, logger) {
	if (resolved.deny.length === 0 && resolved.profile === "full") return {
		status: "applied",
		profile: resolved.profile,
		denied: []
	};
	const service = tools;
	if (!service || typeof service.restrict !== "function") return {
		status: "unsupported",
		profile: resolved.profile,
		denied: []
	};
	let known;
	try {
		const rows = typeof service.definitions === "function" ? service.definitions(agent) : void 0;
		if (Array.isArray(rows)) known = new Set(rows.map((row) => String(row?.name ?? "")).filter(Boolean));
	} catch {}
	let deny;
	if (resolved.profile === "minimal") deny = known ? [...known].filter((name) => !minimalAllowed(name)) : [...resolved.deny];
	else deny = known ? resolved.deny.filter((name) => known.has(name)) : [...resolved.deny];
	if (deny.length === 0) return {
		status: "applied",
		profile: resolved.profile,
		denied: []
	};
	try {
		service.restrict({ deny });
		return {
			status: "applied",
			profile: resolved.profile,
			denied: deny
		};
	} catch (error) {
		const refused = new Set(refusedNames(String(error)));
		const retry = deny.filter((name) => !refused.has(name));
		if (refused.size > 0 && retry.length > 0 && retry.length < deny.length) try {
			service.restrict({ deny: retry });
			return {
				status: "applied",
				profile: resolved.profile,
				denied: retry
			};
		} catch {}
		const message = String(error).slice(0, 200);
		logger?.warn(`supermemory: 分支能力限制（${resolved.profile}）未生效：${message}`);
		return {
			status: "failed",
			profile: resolved.profile,
			denied: [],
			message
		};
	}
}
// src/script-delegation.ts
/**
* The branch's first message, built as a pure function (R18, 需求④).
*
* Capability setup must not live only in the hub model's head: it is written
* into the delegation script itself, so the branch reads its boundary from the
* first line of its own input ("本轮能力边界：…；越界请汇报而不是硬做"). The
* host additionally restricts the branch's tools (src/capabilities.ts), but a
* host without that seam still gets the explicit contract.
*
* Pure on purpose: scripts/mechanism-smoke.mjs asserts the exact text without a
* DSH host.
* @module supermemory/script-delegation
*/
/**
* Build the branch's opening message: header + topic set + task + the explicit
* capability boundary + the working-branch contract (R20: proceed under the
* best interpretation; ask the HUB through `memory_raise_question`, never the
* user directly).
*/
function buildDispatchScript(input) {
	const capability = resolveCapabilities(input.capabilities);
	return [
		"[supermemory-dispatch" + (input.dispatchId ? ` ${input.dispatchId}` : "") + "]",
		`话题集：${input.topicTitle}`,
		...input.branchSessionId ? [`分支会话：${input.branchSessionId}`] : [],
		`任务：${input.task}`,
		"",
		`本轮能力边界：${capability.label}（${capability.description}）；越界请汇报而不是硬做——做不到就说清楚缺什么，不要假装完成。`,
		"",
		"你是该话题集的一个工作分支：完成实质工作并汇报结果。",
		"遇到分歧按「最合理解释」直接执行，不要停下来等用户确认；把做出的假设写进最终汇报。",
		"",
		"提问约定（必须遵守）：",
		"- 需要用户裁决时，调用 memory_raise_question 把问题结构化上交中枢（title/question 必填，可选 options/severity/blocking/progress/defaultPlan），由中枢汇总所有分支的问题后统一向用户提问。",
		"- 不要在本分支对话里直接向用户提问，也不要因为提问而卡住不干活：非阻塞问题（blocking=false）上交后继续按最合理解释推进并完成实质工作。",
		"- 只有真正阻断、非用户裁决无法继续时才 blocking=true，并同时写清已完成的进度（progress）与默认备选方案（defaultPlan）。"
	].join("\n");
}
// src/round-end.ts
/**
* R24: 派发 / 续跑回执的「收口」契约。
*
* 宿主对空闲会话收到 followup 会**新开一个 turn**，只有会话正忙时才排队
* （见 dsh-agent 的 inbox：nextTurn 在 turn 结束后才被 claim）。因此中枢在
* 本轮里等分支，等于把 relay 锁在队列里——分支不是中枢 subagent 树的成员，
* wait_agent 永远等不到它们。回执带 nextAction，让模型在拿到回执的同一步
* 结束本轮，由 relay 开启下一轮。
*
* 文案是唯一来源：dispatch.ts 的回执、tools.ts 的输出 schema 渲染、冒烟断言
* 都引用这里，防止三处文案漂移。
* @module supermemory/round-end
*/
/** memory_dispatch 成功回执的收口提示（单条 / 并行组通用）。 */
const DISPATCH_NEXT_ACTION = "已派发。请立即结束本轮回复；分支完成后 relay 会自动开启新一轮对话，届时再汇总转述给用户。";
/** memory_resume 续跑回执的收口提示（只查清单时不需要）。 */
const RESUME_NEXT_ACTION = "已续跑。请立即结束本轮回复；分支完成后 relay 会自动开启新一轮对话，届时再汇总转述给用户。";
// src/dispatch.ts
const branchHandles = /* @__PURE__ */ new Map();
let createMessage$1;
async function messageFactory$3() {
	if (!createMessage$1) createMessage$1 = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return createMessage$1;
}
/** Parse the "provider/model" text stored on a topic-set member. */
function parseMemberModel(raw) {
	if (!raw) return void 0;
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) return void 0;
	return {
		provider: raw.slice(0, slash),
		model: raw.slice(slash + 1)
	};
}
function agentCwd(agent) {
	return agent?.session?.header?.cwd;
}
function serviceOf(ctx, name) {
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
function sessionOf(agent) {
	return agent?.session;
}
/** Read the hub's preset and permission facts, each independently optional. */
function hubComposition(ctx, hubAgent) {
	const session = sessionOf(hubAgent);
	if (!session) return {};
	const out = {};
	try {
		const presetId = serviceOf(ctx, "agentPresets")?.presetForSession(session) ?? session.header?.agentPreset;
		if (presetId) out.presetId = presetId;
	} catch {}
	try {
		const sandbox = serviceOf(ctx, "sandboxPolicy");
		const mode = sandbox?.resolve?.({ session }).mode ?? sandbox?.overrideOf?.(session);
		if (mode) out.sandboxMode = mode;
	} catch {}
	try {
		const approval = serviceOf(ctx, "approval");
		const policy = approval?.overrideOf?.(session) ?? approval?.config?.policy;
		if (policy) out.approvalPolicy = policy;
	} catch {}
	return out;
}
/**
* Build the pre-publication `setup` callback that mounts the preset onto the
* fresh agent scope and copies the hub's permission facts.
*
* Exported as the seam scripts/mechanism-smoke.mjs drives (F5): the branch
* capability contract must hold without a DSH host.
*
* Mount is best-effort on purpose: a roster that lost the preset must not fail
* the dispatch (the branch still gets the Host tools and the relay channel),
* but the degradation is logged so the cause is visible.
*/
function compositionSetup(ctx, wanted, logger, capabilities) {
	return async (agentCtx, agent) => {
		const session = sessionOf(agent);
		const presets = serviceOf(ctx, "agentPresets");
		let presetId = wanted.presetId;
		try {
			const recorded = session ? presets?.presetForSession(session) : null;
			if (recorded) presetId = recorded;
		} catch {}
		if (presets && presetId) try {
			await presets.mount(agentCtx, presetId);
		} catch (error) {
			logger.warn(`supermemory: agent preset「${presetId}」mount failed for a branch (${String(error).slice(0, 160)}); the branch keeps host tools only`);
		}
		if (capabilities) {
			const applied = applyCapabilities(agentCtx.tools, agent, capabilities, logger);
			if (applied.status === "applied" && applied.denied.length > 0) logger.info?.(`supermemory: branch capability「${capabilities.profile}」applied (${applied.denied.length} tools denied)`);
		}
		if (!session?.append) return;
		try {
			if (wanted.sandboxMode) session.append("sandbox/mode", {
				mode: wanted.sandboxMode,
				source: "delegation"
			});
			if (wanted.approvalPolicy) session.append("approval/policy", {
				policy: wanted.approvalPolicy,
				source: "delegation"
			});
		} catch (error) {
			logger.warn(`supermemory: permission inheritance failed for a branch (${String(error).slice(0, 160)})`);
		}
	};
}
/**
* The dispatch tool body. `tasks[]` (2+) becomes one parallel group (D6);
* a single `task` is the single-dispatch path. Returns receipts immediately;
* the hub never blocks beyond branch acquisition.
*
* R19 协同①: parallel groups were silently weaker than advertised. The old code
* mapped every group task to `new` (so `continue`/`auto` reuse was impossible)
* and acquisition always ranked `members[0]`, so two similar tasks could be
* steered at one branch and merged into a single conversation. Group tasks now
* CLAIM distinct branches (`claimed`), each task reuses an idle topic-set branch
* when one ranks and otherwise gets its own fresh branch, and one task's
* exception no longer aborts the remaining tasks (it becomes an annotated
* failure member, so the single group relay still accounts for every task).
*
* R19 协同③: a branch belongs to its TOPIC SET, not to the hub that created it.
* `acquireBranch` never scopes reuse by `hubSessionId`; any hub of the same set
* can continue an idle branch (that is what "共享" means here), while a busy
* branch is never silently merged into — `auto` falls back to a fresh branch and
* only an explicit `mode=continue` queues behind the busy branch.
*/
async function runDispatch(deps, args, exec) {
	const { ctx, store, logger } = deps;
	const hubSessionId = String(exec.agent?.id ?? "");
	const cwd = agentCwd(exec.agent);
	if (!hubSessionId || !cwd) return {
		status: "error",
		message: "无法确定中枢会话或工作区（agent 会话缺少 cwd），已拒绝派发。"
	};
	const workspaceKey = workspaceKeyOf(cwd);
	const firstTask = (args.task ?? args.tasks?.[0] ?? "").trim();
	if (!(Boolean(firstTask) || (args.tasks ?? []).some((entry) => String(entry ?? "").trim().length > 0))) return {
		status: "error",
		message: "task 不能为空。"
	};
	let topicSetId = args.topicSetId?.trim();
	if (topicSetId && !getTopicSet(store, topicSetId)) return {
		status: "error",
		message: `话题集 ${topicSetId} 不存在。`
	};
	let topicSetSource = topicSetId ? "explicit" : "auto-created";
	if (!topicSetId) {
		topicSetId = getRouting(store, hubSessionId)?.activeTopicSetId;
		if (topicSetId) topicSetSource = "sticky";
	}
	if (!topicSetId && args.kind === "verify") {
		const existing = findVerifyTopicSet(store, workspaceKey);
		if (existing) {
			topicSetId = existing;
			topicSetSource = "reused";
			logger.info(`supermemory: dispatch reused verify topic set ${topicSetId}`);
		} else {
			topicSetId = await createTopicSet(store, {
				workspaceKey,
				title: verifyTopicSetTitle(workspaceKey)
			});
			topicSetSource = "verify";
			logger.info(`supermemory: dispatch created verify topic set ${topicSetId}`);
		}
		await setRouting(store, hubSessionId, {
			activeTopicSetId: topicSetId,
			driftCount: 0
		});
		noteTopicSetActivated({
			ctx,
			store,
			logger
		}, topicSetId);
	}
	if (!topicSetId && args.forceNewTopicSet) {
		topicSetId = await createTopicSet(store, {
			workspaceKey,
			title: clipEllipsis(firstLine(cleanTitleText(firstTask)), 60)
		});
		topicSetSource = "force-new";
		await setRouting(store, hubSessionId, {
			activeTopicSetId: topicSetId,
			driftCount: 0
		});
		noteTopicSetActivated({
			ctx,
			store,
			logger
		}, topicSetId);
		logger.info(`supermemory: dispatch force-created topic set ${topicSetId}`);
	}
	if (!topicSetId) {
		const match = matchTopicSetForTask(store, {
			task: firstTask,
			tasks: args.tasks,
			workspaceKey,
			activeTopicSetId: getRouting(store, hubSessionId)?.activeTopicSetId
		});
		if (match.tier === "high" && match.topicSetId) {
			topicSetId = match.topicSetId;
			topicSetSource = "reused";
			await setRouting(store, hubSessionId, {
				activeTopicSetId: topicSetId,
				driftCount: 0
			});
			noteTopicSetActivated({
				ctx,
				store,
				logger
			}, topicSetId);
			logger.info(`supermemory: dispatch reused topic set ${topicSetId} (score ${match.score})`);
		} else if (match.tier === "medium") {
			logger.info(`supermemory: dispatch needs topic-set confirmation (top score ${match.score})`);
			return {
				status: "need-confirm",
				message: renderTopicSetConfirm(match),
				candidates: match.candidates.slice(0, 5),
				reason: match.reason
			};
		} else {
			topicSetId = await createTopicSet(store, {
				workspaceKey,
				title: clipEllipsis(firstLine(cleanTitleText(firstTask)), 60)
			});
			topicSetSource = "auto-created";
			await setRouting(store, hubSessionId, {
				activeTopicSetId: topicSetId,
				driftCount: 0
			});
			noteTopicSetActivated({
				ctx,
				store,
				logger
			}, topicSetId);
			logger.info(`supermemory: dispatch auto-created topic set ${topicSetId}`);
		}
	}
	const topicSet = getTopicSet(store, topicSetId);
	if (!topicSet) return {
		status: "error",
		message: "话题集解析失败。"
	};
	await touchTopicSet(store, topicSetId);
	const hubModel = hubSelection(exec.agent);
	const composition = hubComposition(ctx, exec.agent);
	const capabilities = resolveCapabilities(args.capabilities);
	const mode = args.mode ?? "auto";
	const tasks = (args.tasks ?? []).map((t) => String(t ?? "").trim()).filter(Boolean);
	if (tasks.length >= 2) {
		const groupId = newGroupId();
		const groupMode = mode === "fork" ? "fork" : mode === "new" ? "new" : "auto";
		const claimed = /* @__PURE__ */ new Set();
		const receipts = [];
		for (const task of tasks) {
			let result;
			try {
				result = await dispatchOne(deps, {
					topicSetId,
					topicSet,
					task,
					cwd,
					hubSessionId,
					hubModel,
					composition,
					capabilities,
					mode: groupMode,
					groupId,
					excludeBranches: claimed
				});
			} catch (error) {
				result = {
					status: "error",
					dispatchId: await recordGroupFailure(deps, {
						topicSetId,
						task,
						hubSessionId,
						groupId,
						error
					}),
					groupId,
					topicSetId,
					message: `分支派发异常：${String(error).slice(0, 200)}`
				};
			}
			if (result.branchSessionId) claimed.add(result.branchSessionId);
			receipts.push({
				task,
				result
			});
		}
		const ok = receipts.filter((row) => row.result.status === "dispatched").length;
		logger.info(`supermemory: group ${groupId} dispatched ${ok}/${tasks.length} (distinct branches: ${claimed.size})`);
		const firstId = receipts[0]?.result.dispatchId;
		return {
			status: ok > 0 ? "dispatched" : "error",
			...firstId ? { dispatchId: firstId } : {},
			groupId,
			topicSetId,
			nextAction: DISPATCH_NEXT_ACTION,
			branches: receipts.map((row) => ({
				...row.result.branchSessionId ? { branchSessionId: row.result.branchSessionId } : {},
				task: row.task,
				status: row.result.status
			})),
			message: ok > 0 ? `已派发 ${ok}/${tasks.length} 个分支任务（组 ${groupId}，每个任务独占一个分支并行执行）；全部到达终态后只回送一次汇总，失败成员会单独标注。` + (topicSetSource === "explicit" || topicSetSource === "sticky" ? "" : `（${topicSetSource === "reused" ? "复用" : topicSetSource === "verify" ? "验证集" : "新建"}话题集『${topicSet.title}』）`) : `全部任务派发失败（组 ${groupId}）。`
		};
	}
	const task = firstTask;
	if (!task) return {
		status: "error",
		message: "task 不能为空。"
	};
	const one = await dispatchOne(deps, {
		topicSetId,
		topicSet,
		task,
		cwd,
		hubSessionId,
		hubModel,
		composition,
		capabilities,
		mode
	});
	if (one.status === "dispatched" && topicSetSource !== "explicit" && topicSetSource !== "sticky") {
		const how = topicSetSource === "reused" ? "复用" : topicSetSource === "verify" ? "验证集" : topicSetSource === "force-new" ? "强制新建" : "自动新建";
		return {
			...one,
			message: `已派发到分支 ${one.branchSessionId ?? ""}（${how}话题集『${topicSet.title}』）；完成后结果会主动送回本会话。`
		};
	}
	return one;
}
/**
* Record a group member whose dispatch threw before a record was written. A
* missing row would make `groupComplete` skip the task entirely (the relay then
* claims "N 成功 / 0 失败" while a task silently vanished). Returns the id.
*/
async function recordGroupFailure(deps, input) {
	const dispatchId = newId("dsp");
	const now = Date.now();
	try {
		await deps.store.dispatches.put(dispatchId, {
			topicSetId: input.topicSetId,
			groupId: input.groupId,
			branchSessionId: "",
			task: input.task,
			hubSessionId: input.hubSessionId,
			startSeq: 0,
			status: "failed",
			turnEndReason: `dispatch-error: ${String(input.error).slice(0, 120)}`,
			createdAt: now,
			updatedAt: now
		});
	} catch (error) {
		deps.logger.warn(`supermemory: group failure record failed: ${String(error).slice(0, 160)}`);
	}
	return dispatchId;
}
/** One dispatch: record → acquire → wake → receipt. Shared by both paths. */
async function dispatchOne(deps, input) {
	const { ctx, store, logger } = deps;
	const { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, composition, capabilities, mode, groupId, excludeBranches } = input;
	const dispatchId = newId("dsp");
	const now = Date.now();
	const record = {
		topicSetId,
		groupId,
		branchSessionId: "",
		task,
		hubSessionId,
		startSeq: 0,
		status: "queued",
		createdAt: now,
		updatedAt: now
	};
	await store.dispatches.put(dispatchId, record);
	let branchSessionId;
	let handle;
	let kind = "root";
	try {
		const acquired = await acquireBranch(deps, {
			topicSetId,
			topicSet,
			task,
			cwd,
			mode,
			hubModel,
			composition,
			capabilities,
			...excludeBranches && excludeBranches.size > 0 ? { exclude: excludeBranches } : {}
		});
		branchSessionId = acquired.sessionId;
		handle = acquired.handle;
		kind = acquired.kind;
	} catch (error) {
		await store.dispatches.update(dispatchId, (r) => ({
			...r,
			status: "failed",
			updatedAt: Date.now()
		}));
		return {
			status: "error",
			dispatchId,
			...groupId ? { groupId } : {},
			message: `分支获取失败：${String(error).slice(0, 200)}`
		};
	}
	await store.dispatches.update(dispatchId, (r) => ({
		...r,
		branchSessionId,
		startSeq: ctx.sessions.get(branchSessionId)?.seq ?? 0,
		status: "dispatched",
		updatedAt: Date.now()
	}));
	try {
		const named = await ensureMemberTitle(store, topicSetId, {
			sessionId: branchSessionId,
			kind
		}, topicSet.title, task);
		const applied = applySessionTitle(ctx, branchSessionId, named, logger);
		if (applied === "host" || applied === "fallback") logger.info(`supermemory: named branch ${branchSessionId.slice(0, 20)} 「${named}」 via ${applied}`);
	} catch (error) {
		logger.warn(`supermemory: branch naming failed for ${branchSessionId}: ${String(error).slice(0, 160)}`);
	}
	try {
		await attachBranchToWorkspace(ctx, branchSessionId, cwd, logger);
	} catch (error) {
		logger.warn(`supermemory: workspace attach failed for ${branchSessionId}: ${String(error).slice(0, 160)}`);
	}
	try {
		const factory = deps.createMessage ?? await messageFactory$3();
		const script = buildDispatchScript({
			task,
			capabilities: capabilities.profile,
			topicTitle: topicSet.title,
			branchSessionId,
			dispatchId
		});
		const message = factory({
			content: [{
				type: "text",
				text: groupId ? `${script}\n\n本任务是并行组 ${groupId} 的一员：只负责这一个任务；全部成员到达终态后由中枢统一汇总，不要等待其他分支。` : script
			}],
			source: { kind: "supermemory" }
		});
		if (!handle) throw new Error("分支句柄缺失（acquireBranch 未返回 handle）");
		const seqBefore = ctx.sessions.get(branchSessionId)?.seq;
		handle.agent.followup(message);
		await new Promise((r) => setTimeout(r, 300));
		const seqAfter = ctx.sessions.get(branchSessionId)?.seq;
		if (typeof seqBefore === "number" && typeof seqAfter === "number" && seqAfter > seqBefore) {
			await store.dispatches.update(dispatchId, (r) => ({
				...r,
				startSeq: seqBefore,
				updatedAt: Date.now()
			}));
			logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} input landed (seq ${seqBefore} → ${seqAfter})`);
		} else logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} input not observed yet (seq ${seqBefore} → ${seqAfter}); leaving it to observation/reconciliation`);
	} catch (error) {
		logger.warn(`supermemory: branch followup threw: ${String(error).slice(0, 300)}`);
		await store.dispatches.update(dispatchId, (r) => ({
			...r,
			status: "failed",
			updatedAt: Date.now()
		}));
		return {
			status: "error",
			dispatchId,
			...groupId ? { groupId } : {},
			branchSessionId,
			message: `分支唤醒失败：${String(error).slice(0, 200)}`
		};
	}
	logger.info(`supermemory: dispatched ${dispatchId} → ${branchSessionId}`);
	return {
		dispatchId,
		branchSessionId,
		status: "dispatched",
		topicSetId,
		nextAction: DISPATCH_NEXT_ACTION,
		...groupId ? { groupId } : {}
	};
}
/**
* Pure branch-selection plan (R19 协同①③), exported as the test seam.
*
* `busy` is the set of branches with an open dispatch; `exclude` the branches a
* parallel group already claimed. The rules are:
*  - `new`: never reuse (candidates empty);
*  - `fork`: fork the best ranked member (when any);
*  - `continue`: rank order as-is, INCLUDING busy branches (explicit queueing);
*  - `auto`: rank order restricted to IDLE branches — a busy branch is never
*    merged into implicitly. No idle candidate means a fresh branch.
* Hub identity is deliberately absent: branches belong to the topic set and any
* hub of that set may continue one (cross-hub sharing).
*/
function branchCandidates(topicSet, task, mode, busy, exclude) {
	const taskTokens = new Set(task.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean));
	const ranked = rankMembers(topicSet, taskTokens).filter((member) => !exclude?.has(member.sessionId));
	if (mode === "new") return { candidates: [] };
	return {
		...mode === "fork" && ranked.length > 0 ? { forkParent: ranked[0] } : {},
		candidates: mode === "continue" ? ranked : ranked.filter((member) => !busy.has(member.sessionId))
	};
}
/** Branches with at least one open dispatch (the `busy` input of the plan). */
function busyBranches(store) {
	const busy = /* @__PURE__ */ new Set();
	for (const [, record] of store.dispatches.entries()) if (record.branchSessionId && isOpenDispatch(record)) busy.add(record.branchSessionId);
	return busy;
}
/**
* Branch acquisition order (§1.3): live handle → live registry agent → resume;
* `fork` builds a seeded child from the parent's last completed turn.
* Model resolution: topicset default → hub's current selection (so a branch
* without a set default follows the hub) → deployment default.
*
* R19 协同①③: the plan above decides WHICH branches are eligible; this function
* only executes it. `auto` therefore never forks (that split a set-owned branch
* instead of continuing it) and never merges into a busy branch; only explicit
* `continue` queues behind one.
*/
async function acquireBranch(deps, input) {
	const { ctx, store, logger } = deps;
	const { topicSetId, topicSet, task, cwd, mode, hubModel, composition, capabilities, exclude } = input;
	const agentOptions = topicSet.defaultModel ?? hubModel;
	const plan = branchCandidates(topicSet, task, mode, busyBranches(store), exclude);
	if (mode === "fork" && plan.forkParent) {
		const forked = await forkFromParent(ctx, plan.forkParent.sessionId, cwd, topicSet.defaultModel, composition, capabilities, logger);
		if (forked) return {
			...forked,
			kind: "fork"
		};
	}
	for (const target of plan.candidates) {
		const held = branchHandles.get(target.sessionId);
		if (held) return {
			sessionId: target.sessionId,
			handle: held,
			kind: target.kind
		};
		const live = ctx.agents.get(target.sessionId);
		if (live) {
			await updateMember(store, topicSetId, target.sessionId, { status: "live" });
			return {
				sessionId: target.sessionId,
				handle: {
					agent: live,
					dispose: async () => {}
				},
				kind: target.kind
			};
		}
		try {
			const resumeOptions = parseMemberModel(target.model) ?? agentOptions;
			const handle = await ctx.agents.resume({
				resumeSessionId: target.sessionId,
				...resumeOptions ? { agentOptions: { ...resumeOptions } } : {},
				setup: compositionSetup(ctx, composition, logger, capabilities)
			});
			const branch = {
				agent: handle.agent,
				dispose: () => handle.dispose()
			};
			branchHandles.set(target.sessionId, branch);
			await updateMember(store, topicSetId, target.sessionId, { status: "live" });
			return {
				sessionId: target.sessionId,
				handle: branch,
				kind: target.kind
			};
		} catch (error) {
			logger.warn(`supermemory: resume ${target.sessionId} failed: ${String(error).slice(0, 160)}`);
		}
	}
	const sessionId = newId("branch");
	const handle = await ctx.agents.create({
		sessionId,
		meta: {
			cwd,
			...composition.presetId ? { agentPreset: composition.presetId } : {}
		},
		setup: compositionSetup(ctx, composition, logger, capabilities),
		...agentOptions ? { agentOptions: { ...agentOptions } } : {}
	});
	const branch = {
		agent: handle.agent,
		dispose: () => handle.dispose()
	};
	branchHandles.set(sessionId, branch);
	return {
		sessionId,
		handle: branch,
		kind: "root"
	};
}
/** Fork a seeded child from the parent's last completed-turn prefix (§1.3). */
async function forkFromParent(ctx, parentSessionId, cwd, defaultModel, composition, capabilities, logger) {
	try {
		const parent = ctx.agents.get(parentSessionId);
		if (!parent) return void 0;
		const boundary = ctx.agents.turnBoundaryOf(parent.session);
		if (boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === void 0) {
			logger.warn(`supermemory: fork skipped — parent ${parentSessionId} has no closed-turn boundary`);
			return;
		}
		const cut = boundary.openTurnStartSeq;
		const handle = await ctx.sessionPersistence.open(parentSessionId, "read");
		const { events } = await handle.read(0, cut);
		await handle.close();
		const sessionId = newId("fork");
		const created = await ctx.agents.create({
			sessionId,
			seed: events,
			inheritedEventCount: cut,
			meta: {
				cwd,
				isSeeded: true,
				parentSession: parentSessionId,
				...composition.presetId ? { agentPreset: composition.presetId } : {}
			},
			setup: compositionSetup(ctx, composition, logger, capabilities),
			...defaultModel ? { agentOptions: { ...defaultModel } } : {}
		});
		const branch = {
			agent: created.agent,
			dispose: () => created.dispose()
		};
		branchHandles.set(sessionId, branch);
		return {
			sessionId,
			handle: branch
		};
	} catch (error) {
		logger.warn(`supermemory: fork from ${parentSessionId} failed: ${String(error).slice(0, 200)}`);
		return;
	}
}
/** Release idle branch handles (decision D5: never before outbox is empty). */
function releasableBranches(store, now, idleReleaseMs) {
	const out = [];
	const dispatchBranch = /* @__PURE__ */ new Map();
	for (const [dispatchId, record] of store.dispatches.entries()) if (record.branchSessionId) dispatchBranch.set(dispatchId, record.branchSessionId);
	const blocked = /* @__PURE__ */ new Set();
	for (const [deliveryId, item] of store.outbox.entries()) {
		if (item.status !== "pending" && item.status !== "relayed") continue;
		const branch = item.dispatchId ? dispatchBranch.get(item.dispatchId) : void 0;
		if (branch) blocked.add(branch);
	}
	for (const [sessionId] of branchHandles) {
		if (blocked.has(sessionId)) continue;
		const member = findMember(store, sessionId);
		if (!member) continue;
		if (now - member.lastActiveAt < idleReleaseMs) continue;
		out.push(sessionId);
	}
	return out;
}
/**
* E: 保留分支会话——空闲分支只释放插件侧 handle（从 branchHandles 摘除），
* 绝不调用 handle.dispose()：宿主语义是停 loop、关闭写句柄、注销 agent，而分支
* 会话的持久日志与可恢复性必须留下（acquireBranch 的 live→resume 路径随时续接，
* memory_resume 也依赖它继续被中断的任务）。判定沿用 releasableBranches
* （D5：有未交付 outbox 的分支不释放）。
*/
function detachIdleBranches(store, now, idleReleaseMs, logger) {
	const detached = [];
	for (const sessionId of releasableBranches(store, now, idleReleaseMs)) if (branchHandles.delete(sessionId)) {
		detached.push(sessionId);
		logger.info(`supermemory: detached idle branch ${sessionId.slice(0, 13)}（会话保留，可续接）`);
	}
	return detached;
}
function findMember(store, sessionId) {
	for (const [, topicSet] of store.topicsets.entries()) {
		const member = topicSet.members.find((m) => m.sessionId === sessionId);
		if (member) return member;
	}
}
// src/observe.ts
/** Per-branch settle chain: concurrent settles (live turn/end + startup
* reconcile) must not both episode + relay the same dispatch, and a trigger that
* arrives while one is running must still get its own pass afterwards (dropping
* it would leave a later turn's dispatch unsettled until the next event). */
const settlingBranches = /* @__PURE__ */ new Map();
let sharedFactory$1;
/** Process-wide cached `createUserMessage` (loaded through the host anchor). */
async function messageFactory$2() {
	if (!sharedFactory$1) sharedFactory$1 = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return sharedFactory$1;
}
/** Read one session's durable log range through the persistence seam. */
async function coldRead$2(ctx, sessionId, afterSeq, untilSeq) {
	const handle = await ctx.sessionPersistence.open(sessionId, "read");
	try {
		const { events } = await handle.read(afterSeq + 1);
		const out = [];
		for (const event of events) {
			if (untilSeq !== void 0 && event.seq > untilSeq) break;
			out.push({
				type: event.type,
				seq: event.seq,
				time: event.time,
				data: event.data
			});
		}
		return out;
	} finally {
		await handle.close();
	}
}
/** True when a committed user message is this plugin's dispatch input. */
function isDispatchInput(message) {
	if (message.source?.kind !== "supermemory") return false;
	const form = message.source?.form;
	return form !== "recall" && form !== "notice";
}
/**
* Locate the dispatch's own input message and the first turn/end after it.
*
* Ownership is the CLAIMED user/message only. followup() durably appends an
* agent/inbox/spliced the moment it is called — even while the branch is
* mid-turn — so treating a splice as the input attributed the PREVIOUS turn's
* answer to this dispatch (and then lost the real answer). The host appends the
* claimed message as user/message at the start of the owning step
* (agent-loop agent.ts step()).
*/
function locateOwnership(events, startSeq) {
	let messageSeq;
	for (const event of events) {
		if (event.seq < startSeq) continue;
		if (event.type !== "user/message") continue;
		if (isDispatchInput(event.data)) {
			messageSeq = event.seq;
			break;
		}
	}
	if (messageSeq === void 0) return void 0;
	for (const event of events) {
		if (event.seq <= messageSeq) continue;
		if (event.type === "turn/end") return {
			messageSeq,
			turnEndSeq: event.seq,
			reason: event.data?.reason
		};
	}
}
/** `summary` is the memory-facing short form; the full answer lives in `result`. */
const EPISODE_SUMMARY_MAX = 400;
/** Rule-based episode from the branch's owned turn (no LLM in the loop). */
function buildEpisode(events, dispatchId, topicSetId, branchSessionId) {
	const timeStart = events[0]?.time ?? Date.now();
	const timeEnd = events[events.length - 1]?.time ?? timeStart;
	const assistantTexts = [];
	const decisions = [];
	const files = [];
	const toolNames = [];
	for (const event of events) if (event.type === "assistant/message") {
		const text = (event.data.message?.content ?? []).map((b) => b.type === "text" ? String(b.text ?? "") : "").filter(Boolean).join("\n").trim();
		if (text) assistantTexts.push(text);
	} else if (event.type === "tool/call") {
		const data = event.data;
		if (data.name) toolNames.push(data.name);
		const args = data.arguments;
		if (args?.file_path) files.push(args.file_path);
		if (args?.path) files.push(args.path);
	}
	const finalText = assistantTexts[assistantTexts.length - 1] ?? "";
	const summary = finalText.length > EPISODE_SUMMARY_MAX ? `${finalText.slice(0, EPISODE_SUMMARY_MAX)}…` : finalText;
	for (const name of new Set(toolNames)) decisions.push(`调用了 ${name}`);
	return {
		topicSetId,
		branchSessionId,
		timeStart,
		timeEnd,
		summary,
		result: finalText,
		decisions,
		files: [...new Set(files)].slice(0, 20),
		nextSteps: [],
		reqIds: [],
		sourceSessionId: branchSessionId,
		sourceSeqStart: events[0]?.seq ?? 0,
		sourceSeqEnd: events[events.length - 1]?.seq ?? 0
	};
}
/** The hub-facing relay text for one dispatch outcome. */
function relayText(dispatch, episode, failure, questions = []) {
	const head = `[supermemory-relay ${dispatch.branchSessionId}]`;
	const questionBlock = renderQuestionsBlock(questions);
	const tail = questionBlock ? `\n\n${questionBlock}` : "";
	if (failure) {
		const partialText = episodeResult(episode);
		const partial = partialText ? `\n已完成部分：${clipRelayResult(partialText, dispatch.branchSessionId)}` : "";
		return `${head}\n任务：${dispatch.task}\n结果：分支未成功完成（${failure}）。${partial}\n以上为失败事实，未伪装成答案。
如需继续该任务：memory_resume（无参查看清单，带 dispatchId 续跑）或 /memory resume。${tail}`;
	}
	const body = clipRelayResult(episodeResult(episode), dispatch.branchSessionId) || "（分支已完成，但未生成摘要）";
	return `${head}\n任务：${dispatch.task}\n分支结果：\n${body}${tail}`;
}
/** Attach observation + delivery; returns the effect disposer. */
function attachObserve(ctx, deps) {
	if (!deps.config.enabled) return () => {};
	const { store, logger } = deps;
	const off = ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		settleOpenDispatches(deps, String(session.id), event.seq).catch((error) => logger.warn("supermemory: settle failed: " + String(error).slice(0, 160)));
	});
	const offConfirm = ctx.on("session/event", (session, event) => {
		if (event.type !== "user/message") return;
		const message = event.data;
		const deliveryId = message.source?.deliveryId;
		if (!deliveryId || message.source?.kind !== "supermemory") return;
		const item = store.outbox.get(deliveryId);
		if (item && item.status !== "confirmed") store.outbox.update(deliveryId, (r) => ({
			...r,
			status: "confirmed",
			relayedAt: Date.now()
		})).then(() => logger.info(`supermemory: delivery ${deliveryId} confirmed in ${String(session.id).slice(0, 13)}`)).catch(() => {});
	});
	const lastBeat = /* @__PURE__ */ new Map();
	const openOf = (branchSessionId) => {
		const rows = [];
		for (const [dispatchId, record] of store.dispatches.entries()) {
			if (record.branchSessionId !== branchSessionId) continue;
			if (record.status === "delivered" || record.status === "failed" || record.status === "interrupted") continue;
			rows.push([dispatchId, record]);
		}
		return rows;
	};
	const offBeat = ctx.on("session/event", (session, _event) => {
		const branchSessionId = String(session.id);
		const now = Date.now();
		if (now - (lastBeat.get(branchSessionId) ?? 0) < 3e4) return;
		const open = openOf(branchSessionId);
		if (open.length === 0) return;
		lastBeat.set(branchSessionId, now);
		for (const [dispatchId] of open) store.dispatches.update(dispatchId, (r) => ({
			...r,
			lastActivityAt: now
		})).catch(() => {});
	});
	return () => {
		off();
		offConfirm();
		offBeat();
	};
}
/**
* Settle every open dispatch of one branch against its durable log. Called by
* the live `turn/end` listener (with that event's seq) and by startup
* reconciliation (with no bound) so a dispatch whose turn ended while the
* plugin was down still settles exactly once.
*/
async function settleOpenDispatches(deps, branchSessionId, turnEndSeq) {
	const inFlight = settlingBranches.get(branchSessionId);
	if (inFlight) await inFlight.catch(() => {});
	const run = settleBranch(deps, branchSessionId, turnEndSeq);
	settlingBranches.set(branchSessionId, run);
	try {
		await run;
	} finally {
		if (settlingBranches.get(branchSessionId) === run) settlingBranches.delete(branchSessionId);
	}
}
/** The settle body; runs under the per-branch lock above. */
async function settleBranch(deps, branchSessionId, turnEndSeq) {
	const { ctx, store, logger } = deps;
	const open = [];
	for (const [dispatchId, record] of store.dispatches.entries()) {
		if (record.branchSessionId !== branchSessionId) continue;
		if (record.status === "delivered" || record.status === "failed" || record.status === "interrupted") continue;
		if (turnEndSeq !== void 0 && record.startSeq >= turnEndSeq) continue;
		open.push([dispatchId, record]);
	}
	if (open.length === 0) return;
	const events = await coldRead$2(ctx, branchSessionId, -1, turnEndSeq);
	const touchedGroups = /* @__PURE__ */ new Set();
	for (const [dispatchId, record] of open) try {
		const ownership = locateOwnership(events, record.startSeq);
		if (!ownership) {
			logger.info(`supermemory: dispatch ${dispatchId} has no owned input yet; waiting`);
			continue;
		}
		if (record.groupId) touchedGroups.add(record.groupId);
		if (turnEndSeq !== void 0 && ownership.turnEndSeq > turnEndSeq) continue;
		const owned = events.filter((e) => e.seq > ownership.messageSeq && e.seq <= ownership.turnEndSeq);
		const reason = ownership.reason?.kind ?? "error";
		if (reason === "completed" || reason === "max-tokens" && deps.config.maxTokensPolicy === "deliver-partial") {
			const episode = buildEpisode(owned, dispatchId, record.topicSetId ?? "", branchSessionId);
			const episodeId = newId("epi");
			await store.episodes.put(episodeId, episode);
			if (!record.groupId) await deliver(deps, {
				dispatchId,
				record,
				text: relayText(record, episode, void 0, openQuestionsOfDispatch(store, dispatchId))
			});
			await store.dispatches.update(dispatchId, (r) => ({
				...r,
				status: "delivered",
				turnEndReason: reason,
				updatedAt: Date.now()
			}));
			await updateMember(store, record.topicSetId ?? "", branchSessionId, { status: "idle" });
			logger.info(`supermemory: dispatch ${dispatchId} completed → episode ${episodeId}${record.groupId ? " (group member)" : ""}`);
		} else {
			const failure = reason === "max-tokens" ? "输出达到上限被截断" : `分支终态 ${reason}`;
			const partial = owned.length > 0 ? buildEpisode(owned, dispatchId, record.topicSetId ?? "", branchSessionId) : void 0;
			if (!record.groupId) await deliver(deps, {
				dispatchId,
				record,
				text: relayText(record, partial, failure, openQuestionsOfDispatch(store, dispatchId))
			});
			await store.dispatches.update(dispatchId, (r) => ({
				...r,
				status: "failed",
				turnEndReason: reason,
				updatedAt: Date.now()
			}));
			await updateMember(store, record.topicSetId ?? "", branchSessionId, { status: "idle" });
			logger.info(`supermemory: dispatch ${dispatchId} failed (${reason})`);
		}
	} catch (error) {
		logger.warn(`supermemory: observe ${dispatchId} failed: ${String(error).slice(0, 200)}`);
	}
	for (const groupId of touchedGroups) try {
		if (!groupComplete(store, groupId) || groupRelayExists(store, groupId)) continue;
		const text = groupRelayText(store, groupId, groupEpisodeSummaries(store, groupId));
		const members = groupMembers(store, groupId);
		const hubSessionId = members[0]?.[1].hubSessionId;
		if (!hubSessionId) continue;
		await deliver(deps, {
			dispatchId: groupId,
			record: { hubSessionId },
			text,
			groupId
		});
		logger.info(`supermemory: group ${groupId} relayed (${members.length} members)`);
	} catch (error) {
		logger.warn(`supermemory: group relay ${groupId} failed: ${String(error).slice(0, 200)}`);
	}
}
/** Enqueue + send one relay delivery to the hub (at-least-once, idempotent). */
async function deliver(deps, input) {
	const { ctx, store, logger } = deps;
	const deliveryId = input.deliveryId ?? (input.groupId ? "dlv-grp-" + input.groupId : "dlv-" + input.dispatchId);
	await store.outbox.put(deliveryId, {
		dispatchId: input.groupId ? void 0 : input.dispatchId || void 0,
		groupId: input.groupId,
		kind: input.groupId ? "group" : "single",
		payload: input.text,
		status: "pending",
		enqueuedAt: Date.now()
	});
	const hub = ctx.agents.get(input.record.hubSessionId);
	if (!hub) {
		logger.info(`supermemory: hub ${input.record.hubSessionId.slice(0, 13)} not live; delivery ${deliveryId} stays pending`);
		return;
	}
	try {
		const factory = await messageFactory$2();
		hub.followup(factory({
			content: [{
				type: "text",
				text: input.text
			}],
			source: {
				kind: "supermemory",
				form: "relay",
				deliveryId
			}
		}));
		await store.outbox.update(deliveryId, (r) => ({
			...r,
			status: "relayed",
			relayedAt: Date.now()
		}));
		logger.info(`supermemory: relayed ${deliveryId} to hub`);
	} catch (error) {
		logger.warn(`supermemory: relay ${deliveryId} failed: ${String(error).slice(0, 160)}`);
	}
}
/**
* Delivery seam for non-settle relays (the startup interrupted notice, resume.ts):
* same at-least-once outbox contract with a caller-supplied stable deliveryId.
*/
async function deliverRelay(deps, input) {
	await deliver(deps, {
		dispatchId: input.dispatchId ?? "",
		record: { hubSessionId: input.hubSessionId },
		text: input.text,
		deliveryId: input.deliveryId
	});
}
/**
* Self-healing delivery pass (the at-least-once contract).
*
* Two windows used to strand results permanently:
*   - a group whose members ALL became terminal right before a crash/reload
*     never got its single relay (the live path only scans groups touched by
*     the current settle, and startup reconcile returned early when no
*     dispatch was open);
*   - an outbox row whose hub was not live stayed pending forever, because the
*     only retry attempt was one startup pass.
* Called from startup reconciliation and from the periodic sweep in apply().
*/
async function flushObserve(deps) {
	const { ctx, store, logger } = deps;
	const groupIds = /* @__PURE__ */ new Set();
	for (const [, record] of store.dispatches.entries()) if (record.groupId) groupIds.add(record.groupId);
	for (const groupId of groupIds) try {
		if (!groupComplete(store, groupId) || groupRelayExists(store, groupId)) continue;
		const hubSessionId = groupMembers(store, groupId)[0]?.[1].hubSessionId;
		if (!hubSessionId) continue;
		await deliver(deps, {
			dispatchId: groupId,
			record: { hubSessionId },
			text: groupRelayText(store, groupId, groupEpisodeSummaries(store, groupId)),
			groupId
		});
		logger.info("supermemory: group " + groupId + " relayed by flush");
	} catch (error) {
		logger.warn("supermemory: group flush " + groupId + " failed: " + String(error).slice(0, 160));
	}
	for (const [deliveryId, item] of [...store.outbox.entries()]) {
		if (item.status !== "pending") continue;
		const hubSessionId = item.dispatchId ? store.dispatches.get(item.dispatchId)?.hubSessionId : item.groupId ? groupMembers(store, item.groupId)[0]?.[1].hubSessionId : void 0;
		if (!hubSessionId) continue;
		const hub = ctx.agents.get(hubSessionId);
		if (!hub?.followup) continue;
		if ([...hub.inbox?.nextTurn ?? [], ...hub.inbox?.nextStep ?? []].some((message) => message.source?.deliveryId === deliveryId)) continue;
		try {
			const factory = await messageFactory$2();
			hub.followup(factory({
				content: [{
					type: "text",
					text: item.payload
				}],
				source: {
					kind: "supermemory",
					form: "relay",
					deliveryId
				}
			}));
			await store.outbox.update(deliveryId, (r) => ({
				...r,
				status: "relayed",
				relayedAt: Date.now()
			}));
			logger.info("supermemory: flushed pending delivery " + deliveryId);
		} catch (error) {
			logger.warn("supermemory: flush delivery " + deliveryId + " failed: " + String(error).slice(0, 160));
		}
	}
}
/**
* D: turn silence into a relay.
*
* A branch that is stopped / crashes / is unloaded never emits `turn/end`, so the
* live settle path can never fire and the hub waits forever. This pass runs from
* the periodic sweep, from plugin disposal and from startup reconciliation:
*  - an open dispatch whose heartbeat is older than `timeoutMs` is marked
*    `interrupted` and relayed once (idempotent through the outbox key);
*  - a terminal dispatch that never reached the hub (crash between settle and
*    deliver) is backfilled with the same one-shot relay.
* Group members are skipped: their single relay belongs to the group.
*/
async function settleInterruptedDispatches(deps, options) {
	const { store, logger } = deps;
	const now = options.now ?? Date.now();
	const settled = [];
	const touchedGroups = /* @__PURE__ */ new Set();
	for (const [dispatchId, record] of [...store.dispatches.entries()]) {
		if (record.status === "delivered") continue;
		const deliveryId = "dlv-" + dispatchId;
		if (store.outbox.get(deliveryId)) continue;
		const stale = now - (record.lastActivityAt ?? record.updatedAt) >= options.timeoutMs;
		const terminal = record.status === "failed" || record.status === "interrupted";
		if (!terminal) {
			if (options.terminalOnly) continue;
			if (!stale) continue;
		}
		const reason = terminal ? `分支中断（${record.turnEndReason ? "终态 " + record.turnEndReason : options.reason ?? "未结算"}）` : `分支中断（${options.reason ?? "超时未结算"}）`;
		if (record.groupId) touchedGroups.add(record.groupId);
		try {
			const partial = await partialSummary(deps, record);
			if (!record.groupId) try {
				await deliver(deps, {
					dispatchId,
					record,
					text: relayText(record, partial, reason, openQuestionsOfDispatch(store, dispatchId))
				});
			} catch (error) {
				logger.warn(`supermemory: interrupt relay ${dispatchId} deferred: ${String(error).slice(0, 160)}`);
			}
			await store.dispatches.update(dispatchId, (r) => ({
				...r,
				status: "interrupted",
				turnEndReason: r.turnEndReason ?? options.reason ?? "silent",
				updatedAt: Date.now()
			}));
			settled.push(dispatchId);
			logger.info(`supermemory: dispatch ${dispatchId} interrupted (${reason})`);
		} catch (error) {
			logger.warn(`supermemory: interrupt settle ${dispatchId} failed: ${String(error).slice(0, 160)}`);
		}
	}
	for (const groupId of touchedGroups) try {
		if (!groupComplete(store, groupId) || groupRelayExists(store, groupId)) continue;
		const members = groupMembers(store, groupId);
		const hubSessionId = members[0]?.[1].hubSessionId;
		if (!hubSessionId) continue;
		await deliver(deps, {
			dispatchId: groupId,
			record: { hubSessionId },
			text: groupRelayText(store, groupId, groupEpisodeSummaries(store, groupId)),
			groupId
		});
		logger.info(`supermemory: group ${groupId} relayed by interrupt sweep (${members.length} members)`);
	} catch (error) {
		logger.warn(`supermemory: interrupt group relay ${groupId} failed: ${String(error).slice(0, 160)}`);
	}
	return settled;
}
/** Best-effort partial episode for an interrupted branch (never blocks a relay). */
async function partialSummary(deps, record) {
	if (!deps.ctx.sessionPersistence || !record.branchSessionId) return void 0;
	try {
		const events = await coldRead$2(deps.ctx, record.branchSessionId, record.startSeq);
		if (events.length === 0) return void 0;
		return buildEpisode(events, record.branchSessionId, record.topicSetId ?? "", record.branchSessionId);
	} catch {
		return;
	}
}
// src/resume.ts
/**
* turnEndReason 中「被外力打断」的签名（区别于 max-tokens / dispatch-error 等
* 自主失败）：分支终态 aborted（重载/禁用杀掉在途 turn）、branch-died（重启后
* 分支消失）、中断巡检的 silent/重载/卸载/退出 文案。
*/
const CUT_OFF_REASON = /abort|branch-died|interrupt|silent|重载|卸载|退出/i;
/** True when a dispatch was cut off by an interruption (not an honest failure). */
function isCutOffDispatch(record) {
	if (record.status === "interrupted") return true;
	if (record.status === "failed") return CUT_OFF_REASON.test(record.turnEndReason ?? "");
	return false;
}
/** 已完成部分摘要：从中断回执（outbox dlv-<dispatchId>）里摘出。 */
function partialOfOutbox(store, dispatchId) {
	const payload = store.outbox.get("dlv-" + dispatchId)?.payload ?? "";
	const at = payload.indexOf("已完成部分：");
	if (at < 0) return "";
	return (payload.slice(at + 6).split("\n")[0] ?? "").trim();
}
/** 分支视角（成员标题 → 任务摘要）。 */
function viewOf(store, dispatchId, record) {
	const topicSet = record.topicSetId ? store.topicsets.get(record.topicSetId) : void 0;
	const member = topicSet?.members.find((row) => row.sessionId === record.branchSessionId);
	const view = {
		dispatchId,
		task: record.task,
		branchSessionId: record.branchSessionId,
		branchTitle: (member?.title ?? "").trim() || taskExcerpt(record.task, 20),
		hubSessionId: record.hubSessionId,
		status: record.status,
		interruptedAt: record.lastActivityAt ?? record.updatedAt,
		partial: partialOfOutbox(store, dispatchId)
	};
	if (record.topicSetId) view.topicSetId = record.topicSetId;
	if (topicSet) view.topicSetTitle = topicSet.title;
	if (record.groupId) view.groupId = record.groupId;
	if (record.resumeOf) view.resumeOf = record.resumeOf;
	return view;
}
/**
* 扫描台账，列出被中断且未终态完成的派发（需求：恢复后自动检查）。
*
* 收录两类「可证明被打断」的行：status=interrupted（静默巡检/dispose 兜底标记），
* 以及 failed 且终态原因是打断签名（重载杀掉在途 turn → aborted、重启后分支消失
* → branch-died）。已交付、自主失败（max-tokens/派发异常）与已被续跑接续的行
* （resumedBy 指向一个仍未终态的派发）都不出现——它们不是待决项。
*/
function listInterruptedDispatches(store, options = {}) {
	const out = [];
	for (const [dispatchId, record] of store.dispatches.entries()) {
		if (!record.branchSessionId) continue;
		if (!isCutOffDispatch(record)) continue;
		const topicSet = record.topicSetId ? store.topicsets.get(record.topicSetId) : void 0;
		if (options.workspaceKey && topicSet?.workspaceKey !== options.workspaceKey) continue;
		if (record.resumedBy) {
			const next = store.dispatches.get(record.resumedBy);
			if (next && isOpenDispatch(next)) continue;
		}
		out.push(viewOf(store, dispatchId, record));
	}
	out.sort((a, b) => b.interruptedAt - a.interruptedAt);
	return out;
}
/** 清单的用户可读文本（工具 message / 命令输出共用）。 */
function renderInterruptedList(views, now = Date.now()) {
	if (views.length === 0) return "没有被中断的任务。";
	const lines = ["被中断的任务清单（" + views.length + "，分支会话已保留，可选择继续）："];
	views.forEach((view, index) => {
		lines.push(index + 1 + ". " + view.dispatchId + " · 话题集「" + (view.topicSetTitle ?? "（未命名）") + "」 · 任务：" + taskExcerpt(view.task, 40) + " · 分支 " + view.branchSessionId + "（" + view.branchTitle + "） · 中断于 " + relativeAgo(view.interruptedAt, now) + (view.groupId ? " · 原属并行组 " + view.groupId : "") + (view.resumeOf ? " · 续跑自 " + view.resumeOf : ""));
		if (view.partial) lines.push("   已完成部分：" + view.partial.slice(0, 160));
	});
	lines.push("用 memory_resume 带 dispatchId 续跑（可多选），或 /memory resume <dispatchId>。");
	return lines.join("\n");
}
/** Process-cached createUserMessage (loaded through the host anchor). */
let sharedFactory;
async function messageFactory$1() {
	if (!sharedFactory) sharedFactory = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return sharedFactory;
}
/** Read one session's durable log range through the persistence seam. */
async function coldRead$1(ctx, sessionId, afterSeq) {
	const handle = await ctx.sessionPersistence.open(sessionId, "read");
	try {
		const { events } = await handle.read(afterSeq + 1);
		return events;
	} finally {
		await handle.close();
	}
}
/** Last assistant text of a log range (the branch's freshest work-in-progress). */
function lastAssistantText(events) {
	let text = "";
	for (const event of events) {
		if (event.type !== "assistant/message") continue;
		const block = (event.data.message?.content ?? []).map((part) => part.type === "text" ? String(part.text ?? "") : "").filter(Boolean).join("\n").trim();
		if (block) text = block;
	}
	return text;
}
/**
* 续跑消息里的「已完成部分」：优先冷读分支日志（最新），失败时退回中断回执摘要。
*/
async function partialOfBranch(deps, dispatchId, record) {
	if (deps.ctx.sessionPersistence && record.branchSessionId) try {
		const text = lastAssistantText(await coldRead$1(deps.ctx, record.branchSessionId, record.startSeq));
		if (text) return text.length > 1500 ? text.slice(0, 1500) + "…" : text;
	} catch {}
	return partialOfOutbox(deps.store, dispatchId);
}
/** The wake message of a same-session continuation. */
function resumeMessage(originalId, record, partial) {
	const group = record.groupId ? "\n原任务来自并行组 " + record.groupId + "（组汇总已另行交付），本次为单独续跑。" : "";
	return "[supermemory-resume " + originalId + "]\n本消息是被中断任务的续跑（原派发 " + originalId + "，原分支 " + record.branchSessionId + "）。" + group + "\n原始任务：" + record.task + "\n已完成部分：" + (partial || "（无记录）") + "\n请先核对以上已完成部分与分支日志中已有的工作，再继续未完成的事项；不要从头重复已完成的工作。\n遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。";
}
/** The re-dispatched task text (original task + continuation context). */
function redispatchTask(record, originalId, partial) {
	const group = record.groupId ? "（原任务来自并行组 " + record.groupId + "，组汇总已另行交付）" : "";
	return record.task + "\n\n【续跑上下文" + group + "】本任务此前被中断（原派发 " + originalId + "，原分支 " + record.branchSessionId + "，原因：插件重载/关闭或 DSH 退出；分支会话已保留但无法续接）。已完成部分：" + (partial || "（无记录）") + "。请先核对已完成部分再继续未完成的工作，不要从头重复。遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。";
}
/** 台账双向关联：新派发 resumeOf=原派发，原派发 resumedBy=新派发。 */
async function linkResume(store, originalId, newDispatchId) {
	const now = Date.now();
	if (store.dispatches.get(newDispatchId)) await store.dispatches.update(newDispatchId, (row) => ({
		...row,
		resumeOf: originalId,
		updatedAt: now
	}));
	await store.dispatches.update(originalId, (row) => ({
		...row,
		resumedBy: newDispatchId,
		updatedAt: now
	}));
}
/**
* 续跑一个被中断的派发（需求：由用户决定哪些任务需要继续）。
*
* 顺序：优先续接被保留的分支会话（live handle → agents.get → agents.resume），
* 续投「原始任务 + 已完成部分」；三条路都拿不到会话时才带同样上下文重派发到
* 新分支。任何路径都会产生一个新派发行并通过 resumeOf/resumedBy 关联原派发，
* 续跑完成后由既有 relay 通道把结果送回调用方（中枢）会话。
*/
async function resumeDispatch(deps, dispatchId, options = {}) {
	const { ctx, store, logger } = deps;
	const record = store.dispatches.get(dispatchId);
	if (!record) return {
		status: "error",
		dispatchId,
		message: "派发 " + dispatchId + " 不存在。"
	};
	if (!record.branchSessionId) return {
		status: "error",
		dispatchId,
		message: "派发 " + dispatchId + " 没有分支会话记录（派发即失败），无需续跑。"
	};
	if (record.status === "delivered") return {
		status: "error",
		dispatchId,
		message: "派发 " + dispatchId + " 已交付，无需续跑。"
	};
	if (!isCutOffDispatch(record)) {
		if (isOpenDispatch(record)) return {
			status: "error",
			dispatchId,
			message: "派发 " + dispatchId + " 仍在进行中（" + record.status + "），无需续跑；若确认分支已死，等待中断巡检（默认 15 分钟）标记后再续跑。"
		};
		return {
			status: "error",
			dispatchId,
			message: "派发 " + dispatchId + "（" + record.status + "）不是被中断的任务。"
		};
	}
	if (record.resumedBy) {
		const next = store.dispatches.get(record.resumedBy);
		if (next && isOpenDispatch(next)) return {
			status: "error",
			dispatchId,
			message: "该任务已有续跑在进行（" + record.resumedBy + "）。"
		};
	}
	const hubSessionId = String(options.exec?.agent?.id ?? record.hubSessionId);
	if (!hubSessionId) return {
		status: "error",
		dispatchId,
		message: "无法确定中枢会话（续跑结果无处回送）。"
	};
	const capabilities = resolveCapabilities(options.capabilities);
	const partial = await partialOfBranch(deps, dispatchId, record);
	let agent = branchHandles.get(record.branchSessionId)?.agent ?? ctx.agents.get(record.branchSessionId);
	if (!agent) try {
		const composition = hubComposition(ctx, options.exec?.agent);
		const resumed = await ctx.agents.resume({
			resumeSessionId: record.branchSessionId,
			setup: compositionSetup(ctx, composition, logger, capabilities)
		});
		agent = resumed.agent;
		branchHandles.set(record.branchSessionId, {
			agent: resumed.agent,
			dispose: () => resumed.dispose()
		});
		logger.info("supermemory: resume " + dispatchId + ": reconnected preserved branch " + record.branchSessionId.slice(0, 20));
	} catch (error) {
		logger.warn("supermemory: resume " + dispatchId + ": branch " + record.branchSessionId.slice(0, 13) + " unrecoverable (" + String(error).slice(0, 140) + "); re-dispatching");
	}
	if (agent) {
		const newDispatchId = newId("dsp");
		const now = Date.now();
		const seqBefore = ctx.sessions.get(record.branchSessionId)?.seq ?? 0;
		await store.dispatches.put(newDispatchId, {
			topicSetId: record.topicSetId,
			branchSessionId: record.branchSessionId,
			task: record.task,
			hubSessionId,
			startSeq: seqBefore,
			status: "dispatched",
			resumeOf: dispatchId,
			createdAt: now,
			updatedAt: now
		});
		await store.dispatches.update(dispatchId, (row) => ({
			...row,
			resumedBy: newDispatchId,
			updatedAt: now
		}));
		if (record.topicSetId) try {
			await updateMember(store, record.topicSetId, record.branchSessionId, { status: "live" });
		} catch {}
		try {
			const factory = options.createMessage ?? await messageFactory$1();
			agent.followup(factory({
				content: [{
					type: "text",
					text: resumeMessage(dispatchId, record, partial)
				}],
				source: {
					kind: "supermemory",
					form: "instructions"
				}
			}));
			if ((ctx.sessions.get(record.branchSessionId)?.seq ?? seqBefore) > seqBefore) await store.dispatches.update(newDispatchId, (row) => ({
				...row,
				startSeq: seqBefore,
				updatedAt: Date.now()
			}));
			logger.info("supermemory: resume " + dispatchId + " → " + newDispatchId + " (continued on " + record.branchSessionId.slice(0, 13) + ")");
			return {
				status: "resumed",
				dispatchId,
				mode: "continued",
				newDispatchId,
				branchSessionId: record.branchSessionId,
				message: "已续接被保留的分支 " + record.branchSessionId + " 继续任务（新派发 " + newDispatchId + "）；完成后结果会主动送回本会话。"
			};
		} catch (error) {
			await store.dispatches.update(newDispatchId, (row) => ({
				...row,
				status: "failed",
				turnEndReason: "resume-wake-failed",
				updatedAt: Date.now()
			}));
			logger.warn("supermemory: resume " + dispatchId + " followup threw: " + String(error).slice(0, 200));
			return {
				status: "error",
				dispatchId,
				newDispatchId,
				message: "分支唤醒失败：" + String(error).slice(0, 200)
			};
		}
	}
	const redispatch = options.redispatch ?? ((task) => runDispatch({
		ctx,
		store,
		logger
	}, {
		...record.topicSetId ? { topicSetId: record.topicSetId } : {},
		task,
		mode: "new",
		capabilities: options.capabilities
	}, options.exec ?? {}));
	try {
		const result = await redispatch(redispatchTask(record, dispatchId, partial));
		if (result.status !== "dispatched" || !result.dispatchId) return {
			status: "error",
			dispatchId,
			message: "重派发失败：" + (result.message ?? "未知原因")
		};
		await linkResume(store, dispatchId, result.dispatchId);
		logger.info("supermemory: resume " + dispatchId + " → " + result.dispatchId + " (re-dispatched to a fresh branch)");
		return {
			status: "resumed",
			dispatchId,
			mode: "redispatched",
			newDispatchId: result.dispatchId,
			...result.branchSessionId ? { branchSessionId: result.branchSessionId } : {},
			message: "原分支无法恢复，已带「原始任务 + 已完成部分」上下文重派发到新分支（新派发 " + result.dispatchId + "）；完成后结果会主动送回本会话。"
		};
	} catch (error) {
		logger.warn("supermemory: resume " + dispatchId + " re-dispatch threw: " + String(error).slice(0, 200));
		return {
			status: "error",
			dispatchId,
			message: "重派发异常：" + String(error).slice(0, 200)
		};
	}
}
/**
* 启动/巡检时的中断清单主动触达（复用 observe 的 at-least-once relay 通道）。
*
* 每个 hub 一条稳定幂等键（dlv-resume-<hub>，outbox 行挂首个中断派发 id 以便
* flushObserve 解析 hub）：hub 在线立即投递，不在线则 pending 自愈重投。签名
* 去重（state.signatures）保证同一清单不重复刷屏，清单变化才再通知。
*/
async function notifyInterruptedDispatches(deps, options = {}) {
	const { ctx, store, logger } = deps;
	const now = options.now ?? Date.now();
	const views = listInterruptedDispatches(store, { now });
	const byHub = /* @__PURE__ */ new Map();
	for (const view of views) {
		const bucket = byHub.get(view.hubSessionId) ?? [];
		bucket.push(view);
		byHub.set(view.hubSessionId, bucket);
	}
	let notified = 0;
	for (const [hubSessionId, rows] of byHub) {
		const signature = rows.map((row) => row.dispatchId + "@" + row.interruptedAt).join("|");
		if (options.state) {
			if (options.state.signatures.get(hubSessionId) === signature) continue;
			options.state.signatures.set(hubSessionId, signature);
		}
		const text = "[SuperMemory] 检测到 " + rows.length + " 个被中断的任务（插件重载/关闭或 DSH 退出导致；分支会话已保留，可选择继续）：\n" + rows.map((row, index) => index + 1 + ". " + row.dispatchId + " · 话题集「" + (row.topicSetTitle ?? "（未命名）") + "」 · 任务：" + taskExcerpt(row.task, 40) + " · 分支 " + row.branchSessionId + " · 中断于 " + relativeAgo(row.interruptedAt, now) + (row.partial ? "\n   已完成部分：" + row.partial.slice(0, 120) : "")).join("\n") + "\n\n用 memory_resume 查看并续跑（无参=清单；带 dispatchId=继续指定任务，可多选），或 /memory resume <dispatchId>。";
		try {
			await deliverRelay(deps, {
				deliveryId: "dlv-resume-" + hubSessionId,
				dispatchId: rows[0].dispatchId,
				hubSessionId,
				text
			});
			notified += 1;
			logger.info("supermemory: interrupted notice sent for hub " + hubSessionId.slice(0, 13) + " (" + rows.length + " task(s))");
		} catch (error) {
			logger.warn("supermemory: interrupted notice for " + hubSessionId.slice(0, 13) + " failed: " + String(error).slice(0, 160));
		}
	}
	return notified;
}
/** The legacy dispatch auto-create wrote title = firstTask.slice(0, 12). */
const LEGACY_TOPIC_TITLE_CHARS = 12;
/** The legacy every-other-path slice: title.slice(0, 40), no ellipsis. */
const LEGACY_TITLE_SLICE_CHARS = 40;
/**
* The auto-creating dispatch is recorded within seconds of the set's
* creation; a much later dispatch did NOT create the set (its title came
* from somewhere else, so that task text is not the title's source).
*/
const AUTOCREATE_GAP_MS = 6e5;
/** The meta-table row key of the migration marker. */
const MARKER_KEY = "titles";
function emptyPlan() {
	return {
		topicSets: [],
		members: [],
		unrecoverable: [],
		topicSetsTotal: 0,
		membersTotal: 0
	};
}
/** The legacy 12-character slice of a task, exactly as the old code cut it. */
function legacyTopicSlice(task) {
	if (task === void 0) return void 0;
	return String(task ?? "").trim().slice(0, LEGACY_TOPIC_TITLE_CHARS);
}
/** Earliest dispatch row (creation order) matching one predicate. */
function earliestDispatch(rows, match) {
	let best;
	for (const row of rows) {
		if (!match(row)) continue;
		if (!best || (row.createdAt || 0) < (best.createdAt || 0) || (row.createdAt || 0) === (best.createdAt || 0) && row.id < best.id) best = row;
	}
	return best;
}
/**
* Compute the repair plan without writing anything. Pure over the store's
* topicsets + dispatches tables, so it is unit-testable with a fake store.
*/
function planTitlesMigration(store) {
	const plan = emptyPlan();
	const rows = [...store.dispatches.entries()].map(([id, row]) => ({
		id,
		...row
	}));
	const refreshedTopicTitles = /* @__PURE__ */ new Map();
	for (const [topicSetId, topicSet] of store.topicsets.entries()) {
		plan.topicSetsTotal += 1;
		const first = earliestDispatch(rows, (row) => row.topicSetId === topicSetId);
		const legacy = legacyTopicSlice(first?.task);
		const title = String(topicSet.title ?? "");
		if (!!first && title === legacy && legacy !== void 0 && legacy.length < String(first.task ?? "").trim().length && first) {
			const to = clipEllipsis(firstLine(cleanTitleText(first.task)), 60);
			if (to && to !== title) {
				plan.topicSets.push({
					topicSetId,
					from: title,
					to,
					source: "dispatch-task"
				});
				refreshedTopicTitles.set(topicSetId, to);
				continue;
			}
		}
		const withinGap = !!first && Math.abs((first.createdAt || 0) - (topicSet.createdAt || 0)) <= AUTOCREATE_GAP_MS;
		if (Array.from(title).length === LEGACY_TOPIC_TITLE_CHARS && !withinGap) plan.unrecoverable.push({
			topicSetId,
			title,
			reason: "疑似被旧「派发自动创建 slice(0,12)」截断，但创建它的派发记录不在台账，无源文本可恢复"
		});
		else if (Array.from(title).length === LEGACY_TITLE_SLICE_CHARS && !withinGap) plan.unrecoverable.push({
			topicSetId,
			title,
			reason: "疑似被旧「slice(0,40)」截断（/memory new、面板、工具或管理台路径），原始完整标题无留存，不可恢复"
		});
	}
	for (const [topicSetId, topicSet] of store.topicsets.entries()) {
		for (const member of topicSet.members) plan.membersTotal += 1;
		const topicTitle = refreshedTopicTitles.get(topicSetId) ?? String(topicSet.title ?? "");
		const oldTopicTitle = String(topicSet.title ?? "");
		const members = topicSet.members;
		const taken = /* @__PURE__ */ new Set();
		for (const member of members) {
			const task = earliestDispatch(rows, (row) => row.branchSessionId === member.sessionId)?.task;
			const topicDerived = !task && member.title.trim() === oldTopicTitle && topicTitle !== oldTopicTitle;
			if (!task && !topicDerived && member.title.trim()) taken.add(member.title.trim());
		}
		for (const member of members) {
			const from = String(member.title ?? "");
			const task = earliestDispatch(rows, (row) => row.branchSessionId === member.sessionId)?.task;
			if (task) {
				const to = sessionTitleFor(topicTitle, task, taken);
				taken.add(to);
				if (to !== from) plan.members.push({
					topicSetId,
					sessionId: member.sessionId,
					from,
					to,
					source: "dispatch-task"
				});
				continue;
			}
			if (from.trim() === oldTopicTitle && topicTitle !== oldTopicTitle) {
				const to = sessionTitleFor(topicTitle, "", taken);
				taken.add(to);
				if (to !== from) plan.members.push({
					topicSetId,
					sessionId: member.sessionId,
					from,
					to,
					source: "topic-title"
				});
				continue;
			}
			if (!from.trim()) continue;
			if (!from.includes(" · ") && Array.from(from).length === 16) plan.unrecoverable.push({
				topicSetId,
				sessionId: member.sessionId,
				title: from,
				reason: "疑似旧「任务前 16 字」片段标题，但该分支无派发记录，无源文本可恢复"
			});
		}
	}
	return plan;
}
/** Write the plan's store rows (topic-set titles, then member titles). */
async function applyPlanToStore(store, plan) {
	const now = Date.now();
	for (const item of plan.topicSets) await store.topicsets.update(item.topicSetId, (record) => record && record.title !== item.to ? {
		...record,
		title: item.to,
		updatedAt: now
	} : record).catch(() => {});
	for (const item of plan.members) await store.topicsets.update(item.topicSetId, (record) => {
		if (!record) return record;
		if (record.members.some((m) => m.sessionId === item.sessionId && m.title === item.to)) return record;
		return {
			...record,
			members: record.members.map((m) => m.sessionId === item.sessionId ? {
				...m,
				title: item.to
			} : m),
			updatedAt: now
		};
	}).catch(() => {});
}
/**
* Apply the plan's member titles to the HOST sessions. A session whose live
* host title was changed by somebody else (user rename, another plugin) is
* skipped rather than overwritten.
*/
async function applyPlanToHost(ctx, plan, logger) {
	let renamed = 0;
	let skipped = 0;
	for (const item of plan.members) try {
		const current = currentSessionTitle(ctx, item.sessionId);
		if (current && current !== item.from) {
			skipped += 1;
			logger.info("supermemory: title migration skipped " + item.sessionId + " — the host title was renamed by somebody else");
			continue;
		}
		const outcome = applySessionTitle(ctx, item.sessionId, item.to, logger, { force: true });
		if (outcome === "host" || outcome === "fallback") renamed += 1;
	} catch (error) {
		logger.warn("supermemory: title migration host apply failed for " + item.sessionId + ": " + String(error).slice(0, 160));
	}
	return {
		renamed,
		skipped
	};
}
/** The persisted migration marker (undefined when never run). */
async function titlesMigrationMarker(store) {
	return store.meta?.get(MARKER_KEY);
}
/** Record a successful run so a restart does not rescan. */
async function writeTitlesMigrationMarker(store) {
	await store.meta?.put(MARKER_KEY, {
		titlesMigratedAt: Date.now(),
		titlesMigrationVersion: 1
	});
}
/**
* Run (or preview) the repair. Startup calls it with no options (marker-
* guarded); the /memory command calls it with ignoreMarker so a manual
* re-scan is always possible, and dryRun to preview without writing.
*/
async function migrateTruncatedTitles(deps, options = {}) {
	const { ctx, store, logger } = deps;
	const zeros = {
		topicSets: 0,
		members: 0,
		hostRenamed: 0,
		hostSkipped: 0
	};
	if (!options.ignoreMarker) {
		const marker = await titlesMigrationMarker(store);
		if (marker && (marker.titlesMigrationVersion ?? 0) >= 1) return {
			...emptyPlan(),
			status: "already-done",
			applied: zeros
		};
	}
	const plan = planTitlesMigration(store);
	if (options.dryRun) return {
		...plan,
		status: "planned",
		applied: zeros
	};
	await applyPlanToStore(store, plan);
	const host = await applyPlanToHost(ctx, plan, logger);
	await writeTitlesMigrationMarker(store);
	logger.info("supermemory: title migration applied — topic sets " + plan.topicSets.length + ", members " + plan.members.length + " (host renamed " + host.renamed + ", skipped " + host.skipped + ")");
	return {
		...plan,
		status: "applied",
		applied: {
			topicSets: plan.topicSets.length,
			members: plan.members.length,
			hostRenamed: host.renamed,
			hostSkipped: host.skipped
		}
	};
}
/** Human-readable report for the /memory command. */
function renderTitlesMigrationReport(result) {
	const lines = ["标题补正刷新（" + (result.status === "applied" ? "已执行并写库" : result.status === "already-done" ? "迁移标记已存在，未重扫（内容幂等，手动重扫也找不到待刷标题）" : "预演（未写库）") + "）："];
	lines.push("- 话题集标题：存量 " + result.topicSetsTotal + " 条，本次刷新 " + result.topicSets.length + " 条");
	for (const item of result.topicSets) lines.push("  · 「" + item.from + "」→「" + item.to + "」");
	lines.push("- 分支成员标题：存量 " + result.membersTotal + " 条，本次刷新 " + result.members.length + " 条");
	for (const item of result.members) lines.push("  · 「" + item.from + "」→「" + item.to + "」");
	if (result.unrecoverable.length > 0) {
		lines.push("- 不可恢复（保持不动）" + result.unrecoverable.length + " 条：");
		for (const item of result.unrecoverable) {
			const who = item.sessionId ? item.sessionId + " " : item.topicSetId ? item.topicSetId + " " : "";
			lines.push("  · " + who + "「" + item.title + "」（" + item.reason + "）");
		}
	}
	if (result.status === "applied") {
		lines.push("- 宿主会话改名 " + result.applied.hostRenamed + " 个；跳过（已被他人改名）" + result.applied.hostSkipped + " 个");
		lines.push("- 迁移标记已写入 store.meta.titles；重启不会重复执行。");
	}
	return lines.join("\n");
}
// src/commands.ts
/** Subcommand -> picker description (doubles as the `/memory-<name>` description). */
const SUBCOMMANDS = [
	["ui", "打开 SuperMemory 可视化管理台（返回带令牌链接，侧边栏 browser tab 可直接打开）"],
	["status", "SuperMemory 状态总览（工作区、活跃话题集、各类计数、维护游标）"],
	["topicsets", "列出当前工作区的话题集（标题/梗概/分支/默认模型）"],
	["switch", "激活话题集：/memory-switch <话题集名>"],
	["new", "新建话题集：/memory-new <标题>"],
	["model", "话题集/分支模型管理：/memory-model <provider> <model> [effort]"],
	["tools", "组合工具管理：/memory-tools 列表；edit <id> <JSON> 修改；desc <id> <文本> 改简介；retire <id> 停用"],
	["reqs", "列出未完成需求"],
	["resume", "继续被中断的任务：/memory-resume 查看清单；/memory-resume <dispatchId...> 续跑（可多个）"],
	["wrap", "更新当前话题集梗概"],
	["scan", "扫描工作区，刷新项目文件地图"],
	["export", "导出 .supermemory-export.md 到工作区根目录"],
	["titles", "补正刷新被旧截断逻辑损坏的话题集/分支标题（dry-run 只预览不写库）"],
	["help", "查看 /memory 命令族全部用法"]
];
/** Attach the /memory command family; returns the effect disposer. */
function attachCommands(ctx, deps) {
	const disposers = [];
	disposers.push(ctx.commands.register({
		name: "memory",
		description: "SuperMemory 命令族：ui 可视化管理台 · status 状态 · topicsets 话题集 · switch 激活 · new 新建 · model 模型 · tools 组合工具 · reqs 需求 · resume 续跑中断任务 · wrap 梗概 · scan 扫描 · export 导出（每个子命令也可直接输 /memory-<名> 快速选择）",
		handler: async (invocation) => {
			const [sub, ...rest] = (invocation.rawInput ?? "").trim().split(/\s+/);
			return runMemory(deps, sub ?? "", rest.join(" ").trim(), invocation);
		}
	}));
	for (const [name, description] of SUBCOMMANDS) disposers.push(ctx.commands.register({
		name: `memory-${name}`,
		description,
		handler: async (invocation) => runMemory(deps, name, (invocation.rawInput ?? "").trim(), invocation)
	}));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** The /memory command body, shared by the family command and every sibling. */
async function runMemory(deps, sub, arg, invocation) {
	const store = deps.store;
	if (!store) return {
		kind: "error",
		text: "SuperMemory 存储域未打开，记忆功能不可用。"
	};
	const agent = invocation.agent;
	const sessionId = String(agent?.id ?? "");
	const workspaceKey = deps.workspaceKeyOfCwd(agent?.session?.header?.cwd);
	switch (sub) {
		case "":
		case "status": return statusText(deps, sessionId, workspaceKey);
		case "titles": {
			const dryRun = /dry[-_ ]?run|预览|预演/i.test(arg);
			if (arg && !dryRun) return {
				kind: "error",
				text: "用法：/memory titles [dry-run]（dry-run 只预览不写库）"
			};
			return {
				kind: "success",
				text: renderTitlesMigrationReport(await migrateTruncatedTitles({
					ctx: deps.ctx,
					store,
					logger: deps.logger
				}, {
					dryRun,
					ignoreMarker: true
				}))
			};
		}
		case "help": return {
			kind: "success",
			text: HELP
		};
		case "topicsets": return topicsetsText(store, workspaceKey);
		case "switch": {
			if (!arg) return {
				kind: "error",
				text: "用法：/memory switch <话题集名>"
			};
			const found = listTopicSets(store, workspaceKey).find(([, t]) => t.title === arg || t.title.includes(arg));
			if (!found) return {
				kind: "error",
				text: `未找到话题集『${arg}』。`
			};
			await setRouting(store, sessionId, {
				activeTopicSetId: found[0],
				driftCount: 0
			});
			await touchTopicSet(store, found[0]);
			noteTopicSetActivated({
				ctx: deps.ctx,
				store,
				logger: deps.logger
			}, found[0]);
			return {
				kind: "success",
				text: `已激活话题集『${found[1].title}』。\n${renderCard(found[1])}`
			};
		}
		case "new": {
			if (!arg) return {
				kind: "error",
				text: "用法：/memory new <标题>"
			};
			const model = await askDefaultModel(deps.model, agent);
			const title = clipEllipsis(firstLine(arg), 60);
			const id = await createTopicSet(store, {
				workspaceKey,
				title,
				...model ? { defaultModel: model } : {}
			});
			try {
				await fillTopicShapeOnCreate({
					ctx: deps.ctx,
					store,
					logger: deps.logger
				}, id, "", {
					tags: true,
					summary: true
				});
			} catch (error) {
				deps.logger.warn("supermemory: topic-set shape generation skipped: " + String(error).slice(0, 160));
			}
			await setRouting(store, sessionId, {
				activeTopicSetId: id,
				driftCount: 0
			});
			noteTopicSetActivated({
				ctx: deps.ctx,
				store,
				logger: deps.logger
			}, id);
			const stored = getTopicSet(store, id);
			return {
				kind: "success",
				text: `已创建并激活话题集『${stored?.title ?? title}』${stored && stored.keywords.length ? `（标签：${stored.keywords.join("、")}）` : ""}${model ? `（默认模型 ${model.provider}/${model.model}）` : ""}`
			};
		}
		case "model": {
			if (!arg) {
				const active = getRouting(store, sessionId)?.activeTopicSetId;
				const topicSet = active ? getTopicSet(store, active) : void 0;
				const lines = topicSet?.defaultModel ? [`当前话题集默认模型：${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}`] : ["当前话题集未设置默认模型（跟随分支创建时的选择）。"];
				for (const m of topicSet?.members ?? []) lines.push(`- ${m.title || m.sessionId}：${m.model ?? "默认"}${m.modelOverridden ? "（覆盖）" : ""}`);
				lines.push("用法：/memory model <provider> <model> [effort]（按话题集）或 /memory model branch <sessionId> <provider> <model>");
				return {
					kind: "success",
					text: lines.join("\n")
				};
			}
			const parts = arg.split(/\s+/);
			if (parts[0] === "branch" && parts.length >= 4) {
				const result = await applyModelSelection(deps.model, { branchSessionId: parts[1] }, {
					provider: parts[2],
					model: parts[3],
					...parts[4] ? { reasoningEffort: parts[4] } : {}
				});
				return result.applied ? {
					kind: "success",
					text: `已覆盖分支 ${parts[1]} 的模型为 ${parts[2]}/${parts[3]}${result.live ? "" : "（分支不在线，已记录，恢复后生效）"}`
				} : {
					kind: "error",
					text: "未找到该分支。"
				};
			}
			if (parts.length >= 2) {
				const active = getRouting(store, sessionId)?.activeTopicSetId;
				if (!active) return {
					kind: "error",
					text: "当前没有激活的话题集。"
				};
				const result = await applyModelSelection(deps.model, { topicSetId: active }, {
					provider: parts[0],
					model: parts[1],
					...parts[2] ? { reasoningEffort: parts[2] } : {}
				});
				return {
					kind: "success",
					text: `已设置默认模型 ${parts[0]}/${parts[1]}${result.live ? "（已应用到在线分支）" : ""}`
				};
			}
			return {
				kind: "error",
				text: "用法：/memory model <provider> <model> [effort]"
			};
		}
		case "tools": return toolsCommand(deps, arg);
		case "reqs": {
			const open = [];
			for (const [, record] of store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open") open.push(`- ${record.text}`);
			return {
				kind: "success",
				text: open.length ? `未完成需求：\n${open.join("\n")}` : "（暂无未完成需求）"
			};
		}
		case "scan": {
			const { scanWorkspace, filemapEntries } = await import("./filemap-BHeNYxCh.js").then((n) => n.n);
			const cwd = agent?.session?.header?.cwd;
			if (!cwd) return {
				kind: "error",
				text: "无法确定当前工作区。"
			};
			const result = await scanWorkspace(store, cwd);
			const total = filemapEntries(store, workspaceKey).length;
			return {
				kind: "success",
				text: `项目地图扫描完成：扫描 ${result.scanned} 个文件，新增 ${result.added}，失效/更新 ${result.stale}，当前共 ${total} 条。`
			};
		}
		case "export": {
			const { writeFileSync } = await import("node:fs");
			const { buildExport } = await import("./export-BpBKNibH.js").then((n) => n.n);
			const active = getRouting(store, sessionId)?.activeTopicSetId;
			const result = buildExport(store, workspaceKey, active);
			const target = `${cwdFor(agent)}/.supermemory-export.md`;
			writeFileSync(target, result.text, "utf8");
			return {
				kind: "success",
				text: `已导出到 ${target}（${result.memories} 条记忆、${result.requirements} 条需求、${result.files} 个文件条目）。`
			};
		}
		case "ui": {
			const { getWebui } = await Promise.resolve().then(() => webui_exports);
			const webui = getWebui();
			if (!webui?.enabled) return {
				kind: "error",
				text: "Web 管理台未启用（ui.enabled=false）。"
			};
			return {
				kind: "success",
				text: `记忆管理台：\n${webui.url(sessionId, workspaceKey)}\n\n直接点击链接，或粘贴进侧边栏 browser tab（管理台与 GUI 不同源，侧边栏可正常嵌入；系统浏览器也可）。令牌仅本次运行有效；宿主重启后请重新执行 /memory ui。`
			};
		}
		case "resume": {
			const ids = arg ? arg.split(/\s+/).map((row) => row.trim()).filter(Boolean) : [];
			if (ids.length === 0) return {
				kind: "success",
				text: renderInterruptedList(listInterruptedDispatches(store, { workspaceKey }))
			};
			const lines = [];
			for (const id of ids) {
				const row = await resumeDispatch({
					ctx: deps.ctx,
					store,
					logger: deps.logger
				}, id, { exec: { agent } });
				lines.push((row.status === "resumed" ? "✅ " : "❌ ") + row.dispatchId + "：" + row.message);
			}
			return {
				kind: "success",
				text: lines.join("\n")
			};
		}
		case "wrap": {
			const active = getRouting(store, sessionId)?.activeTopicSetId;
			if (!active) return {
				kind: "error",
				text: "当前没有激活的话题集。"
			};
			const topicSet = getTopicSet(store, active);
			if (!topicSet) return {
				kind: "error",
				text: "话题集不存在。"
			};
			const bits = [];
			if (topicSet.summary) bits.push(topicSet.summary);
			for (const [, episode] of store.episodes.entries()) if (episode.topicSetId === active && episode.summary) bits.push(episode.summary.slice(0, 120));
			const summary = bits.slice(-6).join(" / ").slice(0, 500);
			await updateTopicSetSummary(store, active, summary || topicSet.summary);
			return {
				kind: "success",
				text: `已更新话题集梗概：\n${summary || "（暂无素材）"}`
			};
		}
		default: return {
			kind: "error",
			text: `未知子命令 /memory ${sub}；可用：${HELP}`
		};
	}
}
const HELP = "status 状态总览 · topicsets 话题集列表 · switch <名> 激活 · new <标题> 新建 · model 模型管理 · tools 组合工具 · reqs 需求 · resume 续跑中断任务 · wrap 更新梗概 · scan/export（P2） · ui 可视化管理台（Plan A）\nresume：被中断的任务（插件重载/关闭或 DSH 退出导致，分支会话已保留）。/memory-resume 查看清单；/memory-resume <dispatchId...> 续跑指定任务（优先续接原分支会话）。\n快捷方式：每个子命令都是独立命令，输入 /memory 后可在列表里直接选择（如 /memory-ui、/memory-status、/memory-topicsets）；也可用 /memory <子命令> <参数>。";
/** R6: /memory tools — list / edit / describe / retire composite tools. */
async function toolsCommand(deps, arg) {
	const store = deps.store;
	if (!store) return {
		kind: "error",
		text: "SuperMemory 存储域未打开，记忆功能不可用。"
	};
	const { SupermemoryPanelService } = await Promise.resolve().then(() => panel_exports);
	const service = new SupermemoryPanelService(store, deps.ctx);
	const [verb, ...rest] = arg.split(/\s+/);
	const target = rest.join(" ").trim();
	if (!verb) {
		const rows = service.listTools();
		if (rows.length === 0) return {
			kind: "success",
			text: "（暂无组合工具；重复流程出现 3 次后会提议固化，或用 memory_toolize 接受）"
		};
		return {
			kind: "success",
			text: [
				"组合工具（自行生成，可编辑）：",
				...rows.map((row) => [
					`- ${row.name}（${row.status}${row.live ? "" : "，未注册"}，使用 ${row.useCount} 次）`,
					`  简介：${row.description || "（无）"}`,
					`  步骤：${row.steps.join(" → ") || "（无）"}`,
					row.parameters.length > 0 ? `  参数：${row.parameters.join("、")}` : "  参数：（无）",
					`  id=${row.id}`
				].join("\n")),
				"",
				"编辑：/memory tools edit <id> {\"description\":\"…\",\"steps\":[{\"tool\":\"…\",\"arguments\":{}}],\"parameters\":[…]}",
				"改简介：/memory tools desc <id> <文本> · 停用：/memory tools retire <id>"
			].join("\n")
		};
	}
	if (verb === "desc") {
		const [id, ...textParts] = target.split(/\s+/);
		const text = textParts.join(" ").trim();
		if (!id || !text) return {
			kind: "error",
			text: "用法：/memory tools desc <id> <简介文本>"
		};
		const result = await service.editTool(id, { description: text });
		return result.status === "ok" ? {
			kind: "success",
			text: result.message
		} : {
			kind: "error",
			text: result.message
		};
	}
	if (verb === "retire") {
		if (!target) return {
			kind: "error",
			text: "用法：/memory tools retire <id>"
		};
		const result = await service.editTool(target.trim(), { status: "retired" });
		return result.status === "ok" ? {
			kind: "success",
			text: result.message
		} : {
			kind: "error",
			text: result.message
		};
	}
	if (verb === "edit") {
		const space = target.indexOf(" ");
		if (space <= 0) return {
			kind: "error",
			text: "用法：/memory tools edit <id> <JSON 补丁>"
		};
		const id = target.slice(0, space);
		const raw = target.slice(space + 1).trim();
		let patch;
		try {
			patch = JSON.parse(raw);
		} catch {
			return {
				kind: "error",
				text: "JSON 补丁解析失败。"
			};
		}
		const result = await service.editTool(id, patch);
		return result.status === "ok" ? {
			kind: "success",
			text: result.message
		} : {
			kind: "error",
			text: result.message
		};
	}
	return {
		kind: "error",
		text: `未知操作 /memory tools ${verb}；可用：（无参）列表 · edit <id> <JSON> · desc <id> <文本> · retire <id>`
	};
}
function statusText(deps, sessionId, workspaceKey) {
	const store = deps.store;
	let memories = 0;
	let ownMemories = 0;
	let episodes = 0;
	let requirements = 0;
	let signals = 0;
	for (const [, record] of store.memories.entries()) {
		memories++;
		if (record.workspaceKey === workspaceKey && record.status === "active") ownMemories++;
	}
	episodes = store.episodes.size;
	for (const [, record] of store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open") requirements++;
	for (const [, record] of store.signals.entries()) if (record.workspaceKey === workspaceKey) signals++;
	const hot = store.hotcache.get(sessionId);
	const cursor = hot?.lastMaintainedSeq !== void 0 ? String(hot.lastMaintainedSeq) : "无";
	const active = getRouting(store, sessionId)?.activeTopicSetId;
	const topicSet = active ? getTopicSet(store, active) : void 0;
	return {
		kind: "success",
		text: [
			"SuperMemory 状态",
			`- 工作区：${workspaceKey}`,
			`- 活跃话题集：${topicSet ? topicSet.title : "（未激活）"}`,
			`- 事实记忆：${ownMemories} 条（全库 ${memories} 条）`,
			`- 归档梗概：${episodes} 条`,
			`- 未完成需求：${requirements} 条`,
			`- 重复模式信号：${signals} 个`,
			`- 本会话维护游标：${cursor}`
		].join("\n")
	};
}
/** The session cwd of a command invocation, for file-targeting commands. */
function cwdFor(agent) {
	return agent?.session?.header?.cwd ?? process.cwd();
}
function topicsetsText(store, workspaceKey) {
	const list = listTopicSets(store, workspaceKey);
	if (list.length === 0) return {
		kind: "success",
		text: "（当前工作区暂无话题集；发送消息时将按需询问新建）"
	};
	return {
		kind: "success",
		text: list.map(([id, t]) => {
			const branches = t.members.map((m) => `${m.title || m.sessionId.slice(0, 8)}(${m.status})`).join("、") || "无分支";
			return `- ${t.title}${t.defaultModel ? ` [${t.defaultModel.provider}/${t.defaultModel.model}]` : ""}\n  ${t.summary || "（暂无梗概）"}\n  分支：${branches}\n  id=${id}`;
		}).join("\n")
	};
}
// src/maintenance.ts
const BUFFER_CAP = 50;
/** In-memory debounce counter for the rolling topic-set summary. */
const summaryTurns = /* @__PURE__ */ new Map();
/** Attach the maintenance loop; returns the effect disposer. */
function attachMaintenance(ctx, store, config, logger) {
	if (!store || !config.enabled) return () => {};
	const activeStore = store;
	const buffers = /* @__PURE__ */ new Map();
	const cursors = /* @__PURE__ */ new Map();
	const queue = [];
	let pumping = false;
	let disposed = false;
	for (const [sessionId, entry] of activeStore.hotcache.entries()) if (entry.lastMaintainedSeq !== void 0) cursors.set(sessionId, entry.lastMaintainedSeq);
	const bufferFor = (sessionId) => {
		let buffer = buffers.get(sessionId);
		if (!buffer) {
			buffer = [];
			buffers.set(sessionId, buffer);
		}
		return buffer;
	};
	const off = ctx.on("session/event", (session, event) => {
		if (disposed) return;
		const sessionId = String(session.id);
		if (event.type !== "user/message" && event.type !== "turn/end") return;
		if (event.type === "user/message") {
			const message = event.data;
			if (message.source?.kind !== "user") return;
			const text = textOfMessage(message);
			if (!text) return;
			const buffer = bufferFor(sessionId);
			buffer.push({
				seq: event.seq,
				text
			});
			if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
			return;
		}
		if (event.type === "turn/end") {
			queue.push({
				sessionId,
				seq: event.seq
			});
			pump();
		}
	});
	async function pump() {
		if (pumping) return;
		pumping = true;
		try {
			while (!disposed && queue.length > 0) {
				const task = queue.shift();
				try {
					await process(task);
				} catch (error) {
					logger.warn(`supermemory: maintenance task failed (${task.sessionId}@${task.seq}): ${String(error)}`);
				}
			}
		} finally {
			pumping = false;
		}
	}
	async function process(task) {
		const cursor = cursors.get(task.sessionId) ?? -1;
		let users = (buffers.get(task.sessionId) ?? []).filter((u) => u.seq > cursor);
		let workspaceKey;
		const liveCwd = ctx.sessions.get(task.sessionId)?.header?.cwd;
		if (liveCwd) workspaceKey = workspaceKeyOf(liveCwd);
		if (users.length === 0 || workspaceKey === void 0) {
			const cold = await coldRead(task.sessionId, cursor, task.seq);
			if (cold) {
				if (users.length === 0) users = cold.users;
				workspaceKey ??= cold.workspaceKey;
			} else if (users.length === 0 || workspaceKey === void 0) {
				logger.warn(`supermemory: cold read failed for ${task.sessionId}@${task.seq}; cursor kept at ${cursor}`);
				return;
			}
		}
		if (workspaceKey === void 0 || users.length === 0) {
			cursors.set(task.sessionId, task.seq);
			await persistCursor(task.sessionId, task.seq);
			return;
		}
		const now = Date.now();
		const createdIds = [];
		const reqIds = [];
		for (const user of users) {
			for (const fact of extractFacts(user.text)) {
				const memoryId = await rememberFact(activeStore, workspaceKey, fact.text, fact.keywords, task.sessionId, user.seq, now);
				if (memoryId) {
					createdIds.push(memoryId);
					countSignal(activeStore, workspaceKey, fact.keywords[0] ?? fact.text.slice(0, 12), fact.text, now);
				}
			}
			const reqTexts = extractRequirements(user.text);
			if (reqTexts.length > 0) {
				const created = await rememberRequirements(activeStore, workspaceKey, reqTexts, task.sessionId, user.seq, now);
				reqIds.push(...created);
			}
		}
		buffers.set(task.sessionId, []);
		cursors.set(task.sessionId, task.seq);
		await persistCursor(task.sessionId, task.seq, createdIds);
		rollSummary(activeStore, task.sessionId, users, config.summaryEveryTurns, logger);
		if (createdIds.length > 0 || reqIds.length > 0) logger.info(`supermemory: +${createdIds.length} memories, +${reqIds.length} requirements from ${task.sessionId}@${task.seq}`);
		await countSequenceSignal(activeStore, ctx, task.sessionId, workspaceKey, cursor, task.seq, config, logger);
	}
	async function persistCursor(sessionId, seq, createdIds = []) {
		const recentRelevant = activeStore.hotcache.get(sessionId)?.recentRelevant ?? {
			episodes: [],
			reqIds: [],
			memoryIds: [],
			toolNames: []
		};
		const memoryIds = [...createdIds, ...recentRelevant.memoryIds].slice(0, 10);
		await activeStore.hotcache.put(sessionId, {
			recentRelevant: {
				...recentRelevant,
				memoryIds
			},
			lastMaintainedSeq: seq,
			updatedAt: Date.now()
		});
	}
	/** Cold-read one session's durable log through the persistence seam. */
	async function coldRead(sessionId, afterSeq, untilSeq) {
		let handle;
		try {
			handle = await ctx.sessionPersistence.open(sessionId, "read");
			const { events } = await handle.read(afterSeq + 1);
			const users = [];
			const turnEndSeqs = [];
			for (const event of events) {
				if (event.seq > untilSeq) break;
				if (event.type === "user/message") {
					const message = event.data;
					if (message.source?.kind !== "user") continue;
					const text = textOfMessage(message);
					if (text) users.push({
						seq: event.seq,
						text
					});
				} else if (event.type === "turn/end") turnEndSeqs.push(event.seq);
			}
			return {
				users,
				turnEndSeqs,
				workspaceKey: handle.header?.cwd ? workspaceKeyOf(handle.header.cwd) : void 0
			};
		} catch {
			return;
		} finally {
			handle?.close?.();
		}
	}
	(async () => {
		for (const [sessionId, cursor] of [...cursors]) try {
			const cold = await coldRead(sessionId, cursor, Number.MAX_SAFE_INTEGER);
			if (!cold || cold.users.length === 0) continue;
			const missed = cold.turnEndSeqs.filter((seq) => seq > cursor);
			if (missed.length === 0) continue;
			logger.info(`supermemory: reconciling ${missed.length} missed turn(s) for ${sessionId}`);
			for (const seq of missed) queue.push({
				sessionId,
				seq
			});
			pump();
		} catch (error) {
			logger.warn(`supermemory: reconciliation failed for ${sessionId}: ${String(error)}`);
		}
	})();
	return () => {
		disposed = true;
		off();
	};
}
/** Plain text of one message's content blocks. */
function textOfMessage(message) {
	return (message.content ?? []).map((block) => block.type === "text" ? String(block.text ?? "") : "").filter(Boolean).join("\n");
}
/**
* §2.1 (4): rolling topic-set summary. Rule-based and debounced by an
* in-memory turn counter (a remount restarts the count — acceptable for a
* debounce; the durable state is the summary itself).
*/
function rollSummary(store, sessionId, users, everyNTurns, logger) {
	const routing = store.routing.get(sessionId);
	if (!routing?.activeTopicSetId) return;
	const topicSet = store.topicsets.get(routing.activeTopicSetId);
	if (!topicSet) return;
	const count = (summaryTurns.get(sessionId) ?? 0) + 1;
	summaryTurns.set(sessionId, count);
	if (count % Math.max(1, everyNTurns) !== 0) return;
	const last = users[users.length - 1]?.text?.trim() ?? "";
	if (!last) return;
	const snippet = last.replace(/\s+/g, " ").slice(0, 60);
	const summary = `${topicSet.summary}${topicSet.summary ? " / " : ""}${snippet}`.slice(0, 300);
	store.topicsets.update(routing.activeTopicSetId, (record) => ({
		...record,
		summary,
		updatedAt: Date.now()
	})).then(() => {
		logger.info(`supermemory: rolled summary for ${routing.activeTopicSetId}`);
	}).catch(() => {});
}
/**
* One turn's tool sequence feeds the tool-ization pipeline: sliding windows of
* 2..4 calls (every occurrence counts) plus the whole short turn. Crossing the
* threshold auto-registers the composite (需求 B) or, with autoToolize off,
* raises the manual pending proposal exactly as before.
*/
async function countSequenceSignal(store, ctx, sessionId, workspaceKey, afterSeq, untilSeq, config, logger) {
	let tools = [];
	const args = [];
	const { parseArgs } = await import("./composite-Cttx-LIx.js").then((n) => n.r);
	try {
		const handle = await ctx.sessionPersistence.open(sessionId, "read");
		try {
			const { events } = await handle.read(afterSeq + 1);
			for (const event of events) {
				if (event.seq > untilSeq) break;
				if (event.type !== "tool/call") continue;
				const data = event.data;
				if (!data.name) continue;
				tools.push(data.name);
				args.push(parseArgs(data.arguments));
			}
		} finally {
			await handle.close();
		}
	} catch {
		return;
	}
	if (tools.length < 2) return;
	const { recordTurnSequences, recycleIdleComposites } = await Promise.resolve().then(() => toolize_exports);
	const toolize = {
		enabled: config.autoToolize,
		threshold: config.signalsThreshold,
		cooldownMs: config.toolizeCooldownMs,
		maxActive: config.toolizeMax,
		minSteps: config.toolizeMinSteps,
		minDistinctTools: config.toolizeMinDistinctTools,
		nearMissHint: config.nearMissHint,
		recycleIdleDays: config.recycleIdleToolDays
	};
	await recordTurnSequences(ctx, store, workspaceKey, tools, args, toolize, logger);
	await recycleIdleComposites(ctx, store, toolize, logger);
}
/** Write one fact, skipping exact duplicates within the workspace. */ async function rememberFact(store, workspaceKey, text, keywords, sourceSessionId, sourceSeq, now) {
	const normalized = text.trim().toLowerCase();
	for (const [, record] of store.memories.entries()) if (record.workspaceKey === workspaceKey && record.status === "active" && record.text.trim().toLowerCase() === normalized) return;
	const memoryId = newId("mem");
	const memory = {
		workspaceKey,
		title: deriveTitle(text),
		text,
		keywords: mergeTags([], keywords),
		sourceSessionId,
		sourceSeq,
		status: "active",
		createdAt: now,
		updatedAt: now
	};
	await store.memories.put(memoryId, memory);
	return memoryId;
}
/** Increment the repeated-pattern counter (P3 tool-ization input). */
function countSignal(store, workspaceKey, pattern, example, now) {
	if (!pattern) return;
	const signalKey = `ws/${workspaceKey}/${pattern}`;
	const existing = store.signals.get(signalKey);
	const signal = existing ? {
		...existing,
		count: existing.count + 1,
		lastSeen: now,
		examples: [...existing.examples, example].slice(-5)
	} : {
		workspaceKey,
		pattern,
		count: 1,
		lastSeen: now,
		examples: [example],
		sequence: [],
		samples: []
	};
	store.signals.put(signalKey, signal).catch(() => {});
}
// src/toolize.ts
var toolize_exports = /* @__PURE__ */ __exportAll({
	recordTurnSequences: () => recordTurnSequences,
	recycleIdleComposites: () => recycleIdleComposites
});
/** Default seam: the real host registry and the real durable table. */
function defaultToolizeDeps() {
	return {
		register: registerComposite,
		persist: persistComposite,
		toolExists: (ctx, name) => Boolean(ctx.tools.get(name)),
		now: () => Date.now()
	};
}
/** Name compileComposite gives this sequence (single source of the naming rule). */
function compositeNameOf(tools) {
	return "sm_composite_" + (tools.join(">").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24) || "seq");
}
/** Every durable active composite (broken JSON is skipped, never thrown). */
function activeComposites(store) {
	const out = [];
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || record.status !== "active" || !record.entry) continue;
		try {
			const spec = JSON.parse(record.entry);
			if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) continue;
			out.push({
				id,
				spec,
				useCount: record.useCount
			});
		} catch {}
	}
	return out;
}
/** Longest suffix of recent tool names that is a prefix of one composite. */
function longestPrefixMatch(recent, steps) {
	const max = Math.min(recent.length, steps.length);
	for (let len = max; len > 0; len -= 1) {
		const tail = recent.slice(recent.length - len);
		let same = true;
		for (let index = 0; index < len; index += 1) if (tail[index] !== steps[index]) {
			same = false;
			break;
		}
		if (same) return len;
	}
	return 0;
}
/** Pick the composite with the longest matching prefix; only LIVE names qualify. */
function pickCompositeMatch(recent, candidates, live = liveCompositeSpecs) {
	let best;
	for (const candidate of candidates) {
		if (!live.has(candidate.spec.name)) continue;
		const hits = longestPrefixMatch(recent, candidate.spec.steps.map((step) => step.tool));
		if (hits === 0) continue;
		if (!best || hits > best.hits) best = {
			spec: candidate.spec,
			hits,
			recent: recent.slice(-hits)
		};
	}
	return best;
}
/** Catalog of LIVE composites, best (longest just-executed prefix) first. */
function catalogFor(recent, candidates, live = liveCompositeSpecs, limit = 3) {
	const entries = [];
	for (const candidate of candidates) {
		if (!live.has(candidate.spec.name)) continue;
		const steps = candidate.spec.steps.map((step) => step.tool);
		const hits = longestPrefixMatch(recent, steps);
		entries.push({
			name: candidate.spec.name,
			steps,
			description: candidate.spec.description,
			parameters: candidate.spec.parameters.map((parameter) => parameter.name),
			hits
		});
	}
	entries.sort((left, right) => right.hits - left.hits);
	return entries.slice(0, Math.max(1, limit));
}
/** Structured, model-facing catalog block (form: catalog vocabulary in prose). */
function renderCatalog(entries) {
	if (entries.length === 0) return "";
	const lines = ["[SuperMemory 可用组合工具]", "以下组合工具已注册，可一次调用完成固定子序列；步骤匹配时优先直接调用它们。"];
	for (const entry of entries) {
		const params = entry.parameters.length > 0 ? "（参数：" + entry.parameters.join(", ") + "）" : "";
		const hint = entry.hits >= 2 ? "；刚执行的步骤与其前 " + entry.hits + " 步一致，建议直接调用它" : "";
		lines.push("- " + entry.name + "：" + entry.steps.join(" → ") + params + hint);
	}
	return lines.join("\n");
}
/** Decide whether one sequence may become a composite right now (pure). */
function planAutoToolize(input) {
	const config = input.config;
	const name = compositeNameOf(input.tools);
	if (!config.enabled) return {
		action: "disabled",
		reason: "autoToolize 关闭",
		name
	};
	if (input.tools.length < Math.max(2, config.minSteps)) return {
		action: "invalid",
		reason: "步数不足",
		name
	};
	if (input.tools.length > 6) return {
		action: "invalid",
		reason: "步数过多（只固化短流程）",
		name
	};
	if (new Set(input.tools).size < Math.max(1, config.minDistinctTools)) return {
		action: "invalid",
		reason: "同一工具重复不构成流程",
		name
	};
	for (const tool of input.tools) {
		if (tool.startsWith("sm_composite_")) return {
			action: "invalid",
			reason: "序列包含组合工具本身",
			name
		};
		if (!input.registered.has(tool)) return {
			action: "invalid",
			reason: "工具当前未注册：" + tool,
			name
		};
	}
	if (input.existingNames.has(name)) return {
		action: "duplicate",
		reason: "组合工具已存在",
		name
	};
	if (input.activeCount >= Math.max(1, config.maxActive)) return {
		action: "cap",
		reason: "已达组合工具上限",
		name
	};
	if (input.cooldown) return {
		action: "cooldown",
		reason: "冷却窗口内",
		name
	};
	return {
		action: "create",
		reason: "ok",
		name
	};
}
/** Last successful auto-toolization time per workspace (cooldown state). */
const cooldownUntil = /* @__PURE__ */ new Map();
/** Minimal durable Signal compileComposite needs for one sequence. */
function signalOf(workspaceKey, tools, samples, now) {
	return {
		workspaceKey,
		pattern: tools.join(">"),
		count: 1,
		lastSeen: now,
		examples: [tools.join(" → ")],
		sequence: tools,
		samples: samples.map((sample) => JSON.stringify(sample)),
		proposedAt: now,
		proposalStatus: "accepted"
	};
}
/** Compile, register and persist one sequence under cooldown/cap/duplicate rules. */
async function autoToolizeFromSequence(ctx, store, workspaceKey, tools, samples, config, logger, deps) {
	const seam = deps ?? defaultToolizeDeps();
	const candidates = activeComposites(store);
	const existingNames = new Set(candidates.map((candidate) => candidate.spec.name));
	const registered = /* @__PURE__ */ new Set();
	for (const tool of tools) if (seam.toolExists(ctx, tool)) registered.add(tool);
	const now = seam.now();
	const plan = planAutoToolize({
		tools,
		existingNames,
		activeCount: candidates.length,
		cooldown: (cooldownUntil.get(workspaceKey) ?? 0) > now,
		registered,
		config
	});
	if (plan.action !== "create") {
		if (plan.action !== "duplicate" && plan.action !== "disabled") logger.info("supermemory: auto-toolize skipped (" + plan.action + "): " + plan.reason + " " + tools.join(">"));
		return {
			action: plan.action,
			name: plan.name,
			reason: plan.reason
		};
	}
	try {
		const fallback = {
			tools,
			args: tools.map(() => ({}))
		};
		const usable = samples.length > 0 ? samples : [fallback];
		const spec = compileComposite(signalOf(workspaceKey, tools, usable, now), usable);
		await seam.register(ctx, store, spec);
		await seam.persist(store, spec, "ws/" + workspaceKey + "/seq/" + tools.join(">"));
		cooldownUntil.set(workspaceKey, now + Math.max(0, config.cooldownMs));
		logger.info("supermemory: auto-toolized " + tools.join(">") + " -> " + spec.name);
		return {
			action: "create",
			name: spec.name,
			reason: "ok"
		};
	} catch (error) {
		logger.warn("supermemory: auto-toolize failed: " + String(error).slice(0, 200));
		return {
			action: "failed",
			name: plan.name,
			reason: String(error).slice(0, 160)
		};
	}
}
/** Every sliding window of minSteps..maxSteps calls, in turn order. */
function sequenceWindows(tools, minSteps, maxSteps) {
	const out = [];
	const low = Math.max(2, minSteps);
	const high = Math.max(low, Math.min(tools.length, maxSteps));
	for (let len = low; len <= high; len += 1) for (let start = 0; start + len <= tools.length; start += 1) {
		const indexes = [];
		for (let offset = 0; offset < len; offset += 1) indexes.push(start + offset);
		out.push({
			tools: indexes.map((index) => tools[index]),
			indexes
		});
	}
	return out;
}
/** Parse the samples recorded on a durable signal. */
function parseSamples(raw) {
	const out = [];
	for (const entry of raw) try {
		const parsed = JSON.parse(entry);
		if (parsed && Array.isArray(parsed.tools) && Array.isArray(parsed.args)) out.push(parsed);
	} catch {}
	return out;
}
/**
* Durable per-turn sequence counting: sliding windows of 2..4 calls (each
* occurrence counts) plus the whole turn when it is short (legacy signature).
*/
async function recordTurnSequences(ctx, store, workspaceKey, tools, args, config, logger, deps) {
	if (tools.length < 2) return;
	const jobs = /* @__PURE__ */ new Map();
	const add = (jobTools, jobArgs) => {
		const key = jobTools.join(">");
		const existing = jobs.get(key);
		if (existing) {
			existing.occurrences += 1;
			return;
		}
		jobs.set(key, {
			tools: jobTools,
			args: jobArgs,
			occurrences: 1
		});
	};
	const low = Math.max(2, config.minSteps);
	for (const window of sequenceWindows(tools, low, Math.min(4, low + 2))) {
		add(window.tools, window.indexes.map((index) => args[index] ?? {}));
		if (jobs.size >= 40) break;
	}
	if (tools.length <= 6) add(tools, args);
	const now = Date.now();
	for (const [key, job] of jobs) {
		const signalKey = "ws/" + workspaceKey + "/seq/" + key;
		const existing = store.signals.get(signalKey);
		const count = (existing?.count ?? 0) + job.occurrences;
		const samples = [...existing?.samples ?? [], JSON.stringify({
			tools: job.tools,
			args: job.args
		})].slice(-3);
		const crossed = count >= Math.max(1, config.threshold);
		const signal = {
			workspaceKey,
			pattern: key,
			count,
			lastSeen: now,
			examples: [...existing?.examples ?? [], job.tools.join(" → ")].slice(-3),
			sequence: job.tools,
			samples,
			proposedAt: crossed ? existing?.proposedAt ?? now : existing?.proposedAt,
			proposalStatus: crossed ? "pending" : existing?.proposalStatus
		};
		await store.signals.put(signalKey, signal);
		if (!crossed) continue;
		const outcome = await autoToolizeFromSequence(ctx, store, workspaceKey, job.tools, parseSamples(samples), config, logger, deps);
		if (outcome.action === "create" || outcome.action === "duplicate") await store.signals.update(signalKey, (record) => ({
			...record,
			proposalStatus: "accepted"
		}));
		else if (outcome.action !== "disabled" && outcome.action !== "failed") await store.signals.update(signalKey, (record) => ({
			...record,
			proposalStatus: "declined"
		}));
		logger.info("supermemory: sequence " + key + " crossed (count=" + count + ", auto=" + outcome.action + ")");
	}
}
/**
* Startup sweep: auto-register every durable signal that already crossed the
* threshold (upgrade path for signals recorded before autoToolize existed).
*/
async function sweepAutoToolize(ctx, store, config, logger, deps) {
	if (!config.enabled) return 0;
	const threshold = Math.max(1, config.threshold);
	let created = 0;
	for (const [key, signal] of [...store.signals.entries()]) {
		if (signal.count < threshold) continue;
		if (signal.proposalStatus === "accepted" || signal.proposalStatus === "declined") continue;
		const tools = signal.sequence ?? [];
		if (tools.length < Math.max(2, config.minSteps) || tools.length > 6) continue;
		const outcome = await autoToolizeFromSequence(ctx, store, signal.workspaceKey, tools, parseSamples(signal.samples ?? []), config, logger, deps);
		if (outcome.action === "create" || outcome.action === "duplicate") {
			await store.signals.update(key, (record) => ({
				...record,
				proposalStatus: "accepted"
			}));
			if (outcome.action === "create") created += 1;
		}
	}
	const idle = activeComposites(store).filter((entry) => entry.useCount === 0).length;
	if (idle > 0) logger.info("supermemory: " + idle + " composite tool(s) have zero recorded use");
	if (created > 0) logger.info("supermemory: startup sweep auto-toolized " + created + " sequence(s)");
	return created;
}
/** Rate limit of the idle-composite sweep (one pass per hour at most). */
let lastRecycleAt = 0;
/**
* Idle-composite recycle (requirement B2, default OFF via recycleIdleDays 0):
* a composite with zero recorded use whose source flow has not been seen for
* recycleIdleDays is retired (unregistered + durable status retired).
*/
async function recycleIdleComposites(ctx, store, config, logger, now = Date.now()) {
	if (config.recycleIdleDays <= 0) return 0;
	if (now - lastRecycleAt < 36e5) return 0;
	lastRecycleAt = now;
	let retired = 0;
	for (const entry of activeComposites(store)) {
		if (entry.useCount > 0) continue;
		const record = store.toolMemory.get(entry.id);
		if (!record) continue;
		const lastSeen = (record.trigger ? store.signals.get(record.trigger) : void 0)?.lastSeen ?? 0;
		if (lastSeen === 0) continue;
		if (now - lastSeen < config.recycleIdleDays * 864e5) continue;
		try {
			await editCompositeTool(ctx, store, entry.id, { status: "retired" });
			retired += 1;
			logger.info("supermemory: recycled idle composite " + entry.spec.name);
		} catch (error) {
			logger.warn("supermemory: recycle failed for " + entry.spec.name + ": " + String(error).slice(0, 120));
		}
	}
	return retired;
}
/** The strongest same-window repetition inside ONE request (hard signal). */
function repeatedWindow(state, config) {
	const names = state.recent.map((item) => item.name);
	if (names.length < 2) return void 0;
	const low = Math.max(2, config.minSteps);
	const high = Math.min(4, low + 2);
	const need = Math.max(2, config.threshold);
	let best;
	for (let len = high; len >= low; len -= 1) {
		if (names.length < len) continue;
		for (let start = 0; start + len <= names.length; start += 1) {
			const window = names.slice(start, start + len);
			let count = 0;
			for (let probe = 0; probe + len <= names.length; probe += 1) {
				let same = true;
				for (let offset = 0; offset < len; offset += 1) if (names[probe + offset] !== window[offset]) {
					same = false;
					break;
				}
				if (same) count += 1;
			}
			if (count < need) continue;
			if (best && best.tools.length >= len) continue;
			best = {
				tools: window,
				samples: [{
					tools: window,
					args: state.recent.slice(start, start + len).map((item) => item.args)
				}],
				count
			};
		}
	}
	return best;
}
// src/activity.ts
/** Text content of one tool result (success and failure both carry content). */
function contentText(result) {
	const blocks = result.content ?? [];
	const parts = [];
	for (const block of blocks) if (block.type === "text" && block.text) parts.push(String(block.text));
	return parts.join("\n").slice(0, 2e3);
}
/** Parsed arguments of one execution (host may already have parsed them). */
function argsOf(value) {
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
	return value && typeof value === "object" ? value : {};
}
/** Best-effort durable near-miss counter for one composite. */
function recordNearMiss(store, workspaceKey, match, logger) {
	const key = "ws/" + workspaceKey + "/nearmiss/" + match.spec.name;
	const now = Date.now();
	const existing = store.signals.get(key);
	const signal = existing ? {
		...existing,
		count: existing.count + 1,
		lastSeen: now,
		examples: [...existing.examples, match.recent.join(" > ")].slice(-3)
	} : {
		workspaceKey,
		pattern: "nearmiss:" + match.spec.name,
		count: 1,
		lastSeen: now,
		examples: [match.recent.join(" > ")],
		sequence: match.recent,
		samples: []
	};
	store.signals.put(key, signal).catch(() => {});
	logger.info("supermemory: composite near-miss " + match.spec.name + " (hits=" + match.hits + ")");
}
/** Create one model-facing notice message (used for the immediate hint). */
async function buildNotice(text) {
	return (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "supermemory",
			form: "notice",
			summary: "组合工具提示"
		}
	});
}
/** Attach the tool-activity listener; returns the effect disposer. */
function attachToolActivity(ctx, store, tracker, config, logger, deps) {
	if (!store) return () => {};
	const activeStore = store;
	const memoryCap = 400;
	return ctx.on("tools/post-execute", async (exec, result, next) => {
		let decision;
		try {
			decision = await next();
		} catch (error) {
			logger.warn("supermemory: tool post-execute next() failed: " + String(error));
			throw error;
		}
		try {
			const execution = exec;
			const name = String(execution.name ?? "");
			if (!name) return decision;
			if (execution.parent !== void 0) return decision;
			const sessionId = String(execution.agent?.id ?? "");
			if (!sessionId) return decision;
			const workspaceKey = workspaceKeyOf(execution.agent?.session?.header?.cwd);
			const observation = {
				name,
				args: argsOf(execution.arguments),
				text: contentText(result),
				isError: Boolean(result.isError)
			};
			tracker.observe(sessionId, observation, config.repeat, activeStore.memories.entries(), memoryCap);
			const state = tracker.get(sessionId);
			if (!state) return decision;
			const match = pickCompositeMatch(state.recent.map((entry) => entry.name), activeComposites(activeStore));
			if (match && match.hits >= 2) recordNearMiss(activeStore, workspaceKey, match, logger);
			if (config.toolize.enabled) {
				const repeat = repeatedWindow(state, config.toolize);
				if (repeat) await autoToolizeFromSequence(ctx, activeStore, workspaceKey, repeat.tools, repeat.samples, config.toolize, logger, deps);
			}
			if (!config.nearMissHint || !match || match.hits < 2) return decision;
			if (tracker.hasHinted(sessionId, match.spec.name)) return decision;
			if (decision.kind !== "accept") return decision;
			tracker.markHinted(sessionId, match.spec.name);
			const notice = await buildNotice("[SuperMemory 提示] 刚执行的 " + match.recent.join(" → ") + " 与组合工具 " + match.spec.name + " 的前 " + match.hits + " 步一致。同样的流程可以直接调用它一次完成。");
			const existingContexts = decision.additionalContexts ?? [];
			return {
				...decision,
				additionalContexts: [...existingContexts, notice]
			};
		} catch (error) {
			logger.warn("supermemory: tool activity skipped: " + String(error).slice(0, 200));
			return decision;
		}
	});
}
// src/inrequest.ts
/**
* In-request recall (requirement A): repeat recall while ONE user request runs.
*
* Host event surface (verified against @deepseek-ai/dsh-agent and
* @deepseek-ai/dsh-tools 0.2.2-rc.3 sources under _dsh_src):
*
* - agent/pre-step is a per-STEP waterfall: dsh-agent-loop agent.ts#preStep runs
*   for every model step of a turn and receives the claimed inbox messages. An
*   enter decision carries messages, the ONLY place where a plugin may append
*   model-visible, durably logged content. A tool-continuation step claims no
*   user message, which is why the old guard (inject only when a user-source
*   message exists) produced exactly one card per request.
* - agent/request is deprecated and documented as unable to mutate messages.
* - systemPrompt sections are assembled BEFORE the pre-step waterfall and must be
*   pure/synchronous (no recall I/O); runtimeContext is a read-only projection.
* - tools/pre-execute only allows/denies/cancels/asks: PreToolDecision has no
*   context field, so it cannot carry a card (the old composite hint wrote
*   additionalContexts there and was silently dropped). tools/post-execute DOES
*   accept additionalContexts for the next request; tools/result is an isolated
*   observer whose failures are contained.
* => the per-step pre-step waterfall is the single safe injection point.
*
* This module is host-free (pure functions plus an in-memory tracker) so the
* smoke scripts can exercise it under Node type stripping.
* @module supermemory/inrequest
*/
const MAX_SESSIONS = 128;
const MAX_RECENT = 8;
const TOOL_TEXT_CAP = 1200;
const PATH_PATTERN = /[A-Za-z]:[\\/][^\s;)\]]{2,}|(?:\.{0,2}\/)[\w.\-]+(?:\/[\w.\-]+)+/g;
const ERROR_PATTERN = /(^|[^A-Za-z])(error|exception|failed|failure|fatal|ENOENT|EACCES|EPERM|TypeError|ReferenceError|SyntaxError)([^A-Za-z]|)|错误|失败|异常|报错/i;
/** Clamp one string to a character budget (never throws). */
function clampText(text, cap) {
	if (typeof text !== "string") return "";
	if (text.length <= cap) return text;
	return text.slice(0, cap);
}
/** Start a fresh request state. */
function newState(turn, step, query) {
	return {
		turn,
		step,
		lastRecallStep: step,
		toolCalls: 0,
		cards: 0,
		chars: 0,
		injectedIds: /* @__PURE__ */ new Set(),
		baseQuery: clampText(query, 2e3),
		toolText: "",
		recent: [],
		seenPaths: /* @__PURE__ */ new Set(),
		bestOverlap: 0,
		hot: false,
		hinted: /* @__PURE__ */ new Set()
	};
}
/** File-path-looking tokens in one tool output (Windows and POSIX forms). */
function extractPaths(text) {
	if (!text) return [];
	const found = text.match(PATH_PATTERN);
	if (!found) return [];
	return [...new Set(found)].slice(0, 12);
}
/** Cheap error heuristic over a tool output. */
function looksLikeError(text) {
	if (!text) return false;
	return ERROR_PATTERN.test(text);
}
/**
* Best keyword overlap between one observation and the workspace memories.
* Counts DISTINCT query tokens hitting one memory and caps the scan, so a huge
* store can never turn one tool result into a hot spot for the hub.
*/
function memoryOverlap(text, memories, cap) {
	const tokens = new Set(tokenize(clampText(text, 800)));
	if (tokens.size === 0) return 0;
	const wanted = /* @__PURE__ */ new Set();
	for (const token of tokens) {
		if (token.length < 2) continue;
		wanted.add(token);
		if (wanted.size >= 60) break;
	}
	let best = 0;
	let checked = 0;
	for (const entry of memories) {
		const memory = entry[1];
		if (memory.status !== "active") continue;
		checked += 1;
		if (checked > cap) break;
		const hay = new Set(tokenize(memory.text + " " + memory.keywords.join(" ")));
		let hits = 0;
		for (const token of wanted) if (hay.has(token)) hits += 1;
		if (hits > best) best = hits;
	}
	return best;
}
/**
* Record one tool result in the request state and decide whether it carried a
* high-signal change. Conservative by design: a bare new path is routine (an
* agent touches many files); it becomes hot only together with a real keyword
* overlap, and an overlap only counts when it clearly rises.
*/
function observe(state, observation, config, memories, memoryCap) {
	state.toolCalls += 1;
	state.recent.push({
		name: observation.name,
		args: observation.args,
		text: clampText(observation.text, 600),
		isError: observation.isError
	});
	if (state.recent.length > MAX_RECENT) state.recent.splice(0, state.recent.length - MAX_RECENT);
	state.toolText = clampText((state.toolText + "\n" + observation.text).trim(), TOOL_TEXT_CAP);
	if (!config.hotSignal) return;
	if (observation.isError || looksLikeError(observation.text)) {
		state.hot = true;
		return;
	}
	const newPaths = extractPaths(observation.text).filter((path) => !state.seenPaths.has(path));
	for (const path of newPaths) state.seenPaths.add(path);
	const overlap = memoryOverlap(observation.text, memories, memoryCap);
	if (newPaths.length > 0 && overlap >= 3) state.hot = true;
	if (overlap >= state.bestOverlap + 2 && overlap >= 4) state.hot = true;
	if (overlap > state.bestOverlap) state.bestOverlap = overlap;
}
/** Why (if at all) this step should inject another card. */
function triggerOf(state, step, config) {
	state.step = step;
	if (!config.enabled) return void 0;
	const every = Math.max(1, Math.floor(config.everySteps || 3));
	if (state.toolCalls >= every) return "tools";
	if (config.hotSignal && state.hot) return "hot";
}
/** Whether the per-request card budget still allows one more card. */
function canInjectCard(state, config) {
	if (!config.enabled) return false;
	if (state.cards >= Math.max(1, Math.floor(config.maxCardsPerRequest || 1))) return false;
	if (state.chars >= Math.max(200, Math.floor(config.maxCharsPerRequest || 6e3))) return false;
	return true;
}
/** Remaining per-request character budget for one more card. */
function remainingChars(state, config) {
	return Math.max(0, Math.floor(config.maxCharsPerRequest || 6e3) - state.chars);
}
/** Query for a repeat recall: this request's user text plus recent tool output. */
function buildQuery(state, cap) {
	return clampText([state.baseQuery, state.toolText].filter((part) => Boolean(part)).join("\n"), cap).trim();
}
/** Drop memories already injected in this request (dedupe). */
function freshItems(items, state, config) {
	if (!config.dedupe) return items;
	return items.filter((item) => !state.injectedIds.has(item.memoryId));
}
/** Record an injected card: advances the trigger baseline and the budgets. */
function commitCard(state, step, items, chars) {
	state.lastRecallStep = step;
	state.toolCalls = 0;
	state.hot = false;
	state.cards += 1;
	state.chars += chars;
	for (const item of items) state.injectedIds.add(item.memoryId);
}
/** Record a scan that produced no card, so the next trigger needs fresh calls. */
function commitScan(state, step) {
	state.lastRecallStep = step;
	state.toolCalls = 0;
	state.hot = false;
}
/** Rank this workspace's active memories against one query (same rules as P0). */
function recallScoped(store, workspaceKey, query, options) {
	const own = [];
	for (const entry of store.memories.entries()) {
		const record = entry[1];
		if (record.workspaceKey === workspaceKey && record.status === "active") own.push(entry);
	}
	return recallMemories(own, query, options);
}
/** The later-in-request card: a clearly distinct header plus the composite catalog. */
function renderRepeatCard(items, style, catalog) {
	if (items.length === 0 && !catalog) return "";
	const head = style === "plain" ? ["[SuperMemory 相关记忆 · 过程内补充]"] : ["[SuperMemory 相关记忆 · 过程内补充]", "执行过程中出现了此前未注入的相关记忆，仅供参考；与当前指令冲突时以当前指令为准。"];
	const lines = items.map((item, index) => index + 1 + ". " + item.text);
	const body = [...head, ...lines];
	if (catalog) body.push(catalog);
	return body.join("\n");
}
/** Create a tracker bounded to MAX_SESSIONS live requests (LRU on touch). */
function createTracker() {
	const states = /* @__PURE__ */ new Map();
	const touch = (sessionId, state) => {
		states.delete(sessionId);
		states.set(sessionId, state);
		while (states.size > MAX_SESSIONS) {
			const oldest = states.keys().next();
			if (oldest.done) break;
			states.delete(oldest.value);
		}
	};
	return {
		begin(sessionId, turn, step, query) {
			const state = newState(turn, step, query);
			touch(sessionId, state);
			return state;
		},
		ensure(sessionId, turn, step) {
			const existing = states.get(sessionId);
			if (existing && existing.turn === turn) return existing;
			const state = newState(turn, step, "");
			touch(sessionId, state);
			return state;
		},
		get(sessionId) {
			return states.get(sessionId);
		},
		observe(sessionId, observation, config, memories, memoryCap) {
			const state = states.get(sessionId);
			if (!state) return;
			observe(state, observation, config, memories, memoryCap);
		},
		hasHinted(sessionId, name) {
			return states.get(sessionId)?.hinted.has(name) ?? false;
		},
		markHinted(sessionId, name) {
			const state = states.get(sessionId);
			if (state) state.hinted.add(name);
		}
	};
}
// src/prestep.ts
/** Plain text of one message's content blocks. */
function textOf(message) {
	return (message.content ?? []).map((block) => block.type === "text" ? String(block.text ?? "") : "").filter(Boolean).join("\n");
}
/** Options shared by the opening recall and every repeat recall. */
function recallOptions(config) {
	return {
		limit: config.maxItems,
		minScore: config.minScore,
		halfLifeDays: config.halfLifeDays,
		now: Date.now()
	};
}
/** Attach the recall-injecting pre-step listener. Returns the effect disposer. */
function attachPreStep(ctx, store, config, logger) {
	if (!store || !config.enabled) return () => {};
	const activeStore = store;
	let createMessage;
	const ensureFactory = async () => {
		if (!createMessage) createMessage = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
		return createMessage;
	};
	const build = async (text) => {
		return (await ensureFactory())({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "supermemory",
				form: "recall"
			}
		});
	};
	const buildNotice = async (text) => {
		return (await ensureFactory())({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "supermemory",
				form: "notice",
				summary: "SuperMemory 中枢分支概览"
			}
		});
	};
	return ctx.on("agent/pre-step", async (payload, next) => {
		let decision;
		try {
			decision = await next();
		} catch (error) {
			logger.warn("supermemory: pre-step next() failed: " + String(error));
			throw error;
		}
		if (decision.kind !== "enter") return decision;
		const agent = payload.agent;
		const sessionId = String(agent?.id ?? "");
		const workspaceKey = workspaceKeyOf(agent?.session?.header?.cwd);
		const turn = Number(payload.turn) || 0;
		const step = Number(payload.step) || 0;
		try {
			const messages = decision.messages ?? [];
			const userText = messages.filter((message) => message.source?.kind === "user").map(textOf).filter(Boolean).join("\n").slice(0, 2e3);
			if (userText) {
				const state = config.tracker.begin(sessionId, turn, step, userText);
				const items = recallScoped(activeStore, workspaceKey, userText, recallOptions(config));
				const topicSets = matchTopicSets([...activeStore.topicsets.entries()], userText, 3);
				const card = renderRecallCard(items, config.injectStyle, topicSets).slice(0, config.maxChars);
				let branchesCard = "";
				if (isHubSession(activeStore, agent)) try {
					branchesCard = renderHubBranchesCard(listHubBranches(activeStore, sessionId), { now: Date.now() });
				} catch (error) {
					logger.warn("supermemory: hub branch card skipped: " + String(error).slice(0, 160));
				}
				if (!card && !branchesCard) return decision;
				const appended = [];
				if (card) {
					const message = await build(card);
					commitCard(state, step, items, card.length);
					appended.push(message);
				}
				if (branchesCard) appended.push(await buildNotice(branchesCard));
				return {
					...decision,
					messages: [...messages, ...appended]
				};
			}
			if (!config.repeat.enabled) return decision;
			const state = config.tracker.ensure(sessionId, turn, step);
			if (!canInjectCard(state, config.repeat)) return decision;
			if (!triggerOf(state, step, config.repeat)) return decision;
			const query = buildQuery(state, 2e3);
			if (!query) {
				commitScan(state, step);
				return decision;
			}
			const items = freshItems(recallScoped(activeStore, workspaceKey, query, recallOptions(config)), state, config.repeat);
			const entries = catalogFor(state.recent.map((entry) => entry.name), activeComposites(activeStore), void 0, 3);
			const strong = entries.some((entry) => entry.hits >= 2);
			const catalog = renderCatalog(entries);
			const text = renderRepeatCard(items, config.injectStyle, catalog);
			if (!text || items.length === 0 && !strong) {
				commitScan(state, step);
				return decision;
			}
			const capped = clampText(text, Math.min(config.maxChars, remainingChars(state, config.repeat)));
			if (!capped) {
				commitScan(state, step);
				return decision;
			}
			const message = await build(capped);
			commitCard(state, step, items, capped.length);
			return {
				...decision,
				messages: [...messages, message]
			};
		} catch (error) {
			logger.warn("supermemory: recall injection skipped: " + String(error).slice(0, 200));
			return decision;
		}
	});
}
// src/reconcile.ts
async function coldRead(ctx, sessionId, afterSeq) {
	const handle = await ctx.sessionPersistence.open(sessionId, "read");
	try {
		const { events } = await handle.read(afterSeq + 1);
		return events;
	} finally {
		await handle.close();
	}
}
/**
* Record one failure delivery (explicit failure, never disguised).
*
* The row is persisted FIRST and actually sent by the flush pass: the old code
* returned early when the hub was not live, and since the dispatch was already
* terminal nothing ever retried it — a restart-time failure was lost forever.
*/
async function failureDelivery(deps, dispatchId, record, reason) {
	const { store, logger } = deps;
	const deliveryId = "dlv-fail-" + record.branchSessionId;
	if (store.outbox.get(deliveryId)) return;
	const questionBlock = renderQuestionsBlock(openQuestionsOfDispatch(store, dispatchId));
	const payload = "[supermemory-relay " + record.branchSessionId + "]\n任务：" + record.task + "\n结果：" + reason + (questionBlock ? "\n\n" + questionBlock : "");
	await store.outbox.put(deliveryId, {
		dispatchId,
		kind: "single",
		payload,
		status: "pending",
		enqueuedAt: Date.now()
	});
	logger.info("supermemory: failure delivery " + deliveryId + " queued for the hub");
}
/** Run all three reconciliation paths once, detached from apply(). */
function runReconciliation(deps) {
	(async () => {
		const { ctx, store, logger } = deps;
		let factory;
		const ensureFactory = async () => {
			if (!factory) factory = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
			return factory;
		};
		for (const [dispatchId, record] of [...store.dispatches.entries()]) {
			if (record.status !== "dispatched" && record.status !== "queued") continue;
			if (!record.branchSessionId) continue;
			if (!deps.observe.enabled) continue;
			try {
				await settleOpenDispatches({
					ctx,
					store,
					logger,
					config: deps.observe
				}, record.branchSessionId);
				const after = store.dispatches.get(dispatchId);
				if (after && after.status !== record.status) logger.info(`supermemory: reconcile ${dispatchId}: settled from ${record.status} → ${after.status}`);
			} catch (error) {
				logger.warn(`supermemory: reconcile path1 ${dispatchId} failed: ${String(error).slice(0, 160)}`);
			}
		}
		for (const [dispatchId, record] of [...store.dispatches.entries()]) {
			if (record.status !== "queued" && record.status !== "dispatched") continue;
			if (!record.branchSessionId) continue;
			try {
				const events = (await coldRead(ctx, record.branchSessionId, -1)).filter((e) => e.seq > record.startSeq);
				const spliced = (e) => e.type === "agent/inbox/spliced" && (e.data?.inserted?.some((m) => m.source?.kind === "supermemory") ?? false);
				const claimedAt = events.findIndex((e) => e.type === "user/message" && isDispatchInput(e.data));
				const traced = claimedAt >= 0 || events.some(spliced);
				const branch = ctx.agents.get(record.branchSessionId) ?? branchHandles.get(record.branchSessionId)?.agent;
				if (!traced) {
					let target = branch;
					if (!target) try {
						const handle = await ctx.agents.resume({ resumeSessionId: record.branchSessionId });
						target = handle.agent;
						branchHandles.set(record.branchSessionId, {
							agent: handle.agent,
							dispose: () => handle.dispose()
						});
						logger.info(`supermemory: reconcile ${dispatchId}: resumed dead branch`);
						if (record.topicSetId) try {
							const topicTitle = store.topicsets.get(record.topicSetId)?.title ?? "";
							const named = await ensureMemberTitle(store, record.topicSetId, {
								sessionId: record.branchSessionId,
								kind: "root"
							}, topicTitle, record.task);
							applySessionTitle(ctx, record.branchSessionId, named, logger);
						} catch {}
					} catch (error) {
						logger.warn(`supermemory: reconcile ${dispatchId}: resume failed: ${String(error).slice(0, 160)}`);
					}
					if (!target) {
						await store.dispatches.update(dispatchId, (r) => ({
							...r,
							status: "failed",
							turnEndReason: "branch-died",
							updatedAt: Date.now()
						}));
						await failureDelivery(deps, dispatchId, record, "分支在执行前已不存在（重启/重载导致），未伪装成答案。");
						continue;
					}
					const make = await ensureFactory();
					target.followup(make({
						content: [{
							type: "text",
							text: `[supermemory-dispatch ${dispatchId}]\n任务：${record.task}\n\n（重启恢复：重新派发）\n遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。`
						}],
						source: {
							kind: "supermemory",
							form: "instructions"
						}
					}));
					logger.info(`supermemory: reconcile ${dispatchId}: re-followed branch`);
					continue;
				}
				if (claimedAt >= 0 && events.some((e, index) => index > claimedAt && e.type === "turn/end") || branch) continue;
				logger.info(`supermemory: reconcile ${dispatchId}: branch dead with input on disk; failing dispatch`);
				await store.dispatches.update(dispatchId, (r) => ({
					...r,
					status: "failed",
					turnEndReason: "branch-died",
					updatedAt: Date.now()
				}));
				await failureDelivery(deps, dispatchId, record, "分支在执行中消失（重启/重载导致），未伪装成答案。");
			} catch (error) {
				logger.warn(`supermemory: reconcile path3 ${dispatchId} failed: ${String(error).slice(0, 160)}`);
			}
		}
		for (const [deliveryId, item] of [...store.outbox.entries()]) {
			if (item.status !== "pending" && item.status !== "relayed") continue;
			let hubSessionId = item.dispatchId ? store.dispatches.get(item.dispatchId)?.hubSessionId : void 0;
			if (!hubSessionId && item.groupId) {
				const { groupMembers } = await import("./group-DvHNIRs9.js").then((n) => n.o);
				hubSessionId = groupMembers(store, item.groupId)[0]?.[1].hubSessionId;
			}
			if (!hubSessionId) continue;
			try {
				if ((await coldRead(ctx, hubSessionId, -1)).some((e) => e.type === "user/message" && e.data?.source?.deliveryId === deliveryId)) {
					await store.outbox.update(deliveryId, (r) => ({
						...r,
						status: "confirmed",
						relayedAt: Date.now()
					}));
					logger.info(`supermemory: reconcile ${deliveryId}: confirmed from hub log`);
					continue;
				}
				const hubAgent = ctx.agents.get(hubSessionId);
				if ([...hubAgent?.inbox?.nextTurn ?? [], ...hubAgent?.inbox?.nextStep ?? []].some((m) => m.source?.deliveryId === deliveryId)) {
					logger.info(`supermemory: reconcile ${deliveryId}: already queued in hub inbox; no re-send`);
					continue;
				}
				const hub = ctx.agents.get(hubSessionId);
				if (!hub) {
					logger.info(`supermemory: reconcile ${deliveryId}: hub not live; stays pending`);
					continue;
				}
				const make = await ensureFactory();
				hub.followup(make({
					content: [{
						type: "text",
						text: item.payload
					}],
					source: {
						kind: "supermemory",
						form: "relay",
						deliveryId
					}
				}));
				await store.outbox.update(deliveryId, (r) => ({
					...r,
					status: "relayed",
					relayedAt: Date.now()
				}));
				logger.info(`supermemory: reconcile ${deliveryId}: re-relayed to hub`);
			} catch (error) {
				logger.warn(`supermemory: reconcile path2 ${deliveryId} failed: ${String(error).slice(0, 160)}`);
			}
		}
		await flushObserve({
			ctx,
			store,
			logger,
			config: deps.observe
		});
		logger.info("supermemory: reconciliation pass complete");
	})().catch((error) => {
		deps.logger.warn(`supermemory: reconciliation pass failed: ${String(error).slice(0, 200)}`);
	});
}
// src/panel.ts
var panel_exports = /* @__PURE__ */ __exportAll({ SupermemoryPanelService: () => SupermemoryPanelService });
/**
* Sessions this panel resumed so the user can keep talking inside the panel.
* Deliberately NOT disposed here: `resume` makes the session live for the user,
* and killing it on a plugin reload would drop the conversation. DSH closes it
* with the app.
*/
const resumedChatHandles = /* @__PURE__ */ new Map();
let createMessage;
async function messageFactory() {
	if (!createMessage) createMessage = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return createMessage;
}
/**
* R18: the opening message of a 话题集会话 carries the set's three layers —
* title, tags, summary — before the user's own text, so the session starts from
* the index (and the client never has to re-send them).
*
* Exported as a pure seam: scripts/mechanism-smoke.mjs asserts the exact text
* without a DSH host.
*/
function buildTopicSetOpening(store, topicSetIds, message) {
	const body = String(message ?? "").trim();
	if (!body) return "";
	const sets = topicSetIds.map((id) => store.topicsets.get(id)).filter((record) => !!record);
	const titles = sets.map((record) => record.title).join("、");
	const tags = [...new Set(sets.flatMap((record) => record.keywords))].filter(Boolean);
	const summary = sets.map((record) => record.summary).filter(Boolean).join(" ");
	return [
		`[supermemory-topic-set] 话题集：${titles}${tags.length > 0 ? ` ｜标签: ${tags.join("、")}` : ""}`,
		...summary ? [`话题集梗概：${summary}`] : [],
		"",
		`用户开场：${body}`
	].join("\n");
}
/** Plain text of one model content block; tool calls stay visible as a marker. */
function chatBlockText(block) {
	if (!block || typeof block !== "object") return "";
	const record = block;
	switch (record.type) {
		case "text": return String(record.text ?? "");
		case "tool-call": return `（调用 ${String(record.name ?? "工具")}）`;
		case "image": return "（图片）";
		case "file": return "（文件）";
		default: return "";
	}
}
/** Join one message's content blocks into chat text. */
function chatMessageText(content, maxChars = 1200) {
	if (!Array.isArray(content)) return "";
	const text = content.map(chatBlockText).filter(Boolean).join("\n").trim();
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
/**
* R19 需求⑤: project a `sessionQuery.readSurface()` event list onto chat rows.
* Only model-visible conversation events are kept (user / assistant / tool);
* system prompts, developer declarations and lifecycle events are excluded.
* Exported pure for scripts/mechanism-smoke.mjs.
*/
function projectChatEvents(events, limit = 80) {
	const rows = [];
	for (const event of events) {
		const type = String(event?.type ?? "");
		const data = event?.data;
		if (!data || !data.message) continue;
		if (type === "user/message") {
			const text = chatMessageText(data.message.content);
			if (text) rows.push({
				seq: Number(event.seq ?? 0),
				role: "user",
				text,
				at: Number(event.time ?? 0)
			});
		} else if (type === "assistant/message") {
			const text = chatMessageText(data.message.content);
			if (text) rows.push({
				seq: Number(event.seq ?? 0),
				role: "assistant",
				text,
				at: Number(event.time ?? 0)
			});
		} else if (type === "tool/result") {
			const body = chatMessageText(data.message.content, 600);
			if (body) rows.push({
				seq: Number(event.seq ?? 0),
				role: "tool",
				text: data.isError ? `（工具失败）${body}` : body,
				at: Number(event.time ?? 0)
			});
		}
	}
	const cap = Math.max(1, Math.min(400, Math.floor(limit) || 80));
	const truncated = rows.length > cap;
	return {
		messages: truncated ? rows.slice(-cap) : rows,
		truncated
	};
}
/** Plain data service (no host imports needed at definition time). */
var SupermemoryPanelService = class {
	store;
	ctx;
	constructor(store, ctx) {
		this.store = store;
		this.ctx = ctx;
	}
	wk(cwd) {
		return workspaceKeyOf(cwd);
	}
	view(id, topicSet) {
		if (!topicSet) return {
			id,
			title: id,
			tags: [],
			summary: "",
			sessions: 0,
			live: 0,
			branches: []
		};
		const hubCounts = hubsByBranch(this.store);
		return {
			id,
			title: topicSet.title,
			tags: topicSet.keywords,
			summary: topicSet.summary,
			sessions: topicSet.members.length,
			live: topicSet.members.filter((member) => member.status === "live").length,
			branches: topicSet.members.map((m) => {
				const isBranch = m.kind === "fork" || isPluginBranchId(m.sessionId);
				const hubCount = isBranch ? hubCounts.get(m.sessionId)?.length : void 0;
				return {
					sessionId: m.sessionId,
					kind: isBranch ? "fork" : "root",
					title: m.title,
					status: m.status,
					...m.model ? { model: m.model } : {},
					...isBranch ? {
						topicSetId: id,
						topicSetTitle: topicSet.title
					} : {},
					...hubCount ? { hubs: hubCount } : {}
				};
			}),
			...topicSet.defaultModel ? { model: `${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}` } : {}
		};
	}
	/** Topic sets of one workspace, newest first. */
	listTopicSets(cwd) {
		const workspaceKey = this.wk(cwd);
		return listTopicSets(this.store, workspaceKey).map(([id, topicSet]) => this.view(id, topicSet));
	}
	/**
	* Activate a topic set for one session (panel click). AWAITED: the panel
	* reloads right after the click, and the domain updates its map only when the
	* queued write lands — a fire-and-forget write showed the OLD active set.
	*/
	async activate(sessionId, topicSetId) {
		if (!this.store.topicsets.get(topicSetId)) return false;
		await setRouting(this.store, sessionId, {
			activeTopicSetId: topicSetId,
			driftCount: 0
		});
		await touchTopicSet(this.store, topicSetId);
		noteTopicSetActivated({
			ctx: this.ctx,
			store: this.store,
			logger: { warn: (msg) => console.warn(msg) }
		}, topicSetId);
		return true;
	}
	/** The active topic set of one session. */
	activeTopicSet(sessionId) {
		const active = getRouting(this.store, sessionId)?.activeTopicSetId;
		if (!active) return void 0;
		const topicSet = this.store.topicsets.get(active);
		if (!topicSet) return void 0;
		return this.view(active, topicSet);
	}
	/** Full panel snapshot: hub session, topic sets, memories, counts. */
	hubState(cwd, sessionId) {
		const workspaceKey = this.wk(cwd);
		const topicSets = listTopicSets(this.store, workspaceKey).map(([id, topicSet]) => this.view(id, topicSet));
		const memories = [];
		for (const [id, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey) continue;
			memories.push({
				id,
				title: record.title,
				tags: record.keywords,
				text: record.text,
				key: record.key,
				status: record.status,
				sourceSessionId: record.sourceSessionId,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt
			});
		}
		memories.sort((a, b) => b.updatedAt - a.updatedAt);
		let requirements = 0;
		for (const [, record] of this.store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open") requirements++;
		let dispatches = 0;
		for (const [, record] of this.store.dispatches.entries()) if (record.status !== "delivered" && record.status !== "failed" && record.status !== "interrupted") dispatches++;
		const tools = [...this.store.toolMemory.entries()].filter(([, r]) => r.kind === "composite").length;
		return {
			sessionId,
			workspaceKey,
			...getRouting(this.store, sessionId)?.activeTopicSetId ? { activeTopicSetId: getRouting(this.store, sessionId).activeTopicSetId } : {},
			topicSets,
			memories,
			counts: {
				memories: memories.length,
				requirements,
				episodes: this.store.episodes.size,
				dispatches,
				tools
			}
		};
	}
	/** Memories of one workspace, newest first; `query` filters by text/keywords. */
	listMemories(cwd, query, limit) {
		const workspaceKey = this.wk(cwd);
		const tokens = query ? new Set(tokenize(query)) : /* @__PURE__ */ new Set();
		const rows = [];
		for (const [id, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey) continue;
			const titleBag = new Set(tokenize(record.title));
			const tagBag = new Set(tokenize(record.keywords.join(" ")));
			const bodyBag = new Set(tokenize(`${record.text} ${record.key ?? ""}`));
			let score = 0;
			for (const token of tokens) if (titleBag.has(token)) score += 4;
			else if (tagBag.has(token)) score += 3;
			else if (bodyBag.has(token)) score += 1;
			if (tokens.size > 0 && score === 0) continue;
			rows.push({
				score,
				view: {
					id,
					title: record.title,
					tags: record.keywords,
					text: record.text,
					key: record.key,
					status: record.status,
					sourceSessionId: record.sourceSessionId,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt
				}
			});
		}
		rows.sort((a, b) => b.score - a.score || b.view.updatedAt - a.view.updatedAt);
		const cap = Math.max(1, Math.min(200, Number(limit) || 100));
		return rows.slice(0, cap).map((row) => row.view);
	}
	/** Create one memory (panel editor). Mirrors memory_remember semantics. */
	async createMemory(cwd, text, key, title, tags) {
		const workspaceKey = this.wk(cwd);
		const body = String(text ?? "").trim();
		if (!body) return {
			status: "error",
			message: "记忆文本不能为空。"
		};
		const cleanTitle = String(title ?? "").trim().slice(0, 48) || deriveTitle(body);
		const cleanTags = mergeTags(normalizeTags(tags), tagsOfBody(body));
		const stableKey = key?.trim() || void 0;
		const now = Date.now();
		for (const [memoryId, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey || record.status !== "active") continue;
			if (stableKey && record.key === stableKey) {
				if (record.text.trim().toLowerCase() === body.toLowerCase()) return {
					status: "ok",
					message: "该 key 已存相同内容，未重复写入。",
					id: memoryId
				};
				return {
					status: "error",
					message: `key「${stableKey}」已存不同内容，请先修改或删除原记忆。`,
					id: memoryId
				};
			}
			if (!stableKey && record.text.trim().toLowerCase() === body.toLowerCase()) return {
				status: "ok",
				message: "相同记忆已存在。",
				id: memoryId
			};
		}
		const memoryId = newId("mem");
		const memory = {
			workspaceKey,
			title: cleanTitle,
			text: body,
			key: stableKey,
			keywords: cleanTags,
			sourceSessionId: "",
			sourceSeq: 0,
			status: "active",
			createdAt: now,
			updatedAt: now
		};
		await this.store.memories.put(memoryId, memory);
		return {
			status: "ok",
			message: "已记住。",
			id: memoryId
		};
	}
	/** Update one memory's text (and optional key). */
	async updateMemory(cwd, id, text, key, title, tags) {
		const workspaceKey = this.wk(cwd);
		const record = this.store.memories.get(id);
		if (!record || record.workspaceKey !== workspaceKey) return {
			status: "error",
			message: "记忆不存在或不属于当前工作区。"
		};
		const body = String(text ?? "").trim();
		if (!body) return {
			status: "error",
			message: "记忆文本不能为空。"
		};
		const verdict = assessConclusion(body);
		if (!verdict.ok) return {
			status: "error",
			message: verdict.message
		};
		await this.store.memories.update(id, (r) => ({
			...r,
			text: body,
			...key !== void 0 ? { key: key.trim() || void 0 } : {},
			...title !== void 0 ? { title: String(title).trim().slice(0, 48) || deriveTitle(body) } : {},
			...tags !== void 0 ? { keywords: mergeTags(normalizeTags(tags), tagsOfBody(body)) } : {},
			updatedAt: Date.now()
		}));
		return {
			status: "ok",
			message: "已更新。",
			id
		};
	}
	/** Delete one memory. */
	async deleteMemory(cwd, id) {
		const workspaceKey = this.wk(cwd);
		const record = this.store.memories.get(id);
		if (!record || record.workspaceKey !== workspaceKey) return {
			status: "error",
			message: "记忆不存在或不属于当前工作区。"
		};
		await this.store.memories.delete(id);
		return {
			status: "ok",
			message: "已删除。",
			id
		};
	}
	/** Toggle one memory's status (active / superseded). */
	async setMemoryStatus(cwd, id, status) {
		const workspaceKey = this.wk(cwd);
		const record = this.store.memories.get(id);
		if (!record || record.workspaceKey !== workspaceKey) return {
			status: "error",
			message: "记忆不存在或不属于当前工作区。"
		};
		if (status !== "active" && status !== "superseded") return {
			status: "error",
			message: "status 仅支持 active / superseded。"
		};
		await this.store.memories.update(id, (r) => ({
			...r,
			status,
			updatedAt: Date.now()
		}));
		return {
			status: "ok",
			message: status === "active" ? "已启用。" : "已停用。",
			id
		};
	}
	/**
	* R18: hub sessions of this workspace (no parent, not a subagent, not a
	* topic-set member). Read through the host session-query seam; a host
	* without it degrades to the live session list, then to an empty rail.
	*/
	listHubSessions(cwd) {
		return listHubSessions(this.ctx, this.store, cwd);
	}
	/**
	* R19 协同②: the hub → branch association of one hub session.
	*
	* The rows are projected from the durable dispatch table (`hubSessionId`), so
	* this works for a live hub, a persisted hub, and for a branch shared by
	* several hubs. `cwd` is the panel's current workspace: a row whose topic set
	* belongs to another workspace is filtered out (defence in depth; the caller
	* already scopes by workspace).
	*/
	listHubBranches(cwd, hubSessionId, limit = 20) {
		const id = String(hubSessionId ?? "").trim();
		if (!id) return [];
		const workspaceKey = this.wk(cwd);
		return listHubBranches(this.store, id, limit).filter((row) => {
			if (!row.topicSetId) return true;
			const topicSet = this.store.topicsets.get(row.topicSetId);
			return !topicSet || topicSet.workspaceKey === workspaceKey;
		});
	}
	/**
	* R19 需求⑤: read one session's model-visible conversation for the in-panel
	* chat. Capability evidence: `ctx.sessionQuery.readSurface(id)` returns the
	* cloned current surface (dsh-session-query/src/index.ts:322), which is the
	* same fold the model itself sees — no transcript mutation, no resume.
	*
	* A host without `sessionQuery` (older/minimal profile) degrades to an empty
	* list with an explicit `note`, never to an error: the panel keeps working.
	*/
	async readSessionMessages(sessionId, limit = 80) {
		const id = String(sessionId ?? "").trim();
		if (!id) return {
			sessionId: "",
			title: "",
			live: false,
			messages: [],
			truncated: false,
			note: "缺少会话 id。"
		};
		const ctx = this.ctx;
		let live = false;
		let agents;
		try {
			agents = ctx?.get?.("agents");
			live = !!agents?.get?.(id);
		} catch {
			live = false;
		}
		let query;
		try {
			query = ctx?.get?.("sessionQuery");
		} catch {
			query = void 0;
		}
		let title = id.slice(-4);
		try {
			if (query?.readTitleSnapshots) {
				const observedTitle = (await query.readTitleSnapshots([id])).find((row) => row.status === "fulfilled" && row.sessionId === id)?.value?.title?.title;
				if (typeof observedTitle === "string" && observedTitle.trim()) title = observedTitle.trim();
			}
		} catch {}
		if (!query?.readSurface) return {
			sessionId: id,
			title,
			live,
			messages: [],
			truncated: false,
			note: "宿主未提供 sessionQuery，无法读取会话消息；可在 DSH 中打开该会话查看。"
		};
		try {
			const projected = projectChatEvents((await query.readSurface(id))?.events ?? [], limit);
			return {
				sessionId: id,
				title,
				live,
				messages: projected.messages,
				truncated: projected.truncated
			};
		} catch (error) {
			return {
				sessionId: id,
				title,
				live,
				messages: [],
				truncated: false,
				note: `读取会话失败：${String(error).slice(0, 160)}`
			};
		}
	}
	/**
	* R19 需求⑤: send one user message directly into a hub/branch session from
	* the panel. A live agent is used as-is (`ctx.agents.get`); a persisted but
	* idle session is resumed once (`ctx.agents.resume({resumeSessionId})` — the
	* documented resume entry, dsh-agent/src/index.ts:429) and kept live inside
	* this panel so the reply can be polled. The session's own view in DSH shows
	* the same messages: the panel is a second surface, not a parallel transcript.
	*/
	async sendSessionMessage(sessionId, text) {
		const id = String(sessionId ?? "").trim();
		const body = String(text ?? "").trim();
		if (!id) return {
			status: "error",
			message: "缺少会话 id。"
		};
		if (!body) return {
			status: "error",
			message: "消息不能为空。"
		};
		if (Array.from(body).length > 8e3) return {
			status: "error",
			message: "消息过长（上限 8000 字）。"
		};
		const ctx = this.ctx;
		if (!ctx) return {
			status: "error",
			message: "宿主上下文不可用。"
		};
		let agents;
		try {
			agents = ctx.get?.("agents");
		} catch {
			agents = void 0;
		}
		if (!agents) return {
			status: "error",
			message: "宿主未提供 agents 服务，无法发送消息。"
		};
		let message;
		try {
			message = (await messageFactory())({
				content: [{
					type: "text",
					text: body
				}],
				source: { kind: "supermemory" }
			});
		} catch (error) {
			return {
				status: "error",
				message: `宿主消息工厂不可用：${String(error).slice(0, 160)}`
			};
		}
		let agent = agents.get?.(id);
		let resumed = false;
		if (!agent) {
			if (typeof agents.resume !== "function") return {
				status: "error",
				message: "该会话未运行，且宿主不支持恢复；请点「打开会话」在 DSH 中打开后再发送。"
			};
			try {
				const handle = await agents.resume({
					resumeSessionId: id,
					setup: compositionSetup(ctx, {}, { warn: (msg) => console.warn(msg) })
				});
				resumedChatHandles.set(id, handle);
				agent = handle.agent;
				resumed = true;
			} catch (error) {
				return {
					status: "error",
					message: `会话未运行且恢复失败：${String(error).slice(0, 160)}。请点「打开会话」在 DSH 中打开后再发送。`
				};
			}
		}
		try {
			if (typeof agent?.followup !== "function") return {
				status: "error",
				message: "该会话的 agent 不可写（followup 不可用）。"
			};
			agent.followup(message);
			return {
				status: "ok",
				message: resumed ? "会话已恢复，消息已发送。" : "消息已发送。",
				id
			};
		} catch (error) {
			return {
				status: "error",
				message: `发送失败：${String(error).slice(0, 160)}`
			};
		}
	}
	/**
	* R18: derive the title + tags a memory body implies, so the panel's editor
	* can fill the two index fields instead of leaving them blank. Pure reuse of
	* the retrieval rules (same derivation the tool layer applies on write).
	*/
	suggestMemoryShape(text) {
		const body = String(text ?? "").trim();
		return {
			title: deriveTitle(body),
			tags: mergeTags([], tagsOfBody(body))
		};
	}
	/**
	* Create a topic set (panel). R18: title + tags + summary are all written on
	* creation — omitted tags fall back to the title/body vocabulary, so a set
	* created from the panel is never index-less.
	*/
	async createTopicSet(cwd, title, tags, summary) {
		const workspaceKey = this.wk(cwd);
		const name = String(title ?? "").trim();
		if (!name) return {
			status: "error",
			message: "标题不能为空。"
		};
		const body = String(summary ?? "").slice(0, 500);
		const explicitTags = normalizeTags(tags);
		const keywords = mergeTags(explicitTags, tagsOfBody(`${name} ${body}`));
		const id = await createTopicSet(this.store, {
			workspaceKey,
			title: clipEllipsis(name, 60),
			summary: body,
			keywords
		});
		let shapeNote = "";
		try {
			if (await fillTopicShapeOnCreate({
				ctx: this.ctx,
				store: this.store,
				logger: { warn: (msg) => console.warn(msg) }
			}, id, body, {
				tags: explicitTags.length === 0,
				summary: body.trim().length === 0
			})) shapeNote = "（已由模型补全索引）";
		} catch (error) {
			console.warn("supermemory: topic-set shape generation skipped: " + String(error).slice(0, 160));
		}
		const stored = this.store.topicsets.get(id);
		const finalTags = stored?.keywords ?? keywords;
		const tagText = finalTags.length > 0 ? `（标签：${finalTags.join("、")}）` : "";
		return {
			status: "ok",
			message: `已创建话题集『${stored?.title ?? clipEllipsis(name, 60)}』${tagText}${shapeNote}。`,
			id
		};
	}
	/** Update a topic set's summary (panel). */
	async updateTopicSetSummary(id, summary, tags) {
		const record = this.store.topicsets.get(id);
		if (!record) return {
			status: "error",
			message: "话题集不存在。"
		};
		const nextKeywords = tags !== void 0 ? normalizeTags(tags) : record.keywords;
		await updateTopicSetSummary(this.store, id, String(summary ?? "").slice(0, 500), nextKeywords);
		return {
			status: "ok",
			message: "标签与正文已更新。",
			id
		};
	}
	/**
	* R3: create a session bound to one or more topic sets (话题集会话).
	* The session is a fresh root member of every selected topic set.
	*/
	async createTopicSetSession(cwd, topicSetIds, options = {}, firstMessage = "") {
		const ctx = this.ctx;
		if (!ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法创建会话。"
		};
		const ids = (topicSetIds ?? []).filter((id) => this.store.topicsets.get(id));
		if (ids.length === 0) return {
			status: "error",
			message: "请至少选择一个有效话题集。"
		};
		if (!cwd) return {
			status: "error",
			message: "无法确定工作区。"
		};
		const titles = ids.map((id) => this.store.topicsets.get(id)?.title ?? id);
		const created = await this.createSessionWithOptions(cwd, options);
		if ("error" in created) return {
			status: "error",
			message: created.error
		};
		const sessionId = created.sessionId;
		try {
			const named = await ensureMemberTitle(this.store, ids[0], {
				sessionId,
				kind: "root"
			}, titles.join("、"), "");
			for (const id of ids.slice(1)) {
				await addMember(this.store, id, {
					sessionId,
					kind: "root",
					title: named
				});
				await touchTopicSet(this.store, id);
			}
			await touchTopicSet(this.store, ids[0]);
			applySessionTitle(ctx, sessionId, named, { warn: () => {} });
			try {
				await attachBranchToWorkspace(ctx, sessionId, cwd, {
					warn: () => {},
					info: () => {}
				});
			} catch {}
			const delivered = await this.deliverFirstMessage(created.handle, buildTopicSetOpening(this.store, ids, firstMessage));
			const base = `已创建话题集会话（${titles.join("、")}）`;
			if (delivered === true) return {
				status: "ok",
				message: `${base}并发送首条消息。`,
				id: sessionId
			};
			if (typeof delivered === "string") return {
				status: "ok",
				message: `${base}，但首条消息发送失败：${delivered}`,
				id: sessionId
			};
			return {
				status: "ok",
				message: `${base}。`,
				id: sessionId
			};
		} catch (error) {
			return {
				status: "error",
				message: `创建会话失败：${String(error).slice(0, 200)}`
			};
		}
	}
	/**
	* R7: create one plain hub session carrying the quick-launcher choices. The
	* session belongs to NO topic set; it is named, attached to its workspace
	* and opened by the client. An empty option set reproduces the shell's
	* plain new session (host defaults for preset/model/permission).
	*/
	async createHubSession(cwd, options = {}, firstMessage = "") {
		const created = await this.createSessionWithOptions(cwd, options);
		if ("error" in created) return {
			status: "error",
			message: created.error
		};
		const title = "新会话 · " + created.sessionId.slice(-4);
		await this.finishSession(created.sessionId, cwd, title);
		const delivered = await this.deliverFirstMessage(created.handle, firstMessage);
		if (delivered === true) return {
			status: "ok",
			message: "已创建中枢会话并发送首条消息。",
			id: created.sessionId
		};
		if (typeof delivered === "string") return {
			status: "ok",
			message: `中枢会话已创建，但首条消息发送失败：${delivered}`,
			id: created.sessionId
		};
		return {
			status: "ok",
			message: "已创建中枢会话。",
			id: created.sessionId
		};
	}
	/**
	* R8: push the composer's opening message into the session the panel just
	* created, so a hub conversation can be started from the SuperMemory page
	* without navigating to the shell's new-session page. Returns `true` when
	* delivered, `false` when there was nothing to send, or the failure text —
	* a failed delivery never discards the already-created session.
	*/
	async deliverFirstMessage(handle, text) {
		const body = String(text ?? "").trim();
		if (!body) return false;
		try {
			const message = (await messageFactory())({
				content: [{
					type: "text",
					text: body
				}],
				source: { kind: "supermemory" }
			});
			handle.agent.followup(message);
			return true;
		} catch (error) {
			return String(error).slice(0, 200);
		}
	}
	/**
	* R7: create the bare session with the quick-launcher choices applied. The
	* agent preset rides the creation metadata; the model rides the agent
	* options (route fallback until the session records a selection); the
	* permission preset is applied right after creation because its service
	* owns the session knob events. Every choice is optional.
	*/
	async createSessionWithOptions(cwd, options) {
		const ctx = this.ctx;
		if (!ctx) return { error: "宿主上下文不可用，无法创建会话。" };
		if (!cwd) return { error: "无法确定工作区。" };
		const sessionId = newId("session");
		const meta = { cwd };
		if (options.agentPreset) meta.agentPreset = options.agentPreset;
		const agentOptions = {};
		if (options.model?.provider && options.model?.model) {
			agentOptions.provider = options.model.provider;
			agentOptions.model = options.model.model;
			if (options.model.reasoningEffort) agentOptions.reasoningEffort = options.model.reasoningEffort;
		}
		let handle;
		try {
			handle = await ctx.agents.create({
				sessionId,
				meta,
				...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
			});
		} catch (error) {
			return { error: `创建会话失败：${String(error).slice(0, 200)}` };
		}
		this.applyPermission(sessionId, options.permission);
		return {
			sessionId,
			handle
		};
	}
	/** Name the host session and attach it to its workspace (best-effort). */
	async finishSession(sessionId, cwd, title) {
		const ctx = this.ctx;
		if (!ctx) return;
		applySessionTitle(ctx, sessionId, title, { warn: () => {} });
		try {
			await attachBranchToWorkspace(ctx, sessionId, cwd, {
				warn: () => {},
				info: () => {}
			});
		} catch {}
	}
	/**
	* R7: apply one permission preset to a just-created session. The preset
	* value comes from the host catalog (listPermissions); an unknown value or
	* a missing service is reported, never faked.
	*/
	applyPermission(sessionId, preset) {
		if (!preset) return;
		const ctx = this.ctx;
		if (!ctx) return;
		try {
			const service = ctx.get("permissionPresets");
			const agent = ctx.agents.get(sessionId);
			if (!service || typeof service.set !== "function" || !agent?.session) return;
			service.set(agent.session, preset);
		} catch (error) {
			console.warn("supermemory: permission preset apply failed: " + String(error).slice(0, 160));
		}
	}
	/** R7: the agent-preset roster for the hub quick launcher. */
	async listAgentPresets() {
		const ctx = this.ctx;
		if (!ctx) return [];
		try {
			const service = ctx.get("agentPresets");
			if (!service || typeof service.list !== "function") return [];
			const rows = await service.list();
			const defaultId = service.defaultId;
			return rows.map((row) => ({
				id: row.id,
				...row.name ? { name: row.name } : {},
				...row.description ? { description: row.description } : {},
				isDefault: row.id === defaultId
			}));
		} catch (error) {
			console.warn("supermemory: agent preset roster unavailable: " + String(error).slice(0, 160));
			return [];
		}
	}
	/** R7: the runtime provider/model catalog for the hub quick launcher. */
	async listModelCatalog() {
		const ctx = this.ctx;
		if (!ctx) return {
			providers: [],
			models: []
		};
		try {
			return await enumerateModels(ctx);
		} catch (error) {
			console.warn("supermemory: model catalog unavailable: " + String(error).slice(0, 160));
			return {
				providers: [],
				models: []
			};
		}
	}
	/** R7: the process-level permission catalog for the hub quick launcher. */
	async listPermissions() {
		const ctx = this.ctx;
		if (!ctx) return {
			options: [],
			defaultPreset: ""
		};
		try {
			const service = ctx.get("permissionPresets");
			if (!service || typeof service.catalog !== "function") return {
				options: [],
				defaultPreset: ""
			};
			return service.catalog();
		} catch (error) {
			console.warn("supermemory: permission catalog unavailable: " + String(error).slice(0, 160));
			return {
				options: [],
				defaultPreset: ""
			};
		}
	}
	/**
	* R5: reply into a topic set. Resolves the topic set's live member (or the
	* most recent one, creating a fresh branch when none exists) and delivers
	* the text as a followup; the result names the session the reply landed in.
	*/
	async followupTopicSet(cwd, topicSetId, text) {
		const ctx = this.ctx;
		if (!ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法回复。"
		};
		const topicSet = getTopicSet(this.store, topicSetId);
		if (!topicSet) return {
			status: "error",
			message: "话题集不存在。"
		};
		const body = String(text ?? "").trim();
		if (!body) return {
			status: "error",
			message: "回复内容不能为空。"
		};
		if (!cwd) return {
			status: "error",
			message: "无法确定工作区。"
		};
		let sessionId;
		for (const member of [...topicSet.members].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) if (branchHandles.has(member.sessionId)) {
			sessionId = member.sessionId;
			break;
		}
		if (!sessionId) {
			for (const member of [...topicSet.members].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) if (ctx.agents.get(member.sessionId)) {
				sessionId = member.sessionId;
				break;
			}
		}
		if (!sessionId && topicSet.members.length > 0) {
			const target = [...topicSet.members].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
			try {
				const handle = await ctx.agents.resume({ resumeSessionId: target.sessionId });
				branchHandles.set(target.sessionId, {
					agent: handle.agent,
					dispose: () => handle.dispose()
				});
				sessionId = target.sessionId;
			} catch {}
		}
		if (!sessionId) {
			sessionId = newId("branch");
			try {
				const handle = await ctx.agents.create({
					sessionId,
					meta: { cwd }
				});
				branchHandles.set(sessionId, {
					agent: handle.agent,
					dispose: () => handle.dispose()
				});
			} catch (error) {
				return {
					status: "error",
					message: `创建分支失败：${String(error).slice(0, 200)}`
				};
			}
			const named = await ensureMemberTitle(this.store, topicSetId, {
				sessionId,
				kind: "root"
			}, topicSet.title, body);
			applySessionTitle(ctx, sessionId, named, { warn: () => {} });
			try {
				await attachBranchToWorkspace(ctx, sessionId, cwd, {
					warn: () => {},
					info: () => {}
				});
			} catch {}
		}
		try {
			const message = (await messageFactory())({
				content: [{
					type: "text",
					text: `[supermemory-panel-reply]\n话题集：${topicSet.title}\n用户回复：${body}\n\n你是该话题集的工作分支：按用户回复继续执行并汇报结果。遇到分歧按最合理解释执行，不要停下来等确认；需要用户裁决时用 memory_raise_question 上交中枢汇总（不要在本分支里直接向用户提问）。`
				}],
				source: { kind: "supermemory" }
			});
			const agent = branchHandles.get(sessionId)?.agent ?? ctx.agents.get(sessionId);
			if (!agent) return {
				status: "error",
				message: "分支会话不在线，回复未送达。",
				id: sessionId
			};
			agent.followup(message);
			await touchTopicSet(this.store, topicSetId);
			return {
				status: "ok",
				message: "已送入话题集分支。",
				id: sessionId
			};
		} catch (error) {
			return {
				status: "error",
				message: `回复失败：${String(error).slice(0, 200)}`,
				id: sessionId
			};
		}
	}
	/** R6: list composite tools (self-generated) with descriptions. */
	listTools() {
		const rows = [];
		for (const [id, record] of this.store.toolMemory.entries()) {
			if (record.kind !== "composite") continue;
			let steps = [];
			let parameters = [];
			let name = id;
			let kind = "sequence";
			let entry;
			let doc;
			let scope;
			let runnable;
			let dryRunArg;
			let writeConfirm;
			try {
				const spec = JSON.parse(record.entry);
				name = spec.name ?? id;
				kind = spec.kind === "capability" ? "capability" : "sequence";
				steps = (spec.steps ?? []).map((s) => s.tool);
				parameters = (spec.parameters ?? []).map((p) => p.name);
				entry = spec.entry;
				doc = spec.doc;
				scope = spec.scope;
				runnable = spec.runnable;
				dryRunArg = spec.dryRunArg;
				writeConfirm = spec.writeConfirm;
			} catch {}
			rows.push({
				id,
				name,
				title: record.title || record.description.slice(0, 48),
				tags: record.tags,
				description: record.description,
				steps,
				parameters,
				useCount: record.useCount,
				status: record.status,
				live: liveCompositeSpecs.has(name),
				kind,
				entry,
				doc,
				scope,
				runnable,
				dryRunArg,
				writeConfirm
			});
		}
		rows.sort((a, b) => a.name.localeCompare(b.name));
		return rows;
	}
	/** R6: edit one composite tool (description / steps / parameters / status). */
	async editTool(id, patch) {
		if (!this.ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法修改工具。"
		};
		return editCompositeTool(this.ctx, this.store, id, patch);
	}
	/**
	* R6+: delete one composite tool for good (unregister + durable row + the
	* sequence signal that created it). The panel's delete button; a retired
	* tool is deleted the same way.
	*/
	async deleteTool(id) {
		if (!this.ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法删除工具。"
		};
		return deleteCompositeTool(this.ctx, this.store, id);
	}
	/**
	* R22: run one capability tool (its entry command inside its scope directory).
	* Dry-run is the default (dryRunArg appended); a writeConfirm capability
	* refuses a real run without an explicit confirm and answers
	* status 'needs-confirm' WITHOUT executing anything.
	*/
	async runTool(id, options = {}) {
		const record = this.store.toolMemory.get(id);
		if (!record || record.kind !== "composite" || !record.entry) return {
			status: "failed",
			stdout: "",
			stderr: "",
			durationMs: 0,
			dryRun: Boolean(options.dryRun),
			command: "",
			summary: "组合工具不存在。"
		};
		let spec;
		try {
			spec = JSON.parse(record.entry);
		} catch {
			return {
				status: "failed",
				stdout: "",
				stderr: "",
				durationMs: 0,
				dryRun: Boolean(options.dryRun),
				command: "",
				summary: "工具定义损坏，无法执行。"
			};
		}
		if (spec.kind !== "capability" || !spec.entry) return {
			status: "failed",
			stdout: "",
			stderr: "",
			durationMs: 0,
			dryRun: Boolean(options.dryRun),
			command: "",
			summary: "只有能力（capability）可以一键执行；序列组合工具请直接调用它。"
		};
		const result = runCapability(spec, {
			dryRun: options.dryRun,
			confirm: options.confirm
		});
		if (result.status !== "needs-confirm") bumpCompositeUse(this.store, spec.name);
		return result;
	}
	/**
	* Sidebar badge projection (GUI 问题③; R19 需求③④ root cause fix).
	*
	* Membership alone does NOT make a branch: `createTopicSetSession` adds the
	* session it creates as `kind: 'root'` — the set's own hub conversation, which
	* must keep its 中枢 role and be badged as 「话题集」.
	*
	* A branch is (a) any plugin-minted `branch-*`/`fork-*` id — a fresh dispatch
	* is recorded as kind 'root', so the id prefix is the only reliable witness —
	* or (b) a `kind:'fork'` member. R18 treated every member as a branch, so a
	* hub that owned a set showed the wrong 分支 badge (and the same conflation
	* removed it from the hub rail / disabled its hub prompt).
	*
	* Tiers: a branch hit wins; otherwise a root hit yields `hub-set`; otherwise a
	* plain hub. Multiple hits inside one tier resolve to the newest
	* `lastActiveAt`. Archived sets never badge.
	*/
	sessionBadge(sessionId) {
		const pluginBranch = isPluginBranchId(sessionId);
		let bestFork;
		let bestRoot;
		for (const [topicSetId, topicSet] of this.store.topicsets.entries()) {
			if (topicSet.status !== "active") continue;
			for (const member of topicSet.members) {
				if (member.sessionId !== sessionId) continue;
				if (pluginBranch || member.kind === "fork") {
					if (!bestFork || member.lastActiveAt > bestFork.lastActiveAt) bestFork = {
						topicSetId,
						title: topicSet.title,
						status: member.status,
						lastActiveAt: member.lastActiveAt
					};
				} else if (!bestRoot || member.lastActiveAt > bestRoot.lastActiveAt) bestRoot = {
					topicSetId,
					title: topicSet.title,
					lastActiveAt: member.lastActiveAt
				};
			}
		}
		if (bestFork) return {
			kind: "branch",
			topicSetId: bestFork.topicSetId,
			topicSetTitle: bestFork.title,
			status: bestFork.status
		};
		if (bestRoot) return {
			kind: "hub-set",
			topicSetId: bestRoot.topicSetId,
			topicSetTitle: bestRoot.title
		};
		return { kind: "hub" };
	}
};
/** Remote descriptors for the panel service (wire contract). */
const PANEL_DESCRIPTORS = Object.freeze([
	{
		id: "dsh-supermemory#supermemoryPanel/listTopicSets",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listTopicSets",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#TopicSetViews",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "cwd",
			wire: "cwd",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Cwd",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/activate",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "activate",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#ActivateResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#SessionId",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "topicSetId",
			wire: "topicSetId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#TopicSetId",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/activeTopicSet",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "activeTopicSet",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#TopicSetView",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#SessionId",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/hubState",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "hubState",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#HubState",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "cwd",
			wire: "cwd",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Cwd",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#SessionId",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listMemories",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listMemories",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MemoryViews",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "query",
				wire: "query",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Query",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "limit",
				wire: "limit",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Limit",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/createMemory",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "createMemory",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "text",
				wire: "text",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Text",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "key",
				wire: "key",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Key",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "title",
				wire: "title",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Title",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "tags",
				wire: "tags",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Tags",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/updateMemory",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "updateMemory",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "id",
				wire: "id",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Id",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "text",
				wire: "text",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Text",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "key",
				wire: "key",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Key",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "title",
				wire: "title",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Title",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "tags",
				wire: "tags",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Tags",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/deleteMemory",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "deleteMemory",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "cwd",
			wire: "cwd",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Cwd",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "id",
			wire: "id",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Id",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/setMemoryStatus",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "setMemoryStatus",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "id",
				wire: "id",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Id",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "status",
				wire: "status",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Status",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/createTopicSet",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "createTopicSet",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "title",
				wire: "title",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Title",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "tags",
				wire: "tags",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Tags",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "summary",
				wire: "summary",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Summary",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/updateTopicSetSummary",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "updateTopicSetSummary",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "id",
				wire: "id",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Id",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "summary",
				wire: "summary",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Summary",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "tags",
				wire: "tags",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Tags",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/createTopicSetSession",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "createTopicSetSession",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "topicSetIds",
				wire: "topicSetIds",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#TopicSetIds",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "options",
				wire: "options",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#SessionOptions",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "firstMessage",
				wire: "firstMessage",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#FirstMessage",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/createHubSession",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "createHubSession",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "options",
				wire: "options",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#SessionOptions",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "firstMessage",
				wire: "firstMessage",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#FirstMessage",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listAgentPresets",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listAgentPresets",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#AgentPresetViews",
			create: () => ({ parse: (v) => v })
		},
		parameters: []
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listModelCatalog",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listModelCatalog",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#ModelCatalogView",
			create: () => ({ parse: (v) => v })
		},
		parameters: []
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listPermissions",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listPermissions",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#PermissionCatalogView",
			create: () => ({ parse: (v) => v })
		},
		parameters: []
	},
	{
		id: "dsh-supermemory#supermemoryPanel/followupTopicSet",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "followupTopicSet",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "topicSetId",
				wire: "topicSetId",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#TopicSetId",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "text",
				wire: "text",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Text",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listTools",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listTools",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#ToolViews",
			create: () => ({ parse: (v) => v })
		},
		parameters: []
	},
	{
		id: "dsh-supermemory#supermemoryPanel/editTool",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "editTool",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "id",
			wire: "id",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Id",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "patch",
			wire: "patch",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#ToolPatch",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/deleteTool",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "deleteTool",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "id",
			wire: "id",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Id",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/runTool",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "runTool",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#CapabilityRunResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "id",
			wire: "id",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Id",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "options",
			wire: "options",
			source: "json",
			acceptsUndefined: true,
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#RunOptions",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listHubSessions",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listHubSessions",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#HubSessionRows",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "cwd",
			wire: "cwd",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Cwd",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listHubBranches",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listHubBranches",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#HubBranchViews",
			create: () => ({ parse: (v) => v })
		},
		parameters: [
			{
				name: "cwd",
				wire: "cwd",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Cwd",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "hubSessionId",
				wire: "hubSessionId",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#HubSessionId",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "limit",
				wire: "limit",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#Limit",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/readSessionMessages",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "readSessionMessages",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#SessionChatView",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#SessionId",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "limit",
			wire: "limit",
			source: "json",
			acceptsUndefined: true,
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Limit",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/sendSessionMessage",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "sendSessionMessage",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MutationResult",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#SessionId",
				create: () => ({ parse: (v) => v })
			}
		}, {
			name: "text",
			wire: "text",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Text",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/suggestMemoryShape",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "suggestMemoryShape",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MemoryShape",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "text",
			wire: "text",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Text",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/sessionBadge",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "sessionBadge",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#SessionBadge",
			create: () => ({ parse: (v) => v })
		},
		parameters: [{
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#SessionId",
				create: () => ({ parse: (v) => v })
			}
		}]
	}
]);
/**
* Mount the panel service and register its remote descriptors.
*
* Three host contracts make the panel reachable from the browser, and the first
* two used to be silently missing (2026-11-18: every panel call answered 404):
*
* 1. `ctx.typert` is a proxy property. Reading it requires 'typert' in this
*    plugin's `inject`; without it the getter throws "cannot get property
*    'typert' without inject" (cordis ReflectService.handler.get). The old code
*    read `ctx.typert?.register(...)` inside `try { } catch {}`, so the throw was
*    swallowed on every call, the descriptors never reached the typert local
*    registry, and the API Gateway (claimsEndpoint reads
*    `ctx.typert.local.get(endpoint)`) answered 404 for POST
*    /api/supermemoryPanel/*. `ctx.get('typert')` has no inject requirement, and
*    every failure is now logged instead of swallowed.
* 2. The Gateway's validateBinding/readBinding requires the service instance to
*    expose `typertRemote` = `{ service, serviceKey, namespace }` — exactly what
*    `bindTypertRemote(this, 'supermemoryPanel')` from
*    @deepseek-ai/dsh-typert-protocol produces. It is attached here by hand
*    because this plugin takes no static dependency on that package (host
*    packages resolve only through the loadHostModule anchor).
* 3. The registry keys every endpoint and remembers every endpoint it has EVER
*    seen (`local.hasSeen()`). Once a strict definition is withdrawn, the
*    Gateway refuses the descriptor-free source fallback for that endpoint for
*    the rest of the process:
*      "typert gateway: supermemoryPanel/hubState: its strict definition was
*       withdrawn and SRC fallback is forbidden".
*    A plugin reload can race the old fiber's teardown: the new instance calls
*    `typert.register()` while the old package face is still live, the registry
*    rejects the duplicate, the old fiber then withdraws, and nothing ever
*    re-registers — the panel is dead while every other feature still works.
*    The registration therefore VERIFIES its endpoints and RETRIES instead of
*    firing once (see attachPanelRegistration).
*/
function attachPanel(ctx, store) {
	if (!store) return () => {};
	const service = new SupermemoryPanelService(store, ctx);
	Object.defineProperty(service, "typertRemote", {
		value: Object.freeze({
			service,
			serviceKey: "supermemoryPanel",
			namespace: "supermemoryPanel"
		}),
		enumerable: false
	});
	ctx.provide("supermemoryPanel", service);
	return attachPanelRegistration(ctx);
}
/** Endpoint key of one descriptor, exactly as the registry (and the Gateway) keys it. */
function panelEndpoint(descriptor) {
	return `${descriptor.namespace}/${descriptor.method}`;
}
/** Delays between failed registration attempts; the last value repeats. */
const PANEL_REGISTRATION_RETRY_MS = Object.freeze([
	250,
	750,
	2e3,
	5e3,
	15e3
]);
/** Re-verification delays after a healthy registration, before the steady watchdog takes over. */
const PANEL_REGISTRATION_VERIFY_MS = Object.freeze([1e3, 4e3]);
/** Steady-state watchdog: re-registers if the endpoints are withdrawn later in this process. */
const PANEL_REGISTRATION_WATCHDOG_MS = 3e4;
/**
* Keep the panel descriptors registered for this fiber's lifetime.
*
* `typert.register()` is transactional and rejects the whole batch on a
* duplicate package face or endpoint, so the only safe recovery from the reload
* race described on attachPanel is to retry once the old fiber has withdrawn.
* Each tick first verifies the live endpoints through `typert.local.get()`: a
* complete set is health (watchdog), a missing set is re-registered. Timers are
* unref'd and cleared by the returned disposer, so the plugin never keeps the
* process alive and a reload starts from a clean slate.
*/
function attachPanelRegistration(ctx) {
	let closed = false;
	let failed = 0;
	let verified = 0;
	/** Set once a registration succeeded on a registry that cannot be read back (no `local` view). */
	let healthUnverifiable = false;
	const timers = /* @__PURE__ */ new Set();
	const disposers = [];
	const schedule = (delay) => {
		if (closed) return;
		const timer = setTimeout(() => {
			timers.delete(timer);
			check();
		}, delay);
		timers.add(timer);
		const unrefable = timer;
		if (typeof unrefable.unref === "function") unrefable.unref();
	};
	/**
	* Registration state read from the registry: true = every endpoint is live,
	* false = at least one is missing, undefined = this registry exposes no
	* `local` view (a test double or a future host), so it cannot be verified.
	*/
	const registered = (typert) => {
		const local = typert.local;
		if (!local || typeof local.get !== "function") return void 0;
		return PANEL_DESCRIPTORS.every((descriptor) => local.get(panelEndpoint(descriptor)) !== void 0);
	};
	const check = () => {
		if (closed) return;
		const typert = ctx.get("typert");
		if (!typert || typeof typert.register !== "function") {
			if (failed === 0) console.warn("supermemory: typert registry unavailable; panel remote descriptors not registered yet");
			failed += 1;
			schedule(PANEL_REGISTRATION_RETRY_MS[Math.min(failed - 1, PANEL_REGISTRATION_RETRY_MS.length - 1)]);
			return;
		}
		const state = registered(typert);
		if (state === true || state === void 0 && healthUnverifiable) {
			failed = 0;
			verified += 1;
			schedule(verified <= PANEL_REGISTRATION_VERIFY_MS.length ? PANEL_REGISTRATION_VERIFY_MS[verified - 1] : PANEL_REGISTRATION_WATCHDOG_MS);
			return;
		}
		try {
			const disposer = typert.register({
				package: "dsh-supermemory",
				face: "host",
				schemas: [],
				model: {
					services: [],
					events: [],
					objects: []
				},
				invocations: PANEL_DESCRIPTORS
			});
			if (typeof disposer === "function") disposers.push(disposer);
			const after = registered(typert);
			if (after === false) throw new Error("the registry did not keep the panel descriptors");
			if (after === void 0) healthUnverifiable = true;
			failed = 0;
			verified = 0;
		} catch (error) {
			if (failed === 0) console.warn("supermemory: typert register failed for the panel descriptors; retrying", error);
			failed += 1;
		}
		schedule(failed === 0 ? PANEL_REGISTRATION_VERIFY_MS[0] : PANEL_REGISTRATION_RETRY_MS[Math.min(failed - 1, PANEL_REGISTRATION_RETRY_MS.length - 1)]);
	};
	check();
	return () => {
		if (closed) return;
		closed = true;
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		for (const disposer of disposers) try {
			disposer();
		} catch {}
		disposers.length = 0;
	};
}
// src/tools.ts
/** Attach all tools; returns the effect disposer. */
async function attachTools(ctx, deps, config) {
	const { store } = deps;
	const tools = await loadHostModule("@deepseek-ai/dsh-tools");
	const disposers = [];
	if (config.rememberEnabled) disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_remember",
		description: "将一条【结论性】事实记忆写入 SuperMemory：跨会话持久、按工作区隔离。只记结论——可复用的事实、决策、约定、构建命令、文件用途；禁止记录过程流水账（先做了什么、执行了哪些命令、第几步、工具调用日志、大段输出），这些留在会话里。必须同时给出 title + tags + 正文：标题是一句可扫读的结论（≤48 字），标签是 3–8 个短词（检索索引），正文自包含。过长（>1500 字）或明显是步骤/命令日志的内容会被拒绝，请先改写成结论。同一 key 已存不同文本时返回冲突提示（不覆盖），由你向用户裁决。",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "结论正文（自包含、可复用的事实/决策；不要过程流水账）"
			},
			key: {
				type: "string",
				description: "可选稳定键；同一事实更新时传相同 key"
			},
			title: {
				type: "string",
				required: true,
				description: "结论标题（≤48 字）：一句可扫读的话，检索时权重最高"
			},
			tags: {
				type: "array",
				required: true,
				description: "标签（3–8 个短词）：检索索引，与正文分离",
				items: { type: "string" }
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"stored",
							"updated",
							"conflict",
							"duplicate"
						],
						required: true
					},
					memoryId: { type: "string" },
					title: { type: "string" },
					tags: {
						type: "array",
						items: { type: "string" }
					},
					message: {
						type: "string",
						required: true
					},
					conflict: {
						type: "object",
						properties: {
							memoryId: {
								type: "string",
								required: true
							},
							text: {
								type: "string",
								required: true
							}
						},
						additionalProperties: false
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.message ?? "")
			}]
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) return {
				status: "conflict",
				message: "无法确定当前工作区（agent 会话缺少 cwd），已拒绝写入。"
			};
			const workspaceKey = workspaceKeyOf(cwd);
			const text = String(args.text ?? "").trim();
			if (!text) return {
				status: "conflict",
				message: "text 不能为空。"
			};
			const verdict = assessConclusion(text);
			if (!verdict.ok) return {
				status: "conflict",
				message: verdict.message
			};
			const key = args.key?.trim() || void 0;
			const title = String(args.title ?? "").trim().slice(0, 48) || deriveTitle(text);
			const tags = mergeTags(normalizeTags(args.tags), tagsOfBody(text));
			if (!title) return {
				status: "conflict",
				message: "标题不能为空：请给出一句可扫读的结论标题。"
			};
			if (tags.length === 0) return {
				status: "conflict",
				message: "至少需要 1 个标签（3–8 个短词）作为检索索引。"
			};
			const now = Date.now();
			if (key) for (const [memoryId, record] of store.memories.entries()) {
				if (record.workspaceKey !== workspaceKey || record.status !== "active" || record.key !== key) continue;
				if (record.text.trim().toLowerCase() === text.toLowerCase()) return {
					status: "duplicate",
					memoryId,
					title: record.title,
					tags: record.keywords,
					message: "该 key 已存相同内容，未重复写入。"
				};
				return {
					status: "conflict",
					memoryId,
					title: record.title,
					tags: record.keywords,
					message: `key「${key}」已存不同内容：「${renderRecordLine({
						title: record.title,
						text: record.text,
						tags: record.keywords
					})}」。请与用户裁决后再写入。`,
					conflict: {
						memoryId,
						text: record.text
					}
				};
			}
			for (const [memoryId, record] of store.memories.entries()) if (record.workspaceKey === workspaceKey && record.status === "active" && record.text.trim().toLowerCase() === text.toLowerCase()) return {
				status: "duplicate",
				memoryId,
				title: record.title,
				tags: record.keywords,
				message: "相同记忆已存在，未重复写入。"
			};
			const memoryId = newId("mem");
			const memory = {
				workspaceKey,
				title,
				text,
				key,
				keywords: tags,
				sourceSessionId: String(exec.agent?.id ?? "tool"),
				sourceSeq: 0,
				status: "active",
				createdAt: now,
				updatedAt: now
			};
			await store.memories.put(memoryId, memory);
			return {
				status: "stored",
				memoryId,
				title,
				tags,
				message: `已记住：${renderRecordLine({
					title,
					text,
					tags
				})}`
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_recall",
		description: "检索 SuperMemory：结论性事实记忆（memories）、归档梗概（episodes）、需求（requirements）与项目文件地图（filemap），按当前工作区隔离，关键词 + 时间衰减规则评分。回答\"之前说过什么/做过什么\"类问题前先用本工具检索；记忆只存结论，不是过程日志。返回的 topicSets 是命中的话题集（结论属于哪个集），命中时优先直接回答或把任务派发到该集，不要重复检索。",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "检索问题或关键词"
			},
			limit: {
				type: "integer",
				description: `返回条数上限，默认 ${config.recall.maxItems}`
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							properties: {
								kind: {
									type: "string",
									enum: [
										"memory",
										"episode",
										"requirement",
										"file"
									],
									required: true
								},
								id: {
									type: "string",
									required: true
								},
								title: {
									type: "string",
									description: "标题：检索命中的索引字段，优先阅读"
								},
								tags: {
									type: "array",
									items: { type: "string" },
									description: "标签"
								},
								text: {
									type: "string",
									required: true,
									description: "正文"
								},
								score: {
									type: "number",
									required: true
								},
								createdAt: { type: "integer" }
							},
							additionalProperties: false
						}
					},
					total: {
						type: "integer",
						required: true
					},
					topicSets: {
						type: "array",
						description: "命中的话题集（按匹配分排序）：命中记忆时优先用该集",
						items: {
							type: "object",
							properties: {
								id: {
									type: "string",
									required: true
								},
								title: {
									type: "string",
									required: true
								},
								tags: {
									type: "array",
									items: { type: "string" }
								},
								score: {
									type: "number",
									required: true
								}
							},
							additionalProperties: false
						}
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const items = value.items ?? [];
				const topicSets = value.topicSets ?? [];
				const hint = topicSets.length > 0 ? `\n相关话题集：${topicSets.map((topicSet) => topicSet.title).join("、")}` : "";
				if (items.length === 0) return [{
					type: "text",
					text: `（未检索到相关记忆）${hint}`
				}];
				return [{
					type: "text",
					text: items.map((item, i) => `${i + 1}. ${renderRecordLine({
						title: item.title,
						text: item.text,
						tags: item.tags
					})}`).join("\n") + hint
				}];
			}
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) return {
				items: [],
				total: 0,
				topicSets: []
			};
			const workspaceKey = workspaceKeyOf(cwd);
			const query = String(args.query ?? "").trim();
			if (!query) return {
				items: [],
				total: 0,
				topicSets: []
			};
			const options = {
				limit: Math.max(1, Math.min(20, Number(args.limit) || config.recall.maxItems)),
				minScore: config.recall.minScore,
				halfLifeDays: config.recall.halfLifeDays,
				now: Date.now()
			};
			const items = [];
			const memories = [];
			for (const entry of store.memories.entries()) if (entry[1].workspaceKey === workspaceKey && entry[1].status === "active") memories.push(entry);
			for (const item of recallMemories(memories, query, options)) items.push({
				kind: "memory",
				id: item.memoryId,
				title: item.title,
				tags: item.keywords,
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			const ownTopicSetIds = topicSetIdsOf(store, workspaceKey);
			const episodes = [];
			for (const entry of store.episodes.entries()) {
				const topicSetId = entry[1].topicSetId;
				if (!topicSetId || !ownTopicSetIds.has(topicSetId)) continue;
				if (entry[1].summary) episodes.push([entry[0], entry[1]]);
			}
			for (const item of recallMemories(episodes.map(([id, episode]) => [id, {
				workspaceKey: "",
				title: "",
				text: episode.summary,
				keywords: [],
				sourceSessionId: episode.sourceSessionId,
				sourceSeq: episode.sourceSeqStart,
				status: "active",
				createdAt: episode.timeStart,
				updatedAt: episode.timeEnd
			}]), query, options)) items.push({
				kind: "episode",
				id: item.memoryId,
				title: item.title,
				tags: item.keywords,
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			const requirements = [];
			for (const entry of store.requirements.entries()) if (entry[1].workspaceKey === workspaceKey && entry[1].status === "open") requirements.push(entry);
			for (const item of recallMemories(requirements.map(([id, req]) => [id, {
				workspaceKey: req.workspaceKey,
				title: "",
				text: req.text,
				keywords: req.constraints,
				sourceSessionId: req.sourceSessionId,
				sourceSeq: req.sourceSeq,
				status: "active",
				createdAt: req.createdAt,
				updatedAt: req.createdAt
			}]), query, options)) items.push({
				kind: "requirement",
				id: item.memoryId,
				title: item.title,
				tags: item.keywords,
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			const filemap = [];
			for (const entry of store.filemap.entries()) if (entry[1].workspaceKey === workspaceKey) filemap.push(entry);
			for (const item of recallMemories(filemap.map(([key, entry]) => [key, {
				workspaceKey: entry.workspaceKey,
				title: entry.path,
				text: `${entry.role ? entry.role + "：" : ""}${entry.summary}`.trim() || entry.path,
				keywords: entry.keywords,
				sourceSessionId: "",
				sourceSeq: 0,
				status: "active",
				createdAt: entry.annotatedAt,
				updatedAt: entry.annotatedAt
			}]), query, options)) items.push({
				kind: "file",
				id: item.memoryId,
				title: item.title,
				tags: item.keywords,
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
			const topicSets = matchTopicSets(listTopicSets(store, workspaceKey), query, 3);
			return {
				items: items.slice(0, options.limit),
				total: items.length,
				topicSets
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_topicsets",
		description: "列出当前工作区的话题集（标题/梗概/分支状态/默认模型），或查看单个话题集的详情。需要激活某个话题集时用 /memory switch，或在消息里 @话题集名。",
		parameters: { topicSetId: {
			type: "string",
			description: "可选；提供则返回该话题集详情"
		} },
		output: {
			schema: {
				type: "object",
				properties: {
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							properties: {
								id: {
									type: "string",
									required: true
								},
								title: {
									type: "string",
									required: true
								},
								tags: {
									type: "array",
									items: { type: "string" },
									description: "标签（keywords）"
								},
								summary: {
									type: "string",
									required: true,
									description: "正文/梗概"
								},
								sessions: {
									type: "integer",
									required: true,
									description: "该话题集下的会话数"
								},
								branches: {
									type: "integer",
									required: true,
									description: "同 sessions（兼容字段）"
								},
								model: { type: "string" }
							},
							additionalProperties: false
						}
					},
					total: {
						type: "integer",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const items = value.items ?? [];
				if (items.length === 0) return [{
					type: "text",
					text: "（当前工作区暂无话题集）"
				}];
				return [{
					type: "text",
					text: items.map((i) => {
						const count = i.sessions ?? i.branches ?? 0;
						const tags = i.tags && i.tags.length > 0 ? ` ｜标签: ${i.tags.join("、")}` : "";
						return `- 【${i.title}】${count} 个会话${i.model ? " · " + i.model : ""}${tags}${i.summary ? "：" + i.summary.slice(0, 80) : ""}`;
					}).join("\n")
				}];
			}
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) return {
				items: [],
				total: 0
			};
			const workspaceKey = workspaceKeyOf(cwd);
			const toItem = (id, topicSet) => ({
				id,
				title: topicSet.title,
				tags: topicSet.keywords,
				summary: topicSet.summary,
				sessions: topicSet.members.length,
				branches: topicSet.members.length,
				...topicSet.defaultModel ? { model: `${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}` } : {}
			});
			if (args.topicSetId) {
				const topicSet = store.topicsets.get(String(args.topicSetId));
				if (!topicSet) return {
					items: [],
					total: 0
				};
				return {
					items: [toItem(String(args.topicSetId), topicSet)],
					total: 1
				};
			}
			const items = listTopicSets(store, workspaceKey).map(([id, topicSet]) => toItem(id, topicSet));
			return {
				items,
				total: items.length
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_new_topicset",
		description: "为当前讨论新建一个话题集（可按提示选择默认模型），并立即激活。必须同时给出 title + tags + summary，不要只给标题：标题是一句可扫读的话，标签是 3–8 个检索短词，正文说明这个话题集到底要做什么。显式开新话题时使用；不确定时先 memory_topicsets 查看已有话题集。",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "话题集标题（简短）"
			},
			tags: {
				type: "array",
				description: "标签（3–8 个短词）：检索索引，必填建议；缺省会用标题/摘要派生",
				items: { type: "string" }
			},
			summary: {
				type: "string",
				description: "正文/梗概（≤500 字）：这个话题集到底要做什么，必填建议"
			},
			askModel: {
				type: "boolean",
				description: "是否询问默认模型；默认询问"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["created", "error"],
						required: true
					},
					topicSetId: { type: "string" },
					title: { type: "string" },
					tags: {
						type: "array",
						items: { type: "string" }
					},
					model: { type: "string" },
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "created") return [{
					type: "text",
					text: `已创建并激活话题集『${v.title ?? ""}』${v.tags && v.tags.length > 0 ? "（标签：" + v.tags.join("、") + "）" : ""}${v.model ? "（默认模型 " + v.model + "）" : ""}`
				}];
				return [{
					type: "text",
					text: v.message ?? "创建失败。"
				}];
			}
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			const sessionId = String(exec.agent?.id ?? "");
			if (!cwd || !sessionId) return {
				status: "error",
				message: "无法确定当前会话。"
			};
			const workspaceKey = workspaceKeyOf(cwd);
			let model;
			if (args.askModel !== false) model = await askDefaultModel(deps.model, exec.agent);
			const title = clipEllipsis(String(args.title ?? "").trim(), 60);
			if (!title.trim()) return {
				status: "error",
				message: "标题不能为空。"
			};
			const tags = mergeTags(normalizeTags(args.tags), tagsOfBody(`${title} ${args.summary ?? ""}`));
			const topicSetId = await createTopicSet(store, {
				workspaceKey,
				title,
				keywords: tags,
				summary: String(args.summary ?? "").slice(0, 500),
				...model ? { defaultModel: model } : {}
			});
			await setRouting(store, sessionId, {
				activeTopicSetId: topicSetId,
				driftCount: 0
			});
			const explicitTags = normalizeTags(args.tags);
			if (explicitTags.length === 0 || !String(args.summary ?? "").trim()) try {
				await fillTopicShapeOnCreate({
					ctx: deps.ctx,
					store,
					logger: deps.logger
				}, topicSetId, "", {
					tags: explicitTags.length === 0,
					summary: !String(args.summary ?? "").trim()
				});
			} catch (error) {
				deps.logger.warn("supermemory: topic-set shape generation skipped: " + String(error).slice(0, 160));
			}
			noteTopicSetActivated({
				ctx: deps.ctx,
				store,
				logger: deps.logger
			}, topicSetId);
			const stored = store.topicsets.get(topicSetId);
			return {
				status: "created",
				topicSetId,
				title: stored?.title ?? title,
				tags: stored?.keywords ?? tags,
				...model ? { model: `${model.provider}/${model.model}` } : {}
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_dispatch",
		description: "把实质工作异步派发到话题集的分支会话（在全新对话中执行，不在主对话框直接完成操作）：插件先落账，随即唤醒分支并立即返回回执，本会话（中枢）不阻塞。分支完成后结果会以 relay 形式主动送回本会话。中枢只做判断、派发与汇总：不要自己读改文件/跑命令，把操作交给分支。简单问答不要派发——上下文卡/recall 能答的中枢直接答。需求多或复杂时用 tasks[] 拆成多个分支并行协同：每个任务一个独立分支，全部到达终态后只回送一次汇总，失败成员单独标注；并行组里的任务必须自包含、互不依赖，不要把一个可拆分的大任务塞进单个分支串行做。mode 语义：auto（默认）复用空闲的匹配分支、否则新建，绝不在忙碌分支里合并另一个任务；continue 显式续派同一条分支（忙则排队，用于同一任务的后续）；fork 从父分支最近已完成轮次开新分支；new 强制新建。分支归属话题集、可被同一话题集下的多个中枢复用/共享（不按中枢隔离）；不要为同一件工作反复新建分支造成重复或分裂。话题集匹配（未显式给 topicSetId 且本会话没有激活话题集时）：插件按任务与同工作区现有话题集的相似度三档处置——高相似：直接复用该话题集（不新建，回执注明复用了哪个集）；中等相似：不派发也不新建，返回 need-confirm 与候选列表（id/标题/分数），中枢应立即用 ask_user_question 转问用户：复用哪个候选（用户选定后带 topicSetId 重新派发）、强制新建（forceNewTopicSet=true）还是改述任务；低相似/无候选：才自动新建（标题=任务首行）。跨工作区的话题集绝不参与匹配。一次性验证类任务传 kind:\"verify\"：归入「<工作区目录名> · 验证」话题集（优先复用已有的），不要为每次验证新建话题集。派发前优先考虑复用已有话题集；确认必须开新话题时才用 forceNewTopicSet=true，不要人为制造碎片化。capabilities 在派发前设定分支的能力边界（写进分支首条消息并尽量用 tools.restrict 落实）：full=与中枢一致（可读写文件 + 跑命令，改代码/构建/验证时用）；read-write=可读改文件但不能跑命令（默认，纯代码编辑/审阅改动用）；read=只读审阅（不能写文件、不能跑命令，只做分析/评审）；minimal=最小（只读文件 + memory_* / send_message / wait_agent，做汇总或轻量核对）。派发前先想清楚是否需要改代码/跑命令，不要一律用 full。分支遇到需要用户裁决的问题会用 memory_raise_question 上交中枢（永不直接问用户）；收到 relay 或用户新消息时用 memory_questions 汇总所有分支的问题，再用 ask_user_question 一次提问。R24 收口：本工具立即返回回执、不阻塞；拿到回执后请直接结束本轮回复——不要调用 wait_agent 等分支、不要轮询分支状态。分支完成后 relay 会作为新消息自动送达本会话并开启新一轮对话，届时再汇总转述。",
		parameters: {
			task: {
				type: "string",
				description: "单个任务描述（自包含）；与 tasks 二选一"
			},
			tasks: {
				type: "array",
				description: "多个任务描述（2 个以上）→ 并行组，全部终态后单次汇总回送",
				items: { type: "string" }
			},
			topicSetId: {
				type: "string",
				description: "目标话题集；省略则用本会话当前激活的话题集"
			},
			forceNewTopicSet: {
				type: "boolean",
				description: "强制新建话题集（绕过相似度匹配复用）；默认 false"
			},
			kind: {
				type: "string",
				enum: ["verify"],
				description: "任务性质：verify=一次性验证，归入「<工作区目录名> · 验证」话题集（优先复用已有的）"
			},
			mode: {
				type: "string",
				enum: [
					"auto",
					"continue",
					"fork",
					"new"
				],
				description: "分支获取方式；默认 auto"
			},
			capabilities: {
				type: "string",
				enum: [
					"read",
					"read-write",
					"full",
					"minimal"
				],
				description: "分支能力边界（默认 read-write）：full=读写+命令（改代码/构建用）；read-write=读写无命令（默认）；read=只读审阅；minimal=只读+记忆/汇总类工具。越界由插件在分支作用域内限制。"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"dispatched",
							"error",
							"need-confirm"
						],
						required: true
					},
					dispatchId: { type: "string" },
					branchSessionId: { type: "string" },
					groupId: { type: "string" },
					topicSetId: { type: "string" },
					message: { type: "string" },
					candidates: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								title: { type: "string" },
								score: { type: "number" }
							},
							additionalProperties: false
						}
					},
					reason: { type: "string" },
					nextAction: { type: "string" },
					branches: {
						type: "array",
						items: {
							type: "object",
							properties: {
								branchSessionId: { type: "string" },
								task: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								}
							},
							additionalProperties: false
						}
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "need-confirm") {
					const lines = [v.message ?? "任务与现有话题集中等相似，尚未派发，等待用户裁决。"];
					if (v.candidates && v.candidates.length > 0) {
						lines.push("候选话题集：");
						v.candidates.forEach((row, index) => {
							lines.push(`${index + 1}. 『${row.title ?? ""}』（${row.id ?? ""}${row.score !== void 0 ? `，分数 ${row.score}` : ""}）`);
						});
					}
					if (v.reason) lines.push("判定理由：" + v.reason);
					return [{
						type: "text",
						text: lines.join("\n")
					}];
				}
				if (v.status === "dispatched") {
					const lines = [v.message ?? `已派发到分支 ${v.branchSessionId}；完成后结果会主动送回本会话。`];
					if (v.nextAction) lines.push(v.nextAction);
					if (v.branches && v.branches.length > 0) {
						lines.push("分支清单：");
						v.branches.forEach((row, index) => {
							lines.push(`${index + 1}. ${row.status === "dispatched" ? "✅" : "❌"} ${row.task.slice(0, 40)}${row.branchSessionId ? ` → ${row.branchSessionId}` : ""}`);
						});
					}
					return [{
						type: "text",
						text: lines.join("\n")
					}];
				}
				return [{
					type: "text",
					text: v.message ?? "派发失败。"
				}];
			}
		},
		async execute(args, exec) {
			try {
				return await runDispatch(deps.dispatch, args, exec);
			} catch (error) {
				deps.logger.warn(`supermemory: memory_dispatch threw: ${String(error).slice(0, 200)}`);
				return {
					status: "error",
					message: `派发异常：${String(error).slice(0, 200)}`
				};
			}
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_resume",
		description: "继续被中断的任务（插件重载/关闭或 DSH 退出导致；分支会话已保留，未删除）。无参 = 返回被中断任务清单（dispatchId、话题集、任务摘要、分支会话标识、中断时间、已完成部分）；带 dispatchIds（可多个）= 续跑指定任务：优先续接被保留的分支会话（同一会话同一日志续投「原始任务 + 已完成部分」），会话无法恢复时才带同样上下文重派发到新分支，并用 resumeOf/resumedBy 在台账关联原 dispatchId。已交付、仍在进行中或自主失败（max-tokens 等）的任务不会被续跑。R24 收口：续跑同样立即返回、不阻塞；返回后请直接结束本轮回复，不要 wait_agent 或轮询等待分支——分支完成后 relay 会自动开启新一轮对话。",
		parameters: {
			dispatchIds: {
				type: "array",
				description: "要续跑的 dispatchId（多个）；省略 = 只返回被中断任务清单",
				items: { type: "string" }
			},
			capabilities: {
				type: "string",
				enum: [
					"read",
					"read-write",
					"full",
					"minimal"
				],
				description: "续跑分支能力边界（默认 read-write，与 memory_dispatch 一致）"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"listed",
							"resumed",
							"partial",
							"error"
						],
						required: true
					},
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							properties: {
								dispatchId: {
									type: "string",
									required: true
								},
								topicSetId: { type: "string" },
								topicSetTitle: { type: "string" },
								task: {
									type: "string",
									required: true
								},
								branchSessionId: {
									type: "string",
									required: true
								},
								branchTitle: {
									type: "string",
									required: true
								},
								hubSessionId: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								},
								interruptedAt: {
									type: "integer",
									required: true
								},
								partial: { type: "string" },
								groupId: { type: "string" },
								resumeOf: { type: "string" }
							},
							additionalProperties: false
						}
					},
					results: {
						type: "array",
						required: true,
						items: {
							type: "object",
							properties: {
								dispatchId: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								},
								mode: { type: "string" },
								newDispatchId: { type: "string" },
								branchSessionId: { type: "string" },
								message: {
									type: "string",
									required: true
								}
							},
							additionalProperties: false
						}
					},
					total: {
						type: "integer",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					nextAction: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.message ?? "")
			}]
		},
		async execute(args, exec) {
			try {
				const cwd = exec.agent?.session?.header?.cwd;
				if (!cwd) return {
					status: "error",
					items: [],
					results: [],
					total: 0,
					message: "无法确定当前工作区。"
				};
				const ids = (args.dispatchIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
				const resumeDeps = {
					ctx: deps.ctx,
					store,
					logger: deps.logger
				};
				if (ids.length === 0) {
					const views = listInterruptedDispatches(store, { workspaceKey: workspaceKeyOf(cwd) });
					return {
						status: "listed",
						items: views.map((view) => ({
							dispatchId: view.dispatchId,
							...view.topicSetId ? { topicSetId: view.topicSetId } : {},
							...view.topicSetTitle ? { topicSetTitle: view.topicSetTitle } : {},
							task: view.task,
							branchSessionId: view.branchSessionId,
							branchTitle: view.branchTitle,
							hubSessionId: view.hubSessionId,
							status: view.status,
							interruptedAt: view.interruptedAt,
							...view.partial ? { partial: view.partial } : {},
							...view.groupId ? { groupId: view.groupId } : {},
							...view.resumeOf ? { resumeOf: view.resumeOf } : {}
						})),
						results: [],
						total: views.length,
						message: renderInterruptedList(views)
					};
				}
				const results = [];
				for (const id of ids) results.push(await resumeDispatch(resumeDeps, id, {
					exec,
					...args.capabilities ? { capabilities: args.capabilities } : {}
				}));
				const resumed = results.filter((row) => row.status === "resumed").length;
				const status = resumed === results.length ? "resumed" : resumed > 0 ? "partial" : "error";
				const message = results.map((row, index) => index + 1 + ". " + (row.status === "resumed" ? "✅" : "❌") + " " + row.dispatchId + "：" + row.message).join("\n");
				return {
					status,
					items: [],
					results,
					total: results.length,
					message,
					...resumed > 0 ? { nextAction: RESUME_NEXT_ACTION } : {}
				};
			} catch (error) {
				deps.logger.warn(`supermemory: memory_resume threw: ${String(error).slice(0, 200)}`);
				return {
					status: "error",
					items: [],
					results: [],
					total: 0,
					message: `续跑异常：${String(error).slice(0, 200)}`
				};
			}
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_raise_question",
		description: "【仅分支会话使用】把需要用户裁决的问题结构化上交中枢，由中枢汇总所有分支的问题后统一向用户提问。分支不要直接向用户提问、也不要因为提问而卡住不干活：非阻塞问题（blocking=false，默认）上交后继续按最合理解释推进并完成实质工作，把做出的假设写进最终汇报；只有真正阻断、非用户裁决无法继续时才 blocking=true，并同时给出 progress（已完成进度）与 defaultPlan（默认备选方案）。中枢不要调用本工具——中枢需要用户裁决时直接用 ask_user_question。",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "问题标题（≤80 字）：一句可扫读的话"
			},
			question: {
				type: "string",
				required: true,
				description: "要用户裁决的具体问题（写清背景与取舍）"
			},
			options: {
				type: "array",
				items: { type: "string" },
				description: "可选：给用户的候选答案（每个一句）"
			},
			severity: {
				type: "string",
				enum: [
					"low",
					"medium",
					"high"
				],
				description: "可选：严重度，默认 medium"
			},
			blocking: {
				type: "boolean",
				description: "是否阻塞：true=非用户裁决无法继续（应同时给 progress 与 defaultPlan）；默认 false"
			},
			progress: {
				type: "string",
				description: "可选：已完成的进度（阻塞时必填，便于中枢向用户说明代价）"
			},
			defaultPlan: {
				type: "string",
				description: "可选：用户不裁决时分支将采用的默认备选方案（阻塞时必填）"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["recorded", "error"],
						required: true
					},
					questionId: { type: "string" },
					dispatchId: { type: "string" },
					blocking: { type: "boolean" },
					message: {
						type: "string",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.message ?? "")
			}]
		},
		async execute(args, exec) {
			const sessionId = String(exec.agent?.id ?? "");
			if (!sessionId) return {
				status: "error",
				message: "无法确定当前会话。"
			};
			try {
				return await raiseQuestion(store, sessionId, args);
			} catch (error) {
				deps.logger.warn(`supermemory: memory_raise_question threw: ${String(error).slice(0, 200)}`);
				return {
					status: "error",
					message: `上交失败：${String(error).slice(0, 200)}`
				};
			}
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_questions",
		description: "【中枢汇总用】列出 / 结清分支通过 memory_raise_question 上交的问题：含来源分支、是否阻塞、已完成进度与默认备选方案。收到 relay 或用户新消息时先调用本工具，把各分支的问题去重、按主题合并成一份清单，再用 ask_user_question 一次向用户提问；非阻塞问题且分支已按最合理解释完成时不必提问，在汇报里列出假设即可。用户答复后用 resolve 传入问题 id 结清（可带 answer），再用 memory_dispatch 把裁决派回对应分支。",
		parameters: {
			status: {
				type: "string",
				enum: [
					"open",
					"resolved",
					"all"
				],
				description: "要列出的话题状态；默认 open（待处理）"
			},
			resolve: {
				type: "array",
				items: { type: "string" },
				description: "可选：已向用户提问/已裁决的问题 id，传入即标记 resolved"
			},
			answer: {
				type: "string",
				description: "可选：用户答复原文，随 resolve 一起记录"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"listed",
							"resolved",
							"error"
						],
						required: true
					},
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							properties: {
								id: {
									type: "string",
									required: true
								},
								dispatchId: { type: "string" },
								topicSetId: { type: "string" },
								branchSessionId: {
									type: "string",
									required: true
								},
								branchTask: { type: "string" },
								title: {
									type: "string",
									required: true
								},
								question: {
									type: "string",
									required: true
								},
								options: {
									type: "array",
									items: { type: "string" }
								},
								severity: { type: "string" },
								blocking: {
									type: "boolean",
									required: true
								},
								progress: { type: "string" },
								defaultPlan: { type: "string" },
								status: {
									type: "string",
									required: true
								},
								createdAt: { type: "integer" }
							},
							additionalProperties: false
						}
					},
					total: {
						type: "integer",
						required: true
					},
					blocking: {
						type: "integer",
						required: true
					},
					resolved: { type: "integer" },
					message: {
						type: "string",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.message ?? "")
			}]
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			const sessionId = String(exec.agent?.id ?? "");
			if (!cwd) return {
				status: "error",
				items: [],
				total: 0,
				blocking: 0,
				resolved: 0,
				message: "无法确定当前工作区。"
			};
			const workspaceKey = workspaceKeyOf(cwd);
			const wanted = args.status === "resolved" || args.status === "all" ? args.status : "open";
			const resolveIds = (args.resolve ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
			let resolved = 0;
			if (resolveIds.length > 0) {
				const visible = new Set(questionsForHub(store, workspaceKey, sessionId || void 0, "open").map((row) => row.id));
				resolved = await resolveQuestions(store, resolveIds.filter((id) => visible.has(id)), args.answer);
			}
			const rows = questionsForHub(store, workspaceKey, sessionId || void 0, wanted);
			const items = rows.map(({ id, question }) => ({
				id,
				...question.dispatchId ? { dispatchId: question.dispatchId } : {},
				...question.topicSetId ? { topicSetId: question.topicSetId } : {},
				branchSessionId: question.branchSessionId,
				...question.branchTask ? { branchTask: question.branchTask } : {},
				title: question.title,
				question: question.question,
				...question.options.length > 0 ? { options: question.options } : {},
				severity: question.severity,
				blocking: question.blocking,
				...question.progress ? { progress: question.progress } : {},
				...question.defaultPlan ? { defaultPlan: question.defaultPlan } : {},
				status: question.status,
				createdAt: question.createdAt
			}));
			const listText = renderQuestionList(rows);
			const message = resolved > 0 ? `已标记 ${resolved} 个问题为已解决。

${listText}` : listText;
			return {
				status: resolveIds.length > 0 ? "resolved" : "listed",
				items,
				total: rows.length,
				blocking: rows.filter((row) => row.question.blocking).length,
				resolved,
				message
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_set_model",
		description: "设置话题集默认模型或单个分支的模型覆盖。省略 provider/model 时返回当前可用的providers/models 目录供选择（运行时枚举，可能为空——空目录时可直接自由输入）。",
		parameters: {
			topicSetId: {
				type: "string",
				description: "按话题集设置（默认模型）"
			},
			branchSessionId: {
				type: "string",
				description: "按分支设置（覆盖）"
			},
			provider: {
				type: "string",
				description: "提供方 id"
			},
			model: {
				type: "string",
				description: "模型 id"
			},
			reasoningEffort: {
				type: "string",
				description: "可选推理强度"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"applied",
							"catalog",
							"error"
						],
						required: true
					},
					applied: { type: "string" },
					live: { type: "boolean" },
					catalog: {
						type: "array",
						items: {
							type: "object",
							properties: {
								provider: {
									type: "string",
									required: true
								},
								id: {
									type: "string",
									required: true
								},
								name: {
									type: "string",
									required: true
								}
							},
							additionalProperties: false
						}
					},
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "applied") return [{
					type: "text",
					text: `已设置模型：${v.applied}`
				}];
				if (v.status === "catalog") return [{
					type: "text",
					text: `可用模型目录：${(v.catalog ?? []).map((m) => `${m.provider}/${m.id}`).join("、") || "（空——可直接自由输入 provider 与 model）"}`
				}];
				return [{
					type: "text",
					text: v.message ?? "设置失败。"
				}];
			}
		},
		async execute(args) {
			if (!args.provider || !args.model) {
				const { models } = await enumerateModels(deps.ctx);
				return {
					status: "catalog",
					catalog: models.slice(0, 40)
				};
			}
			if (!args.topicSetId && !args.branchSessionId) return {
				status: "error",
				message: "必须指定 topicSetId 或 branchSessionId。"
			};
			const result = await applyModelSelection(deps.model, {
				topicSetId: args.topicSetId,
				branchSessionId: args.branchSessionId
			}, {
				provider: String(args.provider),
				model: String(args.model),
				...args.reasoningEffort ? { reasoningEffort: String(args.reasoningEffort) } : {}
			});
			if (!result.applied) return {
				status: "error",
				message: "未找到目标。"
			};
			return {
				status: "applied",
				applied: result.applied,
				live: result.live
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_scan",
		description: "扫描当前工作区的文件并刷新项目地图（filemap）：规则化标注角色、按 hash 失效陈旧条目。之后 memory_recall 能回答\"这个文件干什么\"。等价于 /memory scan。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["scanned", "error"],
						required: true
					},
					scanned: { type: "integer" },
					added: { type: "integer" },
					stale: { type: "integer" },
					total: { type: "integer" },
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "scanned") return [{
					type: "text",
					text: `扫描 ${v.scanned} 个文件：新增 ${v.added}，失效/更新 ${v.stale}，当前共 ${v.total} 条。`
				}];
				return [{
					type: "text",
					text: v.message ?? "扫描失败。"
				}];
			}
		},
		async execute(_args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) return {
				status: "error",
				message: "无法确定当前工作区。"
			};
			try {
				const { scanWorkspace, filemapEntries } = await import("./filemap-BHeNYxCh.js").then((n) => n.n);
				const result = await scanWorkspace(store, cwd);
				const total = filemapEntries(store, workspaceKeyOf(cwd)).length;
				return {
					status: "scanned",
					scanned: result.scanned,
					added: result.added,
					stale: result.stale,
					total
				};
			} catch (error) {
				return {
					status: "error",
					message: `扫描失败：${String(error).slice(0, 200)}`
				};
			}
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_export",
		description: "把当前工作区的 SuperMemory 内容（激活话题集、事实记忆、未完成需求、归档梗概、项目文件地图）导出为 Markdown 文件（写入工作区根目录的 .supermemory-export.md），供 git 共享。等价于 /memory export。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["exported", "error"],
						required: true
					},
					path: { type: "string" },
					memories: { type: "integer" },
					requirements: { type: "integer" },
					files: { type: "integer" },
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: v.status === "exported" ? `已导出到 ${v.path}` : v.message ?? "导出失败。"
				}];
			}
		},
		async execute(_args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) return {
				status: "error",
				message: "无法确定当前工作区。"
			};
			try {
				const { writeFileSync } = await import("node:fs");
				const { buildExport } = await import("./export-BpBKNibH.js").then((n) => n.n);
				const workspaceKey = workspaceKeyOf(cwd);
				const activeTopicSetId = store.routing.get(String(exec.agent?.id ?? ""))?.activeTopicSetId;
				const result = buildExport(store, workspaceKey, activeTopicSetId);
				const target = `${cwd.replace(/[\\/]+$/, "")}/.supermemory-export.md`;
				writeFileSync(target, result.text, "utf8");
				return {
					status: "exported",
					path: target,
					memories: result.memories,
					requirements: result.requirements,
					files: result.files
				};
			} catch (error) {
				return {
					status: "error",
					message: `导出失败：${String(error).slice(0, 200)}`
				};
			}
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_ui",
		description: "打开 SuperMemory 可视化管理台（Plan A）：返回当前可用的管理台 URL（含一次性令牌）。用户要求「可视化管理记忆 / 打开记忆面板 / 记忆管理台」时调用本工具，并把返回的 URL 原样作为 Markdown 链接交付；管理台未启用时不要反复重试，退回 /memory 命令族即可。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["ready", "unavailable"],
						required: true
					},
					url: { type: "string" },
					port: { type: "integer" },
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: v.status === "ready" ? `记忆管理台：${v.url}` : v.message ?? "管理台不可用。"
				}];
			}
		},
		async execute(_args, exec) {
			const { getWebui } = await Promise.resolve().then(() => webui_exports);
			const webui = getWebui();
			if (!webui?.enabled) return {
				status: "unavailable",
				message: "管理台未启用（ui.enabled=false）。可用 /memory 命令族替代。"
			};
			const cwd = exec.agent?.session?.header?.cwd;
			const sessionId = String(exec.agent?.id ?? "") || void 0;
			return {
				status: "ready",
				url: webui.url(sessionId, cwd ? workspaceKeyOf(cwd) : void 0),
				port: webui.port
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_toolize",
		description: "工具化（P3）：① 列出待处理的组合工具提议（重复流程达阈值后产生）与已注册的能力；② 接受/拒绝某个提议；③ register 注册一个\"能力\"（capability）——入口命令 + 文档 + 适用范围 + 路由描述 + 可一键执行（默认预演，写操作需 confirm=true）。接受提议会把记录到的工具序列编译成组合工具（一次调用完成确定性子序列）并持久化，重启后仍可用。register 的能力同样落库（tool_memory），重启后 rebuildComposites 重建注册；仅适用于本仓库范围内注册（scope 指向本仓库目录）。",
		parameters: {
			accept: {
				type: "boolean",
				description: "接受第一个待处理提议并生成组合工具"
			},
			decline: {
				type: "boolean",
				description: "拒绝（不再提示）第一个待处理提议"
			},
			register: {
				type: "boolean",
				description: "注册一个能力（入口命令 + 文档 + 适用范围 + 路由描述，可一键执行）"
			},
			name: {
				type: "string",
				description: "能力逻辑名（字母/数字/-/_，如 git-sync-supermemory；工具名派生为 sm_composite_<name>）"
			},
			title: {
				type: "string",
				description: "能力标题（人类可读）"
			},
			description: {
				type: "string",
				description: "能力描述 + 路由：何时优先用它、关键坑是什么（模型据此路由）"
			},
			entry: {
				type: "string",
				description: "入口命令，如 \"pnpm git:sync\"（在 scope 目录内经 shell 执行）"
			},
			doc: {
				type: "string",
				description: "文档路径（相对仓库根），如 \"docs/git-sync.md\""
			},
			scope: {
				type: "string",
				description: "适用范围：入口命令的执行目录，如 \"G:\\09 - dsh\\SuperMemory\""
			},
			runnable: {
				type: "boolean",
				description: "是否允许执行；缺省 true"
			},
			dryRunArg: {
				type: "string",
				description: "预演参数，如 \"--dry-run\"；定义后默认预演执行"
			},
			writeConfirm: {
				type: "boolean",
				description: "true=真实执行可能写远端/改状态，必须显式 confirm=true"
			},
			tags: {
				type: "array",
				description: "标签（3–8 个短词，检索索引）",
				items: { type: "string" }
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"listed",
							"accepted",
							"declined",
							"none",
							"registered",
							"error"
						],
						required: true
					},
					pending: {
						type: "array",
						items: {
							type: "object",
							properties: {
								pattern: {
									type: "string",
									required: true
								},
								count: {
									type: "integer",
									required: true
								}
							},
							additionalProperties: false
						}
					},
					tool: { type: "string" },
					message: { type: "string" },
					capabilities: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: {
									type: "string",
									required: true
								},
								title: { type: "string" },
								entry: {
									type: "string",
									required: true
								},
								doc: { type: "string" },
								scope: { type: "string" },
								runnable: { type: "boolean" },
								dryRunArg: { type: "string" },
								writeConfirm: { type: "boolean" },
								status: { type: "string" },
								useCount: { type: "integer" },
								live: { type: "boolean" }
							},
							additionalProperties: false
						}
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "listed") {
					const list = (v.pending ?? []).map((p) => `- ${p.pattern}（${p.count} 次）`).join("\n");
					const caps = (v.capabilities ?? []).map((c) => `- ${c.name}：${c.entry}${c.dryRunArg ? `（默认预演 ${c.dryRunArg}）` : ""}${c.writeConfirm ? "（写操作需 confirm=true）" : ""}${c.status === "retired" ? "（已停用）" : ""}`).join("\n");
					const parts = [];
					if (list) parts.push(`待处理提议：\n${list}`);
					if (caps) parts.push(`已注册能力：\n${caps}`);
					return [{
						type: "text",
						text: parts.length > 0 ? parts.join("\n\n") : "（没有待处理的工具化提议，也没有已注册的能力）"
					}];
				}
				if (v.status === "accepted") return [{
					type: "text",
					text: `已固化为组合工具 ${v.tool}。`
				}];
				if (v.status === "registered") return [{
					type: "text",
					text: v.message ?? `已注册能力 ${v.tool}。`
				}];
				if (v.status === "declined") return [{
					type: "text",
					text: "已拒绝该提议。"
				}];
				if (v.status === "none") return [{
					type: "text",
					text: "（没有待处理的工具化提议）"
				}];
				return [{
					type: "text",
					text: v.message ?? "操作失败。"
				}];
			}
		},
		async execute(args, exec) {
			if (args.register) {
				const { registerCapability } = await import("./composite-Cttx-LIx.js").then((n) => n.r);
				const cwd = exec.agent?.session?.header?.cwd;
				const ws = cwd ? workspaceKeyOf(cwd) : args.scope ? workspaceKeyOf(args.scope) : void 0;
				const result = await registerCapability(ctx, store, {
					name: String(args.name ?? ""),
					title: args.title,
					description: String(args.description ?? ""),
					entry: String(args.entry ?? ""),
					doc: args.doc,
					scope: args.scope,
					runnable: args.runnable,
					dryRunArg: args.dryRunArg,
					writeConfirm: args.writeConfirm,
					tags: args.tags
				}, ws);
				if (result.status === "error") return {
					status: "error",
					message: result.message
				};
				deps.logger.info(`supermemory: capability ${result.name} registered via memory_toolize`);
				return {
					status: "registered",
					tool: result.name,
					message: result.message
				};
			}
			const pending = [];
			for (const [key, signal] of store.signals.entries()) if (signal.proposalStatus === "pending" && signal.proposedAt !== void 0) pending.push([key, signal]);
			if (!args.accept && !args.decline) {
				const { capabilityRecordsOf, liveCompositeSpecs } = await import("./composite-Cttx-LIx.js").then((n) => n.r);
				return {
					status: "listed",
					pending: pending.map(([, s]) => ({
						pattern: s.pattern,
						count: s.count
					})),
					capabilities: capabilityRecordsOf(store).map((c) => ({
						name: c.spec.name,
						title: c.spec.title,
						entry: c.spec.entry,
						doc: c.spec.doc,
						scope: c.spec.scope,
						runnable: c.spec.runnable !== false,
						dryRunArg: c.spec.dryRunArg,
						writeConfirm: Boolean(c.spec.writeConfirm),
						status: c.status,
						useCount: c.useCount,
						live: liveCompositeSpecs.has(c.spec.name)
					}))
				};
			}
			if (pending.length === 0) return { status: "none" };
			const [key, signal] = pending[0];
			if (args.decline) {
				await store.signals.update(key, (r) => ({
					...r,
					proposalStatus: "declined"
				}));
				return { status: "declined" };
			}
			try {
				const { compileComposite, registerComposite, persistComposite } = await import("./composite-Cttx-LIx.js").then((n) => n.r);
				const spec = compileComposite(signal, (signal.samples ?? []).map((raw) => {
					try {
						return JSON.parse(raw);
					} catch {
						return;
					}
				}).filter((s) => s !== void 0));
				await registerComposite(ctx, store, spec);
				await persistComposite(store, spec, key);
				await store.signals.update(key, (r) => ({
					...r,
					proposalStatus: "accepted"
				}));
				deps.logger.info(`supermemory: composite tool ${spec.name} registered via memory_toolize`);
				return {
					status: "accepted",
					tool: spec.name
				};
			} catch (error) {
				return {
					status: "error",
					message: `生成失败：${String(error).slice(0, 200)}`
				};
			}
		}
	})));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
// src/webui.ts
/**
* Web management console — Plan A: visual memory management.
*
* Mounts a prefix route on the host web server (`ctx.webServer`, the GUI's own
* HTTP carrier, confirmed running at the Web GUI origin) under `/supermemory`:
* static assets are read per request from `src/web/` (so UI iteration needs no
* plugin rebuild), and a small JSON API reads/writes the same domain tables the
* plugin uses. No client bundle is involved, so the GUI boot path stays
* untouched — that was the blocker for the native sidebar tab (§1.5).
*
* Auth: the page URL carries a per-start token (`?k=`); API calls echo it in
* the `x-sm-key` header. `ui.token: 'off'` disables the check on trusted
* loopback-only setups.
* @module supermemory/webui
*/
var webui_exports = /* @__PURE__ */ __exportAll({ getWebui: () => getWebui });
/** Route prefix owned by this module (a host web-server named prefix route). */
const PREFIX = "/supermemory";
/** Hard cap for JSON request bodies. */
const MAX_BODY_BYTES = 1048576;
let active;
/** The live handle, read by the `/memory ui` command and the `memory_ui` tool. */
function getWebui() {
	return active;
}
/** Attach the console; returns the effect disposer. */
function attachWebui(ctx, store, config, logger) {
	if (!config.enabled || !store) return () => {};
	const theStore = store;
	const theCtx = ctx;
	const token = config.token === "off" ? "" : config.token || randomUUID();
	const staticDir = resolveStaticDir();
	const router = async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const sub = url.pathname === PREFIX ? "/" : url.pathname.startsWith(PREFIX) ? url.pathname.slice(12) : void 0;
		const head = req.method === "HEAD";
		const authorized = !token || req.headers["x-sm-key"] === token || url.searchParams.get("k") === token;
		if (req.method === "OPTIONS") return sendCors(res);
		try {
			if (sub === void 0) return sendJson(res, 404, {
				ok: false,
				error: "not found"
			}, head);
			if (sub.startsWith("/api/")) {
				if (!authorized) return sendJson(res, 401, {
					ok: false,
					error: "unauthorized — reopen the console via /memory ui"
				}, head);
				const route = sub.slice(5);
				const readOnly = route === "workspaces" || route === "state";
				let body;
				if (req.method === "POST") try {
					body = await readJsonBody(req);
				} catch (bodyError) {
					const message = bodyError instanceof Error ? bodyError.message : String(bodyError);
					return sendJson(res, message.includes("too large") ? 413 : 400, {
						ok: false,
						error: message
					}, head);
				}
				else if (req.method === "GET" && readOnly) body = Object.fromEntries(url.searchParams.entries());
				else return sendJson(res, 405, {
					ok: false,
					error: readOnly ? "GET or POST required" : "POST required"
				}, head);
				return await handleApi(res, route, body, theStore, logger, theCtx);
			}
			if (req.method !== "GET" && !head) return sendJson(res, 405, {
				ok: false,
				error: "GET required"
			}, head);
			return await serveStatic(res, sub, head, staticDir, authorized ? token : "");
		} catch (error) {
			logger.warn(`supermemory: web console request failed: ${String(error).slice(0, 200)}`);
			return sendJson(res, 500, {
				ok: false,
				error: "internal error"
			}, head);
		}
	};
	const webServer = config.carrier === "auto" ? ctx.get("webServer") : void 0;
	let carrier;
	if (webServer) carrier = {
		kind: "host-webServer",
		port: () => webServer.port,
		register: (handler) => webServer.register({
			kind: "prefix",
			path: PREFIX,
			handler
		})
	};
	else {
		const server = createServer((req, res) => {
			router(req, res).catch(() => {});
		});
		let ownPort = 0;
		const readPort = () => {
			const addr = server.address();
			return addr && typeof addr === "object" ? addr.port : 0;
		};
		server.on("listening", () => {
			ownPort = readPort();
		});
		server.on("error", (error) => {
			logger.warn(`supermemory: console server error: ${String(error).slice(0, 160)}`);
		});
		try {
			server.listen(0, "127.0.0.1");
			carrier = {
				kind: "own-http",
				port: () => ownPort || readPort(),
				register: () => () => {},
				close: () => {
					server.closeAllConnections?.();
					server.close();
				}
			};
			logger.info(config.carrier === "auto" ? "supermemory: ctx.webServer unavailable — console served from own loopback server" : "supermemory: console served from own loopback server (carrier=own, sidebar-openable origin)");
		} catch (error) {
			logger.warn(`supermemory: web console disabled — no HTTP carrier: ${String(error).slice(0, 120)}`);
		}
	}
	if (!carrier) return () => {};
	const theCarrier = carrier;
	const base = () => `http://127.0.0.1:${theCarrier.port()}${PREFIX}/`;
	const handle = {
		enabled: true,
		get port() {
			return theCarrier.port();
		},
		url: (sessionId, workspaceKey) => {
			const params = new URLSearchParams();
			if (token) params.set("k", token);
			if (sessionId) params.set("session", sessionId);
			if (workspaceKey) params.set("ws", workspaceKey);
			const query = params.toString();
			return query ? `${base()}?${query}` : base();
		}
	};
	return ctx.effect(() => {
		const disposeRoute = theCarrier.register(router);
		active = handle;
		logger.info(`supermemory: web console at ${base()} (carrier: ${theCarrier.kind})`);
		return () => {
			disposeRoute();
			if (theCarrier.kind === "own-http") theCarrier.close();
			if (active === handle) active = void 0;
		};
	}, "supermemory: web-console");
}
/** First existing asset directory: repo checkout, then a bundled `web/`. */
function resolveStaticDir() {
	for (const candidate of ["../src/web/", "../web/"]) try {
		const dir = fileURLToPath(new URL(candidate, import.meta.url));
		if (statSync(join(dir, "index.html")).isFile()) return dir;
	} catch {}
	return fileURLToPath(new URL("../src/web/", import.meta.url));
}
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8"
};
/** Serve the console shell and its two assets; everything else 404s. */
async function serveStatic(res, sub, head, staticDir, token) {
	if (sub === "/" || sub === "/index.html") {
		let html;
		try {
			html = await readFile(join(staticDir, "index.html"), "utf8");
		} catch {
			html = fallbackHtml();
		}
		return sendText(res, 200, injectToken(html, token), MIME[".html"], head, false);
	}
	const name = sub === "/app.js" ? "app.js" : sub === "/style.css" ? "style.css" : void 0;
	if (!name) return sendJson(res, 404, {
		ok: false,
		error: "not found"
	}, head);
	const ext = name.slice(name.lastIndexOf("."));
	try {
		return sendText(res, 200, await readFile(join(staticDir, name), "utf8"), MIME[ext] ?? "text/plain; charset=utf-8", head, false);
	} catch {
		return sendJson(res, 404, {
			ok: false,
			error: "asset missing — src/web/ not installed"
		}, head);
	}
}
/** Stamp the per-start token into the shell so app.js can echo it back. */
function injectToken(html, token) {
	const meta = token ? `<meta name="sm-token" content="${token}">` : "<meta name=\"sm-token\" content=\"\">";
	if (/<meta name="sm-token"[^>]*>/.test(html)) return html.replace(/<meta name="sm-token"[^>]*>/, meta);
	return html.replace("<head>", `<head>
    ${meta}`);
}
/** Shown when the bundle ships without `src/web/`. */
function fallbackHtml() {
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>SuperMemory</title></head><body style=\"background:#151517;color:#f9fafb;font-family:system-ui;padding:24px\"><h3>SuperMemory 管理台</h3><p>静态资源缺失：请在插件目录保留 <code>src/web/</code>（index.html / app.js / style.css）。</p></body></html>";
}
/** Every mutating endpoint validates the target row against `ws` first. */
async function handleApi(res, route, body, store, logger, ctx) {
	const ws = text(body.ws);
	const fail = (error) => sendJson(res, 400, {
		ok: false,
		error
	});
	if (route !== "workspaces" && !ws) return fail("ws 不能为空");
	switch (route) {
		case "workspaces": return sendJson(res, 200, {
			ok: true,
			workspaces: listWorkspaces(store)
		});
		case "state": {
			if (!ws) return fail("ws 不能为空");
			let hubs = [];
			if (ctx) try {
				hubs = await listHubSessions(ctx, store, ws);
			} catch {}
			let hubBranches = [];
			try {
				hubBranches = listWorkspaceBranches(store, ws);
			} catch {}
			return sendJson(res, 200, {
				ok: true,
				...buildState(store, ws),
				hubs,
				hubBranches
			});
		}
		case "memory/create": {
			const memText = text(body.text);
			if (!memText) return fail("text 不能为空");
			const verdict = assessConclusion(memText);
			if (!verdict.ok) return fail(verdict.message);
			const id = newId("mem");
			const now = Date.now();
			const record = {
				workspaceKey: ws,
				title: text(body.title).slice(0, 48) || deriveTitle(memText),
				text: memText,
				keywords: mergeTags(normalizeTags(list(body.keywords)), tagsOfBody(memText)),
				key: text(body.key) || void 0,
				sourceSessionId: text(body.sessionId) || "webui",
				sourceSeq: 0,
				status: "active",
				createdAt: now,
				updatedAt: now
			};
			await store.memories.put(id, record);
			logger.info(`supermemory: webui created memory ${id}`);
			return sendJson(res, 200, {
				ok: true,
				id
			});
		}
		case "memory/update": {
			const id = text(body.id);
			const existing = store.memories.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("记忆不存在");
			const memText = text(body.text);
			if (memText) {
				const verdict = assessConclusion(memText);
				if (!verdict.ok) return fail(verdict.message);
			}
			await store.memories.update(id, (r) => ({
				...r,
				...memText ? { text: memText } : {},
				...body.title !== void 0 ? { title: text(body.title).slice(0, 48) || deriveTitle(memText || r.text) } : {},
				...body.keywords !== void 0 ? { keywords: mergeTags(normalizeTags(list(body.keywords)), tagsOfBody(memText || r.text)) } : {},
				...body.key !== void 0 ? { key: text(body.key) || void 0 } : {},
				updatedAt: Date.now()
			}));
			logger.info(`supermemory: webui updated memory ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		case "memory/status": {
			const id = text(body.id);
			const status = body.status === "active" || body.status === "superseded" ? body.status : void 0;
			if (!status) return fail("status 必须是 active 或 superseded");
			const existing = store.memories.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("记忆不存在");
			await store.memories.update(id, (r) => ({
				...r,
				status,
				updatedAt: Date.now()
			}));
			logger.info(`supermemory: webui memory ${id} -> ${status}`);
			return sendJson(res, 200, { ok: true });
		}
		case "memory/delete": {
			const id = text(body.id);
			const existing = store.memories.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("记忆不存在");
			await store.memories.delete(id);
			logger.info(`supermemory: webui deleted memory ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		case "requirement/create": {
			const reqText = text(body.text);
			if (!reqText) return fail("text 不能为空");
			const id = newId("req");
			const now = Date.now();
			const record = {
				topicSetId: text(body.topicSetId) || void 0,
				workspaceKey: ws,
				text: reqText,
				constraints: list(body.constraints),
				status: "open",
				sourceSessionId: text(body.sessionId) || "webui",
				sourceSeq: 0,
				createdAt: now
			};
			await store.requirements.put(id, record);
			logger.info(`supermemory: webui created requirement ${id}`);
			return sendJson(res, 200, {
				ok: true,
				id
			});
		}
		case "requirement/update": {
			const id = text(body.id);
			const existing = store.requirements.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("需求不存在");
			const reqText = text(body.text);
			const status = body.status === "open" || body.status === "closed" ? body.status : void 0;
			await store.requirements.update(id, (r) => ({
				...r,
				...reqText ? { text: reqText } : {},
				...body.constraints !== void 0 ? { constraints: list(body.constraints) } : {},
				...body.topicSetId !== void 0 ? { topicSetId: text(body.topicSetId) || void 0 } : {},
				...status ? {
					status,
					closedAt: status === "closed" ? Date.now() : void 0
				} : {}
			}));
			logger.info(`supermemory: webui updated requirement ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		case "requirement/delete": {
			const id = text(body.id);
			const existing = store.requirements.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("需求不存在");
			await store.requirements.delete(id);
			logger.info(`supermemory: webui deleted requirement ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		case "topicset/create": {
			const title = text(body.title);
			if (!title) return fail("title 不能为空");
			const id = await createTopicSet(store, {
				workspaceKey: ws,
				title: clipEllipsis(title.trim(), 60),
				summary: text(body.summary) || void 0,
				keywords: list(body.keywords)
			});
			try {
				await fillTopicShapeOnCreate({
					ctx,
					store,
					logger: { warn: (msg) => logger.warn(msg) }
				}, id, text(body.summary), {
					tags: list(body.keywords).length === 0,
					summary: !text(body.summary)
				});
			} catch (error) {
				logger.warn("supermemory: webui topic-set shape generation skipped: " + String(error).slice(0, 160));
			}
			const stored = store.topicsets.get(id);
			logger.info(`supermemory: webui created topic set ${id}`);
			return sendJson(res, 200, {
				ok: true,
				id,
				title: stored?.title,
				keywords: stored?.keywords,
				summary: stored?.summary
			});
		}
		case "topicset/update": {
			const id = text(body.id);
			const existing = store.topicsets.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("话题集不存在");
			const title = text(body.title);
			const status = body.status === "active" || body.status === "archived" ? body.status : void 0;
			await store.topicsets.update(id, (r) => ({
				...r,
				...title ? { title: clipEllipsis(title.trim(), 60) } : {},
				...body.summary !== void 0 ? { summary: text(body.summary) } : {},
				...body.keywords !== void 0 ? { keywords: list(body.keywords) } : {},
				...status ? { status } : {},
				updatedAt: Date.now()
			}));
			logger.info(`supermemory: webui updated topic set ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		case "topicset/activate": {
			const id = text(body.id);
			const sessionId = text(body.sessionId);
			const existing = store.topicsets.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("话题集不存在");
			if (!sessionId) return fail("sessionId 不能为空");
			await setRouting(store, sessionId, {
				activeTopicSetId: id,
				driftCount: 0
			});
			await touchTopicSet(store, id);
			noteTopicSetActivated({
				ctx,
				store,
				logger: { warn: (msg) => logger.warn(msg) }
			}, id);
			logger.info(`supermemory: webui activated ${id} for ${sessionId}`);
			return sendJson(res, 200, { ok: true });
		}
		case "filemap/scan": {
			const cwd = text(body.cwd);
			if (!cwd) return fail("cwd 不能为空");
			let isDir = false;
			try {
				isDir = statSync(cwd).isDirectory();
			} catch {}
			if (!isDir) return fail("cwd 不是有效目录");
			if (workspaceKeyOf(cwd) !== ws) return fail("cwd 与所选工作区不匹配");
			const result = await scanWorkspace(store, cwd);
			const total = countWs(store.filemap.entries(), ws);
			logger.info(`supermemory: webui scanned ${result.scanned} files`);
			return sendJson(res, 200, {
				ok: true,
				...result,
				total
			});
		}
		case "export": {
			const cwd = text(body.cwd);
			if (!cwd) return fail("cwd 不能为空");
			if (workspaceKeyOf(cwd) !== ws) return fail("cwd 与所选工作区不匹配");
			const result = buildExport(store, ws);
			const target = join(cwd, ".supermemory-export.md");
			await writeFile(target, result.text, "utf8");
			logger.info(`supermemory: webui exported to ${target}`);
			return sendJson(res, 200, {
				ok: true,
				path: target,
				...result
			});
		}
		case "episode/delete": {
			const id = text(body.id);
			const episode = store.episodes.get(id);
			if (!episode) return fail("梗概不存在");
			if (episode.topicSetId && !tsIdsOf(store, ws).has(episode.topicSetId)) return fail("梗概不属于当前工作区");
			await store.episodes.delete(id);
			logger.info(`supermemory: webui deleted episode ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		case "dispatch/delete": {
			const id = text(body.id);
			const dispatch = store.dispatches.get(id);
			if (!dispatch) return fail("派发记录不存在");
			if (dispatch.topicSetId && !tsIdsOf(store, ws).has(dispatch.topicSetId)) return fail("派发记录不属于当前工作区");
			await store.dispatches.delete(id);
			let outbox = 0;
			for (const [outboxId, item] of [...store.outbox.entries()]) {
				if (item.dispatchId !== id) continue;
				await store.outbox.delete(outboxId);
				outbox++;
			}
			logger.info(`supermemory: webui deleted dispatch ${id} (+${outbox} outbox rows)`);
			return sendJson(res, 200, {
				ok: true,
				outbox
			});
		}
		case "topicset/delete": {
			const id = text(body.id);
			const existing = store.topicsets.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("话题集不存在");
			let episodes = 0;
			for (const [episodeId, episode] of [...store.episodes.entries()]) {
				if (episode.topicSetId !== id) continue;
				await store.episodes.delete(episodeId);
				episodes++;
			}
			const dispatchIds = /* @__PURE__ */ new Set();
			const groupIds = /* @__PURE__ */ new Set();
			for (const [dispatchId, dispatch] of [...store.dispatches.entries()]) {
				if (dispatch.topicSetId !== id) continue;
				await store.dispatches.delete(dispatchId);
				dispatchIds.add(dispatchId);
				if (dispatch.groupId) groupIds.add(dispatch.groupId);
			}
			let outbox = 0;
			for (const [outboxId, item] of [...store.outbox.entries()]) {
				if (!(item.dispatchId !== void 0 && dispatchIds.has(item.dispatchId) || item.groupId !== void 0 && groupIds.has(item.groupId))) continue;
				await store.outbox.delete(outboxId);
				outbox++;
			}
			let routing = 0;
			for (const [sessionId, record] of [...store.routing.entries()]) {
				if (record.activeTopicSetId !== id) continue;
				await store.routing.delete(sessionId);
				routing++;
			}
			await store.topicsets.delete(id);
			logger.info(`supermemory: webui deleted topic set ${id} (episodes ${episodes}, dispatches ${dispatchIds.size}, outbox ${outbox}, routing ${routing})`);
			return sendJson(res, 200, {
				ok: true,
				episodes,
				dispatches: dispatchIds.size,
				outbox,
				routing
			});
		}
		case "tool/register": {
			if (!ctx) return fail("宿主上下文不可用，无法注册能力。");
			const result = await registerCapability(ctx, store, {
				name: text(body.name),
				title: text(body.title) || void 0,
				description: text(body.description),
				entry: text(body.entry),
				doc: text(body.doc) || void 0,
				scope: text(body.scope) || void 0,
				runnable: body.runnable === void 0 ? void 0 : Boolean(body.runnable),
				dryRunArg: text(body.dryRunArg) || void 0,
				writeConfirm: body.writeConfirm === void 0 ? void 0 : Boolean(body.writeConfirm),
				tags: list(body.tags)
			}, ws);
			if (result.status === "error") return fail(result.message);
			logger.info(`supermemory: webui registered capability ${result.name}`);
			return sendJson(res, 200, {
				ok: true,
				id: result.id,
				name: result.name,
				message: result.message
			});
		}
		case "tool/run": {
			const id = text(body.id);
			const record = store.toolMemory.get(id);
			if (!record || record.kind !== "composite" || !record.entry) return fail("组合工具不存在");
			if (record.workspaceKey && record.workspaceKey !== ws) return fail("工具不属于当前工作区");
			let spec;
			try {
				spec = JSON.parse(record.entry);
			} catch {
				return fail("工具定义损坏，无法执行");
			}
			if (spec.kind !== "capability" || !spec.entry) return fail("只有能力（capability）可以一键执行；序列组合工具请直接调用");
			const result = runCapability(spec, {
				...body.dryRun === void 0 ? {} : { dryRun: Boolean(body.dryRun) },
				...body.confirm === void 0 ? {} : { confirm: Boolean(body.confirm) }
			});
			if (result.status !== "needs-confirm") bumpCompositeUse(store, spec.name);
			logger.info(`supermemory: webui ran capability ${spec.name} (${result.status}, exit ${result.exitCode ?? "-"})`);
			return sendJson(res, 200, {
				ok: true,
				...result
			});
		}
		case "tool/status": {
			if (!ctx) return fail("宿主上下文不可用，无法修改工具状态。");
			const id = text(body.id);
			const status = body.status === "active" || body.status === "retired" ? body.status : void 0;
			if (!status) return fail("status 必须是 active 或 retired");
			const existing = store.toolMemory.get(id);
			if (!existing || existing.kind !== "composite") return fail("组合工具不存在");
			if (existing.workspaceKey && existing.workspaceKey !== ws) return fail("工具不属于当前工作区");
			const result = await editCompositeTool(ctx, store, id, { status });
			if (result.status === "error") return fail(result.message);
			logger.info(`supermemory: webui tool ${id} -> ${status}`);
			return sendJson(res, 200, { ok: true });
		}
		case "tool/delete": {
			if (!ctx) return fail("宿主上下文不可用，无法删除工具。");
			const id = text(body.id);
			const existing = store.toolMemory.get(id);
			if (!existing || existing.kind !== "composite") return fail("组合工具不存在");
			if (existing.workspaceKey && existing.workspaceKey !== ws) return fail("工具不属于当前工作区");
			const result = await deleteCompositeTool(ctx, store, id);
			if (result.status === "error") return fail(result.message);
			logger.info(`supermemory: webui deleted tool ${id}`);
			return sendJson(res, 200, { ok: true });
		}
		default: return sendJson(res, 404, {
			ok: false,
			error: `unknown api route: ${route}`
		});
	}
}
/** Workspace inventory for the console's workspace selector. */
function listWorkspaces(store) {
	const rows = /* @__PURE__ */ new Map();
	const row = (key) => {
		let found = rows.get(key);
		if (!found) {
			found = {
				key,
				topicsets: 0,
				memories: 0,
				requirements: 0,
				episodes: 0,
				filemap: 0
			};
			rows.set(key, found);
		}
		return found;
	};
	const topicSetsByWs = /* @__PURE__ */ new Map();
	for (const [id, t] of store.topicsets.entries()) {
		row(t.workspaceKey).topicsets++;
		const ids = topicSetsByWs.get(t.workspaceKey) ?? /* @__PURE__ */ new Set();
		ids.add(id);
		topicSetsByWs.set(t.workspaceKey, ids);
	}
	for (const [, m] of store.memories.entries()) row(m.workspaceKey).memories++;
	for (const [, r] of store.requirements.entries()) row(r.workspaceKey).requirements++;
	for (const [, f] of store.filemap.entries()) row(f.workspaceKey).filemap++;
	for (const [, e] of store.episodes.entries()) {
		const key = e.topicSetId ? findWsOfTopicSet(topicSetsByWs, e.topicSetId) : void 0;
		if (key) row(key).episodes++;
	}
	return [...rows.values()].sort((a, b) => b.topicsets + b.memories + b.requirements + b.filemap - (a.topicsets + a.memories + a.requirements + a.filemap));
}
function findWsOfTopicSet(map, topicSetId) {
	for (const [ws, ids] of map) if (ids.has(topicSetId)) return ws;
}
/**
* Full snapshot for one workspace. Workspace-scoped tables are filtered by
* `workspaceKey`; episodes/dispatches/outbox join through their topic set;
* routing and workspace-free tool memories stay global (session/global scope).
*/
function buildState(store, ws) {
	const topicsets = [];
	for (const [id, t] of store.topicsets.entries()) {
		if (t.workspaceKey !== ws) continue;
		topicsets.push({
			id,
			...t
		});
	}
	topicsets.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const tsIds = new Set(topicsets.map((t) => t.id));
	const memories = [];
	for (const [id, m] of store.memories.entries()) if (m.workspaceKey === ws) memories.push({
		id,
		...m
	});
	memories.sort((a, b) => b.updatedAt - a.updatedAt);
	const requirements = [];
	for (const [id, r] of store.requirements.entries()) if (r.workspaceKey === ws) requirements.push({
		id,
		...r
	});
	requirements.sort((a, b) => b.createdAt - a.createdAt);
	const signals = [];
	for (const [id, s] of store.signals.entries()) if (s.workspaceKey === ws) signals.push({
		id,
		...s
	});
	signals.sort((a, b) => b.lastSeen - a.lastSeen);
	const filemap = [];
	for (const [id, f] of store.filemap.entries()) if (f.workspaceKey === ws) filemap.push({
		id,
		...f
	});
	filemap.sort((a, b) => a.path.localeCompare(b.path));
	const episodes = [];
	for (const [id, e] of store.episodes.entries()) {
		if (e.topicSetId && !tsIds.has(e.topicSetId)) continue;
		episodes.push({
			id,
			...e
		});
	}
	episodes.sort((a, b) => b.timeStart - a.timeStart);
	const dispatches = [];
	for (const [id, d] of store.dispatches.entries()) {
		if (d.topicSetId && !tsIds.has(d.topicSetId)) continue;
		dispatches.push({
			id,
			...d
		});
	}
	dispatches.sort((a, b) => b.createdAt - a.createdAt);
	const dispatchIds = new Set(dispatches.map((d) => d.id));
	const groupIds = new Set(dispatches.map((d) => d.groupId).filter((g) => !!g));
	const outbox = [];
	for (const [id, o] of store.outbox.entries()) {
		if (o.dispatchId && !dispatchIds.has(o.dispatchId)) continue;
		if (!o.dispatchId && o.groupId && !groupIds.has(o.groupId)) continue;
		if (!o.dispatchId && !o.groupId) continue;
		outbox.push({
			id,
			...o
		});
	}
	outbox.sort((a, b) => b.enqueuedAt - a.enqueuedAt);
	const toolMemory = [];
	for (const [id, t] of store.toolMemory.entries()) {
		if (t.workspaceKey && t.workspaceKey !== ws) continue;
		toolMemory.push({
			id,
			...t
		});
	}
	toolMemory.sort((a, b) => a.trigger.localeCompare(b.trigger));
	const routing = [];
	for (const [sessionId, r] of store.routing.entries()) routing.push({
		sessionId,
		...r
	});
	routing.sort((a, b) => b.updatedAt - a.updatedAt);
	return {
		generatedAt: Date.now(),
		workspace: ws,
		topicsets,
		memories,
		episodes,
		requirements,
		dispatches,
		outbox,
		signals,
		toolMemory,
		filemap,
		routing
	};
}
/** Topic-set ids of one workspace: episodes/dispatches join through them. */
function tsIdsOf(store, ws) {
	const ids = /* @__PURE__ */ new Set();
	for (const [id, topicSet] of store.topicsets.entries()) if (topicSet.workspaceKey === ws) ids.add(id);
	return ids;
}
function countWs(entries, ws) {
	let n = 0;
	for (const [, v] of entries) if (v.workspaceKey === ws) n++;
	return n;
}
/** Accept a string (comma separated, EN/CN) or a string array. */
function list(value) {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value === "string") return value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
	return [];
}
function text(value) {
	return typeof value === "string" ? value.trim() : "";
}
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk;
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buf);
	}
	if (size === 0) return {};
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
	return parsed;
}
function sendText(res, status, body, type, head, cors = true) {
	const buf = Buffer.from(body, "utf8");
	const headers = {
		"content-type": type,
		"cache-control": "no-store",
		"content-length": String(buf.length)
	};
	if (cors) {
		headers["access-control-allow-origin"] = "*";
		headers["access-control-allow-methods"] = "GET, POST, HEAD, OPTIONS";
		headers["access-control-allow-headers"] = "x-sm-key, content-type";
	}
	res.writeHead(status, headers);
	if (head) res.end();
	else res.end(buf);
}
/** CORS preflight answer (204, no body). */
function sendCors(res) {
	res.writeHead(204, {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, HEAD, OPTIONS",
		"access-control-allow-headers": "x-sm-key, content-type",
		"access-control-max-age": "600",
		"content-length": "0"
	});
	res.end();
}
function sendJson(res, status, value, head = false) {
	sendText(res, status, JSON.stringify(value), "application/json; charset=utf-8", head);
}
// src/index.ts
const name = "supermemory";
/** Services this plugin consumes; the fiber stays PENDING until all exist. */
const inject = [
	"sessions",
	"tools",
	"storageDomain",
	"sessionPersistence",
	"commands",
	"systemPrompt",
	"userQuestions",
	"agents",
	"workspaceRegistry"
];
/**
* Project the plugin Config onto the tool-ization knobs (one place, so the
* maintenance loop and the tool-activity listener never disagree).
*/
function toolizeConfig(config) {
	return {
		enabled: config.maintenance.autoToolize,
		threshold: config.maintenance.signalsThreshold,
		cooldownMs: config.maintenance.toolizeCooldownMs,
		maxActive: config.maintenance.toolizeMax,
		minSteps: config.maintenance.toolizeMinSteps,
		minDistinctTools: config.maintenance.toolizeMinDistinctTools,
		nearMissHint: config.maintenance.nearMissHint,
		recycleIdleDays: config.maintenance.recycleIdleToolDays
	};
}
const Config = Schema.object({
	enabled: Schema.boolean().description("插件总开关").default(true),
	recall: Schema.object({
		maxItems: Schema.natural().description("recall 注入条数上限").default(5),
		minScore: Schema.natural().description("recall 注入最低分").default(1),
		halfLifeDays: Schema.natural().description("时间衰减半衰期（天）").default(14),
		maxChars: Schema.natural().description("recall 卡片字符上限").default(2400),
		injectStyle: Schema.union([Schema.const("gentle"), Schema.const("plain")]).description("注入语气：gentle 温和起步 / plain 直陈").default("gentle"),
		repeat: Schema.object({
			enabled: Schema.boolean().description("过程内再召回开关（需求 A：同一请求执行过程中继续召回，不只在开头注入一次）").default(true),
			everySteps: Schema.natural().description("自上次召回后又执行了多少次工具调用才再次召回（默认 3，保守；每次召回后计数清零）").default(3),
			maxCardsPerRequest: Schema.natural().description("同一请求内召回卡片总数上限（含开头那张）").default(4),
			maxCharsPerRequest: Schema.natural().description("同一请求内召回卡片字符总量上限").default(6e3),
			dedupe: Schema.boolean().description("已注入过的 memory id 不再重复注入").default(true),
			hotSignal: Schema.boolean().description("高信号变化提前触发：工具报错，或与已有记忆关键词重合度显著上升（新路径单独出现不算，避免每读一个文件就注入）").default(true)
		}).description("过程内再召回参数").default({})
	}).description("检索注入参数").default({}),
	route: Schema.object({
		enabled: Schema.boolean().description("话题集路由开关").default(true),
		driftTurns: Schema.natural().description("连续多少轮低重合才重新路由").default(3),
		driftThreshold: Schema.natural().description("重合度阈值（命中 token 数）").default(1),
		hint: Schema.boolean().description("关键词命中话题集时注入静默提示卡片（不询问、不切换）").default(true),
		llmFallback: Schema.boolean().description("关键词不确定时是否用 LLM 语义匹配（需配置分类器模型）").default(false),
		classifierProvider: Schema.string().description("分类器 provider（llmFallback 开启时必填）").default(""),
		classifierModel: Schema.string().description("分类器模型（llmFallback 开启时必填）").default("")
	}).description("话题集路由参数").default({}),
	dispatch: Schema.object({
		enabled: Schema.boolean().description("异步派发开关").default(true),
		idleReleaseMs: Schema.natural().description("分支空闲释放毫秒数（D5：释放前确认无未交付 outbox）").default(18e5)
	}).description("派发参数").default({}),
	observe: Schema.object({
		enabled: Schema.boolean().description("分支观察与投递开关").default(true),
		maxTokensPolicy: Schema.union([Schema.const("deliver-partial"), Schema.const("fail")]).description("max-tokens 终态处理").default("deliver-partial"),
		interruptAfterMs: Schema.natural().description("需求 D：派发超过多少毫秒没有任何分支活动就判定中断并补发回执（默认 15 分钟）").default(9e5)
	}).description("观察投递参数").default({}),
	maintenance: Schema.object({
		enabled: Schema.boolean().description("维护循环开关").default(true),
		signalsThreshold: Schema.natural().description("工具化序列阈值（同一短流程出现次数）").default(3),
		summaryEveryTurns: Schema.natural().description("话题集梗概滚动更新间隔（轮）").default(10),
		autoToolize: Schema.boolean().description("需求 B：达到阈值自动固化为组合工具（不再等用户确认）；关闭时保留原有人工确认路径").default(true),
		toolizeCooldownMs: Schema.natural().description("自动固化冷却毫秒数（同一工作区两次固化之间的最小间隔，防止无限增长）").default(6e4),
		toolizeMax: Schema.natural().description("组合工具数量上限（达到后不再自动新增）").default(8),
		toolizeMinSteps: Schema.natural().description("自动固化的最少步数（默认 2）").default(2),
		toolizeMinDistinctTools: Schema.natural().description("自动固化要求的最少不同工具数（默认 2；同一工具重复不构成流程）").default(2),
		nearMissHint: Schema.boolean().description("模型手工执行组合工具前几步时，注入一句可直接调用组合工具的提示（走 post-execute additionalContexts，真实可见）").default(true),
		recycleIdleToolDays: Schema.natural().description("零使用组合工具回收天数（0=关闭，只记录不回收）").default(0)
	}).description("维护循环参数").default({}),
	ui: Schema.object({
		enabled: Schema.boolean().description("Web 管理台总开关（/supermemory 路由）").default(true),
		token: Schema.string().description("管理台访问令牌：留空=每次启动随机生成；off=不校验（仅可信 loopback）；其他值=固定令牌").default(""),
		carrier: Schema.union([Schema.const("own"), Schema.const("auto")]).description("HTTP 载体：own=自有 loopback 端口（与 GUI 不同源，侧边栏 browser tab 能打开，默认）；auto=优先宿主 webServer（GUI 同源，省一个端口，但侧边栏 browser tab 会以「应用自身」为由拒绝打开，仅适合系统浏览器）").default("own")
	}).description("Web 管理台参数").default({})
}).description("SuperMemory 记忆插件配置").default({});
/**
* P3: ask about pending tool-ization proposals at the next user turn (§2.3).
* Additive waterfall: the decision is always passed through; only a context
* message is attached when the user accepts (so the hub learns the new tool).
*/
function attachProposals(ctx, store, logger) {
	if (!store) return () => {};
	let createMessage;
	const ensureFactory = async () => {
		if (!createMessage) createMessage = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
		return createMessage;
	};
	return ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (decision.kind !== "enter") return decision;
		if (!(decision.messages ?? []).some((m) => m.source?.kind === "user")) return decision;
		try {
			const pending = [];
			for (const [key, signal] of store.signals.entries()) if (signal.proposalStatus === "pending" && signal.proposedAt !== void 0) pending.push([key, signal]);
			if (pending.length === 0) return decision;
			const signal = pending[0][1];
			const selected = (await ctx.userQuestions.ask({
				questions: [{
					id: "supermemory-toolize",
					header: "工具化提议",
					question: `检测到重复流程「${signal.pattern}」（已出现 ${signal.count} 次）。要固化为组合工具吗？`,
					detail: `样例：${(signal.examples ?? []).slice(0, 3).join("；") || "（无）"}`,
					options: [
						{
							label: "固化为组合工具",
							description: "生成可一次调用完成的组合工具并持久化"
						},
						{
							label: "以后再说",
							description: "保留提议，下次再问"
						},
						{
							label: "不再提示",
							description: "忽略此模式"
						}
					]
				}],
				...payload.agent ? { agent: payload.agent } : {},
				...payload.signal ? { signal: payload.signal } : {}
			}))?.answers?.[0]?.selected?.[0] ?? "";
			const key = pending[0][0];
			if (selected === "固化为组合工具") {
				const { compileComposite, registerComposite, persistComposite } = await import("./composite-Cttx-LIx.js").then((n) => n.r);
				const spec = compileComposite(signal, (signal.samples ?? []).map((raw) => {
					try {
						return JSON.parse(raw);
					} catch {
						return;
					}
				}).filter((s) => s !== void 0));
				await registerComposite(ctx, store, spec);
				await persistComposite(store, spec, key);
				await store.signals.update(key, (r) => ({
					...r,
					proposalStatus: "accepted"
				}));
				logger.info(`supermemory: composite tool ${spec.name} registered`);
				const note = (await ensureFactory())({
					content: [{
						type: "text",
						text: `[SuperMemory] 已固化为组合工具 ${spec.name}：${spec.description}。后续同样流程优先一次调用它。`
					}],
					source: {
						kind: "supermemory",
						form: "notice",
						summary: "组合工具已固化"
					}
				});
				return {
					...decision,
					messages: [...decision.messages, note]
				};
			}
			await store.signals.update(key, (r) => ({
				...r,
				proposalStatus: selected === "不再提示" ? "declined" : r.proposalStatus
			}));
			return decision;
		} catch (error) {
			logger.warn(`supermemory: proposal flow skipped: ${String(error).slice(0, 200)}`);
			return decision;
		}
	});
}
/**
* R18 需求⑤ (软约定): the hub session's role. Injected ONLY when the initiating
* agent is a hub of its workspace — a top-level session (no parent, not a
* subagent) that belongs to no topic set. Branches must never receive this
* text, or they would refuse the very work they were dispatched to do.
*
* Deliberately a SOFT convention: the hub keeps its tools (the user chose
* "soft" over removing them); the prompt only states the division of labour.
*/
const HUB_ROLE_TEXT = [
	"[SuperMemory 中枢会话]",
	"- 你是中枢会话：只做判断、派发（memory_dispatch）与汇总（收到 relay 结果后转述给用户）。",
	"- 不要直接读改文件、执行命令、跑构建或长篇推理——这些操作交给分支会话完成；你的价值是定义清楚任务与边界，再整合结果。",
	"- 派发时先设定能力：要改代码/跑命令用 capabilities=full；只审阅用 read；纯代码编辑用 read-write；汇总/轻量核对用 minimal。",
	"- 需求多或复杂（多个独立子任务、多个方向调研、互相可并行的修复）时，用 memory_dispatch 的 tasks[] 一次拆成多个分支并行协同：",
	"  每个任务一个独立分支，全部到达终态后只回送一次汇总，失败成员会单独标注；不要把一个可拆分的大任务塞进单个分支串行做。",
	"  并行组里的每个任务必须自包含（写清目标、范围、验收），彼此不要依赖同一文件的并发修改。",
	"- 系统上下文会注入「[supermemory 关联分支]」卡：它列出你已拉起的分支（名称/状态/话题集/是否被多个中枢共享），先看它再决定派发。",
	"- 分支归属话题集，可被同一话题集下的其他中枢复用/共享：继续同一条分支用 mode=continue（忙则排队），新任务用 mode=auto（复用空闲分支，否则新建）。",
	"- 不要为同一件工作反复新建分支造成重复/分裂；已完成或空闲的分支优先续派。",
	"- memory_dispatch / memory_resume 返回回执后，立即结束本轮回复：不要调用 wait_agent 等分支、不要轮询分支状态、也不要边等边做无关工作把本轮挂住。",
	"- 原因：分支不是中枢 subagent 树的成员，wait_agent 等不到它们；在本轮内等待只会让分支 relay 在队列里排队，把中枢回合卡住。",
	"- 分支完成后 relay 会作为新消息自动送回本会话并开启新一轮对话；届时再调用 memory_questions 汇总未决问题、把结果转述给用户。",
	"- 同一轮可以连续派发多个任务（含 tasks[] 并行组），全部派发完成后一次性结束本轮回复。",
	"- 分支不会直接问用户：它们的疑问通过 memory_raise_question 上交到你。收到 relay 或用户新消息时，先调用 memory_questions 查看所有未解决问题（含仍在工作的分支）。",
	"- 汇总问题：去重、按主题合并成一份清单，标注来源分支 / 是否阻塞 / 已完成进度 / 默认备选方案，然后用 ask_user_question **一次**向用户提问；不要逐个转发。",
	"- 用户答复后用 memory_questions 的 resolve 结清（可带 answer），再把裁决用 memory_dispatch 派回对应分支。",
	"- 分支已按最合理解释完成、问题不阻塞时不必提问：在汇报里列出它做的假设即可。",
	"- 纯问答、简单确认、记忆检索类问题不必派发，直接答。",
	"- 写入记忆只记结论：memory_remember 里放可复用的事实/决策/约定（跨会话仍然成立）；不要写过程流水账（先做了什么、执行了哪些命令、第几步、工具日志）。",
	"- recall 命中「相关话题集」时，优先直接回答或把任务派发到该话题集，不要重新检索一遍。"
].join("\n");
const PROMPT_TEXT = [
	"[SuperMemory 记忆]",
	"- 涉及历史结论、约定、构建命令、文件用途、\"之前说过/做过什么\"时，先调用 memory_recall 检索再作答。",
	"- 用户明确要求记住某事、或某事实值得跨会话保留时，调用 memory_remember 写入（按工作区隔离）：",
	"  只写结论性、可复用的事实/决策/约定（标题 + 标签 + 正文），禁止把过程流水账、临时步骤、工具调用日志写进记忆。",
	"- 对话连续性：用户在当前对话框直接对话时，你就在当前对话的上下文中继续回答，不要询问是否切换话题、不要自行切换话题集；",
	"  话题集只在用户显式 @话题集名、在 SuperMemory 面板中激活、或执行 /memory switch 时才切换。",
	"- 实质工作必须开新对话执行：当用户提出问题需要实际操作（读改文件、执行命令、多步调研、修复与验证等）时，",
	"  调用 memory_dispatch 把任务派发到话题集分支会话中完成，由分支汇报结果——不要在主对话框里直接完成整套操作或长篇大论；",
	"  主对话框（中枢）只做：判断、派发、收到 relay 结果后轻量转述与交付用户要的最终信息；不要直接读改文件、执行命令或长篇推理。",
	"  派发后即结束本轮回复，不要 wait_agent 等待分支；分支完成后 relay 会自动开启新一轮对话。",
	"  派发前用 capabilities 设定分支能力边界（改代码/跑命令用 full，只审阅用 read，纯编辑用 read-write，汇总/轻量核对用 minimal）；",
	"  纯问答、简单确认、记忆检索类问题不要派发。",
	"- 用户要求可视化管理记忆/打开记忆面板时：SuperMemory 面板已内置在左侧边栏（插件/自动化任务下方的\"超级记忆\"入口），",
	"  直接提示用户点击该入口即可；memory_ui 返回的浏览器管理台链接仅在用户明确要求外部链接时给出。",
	"- 对话中可能出现 [SuperMemory 相关记忆] / [SuperMemory 话题集] / [SuperMemory 话题提示] 注入卡片：仅供参考，",
	"  与用户当前指令冲突时以当前指令为准；[SuperMemory 话题提示] 只是候选列表，不代表已切换话题。"
].join("\n");
async function apply(ctx, config) {
	const logger = ctx.logger("supermemory");
	if (!config?.enabled) {
		logger.info("supermemory: disabled by config");
		return;
	}
	let store;
	try {
		store = await openStoreWithRetry(ctx.storageDomain, logger);
	} catch (error) {
		logger.warn(`supermemory: storage domain unavailable, memory features disabled: ${String(error)}`);
	}
	ctx.effect(() => () => {
		store?.close().catch(() => {});
	}, "supermemory: domain");
	const modelDeps = {
		ctx,
		store,
		logger
	};
	try {
		const disposeTools = await attachTools(ctx, {
			ctx,
			store,
			dispatch: {
				ctx,
				store,
				logger
			},
			model: modelDeps,
			logger
		}, {
			rememberEnabled: true,
			recall: {
				maxItems: config.recall.maxItems,
				minScore: config.recall.minScore,
				halfLifeDays: config.recall.halfLifeDays
			}
		});
		ctx.effect(() => disposeTools, "supermemory: tools");
	} catch (error) {
		logger.warn(`supermemory: tool registration failed: ${String(error)}`);
	}
	const tracker = createTracker();
	ctx.effect(() => attachPreStep(ctx, store, {
		enabled: true,
		maxItems: config.recall.maxItems,
		minScore: config.recall.minScore,
		halfLifeDays: config.recall.halfLifeDays,
		maxChars: config.recall.maxChars,
		injectStyle: config.recall.injectStyle,
		repeat: config.recall.repeat,
		tracker
	}, logger), "supermemory: pre-step");
	ctx.effect(() => attachToolActivity(ctx, store, tracker, {
		repeat: config.recall.repeat,
		nearMissHint: config.maintenance.nearMissHint,
		toolize: toolizeConfig(config)
	}, logger), "supermemory: tool-activity");
	const routeDeps = {
		store,
		...store ? { ctx } : {},
		config: {
			enabled: config.route.enabled,
			driftTurns: config.route.driftTurns,
			driftThreshold: config.route.driftThreshold,
			hint: config.route.hint,
			llmFallback: config.route.llmFallback
		},
		logger
	};
	ctx.effect(() => attachRoute(ctx, routeDeps), "supermemory: route");
	if (store) (async () => {
		try {
			const { rebuildComposites } = await import("./composite-Cttx-LIx.js").then((n) => n.r);
			const count = await rebuildComposites(ctx, store);
			if (count > 0) logger.info("supermemory: rebuilt " + count + " composite tool(s)");
			const sweepCreated = await sweepAutoToolize(ctx, store, toolizeConfig(config), logger);
			if (sweepCreated > 0) logger.info("supermemory: auto-toolized " + sweepCreated + " composite(s) at boot");
		} catch (error) {
			logger.warn(`supermemory: composite rebuild failed: ${String(error).slice(0, 200)}`);
		}
	})();
	ctx.effect(() => attachProposals(ctx, store, logger), "supermemory: proposals");
	ctx.effect(() => attachObserve(ctx, {
		ctx,
		store,
		config: {
			enabled: config.observe.enabled,
			maxTokensPolicy: config.observe.maxTokensPolicy
		},
		logger
	}), "supermemory: observe");
	ctx.effect(() => attachMaintenance(ctx, store, {
		enabled: config.maintenance.enabled,
		signalsThreshold: config.maintenance.signalsThreshold,
		summaryEveryTurns: config.maintenance.summaryEveryTurns,
		autoToolize: config.maintenance.autoToolize,
		toolizeCooldownMs: config.maintenance.toolizeCooldownMs,
		toolizeMax: config.maintenance.toolizeMax,
		toolizeMinSteps: config.maintenance.toolizeMinSteps,
		toolizeMinDistinctTools: config.maintenance.toolizeMinDistinctTools,
		nearMissHint: config.maintenance.nearMissHint,
		recycleIdleToolDays: config.maintenance.recycleIdleToolDays
	}, logger), "supermemory: maintenance");
	const commandDeps = {
		ctx,
		store,
		model: modelDeps,
		logger,
		workspaceKeyOfCwd: workspaceKeyOf
	};
	ctx.effect(() => attachCommands(ctx, commandDeps), "supermemory: commands");
	ctx.effect(() => attachPanel(ctx, store), "supermemory: panel");
	ctx.effect(() => attachWebui(ctx, store, {
		enabled: config.ui?.enabled ?? true,
		token: config.ui?.token ?? "",
		carrier: config.ui?.carrier ?? "own"
	}, logger), "supermemory: web-console");
	ctx.effect(() => ctx.systemPrompt.section({
		name: "supermemory:role",
		order: 900,
		text: PROMPT_TEXT
	}), "supermemory: prompt");
	ctx.effect(() => ctx.systemPrompt.section({
		name: "supermemory:hub-role",
		order: 901,
		text: (context) => {
			let agent;
			try {
				agent = ctx.agents.currentInitiator();
			} catch {
				agent = void 0;
			}
			if (!agent) agent = context?.scope;
			return isHubSession(store, agent) ? HUB_ROLE_TEXT : "";
		}
	}), "supermemory: prompt (hub role)");
	if (store) {
		runReconciliation({
			ctx,
			store,
			logger,
			observe: {
				enabled: config.observe.enabled,
				maxTokensPolicy: config.observe.maxTokensPolicy,
				interruptAfterMs: config.observe.interruptAfterMs
			}
		});
		migrateTruncatedTitles({
			ctx,
			store,
			logger
		}).catch((error) => {
			logger.warn("supermemory: title migration failed: " + String(error).slice(0, 160));
		});
		settleInterruptedDispatches({
			ctx,
			store,
			config: {
				enabled: config.observe.enabled,
				maxTokensPolicy: config.observe.maxTokensPolicy,
				interruptAfterMs: config.observe.interruptAfterMs
			},
			logger
		}, {
			timeoutMs: 0,
			terminalOnly: true,
			reason: "启动对账补发历史中断"
		}).catch(() => {});
	}
	if (store) {
		const releaseStore = store;
		const observeConfig = {
			enabled: config.observe.enabled,
			maxTokensPolicy: config.observe.maxTokensPolicy,
			interruptAfterMs: config.observe.interruptAfterMs
		};
		const noticeState = { signatures: /* @__PURE__ */ new Map() };
		const timer = setInterval(() => {
			try {
				flushObserve({
					ctx,
					store: releaseStore,
					config: observeConfig,
					logger
				}).catch(() => {});
				settleInterruptedDispatches({
					ctx,
					store: releaseStore,
					config: observeConfig,
					logger
				}, { timeoutMs: config.observe.interruptAfterMs }).catch(() => {});
				detachIdleBranches(releaseStore, Date.now(), config.dispatch.idleReleaseMs, logger);
				notifyInterruptedDispatches({
					ctx,
					store: releaseStore,
					config: observeConfig,
					logger
				}, { state: noticeState }).catch(() => {});
			} catch {}
		}, 3e5);
		ctx.effect(() => () => clearInterval(timer), "supermemory: release-sweep");
		const noticeTimer = setTimeout(() => {
			notifyInterruptedDispatches({
				ctx,
				store: releaseStore,
				config: observeConfig,
				logger
			}, { state: noticeState }).catch(() => {});
		}, 1e4);
		ctx.effect(() => () => clearTimeout(noticeTimer), "supermemory: resume-notice");
		ctx.effect(() => () => {
			settleInterruptedDispatches({
				ctx,
				store: releaseStore,
				config: observeConfig,
				logger
			}, {
				timeoutMs: 0,
				reason: "插件重载/卸载导致分支中断"
			}).catch(() => {});
		}, "supermemory: settle-on-dispose");
	}
	logger.info(`supermemory: active (store=${store ? "open" : "degraded"})`);
}
export { Config, apply, inject, name, toolizeConfig };
