import { t as __exportAll } from "./rolldown-runtime-BJohB4LM.js";
import { i as loadHostModule, r as workspaceKeyOf, t as newId } from "./store-Ch9VlqHm.js";
import { _ as updateTopicSetShape, c as getRouting, f as setRouting, h as touchTopicSet, i as clipWithNote, l as getTopicSet, n as clipAtBoundary, t as charCount, u as listTopicSets } from "./clip-DPi0qjxp.js";
import { b as injectionTitle, h as normalizeTags, i as hubSelection, r as enumerateModels, u as tokenize, y as INJECTION_TITLES } from "./model-jCUTlaTL.js";
import { S as upsertCapabilitySkill, _ as resolveSkillRoot, a as archivedCapabilityDocFiles, b as splitFactsBlock, c as capabilitySkillNames, d as isShellIdentity, f as parseSkillMarkdown, g as resolveCapabilityRoot, i as archiveShellSkills, m as readSkillVersionAt, n as archiveCapabilityDoc, o as bodyHashOf, r as archiveCapabilitySkill, s as capabilityDocPath, t as adoptCapabilityDocVersion } from "./skill-forge-DHxPo_w6.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
// src/source.ts
/**
* Build one injection card's source. The label comes from the registry — never
* hand-write `kind: 'supermemory'` for a card (that would collapse every card
* back to the same 「上下文注入 supermemory」 title).
* @param kind - Registered card kind.
* @param formed - Host presentation form (and its required fields), if any.
* @returns The message source whose `kind` is the card label.
*/
function injectionSource(kind, formed = {}) {
	return {
		kind: INJECTION_TITLES[kind],
		...formed
	};
}
// src/role.ts
/** The id a role decision should use for an Agent. */
function agentSessionId(agent) {
	const shaped = agent;
	return String(shaped?.id ?? shaped?.session?.id ?? "");
}
/** Canonical workspace key of an Agent's session cwd (undefined when absent). */
function agentWorkspaceKey(agent) {
	const cwd = agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd.trim() ? workspaceKeyOf(cwd) : void 0;
}
/**
* A marker's workspace agrees with the agent's. Unknown on either side is not a
* mismatch (an old record may predate workspace fields); a known disagreement
* IS one — the hub role is deliberately workspace-scoped.
*/
function workspaceAgrees(markerKey, agentKey) {
	if (!markerKey || !agentKey) return true;
	return markerKey === agentKey;
}
/** Safe iterable view of a table (missing table in a fixture/host-free run). */
function entriesOf(table) {
	if (!table) return [];
	try {
		return [...table.entries()];
	} catch {
		return [];
	}
}
/**
* Resolve one agent's role. Never throws: a store read failure answers
* `other / resolution-error` so the caller's guard can stay total.
*/
function resolveRole(store, agent) {
	const sessionId = agentSessionId(agent);
	const header = agent?.session?.header;
	const workspaceKey = agentWorkspaceKey(agent);
	const base = (role, reason) => ({
		role,
		reason,
		sessionId,
		...workspaceKey ? { workspaceKey } : {}
	});
	if (!store) return base("other", "no-session-id");
	if (!sessionId) return base("other", "no-session-id");
	try {
		if (sessionId.startsWith("branch-") || sessionId.startsWith("fork-")) return base("branch", "plugin-branch-id");
		let sawFork = false;
		for (const [, topicSet] of entriesOf(store.topicsets)) {
			const member = (topicSet.members ?? []).find((row) => row.sessionId === sessionId);
			if (!member) continue;
			if (member.kind === "fork") {
				sawFork = true;
				break;
			}
		}
		if (sawFork) return base("branch", "fork-member");
		for (const [, dispatch] of entriesOf(store.dispatches)) if (dispatch.branchSessionId === sessionId) return base("branch", "dispatch-branch");
		if (header?.origin === "subagent") return base("other", "subagent-child");
		let sawForeignHub = false;
		const hubs = store.hubs;
		try {
			const record = hubs?.get?.(sessionId);
			if (record) {
				if (workspaceAgrees(record.workspaceKey, workspaceKey)) return base("hub", "hub-record");
				sawForeignHub = true;
			}
		} catch {}
		for (const [, topicSet] of entriesOf(store.topicsets)) {
			if (!(topicSet.members ?? []).find((row) => row.sessionId === sessionId && row.kind === "root")) continue;
			if (workspaceAgrees(String(topicSet.workspaceKey ?? ""), workspaceKey)) return base("hub", "topic-set-root");
			sawForeignHub = true;
		}
		for (const [, dispatch] of entriesOf(store.dispatches)) {
			if (dispatch.hubSessionId !== sessionId) continue;
			let markerWorkspace;
			if (dispatch.topicSetId) try {
				markerWorkspace = store.topicsets?.get?.(dispatch.topicSetId)?.workspaceKey;
			} catch {}
			if (workspaceAgrees(markerWorkspace, workspaceKey)) return base("hub", "dispatch-hub");
			sawForeignHub = true;
		}
		return base("other", sawForeignHub ? "workspace-mismatch" : "no-positive-marker");
	} catch {
		return base("other", "resolution-error");
	}
}
/**
* Write (or refresh) one positive hub record. Best-effort: a missing table or a
* closing store loses only the audit row — resolution still sees root members
* and dispatch references.
*/
async function recordHubSession(store, input) {
	const sessionId = String(input.sessionId ?? "").trim();
	if (!store || !sessionId) return;
	try {
		const table = store.hubs;
		if (!table || typeof table.put !== "function") return;
		const existing = typeof table.get === "function" ? table.get(sessionId) : void 0;
		const now = Date.now();
		const source = existing?.source ?? input.source ?? "panel";
		await table.put(sessionId, {
			workspaceKey: String(input.workspaceKey || existing?.workspaceKey || "unknown"),
			sessionId,
			title: String(input.title ?? existing?.title ?? ""),
			source,
			lastSource: input.source ?? existing?.lastSource ?? source,
			createdAt: Number(existing?.createdAt) || now,
			updatedAt: now
		});
	} catch {}
}
/**
* Seed hub records from durable positive evidence (root members + dispatch hub
* references) so the R33 table is populated for media written by earlier
* rounds. Idempotent; returns the number of rows written.
*/
async function backfillHubRecords(store, logger) {
	if (!store) return 0;
	let written = 0;
	try {
		const existing = /* @__PURE__ */ new Set();
		try {
			for (const [id] of store.hubs.entries()) existing.add(id);
		} catch {}
		for (const [, topicSet] of entriesOf(store.topicsets)) for (const member of topicSet.members ?? []) {
			if (member.kind !== "root" || existing.has(member.sessionId)) continue;
			if (resolveRole(store, { id: member.sessionId }).role === "branch") continue;
			await recordHubSession(store, {
				sessionId: member.sessionId,
				workspaceKey: String(topicSet.workspaceKey ?? "unknown"),
				title: member.title,
				source: "topicset-root"
			});
			existing.add(member.sessionId);
			written += 1;
		}
		for (const [, dispatch] of entriesOf(store.dispatches)) {
			const id = String(dispatch.hubSessionId ?? "");
			if (!id || existing.has(id)) continue;
			let workspaceKey = "unknown";
			try {
				workspaceKey = String(store.topicsets?.get?.(dispatch.topicSetId ?? "")?.workspaceKey ?? "unknown");
			} catch {}
			await recordHubSession(store, {
				sessionId: id,
				workspaceKey,
				source: "dispatch"
			});
			existing.add(id);
			written += 1;
		}
	} catch (error) {
		logger?.warn("supermemory: hub record backfill failed: " + String(error).slice(0, 160));
	}
	return written;
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
const CAPABILITY_ROUTING_RULES = "固化能力（capability）路由规则：① 在能力适用范围（scope）内遇到高频事务（git 同步/提交/推送、构建、验证、测试、发布等）时，优先调用已固化能力（sm_cap_*，默认预演、写操作 confirm=true 确认真实执行），不要每次现敲命令；② 重复工作先沉淀经验：判断型、易变的流程用 memory_toolize register 产出/更新能力知识面（描述写「何时用」，正文写触发条件/步骤/关键坑/验证；模型用 sm_cap_doc 按需读取，不要用宿主 skill 工具加载能力），不要满足于一次性工作；确实需要固定入口命令时才固化能力（入口命令 + 文档 + 适用范围）；③ 能力执行连续失败、或文档与现状不符时，必须用 memory_toolize register 同名更新能力（version+1、changelog 记录原因），不要绕过它手敲命令；④ 用 memory_toolize refresh-builtin 刷新内置能力并查看差异报告与健康度（使用次数、成败分列、连续失败、文档/适用范围缺失、零使用），按信号决定更新还是停用；⑤ 职责边界（R55）：中枢只能只读检查——用 sm_cap_doc 读知识面判断是否适用，执行必须 memory_dispatch 派发到分支（sm_cap_* 在中枢被 HUB_CAPABILITY_EXEC_DENIED 拒绝）；分支才是执行者（默认预演，写操作 confirm=true）。";
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
					card: renderCard(getTopicSet(store, id)),
					cardKind: "topic"
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
					card: renderCard(active),
					cardKind: "topic"
				};
			}
			const drift = routing.driftCount + 1;
			if (drift < config.driftTurns) {
				await setRouting(store, sessionId, { driftCount: drift });
				return {
					topicSetId: routing.activeTopicSetId,
					card: renderCard(active),
					cardKind: "topic"
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
	const lines = candidates.map((c) => `- 『${c.topicSet.title}』${c.topicSet.summary ? `：${clipWithNote(c.topicSet.summary, 80)}` : ""}`);
	return {
		cardKind: "topicCandidate",
		card: [
			injectionTitle("topicCandidate"),
			"检测到可能与当前对话相关的历史话题（未切换，当前对话继续）：",
			...lines,
			"需要切换时：在消息里 @话题集名，或在 SuperMemory 面板中点击激活。"
		].join("\n")
	};
}
/**
* True when the session is one of this plugin's branch sessions.
*
* R35: the local R19 rule (prefix + fork member) was a SECOND branch authority —
* it missed `dispatches.branchSessionId`, so a dispatch branch reached through
* `mode: continue` on a non-`branch-*` id could be routed as a hub. Resolution
* now goes through {@link resolveRole}, the single authority (branch facts win,
* then positive hub marks, otherwise other).
*/
function isBranchSession(store, sessionId) {
	return resolveRole(store, { id: sessionId }).role === "branch";
}
/** The model-facing topicset context card (§1.2 final step). */
function renderCard(topicSet) {
	if (!topicSet) return "";
	const lines = [`${injectionTitle("topic")} ${topicSet.title}`, topicSet.summary ? `梗概：${topicSet.summary}` : "梗概：（暂无，随对话滚动更新）"];
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
			const factory = await ensureFactory();
			const cardSource = outcome.cardKind === "topicCandidate" ? injectionSource("topicCandidate", { form: "recall" }) : injectionSource("topic", { form: "recall" });
			const card = factory({
				content: [{
					type: "text",
					text: outcome.card
				}],
				source: cardSource
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
* store 里、不随代码维护。内置能力把定义收进源码：rebuildCapabilities 启动
* 重建时与 store 合并（缺失→播种、旧版→升级、现场更新→保留），能力定义从此
* 随插件代码一起被维护（改入口/文档/路由描述 = 改这个文件 + version+1）。
*
* 合并/升级策略（mergeBuiltinCapabilities，src/capability.ts）：
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
/** Package names this plugin is installed under: the published scoped name and the pre-1.4.0 dev name. */
const PLUGIN_PACKAGE_NAMES = /* @__PURE__ */ new Set(["@frogmoo/dsh-supermemory", "dsh-supermemory"]);
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
* node_modules/@frogmoo/dsh-supermemory（1.4.0 起的 scoped 名；更早的草稿名是
* node_modules/dsh-supermemory）是指向源码仓库的符号链接，Node 默认解析 realpath）：
* import.meta.url → lib/<file>.js → 逐级向上找到含 package.json（name 为本包的
* scoped 名或旧名）的目录即仓库根；找不到时退回「模块目录的上一级」（lib/ 的父目录）。
*
* 兜底说明：安装成副本（非符号链接）时推导值是副本包根——此时该能力本就不适用
* （入口脚本与 docs 在副本里，不是 git 仓库），能力描述已要求调用前先确认是本仓库。
*/
function resolvePluginRepoRoot(moduleUrl = import.meta.url) {
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	let dir = moduleDir;
	for (let depth = 0; depth < 4; depth += 1) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (typeof pkg?.name === "string" && PLUGIN_PACKAGE_NAMES.has(pkg.name)) return dir;
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
	version: 7,
	title: "git 同步/提交/推送（SuperMemory 仓库）",
	description: "SuperMemory 仓库 git 同步/提交/推送固化流程。先确认工作区是本仓库（有 scripts/git-sync-push.sh），否则不触发。优先 pnpm git:sync，不要手敲 fetch/rebase/push。凭据走仓库本地 GCM（helper=manager）；GIT_TERMINAL_PROMPT=0，失败找用户，勿改全局 config/remote。推送（2026-11-23 起双远程）：origin push = GitHub（FrogMoo/SuperMemory，首位）+ 内网 Gitee 镜像，fetch/pull 只走 Gitee；首个 push URL 失败即中止后续推送，故远程排位即韧性。Gitea 2026-11-22 晚曾重置、已恢复（帐号改名为 Zry）。日常=跑入口；预演=加 --dry-run；提交前闸门 pnpm typecheck + pnpm smoke，提交信息写文件后 commit -F。凭据键坑与恢复流程见 docs/git-sync.md。",
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
		"v6: 清理能力定义中的平台旧帐号身份信息（描述与 changelog 不再出现旧帐号名与邮箱）；路由与操作内容不变。",
		"v5: 描述压回 500 字上限内并更新为现状。根因：v4 描述 725 字超过 buildCapabilitySpec 的 500 字上限，mergeBuiltinCapabilities 静默跳过播种（report.seeded=[]），capability-smoke C3 与 workspace-scope W5 因此失败、内置能力计数差 1。内容更新：Gitea 2026-11-22 晚重置后已恢复（帐号改名为 Zry，非重建）、origin push = GitHub（首位）+ Gitee Zry/SuperMemory、fetch/pull 只走 Gitee、凭据走仓库本地 GCM（git http 传输的凭据键 host 带端口，换帐号时该键与 host+port 分开写法都要 approve、旧键要 reject）。",
		"v4: 双远程同时推送（origin push URL = GitHub 优先 + Gitee，fetch 仍只走 Gitee；git 2.55 首个 push URL 失败即中止后续推送，故 GitHub 排首位保障 Gitee 故障期推送不落空）；记录 Gitee 服务器 2026-11-22 重置、旧帐号名仓库 404 的现状与恢复后 URL 更新方法。",
		"v3: 凭据改为走仓库本地 GCM（manager + Windows 凭据存储）；旧 store 方案（~/.git-credentials）已失效（文件不存在，fetch 必报 could not read Username），脚本与 docs 同步更新。",
		"v2: scope 改为从插件位置自动推导（原硬编码 G:\\09 - dsh\\SuperMemory），修复仓库迁移后「适用范围目录不存在」导致能力对当前工作区失效；升级时由旧 scope 继承的行级归属一并迁移。",
		"v1: 能力内置化（原由 memory_toolize register 手工录入）：随插件分发，清库/全新安装后自动播种；附带使用统计（成败分列/连续失败/最近一次结果）与刷新入口 memory_toolize refresh-builtin。"
	]
}]);
// src/capability.ts
/**
* Unified capability (R50): ONE record, TWO faces — knowledge (SKILL.md) and
* execution (sm_cap_<name>).
*
* R50 (2026-11-26) replaced the old split between "composite tools" (tool
* sequences compiled into one call), "capabilities" (entry command + doc +
* scope) and the separate auto-generated skill list. A capability is now a
* single durable record:
*
*   kind='capability'  executable + knowledge face (entry command);
*   kind='knowledge'   knowledge face only (SKILL.md, no entry);
*   kind='proposal'    pending auto knowledge draft (accept -> capability).
*
* The old sequence pipeline is GONE: no compile/register/rebuild path exists
* for sm_composite_* tools. Legacy rows are migrated lazily and idempotently:
*   - old capability rows (kind='composite' + spec.kind='capability') become
*     capabilities, renamed sm_composite_<x> -> sm_cap_<x>, with a SKILL.md;
*   - old kind='skill' rows become knowledge (no entry);
*   - old tool-sequence rows become status='retired' (audit only, never registered).
*
* Execution semantics are unchanged: scope/workspace gate, default dry-run
* (dryRunArg), writeConfirm requires confirm=true, output clipped and
* time-limited. One tool per capability, named sm_cap_<name>, with a fixed
* entry (no arbitrary argument passthrough); it only accepts dry_run/confirm.
*
* @module supermemory/capability
*/
var capability_exports = /* @__PURE__ */ __exportAll({
	acceptProposal: () => acceptProposal,
	bumpCapabilityLoad: () => bumpCapabilityLoad,
	capabilityHealthOf: () => capabilityHealthOf,
	capabilityLogicalName: () => capabilityLogicalName,
	capabilityRows: () => capabilityRows,
	capabilityToolName: () => capabilityToolName,
	declineProposal: () => declineProposal,
	isShellUnit: () => isShellUnit,
	liveCapabilityNames: () => liveCapabilityNames,
	loadCapabilityDoc: () => loadCapabilityDoc,
	mergeBuiltinCapabilities: () => mergeBuiltinCapabilities,
	pendingProposalsOf: () => pendingProposalsOf,
	rebuildCapabilities: () => rebuildCapabilities,
	registerCapability: () => registerCapability,
	registerCapabilityTool: () => registerCapabilityTool,
	setCapabilityEnabled: () => setCapabilityEnabled
});
/** Serialized record marker (distinguishes new JSON from legacy CompositeSpec). */
const CAPABILITY_SCHEMA = "sm.capability/1";
/** Tool prefix of the execution face. sm_composite_* is retired for good. */
const CAPABILITY_PREFIX = "sm_cap_";
/** Logical name -> registered tool name (git-sync-supermemory -> sm_cap_git_sync_supermemory). */
function capabilityToolName(name) {
	const slug = String(name ?? "").replace(/^sm_cap_|^sm_composite_|^sm-/, "").trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 41);
	return CAPABILITY_PREFIX + (slug || "capability");
}
/** Logical name -> skill name (git-sync-supermemory -> sm-git-sync-supermemory). */
function capabilitySkillName(name) {
	return capabilitySkillNames(name).skillName;
}
/** Normalise any historical name form to the logical kebab slug. */
function capabilityLogicalName(name) {
	return String(name ?? "").trim().replace(/^sm_cap_|^sm_composite_|^sm-/, "").replace(/_/g, "-").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "capability";
}
const CHANGELOG_MAX = 20;
const PROPOSAL_TTL_MS = 2592e6;
const PROPOSAL_MAX = 20;
function num(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
function str(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}
/** Normalise a record read from any historical shape (never throws). */
function normalizeCapabilityRecord(raw, row) {
	const isNew = raw.schema === CAPABILITY_SCHEMA;
	const kind = raw.kind === "proposal" || raw.kind === "knowledge" || row?.kind === "knowledge" || row?.kind === "proposal" ? raw.kind === "proposal" || row?.kind === "proposal" ? "proposal" : "knowledge" : "capability";
	const name = isNew ? capabilityLogicalName(str(raw.name)) : capabilityLogicalName(str(raw.name) || str(row?.trigger) || "capability");
	const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
	const facts = raw.facts && typeof raw.facts === "object" ? raw.facts : {};
	const entryDraft = str(raw.entryDraft ?? row?.entryDraft);
	const entry = kind === "capability" || raw.kind === "capability" ? str(raw.entry) : str(raw.entry);
	const enabled = raw.enabled === void 0 ? row?.enabled === false ? false : row?.status !== "retired" : Boolean(raw.enabled);
	return {
		schema: CAPABILITY_SCHEMA,
		name,
		kind,
		title: str(raw.title) || name,
		description: str(raw.description) || str(row?.description),
		tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)).slice(0, 8) : row?.tags ?? [],
		entry,
		entryDraft,
		entryVerified: Boolean(raw.entryVerified ?? row?.entryVerified ?? (entry && !entryDraft)),
		doc: str(raw.doc),
		scope: str(raw.scope),
		runnable: raw.runnable === void 0 ? Boolean(entry) : Boolean(raw.runnable),
		enabled,
		dryRunArg: str(raw.dryRunArg),
		writeConfirm: Boolean(raw.writeConfirm),
		routeNote: str(raw.routeNote),
		source: str(raw.source) || str(row?.source) || "manual",
		taskKey: str(raw.taskKey ?? row?.taskKey),
		version: Math.max(1, num(raw.version, 1)),
		updatedAt: num(raw.updatedAt ?? row?.createdAt, Date.now()),
		changelog: Array.isArray(raw.changelog) ? raw.changelog.map((line) => String(line)).slice(0, CHANGELOG_MAX) : [],
		skillPath: str(raw.skillPath ?? row?.skillPath),
		bodyHash: str(raw.bodyHash ?? row?.bodyHash),
		factsHash: str(raw.factsHash ?? row?.factsHash),
		facts,
		loadCount: Math.max(0, num(raw.loadCount, num(row?.loadCount))),
		runCount: Math.max(0, num(raw.runCount, num(row?.runCount, num(row?.useCount)))),
		successCount: Math.max(0, num(raw.successCount, num(usage.successCount))),
		failCount: Math.max(0, num(raw.failCount, num(usage.failCount))),
		consecutiveFailures: Math.max(0, num(raw.consecutiveFailures, num(usage.consecutiveFailures))),
		...num(raw.lastUsedAt ?? usage.lastUsedAt) > 0 ? { lastUsedAt: num(raw.lastUsedAt ?? usage.lastUsedAt) } : {},
		...raw.lastStatus ?? usage.lastStatus ? { lastStatus: raw.lastStatus ?? usage.lastStatus } : {},
		...raw.lastDryRun !== void 0 ? { lastDryRun: Boolean(raw.lastDryRun) } : usage.lastDryRun !== void 0 ? { lastDryRun: Boolean(usage.lastDryRun) } : {},
		...raw.lastExitCode !== void 0 ? { lastExitCode: num(raw.lastExitCode) } : usage.lastExitCode !== void 0 ? { lastExitCode: num(usage.lastExitCode) } : {},
		...typeof (raw.lastSummary ?? usage.lastSummary) === "string" ? { lastSummary: String(raw.lastSummary ?? usage.lastSummary).slice(0, 200) } : {},
		builtin: Boolean(raw.builtin),
		...raw.builtinVersion !== void 0 ? { builtinVersion: num(raw.builtinVersion) } : {},
		...raw.proposalStatus ? { proposalStatus: raw.proposalStatus } : {},
		...raw.expiresAt !== void 0 ? { expiresAt: num(raw.expiresAt) } : {},
		...typeof raw.draftBody === "string" ? { draftBody: raw.draftBody } : {},
		...typeof raw.acceptedId === "string" ? { acceptedId: raw.acceptedId } : {}
	};
}
/** Convert one legacy CompositeSpec capability definition (pre-R50). */
function legacyCapabilityRecord(spec, row) {
	return normalizeCapabilityRecord({
		...spec,
		schema: CAPABILITY_SCHEMA,
		kind: "capability",
		entry: spec.entry,
		entryVerified: true,
		source: "migrated"
	}, row);
}
function skillPathOfLegacyRow(row) {
	const entry = str(row.entry);
	if (!entry) return "";
	if (entry.startsWith("{")) try {
		const parsed = JSON.parse(entry);
		return str(parsed.skillPath) || str(parsed.entryPath);
	} catch {
		return "";
	}
	return entry;
}
function skillNameOfLegacyRow(row) {
	const trigger = str(row.trigger);
	const fromTrigger = /skill\/(.+)$/.exec(trigger)?.[1];
	if (fromTrigger) return fromTrigger;
	const path = skillPathOfLegacyRow(row);
	const match = /[\\/]([^\\/]+)[\\/]SKILL\.md$/.exec(path);
	return match ? match[1] : str(row.title) || "skill";
}
/** Parse one row into a unified record; undefined for legacy sequence/unknown rows. */
function readCapabilityRow(row, id = "") {
	if (!row) return void 0;
	if (row.kind === "proposal") {
		let raw;
		try {
			raw = JSON.parse(row.entry);
		} catch {
			return;
		}
		const record = normalizeCapabilityRecord(raw, row);
		record.kind = "proposal";
		record.proposalStatus = raw.proposalStatus ?? "pending";
		return {
			id,
			row,
			record
		};
	}
	if (row.kind === "knowledge" || row.kind === "skill") {
		const path = row.kind === "skill" ? skillPathOfLegacyRow(row) : row.skillPath ?? "";
		if (row.entry.startsWith("{")) try {
			const raw = JSON.parse(row.entry);
			if (raw.schema === "sm.capability/1") {
				const record = normalizeCapabilityRecord(raw, row);
				record.kind = "knowledge";
				if (!record.skillPath && path) record.skillPath = path;
				return {
					id,
					row,
					record
				};
			}
		} catch {}
		let file;
		if (path) try {
			file = parseSkillMarkdown(readFileSync(path, "utf8"), "");
		} catch {
			file = void 0;
		}
		const name = file?.name || skillNameOfLegacyRow(row);
		return {
			id,
			row,
			record: normalizeCapabilityRecord({
				schema: CAPABILITY_SCHEMA,
				name,
				kind: "knowledge",
				title: row.title || name,
				description: file?.description || row.description,
				entry: "",
				entryVerified: false,
				runnable: false,
				source: str(row.source) || "migrated",
				taskKey: file?.taskKey ?? row.taskKey,
				version: file?.version ?? 1,
				changelog: file?.changelog ?? [],
				bodyHash: file?.bodyHash ?? row.bodyHash,
				factsHash: file?.factsHash ?? row.factsHash,
				skillPath: path
			}, row)
		};
	}
	if (row.kind !== "capability" && row.kind !== "composite" && row.kind !== "workflow") return void 0;
	let raw;
	try {
		raw = JSON.parse(row.entry);
	} catch {
		return;
	}
	if (!raw || typeof raw !== "object") return void 0;
	if (raw.schema === "sm.capability/1") return {
		id,
		row,
		record: normalizeCapabilityRecord(raw, row)
	};
	if (raw.kind !== "capability" || !str(raw.entry)) return void 0;
	return {
		id,
		row,
		record: legacyCapabilityRecord(raw, row)
	};
}
/** Build the durable row projection for one record. */
function rowOfRecord(record, workspaceKey, createdAt) {
	return {
		...workspaceKey ? { workspaceKey } : {},
		...createdAt !== void 0 ? { createdAt } : {},
		kind: record.kind,
		title: record.title,
		tags: record.tags.slice(0, 8),
		trigger: record.kind === "proposal" ? "proposal/" + record.name : "capability/" + record.name,
		description: record.description,
		entry: JSON.stringify(record),
		useCount: record.runCount,
		status: record.kind === "proposal" ? record.proposalStatus === "pending" ? "active" : "retired" : record.enabled === false ? "retired" : "active",
		...record.skillPath ? { skillPath: record.skillPath } : {},
		enabled: record.enabled !== false,
		loadCount: record.loadCount,
		runCount: record.runCount,
		source: record.source,
		...record.taskKey ? { taskKey: record.taskKey } : {},
		entryDraft: record.entryDraft,
		entryVerified: record.entryVerified,
		...record.bodyHash ? { bodyHash: record.bodyHash } : {},
		...record.factsHash ? { factsHash: record.factsHash } : {}
	};
}
/** True when the record has a usable execution face. */
function isExecutable(record) {
	return record.kind === "capability" && Boolean(record.entry) && record.runnable !== false && record.enabled !== false;
}
/** Every unified record (capability/knowledge/proposal), broken rows skipped. */
function capabilityRows(store, workspaceKey) {
	const out = [];
	for (const [id, row] of store.toolMemory.entries()) {
		if (!row || ![
			"capability",
			"knowledge",
			"proposal",
			"composite",
			"skill",
			"workflow"
		].includes(row.kind)) continue;
		const parsed = readCapabilityRow(row, id);
		if (!parsed) continue;
		if (workspaceKey !== void 0 && !capabilityAppliesToWorkspace(parsed.record, workspaceKey, row.workspaceKey)) continue;
		out.push(parsed);
	}
	return out.sort((left, right) => left.record.name.localeCompare(right.record.name));
}
/** A capability belongs to a workspace via row ownership or scope. */
function capabilityAppliesToWorkspace(record, callerWorkspace, rowWorkspaceKey) {
	if (!callerWorkspace) return true;
	const own = rowWorkspaceKey || (record.scope ? workspaceKeyOf(record.scope) : void 0);
	if (!own) return true;
	return own === callerWorkspace;
}
/** A caller cwd is inside the capability scope (equal or descendant). */
function scopeContains(scope, cwd) {
	if (!scope || !cwd) return true;
	try {
		const base = resolve(scope).replace(/[\\/]+$/, "").toLowerCase();
		const target = resolve(cwd).replace(/[\\/]+$/, "").toLowerCase();
		return target === base || target.startsWith(base + sep);
	} catch {
		return false;
	}
}
function findCapabilityRow(store, options) {
	if (options.id) return readCapabilityRow(store.toolMemory.get(options.id), options.id);
	if (!options.name) return void 0;
	const target = capabilityLogicalName(options.name);
	for (const candidate of capabilityRows(store)) {
		if (candidate.record.name !== target) continue;
		if (options.workspaceKey && candidate.row.workspaceKey && candidate.row.workspaceKey !== options.workspaceKey) continue;
		return candidate;
	}
}
async function saveCapabilityRecord(store, record, options = {}) {
	if (options.id) {
		await store.toolMemory.update(options.id, (row) => ({
			...row,
			...rowOfRecord(record, options.workspaceKey ?? row.workspaceKey, row.createdAt ?? options.createdAt)
		}));
		return options.id;
	}
	const id = newId("tm");
	await store.toolMemory.put(id, rowOfRecord(record, options.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : void 0), options.createdAt ?? Date.now()));
	return id;
}
/**
* R51: a unit that is really a legacy tool-order shell, even after R50 rewrote
* its SKILL.md face from `sm-source: sequence` to `sm-source: capability`.
* Executable capabilities are never shells — only knowledge-only units qualify.
*/
function isShellUnit(record) {
	if (record.kind === "capability" && String(record.entry ?? "").trim()) return false;
	return isShellIdentity({
		name: record.name,
		description: record.description,
		source: record.source,
		body: record.draftBody
	});
}
/** Retire one unit row without deleting it (audit + rollback stay possible). */
async function retireUnitRow(store, id) {
	await store.toolMemory.update(id, (row) => ({
		...row,
		status: "retired",
		enabled: false
	}));
}
/**
* R51: idempotently retire every adopted tool-order shell unit.
* Used by migration, boot cleanup and `memory_toolize cleanup`; never deletes.
*/
async function retireShellUnits(store, options = {}) {
	const retired = [];
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind === "proposal") continue;
		if (entry.row.status === "retired") continue;
		if (!isShellUnit(entry.record)) continue;
		retired.push({
			id: entry.id,
			name: entry.record.name
		});
		if (!options.dryRun) try {
			await retireUnitRow(store, entry.id);
		} catch {}
	}
	return retired;
}
function normalizePathKey(path) {
	try {
		return resolve(path).replace(/\\/g, "/").toLowerCase();
	} catch {
		return String(path ?? "").replace(/\\/g, "/").toLowerCase();
	}
}
function skillRootOf(file) {
	try {
		const normalized = resolve(file).replace(/\\/g, "/");
		const lower = normalized.toLowerCase();
		const index = lower.lastIndexOf("/.dsh/skills/");
		if (index >= 0) return resolve(normalized.slice(0, index + 13 - 1));
		const homeSkills = resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "skills").replace(/\\/g, "/");
		if (lower.startsWith(homeSkills.toLowerCase() + "/")) return resolve(homeSkills);
	} catch {}
}
async function migrateCapabilityDocs(store, options = {}) {
	const now = options.now ?? Date.now();
	const report = {
		moved: 0,
		archivedDirs: 0,
		skippedManual: 0,
		skippedShells: 0,
		changed: false,
		entries: []
	};
	for (const entry of capabilityRows(store)) {
		const record = entry.record;
		if (record.kind === "proposal" || entry.row.status === "retired") continue;
		const oldPath = String(record.skillPath ?? "").trim();
		if (!oldPath) continue;
		if (!skillRootOf(oldPath)) continue;
		const owned = entry.row.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : void 0);
		if (!owned || owned === "unknown" || !isAbsolute(owned) || !existsSync(owned)) continue;
		const newRoot = options.capabilityRoot ?? resolveCapabilityRoot(owned).root;
		const newPath = capabilityDocPath(newRoot, record.name);
		const oldExists = existsSync(oldPath);
		const newExists = existsSync(newPath);
		if (oldExists) {
			let parsed;
			try {
				parsed = parseSkillMarkdown(readFileSync(oldPath, "utf8"), capabilitySkillName(record.name));
			} catch {
				parsed = void 0;
			}
			if (!parsed) continue;
			if (parsed.source === "sequence" || isShellIdentity({
				name: parsed.name,
				description: parsed.description,
				source: parsed.source,
				body: parsed.body
			})) {
				report.skippedShells += 1;
				continue;
			}
			if (parsed.source !== "capability") {
				report.skippedManual += 1;
				continue;
			}
			if (!newExists) try {
				mkdirSync(newRoot, { recursive: true });
				copyFileSync(oldPath, newPath);
			} catch (error) {
				options.logger?.info("supermemory: capability doc copy failed " + oldPath + ": " + String(error).slice(0, 120));
				continue;
			}
			const oldSkillRoot = dirname(dirname(oldPath));
			const oldSkillName = basename(dirname(oldPath));
			let archivePath;
			try {
				const archived = await archiveCapabilitySkill(oldSkillRoot, oldSkillName, {
					now,
					reason: "R52 能力知识面迁移：从宿主 skill 目录移出到 .dsh/capabilities（可回滚）"
				});
				archivePath = archived?.archivePath;
				if (archived) report.archivedDirs += 1;
			} catch {}
			if (!archivePath) continue;
			await saveCapabilityRecord(store, {
				...record,
				skillPath: newPath
			}, {
				id: entry.id,
				workspaceKey: entry.row.workspaceKey,
				createdAt: entry.row.createdAt
			});
			report.moved += 1;
			report.changed = true;
			report.entries.push({
				name: record.name,
				from: oldPath,
				to: newPath,
				archivePath
			});
			options.logger?.info("supermemory: capability doc moved " + record.name + " -> " + newPath);
			continue;
		}
		if (newExists) {
			await saveCapabilityRecord(store, {
				...record,
				skillPath: newPath
			}, {
				id: entry.id,
				workspaceKey: entry.row.workspaceKey,
				createdAt: entry.row.createdAt
			});
			report.moved += 1;
			report.changed = true;
			report.entries.push({
				name: record.name,
				from: oldPath,
				to: newPath
			});
		}
	}
	return report;
}
/** R54: one-line explanation written into the knowledge face when a version is restored. */
function versionRestoreLine(version, restoredFrom) {
	if (!restoredFrom) return "v" + version + ": 知识面版本与能力记录对齐（R54 单调化）";
	let source = "";
	try {
		source = basename(dirname(restoredFrom));
	} catch {
		source = "";
	}
	return "v" + version + ": R52 迁移到 .dsh/capabilities，保留归档版本" + (source ? "（源自归档 " + source + "）" : "");
}
/**
* R54: enforce the monotonic knowledge-face version ledger.
*
* R52's migration could regenerate `.dsh/capabilities/<name>.md` from a stale
* record version (6) while the pre-R52 archive still carried the newer file
* (8) — the live document then regressed two versions. The rule is now
* max(record.version, live file version, every archived version); when the max
* comes from somewhere else, the live file is rewritten AT that version (prose
* untouched) and the restoration is recorded in both the file and the record.
* Idempotent: a second pass finds every ledger aligned and reports changed=false.
*/
async function reconcileCapabilityVersions(store, options = {}) {
	const now = options.now ?? Date.now();
	const report = {
		reconciled: 0,
		changed: false,
		entries: []
	};
	for (const entry of capabilityRows(store)) {
		const record = entry.record;
		if (record.kind === "proposal" || entry.row.status === "retired") continue;
		const owned = entry.row.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : void 0);
		let root = options.capabilityRoot;
		let skillsRoot = options.skillsRoot;
		const usable = owned && owned !== "unknown" && isAbsolute(owned) && existsSync(owned);
		if (!root && usable) try {
			root = resolveCapabilityRoot(owned).root;
		} catch {
			root = void 0;
		}
		if (!skillsRoot && usable) try {
			skillsRoot = resolveSkillRoot(owned).root;
		} catch {
			skillsRoot = void 0;
		}
		if (!root) continue;
		const livePath = String(record.skillPath ?? "").trim();
		const docPath = livePath && existsSync(livePath) ? livePath : capabilityDocPath(root, record.name);
		const archived = archivedCapabilityDocFiles(root, record.name, skillsRoot).map((file) => ({
			file,
			version: readSkillVersionAt(file)
		})).filter((row) => row.version > 0).sort((left, right) => right.version - left.version);
		if (!existsSync(docPath)) {
			if (archived.length === 0) continue;
			try {
				mkdirSync(dirname(docPath), { recursive: true });
				copyFileSync(archived[0].file, docPath);
			} catch {
				continue;
			}
		}
		const fileVersion = readSkillVersionAt(docPath);
		const preserved = Math.max(record.version, fileVersion, archived[0]?.version ?? 0);
		if (preserved <= record.version && preserved <= fileVersion) continue;
		const restoredFrom = archived[0] && archived[0].version > Math.max(record.version, fileVersion) ? archived[0].file : void 0;
		const line = versionRestoreLine(preserved, restoredFrom);
		let restoredHistory = [];
		if (restoredFrom) try {
			restoredHistory = parseSkillMarkdown(readFileSync(restoredFrom, "utf8"), capabilitySkillNames(record.name).skillName)?.changelog ?? [];
		} catch {
			restoredHistory = [];
		}
		const adopted = adoptCapabilityDocVersion({
			path: docPath,
			name: record.name,
			title: record.title,
			tags: record.tags,
			version: preserved,
			changelogLine: line,
			...restoredHistory.length > 0 ? { extraChangelog: restoredHistory } : {},
			now
		});
		if (adopted.status === "error") {
			options.logger?.info("supermemory: capability version reconcile failed " + record.name + ": " + adopted.message);
			continue;
		}
		const next = {
			...record,
			version: adopted.version,
			updatedAt: now,
			changelog: (record.changelog[0] === line ? record.changelog : [line, ...record.changelog]).slice(0, CHANGELOG_MAX),
			skillPath: docPath,
			...adopted.bodyHash ? { bodyHash: adopted.bodyHash } : {},
			...adopted.factsHash ? { factsHash: adopted.factsHash } : {}
		};
		const builtin = BUILTIN_CAPABILITIES.find((candidate) => capabilityLogicalName(candidate.name) === record.name);
		if (builtin) {
			next.builtin = true;
			next.builtinVersion = builtin.version;
		}
		await saveCapabilityRecord(store, next, {
			id: entry.id,
			workspaceKey: entry.row.workspaceKey,
			createdAt: entry.row.createdAt
		});
		report.reconciled += 1;
		report.changed = true;
		report.entries.push({
			name: record.name,
			version: adopted.version,
			path: docPath,
			...restoredFrom ? { restoredFrom } : {}
		});
		options.logger?.info("supermemory: capability version reconciled " + record.name + " -> v" + adopted.version + (restoredFrom ? "（恢复归档版本）" : ""));
	}
	return report;
}
/**
* R54: make the health counters tell ONE story.
*
* Legacy rows can carry successCount=13 / failCount=9 / consecutiveFailures=2 /
* lastStatus='failed' while runCount stayed 0 (the old `usage` object was
* carried into the record without its denominator). The panel then renders
* "0 runs, 0 loads→runs, 13 successes, 9 failures", which reads as a bug.
*
* Chosen rule (documented in CHANGELOG/DEV-NOTES): PRESERVE the history instead
* of discarding it — runCount = max(runCount, successCount + failCount), the
* success rate keeps its real denominator, and lastStatus is forced to agree
* with the most recent outcome (a non-zero consecutive-failure streak means the
* last run failed). Everything is derived, so the pass is idempotent.
*/
function reconcileCapabilityHealth(record) {
	const successCount = Math.max(0, Number(record.successCount) || 0);
	const failCount = Math.max(0, Number(record.failCount) || 0);
	const runs = successCount + failCount;
	const previousRuns = Math.max(0, Number(record.runCount) || 0);
	const runCount = Math.max(previousRuns, runs);
	const legacyFolded = runs > previousRuns;
	const consecutiveFailures = failCount === 0 ? 0 : Math.min(Math.max(0, Number(record.consecutiveFailures) || 0), failCount);
	let lastStatus = record.lastStatus;
	if (consecutiveFailures > 0) lastStatus = "failed";
	else if (lastStatus === "failed" && successCount > 0) lastStatus = "completed";
	else if (!lastStatus && runCount > 0) lastStatus = successCount > 0 ? "completed" : "failed";
	if (!(runCount !== record.runCount || consecutiveFailures !== record.consecutiveFailures || lastStatus !== record.lastStatus)) return {
		record,
		changed: false,
		legacyFolded: false
	};
	return {
		record: {
			...record,
			runCount,
			consecutiveFailures,
			...lastStatus ? { lastStatus } : {}
		},
		changed: true,
		legacyFolded
	};
}
/**
* Lazy, idempotent migration: convert every legacy row exactly once.
*
* R51 order is load-bearing: shell skills are ARCHIVED (and their mirror rows
* retired) before any row is turned into a unit. R50 refreshed every row's
* knowledge face, which re-created archived shells under their canonical path
* with `sm-source: capability` — the next scan then saw a brand-new unit.
* Old sequence rows are retired (never registered); old capability rows become
* executable capabilities; old skill rows become knowledge capabilities; skill
* files without a row become knowledge capabilities — unless they are shells.
*/
async function migrateCapabilities(store, options = {}) {
	const now = options.now ?? Date.now();
	const report = {
		migratedCapabilities: 0,
		migratedKnowledge: 0,
		retiredComposites: 0,
		linkedSkills: 0,
		generatedSkills: 0,
		expiredProposals: 0,
		archivedShells: 0,
		retiredShellUnits: 0,
		dedupedKnowledge: 0,
		movedDocs: 0,
		archivedDocDirs: 0,
		skippedManualDocs: 0,
		versionsReconciled: 0,
		healthReconciled: 0,
		changed: false
	};
	const roots = /* @__PURE__ */ new Set();
	if (options.root) roots.add(options.root);
	for (const [, row] of store.toolMemory.entries()) {
		if (!row.workspaceKey || row.workspaceKey === "unknown" || !isAbsolute(row.workspaceKey) || !existsSync(row.workspaceKey)) continue;
		try {
			roots.add(resolveSkillRoot(row.workspaceKey).root);
		} catch {}
	}
	try {
		const archived = await archiveShellSkills({
			roots: [...roots],
			store,
			now
		});
		report.archivedShells = archived.totalArchived;
		if (archived.totalArchived > 0) report.changed = true;
	} catch {}
	const seen = /* @__PURE__ */ new Map();
	for (const [id, row] of [...store.toolMemory.entries()]) {
		if (row.status === "retired" && (row.kind === "skill" || row.kind === "knowledge")) continue;
		if (row.kind === "composite" || row.kind === "workflow") {
			let raw;
			try {
				raw = JSON.parse(row.entry);
			} catch {
				raw = void 0;
			}
			if (!raw || raw.kind !== "capability" || !str(raw.entry)) {
				if (row.status !== "retired") {
					await store.toolMemory.update(id, (record) => ({
						...record,
						status: "retired"
					}));
					report.retiredComposites += 1;
					report.changed = true;
				}
				continue;
			}
			const record = legacyCapabilityRecord(raw, row);
			const key = (row.workspaceKey ?? "global") + "|" + record.name;
			if (seen.has(key)) {
				await store.toolMemory.update(id, (r) => ({
					...r,
					status: "retired"
				}));
				report.retiredComposites += 1;
				continue;
			}
			seen.set(key, id);
			await saveCapabilityRecord(store, record, {
				id,
				workspaceKey: row.workspaceKey,
				createdAt: row.createdAt ?? now
			});
			report.migratedCapabilities += 1;
			report.changed = true;
			options.logger?.info("supermemory: migrated capability " + record.name + " -> " + capabilityToolName(record.name));
			continue;
		}
		if (row.kind === "proposal") {
			const parsed = readCapabilityRow(row, id);
			if (parsed && parsed.record.expiresAt !== void 0 && parsed.record.expiresAt < now && parsed.record.proposalStatus === "pending") {
				parsed.record.proposalStatus = "declined";
				await saveCapabilityRecord(store, parsed.record, {
					id,
					workspaceKey: row.workspaceKey,
					createdAt: row.createdAt
				});
				report.expiredProposals += 1;
			}
			continue;
		}
		if (row.kind === "skill") {
			const parsed = readCapabilityRow(row, id);
			if (!parsed) continue;
			const record = parsed.record;
			if (isShellUnit(record)) {
				await retireUnitRow(store, id);
				report.retiredShellUnits += 1;
				report.changed = true;
				continue;
			}
			record.kind = "knowledge";
			record.entry = "";
			record.runnable = false;
			record.source = record.source === "manual" ? "manual" : "migrated";
			const key = (row.workspaceKey ?? "global") + "|" + record.name;
			if (seen.has(key)) continue;
			seen.set(key, id);
			await saveCapabilityRecord(store, record, {
				id,
				workspaceKey: row.workspaceKey,
				createdAt: row.createdAt
			});
			report.migratedKnowledge += 1;
			report.changed = true;
			continue;
		}
		if (row.kind === "knowledge" || row.kind === "capability") {
			const parsed = readCapabilityRow(row, id);
			if (!parsed) continue;
			if (isShellUnit(parsed.record)) {
				await retireUnitRow(store, id);
				report.retiredShellUnits += 1;
				report.changed = true;
				continue;
			}
			const key = (row.workspaceKey ?? "global") + "|" + parsed.record.name;
			if (seen.has(key)) continue;
			seen.set(key, id);
			let legacy = false;
			try {
				legacy = JSON.parse(row.entry).schema !== CAPABILITY_SCHEMA;
			} catch {
				legacy = true;
			}
			if (legacy) {
				await saveCapabilityRecord(store, parsed.record, {
					id,
					workspaceKey: row.workspaceKey,
					createdAt: row.createdAt
				});
				report.changed = true;
			}
			continue;
		}
	}
	try {
		const docs = await migrateCapabilityDocs(store, {
			now,
			...options.capabilityRoot ? { capabilityRoot: options.capabilityRoot } : {},
			...options.logger ? { logger: options.logger } : {}
		});
		report.movedDocs = docs.moved;
		report.archivedDocDirs = docs.archivedDirs;
		report.skippedManualDocs = docs.skippedManual;
		if (docs.changed) report.changed = true;
	} catch (error) {
		options.logger?.info("supermemory: capability doc migration failed: " + String(error).slice(0, 160));
	}
	try {
		const versions = await reconcileCapabilityVersions(store, {
			now,
			...options.capabilityRoot ? { capabilityRoot: options.capabilityRoot } : {},
			...options.root ? { skillsRoot: options.root } : {},
			...options.logger ? { logger: options.logger } : {}
		});
		report.versionsReconciled = versions.reconciled;
		if (versions.changed) report.changed = true;
	} catch (error) {
		options.logger?.info("supermemory: capability version reconcile failed: " + String(error).slice(0, 160));
	}
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind === "proposal" || entry.row.status === "retired") continue;
		const health = reconcileCapabilityHealth(entry.record);
		if (!health.changed) continue;
		await saveCapabilityRecord(store, health.record, {
			id: entry.id,
			workspaceKey: entry.row.workspaceKey,
			createdAt: entry.row.createdAt
		});
		report.healthReconciled += 1;
		report.changed = true;
	}
	const capabilityPaths = /* @__PURE__ */ new Map();
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind !== "capability" || !entry.record.skillPath) continue;
		capabilityPaths.set(normalizePathKey(entry.record.skillPath), entry.record.name);
	}
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind !== "knowledge" || entry.row.status === "retired" || !entry.record.skillPath) continue;
		if (!capabilityPaths.has(normalizePathKey(entry.record.skillPath))) continue;
		await retireUnitRow(store, entry.id);
		report.dedupedKnowledge += 1;
		report.changed = true;
	}
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind === "proposal") continue;
		if (entry.row.status === "retired") continue;
		if (isShellUnit(entry.record)) {
			await retireUnitRow(store, entry.id);
			report.retiredShellUnits += 1;
			report.changed = true;
			continue;
		}
		let root = options.capabilityRoot;
		const owned = entry.row.workspaceKey;
		if (!root && owned && owned !== "unknown" && isAbsolute(owned) && existsSync(owned)) try {
			root = resolveCapabilityRoot(owned).root;
		} catch {
			root = void 0;
		}
		if (!root) continue;
		try {
			const result = await syncCapabilitySkill(store, entry, root, { now });
			if (result && result.status === "created") report.generatedSkills += 1;
			if (result && result.status !== "unchanged") report.changed = true;
		} catch {}
	}
	return report;
}
/** Synchronise one capability's SKILL.md (knowledge face). */
async function syncCapabilitySkill(store, entry, root, options = {}) {
	const record = entry.record;
	if (record.kind === "proposal") return void 0;
	if (isShellUnit(record)) return void 0;
	const input = {
		name: record.name,
		title: record.title,
		description: record.description,
		...record.entry ? { entry: record.entry } : {},
		...!record.entry && record.entryDraft ? { entryDraft: record.entryDraft } : {},
		...record.scope ? { scope: record.scope } : {},
		...record.doc ? { doc: record.doc } : {},
		...record.dryRunArg ? { dryRunArg: record.dryRunArg } : {},
		writeConfirm: record.writeConfirm,
		runnable: record.runnable,
		...record.taskKey ? { taskKey: record.taskKey } : {},
		tags: record.tags,
		source: record.source,
		version: record.version,
		...record.routeNote ? { routeNote: record.routeNote } : {},
		facts: record.facts
	};
	const result = await upsertCapabilitySkill({
		store,
		workspaceKey: entry.row.workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : "unknown"),
		root,
		input,
		...options.draftBody ?? record.draftBody ? { draftBody: options.draftBody ?? record.draftBody } : {},
		...options.now !== void 0 ? { now: options.now } : {},
		...options.changelog ? { changelog: options.changelog } : {},
		...record.bodyHash ? { previousBodyHash: record.bodyHash } : {}
	});
	const next = {
		...record,
		skillPath: result.path ?? record.skillPath,
		bodyHash: result.bodyHash ?? record.bodyHash,
		factsHash: result.factsHash ?? record.factsHash,
		version: Math.max(record.version, Math.floor(Number(result.version) || 0))
	};
	if (result.status !== "error") await saveCapabilityRecord(store, next, {
		id: entry.id,
		workspaceKey: entry.row.workspaceKey,
		createdAt: entry.row.createdAt
	});
	return result;
}
function isValidCapabilityName(name) {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(String(name ?? ""));
}
/** Build + validate one capability record (pure). */
function buildCapabilityRecord(input) {
	const rawName = String(input.name ?? "").trim();
	if (!isValidCapabilityName(rawName)) return {
		status: "error",
		message: "能力名称只能包含字母/数字/-/_（≤41 字符）且以字母或数字开头。"
	};
	const logical = capabilityLogicalName(rawName);
	const description = String(input.description ?? "").trim();
	if (!description) return {
		status: "error",
		message: "描述不能为空（模型靠它路由到本能力）。"
	};
	if (description.length > 500) return {
		status: "error",
		message: "描述过长（≤500 字符）。"
	};
	const entry = String(input.entry ?? "").trim();
	const entryDraft = String(input.entryDraft ?? "").trim();
	if (entry.length > 300 || entryDraft.length > 300) return {
		status: "error",
		message: "入口命令过长（≤300 字符）。"
	};
	const kind = entry || entryDraft ? "capability" : "knowledge";
	const record = {
		schema: CAPABILITY_SCHEMA,
		name: logical,
		kind,
		title: String(input.title ?? "").trim().slice(0, 80) || logical,
		description,
		tags: (input.tags && input.tags.length > 0 ? input.tags : [logical]).map((tag) => String(tag).slice(0, 24)).slice(0, 8),
		entry,
		entryDraft,
		entryVerified: Boolean(entry) && !entryDraft,
		doc: String(input.doc ?? "").trim().slice(0, 300),
		scope: String(input.scope ?? "").trim().slice(0, 300),
		runnable: Boolean(entry) && (input.runnable === void 0 ? true : Boolean(input.runnable)),
		enabled: true,
		dryRunArg: String(input.dryRunArg ?? "").trim().slice(0, 80),
		writeConfirm: Boolean(input.writeConfirm),
		routeNote: String(input.routeNote ?? "").trim().slice(0, 500),
		source: input.source ?? "manual",
		taskKey: String(input.taskKey ?? "").trim().slice(0, 120),
		version: 1,
		updatedAt: Date.now(),
		changelog: [],
		skillPath: "",
		bodyHash: "",
		factsHash: "",
		facts: {},
		loadCount: 0,
		runCount: 0,
		successCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		builtin: false
	};
	if (kind === "capability" && entryDraft && !entry) {
		record.entryVerified = false;
		record.runnable = false;
	}
	return {
		status: "ok",
		record
	};
}
/** Live registrations of the execution face (tool name -> disposer). */
const liveCapabilities = /* @__PURE__ */ new Map();
const liveCapabilityToolNames = /* @__PURE__ */ new Set();
function liveCapabilityNames() {
	return [...liveCapabilityToolNames];
}
function disposeCapabilityTool(toolName) {
	const dispose = liveCapabilities.get(toolName);
	if (dispose) try {
		dispose();
	} catch {}
	liveCapabilities.delete(toolName);
	liveCapabilityToolNames.delete(toolName);
}
const OUTPUT_CLIP = 8e3;
const TIMEOUT_MS = 12e4;
const PATH_SEP = process.platform === "win32" ? ";" : ":";
function clipOutput(text) {
	return text.length > OUTPUT_CLIP ? text.slice(0, OUTPUT_CLIP) + "\n…（输出过长已截断，原 " + text.length + " 字符）" : text;
}
/** PATH fallback so node/pnpm resolve even when the host inherited a stripped PATH. */
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
		if (seen.has(dedupe) || !existsSync(dir)) continue;
		seen.add(dedupe);
		parts.push(dir);
	}
	env[key] = parts.join(PATH_SEP);
	return env;
}
/** Execute one capability entry inside its scope (default dry-run; writeConfirm gate). */
function runCapability(record, options = {}) {
	if (record.kind !== "capability" || !record.entry) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun: Boolean(options.dryRun),
		command: "",
		summary: "不是可执行的能力（缺少入口命令）。"
	};
	if (record.runnable === false || record.enabled === false) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun: Boolean(options.dryRun),
		command: record.entry,
		summary: "该能力未开放执行（runnable/enabled=false）。"
	};
	const dryRun = options.dryRun !== void 0 ? Boolean(options.dryRun) : options.confirm === true ? false : Boolean(record.dryRunArg);
	const command = dryRun && record.dryRunArg ? record.entry + " " + record.dryRunArg : record.entry;
	if (dryRun && record.writeConfirm && !record.dryRunArg) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun,
		command,
		summary: "该能力标记了写操作确认但未定义预演参数，无法预演；确认执行请显式传 confirm=true。"
	};
	if (!dryRun && record.writeConfirm && options.confirm !== true) return {
		status: "needs-confirm",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun,
		command,
		summary: "该能力真实执行可能写远端/改状态：确认执行请显式传 confirm=true；只要预演可保持缺省。"
	};
	const started = Date.now();
	const child = spawnSync(command, {
		shell: true,
		cwd: record.scope && record.scope.trim() ? record.scope : process.cwd(),
		encoding: "utf8",
		timeout: TIMEOUT_MS,
		maxBuffer: 16777216,
		env: capabilityExecEnv()
	});
	const durationMs = Date.now() - started;
	const exitCode = typeof child.status === "number" ? child.status : void 0;
	return {
		status: Boolean(child.error) || exitCode === void 0 ? "failed" : exitCode === 0 ? "completed" : "failed",
		exitCode,
		stdout: clipOutput(String(child.stdout ?? "")),
		stderr: clipOutput(String(child.stderr ?? "")),
		durationMs,
		dryRun,
		command,
		summary: command + " → " + (child.error ? "启动失败：" + String(child.error).slice(0, 120) : "exit " + exitCode) + "（" + (dryRun ? "预演" : "实跑") + "，" + durationMs + "ms）"
	};
}
/**
* R54: the index line's「何时用」sentence prefers the human TITLE.
*
* R52 rendered whatever `whenToUse` the caller passed, so a hint that named the
* MACHINE name (git-sync-supermemory) contradicted the human title shown by the
* panel (「git 同步/提交/推送（SuperMemory 仓库）」). The card now derives the
* subject from `title`; a supplied sentence is kept only when it already names
* that title (it usually also carries the scope), and rows without a title fall
* back to description/whenToUse exactly as before.
*/
function capabilityIndexHint(row) {
	const title = String(row.title ?? "").trim();
	const name = String(row.name ?? "").trim();
	const supplied = String(row.whenToUse ?? "").replace(/\s+/g, " ").trim();
	if (title && title !== name) {
		if (supplied && supplied.includes(title)) return supplied;
		const scope = String(row.scope ?? "").trim();
		return scope ? "在 " + scope + " 内遇到「" + title + "」类任务时加载。" : "遇到「" + title + "」类任务时加载。";
	}
	return supplied || String(row.description ?? "").replace(/\s+/g, " ").trim();
}
/** 徽标：可执行 / 仅知识 / 入口待验证。 */
function capabilityIndexBadge(row) {
	if (row.entryDraft && !row.entryVerified) return "入口待验证";
	if (row.entry && row.runnable !== false) return "可执行";
	return "仅知识";
}
/**
* R52: the compact capability index injected into hub/branch sessions. The body
* is NOT here — the model calls `sm_cap_doc` for it. Budget-aware (R47): rows
* degrade with an explicit omission note instead of being hard-sliced.
*/
function renderCapabilityIndex(rows, options = {}) {
	const maxItems = Math.max(1, Math.min(options.maxItems ?? 8, 8));
	const budget = Math.max(160, options.budget ?? 1600);
	const eligible = rows.filter((row) => row.enabled !== false && row.status !== "retired" && row.kind !== "proposal").sort((left, right) => left.name.localeCompare(right.name));
	if (eligible.length === 0) return {
		text: "",
		included: 0,
		omitted: 0,
		truncated: false
	};
	const header = injectionTitle("capability") + "（仅中枢/分支会话注入；正文按需读取）";
	const footer = "正文用 sm_cap_doc 加载：sm_cap_doc { name: \"<能力名>\" }；中枢只读，执行需派发分支；第三方 skill 仍走宿主 skill 目录。";
	const lines = eligible.map((row) => {
		const hint = capabilityIndexHint(row);
		const clipped = clipAtBoundary(hint, 80) || hint.slice(0, 80);
		return "- " + row.name + " [" + capabilityIndexBadge(row) + "]：" + clipped;
	});
	let kept = lines.slice(0, maxItems);
	let omitted = lines.length - kept.length;
	const build = () => [
		header,
		...kept,
		...omitted > 0 ? ["… 省略 " + omitted + " 条（sm_cap_doc 可逐个读取）"] : [],
		footer
	].join("\n");
	while (kept.length > 0 && charCount(build()) > budget) {
		kept = kept.slice(0, -1);
		omitted += 1;
	}
	const text = build();
	if (kept.length === 0 && charCount(text) > budget) return {
		text: clipAtBoundary(header + "…（预算不足，正文用 sm_cap_doc 读取）", budget),
		included: 0,
		omitted: lines.length,
		truncated: true
	};
	return {
		text,
		included: kept.length,
		omitted,
		truncated: omitted > 0
	};
}
/** Derive the "when to use" sentence for one capability. */
function capabilityWhenToUse(record) {
	if (record.scope) return "在 " + record.scope + " 内遇到「" + record.title + "」类任务时加载。";
	return record.description;
}
/** Extract one `## <section>` block from a capability body. */
function extractCapabilitySection(body, section) {
	const wanted = String(section ?? "").trim().replace(/^#+\s*/, "").toLowerCase();
	if (!wanted) return void 0;
	const lines = String(body ?? "").split(/\r?\n/);
	const headings = [];
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match) continue;
		headings.push(match[1]);
		if (start < 0 && match[1].toLowerCase() === wanted) start = index;
	}
	if (start < 0) return {
		text: "",
		headings
	};
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) if (/^##\s+/.test(lines[index] ?? "")) {
		end = index;
		break;
	}
	return {
		text: lines.slice(start, end).join("\n").trim(),
		headings
	};
}
/**
* R52: load one capability knowledge body on demand (the `sm_cap_doc` tool's
* single source of truth). Only enabled, non-retired units whose file exists are
* readable; a successful load increments loadCount (conversion-rate denominator).
*/
async function loadCapabilityDoc(store, workspaceKey, rawName, section) {
	const raw = String(rawName ?? "").trim();
	if (!raw) return {
		status: "error",
		message: "缺少能力名。"
	};
	const logical = capabilityLogicalName(raw);
	const rows = capabilityRows(store, workspaceKey);
	const entry = rows.find((row) => row.record.name === logical) ?? rows.find((row) => capabilityToolName(row.record.name) === raw) ?? rows.find((row) => capabilitySkillName(row.record.name) === raw);
	if (!entry) return {
		status: "error",
		message: "能力不存在：" + raw + "（可在「固化能力」面板查看可用能力）。"
	};
	const record = entry.record;
	if (record.kind === "proposal") return {
		status: "error",
		message: "能力「" + record.name + "」还是待接受提案，尚未生成知识面。"
	};
	if (record.enabled === false || entry.row.status === "retired") return {
		status: "error",
		message: "能力「" + record.name + "」已停用：不加载知识面。"
	};
	if (record.kind === "capability" && record.runnable === false) return {
		status: "error",
		message: "能力「" + record.name + "」的执行面尚未启用（入口待验证）：先人工启用执行。"
	};
	const path = String(record.skillPath ?? "").trim();
	if (!path || !existsSync(path)) return {
		status: "error",
		message: "能力「" + record.name + "」的知识面文件缺失：" + (path || "（未生成）") + "；在面板保存正文可重建。"
	};
	let parsed;
	try {
		parsed = parseSkillMarkdown(readFileSync(path, "utf8"), capabilitySkillName(record.name));
	} catch {
		parsed = void 0;
	}
	if (!parsed) return {
		status: "error",
		message: "能力「" + record.name + "」的知识面文件解析失败：" + path
	};
	const fullBody = parsed.body;
	let body = fullBody;
	let headings;
	if (section !== void 0 && String(section).trim() !== "") {
		const found = extractCapabilitySection(fullBody, section);
		if (!found) {
			headings = extractCapabilitySection(fullBody, "__none__")?.headings ?? [];
			return {
				status: "error",
				message: "知识面没有小节「" + String(section).trim() + "」；可用小节：" + (headings.join("、") || "（无二级标题）"),
				headings
			};
		}
		if (!found.text) {
			headings = found.headings;
			return {
				status: "error",
				message: "知识面没有小节「" + String(section).trim() + "」；可用小节：" + (found.headings.join("、") || "（无二级标题）"),
				headings: found.headings
			};
		}
		body = found.text;
		headings = found.headings;
	}
	const next = {
		...record,
		loadCount: record.loadCount + 1
	};
	try {
		await saveCapabilityRecord(store, next, {
			id: entry.id,
			workspaceKey: entry.row.workspaceKey,
			createdAt: entry.row.createdAt
		});
	} catch {}
	return {
		status: "ok",
		message: "已加载能力「" + record.name + "」的知识面（sm_cap_doc）。",
		name: record.name,
		title: record.title,
		body,
		factsBlock: splitFactsBlock(fullBody).facts,
		entry: record.entry,
		scope: record.scope,
		dryRunArg: record.dryRunArg,
		writeConfirm: Boolean(record.writeConfirm),
		whenToUse: capabilityWhenToUse(record),
		...headings ? { headings } : {},
		loadCount: next.loadCount
	};
}
/** R52: current knowledge-face body (frontmatter stripped) for the panel editor. */
function capabilityBodyOf(record) {
	const path = String(record.skillPath ?? "").trim();
	if (!path || !existsSync(path)) return "";
	try {
		return parseSkillMarkdown(readFileSync(path, "utf8"), capabilitySkillName(record.name))?.body ?? "";
	} catch {
		return "";
	}
}
/** Model-visible description of one capability (routing note + semantics + rules). */
function capabilityToolDescription(record) {
	const semantics = "（能力：在适用范围 " + (record.scope || "当前目录") + " 内执行入口命令 " + record.entry + " 的固定入口；" + (record.dryRunArg ? "默认追加预演参数 " + record.dryRunArg + "（只读不改）；" : "") + (record.writeConfirm ? "真实执行可能写远端/改状态：confirm=true 表示确认真实执行；" : "") + (record.doc ? "详细流程见 " + record.doc + "；" : "") + "返回 exitCode/stdout/stderr/durationMs。）";
	return record.description + (record.routeNote ? "。" + record.routeNote : "") + semantics + "\n固化能力（capability）路由规则：① 在能力适用范围（scope）内遇到高频事务（git 同步/提交/推送、构建、验证、测试、发布等）时，优先调用已固化能力（sm_cap_*，默认预演、写操作 confirm=true 确认真实执行），不要每次现敲命令；② 重复工作先沉淀经验：判断型、易变的流程用 memory_toolize register 产出/更新能力知识面（描述写「何时用」，正文写触发条件/步骤/关键坑/验证；模型用 sm_cap_doc 按需读取，不要用宿主 skill 工具加载能力），不要满足于一次性工作；确实需要固定入口命令时才固化能力（入口命令 + 文档 + 适用范围）；③ 能力执行连续失败、或文档与现状不符时，必须用 memory_toolize register 同名更新能力（version+1、changelog 记录原因），不要绕过它手敲命令；④ 用 memory_toolize refresh-builtin 刷新内置能力并查看差异报告与健康度（使用次数、成败分列、连续失败、文档/适用范围缺失、零使用），按信号决定更新还是停用；⑤ 职责边界（R55）：中枢只能只读检查——用 sm_cap_doc 读知识面判断是否适用，执行必须 memory_dispatch 派发到分支（sm_cap_* 在中枢被 HUB_CAPABILITY_EXEC_DENIED 拒绝）；分支才是执行者（默认预演，写操作 confirm=true）。";
}
function callerCwd(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : void 0;
}
/** The single model-visible tool of one capability (fixed entry, dry_run/confirm only). */
function capabilityToolDef(store, record, rowId, workspaceKey) {
	return {
		name: capabilityToolName(record.name),
		description: capabilityToolDescription(record),
		parameters: {
			dry_run: {
				type: "boolean",
				description: "true=强制预演；缺省时若能力定义了预演参数则自动预演"
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
			const parsed = readCapabilityRow(store.toolMemory.get(rowId), rowId);
			if (!parsed || !isExecutable(parsed.record)) return {
				status: "failed",
				stdout: "",
				stderr: "",
				durationMs: 0,
				dryRun: false,
				command: "",
				summary: "能力不存在或已停用。"
			};
			const recordNow = parsed.record;
			const cwd = callerCwd(exec);
			if (cwd && recordNow.scope && !scopeContains(recordNow.scope, cwd)) return {
				status: "failed",
				stdout: "",
				stderr: "",
				durationMs: 0,
				dryRun: false,
				command: recordNow.entry,
				summary: "当前目录不在能力适用范围 " + recordNow.scope + " 内：不执行（scope 外拒绝）。"
			};
			if (cwd && workspaceKey && !capabilityAppliesToWorkspace(recordNow, workspaceKeyOf(cwd), workspaceKey)) return {
				status: "failed",
				stdout: "",
				stderr: "",
				durationMs: 0,
				dryRun: false,
				command: recordNow.entry,
				summary: "该能力适用于其他工作区：不执行（工作区隔离）。"
			};
			const result = runCapability(recordNow, {
				...typeof args.dry_run === "boolean" ? { dryRun: args.dry_run } : {},
				...typeof args.dryRun === "boolean" ? { dryRun: args.dryRun } : {},
				...typeof args.confirm === "boolean" ? { confirm: args.confirm } : {}
			});
			if (result.status !== "needs-confirm") await bumpCapabilityRun(store, rowId, result);
			if (result.status === "failed") {
				const failures = readCapabilityRow(store.toolMemory.get(rowId), rowId)?.record.consecutiveFailures ?? 0;
				if (failures >= 2) return {
					...result,
					summary: result.summary + "\n连续失败 " + failures + " 次：请更新本能力的事实块/文档（version+1、changelog 记录原因），不要绕过闸门。"
				};
			}
			return result;
		}
	};
}
/** Register one capability tool; returns its disposer. Replaces a previous handle. */
async function registerCapabilityTool(ctx, store, entry, workspaceKey) {
	const toolName = capabilityToolName(entry.record.name);
	disposeCapabilityTool(toolName);
	const tools = await loadHostModule("@deepseek-ai/dsh-tools");
	const workspaceGate = capabilityWhenGate(entry.record, workspaceKey);
	const gate = (context) => capabilityVisibleToCaller(store, context) && workspaceGate(context);
	const disposer = ctx.tools.register(tools.defineTool(capabilityToolDef(store, entry.record, entry.id, workspaceKey)), { when: gate });
	liveCapabilities.set(toolName, disposer);
	liveCapabilityToolNames.add(toolName);
	return disposer;
}
/**
* R55: a hub never SEES the execution surface (`sm_cap_*`) in its tool list.
* Hiding is the first layer (tool declarations), the role guard is the second
* (dispatch): a stale/foreign call is still refused with
* `HUB_CAPABILITY_EXEC_DENIED`. `sm_cap_doc` is registered unconditionally, so
* the hub keeps its read-only capability check. An unknown/absent agent or a
* resolution failure stays visible (fail-open on VISIBILITY only — the guard
* still decides execution); branch/ordinary sessions are untouched.
*/
function capabilityVisibleToCaller(store, context) {
	const agent = context?.agent;
	if (!agent) return true;
	try {
		return resolveRole(store, agent).role !== "hub";
	} catch {
		return true;
	}
}
/** Registration-side visibility gate (same semantics as execute). */
function capabilityWhenGate(record, rowWorkspaceKey) {
	return (context) => {
		try {
			const cwd = context?.agent?.session?.header?.cwd;
			if (!cwd || typeof cwd !== "string") return true;
			return capabilityAppliesToWorkspace(record, workspaceKeyOf(cwd), rowWorkspaceKey);
		} catch {
			return true;
		}
	};
}
/** Record one actual execution (needs-confirm does not count). */
async function bumpCapabilityRun(store, id, result) {
	const parsed = readCapabilityRow(store.toolMemory.get(id), id);
	if (!parsed) return;
	const record = parsed.record;
	const succeeded = result.status === "completed";
	const next = {
		...record,
		runCount: record.runCount + 1,
		successCount: succeeded ? record.successCount + 1 : record.successCount,
		failCount: succeeded ? record.failCount : record.failCount + 1,
		consecutiveFailures: succeeded ? 0 : record.consecutiveFailures + 1,
		lastUsedAt: Date.now(),
		lastStatus: succeeded ? "completed" : "failed",
		lastDryRun: result.dryRun,
		...typeof result.exitCode === "number" ? { lastExitCode: result.exitCode } : {},
		...result.summary ? { lastSummary: result.summary.slice(0, 200) } : {}
	};
	try {
		await saveCapabilityRecord(store, next, {
			id,
			workspaceKey: parsed.row.workspaceKey,
			createdAt: parsed.row.createdAt
		});
	} catch {}
}
/** Record one model-side skill load (knowledge face). */
async function bumpCapabilityLoad(store, callerWorkspaceKey, skillName) {
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind === "proposal") continue;
		if (capabilitySkillName(entry.record.name) !== skillName) continue;
		if (callerWorkspaceKey && entry.row.workspaceKey && callerWorkspaceKey !== entry.row.workspaceKey) continue;
		const next = {
			...entry.record,
			loadCount: entry.record.loadCount + 1
		};
		try {
			await saveCapabilityRecord(store, next, {
				id: entry.id,
				workspaceKey: entry.row.workspaceKey,
				createdAt: entry.row.createdAt
			});
			return true;
		} catch {
			return false;
		}
	}
	return false;
}
function defaultCapabilityDeps() {
	return { register: registerCapabilityTool };
}
async function ensureSkillFor(store, entry, workspaceKey, options = {}) {
	if (!workspaceKey || workspaceKey === "unknown" || !isAbsolute(workspaceKey) || !existsSync(workspaceKey)) return entry;
	let root;
	try {
		root = resolveCapabilityRoot(workspaceKey).root;
	} catch {
		return entry;
	}
	try {
		await syncCapabilitySkill(store, entry, root, options);
	} catch {}
	return readCapabilityRow(store.toolMemory.get(entry.id), entry.id) ?? entry;
}
async function registerIfExecutable(ctx, store, entry, workspaceKey, deps) {
	if (!ctx) return;
	if (!isExecutable(entry.record)) {
		disposeCapabilityTool(capabilityToolName(entry.record.name));
		return;
	}
	if (!(typeof ctx.tools?.register === "function")) return;
	try {
		await (deps ?? defaultCapabilityDeps()).register(ctx, store, entry, workspaceKey);
	} catch {}
}
/**
* Register one capability (manual path and builtin seed). Same logical name =
* update in place: version+1, changelog, statistics and knowledge face kept.
*/
async function registerCapability(ctx, store, input, workspaceKey, deps) {
	const built = buildCapabilityRecord(input);
	if (built.status === "error") return {
		status: "error",
		message: built.message
	};
	const record = built.record;
	const own = workspaceKey ?? (record.scope ? workspaceKeyOf(record.scope) : void 0);
	const existing = findCapabilityRow(store, {
		name: record.name,
		...own ? { workspaceKey: own } : {}
	});
	let id;
	let next;
	if (existing) {
		const changeLine = String(input.changelog ?? "").trim().slice(0, 200) || "更新能力定义（入口 " + (record.entry || "无") + (record.doc ? "，文档 " + record.doc : "") + "）";
		next = {
			...record,
			loadCount: existing.record.loadCount,
			runCount: existing.record.runCount,
			successCount: existing.record.successCount,
			failCount: existing.record.failCount,
			consecutiveFailures: existing.record.consecutiveFailures,
			...existing.record.lastUsedAt !== void 0 ? { lastUsedAt: existing.record.lastUsedAt } : {},
			...existing.record.lastStatus ? { lastStatus: existing.record.lastStatus } : {},
			...existing.record.lastDryRun !== void 0 ? { lastDryRun: existing.record.lastDryRun } : {},
			...existing.record.lastExitCode !== void 0 ? { lastExitCode: existing.record.lastExitCode } : {},
			...existing.record.lastSummary ? { lastSummary: existing.record.lastSummary } : {},
			version: existing.record.version + 1,
			updatedAt: Date.now(),
			changelog: [changeLine, ...existing.record.changelog].slice(0, CHANGELOG_MAX)
		};
		id = await saveCapabilityRecord(store, next, {
			id: existing.id,
			workspaceKey: own ?? existing.row.workspaceKey,
			createdAt: existing.row.createdAt
		});
	} else {
		next = {
			...record,
			version: 1,
			updatedAt: Date.now(),
			changelog: [String(input.changelog ?? "").trim().slice(0, 200) || "注册能力（入口 " + (record.entry || "仅知识") + "）"]
		};
		id = await saveCapabilityRecord(store, next, { workspaceKey: own });
	}
	let entry = readCapabilityRow(store.toolMemory.get(id), id);
	entry = await ensureSkillFor(store, entry, own ?? entry.row.workspaceKey, {
		...input.body ? { draftBody: input.body } : {},
		...input.changelog ? { changelog: input.changelog } : {}
	});
	await registerIfExecutable(ctx, store, entry, own ?? entry.row.workspaceKey, deps);
	const toolName = capabilityToolName(entry.record.name);
	return {
		status: "ok",
		id,
		name: entry.record.name,
		tool: entry.record.kind === "capability" ? toolName : capabilitySkillName(entry.record.name),
		message: (existing ? "已更新能力 " : "已注册能力 ") + entry.record.name + "（v" + entry.record.version + "，" + (entry.record.entry ? "入口 " + entry.record.entry : "仅知识") + "；" + (entry.record.kind === "capability" ? "执行面工具 " + toolName : "无执行面") + "；知识面 " + (entry.record.skillPath || "待生成") + "）。"
	};
}
/** Enable/disable BOTH faces of one capability. */
async function setCapabilityEnabled(ctx, store, id, enabled) {
	const entry = readCapabilityRow(store.toolMemory.get(id), id);
	if (!entry) return {
		status: "error",
		message: "能力不存在。"
	};
	const next = {
		...entry.record,
		enabled,
		updatedAt: Date.now(),
		version: entry.record.version + 1,
		changelog: [(enabled ? "启用" : "停用") + "（知识面与执行面同时生效）", ...entry.record.changelog].slice(0, CHANGELOG_MAX)
	};
	const row = rowOfRecord(next, entry.row.workspaceKey, entry.row.createdAt);
	row.status = enabled ? "active" : "retired";
	await store.toolMemory.update(id, () => row);
	if (next.skillPath) try {
		const { writeFileSync } = await import("node:fs");
		const text = readFileSync(next.skillPath, "utf8").replace(/disable-model-invocation: (true|false)/, "disable-model-invocation: " + String(!enabled));
		writeFileSync(next.skillPath, text, "utf8");
	} catch {}
	if (enabled) await registerIfExecutable(ctx, store, entry, entry.row.workspaceKey);
	else disposeCapabilityTool(capabilityToolName(entry.record.name));
	return {
		status: "ok",
		message: (enabled ? "已启用 " : "已停用 ") + entry.record.name + "（知识面与执行面已同步）。",
		name: entry.record.name
	};
}
/** Human gate for an auto-drafted entry: draft becomes the verified entry. */
async function enableCapabilityEntryDraft(ctx, store, id) {
	const entry = readCapabilityRow(store.toolMemory.get(id), id);
	if (!entry) return {
		status: "error",
		message: "能力不存在。"
	};
	if (!entry.record.entryDraft) return {
		status: "error",
		message: "该能力没有待启用的入口草稿。"
	};
	const row = rowOfRecord({
		...entry.record,
		kind: "capability",
		entry: entry.record.entryDraft,
		entryDraft: "",
		entryVerified: true,
		runnable: true,
		version: entry.record.version + 1,
		updatedAt: Date.now(),
		changelog: ["人工启用执行：入口草稿已确认为入口命令（entryVerified=true）", ...entry.record.changelog].slice(0, CHANGELOG_MAX)
	}, entry.row.workspaceKey, entry.row.createdAt);
	await store.toolMemory.update(id, () => row);
	let updated = readCapabilityRow(store.toolMemory.get(id), id);
	updated = await ensureSkillFor(store, updated, entry.row.workspaceKey, { changelog: "人工启用执行（入口草稿已验证）" });
	await registerIfExecutable(ctx, store, updated, entry.row.workspaceKey);
	return {
		status: "ok",
		message: "已启用执行：" + updated.record.name + " → " + updated.record.entry + "。",
		name: updated.record.name
	};
}
/** Edit one capability definition (panel / memory_toolize). */
async function editCapability(ctx, store, id, patch) {
	const entry = readCapabilityRow(store.toolMemory.get(id), id);
	if (!entry) return {
		status: "error",
		message: "能力不存在。"
	};
	const record = { ...entry.record };
	if (patch.title !== void 0) record.title = String(patch.title).slice(0, 80);
	if (patch.tags !== void 0) record.tags = patch.tags.map((tag) => String(tag)).slice(0, 8);
	if (patch.description !== void 0) record.description = String(patch.description).slice(0, 500);
	if (patch.entry !== void 0) {
		record.entry = String(patch.entry).slice(0, 300);
		if (record.entry) {
			record.entryVerified = true;
			record.kind = "capability";
		}
		record.runnable = Boolean(record.entry);
	}
	if (patch.doc !== void 0) record.doc = String(patch.doc).slice(0, 300);
	if (patch.scope !== void 0) record.scope = String(patch.scope).slice(0, 300);
	if (patch.runnable !== void 0) record.runnable = Boolean(patch.runnable) && Boolean(record.entry);
	if (patch.dryRunArg !== void 0) record.dryRunArg = String(patch.dryRunArg).slice(0, 80);
	if (patch.writeConfirm !== void 0) record.writeConfirm = Boolean(patch.writeConfirm);
	if (patch.routeNote !== void 0) record.routeNote = String(patch.routeNote).slice(0, 500);
	if (patch.status !== void 0 && patch.status !== "active" && patch.status !== "retired") return {
		status: "error",
		message: "status 仅支持 active / retired。"
	};
	if (patch.enabled !== void 0) record.enabled = Boolean(patch.enabled);
	if (patch.status !== void 0) record.enabled = patch.status === "active";
	record.version = record.version + 1;
	record.updatedAt = Date.now();
	record.changelog = [String(patch.changelog ?? "").trim().slice(0, 200) || "更新能力定义", ...record.changelog].slice(0, CHANGELOG_MAX);
	const row = rowOfRecord(record, entry.row.workspaceKey, entry.row.createdAt);
	await store.toolMemory.update(id, () => row);
	let updated = readCapabilityRow(store.toolMemory.get(id), id);
	updated = await ensureSkillFor(store, updated, entry.row.workspaceKey, {
		...patch.changelog ? { changelog: patch.changelog } : {},
		...patch.body ? { draftBody: patch.body } : {}
	});
	if (updated.record.enabled === false || !isExecutable(updated.record)) disposeCapabilityTool(capabilityToolName(updated.record.name));
	else await registerIfExecutable(ctx, store, updated, entry.row.workspaceKey);
	return {
		status: "ok",
		message: "已更新能力 " + updated.record.name + "（v" + updated.record.version + "）。",
		id
	};
}
/** Edit the human prose of one capability's knowledge face (facts block preserved). */
async function updateCapabilitySkillBody(store, id, body) {
	const entry = readCapabilityRow(store.toolMemory.get(id), id);
	if (!entry) return {
		status: "error",
		message: "能力不存在。"
	};
	if (!entry.record.skillPath) return {
		status: "error",
		message: "该能力还没有知识面文件。"
	};
	try {
		const { writeFileSync } = await import("node:fs");
		const text = readFileSync(entry.record.skillPath, "utf8");
		const parsed = parseSkillMarkdown(text, capabilitySkillName(entry.record.name));
		if (!parsed) return {
			status: "error",
			message: "知识面文件解析失败，未修改。"
		};
		const endOfFrontmatter = text.indexOf(parsed.body);
		const frontmatter = endOfFrontmatter >= 0 ? text.slice(0, endOfFrontmatter) : "";
		const split = splitFactsBlock(parsed.body);
		const nextBody = (String(body).trim() + (split.hasBlock ? "\n\n" + split.facts : "")).trim();
		writeFileSync(entry.record.skillPath, frontmatter + nextBody + "\n", "utf8");
		await saveCapabilityRecord(store, {
			...entry.record,
			bodyHash: bodyHashOf(nextBody),
			version: entry.record.version + 1,
			updatedAt: Date.now(),
			changelog: ["人工编辑知识面正文（事实块保留）", ...entry.record.changelog].slice(0, CHANGELOG_MAX)
		}, {
			id,
			workspaceKey: entry.row.workspaceKey,
			createdAt: entry.row.createdAt
		});
		return {
			status: "ok",
			message: "正文已保存（事实块保留）。"
		};
	} catch (error) {
		return {
			status: "error",
			message: "保存正文失败：" + String(error).slice(0, 160)
		};
	}
}
/** Delete one capability: archive its knowledge file (never hard-delete), unregister, drop row. */
async function deleteCapability(ctx, store, id) {
	const entry = readCapabilityRow(store.toolMemory.get(id), id);
	if (!entry) return {
		status: "error",
		message: "能力不存在。"
	};
	disposeCapabilityTool(capabilityToolName(entry.record.name));
	let archivePath;
	if (entry.record.skillPath) {
		if (/\.md$/i.test(entry.record.skillPath)) archivePath = (await archiveCapabilityDoc(dirname(entry.record.skillPath), entry.record.name, { reason: "能力删除：知识面归档" }))?.archivePath;
		else {
			const root = dirname(dirname(entry.record.skillPath));
			archivePath = (await archiveCapabilitySkill(root, capabilitySkillName(entry.record.name), { reason: "能力删除：知识面归档" }))?.archivePath;
		}
	}
	await store.toolMemory.delete(id);
	return {
		status: "ok",
		message: "已删除能力 " + entry.record.name + (archivePath ? "（知识面已归档到 " + archivePath + "，可回滚）" : "") + "。",
		...archivePath ? { archivePath } : {}
	};
}
async function mergeBuiltinCapabilities(store, options = {}) {
	const report = {
		seeded: [],
		upgraded: [],
		current: [],
		localNewer: [],
		changed: []
	};
	for (const builtin of BUILTIN_CAPABILITIES) {
		const target = capabilityLogicalName(builtin.name);
		const existing = capabilityRows(store).find((entry) => entry.record.name === target);
		if (!existing) {
			const { changelog: builtinChangelog, ...builtinBase } = builtin;
			const built = buildCapabilityRecord({
				...builtinBase,
				source: "builtin",
				...builtinChangelog?.[0] ? { changelog: builtinChangelog[0] } : {}
			});
			if (built.status === "error") continue;
			built.record.version = builtin.version;
			built.record.changelog = [...builtin.changelog ?? []];
			built.record.builtin = true;
			built.record.builtinVersion = builtin.version;
			built.record.entryVerified = true;
			built.record.source = "builtin";
			const id = await saveCapabilityRecord(store, built.record, { workspaceKey: builtin.scope ? workspaceKeyOf(builtin.scope) : void 0 });
			const entry = readCapabilityRow(store.toolMemory.get(id), id);
			const synced = await ensureSkillFor(store, entry, entry.row.workspaceKey, { changelog: "内置能力播种：生成知识面" });
			report.seeded.push(synced.record.name);
			report.changed.push(synced);
			continue;
		}
		const builtinSeen = existing.record.builtinVersion;
		if (!(existing.record.version < builtin.version || builtinSeen !== void 0 && builtinSeen < builtin.version)) {
			if (builtinSeen === void 0 && existing.record.version > builtin.version) report.localNewer.push(existing.record.name);
			else report.current.push(existing.record.name);
			continue;
		}
		const { changelog: upgradeChangelog, ...upgradeBase } = builtin;
		const built = buildCapabilityRecord({
			...upgradeBase,
			source: "builtin",
			...upgradeChangelog?.[0] ? { changelog: upgradeChangelog[0] } : {}
		});
		if (built.status === "error") continue;
		const next = {
			...existing.record,
			...built.record,
			loadCount: existing.record.loadCount,
			runCount: existing.record.runCount,
			successCount: existing.record.successCount,
			failCount: existing.record.failCount,
			consecutiveFailures: existing.record.consecutiveFailures,
			...existing.record.lastUsedAt !== void 0 ? { lastUsedAt: existing.record.lastUsedAt } : {},
			...existing.record.lastStatus ? { lastStatus: existing.record.lastStatus } : {},
			version: Math.max(existing.record.version, builtin.version),
			updatedAt: Date.now(),
			changelog: [...builtin.changelog ?? [], ...existing.record.changelog].slice(0, CHANGELOG_MAX),
			builtin: true,
			builtinVersion: builtin.version,
			entryVerified: true
		};
		const previousScopeKey = existing.record.scope ? workspaceKeyOf(existing.record.scope) : void 0;
		const nextScopeKey = next.scope ? workspaceKeyOf(next.scope) : void 0;
		const workspaceKey = Boolean(existing.row.workspaceKey && previousScopeKey && existing.row.workspaceKey === previousScopeKey) && nextScopeKey ? nextScopeKey : existing.row.workspaceKey;
		await saveCapabilityRecord(store, next, {
			id: existing.id,
			workspaceKey,
			createdAt: existing.row.createdAt
		});
		const synced = await ensureSkillFor(store, readCapabilityRow(store.toolMemory.get(existing.id), existing.id), workspaceKey, { changelog: "内置能力升级：刷新知识面事实块" });
		report.upgraded.push(synced.record.name);
		report.changed.push(synced);
	}
	return report;
}
/** Boot/refresh rebuild: migrate, merge builtins, register every executable face. */
async function rebuildCapabilities(ctx, store, deps) {
	try {
		const migration = await migrateCapabilities(store, { ...deps?.logger ? { logger: deps.logger } : {} });
		if (migration.changed) deps?.logger?.info("supermemory: capability migration — caps " + migration.migratedCapabilities + ", knowledge " + migration.migratedKnowledge + ", retired sequences " + migration.retiredComposites + ", linked skills " + migration.linkedSkills + ", archived shells " + migration.archivedShells + ", retired shell units " + migration.retiredShellUnits + ", deduped knowledge " + migration.dedupedKnowledge);
	} catch (error) {
		deps?.logger?.warn?.("supermemory: capability migration failed: " + String(error).slice(0, 160));
	}
	try {
		const merged = await mergeBuiltinCapabilities(store, { ...deps?.logger ? { logger: deps.logger } : {} });
		if (merged.seeded.length > 0 || merged.upgraded.length > 0) deps?.logger?.info("supermemory: builtin capabilities — seeded " + merged.seeded.join(",") + "; upgraded " + merged.upgraded.join(","));
	} catch {}
	const seam = deps?.register ?? registerCapabilityTool;
	let registered = 0;
	for (const entry of capabilityRows(store)) {
		if (!isExecutable(entry.record)) {
			disposeCapabilityTool(capabilityToolName(entry.record.name));
			continue;
		}
		try {
			await seam(ctx, store, entry, entry.row.workspaceKey);
			registered += 1;
		} catch {}
	}
	return registered;
}
function capabilityHealthOf(store, workspaceKey) {
	const out = [];
	for (const entry of capabilityRows(store, workspaceKey)) {
		if (entry.record.kind === "proposal") continue;
		const health = reconcileCapabilityHealth(entry.record);
		const record = health.record;
		if (record.kind === "proposal") continue;
		const builtin = BUILTIN_CAPABILITIES.find((candidate) => capabilityLogicalName(candidate.name) === record.name);
		const scopeMissing = Boolean(record.scope && !existsSync(record.scope));
		const docMissing = Boolean(record.doc && record.scope && !scopeMissing && !existsSync(join(record.scope, record.doc)));
		const notes = [];
		if (record.consecutiveFailures >= 2) notes.push("连续失败 " + record.consecutiveFailures + " 次：更新能力定义/事实块/文档（version+1、changelog 记录原因），不要绕过");
		if (record.runCount > 0 && record.successCount === 0 && record.failCount > 0) notes.push("从未成功执行过：入口命令或适用范围需要修订");
		if (scopeMissing) notes.push("适用范围目录不存在：" + record.scope);
		if (docMissing) notes.push("文档缺失：" + record.doc);
		if (record.runCount === 0 && record.loadCount === 0) notes.push("零使用/零加载：确认路由描述是否说清何时用它");
		if (record.loadCount > 0 && record.runCount === 0) notes.push("有加载无执行：检查知识面是否说清执行面入口");
		if (record.kind === "capability" && !liveCapabilityToolNames.has(capabilityToolName(record.name))) notes.push("执行面未注册（重启或 refresh-builtin 后生效）");
		if (record.entryDraft && !record.entryVerified) notes.push("入口草稿未验证：人工在面板点「启用执行」后才会 runnable=true");
		if (health.changed) notes.push("历史统计已校正（R54：runCount=success+fail，lastStatus 与最近结果一致）");
		const builtinSeen = record.builtinVersion;
		if (builtin && (builtinSeen !== void 0 ? builtinSeen < builtin.version : record.version < builtin.version)) notes.push("现场版本旧于内置 v" + builtin.version + "：memory_toolize refresh-builtin 可升级");
		if (builtin && builtinSeen === void 0 && record.version > builtin.version) notes.push("现场版本新于内置 v" + builtin.version + "（本地维护中）");
		const successRate = record.runCount > 0 ? record.successCount / record.runCount : 0;
		const loadsToRuns = record.loadCount > 0 ? record.runCount / record.loadCount : 0;
		out.push({
			id: entry.id,
			name: record.name,
			...record.title ? { title: record.title } : {},
			kind: record.kind,
			entry: record.entry,
			...record.entryDraft ? { entryDraft: record.entryDraft } : {},
			entryVerified: record.entryVerified,
			...record.doc ? { doc: record.doc } : {},
			...record.scope ? { scope: record.scope } : {},
			status: entry.row.status,
			enabled: record.enabled !== false,
			live: liveCapabilityToolNames.has(capabilityToolName(record.name)),
			builtin: Boolean(builtin),
			...builtin ? { builtinVersion: builtin.version } : {},
			version: record.version,
			loadCount: record.loadCount,
			runCount: record.runCount,
			loadsToRuns,
			successRate,
			successCount: record.successCount,
			failCount: record.failCount,
			consecutiveFailures: record.consecutiveFailures,
			...record.lastUsedAt !== void 0 ? { lastUsedAt: record.lastUsedAt } : {},
			...record.lastStatus ? { lastStatus: record.lastStatus } : {},
			...record.lastDryRun !== void 0 ? { lastDryRun: record.lastDryRun } : {},
			...record.lastSummary ? { lastSummary: record.lastSummary } : {},
			...record.skillPath ? { skillPath: record.skillPath } : {},
			...record.bodyHash ? { bodyHash: record.bodyHash } : {},
			...record.factsHash ? { factsHash: record.factsHash } : {},
			docMissing,
			scopeMissing,
			notes
		});
	}
	return out;
}
function pendingProposalsOf(store, workspaceKey) {
	return capabilityRows(store).filter((entry) => entry.record.kind === "proposal" && entry.record.proposalStatus === "pending" && (!workspaceKey || !entry.row.workspaceKey || entry.row.workspaceKey === workspaceKey));
}
/** Create/update one pending proposal. Pending proposals never consume the 8-skill cap. */
async function createProposal(store, input) {
	const now = input.now ?? Date.now();
	const logical = capabilityLogicalName(input.name);
	if (!isValidCapabilityName(logical)) return {
		status: "rejected",
		name: logical,
		message: "提案名称不合法：" + logical
	};
	const existing = capabilityRows(store).find((entry) => entry.record.kind === "proposal" && entry.record.name === logical && (entry.row.workspaceKey ?? "") === (input.workspaceKey ?? ""));
	const record = normalizeCapabilityRecord({
		schema: CAPABILITY_SCHEMA,
		name: logical,
		kind: "proposal",
		title: input.title,
		description: input.description,
		entry: "",
		entryDraft: input.entryDraft ?? "",
		entryVerified: false,
		runnable: false,
		scope: input.scope ?? "",
		source: input.source ?? "auto",
		taskKey: input.taskKey ?? "",
		version: 1,
		updatedAt: now,
		changelog: ["自动知识草稿（待接受）"],
		draftBody: input.body,
		facts: input.facts ?? {},
		proposalStatus: "pending",
		expiresAt: now + PROPOSAL_TTL_MS
	});
	record.kind = "proposal";
	if (existing) {
		await saveCapabilityRecord(store, {
			...record,
			version: existing.record.version,
			changelog: existing.record.changelog
		}, {
			id: existing.id,
			workspaceKey: input.workspaceKey,
			createdAt: existing.row.createdAt
		});
		return {
			status: "updated",
			id: existing.id,
			name: logical,
			message: "已刷新待接受的知识草稿。"
		};
	}
	if (pendingProposalsOf(store, input.workspaceKey).length >= PROPOSAL_MAX) return {
		status: "rejected",
		name: logical,
		message: "待处理提案已达上限 20 条：先接受/拒绝或清空。"
	};
	return {
		status: "created",
		id: await saveCapabilityRecord(store, record, { workspaceKey: input.workspaceKey }),
		name: logical,
		message: "已写入待接受提案（知识草稿，无执行面）。"
	};
}
/** Accept a pending proposal -> a real capability (knowledge only, or entryDraft pending verification). */
async function acceptProposal(ctx, store, id, options = {}) {
	const proposal = readCapabilityRow(store.toolMemory.get(id), id);
	if (!proposal || proposal.record.kind !== "proposal") return {
		status: "error",
		message: "提案不存在。"
	};
	if (proposal.record.proposalStatus !== "pending") return {
		status: "error",
		message: "提案已处理（不是待接受状态）。"
	};
	const workspaceKey = proposal.row.workspaceKey ?? "unknown";
	let root = options.root;
	if (!root && workspaceKey !== "unknown") try {
		root = resolveCapabilityRoot(workspaceKey).root;
	} catch {
		root = void 0;
	}
	if (root) {
		if (capabilityRows(store).filter((entry) => entry.record.source === "auto" && entry.record.kind !== "proposal" && Boolean(entry.record.skillPath) && resolve(entry.record.skillPath).toLowerCase().startsWith(resolve(root).toLowerCase())).length >= 8) return {
			status: "error",
			message: "该 skills 根自动生成上限 8 个已满：先停用/删除一个再接受。"
		};
	}
	const now = options.now ?? Date.now();
	const record = proposal.record;
	const kind = record.entryDraft ? "capability" : "knowledge";
	const capId = await saveCapabilityRecord(store, {
		...record,
		kind,
		version: 1,
		updatedAt: now,
		changelog: ["接受自动提案（" + (record.entryDraft ? "入口草稿待人工验证" : "仅知识") + "）", ...record.changelog].slice(0, CHANGELOG_MAX),
		proposalStatus: "accepted",
		entry: "",
		entryVerified: false,
		runnable: false,
		enabled: true,
		source: record.source === "manual" ? "manual" : "auto"
	}, { workspaceKey });
	const entry = readCapabilityRow(store.toolMemory.get(capId), capId);
	let synced = entry;
	if (root) {
		try {
			await syncCapabilitySkill(store, entry, root, {
				draftBody: record.draftBody,
				now,
				changelog: "接受自动提案：生成知识面"
			});
		} catch {}
		synced = readCapabilityRow(store.toolMemory.get(capId), capId);
	}
	await saveCapabilityRecord(store, {
		...record,
		proposalStatus: "accepted",
		acceptedId: capId
	}, {
		id,
		workspaceKey,
		createdAt: proposal.row.createdAt
	});
	return {
		status: "ok",
		message: "已接受提案：创建" + (kind === "capability" ? "可执行能力（入口草稿待人工「启用执行」）" : "仅知识能力") + " " + synced.record.name + "。",
		id: capId,
		name: synced.record.name,
		entryDraft: kind === "capability"
	};
}
async function declineProposal(store, id) {
	const proposal = readCapabilityRow(store.toolMemory.get(id), id);
	if (!proposal || proposal.record.kind !== "proposal") return {
		status: "error",
		message: "提案不存在。"
	};
	const record = {
		...proposal.record,
		proposalStatus: "declined",
		updatedAt: Date.now()
	};
	await saveCapabilityRecord(store, record, {
		id,
		workspaceKey: proposal.row.workspaceKey,
		createdAt: proposal.row.createdAt
	});
	return {
		status: "ok",
		message: "已拒绝提案 " + record.name + "。"
	};
}
/** Expire stale pending proposals (30 days). Idempotent. */
async function expireProposals(store, now = Date.now()) {
	let expired = 0;
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind !== "proposal" || entry.record.proposalStatus !== "pending") continue;
		if (entry.record.expiresAt !== void 0 && entry.record.expiresAt >= now) continue;
		await saveCapabilityRecord(store, {
			...entry.record,
			proposalStatus: "declined",
			updatedAt: now,
			changelog: ["提案超 30 天未处理：自动过期", ...entry.record.changelog].slice(0, CHANGELOG_MAX)
		}, {
			id: entry.id,
			workspaceKey: entry.row.workspaceKey,
			createdAt: entry.row.createdAt
		});
		expired += 1;
	}
	return expired;
}
/** Collapse whitespace and strip the dry-run suffix so samples group together. */
function normalizeCommand(command) {
	let value = String(command ?? "").replace(/\s+/g, " ").trim();
	let dryRunArg;
	const match = /\s(--dry-run|--preview|-n)$/.exec(value);
	if (match) {
		dryRunArg = match[1];
		value = value.slice(0, match.index).trim();
	}
	value = value.replace(/^pnpm\s+run\s+/, "pnpm ").replace(/^npm\s+run\s+/, "npm run ");
	return {
		command: value,
		...dryRunArg ? { dryRunArg } : {}
	};
}
function isInteractive(command) {
	if (/(^|\s)-[a-z]*i[a-z]*(\s|$)/.test(command)) return true;
	if (/\b(vim?|nvim|nano|notepad|code|emacs)\b/.test(command)) return true;
	if (/(^|\s)(read|select|pause)(\s|$)/.test(command)) return true;
	if (/set\s+\/p/i.test(command)) return true;
	if (/[<>]/.test(command)) return true;
	return false;
}
function hasPlaceholderOrTemp(command) {
	if (/[{}]/.test(command)) return true;
	if (/\$\{/.test(command)) return true;
	if (/(^|[\s/"'])(\/tmp|%temp%|\$tmp|c:\\users\\[^\\]+\\appdata\\local\\temp)/i.test(command)) return true;
	if (/\.tmp\b|\.temp\b|mkdtemp/i.test(command)) return true;
	return false;
}
function allowedCommandFamily(command, scriptNames) {
	if (/^pnpm\s+git:sync(\s|$)/.test(command)) return true;
	const script = /^(?:pnpm|npm)(?:\s+run)?\s+([a-zA-Z0-9:_.-]+)(?:\s|$)/.exec(command);
	if (script) return scriptNames.includes(script[1]);
	if (/^(?:node\s+)?(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.(?:mjs|cjs|js|sh)(?:\s|$)/.test(command)) return true;
	if (/^bash\s+(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.sh(?:\s|$)/.test(command)) return true;
	return false;
}
function readScriptNames(scope) {
	if (!scope) return [];
	try {
		const pkg = JSON.parse(readFileSync(join(scope, "package.json"), "utf8"));
		return Object.keys(pkg.scripts ?? {});
	} catch {
		return [];
	}
}
/**
* Decide whether the samples justify one auto-drafted entry command. Pure over
* the recorded samples plus an optional scope/workspace root (filesystem read of
* package.json only to validate the script family).
*/
function highConfidenceEntryDraft(samples, options = {}) {
	const scope = options.scope ? resolve(options.scope) : void 0;
	if (scope && options.workspaceRoot && resolve(options.workspaceRoot).toLowerCase() !== scope.toLowerCase()) return {
		status: "none",
		reason: "scope 不是仓库根（" + scope + " ≠ " + resolve(options.workspaceRoot) + "）"
	};
	const scriptNames = options.scriptNames ?? readScriptNames(scope);
	const stats = /* @__PURE__ */ new Map();
	for (const [index, sample] of samples.entries()) {
		if (sample.ok !== true) continue;
		const session = sample.sessionId ?? "sample-" + index;
		for (const arg of sample.args) {
			const raw = typeof arg.command === "string" ? arg.command : "";
			if (!raw) continue;
			const normalized = normalizeCommand(raw);
			const bucket = stats.get(normalized.command) ?? {
				samples: 0,
				sessions: /* @__PURE__ */ new Set(),
				...normalized.dryRunArg ? { dryRunArg: normalized.dryRunArg } : {}
			};
			bucket.samples += 1;
			bucket.sessions.add(session);
			if (normalized.dryRunArg && !bucket.dryRunArg) bucket.dryRunArg = normalized.dryRunArg;
			stats.set(normalized.command, bucket);
		}
	}
	const candidates = [...stats.entries()].filter(([command, bucket]) => bucket.samples >= 3 && bucket.sessions.size >= 2 && allowedCommandFamily(command, scriptNames) && !isInteractive(command) && !hasPlaceholderOrTemp(command)).sort((left, right) => right[1].samples - left[1].samples);
	if (candidates.length === 0) return {
		status: "none",
		reason: "没有满足高置信条件的命令（≥3 样本、≥2 会话、全部 exit 0、非交互、允许的命令家族、无占位符/临时路径）"
	};
	const [command, bucket] = candidates[0];
	const readOnly = /(?:^|\s)(typecheck|smoke|test|lint|check|status|log|diff|verify)(?:\s|$)/.test(command);
	return {
		status: "ok",
		reason: "高置信候选：" + bucket.samples + " 个样本、" + bucket.sessions.size + " 个会话、全部 exit 0；命令家族在允许列表",
		entry: command,
		...bucket.dryRunArg ? { dryRunArg: bucket.dryRunArg } : {},
		writeConfirm: !readOnly,
		samples: bucket.samples,
		sessions: bucket.sessions.size
	};
}
export { attachRoute as A, runCapability as C, updateCapabilitySkillBody as D, syncCapabilitySkill as E, backfillHubRecords as F, recordHubSession as I, resolveRole as L, fillTopicShapeOnCreate as M, noteTopicSetActivated as N, PLUGIN_REPO_ROOT as O, agentWorkspaceKey as P, injectionSource as R, retireShellUnits as S, setCapabilityEnabled as T, isShellUnit as _, capabilityHealthOf as a, registerCapability as b, capabilityToolName as c, declineProposal as d, deleteCapability as f, highConfidenceEntryDraft as g, expireProposals as h, capabilityBodyOf as i, renderCard as j, CAPABILITY_ROUTING_RULES as k, capability_exports as l, enableCapabilityEntryDraft as m, bumpCapabilityRun as n, capabilityRows as o, editCapability as p, capabilityAppliesToWorkspace as r, capabilitySkillName as s, acceptProposal as t, createProposal as u, liveCapabilityToolNames as v, saveCapabilityRecord as w, renderCapabilityIndex as x, readCapabilityRow as y };
