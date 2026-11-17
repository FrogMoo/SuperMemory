import { t as __exportAll } from "./rolldown-runtime-BJohB4LM.js";
import { a as listTopicSets, c as setTopicSetModel, d as updateMember, f as updateTopicSetSummary, i as getTopicSet, n as createTopicSet, o as rankMembers, r as getRouting, s as setRouting, t as addMember, u as touchTopicSet } from "./topicsets-Bbl9iZ3U.js";
import { i as loadHostModule, n as openStore, r as workspaceKeyOf, t as newId } from "./store-DegBEROs.js";
import { a as groupRelayText, i as groupRelayExists, n as groupEpisodeSummaries, r as groupMembers, s as newGroupId, t as groupComplete } from "./group-LPE_88Cy.js";
import Schema from "@deepseek-ai/schemastery";
import { realpathSync } from "node:fs";
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
	const mention = text.match(/@([^\s@,，。;；]{1,30})/);
	if (mention) {
		const name = mention[1];
		for (const [id, topicSet] of listTopicSets(store, workspaceKey)) if (topicSet.title === name || topicSet.title.includes(name) || name.includes(topicSet.title)) {
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
			setRouting(store, sessionId, { driftCount: 0 });
		}
	}
	const candidates = listTopicSets(store, workspaceKey).map(([id, topicSet]) => ({
		id,
		topicSet,
		score: scoreTopicSet(topicSet, tokens)
	})).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
	if (candidates.length > 0) {
		const best = candidates[0];
		if (config.confirm) {
			const answer = await askConfirm(ctx, logger, agent, signal, `检测到相似话题『${best.topicSet.title}』（${best.topicSet.summary || "暂无梗概"}）？当前消息可能属于该话题。`, best.topicSet.title);
			if (answer === "continue") {
				await setRouting(store, sessionId, {
					activeTopicSetId: best.id,
					driftCount: 0
				});
				await touchTopicSet(store, best.id);
				return {
					topicSetId: best.id,
					card: renderCard(best.topicSet)
				};
			}
			if (answer === "new") return await createAndActivate(ctx, deps, sessionId, workspaceKey, text);
			return {};
		}
		await setRouting(store, sessionId, {
			activeTopicSetId: best.id,
			driftCount: 0
		});
		return {
			topicSetId: best.id,
			card: renderCard(best.topicSet)
		};
	}
	if (config.confirm) {
		const answer = await askConfirm(ctx, logger, agent, signal, "没有检测到相似的历史话题。要为当前讨论新建一个话题集吗？", "");
		if (answer === "new" || answer === "continue") return await createAndActivate(ctx, deps, sessionId, workspaceKey, text);
	}
	return {};
}
async function createAndActivate(ctx, deps, sessionId, workspaceKey, text) {
	const title = deriveTitle(text);
	const id = await createTopicSet(deps.store, {
		workspaceKey,
		title,
		keywords: [...new Set(tokenize(text))].slice(0, 12)
	});
	setRouting(deps.store, sessionId, {
		activeTopicSetId: id,
		driftCount: 0
	});
	deps.logger.info(`supermemory: topic set created ${id} (${title})`);
	return {
		topicSetId: id,
		created: id,
		card: renderCard(getTopicSet(deps.store, id))
	};
}
/** Ask the routing confirmation through the host's user-question channel. */
async function askConfirm(ctx, logger, agent, signal, question, topicTitle) {
	try {
		const selected = (await ctx.userQuestions.ask({
			questions: [{
				id: "supermemory-route",
				header: "话题路由",
				question,
				options: [
					{
						label: topicTitle ? `继续该话题` : "新建话题集",
						description: topicTitle ? `激活『${topicTitle}』` : "为当前讨论新建话题集"
					},
					...topicTitle ? [{
						label: "新建话题集",
						description: "为当前讨论新建话题集"
					}] : [],
					{
						label: "都不对",
						description: "本次不进行话题路由"
					}
				]
			}],
			...agent ? { agent } : {},
			...signal ? { signal } : {}
		}))?.answers?.[0]?.selected?.[0] ?? "";
		if (selected === "继续该话题") return "continue";
		if (selected === "新建话题集") return "new";
		return "none";
	} catch (error) {
		logger.warn(`supermemory: routing confirmation unavailable: ${String(error).slice(0, 160)}`);
		return;
	}
}
/** First ~12 chars of the user text as a provisional title. */
function deriveTitle(text) {
	return (text.split("\n").map((s) => s.trim()).find(Boolean) ?? "新话题").slice(0, 12) || "新话题";
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
/** Apply a model selection to a live agent and/or persist it as an override. */
async function applyModelSelection(deps, target, selection) {
	const { ctx, store, logger } = deps;
	let live = false;
	if (target.branchSessionId) {
		const agent = ctx.agents.get(target.branchSessionId);
		if (agent) {
			agent.model.select(selection);
			live = true;
		}
		if (target.topicSetId) await updateMember(store, target.topicSetId, target.branchSessionId, {
			model: `${selection.provider}/${selection.model}`,
			modelOverridden: true
		});
		return {
			applied: target.branchSessionId,
			live
		};
	}
	if (target.topicSetId) {
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
// src/requirements.ts
var requirements_exports = /* @__PURE__ */ __exportAll({ openRequirements: () => openRequirements });
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
		for (const m of text.matchAll(new RegExp(pattern.source, flags))) push(m[1]);
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
// src/commands.ts
/** Attach the /memory command; returns the effect disposer. */
function attachCommands(ctx, deps) {
	return ctx.commands.register({
		name: "memory",
		description: "SuperMemory：/memory status 状态、topicsets 话题集、switch 切换、new 新建、reqs 需求、scan 扫描、export 导出、wrap 小结、model 模型",
		handler: async (invocation) => {
			const store = deps.store;
			if (!store) return {
				kind: "error",
				text: "SuperMemory 存储域未打开，记忆功能不可用。"
			};
			const [sub, ...rest] = (invocation.rawInput ?? "").trim().split(/\s+/);
			const arg = rest.join(" ").trim();
			const agent = invocation.agent;
			const sessionId = String(agent?.id ?? "");
			const workspaceKey = deps.workspaceKeyOfCwd(agent?.session?.header?.cwd);
			switch (sub ?? "") {
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
				case "reqs": {
					const open = [];
					for (const [, record] of store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open") open.push(`- ${record.text}`);
					return {
						kind: "success",
						text: open.length ? `未完成需求：\n${open.join("\n")}` : "（暂无未完成需求）"
					};
				}
				case "scan": {
					const { scanWorkspace, filemapEntries } = await import("./filemap-BXY1TTJE.js");
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
					const { filemapEntries } = await import("./filemap-BXY1TTJE.js");
					const { listTopicSets: list, getTopicSet: getTs } = await import("./topicsets-Bbl9iZ3U.js").then((n) => n.l);
					const active = getRouting(store, sessionId)?.activeTopicSetId;
					const topicSet = active ? getTs(store, active) : void 0;
					const lines = ["# SuperMemory 导出", ""];
					if (topicSet) lines.push(`## 话题集：${topicSet.title}`, "", topicSet.summary || "（暂无梗概）", "");
					const mems = [];
					for (const [, record] of store.memories.entries()) if (record.workspaceKey === workspaceKey && record.status === "active") mems.push(`- ${record.text}`);
					if (mems.length) lines.push("## 事实记忆", "", ...mems, "");
					const reqs = openRequirements(store, workspaceKey);
					if (reqs.length) lines.push("## 未完成需求", "", ...reqs.map(([, r]) => `- ${r.text}`), "");
					const eps = [];
					for (const [, episode] of store.episodes.entries()) if (episode.summary) eps.push(`- ${episode.summary}`);
					if (eps.length) lines.push("## 归档梗概", "", ...eps.slice(-20), "");
					const files = filemapEntries(store, workspaceKey);
					if (files.length) {
						lines.push("## 项目文件地图", "");
						for (const [, entry] of files) lines.push(`- \`${entry.path}\` — ${entry.role}${entry.summary ? "：" + entry.summary : ""}`);
						lines.push("");
					}
					const target = `${cwdFor(agent)}/.supermemory-export.md`;
					writeFileSync(target, lines.join("\n"), "utf8");
					return {
						kind: "success",
						text: `已导出到 ${target}（${mems.length} 条记忆、${reqs.length} 条需求、${files.length} 个文件条目）。`
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
	});
}
const HELP = "status 状态总览 · topicsets 话题集列表 · switch <名> 激活 · new <标题> 新建 · model 模型管理 · reqs 需求 · wrap 更新梗概 · scan/export（P2）";
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
let createMessage;
async function messageFactory$1() {
	if (!createMessage) createMessage = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
	return createMessage;
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
	if (!topicSet.members.some((m) => m.sessionId === branchSessionId)) await addMember(store, topicSetId, {
		sessionId: branchSessionId,
		kind,
		title: task.slice(0, 16)
	});
	try {
		await attachBranchToWorkspace(ctx, branchSessionId, cwd, logger);
	} catch (error) {
		logger.warn(`supermemory: workspace attach failed for ${branchSessionId}: ${String(error).slice(0, 160)}`);
	}
	try {
		const message = (await messageFactory$1())({
			content: [{
				type: "text",
				text: `[supermemory-dispatch ${dispatchId}]\n话题集：${topicSet.title}\n任务：${task}\n\n你是该话题集的一个工作分支：完成实质工作并汇报结果。不要向用户提问，遇到分歧按最合理解释执行。`
			}],
			source: { kind: "supermemory" }
		});
		const seqBefore = ctx.sessions.get(branchSessionId)?.seq;
		handle.agent.followup(message);
		await new Promise((r) => setTimeout(r, 300));
		const seqAfter = ctx.sessions.get(branchSessionId)?.seq;
		logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} input landed (seq ${seqBefore} → ${seqAfter})`);
		if (seqAfter === seqBefore) {
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
				message: "分支唤醒后输入未落账（followup 未生效）。"
			};
		}
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
	if (mode === "fork" || mode === "auto" && ranked.length > 0 && ranked[0].kind === "fork") {
		const parent = ranked[0];
		const forked = await forkFromParent(ctx, parent.sessionId, cwd, topicSet.defaultModel, logger);
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
		if (ctx.agents.get(target.sessionId)) return {
			sessionId: target.sessionId,
			kind: target.kind
		};
		try {
			const handle = await ctx.agents.resume({
				resumeSessionId: target.sessionId,
				...agentOptions ? { agentOptions: { ...agentOptions } } : {}
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
		const live = ctx.sessions.get(task.sessionId);
		if (live) workspaceKey = workspaceKeyOf(live.header?.cwd);
		if (users.length === 0 || workspaceKey === void 0) {
			const cold = await coldRead(task.sessionId, cursor, task.seq);
			if (cold) {
				if (users.length === 0) users = cold.users;
				workspaceKey ??= cold.workspaceKey;
			}
		}
		buffers.set(task.sessionId, []);
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
		await countSequenceSignal(activeStore, ctx, task.sessionId, workspaceKey, cursor, task.seq, config.signalsThreshold, logger);
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
	if (count % Math.max(1, everyNTurns) !== 0 && users.length === 0) return;
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
* §2.3: count one turn's tool-call sequence as a tool-ization signal, and
* raise a pending proposal once it crosses the threshold. Samples carry the
* recorded arguments for later composite compilation.
*/
async function countSequenceSignal(store, ctx, sessionId, workspaceKey, afterSeq, untilSeq, threshold, logger) {
	let tools = [];
	const args = [];
	const { sequenceKey, parseArgs } = await import("./composite-CV-hWoLg.js");
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
	const key = sequenceKey(workspaceKey, tools);
	const existing = store.signals.get(key);
	const now = Date.now();
	const samples = [...existing?.samples ?? [], JSON.stringify({
		tools,
		args
	})].slice(-3);
	const crossed = existing?.proposedAt === void 0 && (existing?.count ?? 0) + 1 >= threshold;
	const signal = {
		workspaceKey,
		pattern: tools.join(">"),
		count: (existing?.count ?? 0) + 1,
		lastSeen: now,
		examples: [...existing?.examples ?? [], `${tools.join(" → ")}`].slice(-3),
		sequence: tools,
		samples,
		proposedAt: crossed ? now : existing?.proposedAt,
		proposalStatus: crossed ? "pending" : existing?.proposalStatus
	};
	await store.signals.put(key, signal);
	if (signal.proposalStatus === "pending") logger.info(`supermemory: tool-ization proposal raised for ${tools.join(">")} (count=${signal.count})`);
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
var observe_exports = /* @__PURE__ */ __exportAll({ settleOpenDispatches: () => settleOpenDispatches });
let sharedFactory;
/** Process-wide cached `createUserMessage` (loaded through the host anchor). */
async function messageFactory() {
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
				data: event.data
			});
		}
		return out;
	} finally {
		await handle.close();
	}
}
/** Locate the dispatch's own input message and the first turn/end after it. */
function locateOwnership(events, startSeq) {
	let messageSeq;
	for (const event of events) {
		if (event.seq < startSeq) continue;
		if (event.type === "agent/inbox/spliced") {
			if (event.data.inserted?.some((m) => m.source?.kind === "supermemory")) {
				messageSeq = event.seq;
				break;
			}
		}
		if (event.type === "user/message") {
			if (event.data.source?.kind === "supermemory") {
				messageSeq = event.seq;
				break;
			}
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
function buildEpisode(events, dispatchId, topicSetId, branchSessionId, timeStart, timeEnd) {
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
		settleOpenDispatches(deps, String(session.id), event.seq);
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
			const episode = buildEpisode(owned, dispatchId, record.topicSetId ?? "", branchSessionId, Date.now() - 1, Date.now());
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
	const deliveryId = newId("dlv");
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
		const factory = await messageFactory();
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
// src/prestep.ts
/** Plain text of one message's content blocks. */
function textOf(message) {
	return (message.content ?? []).map((block) => block.type === "text" ? String(block.text ?? "") : "").filter(Boolean).join("\n");
}
/** Attach the recall-injecting pre-step listener. Returns the effect disposer. */
function attachPreStep(ctx, store, config, logger) {
	if (!store || !config.enabled) return () => {};
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
			logger.warn(`supermemory: pre-step next() failed: ${String(error)}`);
			throw error;
		}
		if (decision.kind !== "enter") return decision;
		const messages = decision.messages ?? [];
		if (!messages.some((m) => m.source?.kind === "user")) return decision;
		try {
			const query = messages.map(textOf).filter(Boolean).join("\n").slice(0, 2e3);
			if (!query) return decision;
			const cwd = payload.agent?.session?.header?.cwd;
			const workspaceKey = workspaceKeyOf(cwd);
			const options = {
				limit: config.maxItems,
				minScore: config.minScore,
				halfLifeDays: config.halfLifeDays,
				now: Date.now()
			};
			const own = [];
			for (const entry of store.memories.entries()) {
				const record = entry[1];
				if (record.workspaceKey === workspaceKey && record.status === "active") own.push(entry);
			}
			const card = renderRecallCard(recallMemories(own, query, options), config.injectStyle).slice(0, config.maxChars);
			if (!card) return decision;
			const recallMessage = (await ensureFactory())({
				content: [{
					type: "text",
					text: card
				}],
				source: {
					kind: "supermemory",
					form: "recall"
				}
			});
			return {
				...decision,
				messages: [...decision.messages, recallMessage]
			};
		} catch (error) {
			logger.warn(`supermemory: recall injection skipped: ${String(error)}`);
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
/** Send one failure delivery to the hub (explicit failure, never disguised). */
async function failureDelivery(deps, record, reason) {
	const { ctx, logger } = deps;
	const hub = ctx.agents.get(record.hubSessionId);
	if (!hub) {
		logger.info(`supermemory: failure delivery for ${record.branchSessionId.slice(0, 13)} stays undelivered (hub not live)`);
		return;
	}
	try {
		const make = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage;
		hub.followup(make({
			content: [{
				type: "text",
				text: `[supermemory-relay ${record.branchSessionId}]\n任务：${record.task}\n结果：${reason}`
			}],
			source: {
				kind: "supermemory",
				form: "relay",
				deliveryId: `dlv-${record.branchSessionId}-failed`
			}
		}));
	} catch (error) {
		logger.warn(`supermemory: failure delivery failed: ${String(error).slice(0, 160)}`);
	}
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
			try {
				const { settleOpenDispatches } = await Promise.resolve().then(() => observe_exports);
				await settleOpenDispatches({
					...deps,
					config: {
						enabled: true,
						maxTokensPolicy: "deliver-partial"
					}
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
				const events = await coldRead(ctx, record.branchSessionId, -1);
				const traced = events.some((e) => e.type === "agent/inbox/spliced" && (e.data?.inserted?.some((m) => m.source?.kind === "supermemory") ?? false) || e.type === "user/message" && e.data?.source?.kind === "supermemory");
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
						await failureDelivery(deps, record, "分支在执行前已不存在（重启/重载导致），未伪装成答案。");
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
				const inputSeq = events.findIndex((e) => e.type === "agent/inbox/spliced" && (e.data?.inserted?.some((m) => m.source?.kind === "supermemory") ?? false) || e.type === "user/message" && e.data?.source?.kind === "supermemory");
				if (inputSeq >= 0 && events.some((e, index) => index > inputSeq && e.type === "turn/end") || branch) continue;
				logger.info(`supermemory: reconcile ${dispatchId}: branch dead with input on disk; failing dispatch`);
				await store.dispatches.update(dispatchId, (r) => ({
					...r,
					status: "failed",
					turnEndReason: "branch-died",
					updatedAt: Date.now()
				}));
				await failureDelivery(deps, record, "分支在执行中消失（重启/重载导致），未伪装成答案。");
			} catch (error) {
				logger.warn(`supermemory: reconcile path3 ${dispatchId} failed: ${String(error).slice(0, 160)}`);
			}
		}
		for (const [deliveryId, item] of [...store.outbox.entries()]) {
			if (item.status !== "pending" && item.status !== "relayed") continue;
			let hubSessionId = item.dispatchId ? store.dispatches.get(item.dispatchId)?.hubSessionId : void 0;
			if (!hubSessionId && item.groupId) {
				const { groupMembers } = await import("./group-LPE_88Cy.js").then((n) => n.o);
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
		for (const [deliveryId, item] of [...store.outbox.entries()]) {
			if (item.status !== "pending") continue;
			const record = item.dispatchId ? store.dispatches.get(item.dispatchId) : void 0;
			if (!record || record.status !== "delivered" && record.status !== "failed") continue;
			try {
				await store.outbox.update(deliveryId, (r) => ({
					...r,
					status: "relayed",
					relayedAt: Date.now()
				}));
				logger.info(`supermemory: reconcile ${deliveryId}: dispatch already ${record.status}; marked relayed`);
			} catch (error) {
				logger.warn(`supermemory: reconcile path1 ${deliveryId} failed: ${String(error).slice(0, 160)}`);
			}
		}
		logger.info("supermemory: reconciliation pass complete");
	})();
}
// src/panel.ts
/** Plain data service (no host imports needed at definition time). */
var SupermemoryPanelService = class {
	store;
	constructor(store) {
		this.store = store;
	}
	/** Topic sets of one workspace, newest first. */
	listTopicSets(cwd) {
		const workspaceKey = workspaceKeyOf(cwd);
		return listTopicSets(this.store, workspaceKey).map(([id, topicSet]) => ({
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
		}));
	}
	/** Activate a topic set for one session (sidebar click). */
	activate(sessionId, topicSetId) {
		if (!this.store.topicsets.get(topicSetId)) return false;
		setRouting(this.store, sessionId, {
			activeTopicSetId: topicSetId,
			driftCount: 0
		});
		touchTopicSet(this.store, topicSetId);
		return true;
	}
	/** The active topic set of one session. */
	activeTopicSet(sessionId) {
		const active = getRouting(this.store, sessionId)?.activeTopicSetId;
		if (!active) return void 0;
		const topicSet = this.store.topicsets.get(active);
		if (!topicSet) return void 0;
		return {
			id: active,
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
	}
]);
/** Mount the panel service + register its remote descriptors. */
function attachPanel(ctx, store) {
	if (!store) return () => {};
	const service = new SupermemoryPanelService(store);
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
			const episodes = [];
			for (const entry of store.episodes.entries()) if (entry[1].summary) episodes.push([entry[0], entry[1]]);
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
		description: "把实质工作异步派发到话题集的分支会话：插件先落账，随即唤醒分支并立即返回回执，本会话（中枢）不阻塞。分支完成后结果会以 relay 形式主动送回本会话。简单问答不要派发——上下文卡/recall 能答的中枢直接答。mode=auto 时插件自行判定继续/新建；需要从父分支最近已完成轮次开新分支时用 mode=fork。传 tasks[]（2 个以上）走并行组：每个任务一个分支，全部到达终态后只回送一次汇总（失败成员标注）。",
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
			return await runDispatch(deps.dispatch, args, exec);
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
				const { scanWorkspace, filemapEntries } = await import("./filemap-BXY1TTJE.js");
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
				const { filemapEntries } = await import("./filemap-BXY1TTJE.js");
				const { openRequirements } = await Promise.resolve().then(() => requirements_exports);
				const workspaceKey = workspaceKeyOf(cwd);
				const lines = ["# SuperMemory 导出", ""];
				const routing = store.routing.get(String(exec.agent?.id ?? ""));
				const topicSet = routing?.activeTopicSetId ? store.topicsets.get(routing.activeTopicSetId) : void 0;
				if (topicSet) lines.push(`## 话题集：${topicSet.title}`, "", topicSet.summary || "（暂无梗概）", "");
				const mems = [];
				for (const [, record] of store.memories.entries()) if (record.workspaceKey === workspaceKey && record.status === "active") mems.push(`- ${record.text}`);
				if (mems.length) lines.push("## 事实记忆", "", ...mems, "");
				const reqs = openRequirements(store, workspaceKey);
				if (reqs.length) lines.push("## 未完成需求", "", ...reqs.map(([, r]) => `- ${r.text}`), "");
				const eps = [];
				for (const [, episode] of store.episodes.entries()) if (episode.summary) eps.push(`- ${episode.summary}`);
				if (eps.length) lines.push("## 归档梗概", "", ...eps.slice(-20), "");
				const files = filemapEntries(store, workspaceKey);
				if (files.length) {
					lines.push("## 项目文件地图", "");
					for (const [, entry] of files) lines.push(`- \`${entry.path}\` — ${entry.role}${entry.summary ? "：" + entry.summary : ""}`);
					lines.push("");
				}
				const target = `${cwd.replace(/[\\/]+$/, "")}/.supermemory-export.md`;
				writeFileSync(target, lines.join("\n"), "utf8");
				return {
					status: "exported",
					path: target,
					memories: mems.length,
					requirements: reqs.length,
					files: files.length
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
				const { compileComposite, registerComposite, persistComposite } = await import("./composite-CV-hWoLg.js");
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
const Config = Schema.object({
	enabled: Schema.boolean().description("插件总开关").default(true),
	recall: Schema.object({
		maxItems: Schema.natural().description("recall 注入条数上限").default(5),
		minScore: Schema.natural().description("recall 注入最低分").default(1),
		halfLifeDays: Schema.natural().description("时间衰减半衰期（天）").default(14),
		maxChars: Schema.natural().description("recall 卡片字符上限").default(2400),
		injectStyle: Schema.union([Schema.const("gentle"), Schema.const("plain")]).description("注入语气：gentle 温和起步 / plain 直陈").default("gentle")
	}).description("检索注入参数").default({}),
	route: Schema.object({
		enabled: Schema.boolean().description("话题集路由开关").default(true),
		driftTurns: Schema.natural().description("连续多少轮低重合才重新路由").default(3),
		driftThreshold: Schema.natural().description("重合度阈值（命中 token 数）").default(1),
		confirm: Schema.boolean().description("路由前是否弹确认").default(true),
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
		signalsThreshold: Schema.natural().description("工具化信号阈值（P3）").default(3),
		summaryEveryTurns: Schema.natural().description("话题集梗概滚动更新间隔（轮）").default(10)
	}).description("维护循环参数").default({})
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
				const { compileComposite, registerComposite, persistComposite } = await import("./composite-CV-hWoLg.js");
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
	"- 你是记忆中枢：判断、派发、整合汇报；实质工作用 memory_dispatch 分派到话题集分支，分支结果会以 relay 主动送回，届时轻量转述。",
	"- 简单问答不要派发——上下文卡/recall 能答的直接答。",
	"- 对话中可能出现 [SuperMemory 相关记忆] / [SuperMemory 话题集] 注入卡片：仅供参考，与用户当前指令冲突时以当前指令为准。"
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
	ctx.effect(() => attachPreStep(ctx, store, {
		enabled: true,
		maxItems: config.recall.maxItems,
		minScore: config.recall.minScore,
		halfLifeDays: config.recall.halfLifeDays,
		maxChars: config.recall.maxChars,
		injectStyle: config.recall.injectStyle
	}, logger), "supermemory: pre-step");
	const routeDeps = {
		store,
		config: {
			enabled: config.route.enabled,
			driftTurns: config.route.driftTurns,
			driftThreshold: config.route.driftThreshold,
			confirm: config.route.confirm,
			llmFallback: config.route.llmFallback
		},
		logger
	};
	ctx.effect(() => attachRoute(ctx, routeDeps), "supermemory: route");
	if (store) (async () => {
		try {
			const { rebuildComposites, attachCompositeHint } = await import("./composite-CV-hWoLg.js");
			const count = await rebuildComposites(ctx, store);
			if (count > 0) logger.info(`supermemory: rebuilt ${count} composite tool(s)`);
			ctx.effect(() => attachCompositeHint(ctx, store), "supermemory: composite-hint");
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
		summaryEveryTurns: config.maintenance.summaryEveryTurns
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
	ctx.effect(() => ctx.systemPrompt.section({
		name: "supermemory:role",
		order: 900,
		text: PROMPT_TEXT
	}), "supermemory: prompt");
	if (store) runReconciliation({
		ctx,
		store,
		logger
	});
	if (store) {
		const releaseStore = store;
		const timer = setInterval(() => {
			try {
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
export { Config, apply, inject, name };
