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
			path: z.string(),
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
			examples: z.array(z.string()).default([]),
			proposedAt: z.number().int().optional(),
			proposalStatus: z.enum([
				"pending",
				"accepted",
				"declined"
			]).optional(),
			sequence: z.array(z.string()).default([]),
			samples: z.array(z.string()).default([])
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
				"failed",
				"interrupted"
			]).default("queued"),
			lastActivityAt: z.number().int().optional(),
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
		filemap: table("filemap"),
		toolMemory: table("tool_memory"),
		signals: table("signals"),
		routing: table("routing"),
		hotcache: table("hotcache"),
		dispatches: table("dispatches"),
		outbox: table("outbox"),
		close: () => domain.close()
	};
}
export { __exportAll as a, loadHostModule as i, openStore as n, workspaceKeyOf as r, newId as t };
