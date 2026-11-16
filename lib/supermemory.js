import { createRequire } from "node:module";
import Schema from "@deepseek-ai/schemastery";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// src/commands.ts
/** Attach the /memory command; returns the effect disposer. */
function attachCommands(ctx, deps) {
	return ctx.commands.register({
		name: "memory",
		description: "SuperMemory 记忆总览：/memory status 查看记忆库状态",
		handler: async (invocation) => {
			const sub = (invocation.rawInput ?? "").trim().split(/\s+/)[0] ?? "";
			if (sub === "" || sub === "status") {
				const store = deps.store;
				if (!store) return {
					kind: "error",
					text: "SuperMemory 存储域未打开，记忆功能不可用。"
				};
				const cwd = invocation.agent?.session?.header?.cwd;
				const workspaceKey = deps.workspaceKeyOfCwd(cwd);
				let memories = 0;
				let ownMemories = 0;
				let episodes = 0;
				let requirements = 0;
				let signals = 0;
				let cursor = "无";
				for (const [, record] of store.memories.entries()) {
					memories++;
					if (record.workspaceKey === workspaceKey && record.status === "active") ownMemories++;
				}
				episodes = store.episodes.size;
				for (const [, record] of store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open") requirements++;
				for (const [, record] of store.signals.entries()) if (record.workspaceKey === workspaceKey) signals++;
				const hot = store.hotcache.get(String(invocation.agent?.id ?? ""));
				if (hot?.lastMaintainedSeq !== void 0) cursor = String(hot.lastMaintainedSeq);
				return {
					kind: "success",
					text: [
						"SuperMemory 状态",
						`- 工作区：${workspaceKey}`,
						`- 事实记忆：${ownMemories} 条（全库 ${memories} 条）`,
						`- 归档梗概：${episodes} 条`,
						`- 未完成需求：${requirements} 条`,
						`- 重复模式信号：${signals} 个`,
						`- 本会话维护游标：${cursor}`
					].join("\n")
				};
			}
			if (sub === "help") return {
				kind: "success",
				text: "SuperMemory 命令：/memory status（状态总览）。话题集路由与派发命令（topicsets/switch/new/reqs/scan/export/wrap）在 P1 提供。"
			};
			return {
				kind: "error",
				text: `未知子命令 /memory ${sub}；P0 仅支持 /memory status 与 /memory help。`
			};
		}
	});
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
// src/host.ts
/**
* Host-anchored module loading.
*
* `@deepseek-ai/dsh-*` packages are NOT resolvable from a plugin's own package
* scope (the profile's node_modules only hoists non-dsh runtime deps). The
* proven third-party pattern (dsh-vscode-mode) resolves the specifier against
* the running DSH entry (`process.argv[1]`) and imports the resolved file URL,
* which lands on the host's bundled copy. Import failures after successful
* resolution are preserved, not hidden by an older copy.
* @module supermemory/host
*/
const cache = /* @__PURE__ */ new Map();
/**
* Import a host package, preferring the copy the running DSH entry resolves.
* @param specifier - host package name, e.g. `@deepseek-ai/dsh-tools`.
* @returns the evaluated module namespace (cached per specifier).
*/
async function loadHostModule(specifier) {
	let pending = cache.get(specifier);
	if (!pending) {
		pending = (async () => {
			const anchor = process.argv[1];
			let resolved;
			if (anchor) try {
				resolved = createRequire(anchor).resolve(specifier);
			} catch {}
			return resolved ? import(pathToFileURL(resolved).href) : import(specifier);
		})();
		cache.set(specifier, pending);
	}
	return pending;
}
// src/schema.ts
let zodPending;
/** The host's zod module (v4), shared with the storage-domain layer. */
function getZod() {
	return zodPending ??= loadHostModule("zod");
}
/** Builds every table schema of the domain. Called once, inside apply(). */
async function buildSchemas() {
	const z = await getZod();
	const member = z.object({
		sessionId: z.string(),
		kind: z.enum(["root", "fork"]).default("root"),
		title: z.string().default(""),
		summary: z.string().default(""),
		status: z.enum(["live", "idle"]).default("live"),
		model: z.string().optional(),
		modelOverridden: z.boolean().default(false),
		lastActiveAt: z.number().int().default(0)
	});
	return {
		topicsets: z.object({
			workspaceKey: z.string(),
			title: z.string(),
			summary: z.string().default(""),
			keywords: z.array(z.string()).default([]),
			status: z.enum(["active", "archived"]).default("active"),
			defaultModel: z.object({
				provider: z.string(),
				model: z.string(),
				reasoningEffort: z.string().optional()
			}).optional(),
			members: z.array(member).default([]),
			createdAt: z.number().int(),
			updatedAt: z.number().int(),
			lastActiveAt: z.number().int().default(0)
		}),
		memories: z.object({
			workspaceKey: z.string(),
			text: z.string(),
			key: z.string().optional(),
			keywords: z.array(z.string()).default([]),
			sourceSessionId: z.string(),
			sourceSeq: z.number().int().nonnegative(),
			status: z.enum(["active", "superseded"]).default("active"),
			supersededBy: z.string().optional(),
			createdAt: z.number().int(),
			updatedAt: z.number().int()
		}),
		episodes: z.object({
			topicSetId: z.string().optional(),
			branchSessionId: z.string().optional(),
			timeStart: z.number().int(),
			timeEnd: z.number().int(),
			summary: z.string().default(""),
			decisions: z.array(z.string()).default([]),
			files: z.array(z.string()).default([]),
			nextSteps: z.array(z.string()).default([]),
			reqIds: z.array(z.string()).default([]),
			sourceSessionId: z.string(),
			sourceSeqStart: z.number().int().nonnegative(),
			sourceSeqEnd: z.number().int().nonnegative()
		}),
		requirements: z.object({
			topicSetId: z.string().optional(),
			workspaceKey: z.string(),
			text: z.string(),
			constraints: z.array(z.string()).default([]),
			status: z.enum(["open", "closed"]).default("open"),
			sourceSessionId: z.string(),
			sourceSeq: z.number().int().nonnegative(),
			createdAt: z.number().int(),
			closedAt: z.number().int().optional()
		}),
		filemap: z.object({
			workspaceKey: z.string(),
			role: z.string().default(""),
			summary: z.string().default(""),
			keywords: z.array(z.string()).default([]),
			hash: z.string().optional(),
			mtime: z.number().int().optional(),
			annotatedAt: z.number().int()
		}),
		tool_memory: z.object({
			workspaceKey: z.string().optional(),
			kind: z.enum([
				"composite",
				"skill",
				"workflow"
			]).default("composite"),
			trigger: z.string().default(""),
			description: z.string().default(""),
			entry: z.string().default(""),
			useCount: z.number().int().nonnegative().default(0),
			status: z.enum(["active", "retired"]).default("active")
		}),
		signals: z.object({
			workspaceKey: z.string(),
			pattern: z.string(),
			count: z.number().int().nonnegative().default(0),
			lastSeen: z.number().int(),
			examples: z.array(z.string()).default([])
		}),
		dispatches: z.object({
			topicSetId: z.string().optional(),
			groupId: z.string().optional(),
			branchSessionId: z.string(),
			task: z.string(),
			hubSessionId: z.string(),
			startSeq: z.number().int().nonnegative(),
			turnEndReason: z.string().optional(),
			status: z.enum([
				"queued",
				"dispatched",
				"observed",
				"summarized",
				"delivered",
				"failed"
			]).default("queued"),
			createdAt: z.number().int(),
			updatedAt: z.number().int()
		}),
		outbox: z.object({
			dispatchId: z.string().optional(),
			groupId: z.string().optional(),
			kind: z.enum(["single", "group"]).default("single"),
			payload: z.string(),
			status: z.enum([
				"pending",
				"relayed",
				"confirmed",
				"failed"
			]).default("pending"),
			enqueuedAt: z.number().int(),
			relayedAt: z.number().int().optional()
		}),
		routing: z.object({
			activeTopicSetId: z.string().optional(),
			driftCount: z.number().int().nonnegative().default(0),
			updatedAt: z.number().int()
		}),
		hotcache: z.object({
			recentRelevant: z.object({
				episodes: z.array(z.string()).default([]),
				reqIds: z.array(z.string()).default([]),
				memoryIds: z.array(z.string()).default([]),
				toolNames: z.array(z.string()).default([])
			}).default({
				episodes: [],
				reqIds: [],
				memoryIds: [],
				toolNames: []
			}),
			lastMaintainedSeq: z.number().int().nonnegative().optional(),
			updatedAt: z.number().int()
		})
	};
}
// src/store.ts
/**
* Domain store: opens the `supermemory` storage domain and exposes typed table
* accessors plus workspace-key resolution.
* @module supermemory/store
*/
/**
* Canonical workspace key: the realpath of a session cwd (decision D4).
* Falls back to the resolved path when the directory vanished.
*/
function workspaceKeyOf(cwd) {
	if (!cwd) return "unknown";
	try {
		return realpathSync(resolve(cwd));
	} catch {
		return resolve(cwd);
	}
}
/** Monotonic-ish id helper (no host import needed). */
function newId(prefix) {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
* Open the storage domain. A failure is logged and rethrown — the caller
* decides whether to degrade (P0: degrade to a disabled store).
*/
async function openStore(storageDomain, logger) {
	const sd = await loadHostModule("@deepseek-ai/dsh-storage-domain");
	const schemas = await buildSchemas();
	const spec = sd.defineDomain({
		name: "supermemory",
		version: 1,
		tables: {
			topicsets: sd.domainTable(schemas.topicsets),
			memories: sd.domainTable(schemas.memories),
			episodes: sd.domainTable(schemas.episodes),
			requirements: sd.domainTable(schemas.requirements),
			filemap: sd.domainTable(schemas.filemap),
			tool_memory: sd.domainTable(schemas.tool_memory),
			signals: sd.domainTable(schemas.signals),
			dispatches: sd.domainTable(schemas.dispatches),
			outbox: sd.domainTable(schemas.outbox),
			routing: sd.domainTable(schemas.routing),
			hotcache: sd.domainTable(schemas.hotcache)
		}
	});
	const domain = await storageDomain.open(spec);
	logger.info("supermemory: storage domain opened");
	const table = (name) => domain.table(name);
	return {
		domain,
		topicsets: table("topicsets"),
		memories: table("memories"),
		episodes: table("episodes"),
		requirements: table("requirements"),
		signals: table("signals"),
		routing: table("routing"),
		hotcache: table("hotcache"),
		close: () => domain.close()
	};
}
// src/maintenance.ts
const BUFFER_CAP = 50;
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
		for (const user of users) for (const fact of extractFacts(user.text)) {
			const memoryId = await rememberFact(activeStore, workspaceKey, fact.text, fact.keywords, task.sessionId, user.seq, now);
			if (memoryId) {
				createdIds.push(memoryId);
				countSignal(activeStore, workspaceKey, fact.keywords[0] ?? fact.text.slice(0, 12), fact.text, now);
			}
		}
		buffers.set(task.sessionId, []);
		cursors.set(task.sessionId, task.seq);
		try {
			await persistCursor(task.sessionId, task.seq, createdIds);
		} catch (error) {
			throw error;
		}
		if (createdIds.length > 0) logger.info(`supermemory: +${createdIds.length} memories from ${task.sessionId}@${task.seq}`);
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
/** Write one fact, skipping exact duplicates within the workspace. */
async function rememberFact(store, workspaceKey, text, keywords, sourceSessionId, sourceSeq, now) {
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
		examples: [example]
	};
	store.signals.put(signalKey, signal).catch(() => {});
}
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
* Score one memory against a query.
* Score = matched-token weight sum × time decay; `minScore: 1` therefore means
* "at least one matched token". No length normalisation: a long memory is not
* penalised for being long, ranking is left to the matched-token count.
*/
function scoreMemory(memory, queryTokens, options) {
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
	if (raw <= 0) return 0;
	return raw * decay(memory.createdAt, options.now, options.halfLifeDays);
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
		const score = scoreMemory(memory, weights, options);
		if (score >= options.minScore) scored.push({
			memoryId,
			text: memory.text,
			score,
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
// src/tools.ts
/** Attach the P0 tools; returns the effect disposer. */
async function attachTools(ctx, store, config) {
	if (!store) return () => {};
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
		description: "检索 SuperMemory：事实记忆（memories）、归档梗概（episodes）与需求（requirements），按当前工作区隔离，关键词 + 时间衰减规则评分。回答“之前说过什么/做过什么”类问题前先用本工具检索。",
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
										"requirement"
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
			items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
			return {
				items: items.slice(0, options.limit),
				total: items.length
			};
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
	"systemPrompt"
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
	maintenance: Schema.object({
		enabled: Schema.boolean().description("维护循环开关").default(true),
		signalsThreshold: Schema.natural().description("工具化信号阈值（P3）").default(3)
	}).description("维护循环参数").default({})
}).description("SuperMemory 记忆插件配置").default({});
const PROMPT_TEXT = [
	"[SuperMemory 记忆]",
	"- 涉及历史结论、约定、构建命令、文件用途、\"之前说过/做过什么\"时，先调用 memory_recall 检索再作答。",
	"- 用户明确要求记住某事、或某事实值得跨会话保留时，调用 memory_remember 写入（按工作区隔离）。",
	"- 对话中可能出现 [SuperMemory 相关记忆] 注入卡片：仅供参考，与用户当前指令冲突时以当前指令为准。"
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
	try {
		const disposeTools = await attachTools(ctx, store, {
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
	ctx.effect(() => attachMaintenance(ctx, store, {
		enabled: config.maintenance.enabled,
		signalsThreshold: config.maintenance.signalsThreshold
	}, logger), "supermemory: maintenance");
	ctx.effect(() => attachCommands(ctx, {
		store,
		workspaceKeyOfCwd: workspaceKeyOf
	}), "supermemory: commands");
	ctx.effect(() => ctx.systemPrompt.section({
		name: "supermemory:role",
		order: 900,
		text: PROMPT_TEXT
	}), "supermemory: prompt");
	logger.info(`supermemory: active (store=${store ? "open" : "degraded"})`);
}
export { Config, apply, inject, name };
