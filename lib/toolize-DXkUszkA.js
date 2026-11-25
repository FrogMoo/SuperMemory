import { E as syncCapabilitySkill, S as retireShellUnits, T as setCapabilityEnabled, g as highConfidenceEntryDraft, h as expireProposals, o as capabilityRows, s as capabilitySkillName, u as createProposal, w as saveCapabilityRecord } from "./capability-D5JJ1r3a.js";
import { _ as resolveSkillRoot, h as recordTaskObservation, i as archiveShellSkills, l as draftSkillFromTaskSignal, p as parseTaskSamples, u as extractWorkflowFacts, v as signalSessionCount, x as taskSignalKey } from "./skill-forge-BnMEUOcU.js";
// src/toolize.ts
const GENERIC_TOOL_NAMES = /* @__PURE__ */ new Set([
	"run_code",
	"bash",
	"read",
	"edit",
	"write",
	"glob",
	"grep",
	"todo_write",
	"present",
	"skill",
	"read_image",
	"working_directory",
	"wait_agent",
	"send_message",
	"list_agents",
	"subagent",
	"subagent_fork",
	"ask_user_question",
	"web_search",
	"web_fetch",
	"schedule_create",
	"schedule_edit",
	"schedule_list",
	"schedule_view",
	"job_list",
	"job_output",
	"job_kill",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource"
]);
const GENERIC_TOOL_PREFIXES = [
	"memory_",
	"sm_cap_",
	"job_",
	"schedule_",
	"session_",
	"cordis_",
	"plugin_"
];
function isGenericToolName(name) {
	const tool = String(name ?? "").trim();
	if (!tool) return true;
	if (GENERIC_TOOL_NAMES.has(tool)) return true;
	return GENERIC_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix));
}
function proposalVerdict(tools) {
	const steps = tools.map((tool) => String(tool ?? "").trim()).filter(Boolean);
	if (steps.length < 2) return {
		valuable: false,
		reason: "步数不足（至少 2 步）"
	};
	if (new Set(steps).size < 2) return {
		valuable: false,
		reason: "同一工具重复不构成流程"
	};
	const generic = steps.find((tool) => isGenericToolName(tool));
	if (generic) return {
		valuable: false,
		reason: "宽泛工具序列：" + generic + " 是通用工具，没有业务对象/命令/文件/入口"
	};
	return {
		valuable: true,
		reason: "ok"
	};
}
function dispatchOf(store, sessionId) {
	if (!sessionId) return void 0;
	const table = store.dispatches;
	if (!table || typeof table.entries !== "function") return void 0;
	try {
		for (const [id, row] of table.entries()) {
			if (row?.branchSessionId !== sessionId) continue;
			return {
				id,
				task: String(row.task ?? ""),
				...row.topicSetId ? { topicSetId: row.topicSetId } : {}
			};
		}
	} catch {}
}
function factsOf(samples) {
	const facts = extractWorkflowFacts(samples);
	const verify = facts.commands.filter((command) => /typecheck|build|smoke|test|lint|check/i.test(command));
	return {
		commands: facts.commands,
		files: facts.files,
		...verify.length > 0 ? { verify } : {},
		pitfalls: facts.patterns.slice(0, 5)
	};
}
/**
* Write/refresh the pending knowledge proposal for one crossed TASK signature.
* If a capability with the same taskKey already exists, refresh its facts
* instead (facts-block merge; human prose is preserved by skill-forge).
*/
async function proposeTaskCapability(store, workspaceKey, signatureKey, options = { threshold: 3 }) {
	if (!workspaceKey || workspaceKey === "unknown") return {
		status: "skipped",
		message: "没有工作区事实，不生成提案。"
	};
	const signalKey = taskSignalKey(workspaceKey, signatureKey);
	const signal = store.signals.get(signalKey);
	if (!signal) return {
		status: "skipped",
		message: "任务信号不存在。"
	};
	const samples = parseTaskSamples(signal.samples ?? []);
	const sessions = signalSessionCount(signal, samples);
	const draft = draftSkillFromTaskSignal(signal, samples, { sessions });
	if (!draft) return {
		status: "skipped",
		message: "任务样本不足，不生成提案。"
	};
	const now = options.now ?? Date.now();
	const facts = factsOf(samples);
	const existing = capabilityRows(store).find((entry) => entry.record.kind !== "proposal" && entry.record.taskKey === signatureKey && (!entry.row.workspaceKey || entry.row.workspaceKey === workspaceKey));
	if (existing) {
		const next = {
			...existing.record,
			description: draft.description,
			facts,
			version: existing.record.version + 1,
			updatedAt: now,
			changelog: ["重复任务有新样本：刷新能力事实块（正文散文保留）", ...existing.record.changelog].slice(0, 20)
		};
		await saveCapabilityRecord(store, next, {
			id: existing.id,
			workspaceKey: existing.row.workspaceKey,
			createdAt: existing.row.createdAt
		});
		let root = options.root;
		if (!root) try {
			root = resolveSkillRoot(workspaceKey).root;
		} catch {
			root = void 0;
		}
		if (root) {
			const updated = capabilityRows(store).find((entry) => entry.id === existing.id);
			if (updated) try {
				await syncCapabilitySkill(store, updated, root, {
					now,
					changelog: "重复任务有新样本：刷新事实块"
				});
			} catch {}
		}
		return {
			status: "refreshed",
			name: existing.record.name,
			message: "已有能力，已刷新事实块。"
		};
	}
	const entryDraft = highConfidenceEntryDraft(samples, {
		scope: workspaceKey,
		workspaceRoot: workspaceKey
	});
	const result = await createProposal(store, {
		workspaceKey,
		name: capabilitySkillName(draft.name).replace(/^sm-/, ""),
		title: draft.title,
		description: draft.description,
		body: draft.body,
		facts,
		taskKey: signatureKey,
		...entryDraft.status === "ok" ? {
			scope: workspaceKey,
			entryDraft: entryDraft.entry,
			dryRunArg: entryDraft.dryRunArg,
			writeConfirm: entryDraft.writeConfirm
		} : {},
		source: "auto",
		now
	});
	return {
		status: result.status === "created" ? "created" : result.status === "updated" ? "updated" : "unchanged",
		...result.name ? { name: result.name } : {},
		message: result.message
	};
}
/**
* Durable per-turn recording (R50): one TASK observation per turn, no sliding
* tool-sequence windows, no registration. config.enabled is accepted for
* compatibility and ignored.
*/
async function recordTurnSequences(ctx, store, workspaceKey, tools, args, config, logger, _deps, context = {}) {
	if (tools.length < 2) return void 0;
	if (!config.autoSkill) return void 0;
	try {
		const dispatch = dispatchOf(store, context.sessionId);
		const task = [dispatch?.task, context.task].filter((part) => typeof part === "string" && part.trim().length > 0).join("\n").trim();
		if (!task) return void 0;
		const ok = Array.isArray(context.successes) && context.successes.length === tools.length ? context.successes.every(Boolean) : void 0;
		const observation = await recordTaskObservation(store, workspaceKey, {
			tools,
			args,
			task,
			...context.sessionId ? { sessionId: context.sessionId } : {},
			...context.dispatchId ?? dispatch?.id ? { dispatchId: context.dispatchId ?? dispatch?.id } : {},
			...context.topicSetId ?? dispatch?.topicSetId ? { topicSetId: context.topicSetId ?? dispatch?.topicSetId } : {},
			...context.now !== void 0 ? { at: context.now } : {},
			...ok !== void 0 ? { ok } : {}
		}, {
			threshold: config.threshold,
			...config.skillMinSessions !== void 0 ? { minSessions: config.skillMinSessions } : {},
			...context.now !== void 0 ? { now: context.now } : {}
		});
		if (!observation) return void 0;
		const report = {
			signature: observation.key,
			count: observation.count,
			sessions: observation.sessions,
			crossed: observation.crossed
		};
		if (!observation.crossed) return report;
		const written = await proposeTaskCapability(store, workspaceKey, observation.key, {
			threshold: config.threshold,
			...config.skillMinSessions !== void 0 ? { minSessions: config.skillMinSessions } : {},
			...config.skillRecencyDays !== void 0 ? { recencyDays: config.skillRecencyDays } : {},
			...context.now !== void 0 ? { now: context.now } : {}
		});
		if (written.status !== "unchanged" && written.status !== "skipped") logger.info("supermemory: task proposal " + (written.name ?? observation.key) + " " + written.status);
		return report;
	} catch (error) {
		logger.warn("supermemory: task proposal recording failed: " + String(error).slice(0, 160));
		return;
	}
}
/** Boot sweep: durable task signals that already crossed become pending proposals. */
async function sweepTaskProposals(store, config, logger) {
	if (!config.autoSkill) return 0;
	const threshold = Math.max(1, config.threshold);
	let created = 0;
	for (const [key, signal] of [...store.signals.entries()]) {
		if (!signal.pattern.startsWith("task:")) continue;
		if (signal.count < threshold) continue;
		if ((signal.sessions ?? []).length < Math.max(1, config.skillMinSessions ?? 2)) continue;
		if (!signal.workspaceKey || signal.workspaceKey === "unknown") continue;
		const signatureKey = signal.pattern.slice(5);
		try {
			const result = await proposeTaskCapability(store, signal.workspaceKey, signatureKey, {
				threshold,
				...config.skillMinSessions !== void 0 ? { minSessions: config.skillMinSessions } : {},
				...config.skillRecencyDays !== void 0 ? { recencyDays: config.skillRecencyDays } : {}
			});
			if (result.status === "created" || result.status === "updated") created += 1;
		} catch (error) {
			logger.warn("supermemory: task proposal sweep failed for " + key + ": " + String(error).slice(0, 160));
		}
	}
	if (created > 0) logger.info("supermemory: task proposal sweep created " + created + " proposal(s)");
	return created;
}
function sequenceOf(signal, key) {
	if (Array.isArray(signal.sequence) && signal.sequence.length > 0) return signal.sequence.map((tool) => String(tool));
	const match = /\/seq\/([^/]+)$/.exec(key);
	return match ? match[1].split(">").filter(Boolean) : [];
}
function isSequenceSignal(key) {
	return /\/seq\//.test(key);
}
/** Clear legacy tool-sequence signals (idempotent; no tool is created). */
async function clearSequenceSignals(store, options = {}) {
	const dryRun = Boolean(options.dryRun);
	let pendingBefore = 0;
	for (const [, signal] of store.signals.entries()) if (signal.proposalStatus === "pending") pendingBefore += 1;
	let clearedProposals = 0;
	let prunedSignals = 0;
	for (const [key, signal] of [...store.signals.entries()]) {
		if (!isSequenceSignal(key)) continue;
		const pending = signal.proposalStatus === "pending";
		if (!!proposalVerdict(sequenceOf(signal, key)).valuable && !(pending && options.dropAllPending === true)) continue;
		if (!dryRun) try {
			await store.signals.delete(key);
		} catch {
			continue;
		}
		if (pending) clearedProposals += 1;
		else prunedSignals += 1;
	}
	let pendingAfter = 0;
	for (const [, signal] of store.signals.entries()) if (signal.proposalStatus === "pending") pendingAfter += 1;
	return {
		pendingBefore,
		clearedProposals,
		prunedSignals,
		pendingAfter,
		dryRun
	};
}
/** Every ACTIVE legacy sequence row (kind=composite/workflow, no capability entry). */
function legacySequenceRows(store) {
	const out = [];
	for (const [id, row] of store.toolMemory.entries()) {
		if (row.kind !== "composite" && row.kind !== "workflow") continue;
		if (row.status !== "active") continue;
		let raw;
		try {
			raw = JSON.parse(row.entry);
		} catch {
			continue;
		}
		if (!raw || raw.kind === "capability" || raw.schema === "sm.capability/1") continue;
		const steps = Array.isArray(raw.steps) ? raw.steps.map((step) => String(step.tool ?? "")).filter(Boolean) : [];
		out.push({
			id,
			name: String(raw.name ?? id),
			steps,
			reason: "历史工具序列行：R50 已删除组合工具机制，仅保留退役记录"
		});
	}
	return out;
}
/** Retire every legacy sequence row (idempotent). */
async function retireLegacySequenceRows(store, logger, options = {}) {
	const candidates = legacySequenceRows(store);
	if (options.dryRun) return candidates;
	const retired = [];
	for (const item of candidates) try {
		await store.toolMemory.update(item.id, (row) => ({
			...row,
			status: "retired"
		}));
		retired.push(item);
		logger?.info("supermemory: retired legacy sequence row " + item.name);
	} catch {}
	return retired;
}
/** Decline every pending proposal (idempotent; never deletes the audit row). */
async function clearPendingProposals(store, options = {}) {
	const pending = capabilityRows(store).filter((entry) => entry.record.kind === "proposal" && entry.record.proposalStatus === "pending");
	if (options.dryRun) return {
		before: pending.length,
		cleared: pending.length
	};
	let cleared = 0;
	for (const entry of pending) {
		const next = {
			...entry.record,
			proposalStatus: "declined",
			updatedAt: Date.now(),
			changelog: ["清理：待处理提案已清空", ...entry.record.changelog].slice(0, 20)
		};
		try {
			await saveCapabilityRecord(store, next, {
				id: entry.id,
				workspaceKey: entry.row.workspaceKey,
				createdAt: entry.row.createdAt
			});
			cleared += 1;
		} catch {}
	}
	return {
		before: pending.length,
		cleared
	};
}
/** One idempotent cleanup pass (boot + memory_toolize cleanup). */
async function cleanupToolize(options) {
	const now = options.now ?? Date.now();
	const dryRun = Boolean(options.dryRun);
	const dropPending = options.dropPending !== false;
	const expiredProposals = dryRun ? 0 : await expireProposals(options.store, now);
	const retired = await retireLegacySequenceRows(options.store, options.logger, { dryRun });
	const proposals = dropPending ? await clearPendingProposals(options.store, { dryRun }) : {
		before: capabilityRows(options.store).filter((entry) => entry.record.kind === "proposal" && entry.record.proposalStatus === "pending").length,
		cleared: 0
	};
	const signals = await clearSequenceSignals(options.store, {
		dropAllPending: dropPending,
		dryRun
	});
	let archived = [];
	let archiveRoots = [];
	let scannedSkills = 0;
	if (options.roots !== void 0 && options.roots.length > 0) {
		const result = await archiveShellSkills({
			roots: options.roots,
			store: options.store,
			now,
			dryRun
		});
		archived = result.archived;
		archiveRoots = result.roots;
		scannedSkills = result.totalScanned;
	}
	const shellUnits = await retireShellUnits(options.store, { dryRun });
	return {
		retired,
		retiredCount: retired.length,
		clearedProposals: Math.max(proposals.cleared, signals.clearedProposals),
		prunedSignals: signals.prunedSignals,
		pendingBefore: Math.max(proposals.before, signals.pendingBefore),
		pendingAfter: signals.pendingAfter,
		archived,
		archiveRoots,
		archivedCount: archived.length,
		scannedSkills,
		expiredProposals,
		retiredShellUnits: shellUnits.length,
		retiredShellNames: shellUnits.map((item) => item.name),
		dryRun
	};
}
/** Idle capability recycle (default OFF via recycleIdleDays 0). */
let lastRecycleAt = 0;
async function recycleIdleCapabilities(ctx, store, config, logger, now = Date.now()) {
	if (config.recycleIdleDays <= 0) return 0;
	if (now - lastRecycleAt < 36e5) return 0;
	lastRecycleAt = now;
	let retired = 0;
	for (const entry of capabilityRows(store)) {
		if (entry.record.kind !== "capability" || entry.record.loadCount > 0 || entry.record.runCount > 0) continue;
		if (now - entry.record.updatedAt < config.recycleIdleDays * 864e5) continue;
		try {
			await setCapabilityEnabled(ctx, store, entry.id, false);
			retired += 1;
			logger.info("supermemory: recycled idle capability " + entry.record.name);
		} catch {}
	}
	return retired;
}
export { cleanupToolize, recordTurnSequences, recycleIdleCapabilities, sweepTaskProposals };
