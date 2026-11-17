import { a as listTopicSets, c as setTopicSetModel, d as updateMember, f as updateTopicSetSummary, i as getTopicSet, l as topicSetIdsOf, n as createTopicSet, o as rankMembers, r as getRouting, s as setRouting, t as addMember, u as touchTopicSet } from "./topicsets-BOeSeHoB.js";
import { a as __exportAll, i as loadHostModule, n as openStore, r as workspaceKeyOf, t as newId } from "./store-D4PJmKb5.js";
import { a as groupRelayText, i as groupRelayExists, n as groupEpisodeSummaries, r as groupMembers, s as newGroupId, t as groupComplete } from "./group-CW5gDiS9.js";
import { i as rememberRequirements, r as extractRequirements, t as buildExport } from "./export-Dd0V9eAh.js";
import { a as persistComposite, i as liveCompositeSpecs, o as registerComposite, r as editCompositeTool, t as compileComposite } from "./composite-BLBbp1v8.js";
import { r as scanWorkspace } from "./filemap-DwuQaf3V.js";
import Schema from "@deepseek-ai/schemastery";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
// src/recall.ts
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
	const haystack = tokenize(`${memory.text} ${memory.keywords.join(" ")}`);
	if (haystack.length === 0) return 0;
	const bag = /* @__PURE__ */ new Map();
	for (const token of haystack) bag.set(token, (bag.get(token) ?? 0) + 1);
	let raw = 0;
	for (const [token, weight] of queryTokens) {
		const hits = bag.get(token);
		if (hits) raw += weight * Math.min(hits, 2);
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
			text: memory.text,
			score: raw * decay(memory.createdAt, options.now, options.halfLifeDays),
			createdAt: memory.createdAt,
			keywords: memory.keywords
		});
	}
	scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
	return scored.slice(0, options.limit);
}
/** Build the model-facing recall card text (温和起步, injectStyle 可配置). */
function renderRecallCard(items, style) {
	if (items.length === 0) return "";
	const lines = items.map((item, index) => `${index + 1}. ${item.text}`);
	if (style === "plain") return ["[SuperMemory 相关记忆]", ...lines].join("\n");
	return [
		"[SuperMemory 相关记忆]",
		"以下记忆可能与本话题相关，仅供参考；与当前指令冲突时以当前指令为准。",
		...lines
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
	for (const [, topicSet] of store.topicsets.entries()) if (topicSet.members.some((m) => m.sessionId === sessionId)) return true;
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
	lines.push("如需把实质工作分派到分支，调用 memory_dispatch；本会话是中枢，只做判断与整合。");
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
	const llm = ctx.llm;
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
	["wrap", "更新当前话题集梗概"],
	["scan", "扫描工作区，刷新项目文件地图"],
	["export", "导出 .supermemory-export.md 到工作区根目录"],
	["help", "查看 /memory 命令族全部用法"]
];
/** Attach the /memory command family; returns the effect disposer. */
function attachCommands(ctx, deps) {
	const disposers = [];
	disposers.push(ctx.commands.register({
		name: "memory",
		description: "SuperMemory 命令族：ui 可视化管理台 · status 状态 · topicsets 话题集 · switch 激活 · new 新建 · model 模型 · tools 组合工具 · reqs 需求 · wrap 梗概 · scan 扫描 · export 导出（每个子命令也可直接输 /memory-<名> 快速选择）",
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
			const id = await createTopicSet(store, {
				workspaceKey,
				title: arg.slice(0, 40),
				...model ? { defaultModel: model } : {}
			});
			await setRouting(store, sessionId, {
				activeTopicSetId: id,
				driftCount: 0
			});
			return {
				kind: "success",
				text: `已创建并激活话题集『${arg.slice(0, 40)}』${model ? `（默认模型 ${model.provider}/${model.model}）` : ""}`
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
			const { scanWorkspace, filemapEntries } = await import("./filemap-DwuQaf3V.js").then((n) => n.n);
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
			const { buildExport } = await import("./export-Dd0V9eAh.js").then((n) => n.n);
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
const HELP = "status 状态总览 · topicsets 话题集列表 · switch <名> 激活 · new <标题> 新建 · model 模型管理 · tools 组合工具 · reqs 需求 · wrap 更新梗概 · scan/export（P2） · ui 可视化管理台（Plan A）\n快捷方式：每个子命令都是独立命令，输入 /memory 后可在列表里直接选择（如 /memory-ui、/memory-status、/memory-topicsets）；也可用 /memory <子命令> <参数>。";
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
// src/dispatch.ts
const branchHandles = /* @__PURE__ */ new Map();
let createMessage$1;
async function messageFactory$2() {
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
/**
* The dispatch tool body. `tasks[]` (2+) becomes one parallel group (D6);
* a single `task` is the single-dispatch path. Returns receipts immediately;
* the hub never blocks beyond branch acquisition.
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
	let topicSetId = args.topicSetId?.trim();
	if (topicSetId && !getTopicSet(store, topicSetId)) return {
		status: "error",
		message: `话题集 ${topicSetId} 不存在。`
	};
	if (!topicSetId) topicSetId = getRouting(store, hubSessionId)?.activeTopicSetId;
	const firstTask = (args.task ?? args.tasks?.[0] ?? "").trim();
	if (!topicSetId) {
		topicSetId = await createTopicSet(store, {
			workspaceKey,
			title: firstTask.slice(0, 12)
		});
		await setRouting(store, hubSessionId, {
			activeTopicSetId: topicSetId,
			driftCount: 0
		});
		logger.info(`supermemory: dispatch auto-created topic set ${topicSetId}`);
	}
	const topicSet = getTopicSet(store, topicSetId);
	if (!topicSet) return {
		status: "error",
		message: "话题集解析失败。"
	};
	await touchTopicSet(store, topicSetId);
	const hubModel = hubSelection(exec.agent);
	const mode = args.mode ?? "auto";
	const tasks = (args.tasks ?? []).map((t) => String(t ?? "").trim()).filter(Boolean);
	if (tasks.length >= 2) {
		const groupId = newGroupId();
		const receipts = [];
		for (const task of tasks) {
			const one = await dispatchOne(deps, {
				topicSetId,
				topicSet,
				task,
				cwd,
				hubSessionId,
				hubModel,
				mode: mode === "fork" ? "fork" : "new",
				groupId
			});
			receipts.push(one);
		}
		const ok = receipts.filter((r) => r.status === "dispatched").length;
		logger.info(`supermemory: group ${groupId} dispatched ${ok}/${tasks.length}`);
		const firstId = receipts[0]?.dispatchId;
		return {
			status: ok > 0 ? "dispatched" : "error",
			...firstId ? { dispatchId: firstId } : {},
			groupId,
			topicSetId,
			message: ok > 0 ? `已派发 ${ok}/${tasks.length} 个分支任务（组 ${groupId}）；全部完成后只回送一次汇总，失败成员会标注。` : "全部任务派发失败。"
		};
	}
	const task = firstTask;
	if (!task) return {
		status: "error",
		message: "task 不能为空。"
	};
	return await dispatchOne(deps, {
		topicSetId,
		topicSet,
		task,
		cwd,
		hubSessionId,
		hubModel,
		mode
	});
}
/** One dispatch: record → acquire → wake → receipt. Shared by both paths. */
async function dispatchOne(deps, input) {
	const { ctx, store, logger } = deps;
	const { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, mode, groupId } = input;
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
			hubModel
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
		if (!topicSet.members.some((m) => m.sessionId === branchSessionId)) await addMember(store, topicSetId, {
			sessionId: branchSessionId,
			kind,
			title: task.slice(0, 16)
		});
	} catch (error) {
		logger.warn(`supermemory: addMember failed for ${branchSessionId}: ${String(error).slice(0, 160)}`);
	}
	try {
		await attachBranchToWorkspace(ctx, branchSessionId, cwd, logger);
	} catch (error) {
		logger.warn(`supermemory: workspace attach failed for ${branchSessionId}: ${String(error).slice(0, 160)}`);
	}
	try {
		const message = (await messageFactory$2())({
			content: [{
				type: "text",
				text: `[supermemory-dispatch ${dispatchId}]\n话题集：${topicSet.title}\n任务：${task}\n\n你是该话题集的一个工作分支：完成实质工作并汇报结果。不要向用户提问，遇到分歧按最合理解释执行。`
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
		...groupId ? { groupId } : {}
	};
}
/**
* Branch acquisition order (§1.3): live handle → live registry agent → resume;
* `fork` builds a seeded child from the parent's last completed turn.
* Model resolution: topicset default → hub's current selection (so a branch
* without a set default follows the hub) → deployment default.
*/
async function acquireBranch(deps, input) {
	const { ctx, store, logger } = deps;
	const { topicSetId, topicSet, task, cwd, mode, hubModel } = input;
	const taskTokens = new Set(task.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean));
	const ranked = rankMembers(topicSet, taskTokens);
	const agentOptions = topicSet.defaultModel ?? hubModel;
	const forkParent = ranked[0];
	if (forkParent && (mode === "fork" || mode === "auto" && forkParent.kind === "fork")) {
		const forked = await forkFromParent(ctx, forkParent.sessionId, cwd, topicSet.defaultModel, logger);
		if (forked) return {
			...forked,
			kind: "fork"
		};
	}
	if (mode !== "new" && ranked.length > 0) {
		const target = ranked[0];
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
				...resumeOptions ? { agentOptions: { ...resumeOptions } } : {}
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
		meta: { cwd },
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
async function forkFromParent(ctx, parentSessionId, cwd, defaultModel, logger) {
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
				parentSession: parentSessionId
			},
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
function findMember(store, sessionId) {
	for (const [, topicSet] of store.topicsets.entries()) {
		const member = topicSet.members.find((m) => m.sessionId === sessionId);
		if (member) return member;
	}
}
// src/extract.ts
const REMEMBER_PATTERNS = [/(?:记住|记一下|请记住|帮忙记住|牢记)[:：\s]+(.{2,200})/, /(?:remember|note that|don'?t forget|keep in mind)\b[:：\s]+(.{2,200})/i];
const DEFINITION_PATTERNS = [/^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)(?:是|为|等于)(.{4,200})$/, /^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)\s+(?:is|are)\s+(.{4,200})$/i];
const STOP_WORDS = /* @__PURE__ */ new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"and",
	"or",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"这个",
	"那个",
	"一下",
	"什么",
	"怎么",
	"如何",
	"请",
	"帮我把",
	"记得"
]);
/** Extract keywords from a fact text (latin words + CJK bigrams, stop-words dropped). */
function keywordsOf(text) {
	const tokens = [];
	const lower = text.toLowerCase();
	for (const m of lower.matchAll(/[a-z0-9_+#.\-]{2,}/g)) if (!STOP_WORDS.has(m[0])) tokens.push(m[0]);
	const chars = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i + 1 < chars.length; i++) {
		const bigram = chars[i] + chars[i + 1];
		if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
	}
	return [...new Set(tokens)].slice(0, 24);
}
/**
* Extract memory-worthy facts from one user message.
* @param text - the user message's plain text.
* @returns zero or more facts; empty when nothing is memory-worthy.
*/
function extractFacts(text) {
	const facts = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (raw) => {
		const clean = raw.trim().replace(/\s+/g, " ").replace(/["'」』]+$/, "").slice(0, 300);
		if (clean.length < 2) return;
		const key = clean.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		facts.push({
			text: clean,
			keywords: keywordsOf(clean)
		});
	};
	for (const pattern of REMEMBER_PATTERNS) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		for (const m of text.matchAll(new RegExp(pattern.source, flags))) push(m[1]);
	}
	for (const line of text.split(/\n+/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.length > 80) continue;
		for (const pattern of DEFINITION_PATTERNS) {
			const m = trimmed.match(pattern);
			if (m && m[1].length >= 2) push(`${m[1].trim()}是${m[2].trim()}`);
		}
	}
	return facts;
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
	const { parseArgs } = await import("./composite-BLBbp1v8.js").then((n) => n.n);
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
		text,
		keywords,
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
// src/observe.ts
/** Per-branch settle chain: concurrent settles (live turn/end + startup
* reconcile) must not both episode + relay the same dispatch, and a trigger that
* arrives while one is running must still get its own pass afterwards (dropping
* it would leave a later turn's dispatch unsettled until the next event). */
const settlingBranches = /* @__PURE__ */ new Map();
let sharedFactory;
/** Process-wide cached `createUserMessage` (loaded through the host anchor). */
async function messageFactory$1() {
	if (!sharedFactory) sharedFactory = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return sharedFactory;
}
/** Read one session's durable log range through the persistence seam. */
async function coldRead$1(ctx, sessionId, afterSeq, untilSeq) {
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
	const summary = finalText.length > 400 ? `${finalText.slice(0, 400)}…` : finalText;
	for (const name of new Set(toolNames)) decisions.push(`调用了 ${name}`);
	return {
		topicSetId,
		branchSessionId,
		timeStart,
		timeEnd,
		summary,
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
function relayText(dispatch, episode, failure) {
	const head = `[supermemory-relay ${dispatch.branchSessionId}]`;
	if (failure) return `${head}\n任务：${dispatch.task}\n结果：分支未成功完成（${failure}）。以上为失败事实，未伪装成答案。`;
	const body = episode?.summary || "（分支已完成，但未生成摘要）";
	return `${head}\n任务：${dispatch.task}\n分支结果：\n${body}`;
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
	return () => {
		off();
		offConfirm();
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
		if (record.status === "delivered" || record.status === "failed") continue;
		if (turnEndSeq !== void 0 && record.startSeq >= turnEndSeq) continue;
		open.push([dispatchId, record]);
	}
	if (open.length === 0) return;
	const events = await coldRead$1(ctx, branchSessionId, -1, turnEndSeq);
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
				text: relayText(record, episode)
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
			if (!record.groupId) await deliver(deps, {
				dispatchId,
				record,
				text: relayText(record, void 0, failure)
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
	const deliveryId = input.groupId ? "dlv-grp-" + input.groupId : "dlv-" + input.dispatchId;
	await store.outbox.put(deliveryId, {
		dispatchId: input.groupId ? void 0 : input.dispatchId,
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
		const factory = await messageFactory$1();
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
			const factory = await messageFactory$1();
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
				const card = renderRecallCard(items, config.injectStyle).slice(0, config.maxChars);
				if (!card) return decision;
				const message = await build(card);
				commitCard(state, step, items, card.length);
				return {
					...decision,
					messages: [...messages, message]
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
	const payload = "[supermemory-relay " + record.branchSessionId + "]\n任务：" + record.task + "\n结果：" + reason;
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
							text: `[supermemory-dispatch ${dispatchId}]\n任务：${record.task}\n\n（重启恢复：重新派发）`
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
				const { groupMembers } = await import("./group-CW5gDiS9.js").then((n) => n.o);
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
let createMessage;
async function messageFactory() {
	if (!createMessage) createMessage = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return createMessage;
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
			summary: "",
			branches: []
		};
		return {
			id,
			title: topicSet.title,
			summary: topicSet.summary,
			branches: topicSet.members.map((m) => ({
				sessionId: m.sessionId,
				title: m.title,
				status: m.status,
				...m.model ? { model: m.model } : {}
			})),
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
		for (const [, record] of this.store.dispatches.entries()) if (record.status !== "delivered" && record.status !== "failed") dispatches++;
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
			const bag = new Set(tokenize(`${record.text} ${record.key ?? ""} ${record.keywords.join(" ")}`));
			let score = 0;
			for (const token of tokens) if (bag.has(token)) score++;
			if (tokens.size > 0 && score === 0) continue;
			rows.push({
				score,
				view: {
					id,
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
	async createMemory(cwd, text, key) {
		const workspaceKey = this.wk(cwd);
		const body = String(text ?? "").trim();
		if (!body) return {
			status: "error",
			message: "记忆文本不能为空。"
		};
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
			text: body,
			key: stableKey,
			keywords: [...new Set(tokenize(body))].slice(0, 12),
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
	async updateMemory(cwd, id, text, key) {
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
		await this.store.memories.update(id, (r) => ({
			...r,
			text: body,
			...key !== void 0 ? { key: key.trim() || void 0 } : {},
			keywords: [...new Set(tokenize(body))].slice(0, 12),
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
	/** Create a topic set (panel). */
	async createTopicSet(cwd, title) {
		const workspaceKey = this.wk(cwd);
		const name = String(title ?? "").trim();
		if (!name) return {
			status: "error",
			message: "标题不能为空。"
		};
		const id = await createTopicSet(this.store, {
			workspaceKey,
			title: name.slice(0, 40)
		});
		return {
			status: "ok",
			message: `已创建话题集『${name.slice(0, 40)}』。`,
			id
		};
	}
	/** Update a topic set's summary (panel). */
	async updateTopicSetSummary(id, summary) {
		if (!this.store.topicsets.get(id)) return {
			status: "error",
			message: "话题集不存在。"
		};
		await updateTopicSetSummary(this.store, id, String(summary ?? "").slice(0, 500));
		return {
			status: "ok",
			message: "梗概已更新。",
			id
		};
	}
	/**
	* R3: create a session bound to one or more topic sets (话题集会话).
	* The session is a fresh root member of every selected topic set.
	*/
	async createTopicSetSession(cwd, topicSetIds) {
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
		try {
			const sessionId = newId("tsession");
			await ctx.agents.create({
				sessionId,
				meta: { cwd }
			});
			for (const id of ids) {
				if (!getTopicSet(this.store, id).members.some((m) => m.sessionId === sessionId)) await addMember(this.store, id, {
					sessionId,
					kind: "root",
					title: `话题集会话：${titles.join("、").slice(0, 24)}`
				});
				await touchTopicSet(this.store, id);
			}
			try {
				await attachBranchToWorkspace(ctx, sessionId, cwd, {
					warn: () => {},
					info: () => {}
				});
			} catch {}
			return {
				status: "ok",
				message: `已创建话题集会话（${titles.join("、")}）。`,
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
			await addMember(this.store, topicSetId, {
				sessionId,
				kind: "root",
				title: "面板回复"
			});
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
					text: `[supermemory-panel-reply]\n话题集：${topicSet.title}\n用户回复：${body}\n\n你是该话题集的工作分支：按用户回复继续执行并汇报结果。不要向用户提问，遇到分歧按最合理解释执行。`
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
			try {
				const spec = JSON.parse(record.entry);
				name = spec.name ?? id;
				steps = (spec.steps ?? []).map((s) => s.tool);
				parameters = (spec.parameters ?? []).map((p) => p.name);
			} catch {}
			rows.push({
				id,
				name,
				description: record.description,
				steps,
				parameters,
				useCount: record.useCount,
				status: record.status,
				live: liveCompositeSpecs.has(name)
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
			name: "title",
			wire: "title",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Title",
				create: () => ({ parse: (v) => v })
			}
		}]
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
			name: "summary",
			wire: "summary",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Summary",
				create: () => ({ parse: (v) => v })
			}
		}]
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
			name: "topicSetIds",
			wire: "topicSetIds",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#TopicSetIds",
				create: () => ({ parse: (v) => v })
			}
		}]
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
	}
]);
/** Mount the panel service + register its remote descriptors. */
function attachPanel(ctx, store) {
	if (!store) return () => {};
	const service = new SupermemoryPanelService(store, ctx);
	ctx.provide("supermemoryPanel", service);
	try {
		ctx.typert?.register({
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
	} catch {}
	return () => {};
}
// src/tools.ts
/** Attach all tools; returns the effect disposer. */
async function attachTools(ctx, deps, config) {
	const { store } = deps;
	const tools = await loadHostModule("@deepseek-ai/dsh-tools");
	const disposers = [];
	if (config.rememberEnabled) disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_remember",
		description: "将一条事实记忆写入 SuperMemory：跨会话持久、按工作区隔离。用户明确要求记住某事、或你判断某事实值得跨会话保留时使用。同一 key 已存不同文本时返回冲突提示（不覆盖），由你向用户裁决。",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "要记住的事实文本，简洁自包含"
			},
			key: {
				type: "string",
				description: "可选稳定键；同一事实更新时传相同 key"
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
			const key = args.key?.trim() || void 0;
			const now = Date.now();
			if (key) for (const [memoryId, record] of store.memories.entries()) {
				if (record.workspaceKey !== workspaceKey || record.status !== "active" || record.key !== key) continue;
				if (record.text.trim().toLowerCase() === text.toLowerCase()) return {
					status: "duplicate",
					memoryId,
					message: "该 key 已存相同内容，未重复写入。"
				};
				return {
					status: "conflict",
					memoryId,
					message: `key「${key}」已存不同内容：「${record.text}」。请与用户裁决后再写入。`,
					conflict: {
						memoryId,
						text: record.text
					}
				};
			}
			for (const [memoryId, record] of store.memories.entries()) if (record.workspaceKey === workspaceKey && record.status === "active" && record.text.trim().toLowerCase() === text.toLowerCase()) return {
				status: "duplicate",
				memoryId,
				message: "相同记忆已存在，未重复写入。"
			};
			const memoryId = newId("mem");
			const memory = {
				workspaceKey,
				text,
				key,
				keywords: keywordsOfText(text),
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
				message: `已记住：${text}`
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_recall",
		description: "检索 SuperMemory：事实记忆（memories）、归档梗概（episodes）、需求（requirements）与项目文件地图（filemap），按当前工作区隔离，关键词 + 时间衰减规则评分。回答\"之前说过什么/做过什么\"类问题前先用本工具检索。",
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
								text: {
									type: "string",
									required: true
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
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const items = value.items ?? [];
				if (items.length === 0) return [{
					type: "text",
					text: "（未检索到相关记忆）"
				}];
				return [{
					type: "text",
					text: items.map((item, i) => `${i + 1}. ${item.text}`).join("\n")
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
			const query = String(args.query ?? "").trim();
			if (!query) return {
				items: [],
				total: 0
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
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			const requirements = [];
			for (const entry of store.requirements.entries()) if (entry[1].workspaceKey === workspaceKey && entry[1].status === "open") requirements.push(entry);
			for (const item of recallMemories(requirements.map(([id, req]) => [id, {
				workspaceKey: req.workspaceKey,
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
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			const filemap = [];
			for (const entry of store.filemap.entries()) if (entry[1].workspaceKey === workspaceKey) filemap.push(entry);
			for (const item of recallMemories(filemap.map(([key, entry]) => [key, {
				workspaceKey: entry.workspaceKey,
				text: `${entry.path}（${entry.role}）${entry.summary}`,
				keywords: entry.keywords,
				sourceSessionId: "",
				sourceSeq: 0,
				status: "active",
				createdAt: entry.annotatedAt,
				updatedAt: entry.annotatedAt
			}]), query, options)) items.push({
				kind: "file",
				id: item.memoryId,
				text: item.text,
				score: item.score,
				createdAt: item.createdAt
			});
			items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
			return {
				items: items.slice(0, options.limit),
				total: items.length
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
								summary: {
									type: "string",
									required: true
								},
								branches: {
									type: "integer",
									required: true
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
					text: items.map((i) => `- ${i.title}（${i.branches} 分支${i.model ? " · " + i.model : ""}）${i.summary ? "：" + i.summary.slice(0, 80) : ""}`).join("\n")
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
				summary: topicSet.summary,
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
		description: "为当前讨论新建一个话题集（可按提示选择默认模型），并立即激活。显式开新话题时使用；不确定时先 memory_topicsets 查看已有话题集。",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "话题集标题（简短）"
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
					model: { type: "string" },
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "created") return [{
					type: "text",
					text: `已创建并激活话题集『${v.title ?? ""}』${v.model ? "（默认模型 " + v.model + "）" : ""}`
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
			const topicSetId = await createTopicSet(store, {
				workspaceKey,
				title: String(args.title).slice(0, 40),
				...model ? { defaultModel: model } : {}
			});
			await setRouting(store, sessionId, {
				activeTopicSetId: topicSetId,
				driftCount: 0
			});
			return {
				status: "created",
				topicSetId,
				title: String(args.title).slice(0, 40),
				...model ? { model: `${model.provider}/${model.model}` } : {}
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_dispatch",
		description: "把实质工作异步派发到话题集的分支会话（在全新对话中执行，不在主对话框直接完成操作）：插件先落账，随即唤醒分支并立即返回回执，本会话（中枢）不阻塞。分支完成后结果会以 relay 形式主动送回本会话。简单问答不要派发——上下文卡/recall 能答的中枢直接答。mode=auto 时插件自行判定继续/新建；需要从父分支最近已完成轮次开新分支时用 mode=fork。传 tasks[]（2 个以上）走并行组：每个任务一个分支，全部到达终态后只回送一次汇总（失败成员标注）。",
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
			mode: {
				type: "string",
				enum: [
					"auto",
					"continue",
					"fork",
					"new"
				],
				description: "分支获取方式；默认 auto"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["dispatched", "error"],
						required: true
					},
					dispatchId: { type: "string" },
					branchSessionId: { type: "string" },
					groupId: { type: "string" },
					topicSetId: { type: "string" },
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "dispatched") return [{
					type: "text",
					text: v.message ?? `已派发到分支 ${v.branchSessionId}；完成后结果会主动送回本会话。`
				}];
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
				const { scanWorkspace, filemapEntries } = await import("./filemap-DwuQaf3V.js").then((n) => n.n);
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
				const { buildExport } = await import("./export-Dd0V9eAh.js").then((n) => n.n);
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
		description: "工具化（P3）：列出待处理的组合工具提议（重复流程达阈值后产生），或接受/拒绝某个提议。接受会把记录到的工具序列编译成组合工具（一次调用完成确定性子序列）并持久化，重启后仍可用。",
		parameters: {
			accept: {
				type: "boolean",
				description: "接受第一个待处理提议并生成组合工具"
			},
			decline: {
				type: "boolean",
				description: "拒绝（不再提示）第一个待处理提议"
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
					message: { type: "string" }
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "listed") {
					const list = (v.pending ?? []).map((p) => `- ${p.pattern}（${p.count} 次）`).join("\n");
					return [{
						type: "text",
						text: list ? `待处理提议：\n${list}` : "（没有待处理的工具化提议）"
					}];
				}
				if (v.status === "accepted") return [{
					type: "text",
					text: `已固化为组合工具 ${v.tool}。`
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
		async execute(args) {
			const pending = [];
			for (const [key, signal] of store.signals.entries()) if (signal.proposalStatus === "pending" && signal.proposedAt !== void 0) pending.push([key, signal]);
			if (!args.accept && !args.decline) return {
				status: "listed",
				pending: pending.map(([, s]) => ({
					pattern: s.pattern,
					count: s.count
				}))
			};
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
				const { compileComposite, registerComposite, persistComposite } = await import("./composite-BLBbp1v8.js").then((n) => n.n);
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
/** Keywords for a tool-written memory (same rules as extraction). */
function keywordsOfText(text) {
	const tokens = [];
	for (const m of text.toLowerCase().matchAll(/[a-z0-9_+#.\-]{2,}/g)) tokens.push(m[0]);
	const chars = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
	return [...new Set(tokens)].slice(0, 24);
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
/** Title cap, mirroring `/memory new`. */
const MAX_TITLE = 40;
let active;
/** The live handle, read by the `/memory ui` command and the `memory_ui` tool. */
function getWebui() {
	return active;
}
/** Attach the console; returns the effect disposer. */
function attachWebui(ctx, store, config, logger) {
	if (!config.enabled || !store) return () => {};
	const theStore = store;
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
				return await handleApi(res, route, body, theStore, logger);
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
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>SuperMemory</title></head><body style=\"background:#0f1115;color:#e6e8ee;font-family:system-ui;padding:24px\"><h3>SuperMemory 管理台</h3><p>静态资源缺失：请在插件目录保留 <code>src/web/</code>（index.html / app.js / style.css）。</p></body></html>";
}
/** Every mutating endpoint validates the target row against `ws` first. */
async function handleApi(res, route, body, store, logger) {
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
		case "state":
			if (!ws) return fail("ws 不能为空");
			return sendJson(res, 200, {
				ok: true,
				...buildState(store, ws)
			});
		case "memory/create": {
			const memText = text(body.text);
			if (!memText) return fail("text 不能为空");
			if (memText.length > 4e3) return fail("text 过长（上限 4000 字符）");
			const id = newId("mem");
			const now = Date.now();
			const record = {
				workspaceKey: ws,
				text: memText,
				keywords: list(body.keywords),
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
			await store.memories.update(id, (r) => ({
				...r,
				...memText ? { text: memText } : {},
				...body.keywords !== void 0 ? { keywords: list(body.keywords) } : {},
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
				title: title.slice(0, MAX_TITLE),
				summary: text(body.summary) || void 0,
				keywords: list(body.keywords)
			});
			logger.info(`supermemory: webui created topic set ${id}`);
			return sendJson(res, 200, {
				ok: true,
				id
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
				...title ? { title: title.slice(0, MAX_TITLE) } : {},
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
		maxTokensPolicy: Schema.union([Schema.const("deliver-partial"), Schema.const("fail")]).description("max-tokens 终态处理").default("deliver-partial")
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
				const { compileComposite, registerComposite, persistComposite } = await import("./composite-BLBbp1v8.js").then((n) => n.n);
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
const PROMPT_TEXT = [
	"[SuperMemory 记忆]",
	"- 涉及历史结论、约定、构建命令、文件用途、\"之前说过/做过什么\"时，先调用 memory_recall 检索再作答。",
	"- 用户明确要求记住某事、或某事实值得跨会话保留时，调用 memory_remember 写入（按工作区隔离）。",
	"- 对话连续性：用户在当前对话框直接对话时，你就在当前对话的上下文中继续回答，不要询问是否切换话题、不要自行切换话题集；",
	"  话题集只在用户显式 @话题集名、在 SuperMemory 面板中激活、或执行 /memory switch 时才切换。",
	"- 实质工作必须开新对话执行：当用户提出问题需要实际操作（读改文件、执行命令、多步调研、修复与验证等）时，",
	"  调用 memory_dispatch 把任务派发到话题集分支会话中完成，由分支汇报结果——不要在主对话框里直接完成整套操作或长篇大论；",
	"  主对话框只做：判断、派发、收到 relay 结果后轻量转述。纯问答、简单确认、记忆检索类问题不要派发。",
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
		store = await openStore(ctx.storageDomain, logger);
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
			const { rebuildComposites } = await import("./composite-BLBbp1v8.js").then((n) => n.n);
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
	if (store) runReconciliation({
		ctx,
		store,
		logger,
		observe: {
			enabled: config.observe.enabled,
			maxTokensPolicy: config.observe.maxTokensPolicy
		}
	});
	if (store) {
		const releaseStore = store;
		const observeConfig = {
			enabled: config.observe.enabled,
			maxTokensPolicy: config.observe.maxTokensPolicy
		};
		const timer = setInterval(() => {
			try {
				flushObserve({
					ctx,
					store: releaseStore,
					config: observeConfig,
					logger
				}).catch(() => {});
				const now = Date.now();
				for (const sessionId of releasableBranches(releaseStore, now, config.dispatch.idleReleaseMs)) {
					const handle = branchHandles.get(sessionId);
					if (!handle) continue;
					handle.dispose().then(() => {
						branchHandles.delete(sessionId);
						logger.info(`supermemory: released idle branch ${sessionId.slice(0, 13)}`);
					}).catch(() => {});
				}
			} catch {}
		}, 3e5);
		ctx.effect(() => () => clearInterval(timer), "supermemory: release-sweep");
	}
	logger.info(`supermemory: active (store=${store ? "open" : "degraded"})`);
}
export { Config, apply, inject, name, toolizeConfig };
