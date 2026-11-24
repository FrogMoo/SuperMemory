import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
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
	const topicsets = z.object({
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
		shapeFingerprint: z.string().default(""),
		shapeGeneratedAt: z.number().int().default(0),
		createdAt: z.number().int(),
		updatedAt: z.number().int(),
		lastActiveAt: z.number().int().default(0)
	});
	const memories = z.object({
		workspaceKey: z.string(),
		title: z.string().default(""),
		text: z.string(),
		key: z.string().optional(),
		keywords: z.array(z.string()).default([]),
		collectionId: z.string().optional(),
		sourceSessionId: z.string(),
		sourceSeq: z.number().int().nonnegative(),
		status: z.enum(["active", "superseded"]).default("active"),
		supersededBy: z.string().optional(),
		version: z.number().int().default(1),
		createdAt: z.number().int(),
		updatedAt: z.number().int()
	});
	const memoryCollections = z.object({
		workspaceKey: z.string(),
		title: z.string(),
		keywords: z.array(z.string()).default([]),
		summary: z.string().default(""),
		status: z.enum(["active", "archived"]).default("active"),
		createdAt: z.number().int(),
		updatedAt: z.number().int()
	});
	const memoryVersions = z.object({
		workspaceKey: z.string(),
		memoryId: z.string(),
		version: z.number().int(),
		title: z.string().default(""),
		text: z.string(),
		/** 该版本的标签（与 memories.keywords 同语义，历史行用 tags 命名）。 */
		tags: z.array(z.string()).default([]),
		collectionId: z.string().optional(),
		/** 该版本生效的时间（创建/更新时刻；迁移行沿用记忆自身的 updatedAt）。 */
		updatedAt: z.number().int(),
		/** create=新建 v1；update=就地更新升版；migrate=旧记忆惰性迁移补的 v1。 */
		changeType: z.enum([
			"create",
			"update",
			"migrate"
		])
	});
	const hubPolicies = z.object({
		workspaceKey: z.string(),
		tools: z.array(z.string()).default([]),
		prefixes: z.array(z.string()).default([]),
		updatedAt: z.number().int()
	});
	const modelDefaults = z.object({
		workspaceKey: z.string(),
		/** 新建中枢会话的默认模型；缺省=跟随宿主默认。 */
		hub: z.object({
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string().optional()
		}).optional(),
		/** 新派发分支会话的默认模型；缺省=跟随话题集/中枢/宿主默认。 */
		branch: z.object({
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string().optional()
		}).optional(),
		updatedAt: z.number().int()
	});
	const episodes = z.object({
		topicSetId: z.string().optional(),
		branchSessionId: z.string().optional(),
		timeStart: z.number().int(),
		timeEnd: z.number().int(),
		/** Short form for recall cards / topic-shape fingerprints / exports. */
		summary: z.string().default(""),
		/**
		* The branch's FULL final answer. `summary` is deliberately short (recall
		* cards, topic-shape fingerprints and exports read it), but the hub-facing
		* relay must carry the whole result: clipping it there silently destroyed
		* most of a branch's work. Episodes written before this field read as ''
		* and fall back to `summary` (the domain stays v1).
		*/
		result: z.string().default(""),
		decisions: z.array(z.string()).default([]),
		files: z.array(z.string()).default([]),
		nextSteps: z.array(z.string()).default([]),
		reqIds: z.array(z.string()).default([]),
		sourceSessionId: z.string(),
		sourceSeqStart: z.number().int().nonnegative(),
		sourceSeqEnd: z.number().int().nonnegative()
	});
	const requirements = z.object({
		topicSetId: z.string().optional(),
		workspaceKey: z.string(),
		text: z.string(),
		constraints: z.array(z.string()).default([]),
		status: z.enum(["open", "closed"]).default("open"),
		sourceSessionId: z.string(),
		sourceSeq: z.number().int().nonnegative(),
		createdAt: z.number().int(),
		closedAt: z.number().int().optional()
	});
	const filemap = z.object({
		workspaceKey: z.string(),
		path: z.string(),
		role: z.string().default(""),
		summary: z.string().default(""),
		keywords: z.array(z.string()).default([]),
		hash: z.string().optional(),
		mtime: z.number().int().optional(),
		annotatedAt: z.number().int()
	});
	const toolMemory = z.object({
		workspaceKey: z.string().optional(),
		createdAt: z.number().int().optional(),
		kind: z.enum([
			"composite",
			"skill",
			"workflow"
		]).default("composite"),
		title: z.string().default(""),
		tags: z.array(z.string()).default([]),
		trigger: z.string().default(""),
		description: z.string().default(""),
		entry: z.string().default(""),
		useCount: z.number().int().nonnegative().default(0),
		status: z.enum(["active", "retired"]).default("active")
	});
	const signals = z.object({
		workspaceKey: z.string(),
		pattern: z.string(),
		count: z.number().int().nonnegative().default(0),
		lastSeen: z.number().int(),
		examples: z.array(z.string()).default([]),
		proposedAt: z.number().int().optional(),
		proposalStatus: z.enum([
			"pending",
			"accepted",
			"declined"
		]).optional(),
		sequence: z.array(z.string()).default([]),
		samples: z.array(z.string()).default([])
	});
	const dispatches = z.object({
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
			"failed",
			"interrupted"
		]).default("queued"),
		lastActivityAt: z.number().int().optional(),
		title: z.string().default(""),
		tags: z.array(z.string()).default([]),
		capability: z.string().default(""),
		resumeOf: z.string().optional(),
		resumedBy: z.string().optional(),
		createdAt: z.number().int(),
		updatedAt: z.number().int()
	});
	const questions = z.object({
		dispatchId: z.string().optional(),
		groupId: z.string().optional(),
		topicSetId: z.string().optional(),
		branchSessionId: z.string(),
		hubSessionId: z.string().optional(),
		/** The dispatched task label, so a hub aggregate is readable without a join. */
		branchTask: z.string().default(""),
		title: z.string(),
		question: z.string(),
		options: z.array(z.string()).default([]),
		severity: z.enum([
			"low",
			"medium",
			"high"
		]).default("medium"),
		/** false = the branch keeps working under its best interpretation. */
		blocking: z.boolean().default(false),
		/** What the branch already finished (required for blocking=true by contract). */
		progress: z.string().default(""),
		/** The branch's default fallback if the user never answers. */
		defaultPlan: z.string().default(""),
		status: z.enum(["open", "resolved"]).default("open"),
		/** The user's answer, filled by the hub's memory_questions resolve step. */
		answer: z.string().optional(),
		createdAt: z.number().int(),
		updatedAt: z.number().int()
	});
	const outbox = z.object({
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
		relayedAt: z.number().int().optional(),
		fromSessionId: z.string().optional(),
		fromTitle: z.string().optional(),
		fromKind: z.enum([
			"hub",
			"branch",
			"group",
			"system"
		]).optional(),
		task: z.string().default(""),
		topicSetTitle: z.string().default(""),
		capability: z.string().default("")
	});
	const hubSessions = z.object({
		workspaceKey: z.string(),
		sessionId: z.string(),
		title: z.string().default(""),
		/** How the hub was marked (audit only; resolution trusts every source). */
		source: z.enum([
			"panel",
			"topicset-root",
			"dispatch",
			"migration",
			"title-migration"
		]).default("panel"),
		createdAt: z.number().int(),
		updatedAt: z.number().int()
	});
	return {
		topicsets,
		memories,
		memory_collections: memoryCollections,
		memory_versions: memoryVersions,
		episodes,
		requirements,
		filemap,
		tool_memory: toolMemory,
		signals,
		dispatches,
		questions,
		outbox,
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
		}),
		meta: z.object({
			titlesMigratedAt: z.number().int().optional(),
			titlesMigrationVersion: z.number().int().optional(),
			mergesVersion: z.number().int().optional(),
			mergeSignatures: z.array(z.string()).optional(),
			lastMergeAt: z.number().int().optional(),
			organizeVersion: z.number().int().optional(),
			organizeAppliedAt: z.number().int().optional(),
			organizeWorkspace: z.string().optional(),
			organizeBackup: z.string().optional(),
			organizeSummary: z.string().optional(),
			hubTitlesMigrationVersion: z.number().int().optional(),
			hubTitlesMigratedAt: z.number().int().optional(),
			hubRecordsMigrationVersion: z.number().int().optional(),
			hubRecordsMigratedAt: z.number().int().optional(),
			roleGuardInstalledAt: z.number().int().optional(),
			roleGuardFailedAt: z.number().int().optional(),
			roleGuardVersion: z.number().int().optional(),
			roleGuardError: z.string().optional()
		}),
		hub_sessions: hubSessions,
		hub_policies: hubPolicies,
		model_defaults: modelDefaults
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
/** Backoff used while a disposing instance still owns the domain (plugin reload race). */
const STORE_OPEN_RETRY_MS = Object.freeze([
	100,
	250,
	750,
	2e3
]);
/**
* Retry an async open while the domain name is still reserved by an instance
* that is unloading.
*
* `storageDomain.open()` rejects `already-open` when the name is reserved by
* an in-flight or completed open, and a plugin reload can start the new fiber
* before the old fiber's domain disposer ran. Only that code is retried; every
* other failure (version mismatch, malformed medium, backend route, …) is the
* caller's to degrade on, immediately.
*/
async function retryDomainOpen(open, logger, delays = STORE_OPEN_RETRY_MS) {
	for (let attempt = 0;; attempt += 1) try {
		return await open();
	} catch (error) {
		if (error?.code !== "already-open" || attempt >= delays.length) throw error;
		logger.warn(`supermemory: storage domain still owned by a disposing instance; retrying in ${delays[attempt]}ms`);
		await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
	}
}
/** Open the storage domain, riding out a reload's domain-handover window. */
async function openStoreWithRetry(storageDomain, logger) {
	return retryDomainOpen(() => openStore(storageDomain, logger), logger);
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
			memory_collections: sd.domainTable(schemas.memory_collections),
			memory_versions: sd.domainTable(schemas.memory_versions),
			episodes: sd.domainTable(schemas.episodes),
			requirements: sd.domainTable(schemas.requirements),
			filemap: sd.domainTable(schemas.filemap),
			tool_memory: sd.domainTable(schemas.tool_memory),
			signals: sd.domainTable(schemas.signals),
			dispatches: sd.domainTable(schemas.dispatches),
			questions: sd.domainTable(schemas.questions),
			outbox: sd.domainTable(schemas.outbox),
			routing: sd.domainTable(schemas.routing),
			hotcache: sd.domainTable(schemas.hotcache),
			meta: sd.domainTable(schemas.meta),
			hub_sessions: sd.domainTable(schemas.hub_sessions),
			hub_policies: sd.domainTable(schemas.hub_policies),
			model_defaults: sd.domainTable(schemas.model_defaults)
		}
	});
	const domain = await storageDomain.open(spec);
	logger.info("supermemory: storage domain opened");
	const table = (name) => domain.table(name);
	return {
		domain,
		topicsets: table("topicsets"),
		memories: table("memories"),
		memoryCollections: table("memory_collections"),
		memoryVersions: table("memory_versions"),
		episodes: table("episodes"),
		requirements: table("requirements"),
		filemap: table("filemap"),
		toolMemory: table("tool_memory"),
		signals: table("signals"),
		routing: table("routing"),
		hotcache: table("hotcache"),
		dispatches: table("dispatches"),
		questions: table("questions"),
		outbox: table("outbox"),
		meta: table("meta"),
		hubs: table("hub_sessions"),
		hubPolicies: table("hub_policies"),
		modelDefaults: table("model_defaults"),
		close: () => domain.close()
	};
}
export { __exportAll as a, loadHostModule as i, openStoreWithRetry as n, workspaceKeyOf as r, newId as t };
