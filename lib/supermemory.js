import { t as __exportAll } from "./rolldown-runtime-BJohB4LM.js";
import { a as dropNote, c as getRouting, d as rankMembers, f as setRouting, g as updateMember, h as touchTopicSet, i as clipWithNote, l as getTopicSet, m as topicSetIdsOf, n as clipAtBoundary, o as addMember, r as clipMarked, s as createTopicSet, t as charCount, u as listTopicSets, v as updateTopicSetSummary } from "./clip-DPi0qjxp.js";
import { A as attachRoute, C as runCapability, D as updateCapabilitySkillBody, F as backfillHubRecords, I as recordHubSession, L as resolveRole, M as fillTopicShapeOnCreate, N as noteTopicSetActivated, O as PLUGIN_REPO_ROOT, P as agentWorkspaceKey, R as injectionSource, T as setCapabilityEnabled, _ as isShellUnit, a as capabilityHealthOf, b as registerCapability, c as capabilityToolName, d as declineProposal, f as deleteCapability, i as capabilityBodyOf, j as renderCard, k as CAPABILITY_ROUTING_RULES, m as enableCapabilityEntryDraft, n as bumpCapabilityRun, o as capabilityRows, p as editCapability, r as capabilityAppliesToWorkspace, s as capabilitySkillName, t as acceptProposal, v as liveCapabilityToolNames, x as renderCapabilityIndex, y as readCapabilityRow } from "./capability-CerjsIyB.js";
import { _ as tagsOfBody, a as matchTopicSets, b as injectionTitle, c as recallMemories, d as MEMORY_TEXT_MAX, f as assessConclusion, g as renderRecordLine, h as normalizeTags, i as hubSelection, l as renderRecallCard, m as mergeTags, n as askDefaultModel, p as deriveTitle, r as enumerateModels, t as applyModelSelection, u as tokenize, v as extractFacts } from "./model-jCUTlaTL.js";
import { i as loadHostModule, n as openStoreWithRetry, r as workspaceKeyOf, t as newId } from "./store-Ch9VlqHm.js";
import { $ as readHostTitle, A as hubRecord, B as composeRecordedHubTitle, C as listWorkspaceBranches, D as resolveSessionTitle, E as taskExcerpt, F as clipTitleBytes, G as clipEllipsis, H as isNeutralTitle, I as composeBranchTitle, J as firstLine, K as currentSessionTitle, L as composeBranchTitleFull, M as mirrorHubTitle, N as patchTitleRow, O as sessionTitleOf, P as titleRow, Q as isSessionLive, R as composeHubTitle, S as listTopicSetBranches, T as renderHubBranchesCard, U as validateManualTitle, V as isLegacyTitle, W as cleanTitleText, X as stripLeadingDescription, Y as sessionTitleFor, Z as errorText, _ as hubsByBranch, a as memoryHistoryOf, b as latestTaskByBranch, c as updateMemoryVersioned, d as LEGACY_HUB_TITLE_PREFIX, et as writeHostTitle, f as hubSessionTitle, g as listHubSessions, h as isPluginBranchId, i as memoryContentUnchanged, j as memberTitleOf, k as ensureTitleRow, m as isNeutralHubTitle, n as currentVersionOf, o as memoryVersionsSupported, p as isLegacyHubTitle, q as describeSessionTitle, r as findMemoryByKey, s as migrateMemoryVersions, t as createMemoryVersioned, u as HUB_TITLE_PREFIX, v as isHubSession, w as relativeAgo, x as listHubBranches, y as isOpenDispatch, z as composeHubTitleFull } from "./memory-versions-BhJDxn_A.js";
import { a as groupRelayText, c as clipRelayResult, d as questionsForHub, f as raiseQuestion, h as resolveQuestions, i as groupRelayExists, l as episodeResult, m as renderQuestionsBlock, n as groupEpisodeSummaries, p as renderQuestionList, r as groupMembers, s as newGroupId, t as groupComplete, u as openQuestionsOfDispatch } from "./group-GfTkkPEE.js";
import { a as listCollections, c as resolveCollectionForEntry, i as findMemoryConflict, l as touchCollection, n as collectionRows, o as migrateFlatMemories, r as collectionTierNote, s as recallEntriesWithCollections, t as bestCollectionFor, u as askLlmJson } from "./memory-collections-CZctgFiw.js";
import { i as rememberRequirements, r as extractRequirements, t as buildExport } from "./export-DDAzZlQr.js";
import { r as scanWorkspace } from "./filemap-MJ8pEDq8.js";
import Schema from "@deepseek-ai/schemastery";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:http";
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
/**
* Symmetric pairwise similarity of two topic sets, for MERGE clustering
* (topicset-merge.ts).
*
* The comparison is TITLE vs TITLE through the same scorer (matchTopicSets):
* one set's title is the query, the other set's title is the only candidate
* field. Summaries are deliberately NOT read here — an LLM-generated summary
* is project boilerplate ("该话题集的目标是…") that makes every set of a
* single-project workspace look alike (measured on the real store: title +
* summary scoring merges all 20 active sets into one component at any
* threshold ≤ 25). The title is the identity label a human judges "same
* topic" by, and merging is a heavy, hard-to-reverse decision, so it requires
* title evidence. No dispatch guardrails (active/recency bonuses) apply:
* this is a catalog decision, not a routing one.
*/
function topicSetPairScore(a, b) {
	const titleOf = (set) => String(set.title ?? "");
	const candidate = (set) => [[titleOf(set), {
		title: titleOf(set),
		summary: "",
		keywords: [],
		status: "active"
	}]];
	const forward = matchTopicSets(candidate(b), titleOf(a), 1)[0]?.score ?? 0;
	const backward = matchTopicSets(candidate(a), titleOf(b), 1)[0]?.score ?? 0;
	return Math.max(forward, backward);
}
// src/session-title/member.ts
/**
* Persist the member title for one topic-set branch, computing it only when the
* member has no title yet (a reused branch / continue / resume keeps its first
* stable name — never renamed automatically).
*
* @param store - plugin store.
* @param topicSetId - owning topic set.
* @param member - branch identity and kind.
* @param topicTitle - topic-set title fallback when the row is gone.
* @param task - task text used for the snippet.
* @param options - `taskOnly` for plugin work branches.
* @returns the title now stored on the member (≤ 80 UTF-8 bytes).
*/
async function ensureMemberTitle(store, topicSetId, member, topicTitle, task, options = {}) {
	const record = store.topicsets.get(topicSetId);
	if (!record) return options.taskOnly ? composeBranchTitle(task) : clipTitleBytes(sessionTitleFor(topicTitle, task));
	const current = record.members.find((entry) => entry.sessionId === member.sessionId);
	if (current && current.title.trim()) return current.title;
	const others = record.members.filter((entry) => entry.sessionId !== member.sessionId).map((entry) => entry.title);
	const title = options.taskOnly ? composeBranchTitle(task) : clipTitleBytes(sessionTitleFor(record.title || topicTitle, task, others));
	if (current) await updateMember(store, topicSetId, member.sessionId, { title });
	else await addMember(store, topicSetId, {
		sessionId: member.sessionId,
		kind: member.kind,
		title
	});
	return title;
}
/**
* Run one task AFTER the current synchronous stack (microtask first, macrotask
* when microtasks are unavailable). Never runs the task inline: that is the
* whole point of this module.
*/
async function deferTitleTask(task) {
	await new Promise((resolve) => {
		try {
			queueMicrotask(resolve);
		} catch {
			setTimeout(resolve, 0);
		}
	});
	return task();
}
/**
* Retry one synchronous write attempt while it reports a re-entrant append.
*
* The first retry waits a macrotask (setTimeout 0), which is past the host's
* publication stack; the loop is bounded so a permanently hostile host can
* never spin. Returns the last result and how many attempts it took.
*/
async function retryReentrant(attempt, options = {}) {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
	let result = attempt();
	let tries = 1;
	while (result.reentrant && tries < maxAttempts) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		result = attempt();
		tries += 1;
	}
	return {
		result,
		tries
	};
}
// src/session-title/gate.ts
/** How long an unconsumed claim stays authoritative (a title event is immediate). */
const PENDING_TTL_MS = 6e4;
const chains = /* @__PURE__ */ new Map();
const pendingWrites = /* @__PURE__ */ new Map();
/** Serialize work per session (rejecting/erroring tasks never break the chain). */
function enqueue(sessionId, task) {
	const run = (chains.get(sessionId) ?? Promise.resolve()).then(() => task());
	let guard;
	guard = run.then(() => void 0, () => void 0).then(() => {
		if (chains.get(sessionId) === guard) chains.delete(sessionId);
	});
	chains.set(sessionId, guard);
	return run;
}
/** Register the claim of the host write that is about to happen. */
function claimHostWrite(sessionId, title) {
	pendingWrites.set(sessionId, {
		title,
		at: Date.now()
	});
}
/** The current claim of one session (expired claims are dropped). */
function pendingWrite(sessionId) {
	const claim = pendingWrites.get(sessionId);
	if (!claim) return void 0;
	if (Date.now() - claim.at > PENDING_TTL_MS) {
		pendingWrites.delete(sessionId);
		return;
	}
	return claim;
}
/** Consume the claim when the host event matches it (true = this was our write). */
function takeOwnWrite(sessionId, title) {
	const claim = pendingWrite(sessionId);
	if (!claim || claim.title !== title) return false;
	pendingWrites.delete(sessionId);
	return true;
}
/** The composition of one intent: final (byte-clipped) + full (diagnostics). */
function composeIntent(intent, row, kind) {
	const workspace = String(intent.workspaceKey ?? row.workspaceKey ?? "");
	if (intent.explicitTitle !== void 0) {
		const full = String(intent.explicitTitle ?? "").trim();
		return {
			desired: clipTitleBytes(full),
			full,
			topic: String(intent.topicText ?? row.topic ?? "").trim()
		};
	}
	const topic = String(intent.topicText ?? intent.firstMessage ?? row.topic ?? "").trim();
	if (kind === "hub") return {
		desired: composeHubTitle(workspace, topic),
		full: composeHubTitleFull(workspace, topic),
		topic
	};
	if (kind === "branch") return {
		desired: composeBranchTitle(topic),
		full: composeBranchTitleFull(topic),
		topic
	};
	return {
		desired: clipTitleBytes(topic),
		full: topic,
		topic
	};
}
/**
* The automatic title a reset should restore, or '' when none is known.
*
* Order: the preserved `autoTitle`, the stored desired (unless it is the human's
* own lastWritten), the durable mirror, the topic-set member title, then the
* stored topic recomposed under the current policy. A legacy user-locked row
* (desired was overwritten with the human title) therefore still recovers.
*/
function recoverAutoTitle(store, row, kind, workspace) {
	const preserved = String(row.autoTitle ?? "").trim();
	if (preserved) return preserved;
	const desired = String(row.desiredTitle ?? "").trim();
	if (desired && (row.state !== "user-locked" || desired !== row.lastWrittenTitle)) return desired;
	const usable = (value) => {
		const text = String(value ?? "").trim();
		if (!text || isNeutralTitle(text, workspace) || isLegacyTitle(text)) return "";
		return clipTitleBytes(text);
	};
	const mirror = usable(hubRecord(store, row.sessionId)?.title ?? "");
	if (mirror) return mirror;
	const member = usable(memberTitleOf(store, row.sessionId));
	if (member) return member;
	const topic = String(row.topic ?? "").trim();
	if (topic) {
		if (kind === "branch") return composeBranchTitle(topic);
		if (kind === "hub") return composeHubTitle(workspace, topic);
		return clipTitleBytes(topic);
	}
	return "";
}
/**
* One host write with the re-entrant retry loop, optionally deferred out of the
* current stack. The claim is registered immediately so the observer can
* attribute the resulting `session/title` event even when the write is deferred.
*/
async function runHostWrite(deps, sessionId, title, options) {
	claimHostWrite(sessionId, title);
	const attempt = () => retryReentrant(() => writeHostTitle(deps.ctx, sessionId, title));
	if (!options.defer) return attempt();
	return deferTitleTask(attempt);
}
/** Persist a failed write: keep the intent, record why, retry later. */
async function recordDeferred(deps, sessionId, row, composed, intent, result) {
	const reason = result.error ?? "host-write-failed";
	const live = isSessionLive(deps.ctx, sessionId);
	await patchTitleRow(deps.store, sessionId, {
		state: "deferred",
		desiredTitle: composed.desired || row.desiredTitle,
		autoTitle: composed.desired || row.autoTitle,
		desiredFull: composed.full,
		topic: composed.topic || row.topic,
		...intent.kind ? { kind: intent.kind } : {},
		...intent.workspaceKey ? { workspaceKey: intent.workspaceKey } : {},
		attempts: (row.attempts ?? 0) + 1,
		lastError: reason.slice(0, 300),
		source: intent.source ?? row.source
	});
	deps.logger.warn("supermemory: title deferred for " + sessionId + " (" + (live ? "host-write-failed" : "session-not-live") + "): " + reason);
	return {
		outcome: "deferred",
		title: composed.desired || row.desiredTitle,
		state: "deferred",
		reason: live ? reason : "session-not-live: " + reason
	};
}
/**
* Apply one naming intent. The ONLY function that writes a host title.
*
* @returns what happened; never throws (a naming failure must never break the
*   action that requested it — the caller's message/dispatch already happened).
*/
async function applySessionTitle(deps, intent) {
	const sessionId = String(intent.sessionId ?? "").trim();
	if (!sessionId) return {
		outcome: "skipped",
		title: "",
		reason: "missing-session-id"
	};
	if (!deps.store) return {
		outcome: "skipped",
		title: "",
		reason: "no-store"
	};
	try {
		return await enqueue(sessionId, () => applyInner(deps, {
			...intent,
			sessionId
		}));
	} catch (error) {
		deps.logger.warn("supermemory: title intent failed for " + sessionId + ": " + errorText(error));
		return {
			outcome: "skipped",
			title: "",
			reason: errorText(error)
		};
	}
}
async function applyInner(deps, intent) {
	const store = deps.store;
	const sessionId = intent.sessionId;
	let row = titleRow(store, sessionId);
	if (!row) row = await ensureTitleRow(store, {
		sessionId,
		workspaceKey: intent.workspaceKey,
		kind: intent.kind,
		source: intent.source
	});
	const kind = intent.kind ?? row.kind;
	const workspace = String(intent.workspaceKey ?? row.workspaceKey ?? "");
	if (intent.mode === "manual") {
		const validated = validateManualTitle(intent.explicitTitle ?? intent.topicText ?? "");
		if (!validated.ok) return {
			outcome: "skipped",
			title: row.desiredTitle,
			reason: validated.error
		};
		if (!isSessionLive(deps.ctx, sessionId)) return {
			outcome: "skipped",
			title: row.desiredTitle || row.autoTitle || "",
			reason: "session-not-live"
		};
		let autoTitle = recoverAutoTitle(store, row, kind, workspace);
		if (!autoTitle) {
			const before = readHostTitle(deps.ctx, sessionId)?.title;
			if (before && !isNeutralTitle(before, workspace) && !isLegacyTitle(before)) autoTitle = clipTitleBytes(before);
		}
		const { result } = await runHostWrite(deps, sessionId, validated.title, { defer: intent.defer });
		if (result.outcome === "none") {
			await patchTitleRow(store, sessionId, {
				...autoTitle ? { autoTitle } : {},
				attempts: (row.attempts ?? 0) + 1,
				lastError: (result.error ?? "host-write-failed").slice(0, 300)
			});
			return {
				outcome: "deferred",
				title: row.desiredTitle || autoTitle,
				state: row.state,
				reason: result.error ?? "host-write-failed"
			};
		}
		const accepted = result.accepted ?? validated.title;
		await patchTitleRow(store, sessionId, {
			state: "user-locked",
			kind,
			...autoTitle ? {
				autoTitle,
				desiredTitle: autoTitle,
				desiredFull: row.desiredFull || autoTitle
			} : {},
			lastWrittenTitle: accepted,
			lastTitleSeq: readHostTitle(deps.ctx, sessionId)?.seq,
			source: "manual",
			lockedReason: "manual",
			attempts: 0,
			lastError: ""
		});
		if (kind === "hub" && intent.mirror !== false) await mirrorHubTitle(store, sessionId, accepted, workspace);
		deps.logger.info("supermemory: session " + sessionId + " renamed by hand 「" + accepted + "」");
		return {
			outcome: result.outcome,
			title: accepted,
			state: "user-locked"
		};
	}
	if (intent.mode === "reset") row = await patchTitleRow(store, sessionId, {
		state: row.topic ? "named" : "provisional",
		lockedReason: ""
	}) ?? row;
	const locked = row.state === "user-locked";
	if (locked && !intent.force) return {
		outcome: "locked",
		title: row.desiredTitle || row.lastWrittenTitle,
		state: "user-locked",
		reason: row.lockedReason || "user-locked"
	};
	const composed = composeIntent(intent, row, kind);
	if (!composed.desired) return {
		outcome: "skipped",
		title: "",
		reason: "no-title"
	};
	const host = readHostTitle(deps.ctx, sessionId);
	const current = host?.title ?? "";
	const currentNeutral = !current || isNeutralTitle(current, workspace);
	const desiredNeutral = isNeutralTitle(composed.desired, workspace);
	if (!intent.force) {
		if (current && current !== row.lastWrittenTitle && !currentNeutral && current !== composed.desired) {
			const autoTitle = recoverAutoTitle(store, row, kind, workspace);
			await patchTitleRow(store, sessionId, {
				state: "user-locked",
				kind,
				...autoTitle ? {
					autoTitle,
					desiredTitle: autoTitle
				} : {},
				lastWrittenTitle: current,
				lastTitleSeq: host?.seq,
				lockedReason: "external-rename"
			});
			if (kind === "hub" && intent.mirror !== false) await mirrorHubTitle(store, sessionId, current, workspace);
			deps.logger.info("supermemory: session " + sessionId + " was renamed outside the plugin; auto-naming stops");
			return {
				outcome: "locked",
				title: current,
				state: "user-locked",
				reason: "external-rename"
			};
		}
		if (row.state === "named") {
			if (desiredNeutral || !currentNeutral || composed.desired !== row.desiredTitle) return {
				outcome: "already",
				title: current || row.desiredTitle,
				state: "named"
			};
		}
		if (composed.desired === row.desiredTitle && current === composed.desired) return {
			outcome: "already",
			title: current,
			state: row.state === "named" ? "named" : "provisional"
		};
	}
	const { result } = await runHostWrite(deps, sessionId, composed.desired, { defer: intent.defer });
	if (result.outcome === "none") return recordDeferred(deps, sessionId, row, composed, intent, result);
	const accepted = result.accepted ?? composed.desired;
	const acceptedNeutral = isNeutralTitle(accepted, workspace);
	const nextState = locked ? "user-locked" : acceptedNeutral && row.state !== "named" ? "provisional" : "named";
	await patchTitleRow(store, sessionId, {
		state: nextState,
		kind,
		...intent.workspaceKey ? { workspaceKey: intent.workspaceKey } : {},
		desiredTitle: accepted,
		autoTitle: accepted,
		desiredFull: composed.full,
		topic: composed.topic || row.topic,
		lastWrittenTitle: accepted,
		lastTitleSeq: readHostTitle(deps.ctx, sessionId)?.seq,
		source: intent.source ?? row.source,
		...intent.source === "manual" ? { lockedReason: "manual" } : {},
		attempts: 0,
		lastError: ""
	});
	if (kind === "hub" && intent.mirror !== false) await mirrorHubTitle(store, sessionId, accepted, workspace);
	deps.logger.info("supermemory: session " + sessionId + " named 「" + accepted + "」 (" + result.outcome + ")");
	return {
		outcome: result.outcome,
		title: accepted,
		state: nextState
	};
}
/** Manual rename (panel / GUI-equivalent): user-locked + exact bytes. */
async function renameSession(deps, input) {
	return applySessionTitle(deps, {
		sessionId: input.sessionId,
		workspaceKey: input.workspaceKey,
		kind: input.kind,
		explicitTitle: input.title,
		mode: "manual",
		force: true,
		defer: input.defer,
		source: "manual"
	});
}
/** Drop the user lock and recompute from the stored topic (restore auto naming). */
async function resetAutoTitle(deps, input) {
	const store = deps.store;
	const row = titleRow(store, input.sessionId);
	if (!row) return {
		outcome: "skipped",
		title: "",
		reason: "no-row"
	};
	const kind = input.kind ?? row.kind;
	const workspace = input.workspaceKey ?? row.workspaceKey;
	const autoTitle = recoverAutoTitle(store, row, kind, workspace);
	if (!autoTitle) return {
		outcome: "skipped",
		title: "",
		state: row.state,
		reason: "no-auto-title"
	};
	if (!isSessionLive(deps.ctx, row.sessionId)) return {
		outcome: "skipped",
		title: autoTitle,
		state: row.state,
		reason: "session-not-live"
	};
	return applySessionTitle(deps, {
		sessionId: input.sessionId,
		workspaceKey: workspace,
		kind,
		explicitTitle: autoTitle,
		mode: "reset",
		force: true,
		defer: input.defer,
		source: "reset"
	});
}
// src/session-title/durable.ts
/**
* Write `title` into every durable copy of one session: all dispatch rows whose
* branch is this session, and every topic-set member row for it. Idempotent;
* a closing/partial store loses only the projection.
*/
async function syncDurableTitles(store, sessionId, title) {
	const counts = {
		dispatches: 0,
		members: 0
	};
	const final = String(title ?? "").trim();
	if (!store || !sessionId || !final) return counts;
	try {
		for (const [id, row] of store.dispatches.entries()) {
			if (row.branchSessionId !== sessionId || row.title === final) continue;
			await store.dispatches.update(id, (record) => ({
				...record,
				title: final
			}));
			counts.dispatches += 1;
		}
	} catch {}
	try {
		for (const [setId, record] of store.topicsets.entries()) {
			let changed = false;
			const members = (record.members ?? []).map((member) => {
				if (member.sessionId !== sessionId || member.title === final) return member;
				changed = true;
				return {
					...member,
					title: final
				};
			});
			if (!changed) continue;
			await store.topicsets.update(setId, (row) => ({
				...row,
				members
			}));
			counts.members += 1;
		}
	} catch {}
	return counts;
}
/**
* Align ONE dispatch row's title with the branch's stable durable title. A
* CONTINUE/resume creates a new dispatch row; without this alignment the
* newest row would carry the new task's title and the branch card/list would
* silently rename a branch whose host/member title never changed.
*
* @returns true when the row was rewritten.
*/
async function syncDispatchTitle(store, dispatchId, title) {
	const final = String(title ?? "").trim();
	if (!store || !dispatchId || !final) return false;
	const row = store.dispatches.get(dispatchId);
	if (!row || row.title === final) return false;
	try {
		await store.dispatches.update(dispatchId, (record) => ({
			...record,
			title: final,
			updatedAt: Date.now()
		}));
		return true;
	} catch {
		return false;
	}
}
/** The session's naming kind (explicit > stored row > plugin id prefix). */
function titleKindOf(store, sessionId, explicit) {
	if (explicit && explicit !== "other") return explicit;
	const row = titleRow(store, sessionId);
	if (row && row.kind !== "other") return row.kind;
	return isPluginBranchId(sessionId) ? "branch" : "hub";
}
/**
* Manual rename: host + hub mirror (gate) then dispatch/member copies.
* Returns the gate result plus sync counts; a cold session is a `skipped`
* `session-not-live` (never resumed).
*/
async function renameSessionWithDurables(deps, input) {
	const kind = titleKindOf(deps.store, input.sessionId, input.kind);
	const result = await renameSession(deps, {
		...input,
		kind
	});
	if (result.outcome !== "host" && result.outcome !== "fallback") return result;
	const synced = await syncDurableTitles(deps.store, input.sessionId, result.title);
	return {
		...result,
		...synced
	};
}
/**
* Restore the automatic title: host + mirror (gate) then dispatch/member copies.
* A row with no recoverable automatic title is `skipped` `no-auto-title` and is
* NOT written.
*/
async function resetSessionWithDurables(deps, input) {
	const kind = titleKindOf(deps.store, input.sessionId, input.kind);
	const result = await resetAutoTitle(deps, {
		...input,
		kind
	});
	if (result.outcome !== "host" && result.outcome !== "fallback") return result;
	const synced = await syncDurableTitles(deps.store, input.sessionId, result.title);
	return {
		...result,
		...synced
	};
}
// src/chat-card.ts
/** Source field carrying the marker for a branch's dispatch input. */
const DISPATCH_SOURCE_FORM = "supermemory-dispatch";
/** Source field carrying the marker for a branch→hub relay. */
const RELAY_SOURCE_FORM = "relay";
/** Build the relay message source (branch → hub). */
function relaySource(input) {
	return {
		kind: "supermemory",
		form: RELAY_SOURCE_FORM,
		deliveryId: input.deliveryId,
		...input.fromSessionId ? { fromSessionId: input.fromSessionId } : {},
		...input.fromTitle ? { fromTitle: input.fromTitle } : {},
		...input.fromKind ? { fromKind: input.fromKind } : {},
		...input.dispatchId ? { dispatchId: input.dispatchId } : {},
		...input.groupId ? { groupId: input.groupId } : {},
		...input.task ? { task: input.task } : {},
		...input.topicSetTitle ? { topicSetTitle: input.topicSetTitle } : {},
		...input.capability ? { capability: input.capability } : {},
		...input.status ? { status: input.status } : {}
	};
}
/**
* Build the branch's first dispatch message source.
*
* `kind` stays 'user' ON PURPOSE (R25): the host's sidebar recency projection
* only advances on `user/message` with source.kind 'user'. The plugin's client
* card renderer keys off `form`, so the branch still sees a card while the
* session stays on top of the list.
*/
function dispatchSource(input) {
	return {
		kind: "user",
		form: DISPATCH_SOURCE_FORM,
		fromKind: "hub",
		...input.fromSessionId ? { fromSessionId: input.fromSessionId } : {},
		...input.fromTitle ? { fromTitle: input.fromTitle } : {},
		...input.task ? { task: input.task } : {},
		...input.topicSetTitle ? { topicSetTitle: input.topicSetTitle } : {},
		...input.capability ? { capability: input.capability } : {},
		...input.dispatchId ? { dispatchId: input.dispatchId } : {},
		...input.groupId ? { groupId: input.groupId } : {},
		...input.status ? { status: input.status } : {}
	};
}
// src/model-defaults.ts
const ROW_PREFIX = "model-defaults-";
/** Defensive copy: only a complete provider+model pair is a selection. */
function selectionOf(value) {
	if (!value || !value.provider || !value.model) return void 0;
	return {
		provider: String(value.provider),
		model: String(value.model),
		...value.reasoningEffort ? { reasoningEffort: String(value.reasoningEffort) } : {}
	};
}
function findRow(store, workspaceKey) {
	try {
		const table = store.modelDefaults;
		if (!table || typeof table.entries !== "function") return void 0;
		for (const [id, row] of table.entries()) if (row && row.workspaceKey === workspaceKey) return {
			id,
			row
		};
	} catch {}
}
/** Read one workspace's defaults. Never throws. */
function readModelDefaults(store, workspaceKey) {
	const key = String(workspaceKey ?? "");
	const fallback = {
		workspaceKey: key,
		source: "default"
	};
	if (!store || !key) return fallback;
	const found = findRow(store, key);
	if (!found) return fallback;
	const hub = selectionOf(found.row.hub);
	const branch = selectionOf(found.row.branch);
	return {
		workspaceKey: key,
		...hub ? { hub } : {},
		...branch ? { branch } : {},
		source: "stored"
	};
}
/** The default for one session kind, or undefined (follow the existing chain). */
function defaultModelFor(store, workspaceKey, kind) {
	const view = readModelDefaults(store, workspaceKey);
	return kind === "hub" ? view.hub : view.branch;
}
/**
* Save a partial patch:
*   - a complete selection replaces that kind's default;
*   - `null` clears it (falls back to the existing chain);
*   - an omitted key keeps the stored value;
*   - `reset: true` clears both (the row is deleted, so source returns default).
*/
async function writeModelDefaults(store, workspaceKey, patch, now = Date.now()) {
	const key = String(workspaceKey ?? "").trim();
	if (!key) throw new Error("缺少工作区键，无法保存默认模型。");
	const table = store.modelDefaults;
	if (!table) throw new Error("model_defaults 表不可用（存储域缺少该表）");
	const found = findRow(store, key);
	if (patch.reset) {
		if (found) await table.delete(found.id);
		return {
			workspaceKey: key,
			source: "default"
		};
	}
	const existing = found?.row;
	const hub = patch.hub === null ? void 0 : selectionOf(patch.hub) ?? selectionOf(existing?.hub);
	const branch = patch.branch === null ? void 0 : selectionOf(patch.branch) ?? selectionOf(existing?.branch);
	const record = {
		workspaceKey: key,
		...hub ? { hub } : {},
		...branch ? { branch } : {},
		updatedAt: now
	};
	if (!record.hub && !record.branch) {
		if (found) await table.delete(found.id);
		return {
			workspaceKey: key,
			source: "default"
		};
	}
	if (found) await table.update(found.id, () => record);
	else await table.put(ROW_PREFIX + key, record);
	return readModelDefaults(store, key);
}
/** Round tokens of a task text: `R30`, `R30-B`, … (the round's own label). */
const ROUND_TOKEN = /(?:^|[^A-Za-z0-9])((?:R|r)\d{1,3}(?:-[A-Za-z]{1,3})?)/g;
/**
* The explicit branch title for one dispatch: the task's first line, markup
* stripped, descriptive lead-ins (「R31：」「任务：」「分支 · 」…) removed, and
* byte-clipped to 80 UTF-8 bytes ({@link TITLE_MAX_BYTES}) by the naming policy.
* When the task carries no readable line the neutral 「新会话」 fallback is
* returned.
*/
function branchTitleFor(task) {
	return composeBranchTitle(task);
}
/**
* Round tokens of a task text, upper-cased and de-duplicated (R30, R30-B…).
*
* A suffixed token also yields its bare round (`R30-B` → `R30-B`, `R30`): the
* requirement's tag shape is 话题集标签 + 轮次 + 任务性质 + 能力档位, and the
* bare round is what a hub filters by when a round fans out into A/B/C tasks.
*/
function roundTokensOf(task) {
	const out = [];
	const text = String(task ?? "");
	const push = (token) => {
		if (token && !out.includes(token)) out.push(token);
	};
	ROUND_TOKEN.lastIndex = 0;
	for (let match = ROUND_TOKEN.exec(text); match; match = ROUND_TOKEN.exec(text)) {
		const token = match[1].toUpperCase();
		push(token);
		const dash = token.indexOf("-");
		if (dash > 0) push(token.slice(0, dash));
	}
	return out;
}
/**
* The branch's tags: 话题集标签 + 轮次令牌 + 任务性质 + 能力档位.
*
* `kind` is the dispatch's nature (`verify` → 验证); `capability` the granted
* profile name (full / read / read-write / minimal). Order is stable so the
* chips read the same everywhere; the cap keeps a card bounded.
*/
function branchTagsFor(input) {
	const out = [];
	const push = (tag) => {
		const clean = String(tag ?? "").trim();
		if (!clean) return;
		const clipped = clipEllipsis(clean, 24);
		if (!out.includes(clipped) && out.length < 8) out.push(clipped);
	};
	for (const tag of input.topicTags ?? []) push(tag);
	for (const token of roundTokensOf(input.task ?? "")) push(token);
	push(input.kind === "verify" ? "验证" : void 0);
	push(input.capability);
	return out;
}
/**
* branchSessionId → the newest dispatch's explicit title + tags.
*
* Same newest-row-wins rule as `latestTaskByBranch` (hub-branches.ts): a
* branch's identity is its latest dispatch, and a resumed dispatch carries the
* mapping forward (resume.ts copies it). One pass over the dispatch table.
*/
function latestBranchMeta(store) {
	const latest = /* @__PURE__ */ new Map();
	if (store) for (const [, row] of store.dispatches.entries()) {
		const branchId = String(row.branchSessionId ?? "");
		if (!branchId) continue;
		const at = Math.max(Number(row.updatedAt) || 0, Number(row.createdAt) || 0);
		const current = latest.get(branchId);
		if (current && at < current.at) continue;
		latest.set(branchId, {
			title: String(row.title ?? ""),
			tags: [...row.tags ?? []],
			at
		});
	}
	const out = /* @__PURE__ */ new Map();
	for (const [branchId, row] of latest) out.set(branchId, {
		title: row.title,
		tags: row.tags
	});
	return out;
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
* R30 需求⑥: the script also names the hub session that dispatched this task
* (`hubSessionId`). The dispatch record carries the same id, and the relay
* channel (observe.ts `deliver`) targets THAT record — so the branch knows
* which conversation its result returns to without maintaining its own map.
* Omitted for a dry run, which then stays id-free.
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
		...input.hubSessionId ? [`中枢会话：${input.hubSessionId}（派发记录与 relay 回送目标都是这个 id；完成后结果会自动送回该会话）`] : [],
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
const DISPATCH_NEXT_ACTION = "已派发，结束本轮，等待 relay：请立即结束本轮回复，不要调用 wait_agent、不要轮询分支状态；分支完成后 relay 会自动开启新一轮对话，届时再汇总转述给用户。";
/** memory_resume 续跑回执的收口提示（只查清单时不需要）。 */
const RESUME_NEXT_ACTION = "已续跑，结束本轮，等待 relay：请立即结束本轮回复，不要调用 wait_agent、不要轮询分支状态；分支完成后 relay 会自动开启新一轮对话，届时再汇总转述给用户。";
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
function serviceOf$3(ctx, name) {
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
		const presetId = serviceOf$3(ctx, "agentPresets")?.presetForSession(session) ?? session.header?.agentPreset;
		if (presetId) out.presetId = presetId;
	} catch {}
	try {
		const sandbox = serviceOf$3(ctx, "sandboxPolicy");
		const mode = sandbox?.resolve?.({ session }).mode ?? sandbox?.overrideOf?.(session);
		if (mode) out.sandboxMode = mode;
	} catch {}
	try {
		const approval = serviceOf$3(ctx, "approval");
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
		const presets = serviceOf$3(ctx, "agentPresets");
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
					kind: args.kind,
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
		mode,
		kind: args.kind
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
	const topicSet = deps.store.topicsets.get(input.topicSetId);
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
			title: branchTitleFor(input.task),
			tags: branchTagsFor({
				topicTags: topicSet?.keywords,
				task: input.task
			}),
			capability: "",
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
	const { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, composition, capabilities, mode, kind: taskKind, groupId, excludeBranches } = input;
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
		title: branchTitleFor(task),
		tags: branchTagsFor({
			topicTags: topicSet.keywords,
			task,
			kind: taskKind,
			capability: capabilities.profile
		}),
		capability: capabilities.profile,
		createdAt: now,
		updatedAt: now
	};
	await store.dispatches.put(dispatchId, record);
	await recordHubSession(store, {
		sessionId: hubSessionId,
		workspaceKey: workspaceKeyOf(cwd),
		source: "dispatch"
	});
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
		}, topicSet.title, task, { taskOnly: true });
		await syncDispatchTitle(store, dispatchId, named);
		const applied = await applySessionTitle({
			ctx,
			store,
			logger
		}, {
			sessionId: branchSessionId,
			kind: "branch",
			explicitTitle: named,
			source: "dispatch"
		});
		if (applied.outcome === "host" || applied.outcome === "fallback") logger.info(`supermemory: named branch ${branchSessionId.slice(0, 20)} 「${applied.title}」 via ${applied.outcome}`);
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
			dispatchId,
			hubSessionId
		});
		const hubTitle = sessionTitleOf(ctx, store, hubSessionId);
		const message = factory({
			content: [{
				type: "text",
				text: groupId ? `${script}\n\n本任务是并行组 ${groupId} 的一员：只负责这一个任务；全部成员到达终态后由中枢统一汇总，不要等待其他分支。` : script
			}],
			source: dispatchSource({
				fromSessionId: hubSessionId,
				...hubTitle ? { fromTitle: hubTitle } : {},
				task,
				topicSetTitle: topicSet.title,
				capability: capabilities.profile,
				dispatchId,
				...groupId ? { groupId } : {},
				status: "dispatched"
			})
		});
		if (!handle) throw new Error("分支句柄缺失（acquireBranch 未返回 handle）");
		const seqBefore = ctx.sessions.get(branchSessionId)?.seq;
		handle.agent.followup(message);
		if (typeof seqBefore === "number") await store.dispatches.update(dispatchId, (r) => ({
			...r,
			startSeq: seqBefore,
			updatedAt: Date.now()
		}));
		logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} followup queued at seq ${String(seqBefore ?? "unknown")}; observation settles the turn`);
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
function branchCandidates(topicSet, task, mode, busy, exclude, isHubMember) {
	const taskTokens = new Set(task.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean));
	const ranked = rankMembers(topicSet, taskTokens).filter((member) => !(isHubMember?.(member.sessionId) ?? false)).filter((member) => !exclude?.has(member.sessionId));
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
	const branchDefault = defaultModelFor(store, workspaceKeyOf(cwd), "branch");
	const agentOptions = topicSet.defaultModel ?? branchDefault ?? hubModel;
	const plan = branchCandidates(topicSet, task, mode, busyBranches(store), exclude, (sessionId) => resolveRole(store, { id: sessionId }).role === "hub");
	if (mode === "fork" && plan.forkParent) {
		const forked = await forkFromParent(ctx, plan.forkParent.sessionId, cwd, topicSet.defaultModel ?? branchDefault, composition, capabilities, logger);
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
	if (message.source?.kind !== "user") return false;
	const form = message.source?.form;
	return form !== "recall" && form !== "notice" && form !== "relay";
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
/**
* Resolve every card field for one relay from durable rows.
*
* R33 需求⑦:
*   - a GROUP's source session is its first member BRANCH (`branchSessionId`),
*     not the group id; the group id is its own card row;
*   - task / topic set / capability are carried in both directions (they used to
*     be dropped for relays, so the branch→hub card rows were always empty);
*   - a pre-R33 outbox row (no persisted fields) is reconstructed from the
*     dispatch row / group member, and a missing title is looked up live.
*
* Pure except for the optional `sessionTitleOf` host read; never throws (a
* missing table answers ''), so a host-free fixture can still deliver.
*/
function relayCardFields(ctx, store, input) {
	let dispatch;
	let groupFirst;
	try {
		dispatch = input.dispatchId ? store.dispatches.get(input.dispatchId) : void 0;
		groupFirst = input.groupId ? groupMembers(store, input.groupId)[0]?.[1] : void 0;
	} catch {}
	const record = dispatch ?? groupFirst;
	const fromKind = input.fromKind ?? (input.groupId ? "group" : "branch");
	const fromSessionId = String(input.fromSessionId ?? record?.branchSessionId ?? "").trim();
	let topicSetTitle = String(input.topicSetTitle ?? "").trim();
	if (!topicSetTitle && record?.topicSetId) try {
		topicSetTitle = String(store.topicsets?.get?.(record.topicSetId)?.title ?? "").trim();
	} catch {}
	let fromTitle = String(input.fromTitle ?? "").trim();
	if (!fromTitle && fromSessionId) try {
		fromTitle = String(sessionTitleOf(ctx, store, fromSessionId) ?? "").trim();
	} catch {}
	if (!fromTitle && input.groupId) fromTitle = topicSetTitle ? `并行组 · ${topicSetTitle}` : "并行组";
	return {
		fromSessionId,
		fromTitle,
		fromKind,
		task: String(input.task ?? record?.task ?? ""),
		topicSetTitle,
		capability: String(input.capability ?? record?.capability ?? "")
	};
}
/** Enqueue + send one relay delivery to the hub (at-least-once, idempotent). */
async function deliver(deps, input) {
	const { ctx, store, logger } = deps;
	const deliveryId = input.deliveryId ?? (input.groupId ? "dlv-grp-" + input.groupId : "dlv-" + input.dispatchId);
	const existing = store.outbox.get(deliveryId);
	if (existing && (existing.status === "relayed" || existing.status === "confirmed")) {
		logger.info(`supermemory: delivery ${deliveryId} already ${existing.status}; not re-sending`);
		return;
	}
	const card = relayCardFields(ctx, store, {
		dispatchId: input.dispatchId,
		groupId: input.groupId,
		...input.fromSessionId === void 0 ? {} : { fromSessionId: input.fromSessionId },
		...input.fromTitle === void 0 ? {} : { fromTitle: input.fromTitle },
		...input.fromKind === void 0 ? {} : { fromKind: input.fromKind }
	});
	await store.outbox.put(deliveryId, {
		dispatchId: input.groupId ? void 0 : input.dispatchId || void 0,
		groupId: input.groupId,
		kind: input.groupId ? "group" : "single",
		payload: input.text,
		status: "pending",
		enqueuedAt: Date.now(),
		...card.fromSessionId ? { fromSessionId: card.fromSessionId } : {},
		...card.fromTitle ? { fromTitle: card.fromTitle } : {},
		...card.fromKind ? { fromKind: card.fromKind } : {},
		task: card.task,
		topicSetTitle: card.topicSetTitle,
		capability: card.capability,
		...input.ledgerOnly ? { suppressedOf: input.ledgerOnly } : {}
	});
	if (input.ledgerOnly) {
		await store.outbox.update(deliveryId, (r) => ({
			...r,
			status: "relayed",
			relayedAt: Date.now()
		})).catch(() => {});
		logger.info(`supermemory: delivery ${deliveryId} suppressed (twin ${input.ledgerOnly} already relayed)`);
		return;
	}
	const hub = ctx.agents.get(input.record.hubSessionId);
	if (!hub) {
		logger.info(`supermemory: hub ${input.record.hubSessionId.slice(0, 13)} not live; delivery ${deliveryId} stays pending`);
		return;
	}
	try {
		const factory = deps.createMessage ?? await messageFactory$2();
		hub.followup(factory({
			content: [{
				type: "text",
				text: input.text
			}],
			source: relaySource({
				deliveryId,
				...card.fromSessionId ? { fromSessionId: card.fromSessionId } : {},
				...card.fromTitle ? { fromTitle: card.fromTitle } : {},
				fromKind: card.fromKind,
				...input.groupId ? { groupId: input.groupId } : { dispatchId: input.dispatchId },
				...card.task ? { task: card.task } : {},
				...card.topicSetTitle ? { topicSetTitle: card.topicSetTitle } : {},
				...card.capability ? { capability: card.capability } : {},
				status: "returned"
			})
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
		deliveryId: input.deliveryId,
		...input.fromSessionId === void 0 ? {} : { fromSessionId: input.fromSessionId },
		...input.fromTitle === void 0 ? {} : { fromTitle: input.fromTitle },
		...input.fromKind === void 0 ? {} : { fromKind: input.fromKind }
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
		if (item.suppressedOf) continue;
		const hubSessionId = item.dispatchId ? store.dispatches.get(item.dispatchId)?.hubSessionId : item.groupId ? groupMembers(store, item.groupId)[0]?.[1].hubSessionId : void 0;
		if (!hubSessionId) continue;
		const hub = ctx.agents.get(hubSessionId);
		if (!hub?.followup) continue;
		if ([...hub.inbox?.nextTurn ?? [], ...hub.inbox?.nextStep ?? []].some((message) => message.source?.deliveryId === deliveryId)) continue;
		try {
			const card = relayCardFields(ctx, store, {
				...item.dispatchId === void 0 ? {} : { dispatchId: item.dispatchId },
				...item.groupId === void 0 ? {} : { groupId: item.groupId },
				...item.fromSessionId ? { fromSessionId: item.fromSessionId } : {},
				...item.fromTitle ? { fromTitle: item.fromTitle } : {},
				...item.fromKind ? { fromKind: item.fromKind } : {},
				...item.task ? { task: item.task } : {},
				...item.topicSetTitle ? { topicSetTitle: item.topicSetTitle } : {},
				...item.capability ? { capability: item.capability } : {}
			});
			const factory = deps.createMessage ?? await messageFactory$2();
			hub.followup(factory({
				content: [{
					type: "text",
					text: item.payload
				}],
				source: relaySource({
					deliveryId,
					...card.fromSessionId ? { fromSessionId: card.fromSessionId } : {},
					...card.fromTitle ? { fromTitle: card.fromTitle } : {},
					fromKind: card.fromKind,
					...item.groupId ? { groupId: item.groupId } : { dispatchId: item.dispatchId ?? "" },
					...card.task ? { task: card.task } : {},
					...card.topicSetTitle ? { topicSetTitle: card.topicSetTitle } : {},
					...card.capability ? { capability: card.capability } : {},
					status: "returned"
				})
			}));
			await store.outbox.update(deliveryId, (r) => ({
				...r,
				...card.fromSessionId ? { fromSessionId: card.fromSessionId } : {},
				...card.fromTitle ? { fromTitle: card.fromTitle } : {},
				fromKind: card.fromKind,
				task: card.task,
				topicSetTitle: card.topicSetTitle,
				capability: card.capability,
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
*
* R42 (relay 重复投递修复): idempotency is PERSISTENT and two-layered —
*  1. the canonical `dlv-<dispatchId>` outbox row (deliver() refuses to re-send
*     a row already relayed/confirmed), so ticks, reloads and late events never
*     produce a second copy;
*  2. within ONE pass, a twin dispatch (same branch + same task — the hub
*     retried a dispatch after a host tool error) is ledgered, not re-sent.
*/
async function settleInterruptedDispatches(deps, options) {
	const { store, logger } = deps;
	const now = options.now ?? Date.now();
	const settled = [];
	const touchedGroups = /* @__PURE__ */ new Set();
	const announced = /* @__PURE__ */ new Map();
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
		const logicalKey = `${record.branchSessionId}\u0000${record.task}`;
		const twinOf = announced.get(logicalKey);
		try {
			const partial = await partialSummary(deps, record);
			if (!record.groupId) try {
				await deliver(deps, {
					dispatchId,
					record,
					text: relayText(record, partial, reason, openQuestionsOfDispatch(store, dispatchId)),
					...twinOf ? { ledgerOnly: twinOf } : {}
				});
				if (!twinOf) announced.set(logicalKey, dispatchId);
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
/**
* Whether a resume successor actually replaced the original interruption.
*
* A still-running, delivered, or itself-cut-off successor owns the work now
* (a cut-off successor appears in the list with its own `resumeOf` row). An
* honest failure of the resume itself — `resume-wake-failed`, a dispatch error,
* max-tokens — is NOT a takeover: the original must stay actionable so the user
* can retry it instead of the task silently disappearing from the list.
*/
function successorSupersedes(next) {
	if (!next) return false;
	if (isOpenDispatch(next)) return true;
	if (next.status === "delivered") return true;
	return isCutOffDispatch(next);
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
* → branch-died）。已交付、自主失败（max-tokens/派发异常）与已被续跑接替的行
* 都不出现——它们不是待决项。续跑接替的判定不能只看「续跑仍在途」：续跑完成
* （delivered）后原派发必须一直保持隐藏，否则清单和中断提醒会永远重复列出它。
* 同时扫描两个方向（原派发的 resumedBy、后继的 resumeOf），历史数据即使只写了
* 单边关联也能被正确过滤，无需迁移。
*/
function listInterruptedDispatches(store, options = {}) {
	const superseded = /* @__PURE__ */ new Set();
	for (const [, candidate] of store.dispatches.entries()) if (candidate.resumeOf && successorSupersedes(candidate)) superseded.add(candidate.resumeOf);
	const out = [];
	for (const [dispatchId, record] of store.dispatches.entries()) {
		if (!record.branchSessionId) continue;
		if (!isCutOffDispatch(record)) continue;
		const topicSet = record.topicSetId ? store.topicsets.get(record.topicSetId) : void 0;
		if (options.workspaceKey && topicSet?.workspaceKey !== options.workspaceKey) continue;
		if (record.resumedBy && successorSupersedes(store.dispatches.get(record.resumedBy))) continue;
		if (superseded.has(dispatchId)) continue;
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
		if (view.partial) lines.push("   已完成部分：" + clipMarked(view.partial, 160));
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
function resumeMessage(originalId, record, partial, hubSessionId) {
	const group = record.groupId ? "\n原任务来自并行组 " + record.groupId + "（组汇总已另行交付），本次为单独续跑。" : "";
	const hub = hubSessionId ? "\n中枢会话：" + hubSessionId + "（完成后结果经既有 relay 通道送回该会话）。" : "";
	return "[supermemory-resume " + originalId + "]\n本消息是被中断任务的续跑（原派发 " + originalId + "，原分支 " + record.branchSessionId + "）。" + group + hub + "\n原始任务：" + record.task + "\n已完成部分：" + (partial || "（无记录）") + "\n请先核对以上已完成部分与分支日志中已有的工作，再继续未完成的事项；不要从头重复已完成的工作。\n遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。";
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
		if (next && successorSupersedes(next)) return {
			status: "error",
			dispatchId,
			message: "该任务已有续跑" + (isOpenDispatch(next) ? "在进行" : "接替") + "（" + record.resumedBy + "）。"
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
			capability: record.capability || capabilities.profile,
			title: record.title || branchTitleFor(record.task),
			tags: record.tags && record.tags.length > 0 ? [...record.tags] : branchTagsFor({
				topicTags: record.topicSetId ? store.topicsets.get(record.topicSetId)?.keywords : void 0,
				task: record.task,
				capability: capabilities.profile
			}),
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
			const hubTitle = sessionTitleOf(ctx, store, hubSessionId);
			const topicSetTitle = record.topicSetId ? store.topicsets.get(record.topicSetId)?.title ?? "" : "";
			agent.followup(factory({
				content: [{
					type: "text",
					text: resumeMessage(dispatchId, record, partial, hubSessionId)
				}],
				source: dispatchSource({
					fromSessionId: hubSessionId,
					...hubTitle ? { fromTitle: hubTitle } : {},
					task: record.task,
					...topicSetTitle ? { topicSetTitle } : {},
					capability: capabilities.profile,
					dispatchId: newDispatchId,
					status: "dispatched"
				})
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
* 一批中断公告的稳定短键（同一批派发集合 → 同一键）。
*
* 只用确定性字符串散列（FNV-1a，base36）：不引入 crypto 依赖，键长短固定，
* 足够把不同批次（新中断加入）区分开——它们的 outbox 行因此互不覆盖，
* hub 不在线时各自 pending 自愈。
*/
function noticeBatchKey(signature) {
	let hash = 2166136261;
	const text = String(signature ?? "");
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(36);
}
/**
* 启动/巡检时的中断清单主动触达（复用 observe 的 at-least-once relay 通道）。
*
* R42（relay 重复投递修复）：公告是**持久增量**——每条派发只在第一次进入清单时
* 被公告一次（`dispatches.interruptNoticedAt` 落库标记），重载后签名表清空、
* 清单刷新（新中断加入）都不会把已公告过的任务重新整批送来。旧的实现只有内存
* 签名去重：插件每次重载后同一批中断任务会被再送达一次（真实 ledger 里同一个
* hub 存在多条 dlv-resume-* 行，多条 pending 从未确认）。
*
* 幂等键按批次稳定：`dlv-resume-<hub>-<签名摘要>`。同一批（相同派发集合）重复
* 触发时键相同 → deliver 的持久守卫直接跳过；不同批（新中断加入）键不同 →
* 各自一行，hub 不在线时都可 pending 自愈，互不覆盖。
*/
async function notifyInterruptedDispatches(deps, options = {}) {
	const { ctx, store, logger } = deps;
	const now = options.now ?? Date.now();
	const pending = listInterruptedDispatches(store, { now }).filter((view) => !store.dispatches.get(view.dispatchId)?.interruptNoticedAt);
	const byHub = /* @__PURE__ */ new Map();
	for (const view of pending) {
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
		const text = injectionTitle("notice") + " 检测到 " + rows.length + " 个被中断的任务（插件重载/关闭或 DSH 退出导致；分支会话已保留，可选择继续）：\n" + rows.map((row, index) => index + 1 + ". " + row.dispatchId + " · 话题集「" + (row.topicSetTitle ?? "（未命名）") + "」 · 任务：" + taskExcerpt(row.task, 40) + " · 分支 " + row.branchSessionId + " · 中断于 " + relativeAgo(row.interruptedAt, now) + (row.partial ? "\n   已完成部分：" + clipMarked(row.partial, 120) : "")).join("\n") + "\n\n用 memory_resume 查看并续跑（无参=清单；带 dispatchId=继续指定任务，可多选），或 /memory resume <dispatchId>。";
		try {
			await deliverRelay(deps, {
				deliveryId: "dlv-resume-" + hubSessionId + "-" + noticeBatchKey(signature),
				dispatchId: rows[0].dispatchId,
				hubSessionId,
				text,
				fromKind: "system",
				fromTitle: "SuperMemory 中断巡检"
			});
			notified += 1;
			const stampedAt = Date.now();
			for (const row of rows) try {
				await store.dispatches.update(row.dispatchId, (r) => r.interruptNoticedAt ? r : {
					...r,
					interruptNoticedAt: stampedAt
				});
			} catch {}
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
const MARKER_KEY$4 = "titles";
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
async function applyPlanToStore$1(store, plan) {
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
async function applyPlanToHost$1(ctx, store, plan, logger) {
	let renamed = 0;
	let skipped = 0;
	for (const item of plan.members) try {
		const current = currentSessionTitle(ctx, item.sessionId);
		if (current && current !== item.from) {
			skipped += 1;
			logger.info("supermemory: title migration skipped " + item.sessionId + " — the host title was renamed by somebody else");
			continue;
		}
		const outcome = await applySessionTitle({
			ctx,
			store,
			logger
		}, {
			sessionId: item.sessionId,
			kind: "other",
			explicitTitle: item.to,
			source: "migration",
			force: true
		});
		if (outcome.outcome === "host" || outcome.outcome === "fallback") renamed += 1;
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
	return store.meta?.get(MARKER_KEY$4);
}
/** Record a successful run so a restart does not rescan. */
async function writeTitlesMigrationMarker(store) {
	await store.meta?.put(MARKER_KEY$4, {
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
	await applyPlanToStore$1(store, plan);
	const host = await applyPlanToHost$1(ctx, store, plan, logger);
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
/** The meta-table row key of the merge marker. */
const MARKER_KEY$3 = "merges";
/**
* A cluster whose every set reads as one-shot verification (title or summary
* mentions 验证/复测/终验) merges INTO the workspace's verification set —
* the funnel `kind:'verify'` dispatches use — creating it when absent.
*/
const VERIFY_NATURE_RE = /验证|复测|终验/;
/** Merged summary cap (2× the 500-char create cap; keeps the field bounded). */
const MERGED_SUMMARY_MAX = 1e3;
function zeroCounts() {
	return {
		dispatches: 0,
		episodes: 0,
		requirements: 0,
		questions: 0,
		routing: 0
	};
}
function addCounts(a, b) {
	return {
		dispatches: a.dispatches + b.dispatches,
		episodes: a.episodes + b.episodes,
		requirements: a.requirements + b.requirements,
		questions: a.questions + b.questions,
		routing: a.routing + b.routing
	};
}
/** Every record that points at one topic set (the FK inventory). */
function recordCounts(store, topicSetId) {
	const counts = zeroCounts();
	for (const [, row] of store.dispatches.entries()) if (row.topicSetId === topicSetId) counts.dispatches += 1;
	for (const [, row] of store.episodes.entries()) if (row.topicSetId === topicSetId) counts.episodes += 1;
	for (const [, row] of store.requirements.entries()) if (row.topicSetId === topicSetId) counts.requirements += 1;
	for (const [, row] of store.questions.entries()) if (row.topicSetId === topicSetId) counts.questions += 1;
	for (const [, row] of store.routing.entries()) if (row.activeTopicSetId === topicSetId) counts.routing += 1;
	return counts;
}
/** Earliest dispatch task per branch session (the text that named it). */
function firstTaskBySession(store) {
	const best = /* @__PURE__ */ new Map();
	for (const [, row] of store.dispatches.entries()) {
		const task = String(row.task ?? "").trim();
		if (!task || !row.branchSessionId) continue;
		const prev = best.get(row.branchSessionId);
		if (!prev || (row.createdAt || 0) < prev.createdAt) best.set(row.branchSessionId, {
			createdAt: row.createdAt || 0,
			task
		});
	}
	const out = /* @__PURE__ */ new Map();
	for (const [sessionId, row] of best) out.set(sessionId, row.task);
	return out;
}
/** Primary-set rule: most members > earliest created > most complete index. */
function completeness(record) {
	return record.keywords.length + (String(record.summary ?? "").trim() ? 1 : 0);
}
function pickTarget(entries) {
	let best = entries[0];
	for (const entry of entries.slice(1)) {
		const cur = best[1];
		const cand = entry[1];
		if (cand.members.length !== cur.members.length) {
			if (cand.members.length > cur.members.length) best = entry;
			continue;
		}
		if ((cand.createdAt ?? 0) !== (cur.createdAt ?? 0)) {
			if ((cand.createdAt ?? 0) < (cur.createdAt ?? 0)) best = entry;
			continue;
		}
		if (completeness(cand) !== completeness(cur)) {
			if (completeness(cand) > completeness(cur)) best = entry;
			continue;
		}
		if (entry[0] < best[0]) best = entry;
	}
	const record = best[1];
	const reason = entries.every((entry) => entry[1].members.length <= record.members.length) && record.members.length > 0 ? `成员最多（${record.members.length} 个）` : "成员数相同，取创建最早且索引最完整者";
	return {
		id: best[0],
		reason
	};
}
/** Cluster signature: stable across re-plans, so the marker can dedupe. */
function clusterSignature(workspaceKey, targetKey, sourceIds) {
	return `v1|${workspaceKey}|${targetKey}|${[...sourceIds].sort().join("+")}`;
}
/**
* Merge member lists: target members first, then each source's; one row per
* sessionId (a session that belongs to several sets is kept ONCE), and a
* kind conflict resolves to 'root' (a set-owning hub outranks a work branch).
* Pure — used by the plan and by apply so both agree on the outcome.
*/
function mergeMemberLists(target, sources) {
	const merged = /* @__PURE__ */ new Map();
	const take = (member) => {
		const existing = merged.get(member.sessionId);
		if (!existing) {
			merged.set(member.sessionId, { ...member });
			return;
		}
		const kind = existing.kind === "root" || member.kind === "root" ? "root" : existing.kind;
		const title = existing.title.trim() ? existing.title : member.title;
		const lastActiveAt = Math.max(existing.lastActiveAt || 0, member.lastActiveAt || 0);
		merged.set(member.sessionId, {
			...existing,
			kind,
			title,
			lastActiveAt
		});
	};
	for (const member of target?.members ?? []) take(member);
	for (const source of sources) for (const member of source.members) take(member);
	return [...merged.values()];
}
/**
* Recompute every merged member's title against the (new) topic-set title,
* keeping the in-set ordinal de-duplication. Sources, in order: the
* branch's first dispatch task; else the snippet after ' · ' of the old
* title; else the old topic-set title alone (a panel root session). A title
* with none of those is left untouched — never guessed.
*/
function planMemberTitles(members, targetTitle, tasks, sourceTitles) {
	const changes = [];
	const taken = /* @__PURE__ */ new Set();
	for (const member of members) {
		const from = String(member.title ?? "");
		const task = tasks.get(member.sessionId);
		let to;
		if (task) to = sessionTitleFor(targetTitle, task, taken);
		else if (from.includes(" · ")) {
			const snippet = from.slice(from.indexOf(" · ") + 3);
			to = sessionTitleFor(targetTitle, snippet, taken);
		} else if (from.trim() && from.trim() === (sourceTitles.get(member.sessionId) ?? "")) to = sessionTitleFor(targetTitle, "", taken);
		else to = from;
		taken.add(to);
		if (to !== from) changes.push({
			sessionId: member.sessionId,
			from,
			to
		});
	}
	return changes;
}
/** The persisted merge marker (undefined when never run). */
function mergeMarker(store) {
	return store.meta?.get(MARKER_KEY$3);
}
/**
* Compute the merge plan without writing anything. Pure over the store's
* topicsets + record tables, so it is unit-testable with a fake store and
* safe to run against the REAL store as a dry-run.
*/
function planTopicSetMerges(store, options = {}) {
	const marker = mergeMarker(store);
	const executed = new Set(marker && (marker.mergesVersion ?? 0) >= 1 ? marker.mergeSignatures ?? [] : []);
	const tasks = firstTaskBySession(store);
	const byWorkspace = /* @__PURE__ */ new Map();
	for (const entry of store.topicsets.entries()) {
		const record = entry[1];
		if (record.status !== "active") continue;
		const arr = byWorkspace.get(record.workspaceKey) ?? [];
		arr.push(entry);
		byWorkspace.set(record.workspaceKey, arr);
	}
	const plan = {
		clusters: [],
		emptySets: [],
		borderline: [],
		orphans: [],
		totals: {
			activeSets: 0,
			clusteredSets: 0,
			toArchive: 0,
			dispatches: 0,
			episodes: 0,
			requirements: 0,
			questions: 0,
			routing: 0,
			membersAfter: 0,
			newTargets: 0
		},
		executedSignatures: [...executed]
	};
	const clustered = /* @__PURE__ */ new Set();
	const built = [];
	for (const [workspaceKey, entries] of byWorkspace) {
		plan.totals.activeSets += entries.length;
		const byId = new Map(entries);
		const pairs = [];
		for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
			const score = topicSetPairScore(entries[i][1], entries[j][1]);
			if (score >= 6) pairs.push({
				a: entries[i][0],
				b: entries[j][0],
				score
			});
		}
		const parent = new Map(entries.map(([id]) => [id, id]));
		const find = (x) => {
			let root = x;
			while (parent.get(root) !== root) root = parent.get(root);
			while (parent.get(x) !== root) {
				const next = parent.get(x);
				parent.set(x, root);
				x = next;
			}
			return root;
		};
		for (const pair of pairs) {
			if (pair.score < 9) continue;
			const ra = find(pair.a);
			const rb = find(pair.b);
			if (ra !== rb) parent.set(ra, rb);
		}
		const groups = /* @__PURE__ */ new Map();
		for (const [id] of entries) {
			const root = find(id);
			groups.set(root, [...groups.get(root) ?? [], id]);
		}
		const clusterMembers = /* @__PURE__ */ new Set();
		for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) clusterMembers.add(id);
		for (const ids of groups.values()) {
			if (ids.length < 2) continue;
			const records = ids.map((id) => byId.get(id));
			const verifyNature = records.every((record) => VERIFY_NATURE_RE.test(`${record.title ?? ""} ${record.summary ?? ""}`));
			const verifyId = verifyNature ? findVerifyTopicSet(store, workspaceKey) : void 0;
			const useVerifyTarget = verifyNature && (!verifyId || ids.includes(verifyId));
			let targetId = "";
			let targetReason = "";
			let targetRecord;
			if (useVerifyTarget && verifyId) {
				targetId = verifyId;
				targetRecord = byId.get(verifyId);
				targetReason = "验证类簇：目标即本工作区验证集（kind:\"verify\" 派发的既定归拢点）";
			} else if (useVerifyTarget) targetReason = `验证类簇：将新建「${verifyTopicSetTitle(workspaceKey)}」作为目标集（kind:"verify" 派发的既定归拢点）`;
			else {
				const picked = pickTarget(records.map((record, index) => [ids[index], record]));
				targetId = picked.id;
				targetRecord = byId.get(targetId);
				targetReason = picked.reason;
			}
			const sourceIds = useVerifyTarget ? ids.filter((id) => id !== targetId) : ids.filter((id) => id !== targetId);
			const signature = clusterSignature(workspaceKey, targetId || `new:${verifyTopicSetTitle(workspaceKey)}`, sourceIds);
			for (const id of ids) clustered.add(id);
			if (executed.has(signature)) continue;
			const targetTitle = targetRecord ? String(targetRecord.title ?? "") : verifyTopicSetTitle(workspaceKey);
			const sources = sourceIds.map((id) => {
				const record = byId.get(id);
				let best = 0;
				for (const other of records) {
					if (other === record) continue;
					const score = topicSetPairScore(record, other);
					if (score > best) best = score;
				}
				return {
					topicSetId: id,
					title: String(record.title ?? ""),
					members: record.members.length,
					createdAt: record.createdAt ?? 0,
					score: Math.round(best * 100) / 100,
					records: recordCounts(store, id)
				};
			});
			let records_ = zeroCounts();
			for (const source of sources) records_ = addCounts(records_, source.records);
			const merged = mergeMemberLists(targetRecord, sourceIds.map((id) => byId.get(id)));
			const sourceTitles = /* @__PURE__ */ new Map();
			for (const source of sources) for (const member of byId.get(source.topicSetId).members) if (!sourceTitles.has(member.sessionId)) sourceTitles.set(member.sessionId, String(byId.get(source.topicSetId).title ?? ""));
			const memberChanges = planMemberTitles(merged, targetTitle, tasks, sourceTitles);
			const keywordUnion = /* @__PURE__ */ new Set();
			if (targetRecord) for (const tag of targetRecord.keywords) keywordUnion.add(tag);
			for (const id of sourceIds) for (const tag of byId.get(id).keywords) keywordUnion.add(tag);
			const summaryParts = [];
			if (targetRecord && String(targetRecord.summary ?? "").trim()) summaryParts.push(String(targetRecord.summary).trim());
			for (const id of sourceIds) {
				const text = String(byId.get(id).summary ?? "").trim();
				if (text) summaryParts.push(text);
			}
			plan.clusters.push({
				signature,
				workspaceKey,
				target: {
					topicSetId: targetId,
					title: targetTitle,
					members: targetRecord ? targetRecord.members.length : 0,
					createdAt: targetRecord ? targetRecord.createdAt ?? 0 : 0,
					keywords: targetRecord ? [...targetRecord.keywords] : [],
					reason: targetReason,
					...targetRecord ? {} : { toCreate: true }
				},
				sources,
				records: records_,
				membersAfter: merged.length,
				memberChanges,
				keywordsAfter: normalizeTags([...keywordUnion]),
				summaryAfter: clipEllipsis(summaryParts.join("\n"), MERGED_SUMMARY_MAX),
				verifyNature
			});
			built.push({
				cluster: plan.clusters[plan.clusters.length - 1],
				members: merged,
				sourceTitles
			});
		}
		for (const [id, record] of entries) {
			if (clusterMembers.has(id)) continue;
			let best;
			for (const pair of pairs) {
				if (pair.a === id && (!best || pair.score > best.score)) best = {
					id: pair.b,
					score: pair.score
				};
				if (pair.b === id && (!best || pair.score > best.score)) best = {
					id: pair.a,
					score: pair.score
				};
			}
			if (best) plan.borderline.push({
				topicSetId: id,
				title: String(record.title ?? ""),
				partnerId: best.id,
				partnerTitle: String(byId.get(best.id).title ?? ""),
				score: Math.round(best.score * 100) / 100,
				partnerInCluster: clusterMembers.has(best.id)
			});
			const counts = recordCounts(store, id);
			const owned = counts.dispatches + counts.episodes + counts.requirements + counts.questions + counts.routing;
			if (record.members.length === 0 && owned === 0) plan.emptySets.push({
				topicSetId: id,
				title: String(record.title ?? ""),
				createdAt: record.createdAt ?? 0
			});
			else if (record.members.length === 0 && owned > 0) plan.orphans.push({
				topicSetId: id,
				title: String(record.title ?? ""),
				records: counts
			});
		}
	}
	if (options.rename !== void 0) {
		const wanted = String(options.rename ?? "").trim();
		if (!wanted) throw new Error("--rename 的标题不能为空。");
		const existing = plan.clusters.filter((cluster) => !cluster.target.toCreate);
		if (existing.length > 1) throw new Error("--rename 不明确：本批有 " + existing.length + " 个「已有主集」簇（" + existing.map((cluster) => "『" + cluster.target.title + "』").join("、") + "）；请分批执行，或在 SuperMemory 管理台逐个改名。");
		if (existing.length === 0) throw new Error("--rename 无可生效的目标：本批没有「已有主集」簇（一次性验证类簇会新建目标集，标题固定）。");
		const item = built.find((entry) => entry.cluster === existing[0]);
		const to = clipEllipsis(wanted, 60);
		if (item && to && to !== existing[0].target.title) {
			existing[0].target.renameFrom = existing[0].target.title;
			existing[0].target.title = to;
			existing[0].memberChanges = planMemberTitles(item.members, to, tasks, item.sourceTitles);
		}
	}
	for (const cluster of plan.clusters) {
		plan.totals.clusteredSets += cluster.sources.length + 1;
		plan.totals.toArchive += cluster.sources.length;
		plan.totals.membersAfter += cluster.membersAfter;
		plan.totals.dispatches += cluster.records.dispatches;
		plan.totals.episodes += cluster.records.episodes;
		plan.totals.requirements += cluster.records.requirements;
		plan.totals.questions += cluster.records.questions;
		plan.totals.routing += cluster.records.routing;
		if (cluster.target.toCreate) plan.totals.newTargets += 1;
	}
	plan.totals.toArchive += plan.emptySets.length;
	return plan;
}
/** Move every record that points at `from` over to `to`. */
async function moveReferences(store, from, to, now, moved) {
	for (const [id, row] of [...store.dispatches.entries()]) {
		if (row.topicSetId !== from) continue;
		await store.dispatches.update(id, (r) => ({
			...r,
			topicSetId: to,
			updatedAt: now
		})).catch(() => {});
		moved.dispatches += 1;
	}
	for (const [id, row] of [...store.episodes.entries()]) {
		if (row.topicSetId !== from) continue;
		await store.episodes.update(id, (r) => ({
			...r,
			topicSetId: to
		})).catch(() => {});
		moved.episodes += 1;
	}
	for (const [id, row] of [...store.requirements.entries()]) {
		if (row.topicSetId !== from) continue;
		await store.requirements.update(id, (r) => ({
			...r,
			topicSetId: to
		})).catch(() => {});
		moved.requirements += 1;
	}
	for (const [id, row] of [...store.questions.entries()]) {
		if (row.topicSetId !== from) continue;
		await store.questions.update(id, (r) => ({
			...r,
			topicSetId: to,
			updatedAt: now
		})).catch(() => {});
		moved.questions += 1;
	}
	for (const [id, row] of [...store.routing.entries()]) {
		if (row.activeTopicSetId !== from) continue;
		await store.routing.update(id, (r) => ({
			...r,
			activeTopicSetId: to,
			updatedAt: now
		})).catch(() => {});
		moved.routing += 1;
	}
}
/** Write the plan's store rows: mint targets, move references, archive sources. */
async function applyPlanToStore(store, plan) {
	const now = Date.now();
	const moved = zeroCounts();
	const archived = [];
	const created = [];
	const titleChanges = /* @__PURE__ */ new Map();
	for (const cluster of plan.clusters) for (const change of cluster.memberChanges) titleChanges.set(change.sessionId, change.to);
	for (const cluster of plan.clusters) {
		let targetId = cluster.target.topicSetId;
		if (cluster.target.toCreate) {
			targetId = newId("ts");
			await store.topicsets.put(targetId, {
				workspaceKey: cluster.workspaceKey,
				title: cluster.target.title,
				summary: "",
				keywords: [],
				status: "active",
				members: [],
				shapeFingerprint: "",
				shapeGeneratedAt: 0,
				createdAt: now,
				updatedAt: now,
				lastActiveAt: now
			}).catch(() => {});
			created.push(targetId);
		}
		const sourceRecords = cluster.sources.map((source) => ({
			id: source.topicSetId,
			record: store.topicsets.get(source.topicSetId)
		})).filter((row) => !!row.record);
		for (const source of sourceRecords) {
			await moveReferences(store, source.id, targetId, now, moved);
			await store.topicsets.update(source.id, (record) => record ? {
				...record,
				status: "archived",
				updatedAt: now
			} : record).catch(() => {});
			archived.push(source.id);
		}
		const merged = mergeMemberLists(store.topicsets.get(targetId), sourceRecords.map((row) => row.record));
		await store.topicsets.update(targetId, (record) => {
			if (!record) return record;
			return {
				...record,
				title: cluster.target.title,
				members: merged.map((member) => {
					const title = titleChanges.get(member.sessionId);
					return title ? {
						...member,
						title
					} : member;
				}),
				keywords: cluster.keywordsAfter,
				summary: cluster.summaryAfter,
				updatedAt: now,
				lastActiveAt: now
			};
		}).catch(() => {});
	}
	for (const item of plan.emptySets) {
		await store.topicsets.update(item.topicSetId, (record) => record && record.status === "active" ? {
			...record,
			status: "archived",
			updatedAt: now
		} : record).catch(() => {});
		archived.push(item.topicSetId);
	}
	const previous = mergeMarker(store)?.mergeSignatures ?? [];
	const signatures = [.../* @__PURE__ */ new Set([...previous, ...plan.clusters.map((cluster) => cluster.signature)])];
	await store.meta?.put(MARKER_KEY$3, {
		mergesVersion: 1,
		mergeSignatures: signatures,
		lastMergeAt: now
	}).catch(() => {});
	return {
		moved,
		archived,
		created
	};
}
/**
* Apply the plan's member titles to the HOST sessions. A session whose live
* host title was changed by somebody else is skipped, never overwritten.
*/
async function applyPlanToHost(ctx, store, plan, logger) {
	let renamed = 0;
	let skipped = 0;
	for (const cluster of plan.clusters) for (const change of cluster.memberChanges) try {
		const current = currentSessionTitle(ctx, change.sessionId);
		if (current && current !== change.from) {
			skipped += 1;
			logger.info("supermemory: merge title skip " + change.sessionId + " — the host title was renamed by somebody else");
			continue;
		}
		const outcome = await applySessionTitle({
			ctx,
			store,
			logger
		}, {
			sessionId: change.sessionId,
			kind: "other",
			explicitTitle: change.to,
			source: "topicset-merge",
			force: true
		});
		if (outcome.outcome === "host" || outcome.outcome === "fallback") renamed += 1;
	} catch (error) {
		logger.warn("supermemory: merge host title failed for " + change.sessionId + ": " + String(error).slice(0, 160));
	}
	return {
		renamed,
		skipped
	};
}
/**
* Plan (dry-run, the default) or apply the merge. Apply is only reached
* through an explicit caller decision (the /memory merge apply subcommand);
* this function never writes on its own.
*/
async function mergeTopicSets(deps, options = {}) {
	const zeros = {
		clusters: 0,
		archived: 0,
		created: 0,
		moved: zeroCounts(),
		hostRenamed: 0,
		hostSkipped: 0
	};
	const plan = planTopicSetMerges(deps.store, options.rename === void 0 ? {} : { rename: options.rename });
	if (plan.clusters.length === 0 && plan.emptySets.length === 0) return {
		...plan,
		status: "nothing-to-do",
		applied: zeros
	};
	if (options.dryRun !== false) return {
		...plan,
		status: "planned",
		applied: zeros
	};
	const storeResult = await applyPlanToStore(deps.store, plan);
	const host = await applyPlanToHost(deps.ctx, deps.store, plan, deps.logger);
	deps.logger.info("supermemory: topic-set merge applied — clusters " + plan.clusters.length + ", archived " + storeResult.archived.length + ", created " + storeResult.created.length + " (host renamed " + host.renamed + ", skipped " + host.skipped + ")");
	return {
		...plan,
		status: "applied",
		applied: {
			clusters: plan.clusters.length,
			archived: storeResult.archived.length,
			created: storeResult.created.length,
			moved: storeResult.moved,
			hostRenamed: host.renamed,
			hostSkipped: host.skipped
		}
	};
}
/** Human-readable report for the /memory command (and the approval flow). */
function renderMergeReport(result) {
	const lines = ["话题集合并（" + (result.status === "applied" ? "已执行并写库" : result.status === "nothing-to-do" ? "没有可合并的簇" : "预演（未写库，审批后 /memory merge apply 才写）") + "）："];
	lines.push("- 活跃话题集 " + result.totals.activeSets + " 个；拟并入 " + result.totals.clusteredSets + " 个为 " + result.clusters.length + " 簇；另拟归档空集 " + result.emptySets.length + " 个");
	lines.push("- 预计搬迁记录：派发 " + result.totals.dispatches + " / 归档 " + result.totals.episodes + " / 需求 " + result.totals.requirements + " / 问题 " + result.totals.questions + " / 路由 " + result.totals.routing + (result.totals.newTargets > 0 ? "；将新建目标集 " + result.totals.newTargets + " 个" : ""));
	result.clusters.forEach((cluster, index) => {
		lines.push("");
		lines.push("簇 " + (index + 1) + "（" + cluster.workspaceKey + (cluster.verifyNature ? "，一次性验证类" : "") + "）：");
		const target = cluster.target.topicSetId ? "『" + cluster.target.title + "』（" + cluster.target.topicSetId + "，成员 " + cluster.target.members + "）" : "（新建）『" + cluster.target.title + "』";
		lines.push("  · 主集：" + target + "——" + cluster.target.reason);
		if (cluster.target.renameFrom) lines.push("  · 目标集改名：「" + cluster.target.renameFrom + "」→「" + cluster.target.title + "」（成员标题与索引预览均按新标题计算；聚类按原标题进行，不受影响）");
		for (const source of cluster.sources) lines.push("  · 源集：『" + source.title + "』（" + source.topicSetId + "，成员 " + source.members + "，相似分 " + source.score + "；派发 " + source.records.dispatches + " / 归档 " + source.records.episodes + " / 需求 " + source.records.requirements + " / 问题 " + source.records.questions + " / 路由 " + source.records.routing + "）");
		lines.push("  · 合并后：" + (cluster.target.renameFrom ? "目标集改名为『" + cluster.target.title + "』；" : "标题不变；") + "keywords=[" + cluster.keywordsAfter.join("、") + "]；成员 " + cluster.membersAfter + " 个");
		if (cluster.summaryAfter) lines.push("  · 摘要预览：" + clipMarked(cluster.summaryAfter, 120));
		lines.push("  · 成员标题变化 " + cluster.memberChanges.length + " 条：");
		for (const change of cluster.memberChanges) lines.push("    - " + change.sessionId + "：「" + change.from + "」→「" + change.to + "」");
	});
	if (result.emptySets.length > 0) {
		lines.push("");
		lines.push("- 空集归档（0 成员 0 记录，apply 后 archived，不删）：");
		for (const item of result.emptySets) lines.push("  · 『" + item.title + "』（" + item.topicSetId + "）");
	}
	if (result.borderline.length > 0) {
		lines.push("");
		lines.push("- 边界候选（低于合并阈值 9，未合并，供人工判断）：");
		for (const item of result.borderline) lines.push("  · 『" + item.title + "』（" + item.topicSetId + "）↔ 『" + item.partnerTitle + "」（" + item.partnerId + "）" + item.score + " 分" + (item.partnerInCluster ? "（对方在拟议簇内）" : ""));
	}
	if (result.orphans.length > 0) {
		lines.push("");
		lines.push("- 待人工处理（0 成员但仍有记录，未匹配任何簇，保持不动）：");
		for (const item of result.orphans) lines.push("  · 『" + item.title + "』（" + item.topicSetId + "；派发 " + item.records.dispatches + " / 归档 " + item.records.episodes + " / 需求 " + item.records.requirements + " / 问题 " + item.records.questions + " / 路由 " + item.records.routing + "）");
	}
	if (result.status === "applied") {
		lines.push("");
		lines.push("- 源集已全部 archived（不物理删除）；宿主改名 " + result.applied.hostRenamed + " 个，跳过（已被他人改名）" + result.applied.hostSkipped + " 个");
		lines.push("- 合并标记已写入 store.meta.merges；已执行簇不会再次出现。");
	}
	return lines.join("\n");
}
/**
* The meta-table row key of the per-workspace marker. The key is a digest so a
* `per-record` storage layout (which restricts keys to [A-Za-z0-9_-]+) accepts
* it too; the human-readable workspace stays inside the record.
*/
function organizeMarkerKey(workspaceKey) {
	return `organize-${createHash("sha256").update(workspaceKey, "utf8").digest("hex").slice(0, 16)}`;
}
/** The fallback collection: created only when an unplanned entry cannot match anything. */
const ORGANIZE_FALLBACK = {
	key: "other",
	title: "其他结论（待归类）",
	keywords: [
		"supermemory",
		"其他",
		"待归类"
	],
	summary: "整理时尚无法归入现有主题的结论，后续可改名、合并或手动归类。"
};
/**
* The R23 plan. This workspace's ids are stable; on any other workspace the
* ids simply do not exist, so the pass reports "nothing-to-do" and writes
* nothing (a fresh clone never gets five empty collections).
*/
const ORGANIZE_PLAN = {
	version: 1,
	collections: [
		{
			key: "core",
			title: "记忆系统：集合、检索与写入",
			keywords: [
				"supermemory",
				"记忆集合",
				"两级检索",
				"标题标签正文",
				"写入去重",
				"R22"
			],
			summary: "记忆的「集合 + 条目」存储、标题×4/标签×3/正文×1 检索加权、写入侧集合复用与同 key 判定等设计结论。"
		},
		{
			key: "ui",
			title: "面板、管理台与前端交互",
			keywords: [
				"supermemory",
				"面板",
				"管理台",
				"composer",
				"页签",
				"交互修复"
			],
			summary: "SuperMemory 面板 / 管理台 / Web 控制台的布局、页签与交互结论，含 composer 改版、侧栏与前端 bug 修复。"
		},
		{
			key: "branch",
			title: "分支派发与协作机制",
			keywords: [
				"supermemory",
				"分支会话",
				"派发",
				"并行组",
				"问题上交",
				"能力边界"
			],
			summary: "中枢↔分支的派发与并行收敛、分支能力继承、分支提问上交中枢与一话题集多中枢等协作结论。"
		},
		{
			key: "gate",
			title: "构建、测试与重载闸门",
			keywords: [
				"supermemory",
				"typecheck",
				"smoke",
				"build",
				"回归闸门",
				"重载"
			],
			summary: "构建 / 测试 / 重载的验收闸门与典型根因修复，含 arity 漂移类回归的永久闸门与全量测试轮结论。"
		},
		{
			key: "env",
			title: "环境、路径与仓库同步",
			keywords: [
				"supermemory",
				"git同步",
				"GCM凭据",
				"scope推导",
				"工作区隔离"
			],
			summary: "仓库同步与推送凭据、内置能力 scope 从插件位置推导、工作区隔离与重载生效条件等环境类结论。"
		}
	],
	entries: [
		{
			memoryId: "mem-mwmcnex9-ucr9fc",
			collection: "core",
			title: "R22：八项修复完成并重载（记忆集合/派发卡/绿点/面板）",
			keywords: [
				"supermemory",
				"R22",
				"记忆集合",
				"派发卡片",
				"绿点",
				"面板"
			]
		},
		{
			memoryId: "mem-mwmceuq0-a8f89d",
			collection: "core",
			title: "记忆写入先做集合匹配（高/中相似复用、低相似新建）",
			keywords: [
				"supermemory",
				"记忆集合",
				"集合匹配",
				"相似度",
				"同key",
				"写入"
			],
			note: "与 mem-mwmc68di 近重复，保留本条的「并在回执注明」完整表述"
		},
		{
			memoryId: "mem-mwkvpvt2-o0krs2",
			collection: "core",
			title: "R9–R11：分支能力继承、标题/标签/正文检索、话题集页签",
			keywords: [
				"supermemory",
				"R9",
				"R10",
				"R11",
				"分支能力",
				"标题标签正文"
			]
		},
		{
			memoryId: "mem-mwkuup1h-rfvc6d",
			collection: "ui",
			title: "R14 需求：中枢会话改 composer 布局并就地触发对话",
			keywords: [
				"supermemory",
				"R14",
				"中枢会话",
				"composer",
				"就地触发",
				"面板"
			]
		},
		{
			memoryId: "mem-mwkv5n2p-vwum3n",
			collection: "ui",
			title: "R8：中枢会话 composer 布局与首条消息直送",
			keywords: [
				"supermemory",
				"R8",
				"composer",
				"firstMessage",
				"中枢会话",
				"面板"
			],
			appendText: `\n\n（后续更正：R9 起分支会话已继承中枢的文件/shell 能力，本条「分支会话没有文件/shell 工具」的限制已解除，见「R9–R11」条目。）`,
			expectTextSha256: "44ce7ef6cf57fabb4e56e28fa7b094ae2f91cf5dffb1bd31c3a1e66cd7b64a19",
			note: "原文保留，追加 R9 已修复「分支无文件/shell 工具」的更正注记"
		},
		{
			memoryId: "mem-mwkwzlw2-wszibc",
			collection: "ui",
			title: "R18：中枢侧栏/自动三层/分支能力/徽标修复/前端改版（含验收）",
			keywords: [
				"supermemory",
				"R18",
				"中枢侧栏",
				"分支能力",
				"徽标持久化",
				"前端改版",
				"验收"
			],
			text: "R18 完成并验收（2026-11-18，用户六项需求）：①中枢会话侧栏——新增 src/hub-sessions.ts（listHubSessions：过滤 parentSession/subagent/话题集成员含归档，批量读标题，50 条上限，sessionQuery 缺失降级 ctx.sessions.list），并新增 BRANCH_ID_PREFIX='branch-' 恒排除、HUB_ID_PREFIX='session-' 保留；宿主 panel.listHubSessions + wire 三处同步，客户端 panel-page.tsx 改 sm-shell 两栏（760px 折叠），左栏「中枢会话」列表+在线绿点+当前高亮+点击打开+「＋新中枢会话」；真实 /api/state 复测 hubs 11 条、branch- 前缀 0 条、live 1。②自动三层：createTopicSet(cwd,title,tags?,summary?)、memory_new_topicset 参数补齐 tags/summary（原 execute 读但参数未声明，中枢派分支修复）、memory_remember 描述强制 title+tags、面板新建记忆 onBlur 调 suggestMemoryShape 自动补全、新建话题集回读显示 title+tags、createTopicSetSession 首条消息 buildTopicSetOpening 带三层。③徽标 bug 根因：session-badge.tsx 的 badgeCache 永久缓存 {kind:'hub'}，分支后来入集也不显示；修法 branch 永久缓存、hub 8s TTL、导出 invalidateBadge + api.invalidateBadges()。④分支能力：src/capabilities.ts 四档（read/read-write/full/minimal）→ agentCtx.tools.restrict({deny})（必须 agent scope 调，全局 ctx 调会抛 requires a scoped context），src/script-delegation.ts buildDispatchScript 把「本轮能力边界」写进分支首条消息，memory_dispatch 新增 capabilities 参数（默认 read-write）。⑤中枢软约定：supermemory:hub-role systemPrompt（order 901，currentInitiator/scope 判定，分支不注入；已在会话 prompt 生效可见），不摘工具。⑥前端改版：面板 8px 栅格/10px 圆角/tab 下划线/空状态插画/按钮分层；管理台左侧固定五段导航+卡片列表+760px 折叠+明暗双主题。闸门（中枢复跑）：tsc 双 0 错、core 6 / mechanism 38（修复后）/ webui 27 / client-sim OK、build 宿主 9 文件（含 hub-sessions chunk）+ client 87298 字符（89065 bytes）。已 plugin_manager 对 include:supermemory 禁用→启用重载，需刷新 http://127.0.0.1:62590；管理台端口每次重载会变，用 memory_ui 取新令牌 URL。",
			expectTextSha256: "888ee36ce351ab96b015df3354df04554ab8bc55a56f09236f40904a556b2c21",
			note: "合并 R18 完成条目与 R18 最终验收条目（验收细节并入）"
		},
		{
			memoryId: "mem-mwkysqcq-jbbgqm",
			collection: "branch",
			title: "R19：并行多分支、关联分支展示与一话题集多中枢",
			keywords: [
				"supermemory",
				"R19",
				"并行分支",
				"关联分支",
				"分支共享",
				"中枢"
			]
		},
		{
			memoryId: "mem-mwkytofa-m9t57p",
			collection: "branch",
			title: "R20：分支先干活、问题上交中枢、中枢一次提问",
			keywords: [
				"supermemory",
				"R20",
				"分支提问",
				"中枢汇总",
				"派发",
				"协作"
			]
		},
		{
			memoryId: "mem-mwm4s24n-bly8s9",
			collection: "gate",
			title: "R21：全量测试轮、7 处前端 bug 与能力 exit 127 根治",
			keywords: [
				"supermemory",
				"R21",
				"全量测试",
				"前端bug",
				"capability",
				"回归闸门"
			]
		},
		{
			memoryId: "mem-mwm3gz5g-1f715w",
			collection: "gate",
			title: "面板「加载失败」根因：客户端 listTools 声明缺 cwd",
			keywords: [
				"supermemory",
				"面板",
				"listTools",
				"arity",
				"远程方法",
				"回归闸门"
			]
		},
		{
			memoryId: "mem-mwm2i0r9-63205r",
			collection: "env",
			title: "git 同步：origin/HEAD 状态、提交历史与 GCM 推送凭据",
			keywords: [
				"supermemory",
				"git",
				"同步",
				"GCM凭据",
				"origin",
				"HEAD"
			],
			text: "仓库 F:\\10-SuperMemory 的 git 同步状态与推送路径（2026-11-18 核实）：远程 origin = http://<内网 Gitee>/<旧帐号名>/SuperMemory.git（内网 Gitee，主机可达 HTTP 200），本地 main 跟踪 origin/main。R15–R20 的改动已打包为提交 897a02357b85a4a1a1813af56d7287c43192c405（49 文件，+12235/−1324，信息 feat(rounds-15-20): 面板注册自愈 / 中枢 composer 与侧栏 / 记忆记录形态 / 分支问题上交）并已推送，origin/main 与该提交一致。此后 HEAD 更新为 60f0f02「feat(round-26): 工作区隔离 / 能力持续维护 / 分支会话重启保留」，与 origin/main 完全一致，工作区干净、无未跟踪文件。后续同步流程：git fetch origin → 若 origin/main 领先则 pull --rebase；有本地源码改动则 add/commit 后 GIT_TERMINAL_PROMPT=0 git push origin main。凭据：scripts/git-sync-push.sh 的 store 凭据方案已失效（~/.git-credentials 不存在，脚本必报 could not read Username for 'http://<内网 Gitee>'，退出码 1）；当前可用默认 GCM（helper=manager，Windows 凭据存储），若 GCM 也失效再找用户要凭据。仓库内另有 scripts/git-sync-push.mjs / .sh 同步脚本。",
			expectTextSha256: "866e5b78b5c14e59251250f58dbca3d8d15ece8120c9e290f3d5e451752ff2e2",
			note: "合并 git 凭据条目与仓库同步条目（897a02 提交、GCM 路径并入）"
		},
		{
			memoryId: "mem-mwm3msyt-1unad2",
			collection: "env",
			title: "内置 git-sync 能力 scope 从插件位置推导（v2）",
			keywords: [
				"supermemory",
				"builtin",
				"git-sync",
				"scope",
				"工作区隔离",
				"路径推导"
			]
		}
	],
	deletes: [
		{
			memoryId: "mem-mwm3hbj6-0vrci3",
			title: "写入结论性记忆（标题+标签+正文：根因、修复位置、验证结果、生效条件）",
			reason: "占位：复述写入规则、无任何结论内容",
			expectTextSha256: "a308c3fef1f89ba9f5d7636e7dffe54059156714786e2204fd300fc2df09118d"
		},
		{
			memoryId: "mem-mwm3nb8q-7fi9ub",
			title: "写结论性记忆",
			reason: "占位：正文仅 7 字「写结论性记忆」，无结论内容",
			expectTextSha256: "6a1495c9f844cb14353f5456884541b0d7a7757151932661e882f8239a3cf89e"
		},
		{
			memoryId: "mem-mwm3sim8-2b610a",
			title: "本任务是并行组 grp-mwm3q5gw-df0g7d 的一员：只负责这一个任务",
			reason: "派发包装文本（并行组说明），是过程消息不是结论",
			expectTextSha256: "f35228f63b1ee98868fa42076dea60d29a80e8337673cef913703f22a2018a33"
		},
		{
			memoryId: "mem-mwmbx5th-pzz88r",
			title: "本任务是并行组 grp-mwmbphig-uy8ihi 的一员：只负责这一个任务",
			reason: "派发包装文本（并行组说明），是过程消息不是结论",
			expectTextSha256: "26260a72b997bc09e95b93011eb81ba40c4e3c8bb161957509bd63202bd94779"
		},
		{
			memoryId: "mem-mwm4wh5d-w3fk69",
			title: "本消息是被中断任务的续跑（原派发 dsp-mwkyjskq-92lsyb，原分支 branch…",
			reason: "续跑包装文本（被中断任务说明），是过程消息不是结论",
			expectTextSha256: "c13b03c147f22696c094ece2af374c8fb64e1caa5115dc5c2d676dfb49fa0aeb"
		},
		{
			memoryId: "mem-mwmcpcf1-i5qgso",
			title: "本消息是被中断任务的续跑（原派发 dsp-mwmbphig-ks97ye，原分支 branch…",
			reason: "续跑包装文本（被中断任务说明），是过程消息不是结论",
			expectTextSha256: "4322554de1e6f7898ac9f00b9e06d18835b9a4ca9e7071ec6d020267de136009"
		},
		{
			memoryId: "mem-mwmc68di-ybrsaz",
			title: "先做集合匹配（标题/标签/正文相似度，分高/中/低三档），高相似直接复用该集合新增条目，回执注…",
			reason: "与 mem-mwmceuq0 近重复；后者表述更完整（「并在回执注明」），本条无独有信息",
			mergedInto: "mem-mwmceuq0-a8f89d",
			expectTextSha256: "2c236b8df4babdffea87c01e14a7eea0e5c824ec804a0f241e357897431cae16"
		},
		{
			memoryId: "mem-mwl4tso5-mlaney",
			title: "SuperMemory 仓库同步：sync 脚本凭据方案失效，改用 GCM 默认路径推送",
			reason: "已并入 git 同步条目：凭据失效原因、GCM 路径、退出码 1 事实全部保留",
			mergedInto: "mem-mwm2i0r9-63205r",
			expectTextSha256: "5ddc730840d161a0e1ce00965280694f16ea2c14e4186ddfd0ecb216c3978526"
		},
		{
			memoryId: "mem-mwl4v8sy-jbnr4d",
			title: "SuperMemory 仓库已同步云端：origin 为内网 Gitee，main↔origin",
			reason: "已并入 git 同步条目：897a02 提交（49 文件/+12235/−1324）与推送事实全部保留",
			mergedInto: "mem-mwm2i0r9-63205r",
			expectTextSha256: "ed9cae27b0c45832f3eeec0f744c33f0477192b4ec82c5549192dac56befae2b"
		},
		{
			memoryId: "mem-mwkx49qw-dbeb4j",
			title: "R18 最终验收：六项需求全部生效（含两处修复：branch 过滤、topicset 工具参数）",
			reason: "已并入 R18 完成条目：BRANCH_ID_PREFIX 修复、/api/state 复测、参数补齐根因全部保留",
			mergedInto: "mem-mwkwzlw2-wszibc",
			expectTextSha256: "5bbdbbf150a122f75ab46d14c2b06bebf2324ae836618e54244aef9033f42c5b"
		}
	],
	oldCollectionIds: [
		"mc-mwmcnchi-ri6xeg",
		"mc-mwmcnely-8v9uoe",
		"mc-mwmcner7-xo93br",
		"mc-mwmcnet9-mf0vgb",
		"mc-mwmcneuy-z7ladr",
		"mc-mwmcnevu-dbwfyz"
	],
	oldCollectionTitles: {
		"mc-mwmcnchi-ri6xeg": "supermemory 记忆",
		"mc-mwmcnely-8v9uoe": "r8 记忆",
		"mc-mwmcner7-xo93br": "写入 记忆",
		"mc-mwmcnet9-mf0vgb": "grp-mwm3q5gw-df0g7d 记忆",
		"mc-mwmcneuy-z7ladr": "dsp-mwkyjskq-92lsyb 记忆",
		"mc-mwmcnevu-dbwfyz": "key 记忆"
	}
};
function sha256(text) {
	return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}
function activeEntries(store, workspaceKey) {
	return [...store.memories.entries()].filter(([, row]) => row.workspaceKey === workspaceKey && row.status === "active");
}
function activeCollections(store, workspaceKey) {
	return collectionRows(store).filter(([, row]) => row.workspaceKey === workspaceKey && row.status !== "archived");
}
function workspaceCollection(store, workspaceKey, id) {
	if (!id) return void 0;
	const found = store.memoryCollections.get(id);
	return found && found.workspaceKey === workspaceKey ? [id, found] : void 0;
}
/** Current-state projection by collection title (empty collections included). */
function organizeState(store, workspaceKey) {
	const active = activeEntries(store, workspaceKey);
	const views = activeCollections(store, workspaceKey).map(([id, row]) => ({
		id,
		title: row.title,
		keywords: [...row.keywords ?? []],
		summary: row.summary ?? "",
		entryCount: 0
	}));
	const byId = new Map(views.map((view) => [view.id, view]));
	let uncollected = 0;
	let inactive = 0;
	const uncollectedRows = [];
	for (const [memoryId, memory] of active) {
		const collection = memory.collectionId ? byId.get(memory.collectionId) : void 0;
		if (!collection) {
			uncollected += 1;
			uncollectedRows.push({
				memoryId,
				title: memory.title ?? ""
			});
			continue;
		}
		collection.entryCount += 1;
	}
	for (const [, memory] of store.memories.entries()) if (memory.workspaceKey === workspaceKey && memory.status !== "active") inactive += 1;
	return {
		counts: {
			collections: views.length,
			entries: active.length,
			uncollected,
			emptyCollections: views.filter((view) => view.entryCount === 0).length,
			inactive
		},
		collections: views,
		uncollected: uncollectedRows
	};
}
/** A pre-R23 collection still carries the title the plan was authored against. */
function isRetiredCollection(plan, id, title) {
	const expected = plan.oldCollectionTitles?.[id];
	return expected === void 0 || expected === title;
}
function collectionBag(spec, workspaceKey) {
	return [spec.key, {
		workspaceKey,
		title: spec.title,
		keywords: spec.keywords,
		summary: spec.summary,
		status: "active",
		createdAt: 0,
		updatedAt: 0
	}];
}
/**
* Build the current-state plan. Pure over the store; no writes. Missing rows
* make the plan smaller (the pass remains safe if it is re-run after a partial
* failure), and changed bodies are moved to `conflicts`, not overwritten.
*/
function planMemoryOrganize(store, workspaceKey, plan = ORGANIZE_PLAN) {
	const state = organizeState(store, workspaceKey);
	const collections = activeCollections(store, workspaceKey);
	const present = [];
	const missing = [];
	const conflicts = [];
	for (const item of plan.entries) {
		const memory = store.memories.get(item.memoryId);
		if (!memory || memory.workspaceKey !== workspaceKey || memory.status !== "active") {
			missing.push(item);
			continue;
		}
		const satisfied = item.text !== void 0 ? memory.text === item.text : item.appendText !== void 0 && memory.text.includes(item.appendText.trim());
		if (item.expectTextSha256 && (item.text !== void 0 || item.appendText !== void 0) && !satisfied && sha256(memory.text) !== item.expectTextSha256) {
			conflicts.push({
				memoryId: item.memoryId,
				title: memory.title ?? "",
				action: "replace-text",
				reason: "正文与整理计划制定时不一致（可能被手动编辑），保留现状不覆盖"
			});
			present.push({
				...item,
				text: void 0,
				appendText: void 0
			});
			continue;
		}
		present.push(item);
	}
	const presentIds = new Set(present.map((item) => item.memoryId));
	const deletions = [];
	for (const item of plan.deletes) {
		const memory = store.memories.get(item.memoryId);
		if (!memory || memory.workspaceKey !== workspaceKey) continue;
		let willDelete = true;
		if (sha256(memory.text) !== item.expectTextSha256) {
			willDelete = false;
			const blockedReason = "正文与整理计划制定时不一致，保留该条";
			deletions.push({
				...item,
				willDelete,
				blockedReason
			});
			conflicts.push({
				memoryId: item.memoryId,
				title: memory.title ?? item.title,
				action: item.mergedInto ? "merge" : "delete",
				reason: "正文与整理计划制定时不一致，保留该条（不删除、不合并）"
			});
			continue;
		}
		deletions.push({
			...item,
			willDelete
		});
	}
	const deleteIds = new Set(plan.deletes.map((item) => item.memoryId));
	const unknown = [];
	for (const [memoryId, memory] of activeEntries(store, workspaceKey)) {
		if (presentIds.has(memoryId) || deleteIds.has(memoryId)) continue;
		unknown.push({
			memoryId,
			title: memory.title ?? "",
			text: memory.text,
			...memory.collectionId ? { collectionId: memory.collectionId } : {}
		});
	}
	const collectionSpecs = plan.collections.map((spec) => {
		const existing = collections.find(([, row]) => row.title.trim().toLowerCase() === spec.title.trim().toLowerCase());
		return {
			...spec,
			...existing ? { existingId: existing[0] } : {}
		};
	});
	const oldCollections = collections.filter(([id, row]) => plan.oldCollectionIds.includes(id) && isRetiredCollection(plan, id, row.title));
	const nothingToDo = present.length === 0 && deletions.length === 0 && oldCollections.length === 0;
	return {
		nothingToDo,
		...nothingToDo ? { reason: "当前工作区没有与整理计划匹配的记忆/集合（计划只针对本插件仓库工作区），未写任何数据。" } : {},
		before: state.counts,
		collections: collectionSpecs,
		present,
		missing,
		deletions,
		conflicts,
		unknown,
		oldCollections
	};
}
/** Default backup directory: next to the storage file, never in the repo. */
function defaultBackupDir() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "storages", "supermemory-backups");
}
async function writeBackup(store, workspaceKey, plan, now, dir) {
	const memories = {};
	for (const [id, row] of store.memories.entries()) if (row.workspaceKey === workspaceKey) memories[id] = row;
	const collections = {};
	for (const [id, row] of store.memoryCollections.entries()) if (row.workspaceKey === workspaceKey) collections[id] = row;
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const path = join(dir, `organize-v1-${stamp}.json`);
	await mkdir(dir, { recursive: true });
	await writeFile(path, JSON.stringify({
		kind: "supermemory-memory-organize-backup",
		version: 1,
		workspaceKey,
		createdAt: now,
		note: "R23 整理前快照：只含 memories / memory_collections 两个受影响表，可直接手工回填。",
		planned: {
			collections: plan.collections.map((spec) => spec.title),
			mappings: plan.present.map((item) => ({
				memoryId: item.memoryId,
				title: item.title
			})),
			deletions: plan.deletions.map((item) => ({
				memoryId: item.memoryId,
				title: item.title,
				reason: item.reason
			}))
		},
		memories,
		memoryCollections: collections
	}, null, 2), "utf8");
	return path;
}
function newCollection(workspaceKey, spec, now) {
	return {
		workspaceKey,
		title: spec.title.slice(0, 48),
		keywords: spec.keywords,
		summary: spec.summary,
		status: "active",
		createdAt: now,
		updatedAt: now
	};
}
function sameTags(left, right) {
	return left.length === right.length && left.every((tag, index) => tag === right[index]);
}
function cloneStore(store) {
	const cloneRows = (rows) => new Map([...rows].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
	const memories = cloneRows(store.memories.entries());
	const collections = cloneRows(store.memoryCollections.entries());
	const meta = cloneRows(store.meta.entries());
	const tableOf = (rows) => ({
		get: (key) => rows.get(key),
		entries: () => rows.entries(),
		put: async (key, value) => {
			rows.set(key, value);
		},
		update: async (key, fn) => {
			rows.set(key, fn(rows.get(key)));
		},
		delete: async (key) => rows.delete(key)
	});
	return {
		memories: tableOf(memories),
		memoryCollections: tableOf(collections),
		meta: tableOf(meta)
	};
}
/**
* Dry-run the plan on a deep copy of the store: the exact same code path as
* apply, so the projection cannot drift from what apply would do. Nothing is
* written to the real store, no backup file is created and no marker is set.
*/
async function previewMemoryOrganize(store, workspaceKey, plan = ORGANIZE_PLAN) {
	return applyMemoryOrganize(store, workspaceKey, {
		plan,
		dryRun: true,
		ignoreMarker: true
	});
}
/**
* Apply the plan through the live store.
*
* Ordering: backup → collections → entry updates → unknown assignment →
* deletions (only after a merge keeper was written) → old collection cleanup →
* verification sweep → marker. A failure before the marker leaves a partial
* state that a re-run completes (the plan is rebuilt from current state).
*/
async function applyMemoryOrganize(store, workspaceKey, options = {}) {
	const now = options.now ?? Date.now();
	const planData = options.plan ?? ORGANIZE_PLAN;
	const logger = options.logger;
	const markerKey = organizeMarkerKey(workspaceKey);
	if (options.dryRun) store = cloneStore(store);
	if (!options.ignoreMarker && !options.dryRun) {
		const marker = store.meta.get(markerKey);
		if (marker && (marker.organizeVersion ?? 0) >= planData.version) {
			const state = organizeState(store, workspaceKey);
			return {
				status: "already-done",
				before: state.counts,
				after: state.counts,
				collections: state.collections,
				mappings: [],
				deletions: [],
				conflicts: [],
				unknownAssignments: [],
				...marker.organizeBackup ? { backupPath: marker.organizeBackup } : {},
				marker: true,
				reason: `整理标记已存在（v${marker.organizeVersion}），未重复执行。`
			};
		}
	}
	const planned = planMemoryOrganize(store, workspaceKey, planData);
	if (planned.nothingToDo) return {
		status: "nothing-to-do",
		before: planned.before,
		collections: organizeState(store, workspaceKey).collections,
		mappings: [],
		deletions: [],
		conflicts: planned.conflicts,
		unknownAssignments: [],
		...planned.reason ? { reason: planned.reason } : {}
	};
	const backupPath = options.dryRun ? void 0 : await writeBackup(store, workspaceKey, planned, now, options.backupDir ?? defaultBackupDir());
	const collectionIds = /* @__PURE__ */ new Map();
	for (const spec of planned.collections) {
		const existing = activeCollections(store, workspaceKey).find(([, row]) => row.title.trim().toLowerCase() === spec.title.trim().toLowerCase());
		if (existing) {
			collectionIds.set(spec.key, existing[0]);
			continue;
		}
		const id = newId("mc");
		await store.memoryCollections.put(id, newCollection(workspaceKey, spec, now));
		collectionIds.set(spec.key, id);
	}
	const collectionIdFor = (key) => collectionIds.get(key);
	const mappings = [];
	for (const item of planned.present) {
		const memory = store.memories.get(item.memoryId);
		if (!memory) continue;
		const collectionId = collectionIdFor(item.collection);
		if (!collectionId) continue;
		const fromTitle = workspaceCollection(store, workspaceKey, memory.collectionId)?.[1].title ?? "";
		const spec = planData.collections.find((row) => row.key === item.collection);
		const next = {
			...memory,
			title: item.title.slice(0, 48),
			keywords: item.keywords,
			collectionId,
			updatedAt: now
		};
		if (item.text !== void 0) next.text = item.text;
		else if (item.appendText !== void 0 && !memory.text.includes(item.appendText.trim())) next.text = `${memory.text}${item.appendText}`;
		const textChanged = next.text !== memory.text;
		const titleChanged = next.title !== (memory.title ?? "");
		const tagsChanged = !sameTags(memory.keywords ?? [], item.keywords);
		if (textChanged || titleChanged || tagsChanged || memory.collectionId !== collectionId) await updateMemoryVersioned(store, workspaceKey, item.memoryId, {
			title: next.title,
			text: next.text,
			tags: next.keywords,
			collectionId
		}, now);
		mappings.push({
			memoryId: item.memoryId,
			title: item.title,
			fromCollection: fromTitle,
			toCollection: spec?.title ?? item.collection,
			titleChanged,
			tagsChanged,
			textChanged,
			...item.note ? { note: item.note } : {}
		});
	}
	const unknownAssignments = [];
	let fallbackId;
	const ensureFallback = async () => {
		if (fallbackId) return fallbackId;
		const existing = activeCollections(store, workspaceKey).find(([, row]) => row.title.trim().toLowerCase() === ORGANIZE_FALLBACK.title.trim().toLowerCase());
		if (existing) {
			fallbackId = existing[0];
			return fallbackId;
		}
		const id = newId("mc");
		await store.memoryCollections.put(id, newCollection(workspaceKey, ORGANIZE_FALLBACK, now));
		fallbackId = id;
		return id;
	};
	const assignUnknown = async (row) => {
		const memory = store.memories.get(row.memoryId);
		if (!memory) return;
		const match = bestCollectionFor({
			title: row.title,
			keywords: memory.keywords ?? [],
			summary: row.text
		}, planData.collections.map((spec) => collectionBag(spec, workspaceKey)));
		let targetId;
		let targetTitle = ORGANIZE_FALLBACK.title;
		if (match && match.tier !== "low") {
			const key = planData.collections.find((spec) => spec.title === match.title)?.key;
			targetId = key ? collectionIdFor(key) : void 0;
			if (key && !targetId) targetId = await ensureFallback();
			if (key) targetTitle = match.title;
		}
		if (!targetId) {
			targetId = await ensureFallback();
			targetTitle = ORGANIZE_FALLBACK.title;
		}
		if (memory.collectionId !== targetId) await updateMemoryVersioned(store, workspaceKey, row.memoryId, { collectionId: targetId }, now);
		unknownAssignments.push({
			memoryId: row.memoryId,
			title: row.title,
			collection: targetTitle
		});
	};
	for (const row of planned.unknown) await assignUnknown(row);
	const deletionViews = [];
	for (const item of planned.deletions) {
		const view = { ...item };
		if (view.willDelete && item.mergedInto) {
			const keeper = store.memories.get(item.mergedInto);
			const expectedText = planData.entries.find((row) => row.memoryId === item.mergedInto)?.text;
			if (!(!!keeper && (expectedText === void 0 || keeper.text === expectedText))) {
				view.willDelete = false;
				view.blockedReason = "合并目标未写入合并正文，保留该条避免丢信息";
				planned.conflicts.push({
					memoryId: item.memoryId,
					title: item.title,
					action: "merge",
					reason: `合并目标 ${item.mergedInto} 未写入成功，保留本条避免丢信息`
				});
			}
		}
		if (view.willDelete) await store.memories.delete(item.memoryId);
		deletionViews.push(view);
	}
	for (const [memoryId, memory] of store.memories.entries()) {
		if (memory.workspaceKey !== workspaceKey) continue;
		const current = workspaceCollection(store, workspaceKey, memory.collectionId);
		const retired = current !== void 0 && planData.oldCollectionIds.includes(current[0]) && isRetiredCollection(planData, current[0], current[1].title);
		if (current && !retired) continue;
		await assignUnknown({
			memoryId,
			title: memory.title ?? "",
			text: memory.text,
			...memory.collectionId ? { collectionId: memory.collectionId } : {}
		});
	}
	for (const [id, row] of planned.oldCollections) {
		if ([...store.memories.entries()].some(([, memory]) => memory.workspaceKey === workspaceKey && memory.collectionId === id)) {
			planned.conflicts.push({
				memoryId: "",
				title: row.title,
				action: "delete",
				reason: `旧集合仍被条目引用，保留未删除（id ${id}）`
			});
			continue;
		}
		await store.memoryCollections.delete(id);
	}
	const after = organizeState(store, workspaceKey);
	if (!options.dryRun) await store.meta.put(markerKey, {
		organizeVersion: planData.version,
		organizeAppliedAt: now,
		organizeWorkspace: workspaceKey,
		organizeBackup: backupPath,
		organizeSummary: `${after.counts.collections} 个集合 / ${after.counts.entries} 条条目`
	});
	if (!options.dryRun) logger?.info(`supermemory: memory organize applied — ${mappings.length} entries mapped, ${deletionViews.filter((row) => row.willDelete).length} removed, ${after.counts.collections} collections; backup ${backupPath}`);
	return {
		status: options.dryRun ? "preview" : "applied",
		before: planned.before,
		after: after.counts,
		collections: after.collections,
		mappings,
		deletions: deletionViews,
		conflicts: planned.conflicts,
		unknownAssignments,
		...backupPath ? { backupPath } : {},
		marker: options.dryRun ? false : true
	};
}
/** Human-readable report for /memory-organize and the startup log. */
function renderMemoryOrganizeReport(result) {
	const lines = [`记忆整理（${result.status === "applied" ? "已执行并写库" : result.status === "already-done" ? "整理标记已存在，未重复执行" : result.status === "preview" ? "预演，未写库" : "无需整理"}）：`];
	if (result.reason) lines.push("- 说明：" + result.reason);
	const before = result.before;
	lines.push(`- 整理前：${before.collections} 个集合 / ${before.entries} 条条目 / 未归集 ${before.uncollected} / 空集合 ${before.emptyCollections} / 已停用 ${before.inactive}`);
	if (result.after) {
		const after = result.after;
		lines.push(`- 整理后：${after.collections} 个集合 / ${after.entries} 条条目 / 未归集 ${after.uncollected} / 空集合 ${after.emptyCollections}`);
	}
	if (result.collections.length > 0) {
		lines.push("- 集合与条目数：");
		for (const row of result.collections) lines.push(`  · ${row.title}（${row.entryCount} 条）`);
	}
	if (result.mappings.length > 0) {
		lines.push("- 归属调整：" + result.mappings.length + " 条");
		for (const row of result.mappings) {
			const changes = [];
			if (row.fromCollection !== row.toCollection) changes.push(`集合「${row.fromCollection || "未归集"}」→「${row.toCollection}」`);
			if (row.titleChanged) changes.push("标题已修正");
			if (row.tagsChanged) changes.push("标签已规范");
			if (row.textChanged) changes.push("正文已合并/补注");
			lines.push(`  · ${row.title}（${changes.join("；") || "已符合"}）${row.note ? " — " + row.note : ""}`);
		}
	}
	if (result.deletions.length > 0) {
		lines.push("- 删除/吸收清单：");
		for (const row of result.deletions) {
			const state = row.willDelete ? result.status === "preview" ? "将删除" : "已删除" : "保留：" + (row.blockedReason ?? "正文已变");
			lines.push(`  · 「${row.title}」— ${state}；${row.reason}${row.mergedInto ? "；并入 " + row.mergedInto : ""}`);
		}
	}
	if (result.unknownAssignments.length > 0) {
		lines.push("- 计划外条目（整理后新写入的）：");
		for (const row of result.unknownAssignments) lines.push(`  · ${row.title} → 「${row.collection}」`);
	}
	if (result.conflicts.length > 0) {
		lines.push("- 冲突（保持现状）：");
		for (const row of result.conflicts) lines.push(`  · ${row.title || row.memoryId}：${row.reason}`);
	}
	if (result.backupPath) lines.push("- 原始数据备份：" + result.backupPath);
	if (result.marker && result.status === "applied") lines.push("- 整理标记已写入 store.meta（重启不会重复执行）。");
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
	["merge", "话题集合并治理：/memory-merge [dry-run|apply] [--rename <标题>]（默认 dry-run 不写库；--rename 只改「已有主集」簇的目标标题）"],
	["organize", "整理记忆集合：/memory-organize [preview|apply]（默认查看整理后状态；preview 只预演不写库）"],
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
		case "merge": {
			const raw = arg.trim();
			let rename;
			let rest = raw;
			const flag = rest.match(/--rename(?:=|\s+)([\s\S]+)$/);
			if (flag) {
				rename = flag[1].trim();
				rest = rest.slice(0, flag.index).trim();
			}
			const apply = /^(apply|执行|应用)$/i.test(rest);
			const dryRun = !rest || /^(dry[-_ ]?run|预览|预演)$/i.test(rest);
			if (!apply && !dryRun) return {
				kind: "error",
				text: "用法：/memory merge [dry-run|apply] [--rename <标题>]（默认 dry-run 只预览不写库；apply 才写库；--rename 仅改「已有主集」簇的目标标题，存在多个已有主集簇时请分批或用管理台逐个改名）"
			};
			let result;
			try {
				result = await mergeTopicSets({
					ctx: deps.ctx,
					store,
					logger: deps.logger
				}, {
					dryRun,
					...rename === void 0 ? {} : { rename }
				});
			} catch (error) {
				return {
					kind: "error",
					text: String(error?.message ?? error).slice(0, 300)
				};
			}
			return {
				kind: "success",
				text: renderMergeReport(result)
			};
		}
		case "organize": {
			const mode = arg.trim().toLowerCase();
			if (mode === "preview" || mode === "dry-run" || mode === "预演") return {
				kind: "success",
				text: renderMemoryOrganizeReport(await previewMemoryOrganize(store, workspaceKey))
			};
			if (mode === "apply" || mode === "执行" || mode === "应用") return {
				kind: "success",
				text: renderMemoryOrganizeReport(await applyMemoryOrganize(store, workspaceKey, {
					ignoreMarker: true,
					logger: deps.logger
				}))
			};
			if (mode) return {
				kind: "error",
				text: "用法：/memory-organize [preview|apply]（默认查看当前集合状态；preview 只预演；apply 手动重跑并写库）"
			};
			return {
				kind: "success",
				text: renderMemoryOrganizeReport(await applyMemoryOrganize(store, workspaceKey, { logger: deps.logger }))
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
			const { scanWorkspace, filemapEntries } = await import("./filemap-MJ8pEDq8.js").then((n) => n.n);
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
			const { buildExport } = await import("./export-DDAzZlQr.js").then((n) => n.n);
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
			for (const [, episode] of store.episodes.entries()) if (episode.topicSetId === active && episode.summary) bits.push(clipMarked(episode.summary, 120));
			const summary = clipMarked(bits.slice(-6).join(" / "), 500);
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
const HELP = "status 状态总览 · topicsets 话题集列表 · switch <名> 激活 · new <标题> 新建 · model 模型管理 · tools 能力（知识面 + 执行面） · reqs 需求 · resume 续跑中断任务 · wrap 更新梗概 · scan/export（P2） · ui 可视化管理台（Plan A）\nmerge：存量话题集合并治理（相似簇→主集，源集 archived 不删）。/memory-merge 预览清单（dry-run 不写库）；/memory-merge apply 执行；\n  --rename <标题>：同时把「已有主集」簇的目标集改名（dry-run 预览即最终形态；存在多个已有主集簇时请分批或用管理台）。\norganize：记忆集合整理（集合重排 / 合并近重复 / 清理占位）。/memory-organize 查看整理后状态；/memory-organize preview 预演不写库；apply 手动重跑；启动时已标记守卫自动执行一次。\nresume：被中断的任务（插件重载/关闭或 DSH 退出导致，分支会话已保留）。/memory-resume 查看清单；/memory-resume <dispatchId...> 续跑指定任务（优先续接原分支会话）。\n快捷方式：每个子命令都是独立命令，输入 /memory 后可在列表里直接选择（如 /memory-ui、/memory-status、/memory-topicsets）；也可用 /memory <子命令> <参数>。";
/** R6/R50: /memory tools — list / edit / describe / enable / retire capabilities. */
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
			text: "（暂无能力；R50 起自动路径只生成待接受的知识提案。用 memory_toolize register 登记能力，或 accept 接受提案）"
		};
		return {
			kind: "success",
			text: [
				"能力（知识面 + 执行面，可编辑）：",
				...rows.map((row) => [
					`- ${row.name}（${row.status}${row.live ? "" : "，未注册"}，执行 ${row.useCount} 次 / 加载 ${row.loadCount ?? 0} 次，转化率 ${row.loadsToRuns ?? 0}）`,
					`  简介：${row.description || "（无）"}`,
					row.entry ? `  入口：${row.entry}${row.dryRunArg ? `（默认预演 ${row.dryRunArg}）` : ""}` : "  入口：（仅知识）",
					row.entryDraft ? `  入口草稿（未验证）：${row.entryDraft}` : "",
					`  知识面：${row.skillPath || "（无）"}`,
					`  id=${row.id}`
				].filter(Boolean).join("\n")),
				"",
				"编辑：/memory tools edit <id> {\"description\":\"…\",\"body\":\"…\"}",
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
				const memoryId = await rememberFact(activeStore, workspaceKey, fact.text, fact.keywords, task.sessionId, user.seq, now, {
					ctx,
					logger
				});
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
		const taskText = users.map((user) => user.text).filter(Boolean).join("\n").slice(0, 2e3);
		await countSequenceSignal(activeStore, ctx, task.sessionId, workspaceKey, cursor, task.seq, config, logger, taskText, now);
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
* One turn's tool sequence feeds the tool-ization pipeline: R48's task signature
* (a repeated TASK becomes a skill) plus, only when the legacy autoComposite
* switch is on, a PENDING proposal for a sequence that names a business object.
* R49: nothing here registers a composite — memory_toolize accept is the only
* sequence entrance.
*/
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
async function countSequenceSignal(store, ctx, sessionId, workspaceKey, afterSeq, untilSeq, config, logger, taskText, now = Date.now()) {
	const tools = [];
	const args = [];
	const successes = [];
	const callIndex = /* @__PURE__ */ new Map();
	try {
		const handle = await ctx.sessionPersistence.open(sessionId, "read");
		try {
			const { events } = await handle.read(afterSeq + 1);
			for (const event of events) {
				if (event.seq > untilSeq) break;
				if (event.type === "tool/call") {
					const data = event.data;
					if (!data.name) continue;
					const index = tools.length;
					tools.push(data.name);
					args.push(parseArgs(data.arguments));
					successes.push(false);
					if (typeof data.callId === "string") callIndex.set(data.callId, index);
					continue;
				}
				if (event.type === "tool/result") {
					const data = event.data;
					const callId = data.message?.callId;
					if (typeof callId !== "string") continue;
					const index = callIndex.get(callId);
					if (index === void 0) continue;
					successes[index] = data.message?.isError !== true;
				}
			}
		} finally {
			await handle.close();
		}
	} catch {
		return;
	}
	if (tools.length < 2) return;
	const { recordTurnSequences, recycleIdleCapabilities } = await import("./toolize-D1gmjN2c.js");
	const toolize = {
		enabled: config.autoToolize,
		autoSkill: config.autoSkill,
		threshold: config.signalsThreshold,
		cooldownMs: config.toolizeCooldownMs,
		maxActive: config.toolizeMax,
		minSteps: config.toolizeMinSteps,
		minDistinctTools: config.toolizeMinDistinctTools,
		nearMissHint: config.nearMissHint,
		recycleIdleDays: config.recycleIdleToolDays,
		skillMinSessions: config.skillMinSessions,
		skillRecencyDays: config.skillRecencyDays
	};
	await recordTurnSequences(ctx, store, workspaceKey, tools, args, toolize, logger, void 0, {
		sessionId,
		...taskText ? { task: taskText } : {},
		successes: successes.slice(0, tools.length),
		now
	});
	await recycleIdleCapabilities(ctx, store, toolize, logger);
}
/** Write one fact, skipping exact duplicates within the workspace. */ async function rememberFact(store, workspaceKey, text, keywords, sourceSessionId, sourceSeq, now, deps) {
	const normalized = text.trim().toLowerCase();
	for (const [, record] of store.memories.entries()) if (record.workspaceKey === workspaceKey && record.status === "active" && record.text.trim().toLowerCase() === normalized) return;
	const title = deriveTitle(text);
	const tags = mergeTags([], keywords);
	const assignment = await resolveCollectionForEntry(store, workspaceKey, {
		title,
		keywords: tags,
		text
	}, {
		now,
		deps
	});
	if ("error" in assignment) return void 0;
	const memoryId = await createMemoryVersioned(store, workspaceKey, {
		title,
		text,
		tags,
		...assignment.collectionId ? { collectionId: assignment.collectionId } : {},
		sourceSessionId,
		sourceSeq
	}, now);
	if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now);
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
// src/activity.ts
/** Text content of one tool result (success and failure both carry content). */
function contentText$2(result) {
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
/** Attach the tool-activity listener; returns the effect disposer. */
function attachToolActivity(ctx, store, tracker, config, logger) {
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
				text: contentText$2(result),
				isError: Boolean(result.isError)
			};
			tracker.observe(sessionId, observation, config.repeat, activeStore.memories.entries(), memoryCap);
			if (name === "skill") {
				const loaded = typeof observation.args.name === "string" ? observation.args.name : "";
				if (loaded.startsWith("sm-")) try {
					const { bumpCapabilityLoad } = await import("./capability-CerjsIyB.js").then((n) => n.l);
					await bumpCapabilityLoad(activeStore, workspaceKey, loaded);
				} catch {}
			}
			return decision;
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
/**
* The later-in-request card: a clearly distinct header plus the composite catalog.
*
* R47 需求②: like the opening card, this one is budget-aware and degrades by
* PRIORITY — header first, then memory records whole (title/tags whole), then
* the catalog block, then clipped bodies, and only then dropped records with a
* counted note. A catalog that would force a body clip is dropped whole
* instead (mixing a capability hint into a card whose memory text had to be
* cut is the wrong trade). `options.budget` omitted = legacy unbounded
* rendering, so existing callers keep their contract.
*/
function renderRepeatCard(items, style, catalog, options = {}) {
	const head = style === "plain" ? [injectionTitle("memoryRepeat")] : [injectionTitle("memoryRepeat"), "执行过程中出现了此前未注入的相关记忆，仅供参考；与当前指令冲突时以当前指令为准。"];
	const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : 0;
	if (!budget) {
		if (items.length === 0 && !catalog) return "";
		const lines = items.map((item, index) => index + 1 + ". " + renderRecordLine({
			title: item.title,
			text: item.text,
			tags: item.keywords
		}));
		return [
			...head,
			...lines,
			...catalog ? [catalog] : []
		].join("\n");
	}
	if (items.length === 0 && !catalog) return "";
	const minimal = [injectionTitle("memoryRepeat")];
	if (budget - (charCount(minimal[0]) + 1) < 116) {
		head.length = 0;
		head.push(...minimal);
	}
	const headCost = head.reduce((sum, line) => sum + charCount(line) + 1, 0);
	if (items.length === 0) {
		const room = budget - headCost - 1;
		if (charCount(catalog) <= room) return [...head, catalog].join("\n");
		return [...head, clipWithNote(catalog, Math.max(32, room), "")].join("\n");
	}
	const catalogCost = catalog ? charCount(catalog) + 1 : 0;
	const build = (reserve, withCatalog, withHint = true) => {
		let remaining = budget - headCost - reserve - (withCatalog ? catalogCost : 0);
		const lines = [];
		let dropped = 0;
		let cut = false;
		for (const [index, item] of items.entries()) {
			const prefix = `${index + 1}. `;
			const tail = item.keywords.length > 0 ? ` ｜标签: ${item.keywords.join("、")}` : "";
			const title = item.title && item.title !== item.text.trim() ? `【${item.title}】` : "";
			const overhead = charCount(prefix) + charCount(title) + charCount(tail) + 1;
			const whole = `${prefix}${title}${item.text}${tail}`;
			const wholeCost = charCount(whole) + 1;
			if (wholeCost <= remaining) {
				lines.push(whole);
				remaining -= wholeCost;
				continue;
			}
			const bodyShare = remaining - overhead;
			if (bodyShare >= 64) {
				cut = true;
				const line = `${prefix}${title}${clipWithNote(item.text, bodyShare, item.title ? `复取：memory_recall 「${item.title}」` : void 0)}${tail}`;
				lines.push(line);
				remaining -= charCount(line) + 1;
				if (remaining <= 0) {
					dropped += items.length - index - 1;
					break;
				}
				continue;
			}
			cut = true;
			dropped += 1;
		}
		const note = dropNote(dropped, withHint ? options.hint : void 0);
		return {
			text: [
				...head,
				...lines,
				...withCatalog && catalog ? [catalog] : [],
				...note ? [note] : []
			].join("\n"),
			note,
			cut,
			count: dropped
		};
	};
	let useCatalog = Boolean(catalog);
	let pass = build(0, useCatalog);
	if (useCatalog && pass.cut) {
		useCatalog = false;
		pass = build(0, false);
	}
	for (let attempt = 0; attempt < 3 && pass.note; attempt += 1) {
		if (charCount(pass.text) <= budget) break;
		pass = build(charCount(pass.note) + 1, useCatalog);
	}
	if (charCount(pass.text) > budget && pass.count > 0) {
		pass = build(charCount(dropNote(pass.count)) + 1, useCatalog, false);
		if (charCount(pass.text) > budget) return "";
	}
	return pass.text;
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
/**
* R47: the re-fetch clue carried by every omission note. The user's own words
* are the best `memory_recall` query, so the note quotes a short, cleaned
* slice of them — long enough to be a real query, short enough to stay a hint.
*/
function clipQueryHint(userText) {
	const clean = String(userText ?? "").replace(/\s+/g, " ").trim();
	return `「${clipAtBoundary(clean, 24) || clean.slice(0, 24)}」`;
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
	const build = async (text, kind) => {
		return (await ensureFactory())({
			content: [{
				type: "text",
				text
			}],
			source: injectionSource(kind, { form: "recall" })
		});
	};
	const buildNotice = async (text, kind) => {
		return (await ensureFactory())({
			content: [{
				type: "text",
				text
			}],
			source: injectionSource(kind)
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
				const recallHint = `复取：memory_recall ${clipQueryHint(userText)}`;
				const card = renderRecallCard(items, config.injectStyle, topicSets, {
					budget: config.maxChars,
					hint: recallHint
				});
				let branchesCard = "";
				if (isHubSession(activeStore, agent)) try {
					const setSections = topicSets.slice(0, 2).map((set) => ({
						title: set.title,
						rows: listTopicSetBranches(activeStore, set.id, 4)
					})).filter((section) => section.rows.length > 0);
					branchesCard = renderHubBranchesCard(listHubBranches(activeStore, sessionId), {
						now: Date.now(),
						...setSections.length > 0 ? { topicSets: setSections } : {}
					});
				} catch (error) {
					logger.warn("supermemory: hub branch card skipped: " + String(error).slice(0, 160));
				}
				let capabilityCard = "";
				if (config.capabilityIndex.enabled) try {
					const role = resolveRole(activeStore, agent);
					if (role.role === "hub" || role.role === "branch") {
						const rows = workspaceKey ? capabilityRows(activeStore, workspaceKey) : [];
						capabilityCard = renderCapabilityIndex(rows.map((entry) => ({
							name: entry.record.name,
							title: entry.record.title,
							description: entry.record.description,
							...entry.record.scope ? { scope: entry.record.scope } : {},
							...entry.record.scope ? { whenToUse: "在 " + entry.record.scope + " 内遇到「" + entry.record.title + "」类任务时加载。" } : {},
							entry: entry.record.entry,
							runnable: entry.record.runnable,
							entryDraft: entry.record.entryDraft,
							entryVerified: entry.record.entryVerified,
							enabled: entry.record.enabled,
							kind: entry.record.kind,
							status: entry.row.status
						})), {
							maxItems: config.capabilityIndex.maxItems,
							budget: Math.min(config.capabilityIndex.maxChars, config.maxChars)
						}).text;
					}
				} catch (error) {
					logger.warn("supermemory: capability index card skipped: " + String(error).slice(0, 160));
				}
				if (!card && !branchesCard && !capabilityCard) return decision;
				const appended = [];
				if (card) {
					const message = await build(card, "memory");
					commitCard(state, step, items, charCount(card));
					appended.push(message);
				}
				if (branchesCard) appended.push(await buildNotice(branchesCard, "branch"));
				if (capabilityCard) appended.push(await buildNotice(capabilityCard, "capability"));
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
			const text = renderRepeatCard(items, config.injectStyle, "", {
				budget: Math.min(config.maxChars, remainingChars(state, config.repeat)),
				hint: `复取：memory_recall ${clipQueryHint(query)}`
			});
			if (!text || items.length === 0) {
				commitScan(state, step);
				return decision;
			}
			const message = await build(text, "memoryRepeat");
			commitCard(state, step, items, charCount(text));
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
*
* R42 (relay 重复投递修复): the key is the CANONICAL `dlv-<dispatchId>` — the
* same key the interrupt sweep's guard (observe.ts settleInterruptedDispatches)
* and deliver()'s persistent guard check. It used to be `dlv-fail-<branchSessionId>`,
* which (a) did not satisfy either guard, so a branch-died dispatch was relayed
* TWICE (once here, once by the sweep), and (b) collided across the dispatches
* of one branch, so a second dispatch's failure relay was silently swallowed
* (observed in the real ledger: a dispatch with no relay row at all).
*/
async function failureDelivery(deps, dispatchId, record, reason) {
	const { ctx, store, logger } = deps;
	const deliveryId = "dlv-" + dispatchId;
	if (store.outbox.get(deliveryId)) return;
	const questionBlock = renderQuestionsBlock(openQuestionsOfDispatch(store, dispatchId));
	const payload = "[supermemory-relay " + record.branchSessionId + "]\n任务：" + record.task + "\n结果：" + reason + (questionBlock ? "\n\n" + questionBlock : "");
	const dispatch = store.dispatches.get(dispatchId);
	const topicSetTitle = record.topicSetId ? String(store.topicsets?.get?.(record.topicSetId)?.title ?? "") : "";
	const card = relayCardFields(ctx, store, {
		dispatchId,
		fromSessionId: record.branchSessionId,
		fromKind: "branch",
		task: record.task,
		...topicSetTitle ? { topicSetTitle } : {},
		...dispatch?.capability ? { capability: dispatch.capability } : {}
	});
	await store.outbox.put(deliveryId, {
		dispatchId,
		kind: "single",
		payload,
		status: "pending",
		enqueuedAt: Date.now(),
		fromSessionId: record.branchSessionId,
		...card.fromTitle ? { fromTitle: card.fromTitle } : {},
		fromKind: "branch",
		task: card.task,
		topicSetTitle: card.topicSetTitle,
		capability: card.capability
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
				const spliced = (e) => e.type === "agent/inbox/spliced" && (e.data?.inserted?.some((m) => m.source?.kind === "supermemory" || m.source?.kind === "user") ?? false);
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
							}, topicTitle, record.task, { taskOnly: true });
							await applySessionTitle({
								ctx,
								store,
								logger
							}, {
								sessionId: record.branchSessionId,
								kind: "branch",
								explicitTitle: named,
								source: "reconcile",
								defer: true
							});
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
					const hubTitle = sessionTitleOf(ctx, store, record.hubSessionId);
					const topicSetTitle = record.topicSetId ? store.topicsets.get(record.topicSetId)?.title ?? "" : "";
					target.followup(make({
						content: [{
							type: "text",
							text: `[supermemory-dispatch ${dispatchId}]\n任务：${record.task}\n\n（重启恢复：重新派发）\n遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。`
						}],
						source: dispatchSource({
							fromSessionId: record.hubSessionId,
							...hubTitle ? { fromTitle: hubTitle } : {},
							task: record.task,
							...topicSetTitle ? { topicSetTitle } : {},
							dispatchId,
							status: "dispatched"
						})
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
				const { groupMembers } = await import("./group-GfTkkPEE.js").then((n) => n.o);
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
				const card = relayCardFields(ctx, store, {
					...item.dispatchId === void 0 ? {} : { dispatchId: item.dispatchId },
					...item.groupId === void 0 ? {} : { groupId: item.groupId },
					...item.fromSessionId ? { fromSessionId: item.fromSessionId } : {},
					...item.fromTitle ? { fromTitle: item.fromTitle } : {},
					...item.fromKind ? { fromKind: item.fromKind } : {},
					...item.task ? { task: item.task } : {},
					...item.topicSetTitle ? { topicSetTitle: item.topicSetTitle } : {},
					...item.capability ? { capability: item.capability } : {}
				});
				hub.followup(make({
					content: [{
						type: "text",
						text: item.payload
					}],
					source: relaySource({
						deliveryId,
						...card.fromSessionId ? { fromSessionId: card.fromSessionId } : {},
						...card.fromTitle ? { fromTitle: card.fromTitle } : {},
						fromKind: card.fromKind,
						...item.groupId ? { groupId: item.groupId } : { dispatchId: item.dispatchId ?? "" },
						...card.task ? { task: card.task } : {},
						...card.topicSetTitle ? { topicSetTitle: card.topicSetTitle } : {},
						...card.capability ? { capability: card.capability } : {},
						status: "returned"
					})
				}));
				await store.outbox.update(deliveryId, (r) => ({
					...r,
					...card.fromSessionId ? { fromSessionId: card.fromSessionId } : {},
					...card.fromTitle ? { fromTitle: card.fromTitle } : {},
					fromKind: card.fromKind,
					task: card.task,
					topicSetTitle: card.topicSetTitle,
					capability: card.capability,
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
function agentsOf(ctx) {
	try {
		return ctx.get?.("agents");
	} catch {
		return;
	}
}
/** A member row is a WORK BRANCH when it is a fork or a plugin-minted branch id. */
function isBranchMember(sessionId, kind) {
	return kind === "fork" || isPluginBranchId(sessionId);
}
/**
* Every branch session the durable ledger knows about, newest activity first.
*
* Sources (deduplicated by session id, member facts preferred):
*   - topic-set members that are work branches (kind 'fork' or a plugin-minted
*     branch-/fork- prefixed id);
*   - dispatch rows whose branchSessionId is a plugin-minted branch id (covers a
*     member write that failed after the dispatch was recorded).
* A topic-set ROOT member (session-* hub conversation) is deliberately NOT a
* target: it is an ordinary session the user opens from the GUI, not a branch.
*/
function collectBranchRestoreTargets(store, options = {}) {
	const out = /* @__PURE__ */ new Map();
	if (!store) return [];
	const upsert = (target) => {
		const existing = out.get(target.sessionId);
		if (!existing) {
			out.set(target.sessionId, target);
			return;
		}
		if (target.memberTitle) {
			existing.memberTitle = target.memberTitle;
			if (target.topicSetId) {
				existing.topicSetId = target.topicSetId;
				existing.topicTitle = target.topicTitle;
			}
		} else if (target.topicSetId && !existing.topicSetId) {
			existing.topicSetId = target.topicSetId;
			existing.topicTitle = target.topicTitle;
		}
		if (target.task && target.lastActiveAt >= existing.lastActiveAt) existing.task = target.task;
		if (target.lastActiveAt > existing.lastActiveAt) existing.lastActiveAt = target.lastActiveAt;
	};
	for (const [, row] of store.dispatches.entries()) {
		const sessionId = String(row.branchSessionId ?? "");
		if (!sessionId || !isPluginBranchId(sessionId)) continue;
		const topicSet = row.topicSetId ? store.topicsets.get(row.topicSetId) : void 0;
		upsert({
			sessionId,
			...row.topicSetId ? { topicSetId: row.topicSetId } : {},
			topicTitle: topicSet?.title ?? "",
			memberTitle: "",
			task: String(row.task ?? ""),
			lastActiveAt: Math.max(Number(row.updatedAt) || 0, Number(row.lastActivityAt) || 0, Number(row.createdAt) || 0)
		});
	}
	for (const [topicSetId, topicSet] of store.topicsets.entries()) for (const member of topicSet.members) {
		if (!isBranchMember(member.sessionId, member.kind)) continue;
		upsert({
			sessionId: member.sessionId,
			topicSetId,
			topicTitle: topicSet.title,
			memberTitle: member.title ?? "",
			task: "",
			lastActiveAt: Number(member.lastActiveAt) || 0
		});
	}
	const limit = Math.max(1, Math.floor(options.limit ?? 200));
	return [...out.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.sessionId.localeCompare(b.sessionId)).slice(0, limit);
}
/** Mark the member row live/idle so the panel's live count stays truthful. */
async function markMemberStatus(store, target, status) {
	if (!target.topicSetId) return;
	try {
		const current = store.topicsets.get(target.topicSetId)?.members.find((m) => m.sessionId === target.sessionId);
		if (current && current.status === status) return;
		await updateMember(store, target.topicSetId, target.sessionId, { status });
	} catch {}
}
/** Re-attach one branch session; every step after the resume is bookkeeping. */
async function restoreOne(deps, agents, target, result) {
	const { ctx, store, logger } = deps;
	const id = target.sessionId;
	if (branchHandles.has(id)) {
		result.live.push(id);
		await markMemberStatus(store, target, "live");
		return;
	}
	let agent;
	try {
		agent = agents.get?.(id);
	} catch {
		agent = void 0;
	}
	if (agent) {
		result.live.push(id);
		await markMemberStatus(store, target, "live");
		return;
	}
	const memberModel = parseMemberModel(target.topicSetId ? store.topicsets.get(target.topicSetId)?.members.find((m) => m.sessionId === id)?.model : void 0);
	const handle = await agents.resume({
		resumeSessionId: id,
		...memberModel ? { agentOptions: { ...memberModel } } : {},
		setup: compositionSetup(ctx, hubComposition(ctx, void 0), logger)
	});
	branchHandles.set(id, {
		agent: handle.agent,
		dispose: () => handle.dispose()
	});
	result.resumed.push(id);
	logger.info("supermemory: restored branch " + id.slice(0, 13) + "（重启后重新 attach，会话保留）");
	await markMemberStatus(store, target, "live");
	try {
		const named = await ensureMemberTitle(store, target.topicSetId ?? "", {
			sessionId: id,
			kind: "fork"
		}, target.topicTitle, target.task, { taskOnly: true });
		await applySessionTitle({
			ctx,
			store,
			logger
		}, {
			sessionId: id,
			kind: "branch",
			explicitTitle: named || target.memberTitle,
			source: "restore",
			defer: true
		});
	} catch (error) {
		logger.warn("supermemory: branch restore naming skipped for " + id.slice(0, 13) + ": " + String(error).slice(0, 140));
	}
	if (target.topicSetId) {
		const workspaceKey = store.topicsets.get(target.topicSetId)?.workspaceKey;
		if (workspaceKey) try {
			await attachBranchToWorkspace(ctx, id, workspaceKey, logger);
		} catch {}
	}
}
/**
* Re-attach every preserved branch session of the ledger (startup pass).
*
* Idempotent: a live session is adopted as-is, so re-running the pass only
* retries what failed before. Never throws — the caller treats restoration as
* best-effort visibility work, and a failed resume leaves the session
* persisted (memory_resume / the panel can still continue it later).
*/
async function restoreBranchSessions(deps, options = {}) {
	const { store, logger } = deps;
	const result = {
		live: [],
		resumed: [],
		failed: [],
		skipped: []
	};
	const targets = collectBranchRestoreTargets(store, { limit: options.limit });
	if (targets.length === 0) return result;
	const agents = agentsOf(deps.ctx);
	if (!agents || typeof agents.resume !== "function") {
		result.skipped.push(...targets.map((target) => target.sessionId));
		return result;
	}
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, targets.length));
	let cursor = 0;
	const worker = async () => {
		for (;;) {
			const index = cursor++;
			if (index >= targets.length) return;
			const target = targets[index];
			try {
				await restoreOne(deps, agents, target, result);
			} catch (error) {
				result.failed.push({
					sessionId: target.sessionId,
					reason: String(error).slice(0, 160)
				});
				let live = false;
				try {
					live = !!agents.get?.(target.sessionId);
				} catch {}
				if (!live) await markMemberStatus(store, target, "idle");
				logger.warn("supermemory: branch restore failed for " + target.sessionId.slice(0, 13) + ": " + String(error).slice(0, 140));
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return result;
}
/** One-line summary for the startup log (kept terse; details live per-session). */
function renderBranchRestoreSummary(result) {
	const parts = [
		"resumed " + result.resumed.length,
		"live " + result.live.length,
		"failed " + result.failed.length
	];
	if (result.skipped.length > 0) parts.push("skipped " + result.skipped.length);
	return "supermemory: branch restore — " + parts.join(" / ");
}
/** The meta-table row key of the migration marker. */
const MARKER_KEY$2 = "hub-titles";
/** Historical hub titles this pass owns: the brand prefix or「新会话 · <id>」. */
const BRANDED_HUB_TITLE = new RegExp("^" + HUB_TITLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\s*·.*)?$");
const LEGACY_HUB_TITLE = new RegExp("^" + LEGACY_HUB_TITLE_PREFIX + "\\s*·\\s*.+$");
const zeros$1 = {
	scanned: 0,
	renamed: 0,
	skipped: 0,
	pending: 0,
	cleaned: 0
};
function serviceOf$2(ctx, name) {
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
/** The session corpus: sessionQuery first, live sessions as a fallback. */
async function listSessionRecords$1(ctx) {
	const query = serviceOf$2(ctx, "sessionQuery");
	if (query && typeof query.listSessions === "function") try {
		const rows = await query.listSessions();
		if (Array.isArray(rows)) return rows;
	} catch {}
	try {
		const live = serviceOf$2(ctx, "sessions");
		return (typeof live?.list === "function" ? live.list() : []).map((session) => ({ header: session.header ?? { id: session.id } }));
	} catch {
		return;
	}
}
/**
* Live titles for a batch of ids: one `readTitleSnapshots` read when the host
* offers it, otherwise the per-session `sessionTitle` read.
*/
async function readTitles$2(ctx, sessionIds) {
	const titles = /* @__PURE__ */ new Map();
	const query = serviceOf$2(ctx, "sessionQuery");
	if (query && typeof query.readTitleSnapshots === "function") try {
		const observations = await query.readTitleSnapshots(sessionIds);
		for (const observation of observations) {
			if (!observation || observation.status !== "fulfilled") continue;
			const sessionId = String(observation.sessionId ?? "");
			const title = observation.value?.title?.title;
			if (!sessionId || typeof title !== "string" || !title.trim()) continue;
			titles.set(sessionId, title.trim());
		}
		return titles;
	} catch {}
	for (const sessionId of sessionIds) {
		const current = currentSessionTitle(ctx, sessionId);
		if (current && current.trim()) titles.set(sessionId, current.trim());
	}
	return titles;
}
/** Join one message's text blocks (the readSurface event shape). */
function contentText$1(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const row = block;
		if (row.type === "text" && typeof row.text === "string" && row.text.trim()) parts.push(row.text);
	}
	return parts.join(String.fromCharCode(10)).trim();
}
/** The first user message of one session, or '' when unreadable. */
async function firstUserMessageText(ctx, sessionId) {
	const query = serviceOf$2(ctx, "sessionQuery");
	if (!query || typeof query.readSurface !== "function") return "";
	try {
		const surface = await query.readSurface(sessionId);
		for (const event of surface?.events ?? []) {
			if (event?.type !== "user/message") continue;
			const text = contentText$1(event.data?.message?.content);
			if (text) return text;
		}
	} catch {}
	return "";
}
/** Strip a KNOWN topic-set prefix (`<set> · `) from a branch title. */
function stripTopicPrefix$1(title, topicTitles) {
	const value = String(title ?? "").trim();
	for (const topic of topicTitles) {
		const prefix = String(topic ?? "").trim() + " · ";
		if (prefix.length > 3 && value.startsWith(prefix)) return value.slice(prefix.length).trim();
	}
	return value;
}
/** All topic-set titles in the store (any workspace; prefixes are discriminative). */
function topicTitlesOf$1(store) {
	const titles = [];
	if (!store) return titles;
	try {
		for (const [, record] of store.topicsets.entries()) {
			const title = String(record?.title ?? "").trim();
			if (title) titles.push(title);
		}
	} catch {}
	return titles;
}
/**
* Rewrite durable titles (dispatch rows + branch member rows) to direct
* descriptions. Content-idempotent; returns how many rows changed.
*/
async function cleanDurableTitles(store, topicTitles) {
	if (!store) return 0;
	let cleaned = 0;
	const cleanOnce = (title) => {
		const raw = String(title ?? "").trim();
		if (!raw) return void 0;
		const next = describeSessionTitle(stripTopicPrefix$1(raw, topicTitles));
		return next && next !== raw ? next : void 0;
	};
	try {
		for (const [id, row] of store.dispatches.entries()) {
			const next = cleanOnce(row.title);
			if (!next) continue;
			await store.dispatches.update(id, (record) => ({
				...record,
				title: next
			}));
			cleaned += 1;
		}
	} catch {}
	try {
		for (const [id, record] of store.topicsets.entries()) {
			let changed = false;
			const members = record.members.map((member) => {
				if (member.kind !== "fork" && !isPluginBranchId(member.sessionId)) return member;
				const next = cleanOnce(member.title);
				if (!next) return member;
				changed = true;
				return {
					...member,
					title: next
				};
			});
			if (!changed) continue;
			await store.topicsets.update(id, (row) => ({
				...row,
				members
			}));
			cleaned += 1;
		}
	} catch {}
	try {
		for (const [id, row] of store.hubs.entries()) {
			const next = cleanOnce(row.title);
			if (!next) continue;
			await store.hubs.update(id, (record) => ({
				...record,
				title: next
			}));
			cleaned += 1;
		}
	} catch {}
	return cleaned;
}
/** The persisted migration marker (undefined when never run). */
async function hubTitlesMigrationMarker(store) {
	return store?.meta?.get(MARKER_KEY$2);
}
/**
* Record a converged pass. R42: the id sets are MERGED with the persisted ones
* (a later pass never forgets an earlier settle), bounded by MARKER_ID_CAP, and
* an empty pending set is stored as absent so the row stays small.
*/
async function writeHubTitlesMigrationMarker(store, ids = {}) {
	if (!store?.meta) return;
	const marker = await hubTitlesMigrationMarker(store);
	const processed = [.../* @__PURE__ */ new Set([...marker?.hubTitlesProcessedIds ?? [], ...ids.settled ?? []])];
	const pending = [.../* @__PURE__ */ new Set([...marker?.hubTitlesPendingIds ?? [], ...ids.pending ?? []])].filter((id) => !processed.includes(id));
	await store.meta.put(MARKER_KEY$2, {
		hubTitlesMigratedAt: Date.now(),
		hubTitlesMigrationVersion: 3,
		...processed.length ? { hubTitlesProcessedIds: processed.slice(-500) } : {},
		...pending.length ? { hubTitlesPendingIds: pending.slice(-500) } : {}
	});
}
/**
* The direct title for one legacy hub row: its first user message, or the
* neutral fallback when there is no readable content.
*/
/**
* The R41/R43 target title of one hub: the first user message as a direct
* description, qualified by the workspace name; 「<工作区名> · 新会话」 when
* the session carries no message yet.
*
* @param ctx - host context (used to read the first user message).
* @param sessionId - hub session id.
* @param workspaceKey - canonical workspace path of that hub (the label).
*/
async function hubTitleFor(ctx, sessionId, workspaceKey = "") {
	const content = await firstUserMessageText(ctx, sessionId);
	return hubSessionTitle(sessionId, content ?? "", workspaceKey);
}
/**
* Run (or preview) the rename. Startup calls it with no options (marker-
* guarded and best-effort); tests call it with `ignoreMarker` to force a pass.
*/
async function migrateHubSessionTitles(deps, options = {}) {
	const { ctx, store, logger } = deps;
	if (!options.ignoreMarker) {
		const marker = await hubTitlesMigrationMarker(store);
		if (marker && (marker.hubTitlesMigrationVersion ?? 0) >= 3) return {
			status: "already-done",
			...zeros$1,
			plan: []
		};
	}
	const topicTitles = topicTitlesOf$1(store);
	const cleaned = options.dryRun ? 0 : await cleanDurableTitles(store, topicTitles);
	if (!ctx) return {
		status: "no-host",
		...zeros$1,
		cleaned: 0,
		plan: []
	};
	const records = await listSessionRecords$1(ctx);
	if (!records) return {
		status: "no-host",
		...zeros$1,
		cleaned,
		plan: []
	};
	const hubCandidates = [];
	const branchCandidates = [];
	for (const record of records) {
		const header = record?.header ?? {};
		const sessionId = String(header.id ?? "");
		if (!sessionId) continue;
		if (header.origin === "subagent") continue;
		if (isPluginBranchId(sessionId)) {
			branchCandidates.push(sessionId);
			continue;
		}
		if (header.parentSession) continue;
		hubCandidates.push({
			sessionId,
			workspaceKey: workspaceKeyOf(header.cwd)
		});
	}
	const scanned = hubCandidates.length + branchCandidates.length;
	if (scanned === 0) {
		if (!options.dryRun) await writeHubTitlesMigrationMarker(store);
		return {
			status: "applied",
			scanned: 0,
			renamed: 0,
			skipped: 0,
			pending: 0,
			cleaned,
			plan: []
		};
	}
	const titles = await readTitles$2(ctx, [...hubCandidates.map((row) => row.sessionId), ...branchCandidates]);
	const plan = [];
	const hubTargets = [];
	for (const candidate of hubCandidates) {
		const title = titles.get(candidate.sessionId);
		if (!title) continue;
		if (!(BRANDED_HUB_TITLE.test(title) || LEGACY_HUB_TITLE.test(title) || isNeutralHubTitle(title, candidate.workspaceKey))) continue;
		const to = await hubTitleFor(ctx, candidate.sessionId, candidate.workspaceKey);
		if (!to || to === title) continue;
		plan.push({
			sessionId: candidate.sessionId,
			from: title,
			to
		});
		hubTargets.push({
			...candidate,
			from: title,
			to
		});
	}
	for (const sessionId of branchCandidates) {
		const title = titles.get(sessionId);
		if (!title) continue;
		const to = describeSessionTitle(stripTopicPrefix$1(title, topicTitles));
		if (!to || to === title) continue;
		plan.push({
			sessionId,
			from: title,
			to
		});
	}
	if (options.dryRun) return {
		status: "planned",
		scanned,
		renamed: 0,
		skipped: 0,
		pending: 0,
		cleaned: 0,
		plan
	};
	for (const target of hubTargets) await recordHubSession(store, {
		sessionId: target.sessionId,
		workspaceKey: target.workspaceKey,
		title: target.to,
		source: "title-migration"
	});
	let renamed = 0;
	let skipped = 0;
	let pending = 0;
	const settled = /* @__PURE__ */ new Set();
	const unfinished = /* @__PURE__ */ new Set();
	const hubIds = new Set(hubTargets.map((target) => target.sessionId));
	for (const item of plan) try {
		const current = currentSessionTitle(ctx, item.sessionId);
		if (current && current !== item.from) {
			skipped += 1;
			settled.add(item.sessionId);
			logger.info(`supermemory: title migration skipped ${item.sessionId} — the host title was renamed by somebody else`);
			continue;
		}
		const outcome = (await applySessionTitle({
			ctx,
			store,
			logger
		}, {
			sessionId: item.sessionId,
			kind: hubIds.has(item.sessionId) ? "hub" : "branch",
			workspaceKey: store?.hubs?.get?.(item.sessionId)?.workspaceKey ?? "",
			explicitTitle: item.to,
			source: "migration",
			force: true
		})).outcome;
		if (outcome === "host" || outcome === "fallback") {
			renamed += 1;
			settled.add(item.sessionId);
		} else {
			pending += 1;
			unfinished.add(item.sessionId);
		}
	} catch (error) {
		pending += 1;
		unfinished.add(item.sessionId);
		logger.warn("supermemory: title migration failed for " + item.sessionId + ": " + String(error).slice(0, 160));
	}
	await writeHubTitlesMigrationMarker(store, {
		settled: [...settled],
		pending: [...unfinished]
	});
	logger.info(`supermemory: title migration applied — scanned ${scanned}, renamed ${renamed}, skipped ${skipped}, pending ${pending}, durable cleaned ${cleaned}`);
	return {
		status: "applied",
		scanned,
		renamed,
		skipped,
		pending,
		cleaned,
		plan
	};
}
/** The meta-table row key of the new migration marker. */
const MARKER_KEY$1 = "session-titles";
/** Bound on scanned candidates (a diagnostics pass, not an archive walk). */
const CANDIDATE_LIMIT = 300;
function serviceOf$1(ctx, name) {
	if (!ctx) return void 0;
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
/** The persisted marker, or undefined when the pass never ran. */
function sessionTitlesMarker(store) {
	if (!store) return void 0;
	try {
		return store.meta?.get?.(MARKER_KEY$1);
	} catch {
		return;
	}
}
/**
* Remove one id from the pending set after a successful live write (called by
* the reconcile/first-event path). Content-idempotent; a missing marker is a
* no-op.
*/
async function settleSessionTitlePendingId(store, sessionId) {
	if (!store || !sessionId) return;
	const marker = sessionTitlesMarker(store);
	if (!marker) return;
	if (!(marker.sessionTitlesPendingIds ?? []).includes(sessionId)) return;
	const pending = (marker.sessionTitlesPendingIds ?? []).filter((id) => id !== sessionId);
	const processed = [.../* @__PURE__ */ new Set([...marker.sessionTitlesProcessedIds ?? [], sessionId])].slice(-500);
	try {
		await store.meta.put(MARKER_KEY$1, {
			...marker,
			sessionTitlesMigratedAt: Date.now(),
			sessionTitlesProcessedIds: processed,
			sessionTitlesPendingIds: pending.slice(-500)
		});
	} catch {}
}
/** All topic-set titles (prefix stripping evidence for durable titles). */
function topicTitlesOf(store) {
	const titles = [];
	if (!store) return titles;
	try {
		for (const [, record] of store.topicsets.entries()) {
			const title = String(record?.title ?? "").trim();
			if (title) titles.push(title);
		}
	} catch {}
	return titles;
}
/** Strip a known topic-set prefix from one title. */
function stripTopicPrefix(title, topicTitles) {
	const value = String(title ?? "").trim();
	for (const topic of topicTitles) {
		const prefix = String(topic ?? "").trim() + " · ";
		if (prefix.length > 3 && value.startsWith(prefix)) return value.slice(prefix.length).trim();
	}
	return value;
}
/**
* Normalize the DURABLE copies (dispatch rows + fork member titles) to the
* direct-description + 80-byte rule. Content-idempotent; hub mirrors are NOT
* touched here — the hub rules below own that string.
*/
async function normalizeDurableTitles(store, topicTitles) {
	if (!store) return 0;
	let cleaned = 0;
	const cleanOnce = (title) => {
		const raw = String(title ?? "").trim();
		if (!raw) return void 0;
		const next = clipTitleBytes(stripLeadingDescription(cleanTitleText(stripTopicPrefix(raw, topicTitles))));
		return next && next !== raw ? next : void 0;
	};
	try {
		for (const [id, row] of store.dispatches.entries()) {
			const next = cleanOnce(row.title);
			if (!next) continue;
			await store.dispatches.update(id, (record) => ({
				...record,
				title: next
			}));
			cleaned += 1;
		}
	} catch {}
	try {
		for (const [id, record] of store.topicsets.entries()) {
			let changed = false;
			const members = record.members.map((member) => {
				if (member.kind !== "fork" && !isPluginBranchId(member.sessionId)) return member;
				const next = cleanOnce(member.title);
				if (!next) return member;
				changed = true;
				return {
					...member,
					title: next
				};
			});
			if (!changed) continue;
			await store.topicsets.update(id, (row) => ({
				...row,
				members
			}));
			cleaned += 1;
		}
	} catch {}
	return cleaned;
}
/** Live workspace key of one session (header cwd), when readable. */
function liveWorkspaceKey(ctx, sessionId) {
	try {
		const cwd = ctx.sessions?.get?.(sessionId)?.header?.cwd;
		return typeof cwd === "string" && cwd ? workspaceKeyOf(cwd) : "";
	} catch {
		return "";
	}
}
/** Every session the plugin ever named, with its durable mirror title. */
function candidatesOf(store) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	if (!store) return out;
	try {
		for (const [, row] of store.hubs.entries()) {
			const sessionId = String(row.sessionId ?? "");
			if (!sessionId || seen.has(sessionId) || out.length >= CANDIDATE_LIMIT) continue;
			if (isPluginBranchId(sessionId)) continue;
			seen.add(sessionId);
			out.push({
				sessionId,
				workspaceKey: String(row.workspaceKey ?? ""),
				mirrorTitle: String(row.title ?? "")
			});
		}
	} catch {}
	return out;
}
/**
* Batch host titles (live snapshot preferred, cold titles from the query seam).
* A missing/rejected observation stays UNKNOWN (undefined) — the pass never
* renames a session whose current title cannot be read.
*/
async function readTitles$1(ctx, sessionIds) {
	const titles = /* @__PURE__ */ new Map();
	const query = serviceOf$1(ctx, "sessionQuery");
	if (query && typeof query.readTitleSnapshots === "function") try {
		const observations = await query.readTitleSnapshots(sessionIds);
		for (const observation of observations) {
			if (!observation || observation.status !== "fulfilled") continue;
			const id = String(observation.sessionId ?? "");
			const title = observation.value?.title?.title;
			if (!id || typeof title !== "string") continue;
			titles.set(id, title.trim());
		}
	} catch {}
	for (const sessionId of sessionIds) {
		if (titles.has(sessionId)) continue;
		const live = readHostTitle(ctx, sessionId)?.title;
		if (live) titles.set(sessionId, live.trim());
	}
	return titles;
}
/** A mirror title usable as a topic (topic-bearing, non-legacy). */
function usableMirror(title, workspaceKey) {
	const value = String(title ?? "").trim();
	if (!value) return false;
	if (isNeutralTitle(value, workspaceKey) || isLegacyTitle(value)) return false;
	return true;
}
/**
* Run the migration pass.
*
* @param deps - host context + store + logger (the gate owns every host write).
* @param options - dryRun returns the mapping without writing; ignoreMarker
*   forces a full scan (manual re-run / tests).
*/
async function migrateSessionTitles(deps, options = {}) {
	const { store } = deps;
	const empty = {
		status: "applied",
		scanned: 0,
		adopted: 0,
		renamed: 0,
		deferred: 0,
		skipped: 0,
		cleaned: 0,
		processed: 0,
		pending: 0,
		plan: []
	};
	if (!store) return {
		...empty,
		status: "no-store"
	};
	const marker = sessionTitlesMarker(store);
	const known = !options.ignoreMarker && (marker?.sessionTitlesMigrationVersion ?? 0) >= 1;
	const processed = new Set(marker?.sessionTitlesProcessedIds ?? []);
	const pending = new Set(marker?.sessionTitlesPendingIds ?? []);
	const candidates = candidatesOf(store);
	const byId = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]));
	if (known && pending.size === 0) return {
		...empty,
		status: "already-done"
	};
	const scanIds = known ? [...pending].filter((id) => byId.has(id)) : candidates.map((candidate) => candidate.sessionId).filter((id) => options.ignoreMarker || !processed.has(id));
	if (known) {
		for (const id of [...pending]) if (!byId.has(id)) pending.delete(id);
	}
	if (scanIds.length === 0) {
		if (!options.dryRun) await writeMarker$1(store, marker, {
			processed,
			pending,
			cleaned: 0,
			counts: {
				migrated: 0,
				adopted: 0,
				deferred: 0,
				skipped: 0
			}
		});
		return {
			...empty,
			status: "applied",
			processed: processed.size,
			pending: pending.size
		};
	}
	const titles = await readTitles$1(deps.ctx, scanIds);
	const topicTitles = topicTitlesOf(store);
	const cleaned = options.dryRun || known ? 0 : await normalizeDurableTitles(store, topicTitles);
	const result = {
		...empty,
		scanned: scanIds.length,
		cleaned
	};
	const plan = result.plan;
	for (const sessionId of scanIds) {
		const candidate = byId.get(sessionId);
		if (!candidate) continue;
		const workspaceKey = candidate.workspaceKey || liveWorkspaceKey(deps.ctx, sessionId);
		const hostTitle = titles.get(sessionId);
		const live = isSessionLive(deps.ctx, sessionId);
		const mirrorTitle = candidate.mirrorTitle;
		const base = {
			sessionId,
			kind: "hub",
			workspaceKey,
			hostTitle: hostTitle ?? "",
			mirrorTitle,
			live
		};
		const row = titleRow(store, sessionId);
		if (row?.state === "user-locked") {
			result.skipped += 1;
			processed.add(sessionId);
			pending.delete(sessionId);
			plan.push({
				...base,
				desiredTitle: row.desiredTitle,
				action: "locked",
				reason: row.lockedReason || "user-locked"
			});
			continue;
		}
		if (hostTitle === void 0) {
			result.skipped += 1;
			processed.add(sessionId);
			pending.delete(sessionId);
			plan.push({
				...base,
				desiredTitle: row?.desiredTitle ?? "",
				action: "unknown",
				reason: "host-title-unreadable"
			});
			continue;
		}
		if (!isNeutralTitle(hostTitle, workspaceKey) && !isLegacyTitle(hostTitle)) {
			result.adopted += 1;
			processed.add(sessionId);
			pending.delete(sessionId);
			plan.push({
				...base,
				desiredTitle: hostTitle,
				action: "adopt",
				reason: "host-title-topic-bearing"
			});
			if (!options.dryRun) {
				await ensureTitleRow(store, {
					sessionId,
					workspaceKey,
					kind: "hub",
					source: "migration"
				});
				await patchTitleRow(store, sessionId, {
					state: "named",
					kind: "hub",
					...workspaceKey ? { workspaceKey } : {},
					desiredTitle: hostTitle,
					autoTitle: hostTitle,
					desiredFull: hostTitle,
					lastWrittenTitle: hostTitle,
					lastTitleSeq: readHostTitle(deps.ctx, sessionId)?.seq,
					source: "migration",
					lockedReason: "",
					attempts: 0,
					lastError: ""
				});
				await mirrorHubTitle(store, sessionId, hostTitle, workspaceKey);
			}
			continue;
		}
		const mirrorTopic = usableMirror(mirrorTitle, workspaceKey);
		const desiredTitle = mirrorTopic ? composeRecordedHubTitle(workspaceKey, mirrorTitle) : composeHubTitle(workspaceKey, "");
		const desiredNeutral = isNeutralTitle(desiredTitle, workspaceKey);
		const action = live ? desiredNeutral ? "provisional" : "rename" : "deferred";
		plan.push({
			...base,
			desiredTitle,
			action,
			reason: mirrorTopic ? "neutral-host-mirror-topic" : "neutral-host-no-topic"
		});
		if (options.dryRun) continue;
		if (!live) {
			await ensureTitleRow(store, {
				sessionId,
				workspaceKey,
				kind: "hub",
				source: "migration"
			});
			await patchTitleRow(store, sessionId, {
				state: "deferred",
				kind: "hub",
				...workspaceKey ? { workspaceKey } : {},
				desiredTitle,
				autoTitle: desiredTitle,
				desiredFull: desiredTitle,
				topic: mirrorTopic ? String(mirrorTitle ?? "").trim() : "",
				source: "migration",
				lastError: "session-not-live"
			});
			if (!desiredNeutral) await mirrorHubTitle(store, sessionId, desiredTitle, workspaceKey);
			pending.add(sessionId);
			processed.add(sessionId);
			result.deferred += 1;
			continue;
		}
		const applied = await applySessionTitle(deps, {
			sessionId,
			kind: "hub",
			workspaceKey,
			explicitTitle: desiredTitle,
			source: "migration",
			force: true,
			defer: true
		});
		if (applied.outcome === "locked") {
			result.skipped += 1;
			processed.add(sessionId);
			pending.delete(sessionId);
			continue;
		}
		if (applied.outcome === "deferred" || applied.outcome === "none" || applied.outcome === "skipped") {
			pending.add(sessionId);
			processed.add(sessionId);
			result.deferred += 1;
			continue;
		}
		result.renamed += 1;
		processed.add(sessionId);
		pending.delete(sessionId);
	}
	if (!options.dryRun) await writeMarker$1(store, marker, {
		processed,
		pending,
		cleaned,
		counts: {
			migrated: result.renamed,
			adopted: result.adopted,
			deferred: result.deferred,
			skipped: result.skipped
		}
	});
	result.processed = processed.size;
	result.pending = pending.size;
	deps.logger.info("supermemory: session titles migrated — scanned " + result.scanned + ", adopted " + result.adopted + ", renamed " + result.renamed + ", deferred " + result.deferred + ", skipped " + result.skipped + ", cleaned " + result.cleaned + ", pending " + result.pending);
	return result;
}
/** Write the converged marker (always, even while pending is non-empty). */
async function writeMarker$1(store, previous, input) {
	try {
		await store.meta.put(MARKER_KEY$1, {
			...previous,
			sessionTitlesMigrationVersion: 1,
			sessionTitlesMigratedAt: Date.now(),
			sessionTitlesMigrated: input.counts.migrated ?? 0,
			sessionTitlesAdopted: input.counts.adopted ?? 0,
			sessionTitlesDeferred: input.counts.deferred ?? 0,
			sessionTitlesSkipped: input.counts.skipped ?? 0,
			sessionTitlesCleaned: input.cleaned,
			sessionTitlesProcessedIds: [...input.processed].slice(-500),
			sessionTitlesPendingIds: [...input.pending].slice(-500)
		});
	} catch {}
}
// src/session-title/reconcile.ts
/** How many rows one reconcile pass looks at (a runaway table must stay bounded). */
const RECONCILE_LIMIT = 300;
/**
* Reconcile ONE session. Returns undefined when there is nothing to do.
* The host write (if any) still goes through the SINGLE gate entry; this module
* only decides what the intent is.
*/
async function reconcileSessionTitle(deps, sessionId, options = {}) {
	const store = deps.store;
	if (!store || !sessionId) return void 0;
	const row = titleRow(store, sessionId);
	if (!row) return void 0;
	const workspace = row.workspaceKey;
	const live = isSessionLive(deps.ctx, sessionId);
	const host = readHostTitle(deps.ctx, sessionId);
	const hostTitle = host?.title ?? "";
	const desired = String(row.desiredTitle ?? "").trim();
	const hostNeutral = !hostTitle || isNeutralTitle(hostTitle, workspace);
	if (row.state === "user-locked") {
		if (host && !hostNeutral && hostTitle !== row.lastWrittenTitle && hostTitle !== row.desiredTitle) {
			await patchTitleRow(store, sessionId, {
				lastWrittenTitle: hostTitle,
				lastTitleSeq: host.seq,
				lockedReason: row.lockedReason || "manual"
			});
			if (row.kind === "hub") await mirrorHubTitle(store, sessionId, hostTitle, workspace);
		}
		return;
	}
	if (!desired) return void 0;
	if (!live) {
		if (row.state !== "deferred") {
			await patchTitleRow(store, sessionId, {
				state: "deferred",
				lastError: row.lastError || "session-not-live"
			});
			return {
				outcome: "deferred",
				title: desired,
				state: "deferred",
				reason: "session-not-live"
			};
		}
		return;
	}
	if (hostTitle === desired) {
		if (row.state !== "named") await patchTitleRow(store, sessionId, {
			state: "named",
			autoTitle: row.autoTitle || desired,
			lastWrittenTitle: desired,
			lastTitleSeq: host?.seq,
			attempts: 0,
			lastError: ""
		});
		await settleSessionTitlePendingId(store, sessionId);
		return {
			outcome: "already",
			title: desired,
			state: "named"
		};
	}
	if (!hostNeutral && hostTitle !== row.lastWrittenTitle) {
		const autoTitle = String(row.autoTitle ?? "").trim() || (row.desiredTitle && row.desiredTitle !== hostTitle ? row.desiredTitle : "");
		await patchTitleRow(store, sessionId, {
			state: "user-locked",
			...autoTitle ? {
				autoTitle,
				desiredTitle: autoTitle
			} : {},
			lastWrittenTitle: hostTitle,
			lastTitleSeq: host?.seq,
			lockedReason: "external-rename"
		});
		if (row.kind === "hub") await mirrorHubTitle(store, sessionId, hostTitle, workspace);
		await settleSessionTitlePendingId(store, sessionId);
		deps.logger.info("supermemory: reconcile locked " + sessionId + " (renamed outside the plugin)");
		return {
			outcome: "locked",
			title: hostTitle,
			state: "user-locked",
			reason: "external-rename"
		};
	}
	const result = await applySessionTitle(deps, {
		sessionId,
		kind: row.kind,
		workspaceKey: workspace,
		explicitTitle: desired,
		source: "reconcile",
		force: true,
		defer: options.defer ?? true
	});
	if (result.outcome === "host" || result.outcome === "fallback" || result.outcome === "already") await settleSessionTitlePendingId(store, sessionId);
	else if (result.outcome === "locked") await settleSessionTitlePendingId(store, sessionId);
	deps.logger.info("supermemory: reconcile " + (options.reason ? "(" + options.reason + ") " : "") + sessionId + " → " + result.outcome);
	return result;
}
/**
* Reconcile every naming row (bounded). Safe on startup/reload and from the
* panel's explicit repair action. Cold sessions are counted but never resumed.
*/
async function reconcileTitles(deps, options = {}) {
	const summary = {
		checked: 0,
		repaired: 0,
		deferred: 0,
		locked: 0,
		failed: 0
	};
	const store = deps.store;
	if (!store) return summary;
	const limit = Math.max(1, Math.min(RECONCILE_LIMIT, options.limit ?? RECONCILE_LIMIT));
	const rows = [];
	try {
		for (const [, row] of store.sessionTitles.entries()) {
			if (rows.length >= limit) break;
			rows.push(row);
		}
	} catch {
		return summary;
	}
	for (const row of rows) {
		if (row.kind === "other") continue;
		if (row.state === "user-locked") continue;
		if (row.state === "provisional") continue;
		if (!isSessionLive(deps.ctx, row.sessionId)) {
			if (row.state === "deferred") summary.deferred += 1;
			continue;
		}
		summary.checked += 1;
		try {
			const result = await reconcileSessionTitle(deps, row.sessionId, { reason: options.reason });
			if (!result) continue;
			if (result.outcome === "locked") summary.locked += 1;
			else if (result.outcome === "deferred") summary.deferred += 1;
			else if (result.outcome === "host" || result.outcome === "fallback" || result.outcome === "already") summary.repaired += 1;
		} catch (error) {
			summary.failed += 1;
			deps.logger.warn("supermemory: reconcile failed for " + row.sessionId + ": " + String(error).slice(0, 160));
		}
	}
	if (summary.checked > 0 || summary.deferred > 0 || summary.locked > 0 || summary.failed > 0) deps.logger.info("supermemory: title reconcile — checked " + summary.checked + ", repaired " + summary.repaired + ", deferred " + summary.deferred + ", locked " + summary.locked + ", failed " + summary.failed);
	return summary;
}
// src/session-title/observe.ts
/** Join one message's text blocks. */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const row = block;
		if (row.type === "text" && typeof row.text === "string" && row.text.trim()) parts.push(row.text);
	}
	return parts.join(String.fromCharCode(10)).trim();
}
/**
* The seq of a session's FIRST user message, or undefined when unreadable.
* Used to avoid naming a session after a LATE message: a legacy hub whose
* first message predates this service must not be renamed by today's prompt.
*/
async function firstUserMessageSeq(ctx, sessionId) {
	if (!ctx) return void 0;
	let query;
	try {
		query = ctx.get?.("sessionQuery");
	} catch {
		return;
	}
	if (!query || typeof query.readSurface !== "function") return void 0;
	try {
		const surface = await query.readSurface(sessionId);
		for (const event of surface?.events ?? []) if (event?.type === "user/message" && typeof event.seq === "number") return event.seq;
	} catch {
		return;
	}
}
/** Adopt a topic-bearing host title we did not write (no rename, just state). */
async function adoptHostTitle(deps, row, sessionId, title, seq) {
	const store = deps.store;
	if (!store) return;
	const base = row ?? await ensureTitleRow(store, { sessionId });
	await patchTitleRow(store, sessionId, {
		state: "named",
		desiredTitle: title,
		autoTitle: title,
		desiredFull: title,
		lastWrittenTitle: title,
		...typeof seq === "number" ? { lastTitleSeq: seq } : {},
		source: base.source || "observer"
	});
	if ((base.kind ?? "other") === "hub") await mirrorHubTitle(store, sessionId, title, base.workspaceKey);
}
/** One `session/title` event (already deferred out of the publication stack). */
async function onHostTitle(deps, sessionId, title, seq) {
	const store = deps.store;
	if (!store) return;
	const row = titleRow(store, sessionId);
	if (!row) {
		const record = hubRecord(store, sessionId);
		if (!record) return;
		if (isNeutralTitle(title, record.workspaceKey)) return;
		await adoptHostTitle(deps, void 0, sessionId, title, seq);
		return;
	}
	if (takeOwnWrite(sessionId, title)) {
		if (row.lastWrittenTitle !== title || typeof seq === "number" && row.lastTitleSeq !== seq) await patchTitleRow(store, sessionId, {
			lastWrittenTitle: title,
			...typeof seq === "number" ? { lastTitleSeq: seq } : {}
		});
		return;
	}
	if (row.lastWrittenTitle === title) {
		if (typeof seq === "number" && row.lastTitleSeq !== seq) await patchTitleRow(store, sessionId, { lastTitleSeq: seq });
		return;
	}
	if (row.state === "user-locked") {
		if (row.lastWrittenTitle !== title) await patchTitleRow(store, sessionId, {
			lastWrittenTitle: title,
			...typeof seq === "number" ? { lastTitleSeq: seq } : {},
			lockedReason: row.lockedReason || "manual"
		});
		if (row.kind === "hub") await mirrorHubTitle(store, sessionId, title, row.workspaceKey);
		return;
	}
	if (isNeutralTitle(title, row.workspaceKey)) {
		if (row.desiredTitle && !isNeutralTitle(row.desiredTitle, row.workspaceKey)) {
			deps.logger.info("supermemory: host title of " + sessionId + " went neutral; re-asserting 「" + row.desiredTitle + "」");
			await applySessionTitle(deps, {
				sessionId,
				kind: row.kind,
				workspaceKey: row.workspaceKey,
				explicitTitle: row.desiredTitle,
				source: "reconcile",
				force: true,
				defer: true
			});
		}
		return;
	}
	const autoTitle = String(row.autoTitle ?? "").trim() || (row.desiredTitle && row.desiredTitle !== title ? row.desiredTitle : "");
	await patchTitleRow(store, sessionId, {
		state: "user-locked",
		...autoTitle ? {
			autoTitle,
			desiredTitle: autoTitle
		} : {},
		lastWrittenTitle: title,
		...typeof seq === "number" ? { lastTitleSeq: seq } : {},
		lockedReason: "external-rename"
	});
	if (row.kind === "hub") await mirrorHubTitle(store, sessionId, title, row.workspaceKey);
	deps.logger.info("supermemory: session " + sessionId + " renamed outside the plugin; auto-naming stops");
}
/** One first-user-message event (already deferred). */
async function onUserMessage(deps, sessionId, seq, text) {
	const store = deps.store;
	if (!store) return;
	const row = titleRow(store, sessionId);
	const record = hubRecord(store, sessionId);
	if (!row && !record) return;
	if (row && (row.state === "user-locked" || row.state === "named")) return;
	if ((row?.kind ?? "hub") !== "hub") return;
	const firstSeq = await firstUserMessageSeq(deps.ctx, sessionId);
	if (!(firstSeq === void 0 ? row?.state === "provisional" : firstSeq === seq)) {
		const mirror = String(record?.title ?? "").trim();
		if (mirror && !isNeutralTitle(mirror, record?.workspaceKey ?? row?.workspaceKey ?? "")) await applySessionTitle(deps, {
			sessionId,
			kind: "hub",
			workspaceKey: record?.workspaceKey ?? row?.workspaceKey,
			explicitTitle: mirror,
			source: "migration",
			defer: true
		});
		return;
	}
	await applySessionTitle(deps, {
		sessionId,
		kind: "hub",
		workspaceKey: row?.workspaceKey || record?.workspaceKey || "",
		topicText: text,
		source: "first-message",
		defer: true
	});
}
/**
* R59 Phase 1b-2: the PANEL's first-message path, extracted so both the panel
* and the tests use the exact same gate call (one deferred write, only while
* the hub title carries no topic; the gate owns every guard).
*
* @returns the gate result; `skipped/no-hub` when the session has no plugin hub record.
*/
async function finalizeHubTitleFromMessage(deps, sessionId, text, source = "panel") {
	const record = hubRecord(deps.store, sessionId);
	if (!record) return {
		outcome: "skipped",
		title: "",
		reason: "no-hub"
	};
	return applySessionTitle(deps, {
		sessionId,
		workspaceKey: record.workspaceKey,
		kind: "hub",
		topicText: text,
		source,
		defer: true
	});
}
/**
* Attach the observer (once per plugin load). Returns the disposer.
*
* The listener only SCHEDULES work: the host forbids writes while it publishes
* an event, so every handler runs after a microtask boundary.
*/
function attachSessionTitleObserver(deps) {
	const ctx = deps.ctx;
	if (!ctx || typeof ctx.on !== "function" || !deps.store) return () => {};
	const retried = /* @__PURE__ */ new Set();
	return ctx.on("session/event", (session, event) => {
		const sessionId = String(session?.id ?? "");
		if (!sessionId) return;
		if (!retried.has(sessionId)) {
			if (titleRow(deps.store, sessionId)?.state === "deferred") {
				retried.add(sessionId);
				deferTitleTask(() => reconcileSessionTitle(deps, sessionId, {
					reason: "first-event",
					defer: true
				})).catch((error) => {
					deps.logger.warn("supermemory: deferred title retry failed for " + sessionId + ": " + String(error).slice(0, 160));
				});
			}
		}
		if (event?.type === "user/message") {
			const data = event.data;
			const kind = data?.source?.kind;
			if (kind && kind !== "user") return;
			const text = contentText(data?.content);
			if (!text.trim()) return;
			deferTitleTask(() => onUserMessage(deps, sessionId, event.seq, text)).catch((error) => {
				deps.logger.warn("supermemory: first-message naming failed for " + sessionId + ": " + String(error).slice(0, 160));
			});
			return;
		}
		if (event?.type === "session/title") {
			const data = event.data;
			const title = typeof data?.title === "string" ? data.title.trim() : "";
			if (!title) return;
			deferTitleTask(() => onHostTitle(deps, sessionId, title, event.seq)).catch((error) => {
				deps.logger.warn("supermemory: title observer failed for " + sessionId + ": " + String(error).slice(0, 160));
			});
		}
	});
}
// src/session-title/index.ts
/**
* R59: the session-naming service — public surface.
*
* One authority (the host title), one durable intent (`session_titles`), one
* write entry ({@link applySessionTitle}), and one automatic observer. Callers
* must never import `host.ts` directly; everything goes through the gate.
* @module supermemory/session-title
*/
/**
* Startup (and plugin reload) entry: migrate the corpus, then reconcile every
* row. Both halves are best-effort — a naming failure must never keep the
* plugin from loading.
*
* Phase 1b: the plugin startup calls this DETACHED (see src/index.ts) — the
* migrate pass runs once behind the new marker, then named/deferred rows are
* reconciled. Every host write inside goes through the gate's deferred path;
* cold sessions are stored as deferred, never resumed.
*/
async function startupSessionTitles(deps) {
	const result = {};
	try {
		result.migration = await migrateSessionTitles(deps);
	} catch (error) {
		deps.logger.warn("supermemory: session-title migration failed: " + String(error).slice(0, 200));
	}
	try {
		result.reconcile = await reconcileTitles(deps, { reason: "startup" });
	} catch (error) {
		deps.logger.warn("supermemory: session-title reconcile failed: " + String(error).slice(0, 200));
	}
	return result;
}
/** Attach the automatic observer (once per plugin load). */
function attachSessionTitles(deps) {
	return attachSessionTitleObserver(deps);
}
/** The meta-table row key of the migration marker (never the 'hub-titles' row). */
const MARKER_KEY = "hub-records";
const zeros = {
	scanned: 0,
	considered: 0,
	skippedNonHub: 0,
	marked: 0,
	pending: 0
};
function serviceOf(ctx, name) {
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
/** The session corpus: sessionQuery first, live sessions as a fallback. */
async function listSessionRecords(ctx) {
	const query = serviceOf(ctx, "sessionQuery");
	if (query && typeof query.listSessions === "function") try {
		const rows = await query.listSessions();
		if (Array.isArray(rows)) return rows;
	} catch {}
	try {
		const live = serviceOf(ctx, "sessions");
		return (typeof live?.list === "function" ? live.list() : []).map((session) => ({ header: session.header ?? { id: session.id } }));
	} catch {
		return;
	}
}
/** Live/persisted titles for a batch of ids (batch seam first, per-session fallback). */
async function readTitles(ctx, sessionIds) {
	const titles = /* @__PURE__ */ new Map();
	const query = serviceOf(ctx, "sessionQuery");
	if (query && typeof query.readTitleSnapshots === "function") try {
		const observations = await query.readTitleSnapshots(sessionIds);
		for (const observation of observations) {
			if (!observation || observation.status !== "fulfilled") continue;
			const sessionId = String(observation.sessionId ?? "");
			const title = observation.value?.title?.title;
			if (!sessionId || typeof title !== "string") continue;
			titles.set(sessionId, title.trim());
		}
	} catch {}
	for (const sessionId of sessionIds) {
		if (titles.has(sessionId)) continue;
		const current = currentSessionTitle(ctx, sessionId);
		if (typeof current === "string") titles.set(sessionId, current.trim());
	}
	return titles;
}
/**
* Workspaces this plugin has data for: every table carrying a `workspaceKey`
* contributes (topic sets, memories, collections, filemap, requirements, hub
* records). `unknown` and empty keys are never treated as a workspace.
*/
function knownWorkspaceKeys(store) {
	const keys = /* @__PURE__ */ new Set();
	if (!store) return [];
	const tables = [
		store.topicsets,
		store.memories,
		store.memoryCollections,
		store.filemap,
		store.requirements,
		store.hubs
	];
	for (const table of tables) {
		if (!table) continue;
		try {
			for (const [, row] of table.entries()) {
				const key = String(row?.workspaceKey ?? "");
				if (key && key !== "unknown") keys.add(key);
			}
		} catch {}
	}
	return [...keys];
}
/** The persisted migration marker (undefined when never run). */
async function hubRecordsMigrationMarker(store) {
	try {
		return await store?.meta?.get(MARKER_KEY);
	} catch {
		return;
	}
}
async function writeMarker(store) {
	if (!store?.meta) return;
	await store.meta.put(MARKER_KEY, {
		hubRecordsMigratedAt: Date.now(),
		hubRecordsMigrationVersion: 1
	});
}
/** Whether this session already has a positive hub record (guarded read). */
function hubRecordOf(store, sessionId) {
	try {
		return store?.hubs?.get?.(sessionId);
	} catch {
		return;
	}
}
/**
* Run (or preview) the one-time pass. Startup calls it with no options; tests
* force a pass with `ignoreMarker`.
*/
async function migrateHubSessionRecords(deps, options = {}) {
	const { ctx, store, logger } = deps;
	if (!options.ignoreMarker) {
		const marker = await hubRecordsMigrationMarker(store);
		if (marker && (marker.hubRecordsMigrationVersion ?? 0) >= 1) return {
			status: "already-done",
			...zeros,
			plan: [],
			skipped: []
		};
	}
	if (!ctx) return {
		status: "no-host",
		...zeros,
		plan: [],
		skipped: []
	};
	const records = await listSessionRecords(ctx);
	if (!records) return {
		status: "no-host",
		...zeros,
		plan: [],
		skipped: []
	};
	const scope = deps.workspaceKeys ? new Set(deps.workspaceKeys) : void 0;
	const scanned = records.length;
	const candidates = [];
	const skipped = [];
	let considered = 0;
	for (const record of records) {
		const header = record?.header ?? {};
		const sessionId = String(header.id ?? "");
		if (!sessionId.startsWith("session-")) continue;
		if (header.parentSession) continue;
		if (header.origin === "subagent") continue;
		if (!header.cwd) continue;
		const workspaceKey = workspaceKeyOf(header.cwd);
		if (scope && !scope.has(workspaceKey)) continue;
		considered += 1;
		candidates.push({
			sessionId,
			workspaceKey
		});
	}
	const titles = await readTitles(ctx, candidates.map((candidate) => candidate.sessionId));
	const plan = [];
	let skippedNonHub = 0;
	let pending = 0;
	for (const candidate of candidates) {
		const title = titles.get(candidate.sessionId);
		if (title === void 0) {
			pending += 1;
			skipped.push({
				sessionId: candidate.sessionId,
				reason: "title-unreadable"
			});
			continue;
		}
		if (!title.startsWith("SuperMemory 中枢")) {
			skippedNonHub += 1;
			continue;
		}
		plan.push({
			sessionId: candidate.sessionId,
			title,
			workspaceKey: candidate.workspaceKey
		});
	}
	const toWrite = [];
	for (const item of plan) {
		if (hubRecordOf(store, item.sessionId)) {
			skipped.push({
				sessionId: item.sessionId,
				title: item.title,
				reason: "already-recorded"
			});
			continue;
		}
		if (resolveRole(store, {
			id: item.sessionId,
			session: { header: { cwd: item.workspaceKey } }
		}).role === "branch") {
			skipped.push({
				sessionId: item.sessionId,
				title: item.title,
				reason: "branch-fact"
			});
			continue;
		}
		toWrite.push(item);
	}
	if (options.dryRun) return {
		status: "planned",
		scanned,
		considered,
		skippedNonHub,
		marked: 0,
		pending,
		skipped,
		plan: toWrite
	};
	let marked = 0;
	for (const item of toWrite) {
		await recordHubSession(store, {
			sessionId: item.sessionId,
			workspaceKey: item.workspaceKey,
			title: item.title,
			source: "title-migration"
		});
		if (hubRecordOf(store, item.sessionId)) marked += 1;
		else pending += 1;
	}
	if (pending === 0) await writeMarker(store);
	logger.info(`supermemory: hub record migration applied — scanned ${scanned}, considered ${considered}, marked ${marked}, skipped ${skipped.length}, pending ${pending}`);
	return {
		status: "applied",
		scanned,
		considered,
		skippedNonHub,
		marked,
		pending,
		skipped,
		plan: toWrite
	};
}
/** Below this length a body is treated as one fact without asking the model. */
const MULTI_FACT_MIN_CHARS = 100;
/**
* Zero-cost pre-check: does this body even look like it holds several facts?
* A short single-sentence conclusion (the common case) never burns a token.
*/
function mayHoldMultipleFacts(text) {
	const clean = String(text ?? "").trim();
	if (Array.from(clean).length < MULTI_FACT_MIN_CHARS) return false;
	if (clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length >= 2) return true;
	return clean.split(/[。；;！!？?]/).map((clause) => clause.trim()).filter(Boolean).length >= 3;
}
/**
* Validate the model's answer into atomic drafts. Accepts a bare array or
* `{entries: [...]}`; every entry keeps only what survives the conclusion
* rule, and duplicates inside one answer are dropped. Returns undefined when
* nothing usable remains (caller keeps the single original entry).
*/
function normalizeSplitResult(raw, fallback, max = 5) {
	const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? raw.entries : void 0;
	if (!Array.isArray(list)) return void 0;
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const record = item;
		const text = String(record.text ?? "").trim().slice(0, MEMORY_TEXT_MAX);
		if (text.length < 2) continue;
		if (!assessConclusion(text).ok) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const tags = normalizeTags(record.tags);
		const title = String(record.title ?? "").trim().slice(0, 48) || deriveTitle(text);
		out.push({
			title,
			tags: tags.length > 0 ? tags : normalizeTags(fallback.tags),
			text
		});
		if (out.length >= Math.max(1, max)) break;
	}
	return out.length > 0 ? out : void 0;
}
const SPLIT_SYSTEM = [
	"你是 SuperMemory 的记忆整形器。用户给出一段待写入的结论材料，请把它拆成多条【原子记忆】：每条只讲一个可独立复用的事实/决策/约定。",
	"只输出一个 JSON 对象，不要代码围栏、不要解释：",
	"{\"entries\":[{\"title\":\"一句可扫读的结论标题（≤48字）\",\"tags\":[\"3–8个检索短词\"],\"text\":\"自包含的一条结论正文\"}]}",
	"规则：",
	"- 明显是单条事实时只返回 1 条，不要硬拆；最多 5 条。",
	"- 每条必须自包含：脱离原文也读得懂，保留具体命令/路径/端口/版本等关键信息。",
	"- 丢弃派发包装文本、寒暄、命令行片段、版本行、疑问句等非结论内容。",
	"- 标签是检索索引，与正文分离；不要生成「本任/务是」式双字碎片。"
].join("\n");
/**
* Split one body into atomic entries with the model. Returns undefined — the
* caller then keeps exactly one entry — when there is no model, the body does
* not look multi-fact, the call fails, or the answer is unusable.
*/
async function splitMemoryEntries(deps, text, fallback) {
	const body = String(text ?? "").trim();
	if (!body) return void 0;
	if (!mayHoldMultipleFacts(body)) return void 0;
	const answer = await askLlmJson(deps, {
		system: SPLIT_SYSTEM,
		user: `待整形材料：\n\n${body}\n\n只返回 JSON。`,
		maxTokens: 900
	});
	if (answer === void 0) return void 0;
	return normalizeSplitResult(answer, fallback);
}
/**
* Core locked entries — always allowed, and the panel cannot uncheck them.
* These are the dispatch/relay spine, the two ways a hub talks to the user and
* to its branches, and (R55) the read-only capability knowledge face; without
* them a hub cannot do its job at all.
*/
const LOCKED_HUB_TOOLS = Object.freeze([
	"memory_dispatch",
	"memory_questions",
	"memory_recall",
	"ask_user_question",
	"send_message",
	"run_code",
	"sm_cap_doc"
]);
/**
* R60: the read-only session-history family — the five tools of the host
* package `@deepseek-ai/dsh-tool-session-query` (globally registered, every
* result authorized from the calling agent's workspace, NO write surface).
*
* Why a list, not just the prefix rule: the prefix decides the GROUP, this
* list decides the READ-ONLY BADGE and the default whitelist membership. Each
* name is backed by the package source (apply() registers exactly these five
* through ctx.tools.register); a future session_* tool would still group here
* but carry no verified read-only badge until it is added.
*/
const SESSION_HISTORY_TOOLS = Object.freeze([
	"session_search",
	"session_event_search",
	"session_trace",
	"session_event_trace",
	"session_event_read"
]);
/** R60: whether a name is one of the verified read-only session-history tools. */
function isSessionHistoryTool(toolName) {
	return SESSION_HISTORY_TOOLS.includes(String(toolName ?? "").trim());
}
/**
* The built-in default whitelist (R33's allowed set, unchanged in membership):
* the memory tools, the dispatch/collect line, the communication tools, the
* read-only inspection tools, the schedule family (prefix), and the PTC
* transport. `plugin_manager` is here on purpose (a hub may reload the plugin)
* but the panel lets the user switch it OFF, with the consequence spelled out.
*/
const DEFAULT_HUB_TOOLS = Object.freeze([
	"memory_dispatch",
	"memory_questions",
	"memory_resume",
	"memory_recall",
	"memory_remember",
	"memory_history",
	"memory_topicsets",
	"memory_new_topicset",
	"memory_export",
	"memory_scan",
	"memory_set_model",
	"memory_toolize",
	"sm_cap_doc",
	"ask_user_question",
	"send_message",
	"wait_agent",
	"list_agents",
	"read",
	"glob",
	"grep",
	...SESSION_HISTORY_TOOLS,
	"skill",
	"todo_write",
	"present",
	"run_code",
	"plugin_manager"
]);
/** Prefix entries of the built-in default whitelist (the schedule family). */
const DEFAULT_HUB_PREFIXES = Object.freeze(["schedule_"]);
/**
* Hands-on execution tools (the R33 blacklist, kept as KNOWLEDGE, not as a
* rule): they appear in the panel catalog with a risk note so a user can see
* what a hub would be able to do if they deliberately enabled one.
*/
const HUB_EXECUTION_TOOLS = Object.freeze([
	"bash",
	"gitbash_native",
	"write",
	"edit",
	"apply_patch",
	"multi_edit",
	"create_file",
	"delete_file",
	"move_file",
	"terminal_open",
	"terminal_read",
	"terminal_close",
	"terminal_signal",
	"job_kill",
	"office_render",
	"office_convert",
	"office_recalculate",
	"subagent",
	"subagent_fork",
	"workflow"
]);
/**
* Whitelist test. Locked entries pass even when a stored list omits them —
* the stored row is user data and must not be able to break the dispatch link.
*/
function isHubAllowedTool(toolName, policy) {
	const name = String(toolName ?? "");
	if (!name) return false;
	if (LOCKED_HUB_TOOLS.includes(name)) return true;
	if (policy.tools.includes(name)) return true;
	return policy.prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix));
}
/** True for an entry the panel must render as locked (cannot be unchecked). */
function isLockedHubTool(toolName) {
	return LOCKED_HUB_TOOLS.includes(toolName);
}
/**
* R55: is this name the capability EXECUTION surface (a concrete `sm_cap_*`
* tool, legacy `sm_composite_*` read the same way)? `sm_cap_doc` is the
* knowledge face, never execution.
*/
function isCapabilityExecutionTool(toolName) {
	const name = String(toolName ?? "").trim();
	if (!name || name === "sm_cap_doc") return false;
	return name.startsWith("sm_cap_") || name.startsWith("sm_composite_");
}
/**
* The panel badge a catalog row carries:
*   - `capabilityDoc` = read-only routing locked on (R55);
*   - `capabilityExecDenied` = a hub must dispatch the execution (R55);
*   - `sessionReadonly` = the verified read-only session-history family (R60).
* Undefined keeps the plain rendering.
*/
function hubCatalogNoteKey(toolName) {
	const name = String(toolName ?? "").trim();
	if (name === "sm_cap_doc") return "capabilityDoc";
	if (isCapabilityExecutionTool(name)) return "capabilityExecDenied";
	if (isSessionHistoryTool(name)) return "sessionReadonly";
}
/** De-duplicate, trim and drop empties; keeps the stored list canonical. */
function normalizePolicyList(values) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of values ?? []) {
		const name = String(value ?? "").trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}
/**
* Read the policy of one workspace. NEVER throws: an unreadable table, a
* malformed row or a missing workspace key degrades to the built-in default and
* reports through `warn` — the guard must keep deciding, and the default keeps
* the dispatch link alive.
*/
function readHubPolicy(store, workspaceKey, warn) {
	const fallback = () => ({
		tools: [...DEFAULT_HUB_TOOLS],
		prefixes: [...DEFAULT_HUB_PREFIXES],
		source: "default"
	});
	if (!store || !workspaceKey) return fallback();
	try {
		const table = store.hubPolicies;
		if (!table || typeof table.entries !== "function") return fallback();
		for (const [, row] of table.entries()) {
			if (!row || row.workspaceKey !== workspaceKey) continue;
			const tools = normalizePolicyList(row.tools ?? []);
			const prefixes = normalizePolicyList(row.prefixes ?? []);
			if (tools.length === 0 && prefixes.length === 0) {
				warn?.("supermemory: hub policy row for this workspace is empty; using the built-in default whitelist");
				return fallback();
			}
			return {
				tools,
				prefixes,
				source: "stored"
			};
		}
		return fallback();
	} catch (error) {
		warn?.("supermemory: hub policy read failed; using the built-in default whitelist: " + String(error).slice(0, 160));
		return fallback();
	}
}
/** Persist one workspace's policy (full replace; the panel always sends both lists). */
async function writeHubPolicy(store, workspaceKey, tools, prefixes, now = Date.now()) {
	const table = store.hubPolicies;
	if (!table) throw new Error("hub_policies 表不可用（存储域缺少该表）");
	const cleanTools = normalizePolicyList(tools);
	const cleanPrefixes = normalizePolicyList(prefixes);
	const merged = normalizePolicyList([...cleanTools, ...LOCKED_HUB_TOOLS]);
	let rowId;
	for (const [id, row] of table.entries()) if (row?.workspaceKey === workspaceKey) {
		rowId = id;
		break;
	}
	const record = {
		workspaceKey,
		tools: merged,
		prefixes: cleanPrefixes,
		updatedAt: now
	};
	if (rowId) await table.update(rowId, () => record);
	else await table.put(`hub-policy-${workspaceKey}`, record);
}
/** Drop the stored row so the workspace falls back to the built-in default. */
async function resetHubPolicy(store, workspaceKey) {
	const table = store.hubPolicies;
	if (!table) return false;
	let rowId;
	for (const [id, row] of table.entries()) if (row?.workspaceKey === workspaceKey) {
		rowId = id;
		break;
	}
	if (!rowId) return false;
	await table.delete(rowId);
	return true;
}
/** The meta-table row key of the one-time locked-entry merge marker. */
const LOCKED_MERGE_MARKER = "hub-policy-locked";
/**
* R55 one-time migration: merge {@link LOCKED_HUB_TOOLS} into every STORED
* workspace policy row. The guard already allows locked entries regardless of
* the row ({@link isHubAllowedTool}), so this is not a permission change — it
* makes the durable row tell the truth (the panel reads it back as checked),
* and it is the documented upgrade step for rows written before R55.
*
* Idempotent: after the first pass no row is missing a locked entry, so a
* second call reports `already-done` and writes nothing. A marker row records
* the check; `ignoreMarker` forces a re-scan (tests / restored backups).
*/
async function mergeLockedHubPolicies(store, options = {}) {
	const empty = (status) => ({
		status,
		rows: 0,
		updated: 0,
		added: []
	});
	if (!store) return empty("no-store");
	const table = store.hubPolicies;
	if (!table || typeof table.entries !== "function") return empty("no-store");
	const now = Number.isFinite(Number(options.now)) && Number(options.now) > 0 ? Number(options.now) : Date.now();
	try {
		if (!options.ignoreMarker) {
			const marker = await store.meta?.get?.(LOCKED_MERGE_MARKER);
			if (Number(marker?.hubPolicyLockedVersion ?? 0) >= 1) return {
				...empty("already-done"),
				status: "already-done"
			};
		}
		let rows = 0;
		let updated = 0;
		const added = /* @__PURE__ */ new Set();
		for (const [id, row] of table.entries()) {
			rows += 1;
			const tools = normalizePolicyList(row?.tools ?? []);
			const missing = LOCKED_HUB_TOOLS.filter((name) => !tools.includes(name));
			if (missing.length === 0) continue;
			const nextTools = normalizePolicyList([...tools, ...missing]);
			await table.update(id, (current) => ({
				...current,
				tools: nextTools,
				updatedAt: now
			}));
			updated += 1;
			for (const name of missing) added.add(name);
		}
		try {
			await store.meta?.put?.(LOCKED_MERGE_MARKER, {
				hubPolicyLockedVersion: 1,
				hubPolicyLockedMergedAt: now,
				hubPolicyLockedRows: rows,
				hubPolicyLockedUpdated: updated
			});
		} catch {}
		return {
			status: updated > 0 ? "merged" : "already-done",
			rows,
			updated,
			added: [...added]
		};
	} catch {
		return empty("no-store");
	}
}
/** Group ids the client maps to localized labels; any unknown id renders `label`. */
const HUB_CATALOG_GROUPS = Object.freeze({
	supermemory: "source:supermemory",
	composite: "source:composite",
	schedule: "source:schedule",
	session: "source:session",
	hostSession: "source:host-session",
	host: "source:host",
	mcpPrefix: "source:mcp:",
	declaredPrefix: "source:declared:",
	stale: "stale"
});
/**
* R40: 宿主会话工具合成清单 — tools a hub session can call even though the
* GLOBAL `ctx.tools.definitions()` view cannot see them.
*
* Why a list, not a rule: the Web surface disables the ordinary tool rows in
* the host layer and mounts them per agent/preset (`dsh-web-app/cordis.patch.yml`
* disables tool-fs/tool-fs-search/tool-jobs/tool-skill/tool-todo/tool-web/
* tool-subagent-control…, and the preset files mount them under the agent
* scope), so a scope-less `definitions()` never lists them. The panel service
* has no agent scope to ask, and the tool contract has no "per-session" flag.
* Every name below is therefore backed by a checked DSH registration fact; a
* fabricated name would claim availability the host never verified.
*
* Evidence classes:
*   - `reserved`: the runtime provides the name outside the registry and
*     rejects registration under it (`run_code`);
*   - `agent-scope`: the tool is registered by a shipped preset row through
*     `agent.ctx.tools.register` (verified in the DSH checkout's
*     `dsh-web-app/presets/*.patch.yml` and the tool package sources);
*   - `session-control`: the subagent/job/schedule families a hub needs to
*     talk to its branches and collect asynchronous results.
*
* Deliberately NOT synthesized: hands-on execution and third-party shell tools
* (`bash`, `gitbash_native`, `write`, `edit`, `office_*`, …). Their presence
* depends on the selected preset and installed bundles, so a workspace-level
* panel cannot truthfully claim `available: true` for them. They remain
* addable by name, and this list can be extended when the host exposes a
* per-scope enumeration.
*/
const HOST_SESSION_TOOLS = Object.freeze([
	"run_code",
	"plugin_manager",
	"ask_user_question",
	"send_message",
	"wait_agent",
	"list_agents",
	"todo_write",
	"present",
	"read",
	"read_image",
	"glob",
	"grep",
	"skill",
	"job_output",
	"job_list",
	"job_kill",
	"schedule_create",
	"schedule_list",
	"schedule_view",
	"schedule_edit"
]);
/**
* Per-name evidence, also the item description in the panel. Keep each line
* short: the client renders it as one muted paragraph under the name.
*/
const HOST_SESSION_TOOL_EVIDENCE = Object.freeze({
	run_code: "宿主保留名：PTC 程序传输由运行时直接提供，ToolsService.register 拒绝注册同名工具，全局 definitions() 永远不含它。",
	plugin_manager: "agent 级注册：@deepseek-ai/dsh-plugin-manager/tools 在会话的 agent.ctx 注册；标准预设启用，ptc 预设默认关闭。",
	ask_user_question: "agent 级注册：@deepseek-ai/dsh-tool-ask-user 由各 agent preset 挂载（标准/ptc 均启用）。",
	send_message: "agent 级注册：@deepseek-ai/dsh-tool-subagent-control 由 preset 挂载，负责分支消息。",
	wait_agent: "agent 级注册：@deepseek-ai/dsh-tool-subagent-control 由 preset 挂载，负责等待子代理输入。",
	list_agents: "agent 级注册：@deepseek-ai/dsh-tool-subagent-control 由 preset 挂载，负责子代理目录。",
	todo_write: "agent 级注册：@deepseek-ai/dsh-tool-todo 由 preset 挂载。",
	present: "agent 级注册：@deepseek-ai/dsh-tool-present 由 preset 挂载，负责交付文件卡片。",
	read: "agent 级注册：@deepseek-ai/dsh-tool-fs 由 preset 挂载（Web 面禁用了宿主全局行，改为每会话注册）。",
	read_image: "agent 级注册：@deepseek-ai/dsh-tool-fs 由 preset 挂载，负责图片读取。",
	glob: "agent 级注册：@deepseek-ai/dsh-tool-fs-search 由 preset 挂载。",
	grep: "agent 级注册：@deepseek-ai/dsh-tool-fs-search 由 preset 挂载。",
	skill: "agent 级注册：@deepseek-ai/dsh-tool-skill 由 preset 挂载。",
	job_output: "agent 级注册：@deepseek-ai/dsh-tool-jobs 由 preset 挂载，负责后台任务输出。",
	job_list: "agent 级注册：@deepseek-ai/dsh-tool-jobs 由 preset 挂载，负责后台任务列表。",
	job_kill: "agent 级注册：@deepseek-ai/dsh-tool-jobs 由 preset 挂载，负责取消后台任务（实操类）。",
	schedule_create: "agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。",
	schedule_list: "agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。",
	schedule_view: "agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。",
	schedule_edit: "agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。"
});
/** The synthetic source every {@link HOST_SESSION_TOOLS} entry belongs to. */
const HOST_SESSION_SOURCE = Object.freeze({
	id: HUB_CATALOG_GROUPS.hostSession,
	label: "宿主会话工具",
	kind: "host-session",
	inferred: false,
	hint: "不在全局注册面（宿主保留名 / agent 级注册 / 会话级 API），但中枢会话实际可用；合成项永不判失效，清理不会移除。"
});
/** Introspection keys a future host definition may use to declare its owner. */
const DECLARED_SOURCE_FIELDS = Object.freeze([
	"source",
	"sourceName",
	"owner",
	"ownerName",
	"plugin",
	"pluginName",
	"pluginId",
	"packageName",
	"serverName",
	"mcpServer"
]);
/**
* Read an optional host-declared source from a raw ToolDefinition. The current
* DSH contract has NO owner field (ToolSchema = name/description/parameters),
* so this normally returns undefined; it exists so a host that starts exposing
* one upgrades the catalog from "inferred" to "declared" without a release.
*/
function declaredHubToolSource(definition) {
	if (!definition || typeof definition !== "object") return void 0;
	const record = definition;
	for (const field of DECLARED_SOURCE_FIELDS) {
		const value = record[field];
		if (typeof value !== "string") continue;
		const clean = value.trim();
		if (clean.length > 0 && clean.length <= 120) return clean;
	}
}
const sourceSlug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "source";
/**
* Attribute one tool to a source. Rules, in order:
*   1. a declared field on the definition (never inferred);
*   2. `mcp__<server>__<tool>` → that MCP server;
*   3. `memory_*` → this plugin;
*   4. `sm_cap_*` → the capability family (legacy `sm_composite_*` is read the same way; R50 never registers those names);
*   5. `schedule_*` → the host scheduling plugin;
*   6. `session_*` → the read-only session-history family (R60);
*   7. everything else (including names nobody reviewed) → host/未归属.
* Every rule except (1) is an inference and is reported as one.
*/
function inferHubToolSource(name, declared) {
	const toolName = String(name ?? "").trim();
	const declaredSource = String(declared ?? "").trim();
	if (declaredSource) return {
		id: HUB_CATALOG_GROUPS.declaredPrefix + sourceSlug(declaredSource),
		label: declaredSource,
		kind: "declared",
		inferred: false,
		hint: "按工具定义自带的来源字段分组（宿主声明，非推断）"
	};
	if (toolName.startsWith("mcp__")) {
		const server = /^mcp__(.+?)__/.exec(toolName)?.[1] ?? "";
		return {
			id: HUB_CATALOG_GROUPS.mcpPrefix + (server || "unknown"),
			label: server ? `MCP · ${server}` : "MCP · 未知服务器",
			kind: "mcp",
			inferred: true,
			hint: "按 mcp__<server>__<tool> 命名前缀推断（服务器名含 __ 时可能解析不准）"
		};
	}
	if (toolName.startsWith("memory_")) return {
		id: HUB_CATALOG_GROUPS.supermemory,
		label: "SuperMemory 插件",
		kind: "supermemory",
		inferred: true,
		hint: "按 memory_* 前缀推断（本插件注册）"
	};
	if (toolName.startsWith("sm_cap_")) return {
		id: HUB_CATALOG_GROUPS.composite,
		label: "固化能力（SuperMemory）",
		kind: "composite",
		inferred: true,
		hint: "按 sm_cap_* 前缀推断（统一能力：知识面 + 执行面）"
	};
	if (toolName.startsWith("sm_composite_")) return {
		id: HUB_CATALOG_GROUPS.composite,
		label: "固化能力（SuperMemory，旧名）",
		kind: "composite",
		inferred: true,
		hint: "历史记录中的 sm_composite_* 前缀：只做读侧映射，不再注册"
	};
	if (toolName.startsWith("schedule_")) return {
		id: HUB_CATALOG_GROUPS.schedule,
		label: "调度",
		kind: "schedule",
		inferred: true,
		hint: "按 schedule_* 前缀推断（宿主调度插件）"
	};
	if (toolName.startsWith("session_")) return {
		id: HUB_CATALOG_GROUPS.session,
		label: "会话历史（只读）",
		kind: "session",
		inferred: true,
		hint: "按 session_* 前缀推断（宿主 dsh-tool-session-query：只读，按调用 agent 做工作区授权）"
	};
	return {
		id: HUB_CATALOG_GROUPS.host,
		label: "宿主内置 / 未归属",
		kind: "host",
		inferred: true,
		hint: "未命中已知来源规则：归入宿主内置或未归属（未知名同样默认拒绝）"
	};
}
/** First meaningful line of a tool description, stripped and clipped. */
function summarizeHubToolDescription(value, max = 140) {
	const clean = (String(value ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "").replace(/^[#>*+\-\s]+/, "").replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(1, max - 1))}…`;
}
/** Render order of source kinds: this plugin first, unattributed last. */
function hubSourceRank(source) {
	switch (source.kind) {
		case "supermemory": return 0;
		case "composite": return 1;
		case "mcp": return 2;
		case "schedule": return 3;
		case "session": return 4;
		case "declared": return 5;
		case "host-session": return 6;
		default: return 7;
	}
}
function sortHubItems(items) {
	return items.sort((left, right) => (left.prefix === right.prefix ? 0 : left.prefix ? -1 : 1) || (left.locked === right.locked ? 0 : left.locked ? -1 : 1) || left.name.localeCompare(right.name));
}
const groupBuckets = () => /* @__PURE__ */ new Map();
function bucketOf(buckets, source) {
	const existing = buckets.get(source.id);
	if (existing) return existing;
	const created = {
		source,
		items: []
	};
	buckets.set(source.id, created);
	return created;
}
/** Turn the buckets + stale rows into the final snapshot (stable ordering). */
function finalizeHubCatalog(buckets, stale, now, info) {
	const ordered = [...buckets.values()].sort((left, right) => hubSourceRank(left.source) - hubSourceRank(right.source) || left.source.label.localeCompare(right.source.label));
	const groups = ordered.map((bucket) => {
		const items = sortHubItems(bucket.items);
		return {
			id: bucket.source.id,
			label: bucket.source.label,
			kind: "source",
			inferred: bucket.source.inferred,
			...bucket.source.hint ? { hint: bucket.source.hint } : {},
			...bucket.source.kind === "host-session" ? { synthetic: true } : {},
			items,
			total: items.length,
			enabledCount: items.filter((entry) => entry.enabled).length
		};
	});
	const staleItems = [...stale].sort((left, right) => left.name.localeCompare(right.name));
	if (staleItems.length > 0) groups.push({
		id: HUB_CATALOG_GROUPS.stale,
		label: "已失效条目",
		kind: "stale",
		inferred: false,
		hint: "白名单里存在、当前运行时已不存在（工具被卸载/改名）；锁定项不可清理",
		items: staleItems,
		total: staleItems.length,
		enabledCount: staleItems.filter((entry) => entry.enabled).length
	});
	return {
		groups,
		stale: staleItems,
		meta: {
			generatedAt: now,
			mode: info.mode,
			toolCount: info.toolCount,
			syntheticCount: Math.max(0, Number(info.syntheticCount ?? 0)),
			groupCount: groups.length,
			anyDeclaredSource: ordered.some((bucket) => bucket.source.kind === "declared"),
			...info.warning ? { warning: info.warning } : {}
		}
	};
}
/**
* Build the catalog from the RUNTIME tool list. Every tool appears exactly
* once; unknown names land in the host bucket and stay default-denied. The
* explicit {@link HOST_SESSION_TOOLS} list fills the names the GLOBAL view
* cannot see (R40) and is never stale. Any other whitelisted name absent from
* the runtime list is moved to the stale bucket — never dropped.
*/
function buildHubCatalog(input) {
	const allowTools = normalizePolicyList(input.allowTools ?? []);
	const prefixes = normalizePolicyList(input.prefixes ?? []);
	const now = Number.isFinite(Number(input.now)) && Number(input.now) > 0 ? Number(input.now) : Date.now();
	const policy = {
		tools: allowTools,
		prefixes
	};
	const buckets = groupBuckets();
	const runtime = /* @__PURE__ */ new Map();
	const sources = /* @__PURE__ */ new Map();
	for (const raw of input.tools ?? []) {
		const name = String(raw?.name ?? "").trim();
		if (!name || runtime.has(name)) continue;
		const source = inferHubToolSource(name, typeof raw?.source === "string" ? raw.source : declaredHubToolSource(raw));
		sources.set(name, source);
		const description = summarizeHubToolDescription(raw?.description);
		const noteKey = hubCatalogNoteKey(name);
		runtime.set(name, {
			name,
			...description ? { description } : {},
			enabled: isHubAllowedTool(name, policy),
			available: true,
			source: source.id,
			...isLockedHubTool(name) ? { locked: true } : {},
			...HUB_EXECUTION_TOOLS.includes(name) ? { risk: true } : {},
			...noteKey ? { noteKey } : {}
		});
	}
	let syntheticCount = 0;
	for (const name of HOST_SESSION_TOOLS) {
		if (runtime.has(name)) continue;
		sources.set(name, HOST_SESSION_SOURCE);
		runtime.set(name, {
			name,
			description: HOST_SESSION_TOOL_EVIDENCE[name],
			enabled: isHubAllowedTool(name, policy),
			available: true,
			synthetic: true,
			source: HOST_SESSION_SOURCE.id,
			...name === "plugin_manager" ? { noteKey: "pluginManager" } : {},
			...hubCatalogNoteKey(name) ? { noteKey: hubCatalogNoteKey(name) } : {},
			...isLockedHubTool(name) ? { locked: true } : {},
			...HUB_EXECUTION_TOOLS.includes(name) ? { risk: true } : {}
		});
		syntheticCount += 1;
	}
	for (const entry of runtime.values()) bucketOf(buckets, sources.get(entry.name)).items.push(entry);
	for (const prefix of prefixes) {
		const matches = [...runtime.values()].filter((entry) => entry.name.startsWith(prefix));
		if (matches.length === 0) continue;
		const source = new Set(matches.map((entry) => entry.source)).size === 1 ? sources.get(matches[0].name) : inferHubToolSource(prefix);
		bucketOf(buckets, source).items.push({
			name: prefix,
			prefix: true,
			description: `前缀规则：放行所有 ${prefix}* 工具（当前匹配 ${matches.length} 个）`,
			enabled: true,
			available: true,
			source: source.id
		});
	}
	const stale = [];
	for (const name of allowTools) {
		if (runtime.has(name)) continue;
		const source = inferHubToolSource(name);
		stale.push({
			name,
			enabled: true,
			available: false,
			stale: true,
			source: source.id,
			...isLockedHubTool(name) ? { locked: true } : {},
			...HUB_EXECUTION_TOOLS.includes(name) ? { risk: true } : {},
			...hubCatalogNoteKey(name) ? { noteKey: hubCatalogNoteKey(name) } : {}
		});
	}
	for (const prefix of prefixes) {
		if ([...runtime.values()].some((entry) => entry.name.startsWith(prefix))) continue;
		const source = inferHubToolSource(prefix);
		stale.push({
			name: prefix,
			prefix: true,
			enabled: true,
			available: false,
			stale: true,
			source: source.id
		});
	}
	return finalizeHubCatalog(buckets, stale, now, {
		mode: "dynamic",
		toolCount: runtime.size,
		syntheticCount
	});
}
/**
* FALLBACK catalog: the built-in knowledge list, still grouped by the same
* source rules, and still carrying EVERY whitelisted entry (an entry the list
* does not know is added to the host group rather than dropped). `available`
* stays undefined because this path cannot verify runtime presence, and no
* stale group is fabricated from an unverifiable comparison.
*/
function buildFallbackHubCatalog(input) {
	const allowTools = normalizePolicyList(input.allowTools ?? []);
	const prefixes = normalizePolicyList(input.prefixes ?? []);
	const now = Number.isFinite(Number(input.now)) && Number(input.now) > 0 ? Number(input.now) : Date.now();
	const policy = {
		tools: allowTools,
		prefixes
	};
	const buckets = groupBuckets();
	const seen = /* @__PURE__ */ new Set();
	let listed = 0;
	const push = (item, source) => {
		bucketOf(buckets, source).items.push(item);
		if (item.prefix !== true) listed += 1;
	};
	for (const group of BUILTIN_HUB_CATALOG) for (const entry of group.items) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		const hostSession = entry.prefix !== true && HOST_SESSION_TOOLS.includes(entry.name);
		const source = hostSession ? HOST_SESSION_SOURCE : inferHubToolSource(entry.name);
		push({
			name: entry.name,
			...entry.prefix ? { description: `前缀规则：放行所有 ${entry.name}* 工具（内置清单，运行时未核验）` } : {},
			...hostSession ? { description: HOST_SESSION_TOOL_EVIDENCE[entry.name] } : {},
			...entry.prefix ? { prefix: true } : {},
			...hostSession ? {
				available: true,
				synthetic: true
			} : {},
			...entry.locked || isLockedHubTool(entry.name) ? { locked: true } : {},
			...entry.risk || HUB_EXECUTION_TOOLS.includes(entry.name) ? { risk: true } : {},
			...entry.noteKey ? { noteKey: entry.noteKey } : hostSession && entry.name === "plugin_manager" ? { noteKey: "pluginManager" } : hubCatalogNoteKey(entry.name) ? { noteKey: hubCatalogNoteKey(entry.name) } : {},
			enabled: entry.prefix ? prefixes.includes(entry.name) : isHubAllowedTool(entry.name, policy),
			source: source.id
		}, source);
	}
	for (const name of [...allowTools, ...prefixes]) {
		if (seen.has(name)) continue;
		seen.add(name);
		const isPrefix = prefixes.includes(name);
		const hostSession = !isPrefix && HOST_SESSION_TOOLS.includes(name);
		const source = hostSession ? HOST_SESSION_SOURCE : inferHubToolSource(name);
		push({
			name,
			...isPrefix ? { prefix: true } : {},
			description: hostSession ? HOST_SESSION_TOOL_EVIDENCE[name] : "白名单条目（内置回退：运行时是否存在未核验）",
			...hostSession ? {
				available: true,
				synthetic: true
			} : {},
			...isLockedHubTool(name) ? { locked: true } : {},
			...hostSession && name === "plugin_manager" ? { noteKey: "pluginManager" } : hubCatalogNoteKey(name) ? { noteKey: hubCatalogNoteKey(name) } : {},
			enabled: true,
			source: source.id
		}, source);
	}
	return finalizeHubCatalog(buckets, [], now, {
		mode: "fallback",
		toolCount: listed,
		warning: input.warning ?? "动态目录不可用，已回退内置清单"
	});
}
/**
* Drop whitelist entries the runtime no longer has. Locked entries are kept
* even when absent (the guard always allows them, so writing them out would
* only be relabelled next read); a prefix is kept while any runtime tool
* matches it.
*/
function cleanStaleHubPolicy(input) {
	const runtime = new Set((input.runtimeNames ?? []).map((name) => String(name ?? "").trim()).filter(Boolean));
	for (const name of HOST_SESSION_TOOLS) runtime.add(name);
	const tools = normalizePolicyList(input.allowTools ?? []);
	const prefixes = normalizePolicyList(input.prefixes ?? []);
	const removedNames = [];
	return {
		tools: tools.filter((name) => {
			const keep = runtime.has(name) || isLockedHubTool(name);
			if (!keep) removedNames.push(name);
			return keep;
		}),
		prefixes: prefixes.filter((prefix) => {
			const keep = [...runtime].some((name) => name.startsWith(prefix));
			if (!keep) removedNames.push(prefix);
			return keep;
		}),
		removed: removedNames.length,
		removedNames
	};
}
const item = (name, extra = {}) => ({
	name,
	...extra
});
/**
* The built-in catalog — the FALLBACK path only (R39). It still lists every
* tool the plugin knows about (so a host without `ctx.tools.definitions()` has
* a truthful, default-denied screen instead of a blank one), but the normal
* path is the runtime list grouped by source.
*/
const BUILTIN_HUB_CATALOG = Object.freeze([
	{
		id: "memory",
		items: [
			item("memory_remember"),
			item("memory_recall", { locked: true }),
			item("memory_history"),
			item("memory_topicsets"),
			item("memory_new_topicset"),
			item("memory_export"),
			item("memory_scan"),
			item("memory_set_model"),
			item("memory_toolize"),
			item("memory_ui"),
			item("memory_raise_question"),
			item("sm_cap_doc", {
				locked: true,
				noteKey: "capabilityDoc"
			})
		]
	},
	{
		id: "dispatch",
		items: [
			item("memory_dispatch", { locked: true }),
			item("memory_resume"),
			item("memory_questions", { locked: true })
		]
	},
	{
		id: "comm",
		items: [
			item("ask_user_question", { locked: true }),
			item("send_message", { locked: true }),
			item("wait_agent"),
			item("list_agents"),
			item("interrupt_agent", { risk: true }),
			item("propose_action")
		]
	},
	{
		id: "readonly",
		items: [
			item("read"),
			item("read_image"),
			item("glob"),
			item("grep"),
			item("lsp"),
			item("session_search"),
			item("session_trace"),
			item("session_event_search"),
			item("session_event_trace"),
			item("session_event_read"),
			item("list_subagent_models"),
			item("job_list"),
			item("job_output")
		]
	},
	{
		id: "schedule",
		items: [item("schedule_", { prefix: true })]
	},
	{
		id: "other",
		items: [
			item("run_code", { locked: true }),
			item("plugin_manager", { noteKey: "pluginManager" }),
			item("skill"),
			item("todo_write"),
			item("present"),
			item("update_goal"),
			item("create_goal"),
			item("get_goal"),
			item("cordis_inspect_list"),
			item("cordis_inspect_query"),
			item("web_search"),
			item("web_fetch"),
			...HUB_EXECUTION_TOOLS.map((name) => item(name, { risk: true })),
			item("terminal_list", { risk: true }),
			item("terminal_open", { risk: true }),
			item("terminal_read", { risk: true }),
			item("terminal_close", { risk: true }),
			item("terminal_signal", { risk: true }),
			item("job_kill", { risk: true }),
			item("ralph", { risk: true }),
			item("spawn_teammate", { risk: true })
		]
	}
]);
// src/panel.ts
var panel_exports = /* @__PURE__ */ __exportAll({ SupermemoryPanelService: () => SupermemoryPanelService });
/**
* R59: the naming gate's logger. The old naming paths passed
* `{ warn: () => {} }`, which is exactly why the R43 write failure stayed
* invisible for weeks — a title failure is always reported now.
*/
const panelTitleLogger = {
	warn: (msg) => console.warn(msg),
	info: (msg) => console.info(msg)
};
/**
* Sessions this panel resumed so the user can keep talking inside the panel.
* Deliberately NOT disposed here: `resume` makes the session live for the user,
* and killing it on a plugin reload would drop the conversation. DSH closes it
* with the app.
*/
const resumedChatHandles = /* @__PURE__ */ new Map();
/** R30 需求②: 「未归集」虚拟集合的标题（id 为空串；与面板 locales 同一词汇）。 */
const UNGROUPED_TITLE = "未归集";
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
	return clipMarked(text, maxChars);
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
	/**
	* A3: 一条 tool_memory 行是否适用于给定工作区。能力按行级归属或 scope 推导
	* （与 composite.capabilityAppliesToWorkspace 同一语义）；序列组合工具无归属
	* 无 scope = 全局，任何工作区照常可见。
	*/
	toolApplies(record, workspaceKey) {
		if (!workspaceKey) return true;
		if (record.workspaceKey) return record.workspaceKey === workspaceKey;
		try {
			const spec = JSON.parse(record.entry);
			if (spec.scope) return workspaceKeyOf(spec.scope) === workspaceKey;
		} catch {}
		return true;
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
		const latestTasks = latestTaskByBranch(this.store);
		const branchMeta = latestBranchMeta(this.store);
		return {
			id,
			title: topicSet.title,
			tags: topicSet.keywords,
			summary: topicSet.summary,
			sessions: topicSet.members.length,
			live: topicSet.members.filter((member) => member.status === "live").length,
			status: topicSet.status,
			branches: topicSet.members.map((m) => {
				const isBranch = m.kind === "fork" || isPluginBranchId(m.sessionId);
				const hubCount = isBranch ? hubCounts.get(m.sessionId)?.length : void 0;
				const meta = branchMeta.get(m.sessionId);
				return {
					sessionId: m.sessionId,
					kind: isBranch ? "fork" : "root",
					title: (isBranch ? meta?.title : "") || m.title,
					status: m.status,
					...m.model ? { model: m.model } : {},
					...isBranch ? {
						topicSetId: id,
						topicSetTitle: topicSet.title
					} : {},
					...hubCount ? { hubs: hubCount } : {},
					...isBranch && latestTasks.get(m.sessionId) ? { task: taskExcerpt(latestTasks.get(m.sessionId), 48) } : {},
					...isBranch && meta && meta.tags.length > 0 ? { tags: [...meta.tags] } : {}
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
		const collections = new Map(listCollections(this.store, workspaceKey));
		const memories = [];
		for (const [id, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey) continue;
			const collection = record.collectionId ? collections.get(record.collectionId) : void 0;
			memories.push({
				id,
				title: record.title,
				tags: record.keywords,
				text: record.text,
				key: record.key,
				status: record.status,
				sourceSessionId: record.sourceSessionId,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				version: currentVersionOf(record),
				...collection ? {
					collectionId: record.collectionId,
					collectionTitle: collection.title,
					collectionTags: [...collection.keywords]
				} : {}
			});
		}
		memories.sort((a, b) => b.updatedAt - a.updatedAt);
		let requirements = 0;
		for (const [, record] of this.store.requirements.entries()) if (record.workspaceKey === workspaceKey && record.status === "open") requirements++;
		const ownSetIds = topicSetIdsOf(this.store, workspaceKey);
		let episodes = 0;
		for (const [, episode] of this.store.episodes.entries()) if (episode.topicSetId && ownSetIds.has(episode.topicSetId)) episodes++;
		let dispatches = 0;
		for (const [, record] of this.store.dispatches.entries()) {
			if (record.status === "delivered" || record.status === "failed" || record.status === "interrupted") continue;
			if (record.topicSetId && !ownSetIds.has(record.topicSetId)) continue;
			dispatches++;
		}
		let tools = 0;
		for (const [, record] of this.store.toolMemory.entries()) {
			if (record.kind !== "composite") continue;
			if (!this.toolApplies(record, workspaceKey)) continue;
			tools++;
		}
		return {
			sessionId,
			workspaceKey,
			...getRouting(this.store, sessionId)?.activeTopicSetId ? { activeTopicSetId: getRouting(this.store, sessionId).activeTopicSetId } : {},
			topicSets,
			memories,
			counts: {
				memories: memories.length,
				requirements,
				episodes,
				dispatches,
				tools
			}
		};
	}
	/** Memories of one workspace, newest first; `query` filters by text/keywords. */
	listMemories(cwd, query, limit) {
		const workspaceKey = this.wk(cwd);
		const tokens = query ? new Set(tokenize(query)) : /* @__PURE__ */ new Set();
		const collections = new Map(listCollections(this.store, workspaceKey));
		const rows = [];
		for (const [id, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey) continue;
			const titleBag = new Set(tokenize(record.title ?? ""));
			const tagBag = new Set(tokenize(record.keywords.join(" ")));
			const bodyBag = new Set(tokenize(`${record.text} ${record.key ?? ""}`));
			let score = 0;
			for (const token of tokens) if (titleBag.has(token)) score += 4;
			else if (tagBag.has(token)) score += 3;
			else if (bodyBag.has(token)) score += 1;
			if (tokens.size > 0 && score === 0) continue;
			const collection = record.collectionId ? collections.get(record.collectionId) : void 0;
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
					updatedAt: record.updatedAt,
					version: currentVersionOf(record),
					...collection ? {
						collectionId: record.collectionId,
						collectionTitle: collection.title,
						collectionTags: [...collection.keywords]
					} : {}
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
		const sameKey = stableKey ? findMemoryByKey(this.store, workspaceKey, stableKey) : void 0;
		if (sameKey) {
			const [memoryId, existing] = sameKey;
			if (memoryContentUnchanged(existing, {
				title: cleanTitle,
				text: body,
				tags: cleanTags
			})) return {
				status: "ok",
				id: memoryId,
				message: `该 key 已存相同内容，未重复写入（当前 v${currentVersionOf(existing)}）。`
			};
			const decisionDeps = {
				ctx: this.ctx,
				logger: { warn: (msg) => console.warn(msg) }
			};
			const assignment = await resolveCollectionForEntry(this.store, workspaceKey, {
				title: cleanTitle,
				keywords: cleanTags,
				text: body
			}, {
				now,
				deps: decisionDeps
			});
			if ("error" in assignment) return {
				status: "error",
				message: assignment.error
			};
			const result = await updateMemoryVersioned(this.store, workspaceKey, memoryId, {
				title: cleanTitle,
				text: body,
				tags: cleanTags,
				...assignment.collectionId ? { collectionId: assignment.collectionId } : {}
			}, now);
			if (!result) return {
				status: "error",
				message: "key 对应的记忆不存在或不属于当前工作区。"
			};
			if (result.status === "unchanged") return {
				status: "ok",
				message: `该 key 已存相同内容，未重复写入（当前 v${result.version}）。`,
				id: memoryId
			};
			if (assignment.collectionId) await touchCollection(this.store, assignment.collectionId, now);
			return {
				status: "ok",
				id: memoryId,
				message: `已更新到 v${result.version}（旧版本已归档，可在详情里查看历史）${assignment.title ? `，归入记忆集合「${assignment.title}」` : ""}。`
			};
		}
		for (const [memoryId, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey || record.status !== "active") continue;
			if (record.text.trim().toLowerCase() === body.toLowerCase()) return {
				status: "ok",
				message: "相同记忆已存在。",
				id: memoryId
			};
		}
		const decisionDeps = {
			ctx: this.ctx,
			logger: { warn: (msg) => console.warn(msg) }
		};
		const atomic = (await splitMemoryEntries(decisionDeps, body, {
			title: cleanTitle,
			tags: cleanTags
		}) ?? [{
			title: cleanTitle,
			tags: cleanTags,
			text: body
		}]).filter((draft) => draft.text && assessConclusion(draft.text).ok);
		const entries = atomic.length > 0 ? atomic : [{
			title: cleanTitle,
			tags: cleanTags,
			text: body
		}];
		const split = entries.length > 1;
		const created = [];
		const duplicateIds = [];
		for (const entry of entries) {
			if (split) {
				let exists = false;
				for (const [memoryId, record] of this.store.memories.entries()) {
					if (record.workspaceKey !== workspaceKey || record.status !== "active") continue;
					if (record.text.trim().toLowerCase() === entry.text.toLowerCase()) {
						exists = true;
						duplicateIds.push(memoryId);
						break;
					}
				}
				if (exists) continue;
			}
			const entryTags = mergeTags(entry.tags, cleanTags);
			const assignment = await resolveCollectionForEntry(this.store, workspaceKey, {
				title: entry.title,
				keywords: entryTags,
				text: entry.text
			}, {
				now,
				deps: decisionDeps
			});
			if ("error" in assignment) return {
				status: "error",
				message: assignment.error
			};
			const memoryId = await createMemoryVersioned(this.store, workspaceKey, {
				title: entry.title,
				text: entry.text,
				tags: entryTags,
				...split ? {} : stableKey ? { key: stableKey } : {},
				...assignment.collectionId ? { collectionId: assignment.collectionId } : {},
				sourceSessionId: "",
				sourceSeq: 0
			}, now);
			if (assignment.collectionId) await touchCollection(this.store, assignment.collectionId, now);
			created.push({
				id: memoryId,
				collectionTitle: assignment.title,
				note: collectionTierNote(assignment)
			});
		}
		if (created.length === 0) return {
			status: "ok",
			message: "相同记忆已存在，未重复写入。",
			...duplicateIds[0] ? { id: duplicateIds[0] } : {}
		};
		const first = created[0];
		const skipped = duplicateIds.length > 0 ? `其中 ${duplicateIds.length} 条已存在，未重复写入。` : "";
		return {
			status: "ok",
			id: first.id,
			message: split ? `已拆分为 ${created.length} 条记忆，分别归入：${created.map((row) => row.collectionTitle ? `「${row.collectionTitle}」` : "未归集").join("、")}。${skipped}` : `已记住（v1）${first.note ? `（${first.note}）` : ""}。${skipped}`
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
		const result = await updateMemoryVersioned(this.store, workspaceKey, id, {
			text: body,
			...key !== void 0 ? { key: key.trim() || void 0 } : {},
			...title !== void 0 ? { title: String(title).trim().slice(0, 48) || deriveTitle(body) } : {},
			...tags !== void 0 ? { tags: mergeTags(normalizeTags(tags), tagsOfBody(body)) } : {}
		});
		if (!result) return {
			status: "error",
			message: "记忆不存在或不属于当前工作区。"
		};
		if (result.status === "unchanged") return {
			status: "ok",
			message: `内容没有变化，未升版（当前 v${result.version}）。`,
			id
		};
		return {
			status: "ok",
			message: `已更新到 v${result.version}（旧版本已归档）。`,
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
	* R36 需求② / R39: 中枢权限页签的一次性快照——当前白名单、内置默认、锁定项，
	* 以及每次调用都从运行时重新生成的工具目录（按来源分组；宿主枚举失败时回退
	* 内置清单并告警，页面不白屏，但默认路径永远是动态目录）。
	*/
	getHubPolicy(cwd) {
		const workspaceKey = this.wk(cwd);
		const resolved = readHubPolicy(this.store, workspaceKey, (message) => console.warn(message));
		const snapshot = this.hubPolicyCatalogSnapshot(resolved.tools, resolved.prefixes);
		return {
			workspaceKey,
			tools: [...resolved.tools],
			prefixes: [...resolved.prefixes],
			source: resolved.source,
			locked: [...LOCKED_HUB_TOOLS],
			defaults: {
				tools: [...DEFAULT_HUB_TOOLS],
				prefixes: [...DEFAULT_HUB_PREFIXES]
			},
			catalog: snapshot.groups,
			catalogMeta: snapshot.meta,
			stale: snapshot.stale
		};
	}
	/**
	* R39: 一键清理失效条目——白名单里有、当前运行时已不存在的工具（插件卸载/
	* 改名）与匹配不到任何工具的前缀。锁定项永不清理（guard 始终放行它们）；
	* 动态枚举失败时拒绝清理而不是瞎猜。原为内置默认时，清理会落一行工作区
	* 自定义白名单（在回执里说明）。
	*/
	async cleanupStaleHubPolicy(cwd) {
		const workspaceKey = this.wk(cwd);
		const resolved = readHubPolicy(this.store, workspaceKey, (message) => console.warn(message));
		let runtimeNames;
		try {
			runtimeNames = this.runtimeHubTools().map((tool) => tool.name);
		} catch (error) {
			return {
				status: "error",
				message: `动态目录不可用，无法判断失效条目：${String(error instanceof Error ? error.message : error).slice(0, 160)}`
			};
		}
		const cleaned = cleanStaleHubPolicy({
			allowTools: resolved.tools,
			prefixes: resolved.prefixes,
			runtimeNames
		});
		if (cleaned.removed === 0) return {
			status: "ok",
			message: "没有失效条目需要清理。"
		};
		try {
			await writeHubPolicy(this.store, workspaceKey, cleaned.tools, cleaned.prefixes);
		} catch (error) {
			return {
				status: "error",
				message: `清理失效条目失败：${String(error).slice(0, 160)}`
			};
		}
		const preview = cleaned.removedNames.slice(0, 5).join("、") + (cleaned.removedNames.length > 5 ? "…" : "");
		return {
			status: "ok",
			message: `已清理 ${cleaned.removed} 个失效条目（${preview}）并保存。` + (resolved.source === "default" ? "原为内置默认，本次已写入工作区自定义白名单。" : "")
		};
	}
	/**
	* R36 需求②: 保存白名单（整份替换：面板总是把两个列表一起送来）。锁定项在
	* 写入时合并回去，用户无法通过一次保存把自己锁在派发链路之外。
	*/
	async setHubPolicy(cwd, patch) {
		const workspaceKey = this.wk(cwd);
		if (patch.reset) {
			try {
				await resetHubPolicy(this.store, workspaceKey);
			} catch (error) {
				return {
					status: "error",
					message: `恢复默认失败：${String(error).slice(0, 160)}`
				};
			}
			return {
				status: "ok",
				message: "已恢复内置默认白名单（下一个工具调用即生效）。"
			};
		}
		const tools = Array.isArray(patch.tools) ? patch.tools : void 0;
		const prefixes = Array.isArray(patch.prefixes) ? patch.prefixes : void 0;
		if (!tools || !prefixes) return {
			status: "error",
			message: "保存白名单需要同时提供 tools 与 prefixes 两个列表。"
		};
		try {
			await writeHubPolicy(this.store, workspaceKey, tools, prefixes);
		} catch (error) {
			return {
				status: "error",
				message: `保存失败：${String(error).slice(0, 160)}`
			};
		}
		return {
			status: "ok",
			message: "白名单已保存（下一个工具调用即生效）。"
		};
	}
	/**
	* R41 需求①b: the 设置 tab's default-model snapshot (per workspace).
	*/
	getModelDefaults(cwd) {
		return readModelDefaults(this.store, this.wk(cwd));
	}
	/**
	* R41 需求①b: save the 设置 tab's default models. A missing selection means
	* "follow the existing chain"; `null` clears one kind; `reset` clears both.
	*/
	async setModelDefaults(cwd, patch) {
		const workspaceKey = this.wk(cwd);
		const hub = patch?.hub === null ? null : patch?.hub ?? void 0;
		const branch = patch?.branch === null ? null : patch?.branch ?? void 0;
		if (!patch?.reset && hub === void 0 && branch === void 0) return {
			status: "error",
			message: "没有要保存的默认模型。"
		};
		try {
			const saved = await writeModelDefaults(this.store, workspaceKey, { ...patch?.reset ? { reset: true } : {
				hub,
				branch
			} });
			const hubName = saved.hub ? `${saved.hub.provider}/${saved.hub.model}` : "跟随宿主默认";
			const branchName = saved.branch ? `${saved.branch.provider}/${saved.branch.model}` : "跟随话题集/中枢/宿主默认";
			return {
				status: "ok",
				message: patch?.reset ? "已恢复默认设置（中枢/分支会话跟随既有链路）。" : `默认模型已保存：中枢会话 ${hubName}；分支会话 ${branchName}。`
			};
		} catch (error) {
			return {
				status: "error",
				message: `保存默认模型失败：${String(error).slice(0, 160)}`
			};
		}
	}
	/**
	* R39: 宿主运行时工具清单——直接读 `ctx.tools.definitions()`（宿主契约：
	* ToolDefinition extends ToolSchema，只有 name/description/parameters，没有
	* owner/plugin 字段）。无该 seams、抛错或返回空清单都视为失败，由调用方回退
	* 内置清单并告警；成功时只投影本模块需要的字段（name/description/来源）。
	* 作用域：不传 scope = 全局视图（panel 服务不是 agent 作用域），因此
	* agent 级 scoped 工具与 preset/session 级 restrict 不在目录里——见
	* DEV-NOTES §47 的限制说明。
	*/
	runtimeHubTools() {
		const tools = this.ctx?.tools;
		if (!tools || typeof tools.definitions !== "function") throw new Error("宿主未暴露 ctx.tools.definitions()");
		const definitions = tools.definitions();
		if (!Array.isArray(definitions)) throw new Error("ctx.tools.definitions() 未返回数组");
		const descriptors = [];
		for (const definition of definitions) {
			const record = definition;
			const name = String(record?.name ?? "").trim();
			if (!name) continue;
			const declared = declaredHubToolSource(definition);
			const description = typeof record?.description === "string" ? record.description : void 0;
			descriptors.push({
				name,
				...description ? { description } : {},
				...declared ? { source: declared } : {}
			});
		}
		if (descriptors.length === 0) throw new Error("ctx.tools.definitions() 返回空清单");
		return descriptors;
	}
	/**
	* R39: 动态目录 + 内置回退（永不抛）。失败路径必须留下告警：页面显示
	* 「内置回退」徽标与警告条，而不是白屏或静默换源。
	*/
	hubPolicyCatalogSnapshot(allowTools, prefixes) {
		const now = Date.now();
		try {
			return buildHubCatalog({
				tools: this.runtimeHubTools(),
				allowTools,
				prefixes,
				now
			});
		} catch (error) {
			const warning = `动态工具目录生成失败，已回退内置清单：${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
			console.warn("supermemory: " + warning);
			return buildFallbackHubCatalog({
				allowTools,
				prefixes,
				now,
				warning
			});
		}
	}
	/**
	* R30 需求②: 记忆页签第一级——本工作区的记忆集合卡片（标题/标签/条目数/
	* 最近更新）。条目数按集合聚合（含未归集：id 为空串的虚拟集合，让旧数据
	* 与「没归集」的新数据在面板里仍然可见，不丢条目）。
	*/
	listMemoryCollections(cwd) {
		const workspaceKey = this.wk(cwd);
		const stats = /* @__PURE__ */ new Map();
		for (const [, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey) continue;
			const id = record.collectionId ?? "";
			const row = stats.get(id) ?? {
				count: 0,
				latest: 0
			};
			row.count += 1;
			if (record.updatedAt > row.latest) row.latest = record.updatedAt;
			stats.set(id, row);
		}
		const rows = [];
		for (const [id, collection] of listCollections(this.store, workspaceKey)) {
			const row = stats.get(id) ?? {
				count: 0,
				latest: collection.updatedAt
			};
			rows.push({
				id,
				title: collection.title,
				tags: [...collection.keywords],
				summary: collection.summary,
				count: row.count,
				latestUpdatedAt: row.latest,
				status: collection.status,
				createdAt: collection.createdAt,
				updatedAt: collection.updatedAt
			});
		}
		const loose = stats.get("");
		if (loose && loose.count > 0) rows.push({
			id: "",
			title: UNGROUPED_TITLE,
			tags: [],
			summary: "",
			count: loose.count,
			latestUpdatedAt: loose.latest,
			status: "active",
			createdAt: 0,
			updatedAt: loose.latest
		});
		rows.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt || a.title.localeCompare(b.title));
		return rows;
	}
	/**
	* R30 需求②: 记忆页签第二级——一个集合（collectionId；'' = 未归集）里的全部
	* 条目，按更新时间倒序。`query` 命中标题/标签/正文/key 时只返回匹配行。
	*/
	listMemoriesByCollection(cwd, collectionId, query, limit) {
		const workspaceKey = this.wk(cwd);
		const wanted = collectionId ?? "";
		const tokens = query ? new Set(tokenize(query)) : /* @__PURE__ */ new Set();
		const collections = new Map(listCollections(this.store, workspaceKey));
		const rows = [];
		for (const [id, record] of this.store.memories.entries()) {
			if (record.workspaceKey !== workspaceKey) continue;
			if ((record.collectionId ?? "") !== wanted) continue;
			const titleBag = new Set(tokenize(record.title ?? ""));
			const tagBag = new Set(tokenize(record.keywords.join(" ")));
			const bodyBag = new Set(tokenize(`${record.text} ${record.key ?? ""}`));
			let score = 0;
			for (const token of tokens) if (titleBag.has(token)) score += 4;
			else if (tagBag.has(token)) score += 3;
			else if (bodyBag.has(token)) score += 1;
			if (tokens.size > 0 && score === 0) continue;
			const collection = record.collectionId ? collections.get(record.collectionId) : void 0;
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
					updatedAt: record.updatedAt,
					version: currentVersionOf(record),
					...collection ? {
						collectionId: record.collectionId,
						collectionTitle: collection.title,
						collectionTags: [...collection.keywords]
					} : {}
				}
			});
		}
		rows.sort((a, b) => b.score - a.score || b.view.updatedAt - a.view.updatedAt);
		const cap = Math.max(1, Math.min(200, Number(limit) || 100));
		return rows.slice(0, cap).map((row) => row.view);
	}
	/**
	* R30 需求②: 记忆详情——当前字段 + 全部历史版本（最后一条即当前版本；
	* 旧存储域没有历史表时只有当前版本，可正常打开详情）。
	*/
	getMemoryDetail(cwd, id) {
		const workspaceKey = this.wk(cwd);
		const record = this.store.memories.get(id);
		if (!record || record.workspaceKey !== workspaceKey) return void 0;
		const collections = new Map(listCollections(this.store, workspaceKey));
		const collection = record.collectionId ? collections.get(record.collectionId) : void 0;
		return {
			view: {
				id,
				title: record.title,
				tags: record.keywords,
				text: record.text,
				key: record.key,
				status: record.status,
				sourceSessionId: record.sourceSessionId,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				version: currentVersionOf(record),
				...collection ? {
					collectionId: record.collectionId,
					collectionTitle: collection.title,
					collectionTags: [...collection.keywords]
				} : {}
			},
			versions: memoryHistoryOf(this.store, id).map((row) => ({
				version: row.version,
				updatedAt: row.updatedAt,
				title: row.title ?? "",
				tags: [...row.tags ?? []],
				text: row.text,
				changeType: row.changeType,
				...row.collectionId ? { collectionId: row.collectionId } : {}
			}))
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
	* R59 Phase 1b-2: manually rename a hub or a work branch from the panel.
	*
	* One final string (validated by the policy, ≤ 80 UTF-8 bytes) is written to
	* the host + hub mirror by the gate and then into the durable copies
	* (`dispatches.title` and the topic-set member title) by the service, so the
	* rail, the card and the host sidebar never split. A cold session is NOT
	* resumed: the caller gets `needsOpen` instead of a false success.
	*/
	async renameSessionTitle(cwd, sessionId, title) {
		const id = String(sessionId ?? "").trim();
		if (!id) return {
			status: "error",
			message: "缺少会话 id。"
		};
		const ctx = this.ctx;
		if (!ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法改名。"
		};
		const validated = validateManualTitle(String(title ?? ""));
		if (!validated.ok) return {
			status: "error",
			message: validated.error
		};
		const row = titleRow(this.store, id);
		const kind = titleKindOf(this.store, id, row?.kind);
		const result = await renameSessionWithDurables({
			ctx,
			store: this.store,
			logger: panelTitleLogger
		}, {
			sessionId: id,
			title: validated.title,
			workspaceKey: row?.workspaceKey || this.wk(cwd),
			kind,
			defer: true
		});
		if (result.outcome === "skipped" && result.reason === "session-not-live") return {
			status: "error",
			message: "会话未运行：打开该会话后再重命名（不会在后台恢复会话）。",
			id,
			needsOpen: true
		};
		if (result.outcome === "host" || result.outcome === "fallback" || result.outcome === "already") return {
			status: "ok",
			message: "已重命名为「" + result.title + "」。",
			id
		};
		return {
			status: "error",
			message: "重命名失败：" + (result.reason ?? "宿主未接受该标题"),
			id
		};
	}
	/**
	* R59 Phase 1b-2: restore the AUTOMATIC title preserved by a manual / external
	* rename. The host + mirror + durable copies are rewritten together. A row
	* whose automatic title is unknown (legacy adoption) is reported explicitly and
	* left untouched — never replaced by the human title.
	*/
	async resetSessionTitle(cwd, sessionId) {
		const id = String(sessionId ?? "").trim();
		if (!id) return {
			status: "error",
			message: "缺少会话 id。"
		};
		const ctx = this.ctx;
		if (!ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法恢复自动命名。"
		};
		const row = titleRow(this.store, id);
		const kind = titleKindOf(this.store, id, row?.kind);
		const result = await resetSessionWithDurables({
			ctx,
			store: this.store,
			logger: panelTitleLogger
		}, {
			sessionId: id,
			workspaceKey: row?.workspaceKey || this.wk(cwd),
			kind,
			defer: true
		});
		if (result.outcome === "skipped") {
			if (result.reason === "no-auto-title") return {
				status: "error",
				message: "没有可恢复的自动标题（该会话尚未记录自动命名）；请直接重命名。",
				id
			};
			if (result.reason === "session-not-live") return {
				status: "error",
				message: "会话未运行：打开会话后再恢复自动命名（不会在后台恢复会话）。",
				id,
				needsOpen: true
			};
			if (result.reason === "no-row") return {
				status: "error",
				message: "该会话没有命名记录，无法恢复自动命名。",
				id
			};
		}
		if (result.outcome === "host" || result.outcome === "fallback" || result.outcome === "already") return {
			status: "ok",
			message: "已恢复自动命名：「" + result.title + "」。",
			id
		};
		return {
			status: "error",
			message: "恢复自动命名失败：" + (result.reason ?? "宿主未接受该标题"),
			id
		};
	}
	/**
	* R59 Phase 1b-2: repair a neutral/deferred title through the same reconcile
	* path used at startup. A cold session is never resumed — the caller gets
	* `needsOpen` and the first live event / next startup repairs it.
	*/
	async repairSessionTitle(cwd, sessionId) {
		const id = String(sessionId ?? "").trim();
		if (!id) return {
			status: "error",
			message: "缺少会话 id。"
		};
		const ctx = this.ctx;
		if (!ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法修复标题。"
		};
		if (!isSessionLive(ctx, id)) return {
			status: "ok",
			message: "会话未运行：打开该会话后会自动修复标题（不会在后台恢复会话）。",
			id,
			needsOpen: true
		};
		const row = titleRow(this.store, id);
		if (row?.state === "user-locked") return {
			status: "error",
			message: "标题已被人工锁定；请使用「恢复自动命名」。",
			id
		};
		const workspace = row?.workspaceKey || this.wk(cwd);
		const kind = titleKindOf(this.store, id, row?.kind);
		const host = readHostTitle(ctx, id)?.title ?? "";
		if (!row && host && !isNeutralTitle(host, workspace) && !isLegacyHubTitle(host)) return {
			status: "ok",
			message: "当前标题已包含主题，无需修复。",
			id
		};
		let result = await reconcileSessionTitle({
			ctx,
			store: this.store,
			logger: panelTitleLogger
		}, id, {
			reason: "panel-repair",
			defer: true
		});
		if (!result) {
			const mirror = hubRecord(this.store, id)?.title ?? "";
			const target = mirror && !isNeutralTitle(mirror, workspace) ? clipTitleBytes(mirror) : row?.autoTitle || row?.desiredTitle || (kind === "hub" ? composeHubTitle(workspace, "") : memberTitleOf(this.store, id));
			if (!target) return {
				status: "error",
				message: "没有可修复的标题（没有镜像或自动标题）。",
				id
			};
			result = await applySessionTitle({
				ctx,
				store: this.store,
				logger: panelTitleLogger
			}, {
				sessionId: id,
				workspaceKey: workspace,
				kind,
				explicitTitle: target,
				source: "reconcile",
				force: true,
				defer: true
			});
		}
		if (result.outcome === "host" || result.outcome === "fallback" || result.outcome === "already") return {
			status: "ok",
			message: "已修复标题：「" + result.title + "」。",
			id
		};
		if (result.outcome === "locked") return {
			status: "error",
			message: "宿主标题已被外部改名，已标记为用户锁定；可用「恢复自动命名」。",
			id
		};
		return {
			status: "error",
			message: "修复失败：" + (result.reason ?? result.outcome),
			id
		};
	}
	/**
	* R30 需求③: EVERY topic set of the workspace — the hub's management view.
	* `listTopicSets` above stays active-only (the 话题集 tab); this one adds the
	* archived sets (each row carries `status`) so a hub can still inspect, tag or
	* re-activate history instead of losing it from every list.
	*/
	listAllTopicSets(cwd) {
		const workspaceKey = this.wk(cwd);
		const rows = [];
		const ordered = [];
		for (const [id, topicSet] of this.store.topicsets.entries()) {
			if (topicSet.workspaceKey !== workspaceKey) continue;
			ordered.push([id, topicSet]);
		}
		ordered.sort((a, b) => (a[1].status === "archived" ? 1 : 0) - (b[1].status === "archived" ? 1 : 0) || b[1].lastActiveAt - a[1].lastActiveAt);
		for (const [id, topicSet] of ordered) rows.push(this.view(id, topicSet));
		return rows;
	}
	/**
	* R30 需求③: every BRANCH session of the workspace, across topic sets — the
	* hub's cross-set view (title / tags / owning set / status / last activity),
	* optionally filtered to one topic set. Projected from the durable dispatch
	* ledger (`listWorkspaceBranches`), so a preserved branch survives restarts
	* without a live handle; `cwd` scopes it to the panel's workspace.
	*/
	listAllBranches(cwd, topicSetId, limit = 100) {
		const workspaceKey = this.wk(cwd);
		const setId = String(topicSetId ?? "").trim();
		const rows = listWorkspaceBranches(this.store, workspaceKey, limit);
		return setId ? rows.filter((row) => row.topicSetId === setId) : rows;
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
		let observedTitle = "";
		try {
			if (query?.readTitleSnapshots) {
				const value = (await query.readTitleSnapshots([id])).find((row) => row.status === "fulfilled" && row.sessionId === id)?.value?.title?.title;
				if (typeof value === "string" && value.trim()) observedTitle = value.trim();
			}
		} catch {}
		let title = resolveSessionTitle(ctx, this.store, id) || observedTitle || id.slice(-4);
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
				source: { kind: "user" }
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
			this.refreshHubTitleFromMessage(id, body);
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
			const applied = await applySessionTitle({
				ctx,
				store: this.store,
				logger: panelTitleLogger
			}, {
				sessionId,
				workspaceKey: workspaceKeyOf(cwd),
				kind: "hub",
				explicitTitle: named,
				source: "topicset-root"
			});
			await recordHubSession(this.store, {
				sessionId,
				workspaceKey: workspaceKeyOf(cwd),
				title: applied.title || named,
				source: "topicset-root"
			});
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
		const workspaceKey = workspaceKeyOf(cwd);
		const resolvedOptions = { ...options };
		if (!resolvedOptions.model) {
			const hubDefault = defaultModelFor(this.store, workspaceKey, "hub");
			if (hubDefault) resolvedOptions.model = hubDefault;
		}
		const created = await this.createSessionWithOptions(cwd, resolvedOptions);
		if ("error" in created) return {
			status: "error",
			message: created.error
		};
		const title = await this.finishSession(created.sessionId, cwd, firstMessage);
		await recordHubSession(this.store, {
			sessionId: created.sessionId,
			workspaceKey,
			title,
			source: "panel"
		});
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
	* R59: the panel send path notifies the naming gate. The gate owns every
	* guard (neutral-only upgrade, human name kept, one final name, external
	* rename lock) and writes OUTSIDE this call stack (defer) — so this path and
	* the shell's session/event observer can never double-write or fight.
	*/
	async refreshHubTitleFromMessage(sessionId, text) {
		const ctx = this.ctx;
		if (!ctx) return;
		try {
			await finalizeHubTitleFromMessage({
				ctx,
				store: this.store,
				logger: panelTitleLogger
			}, sessionId, text, "panel");
		} catch {}
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
				source: { kind: "user" }
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
	/**
	* R59: name the host session through the SINGLE write entry (the gate decides
	* provisional vs final from `topicText`) and attach it to its workspace.
	* @returns the title the naming service put in force ('' when it could not).
	*/
	async finishSession(sessionId, cwd, topicText = "") {
		const ctx = this.ctx;
		if (!ctx) return "";
		const result = await applySessionTitle({
			ctx,
			store: this.store,
			logger: panelTitleLogger
		}, {
			sessionId,
			workspaceKey: workspaceKeyOf(cwd),
			kind: "hub",
			topicText,
			source: "panel"
		});
		try {
			await attachBranchToWorkspace(ctx, sessionId, cwd, {
				warn: () => {},
				info: () => {}
			});
		} catch {}
		return result.title;
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
			await applySessionTitle({
				ctx,
				store: this.store,
				logger: panelTitleLogger
			}, {
				sessionId,
				kind: "branch",
				explicitTitle: named,
				source: "panel"
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
					text: `[supermemory-panel-reply]\n话题集：${topicSet.title}\n用户回复：${body}\n\n你是该话题集的工作分支：按用户回复继续执行并汇报结果。遇到分歧按最合理解释执行，不要停下来等确认；需要用户裁决时用 memory_raise_question 上交中枢汇总（不要在本分支里直接向用户提问）。`
				}],
				source: { kind: "user" }
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
	/**
	* R6: list composite tools (self-generated) with descriptions.
	*
	* A3 工作区隔离：传入 cwd 时只返回适用于该工作区的工具——能力的行级归属
	* （tool_memory.workspaceKey）或 scope 推导命中当前工作区；别的工作区的
	* 能力不列出。无 cwd（旧宿主/兼容路径）不过滤。
	*/
	/**
	* R50: ONE unified list — capability/knowledge (and pending proposals) with
	* both faces: entry/scope/dry-run/confirm plus version, runCount, loadCount,
	* loads-to-runs conversion, success rate and the last status.
	*/
	listTools(cwd) {
		const workspaceKey = cwd ? this.wk(cwd) : void 0;
		const health = new Map(capabilityHealthOf(this.store, workspaceKey).map((row) => [row.id, row]));
		const rows = [];
		for (const entry of capabilityRows(this.store, workspaceKey)) {
			const record = entry.record;
			if (isShellUnit(record)) continue;
			const h = health.get(entry.id);
			const name = record.kind === "capability" ? capabilityToolName(record.name) : "sm-" + record.name;
			rows.push({
				id: entry.id,
				name,
				logicalName: record.name,
				title: record.title,
				tags: record.tags,
				description: record.description,
				steps: [],
				parameters: [],
				useCount: record.runCount,
				status: entry.row.status,
				live: liveCapabilityToolNames.has(name),
				createdAt: entry.row.createdAt,
				kind: record.kind,
				entry: record.entry,
				doc: record.doc,
				scope: record.scope,
				runnable: record.runnable !== false,
				dryRunArg: record.dryRunArg,
				writeConfirm: record.writeConfirm,
				entryDraft: record.entryDraft,
				entryVerified: record.entryVerified,
				enabled: record.enabled !== false,
				loadCount: record.loadCount,
				runCount: record.runCount,
				loadsToRuns: h?.loadsToRuns ?? (record.loadCount > 0 ? record.runCount / record.loadCount : 0),
				successRate: h?.successRate ?? (record.runCount > 0 ? record.successCount / record.runCount : 0),
				successCount: record.successCount,
				failCount: record.failCount,
				consecutiveFailures: record.consecutiveFailures,
				...record.lastStatus ? { lastStatus: record.lastStatus } : {},
				...record.lastUsedAt !== void 0 ? { lastUsedAt: record.lastUsedAt } : {},
				...record.lastDryRun !== void 0 ? { lastDryRun: record.lastDryRun } : {},
				...record.lastSummary ? { lastSummary: record.lastSummary } : {},
				skillPath: record.skillPath,
				body: capabilityBodyOf(record),
				source: record.source,
				...record.taskKey ? { taskKey: record.taskKey } : {},
				routeNote: record.routeNote,
				builtin: record.builtin,
				...record.builtinVersion !== void 0 ? { builtinVersion: record.builtinVersion } : {},
				scopeMissing: h?.scopeMissing ?? false,
				docMissing: h?.docMissing ?? false,
				notes: h?.notes ?? [],
				version: record.version,
				usage: {
					useCount: record.runCount,
					successCount: record.successCount,
					failCount: record.failCount,
					consecutiveFailures: record.consecutiveFailures,
					...record.lastUsedAt !== void 0 ? { lastUsedAt: record.lastUsedAt } : {},
					...record.lastStatus ? { lastStatus: record.lastStatus } : {},
					...record.lastDryRun !== void 0 ? { lastDryRun: record.lastDryRun } : {},
					...record.lastExitCode !== void 0 ? { lastExitCode: record.lastExitCode } : {},
					...record.lastSummary ? { lastSummary: record.lastSummary } : {}
				},
				...record.kind === "proposal" ? { proposalStatus: record.proposalStatus } : {},
				...record.expiresAt !== void 0 ? { expiresAt: record.expiresAt } : {}
			});
		}
		rows.sort((left, right) => left.name.localeCompare(right.name));
		return rows;
	}
	/** R50: pending auto proposals (accepted/rejected through the panel). */
	listProposals(cwd) {
		return this.listTools(cwd).filter((tool) => tool.kind === "proposal" && tool.proposalStatus === "pending");
	}
	/** R50: accept a pending proposal -> a capability (knowledge, or entryDraft pending verification). */
	async acceptProposal(_cwd, id) {
		if (!this.ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法接受提案。"
		};
		const result = await acceptProposal(this.ctx, this.store, id);
		return result.status === "ok" ? {
			status: "ok",
			message: result.message,
			...result.id ? { id: result.id } : {}
		} : {
			status: "error",
			message: result.message
		};
	}
	/** R50: decline a pending proposal (kept for audit, never re-proposed). */
	async declineProposal(_cwd, id) {
		const result = await declineProposal(this.store, id);
		return result.status === "ok" ? {
			status: "ok",
			message: result.message
		} : {
			status: "error",
			message: result.message
		};
	}
	/** R50: enable an auto-drafted entry (human gate; becomes runnable + verified). */
	async enableCapabilityEntry(id) {
		if (!this.ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法启用执行。"
		};
		const result = await enableCapabilityEntryDraft(this.ctx, this.store, id);
		return result.status === "ok" ? {
			status: "ok",
			message: result.message
		} : {
			status: "error",
			message: result.message
		};
	}
	/** R6/R50: edit one capability (definition, both faces, enabled/disabled). */
	async editTool(id, patch) {
		if (!this.ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法修改能力。"
		};
		if (!capabilityRows(this.store).find((entry) => entry.id === id)) return {
			status: "error",
			message: "能力不存在。"
		};
		if (typeof patch.body === "string") {
			const bodyResult = await updateCapabilitySkillBody(this.store, id, patch.body);
			if (bodyResult.status === "error") return {
				status: "error",
				message: bodyResult.message
			};
			return {
				status: "ok",
				message: bodyResult.message,
				id
			};
		}
		const result = await editCapability(this.ctx, this.store, id, patch);
		return result.status === "ok" ? {
			status: "ok",
			message: result.message,
			id
		} : {
			status: "error",
			message: result.message
		};
	}
	/** R6+/R50: delete one capability (knowledge face archived, never hard-deleted). */
	async deleteTool(id) {
		if (!this.ctx) return {
			status: "error",
			message: "宿主上下文不可用，无法删除能力。"
		};
		const result = await deleteCapability(this.ctx, this.store, id);
		return result.status === "ok" ? {
			status: "ok",
			message: result.message,
			id
		} : {
			status: "error",
			message: result.message
		};
	}
	/** R45/R50: knowledge-face snapshot (kept for the old skills surface/tests). */
	listSkills(cwd) {
		const workspaceKey = this.wk(cwd);
		return capabilityRows(this.store, workspaceKey).filter((entry) => entry.record.kind !== "proposal").map((entry) => {
			const record = entry.record;
			let updatedAt = record.updatedAt;
			try {
				if (record.skillPath) readFileSync(record.skillPath, "utf8");
			} catch {}
			return {
				name: capabilitySkillName(record.name),
				title: record.title,
				description: record.description,
				...record.scope ? { whenToUse: "在 " + record.scope + " 内遇到「" + record.title + "」类任务时加载。" } : {},
				version: record.version,
				useCount: record.loadCount,
				enabled: record.enabled !== false,
				status: entry.row.status === "retired" ? "retired" : "active",
				path: record.skillPath,
				...record.source ? { source: record.source } : {},
				occurrences: 1,
				updatedAt,
				changelog: record.changelog
			};
		}).sort((left, right) => left.name.localeCompare(right.name));
	}
	/** R45/R50: enable/disable or change the routing description of one capability. */
	async updateSkill(cwd, name, patch) {
		const workspaceKey = this.wk(cwd);
		const trimmed = String(name ?? "").trim();
		if (!trimmed) return {
			status: "error",
			message: "缺少能力名。"
		};
		const logical = trimmed.replace(/^sm-|^sm_cap_/, "").replace(/_/g, "-");
		const entry = capabilityRows(this.store, workspaceKey).find((candidate) => candidate.record.name === logical || capabilitySkillName(candidate.record.name) === trimmed || capabilityToolName(candidate.record.name) === trimmed);
		if (!entry) return {
			status: "error",
			message: "找不到该能力：" + trimmed
		};
		if (typeof patch?.description === "string") {
			const result = await editCapability(this.ctx, this.store, entry.id, {
				description: patch.description,
				changelog: "更新路由描述"
			});
			if (result.status === "error") return {
				status: "error",
				message: result.message
			};
		}
		if (typeof patch?.enabled === "boolean") {
			const result = await setCapabilityEnabled(this.ctx, this.store, entry.id, patch.enabled);
			if (result.status === "error") return {
				status: "error",
				message: result.message
			};
		}
		return {
			status: "ok",
			message: "已更新能力（知识面与执行面已同步，事实块已刷新）。"
		};
	}
	/**
	* R22/R50: run one capability (fixed entry inside its scope). Dry-run is the
	* default; a writeConfirm capability refuses a real run without an explicit
	* confirm and answers status 'needs-confirm' WITHOUT executing.
	*/
	async runTool(id, options = {}) {
		const parsed = capabilityRows(this.store).find((entry) => entry.id === id);
		if (!parsed) return {
			status: "failed",
			stdout: "",
			stderr: "",
			durationMs: 0,
			dryRun: Boolean(options.dryRun),
			command: "",
			summary: "能力不存在。"
		};
		const result = runCapability(parsed.record, {
			dryRun: options.dryRun,
			confirm: options.confirm
		});
		if (result.status !== "needs-confirm") await bumpCapabilityRun(this.store, id, result);
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
	/** Guarded positive hub-record read: badge truth, same table resolveRole uses. */
	hubRecordOf(sessionId) {
		try {
			return Boolean(this.store?.hubs?.get?.(sessionId));
		} catch {
			return false;
		}
	}
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
		if (isPluginBranchId(sessionId)) return { kind: "none" };
		if (this.hubRecordOf(sessionId)) return { kind: "hub" };
		return { kind: "none" };
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
		id: "dsh-supermemory#supermemoryPanel/listMemoryCollections",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listMemoryCollections",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MemoryCollectionViews",
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
		id: "dsh-supermemory#supermemoryPanel/listMemoriesByCollection",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listMemoriesByCollection",
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
				name: "collectionId",
				wire: "collectionId",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#CollectionId",
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
		id: "dsh-supermemory#supermemoryPanel/getMemoryDetail",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "getMemoryDetail",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#MemoryDetail",
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
		id: "dsh-supermemory#supermemoryPanel/getHubPolicy",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "getHubPolicy",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#HubPolicyView",
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
		id: "dsh-supermemory#supermemoryPanel/setHubPolicy",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "setHubPolicy",
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
			name: "patch",
			wire: "patch",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#HubPolicyPatch",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/cleanupStaleHubPolicy",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "cleanupStaleHubPolicy",
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
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/getModelDefaults",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "getModelDefaults",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#ModelDefaultsView",
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
		id: "dsh-supermemory#supermemoryPanel/setModelDefaults",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "setModelDefaults",
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
			name: "patch",
			wire: "patch",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#ModelDefaultsPatch",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/listSkills",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listSkills",
		invocation: { kind: "direct" },
		result: {
			mode: "strict",
			typeSymbol: "dsh-supermemory#SkillViews",
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
		id: "dsh-supermemory#supermemoryPanel/updateSkill",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "updateSkill",
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
				name: "name",
				wire: "name",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#SkillName",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "patch",
				wire: "patch",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#SkillPatch",
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
		parameters: [{
			name: "cwd",
			wire: "cwd",
			source: "json",
			acceptsUndefined: true,
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#Cwd",
				create: () => ({ parse: (v) => v })
			}
		}]
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
		id: "dsh-supermemory#supermemoryPanel/acceptProposal",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "acceptProposal",
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
		id: "dsh-supermemory#supermemoryPanel/declineProposal",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "declineProposal",
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
		id: "dsh-supermemory#supermemoryPanel/renameSessionTitle",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "renameSessionTitle",
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
				name: "sessionId",
				wire: "sessionId",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#HubSessionId",
					create: () => ({ parse: (v) => v })
				}
			},
			{
				name: "title",
				wire: "title",
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#TitleText",
					create: () => ({ parse: (v) => v })
				}
			}
		]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/resetSessionTitle",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "resetSessionTitle",
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
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#HubSessionId",
				create: () => ({ parse: (v) => v })
			}
		}]
	},
	{
		id: "dsh-supermemory#supermemoryPanel/repairSessionTitle",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "repairSessionTitle",
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
			name: "sessionId",
			wire: "sessionId",
			source: "json",
			codec: {
				mode: "strict",
				typeSymbol: "dsh-supermemory#HubSessionId",
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
		id: "dsh-supermemory#supermemoryPanel/listAllTopicSets",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listAllTopicSets",
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
		id: "dsh-supermemory#supermemoryPanel/listAllBranches",
		service: "supermemoryPanel",
		namespace: "supermemoryPanel",
		method: "listAllBranches",
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
				name: "topicSetId",
				wire: "topicSetId",
				source: "json",
				acceptsUndefined: true,
				codec: {
					mode: "strict",
					typeSymbol: "dsh-supermemory#TopicSetId",
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
		description: "将一条【结论性】事实记忆写入 SuperMemory：跨会话持久、按工作区隔离。只记结论——可复用的事实、决策、约定、构建命令、文件用途；禁止记录过程流水账（先做了什么、执行了哪些命令、第几步、工具调用日志、大段输出），这些留在会话里。必须同时给出 title + tags + 正文：标题是一句可扫读的结论（≤48 字），标签是 3–8 个短词（检索索引），正文自包含。过长（>1500 字）或明显是步骤/命令日志的内容会被拒绝，请先改写成结论。记忆按「记忆集合 + 条目」组织：集合归属由大模型在候选集合中判定（加到某个已有集合，还是新建一个；无模型时退化为标题/标签/正文相似度匹配，高/中相似直接复用该集合并追加条目，低相似才新建集合）；可用 collection 指定集合标题、collectionId 指定集合 id。一条写入若含多个事实，会先被整形为多条原子记忆（每条独立标题/标签/正文，最多 5 条，回执的 entries 逐条说明归入哪个集合）。版本控制（R30）：同一 key 且内容不同 → 就地更新该记忆并 version+1（旧版本归档进 memory_versions，可用 memory_history 溯源）；同一 key 且内容相同 → 幂等返回、不升版；无 key → 新建 v1 并写入历史。",
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
			},
			collection: {
				type: "string",
				description: "可选：目标记忆集合标题（同名/相似集合会被复用，否则以该标题新建）"
			},
			collectionId: {
				type: "string",
				description: "可选：目标记忆集合 id（必须已存在）"
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
					version: {
						type: "integer",
						description: "当前记忆的版本号（同 key 更新后为升版后的新版本）"
					},
					collectionId: {
						type: "string",
						description: "所属记忆集合 id"
					},
					collectionTitle: {
						type: "string",
						description: "所属记忆集合标题"
					},
					collectionTier: {
						type: "string",
						enum: [
							"high",
							"medium",
							"low",
							"explicit",
							"llm"
						],
						description: "复用档位：high/medium=命中已有集合，llm=模型判定，low=新建集合，explicit=调用方指定"
					},
					collectionCreated: {
						type: "boolean",
						description: "本次是否新建了集合"
					},
					split: {
						type: "integer",
						description: "本次写入被拆分为几条原子记忆（1=未拆分）"
					},
					entries: {
						type: "array",
						description: "逐条原子记忆的写入结果（各自的内存 id/标题/标签/所属集合）",
						items: {
							type: "object",
							properties: {
								memoryId: { type: "string" },
								title: { type: "string" },
								tags: {
									type: "array",
									items: { type: "string" }
								},
								collectionId: {
									type: "string",
									description: "所属记忆集合 id"
								},
								collectionTitle: {
									type: "string",
									description: "所属记忆集合标题"
								},
								collectionTier: {
									type: "string",
									enum: [
										"high",
										"medium",
										"low",
										"explicit",
										"llm"
									],
									description: "复用档位：high/medium=命中已有集合，llm=模型判定，low=新建集合，explicit=调用方指定"
								}
							},
							additionalProperties: false
						}
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
			await migrateFlatMemories(store, workspaceKey, now);
			await migrateMemoryVersions(store, workspaceKey, now);
			const decisionDeps = {
				ctx: deps.ctx,
				logger: deps.logger,
				...exec.agent?.id ? { sessionId: String(exec.agent.id) } : {}
			};
			const atomic = (await splitMemoryEntries(decisionDeps, text, {
				title,
				tags
			}) ?? [{
				title,
				tags,
				text
			}]).filter((draft) => draft.text && assessConclusion(draft.text).ok);
			const entries = atomic.length > 0 ? atomic : [{
				title,
				tags,
				text
			}];
			const split = entries.length > 1;
			const stored = [];
			const updated = [];
			const duplicates = [];
			for (const entry of entries) {
				const entryTags = mergeTags(entry.tags, tags);
				const sameKey = !split && key ? findMemoryByKey(store, workspaceKey, key) : void 0;
				if (sameKey) {
					const [memoryId, existing] = sameKey;
					if (!args.collectionId && !args.collection && memoryContentUnchanged(existing, {
						title: entry.title,
						text: entry.text,
						tags: entryTags
					})) return {
						status: "duplicate",
						memoryId,
						title: existing.title ?? "",
						tags: [...existing.keywords ?? []],
						version: currentVersionOf(existing),
						...existing.collectionId ? { collectionId: existing.collectionId } : {},
						message: `该 key 已存相同内容，未重复写入（当前 v${currentVersionOf(existing)}）。`
					};
					const assignment = await resolveCollectionForEntry(store, workspaceKey, {
						title: entry.title,
						keywords: entryTags,
						text: entry.text
					}, {
						...args.collectionId ? { collectionId: String(args.collectionId) } : {},
						...args.collection ? { collection: String(args.collection) } : {},
						now,
						deps: decisionDeps
					});
					if ("error" in assignment) return {
						status: "conflict",
						message: assignment.error + (assignment.candidates && assignment.candidates.length > 0 ? `候选集合：${assignment.candidates.map((c) => `「${c.title}」(${c.collectionId})`).join("、")}` : "")
					};
					const result = await updateMemoryVersioned(store, workspaceKey, memoryId, {
						title: entry.title,
						text: entry.text,
						tags: entryTags,
						...assignment.collectionId ? { collectionId: assignment.collectionId } : {}
					}, now);
					if (!result) return {
						status: "conflict",
						message: `key「${key}」对应的记忆不存在或不属于当前工作区。`
					};
					if (result.status === "unchanged") return {
						status: "duplicate",
						memoryId,
						title: existing.title ?? "",
						tags: [...existing.keywords ?? []],
						version: result.version,
						...existing.collectionId ? { collectionId: existing.collectionId } : {},
						...existing.collectionId ? { collectionTitle: assignment.title } : {},
						message: `该 key 已存相同内容，未重复写入（当前 v${result.version}）` + (assignment.title ? `（所属集合「${assignment.title}」）` : "")
					};
					if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now);
					updated.push({
						memoryId,
						title: entry.title,
						text: entry.text,
						tags: entryTags,
						version: result.version,
						assignment
					});
					continue;
				}
				const existing = findMemoryConflict(store, workspaceKey, { text: entry.text });
				if (existing) {
					duplicates.push(existing);
					continue;
				}
				const assignment = await resolveCollectionForEntry(store, workspaceKey, {
					title: entry.title,
					keywords: entryTags,
					text: entry.text
				}, {
					...args.collectionId ? { collectionId: String(args.collectionId) } : {},
					...args.collection ? { collection: String(args.collection) } : {},
					now,
					deps: decisionDeps
				});
				if ("error" in assignment) return {
					status: "conflict",
					message: assignment.error + (assignment.candidates && assignment.candidates.length > 0 ? `候选集合：${assignment.candidates.map((c) => `「${c.title}」(${c.collectionId})`).join("、")}` : "")
				};
				const memoryId = await createMemoryVersioned(store, workspaceKey, {
					title: entry.title,
					text: entry.text,
					tags: entryTags,
					...!split && key ? { key } : {},
					...assignment.collectionId ? { collectionId: assignment.collectionId } : {},
					sourceSessionId: String(exec.agent?.id ?? "tool"),
					sourceSeq: 0
				}, now);
				if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now);
				stored.push({
					memoryId,
					title: entry.title,
					text: entry.text,
					tags: entryTags,
					assignment
				});
			}
			if (updated.length > 0 && stored.length === 0) {
				const row = updated[0];
				const tierNote = collectionTierNote(row.assignment);
				const line = renderRecordLine({
					title: row.title,
					text: row.text,
					tags: row.tags,
					collection: row.assignment.title
				});
				return {
					status: "updated",
					memoryId: row.memoryId,
					title: row.title,
					tags: row.tags,
					version: row.version,
					...row.assignment.collectionId ? { collectionId: row.assignment.collectionId } : {},
					...row.assignment.title ? { collectionTitle: row.assignment.title } : {},
					collectionTier: row.assignment.tier,
					collectionCreated: row.assignment.created,
					message: `已更新到 v${row.version}（旧版本已归档，可用 memory_history 溯源）：${tierNote === null ? line : `${tierNote} → ${line}`}`
				};
			}
			if (stored.length === 0) {
				const found = duplicates[0];
				return {
					status: "duplicate",
					memoryId: found.memoryId,
					title: found.title,
					tags: found.tags,
					...found.collectionId ? { collectionId: found.collectionId } : {},
					...found.collectionTitle ? { collectionTitle: found.collectionTitle } : {},
					...split ? { split: entries.length } : {},
					message: "相同记忆已存在，未重复写入。" + (found.collectionTitle ? `（所属集合「${found.collectionTitle}」）` : "") + (split ? `（已拆分为 ${entries.length} 条，均已存在）` : "")
				};
			}
			const first = stored[0];
			const tierNote = collectionTierNote(first.assignment);
			const lines = stored.map((row) => renderRecordLine({
				title: row.title,
				text: row.text,
				tags: row.tags,
				collection: row.assignment.title
			}));
			const skipped = duplicates.length > 0 ? `\n其中 ${duplicates.length} 条已存在，未重复写入。` : "";
			const keyNote = key && split ? `\n（拆分写入未沿用 key「${key}」：每条原子记忆是独立事实）` : "";
			return {
				status: "stored",
				memoryId: first.memoryId,
				title: first.title,
				tags: first.tags,
				version: 1,
				...first.assignment.collectionId ? { collectionId: first.assignment.collectionId } : {},
				...first.assignment.title ? { collectionTitle: first.assignment.title } : {},
				collectionTier: first.assignment.tier,
				collectionCreated: first.assignment.created,
				split: entries.length,
				entries: stored.map((row) => ({
					memoryId: row.memoryId,
					title: row.title,
					tags: row.tags,
					...row.assignment.collectionId ? { collectionId: row.assignment.collectionId } : {},
					...row.assignment.title ? { collectionTitle: row.assignment.title } : {},
					collectionTier: row.assignment.tier
				})),
				message: split ? `已拆分为 ${entries.length} 条原子记忆：\n${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}${skipped}${keyNote}` : `${tierNote === null ? `已记住：${lines[0]}` : `${tierNote}：${lines[0]}`}${keyNote}`
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_recall",
		description: "检索 SuperMemory：结论性事实记忆（memories）、归档梗概（episodes）、需求（requirements）与项目文件地图（filemap），按当前工作区隔离，关键词 + 时间衰减规则评分。回答\"之前说过什么/做过什么\"类问题前先用本工具检索；记忆只存结论，不是过程日志。记忆采用两级检索：先按查询匹配「记忆集合」，再在集合内精选条目（标题×4/标签×3/正文×1 + 集合级上下文），命中的记忆条目会带上所属集合的 id/标题/标签与 version（当前版本号；历史版本用 memory_history 溯源）；collections 是命中的记忆集合（按分排序）。返回的 topicSets 是命中的话题集（结论属于哪个集），命中时优先直接回答或把任务派发到该集，不要重复检索。",
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
								version: {
									type: "integer",
									description: "当前记忆的版本号（仅 memory 类条目）"
								},
								collectionId: {
									type: "string",
									description: "所属记忆集合 id（未归集时为空）"
								},
								collectionTitle: {
									type: "string",
									description: "所属记忆集合标题"
								},
								collectionTags: {
									type: "array",
									items: { type: "string" },
									description: "所属记忆集合标签"
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
					},
					collections: {
						type: "array",
						description: "命中的记忆集合（两级检索第一级，按匹配分排序）",
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
								},
								tier: {
									type: "string",
									enum: [
										"high",
										"medium",
										"low"
									]
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
				const collections = value.collections ?? [];
				const collectionHint = collections.length > 0 ? `\n相关记忆集合：${collections.map((c) => c.title).join("、")}` : "";
				const hint = (topicSets.length > 0 ? `\n相关话题集：${topicSets.map((topicSet) => topicSet.title).join("、")}` : "") + collectionHint;
				if (items.length === 0) return [{
					type: "text",
					text: `（未检索到相关记忆）${hint}`
				}];
				return [{
					type: "text",
					text: items.map((item, i) => `${i + 1}. ${renderRecordLine({
						title: item.title,
						text: item.text,
						tags: item.tags,
						collection: item.collectionTitle
					})}`).join("\n") + hint
				}];
			}
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			if (!cwd) return {
				items: [],
				total: 0,
				topicSets: [],
				collections: []
			};
			const workspaceKey = workspaceKeyOf(cwd);
			const query = String(args.query ?? "").trim();
			if (!query) return {
				items: [],
				total: 0,
				topicSets: [],
				collections: []
			};
			const options = {
				limit: Math.max(1, Math.min(20, Number(args.limit) || config.recall.maxItems)),
				minScore: config.recall.minScore,
				halfLifeDays: config.recall.halfLifeDays,
				now: Date.now()
			};
			const items = [];
			await migrateFlatMemories(store, workspaceKey, options.now);
			await migrateMemoryVersions(store, workspaceKey, options.now);
			const collections = listCollections(store, workspaceKey);
			const memories = [];
			const versions = /* @__PURE__ */ new Map();
			for (const entry of store.memories.entries()) {
				if (entry[1].workspaceKey !== workspaceKey || entry[1].status !== "active") continue;
				memories.push(entry);
				versions.set(entry[0], currentVersionOf(entry[1]));
			}
			const collectionRecall = recallEntriesWithCollections(collections, memories, query, options);
			for (const item of collectionRecall.items) items.push({
				kind: "memory",
				id: item.memoryId,
				title: item.title,
				tags: item.keywords,
				text: item.text,
				score: item.score,
				createdAt: item.createdAt,
				collectionId: item.collectionId,
				collectionTitle: item.collectionTitle,
				collectionTags: item.collectionTags,
				version: versions.get(item.memoryId) ?? 1
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
				version: 1,
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
				version: 1,
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
				version: 1,
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
				topicSets,
				collections: collectionRecall.collections.map((match) => ({
					id: match.collectionId,
					title: match.title,
					tags: match.keywords,
					score: match.score,
					tier: match.tier
				}))
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "memory_history",
		description: "查看一条记忆的全部历史版本（版本号/时间/标题/标签/正文/changeType），用于溯源「这个结论以前是什么」。入参 key 或 memoryId 二选一（都不传时返回空）。memory_recall 只返回当前版本；本工具返回该记忆的完整版本序列。",
		parameters: {
			key: {
				type: "string",
				description: "记忆的稳定键（与 memory_remember 的 key 一致）"
			},
			memoryId: {
				type: "string",
				description: "记忆 id（memory_recall 回执里的 id）"
			},
			limit: {
				type: "integer",
				description: "返回版本数上限，默认 20"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					memoryId: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						description: "当前标题"
					},
					currentVersion: {
						type: "integer",
						required: true
					},
					versions: {
						type: "array",
						required: true,
						description: "全部历史版本（按版本号升序；最后一条即当前版本）",
						items: {
							type: "object",
							properties: {
								version: {
									type: "integer",
									required: true
								},
								updatedAt: {
									type: "integer",
									required: true
								},
								title: { type: "string" },
								tags: {
									type: "array",
									items: { type: "string" }
								},
								text: {
									type: "string",
									required: true
								},
								changeType: {
									type: "string",
									enum: [
										"create",
										"update",
										"migrate"
									]
								},
								collectionId: { type: "string" }
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
				memoryId: "",
				currentVersion: 0,
				versions: [],
				total: 0,
				message: "无法确定当前工作区（agent 会话缺少 cwd）。"
			};
			const workspaceKey = workspaceKeyOf(cwd);
			const key = args.key?.trim() || void 0;
			const memoryId = args.memoryId?.trim() || void 0;
			if (!key && !memoryId) return {
				memoryId: "",
				currentVersion: 0,
				versions: [],
				total: 0,
				message: "请给出 key 或 memoryId（二选一）。"
			};
			let found;
			if (memoryId) {
				const record = store.memories.get(memoryId);
				if (record && record.workspaceKey === workspaceKey) found = [memoryId, record];
			}
			if (!found && key) found = findMemoryByKey(store, workspaceKey, key);
			if (!found) return {
				memoryId: memoryId ?? "",
				currentVersion: 0,
				versions: [],
				total: 0,
				message: `没有找到记忆${key ? `（key「${key}」）` : `（id ${memoryId}）`}：它可能不属于当前工作区，或已被删除。`
			};
			const [id, memory] = found;
			const cap = Math.max(1, Math.min(50, Number(args.limit) || 20));
			let rows = memoryHistoryOf(store, id);
			if (rows.length === 0) {
				await migrateMemoryVersions(store, workspaceKey);
				rows = memoryHistoryOf(store, id);
			}
			const current = currentVersionOf(memory);
			const versions = rows.slice(-cap).map((row) => ({
				version: row.version,
				updatedAt: row.updatedAt,
				title: row.title ?? "",
				tags: [...row.tags ?? []],
				text: row.text,
				changeType: row.changeType,
				...row.collectionId ? { collectionId: row.collectionId } : {}
			}));
			const title = memory.title ?? "";
			const noHistory = memoryVersionsSupported(store) ? "" : "（当前存储域没有 memory_versions 表，无法提供历史）";
			const lines = versions.map((row) => `v${row.version}（${new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false })}，${row.changeType}）${row.title ? ` ${row.title}` : ""}：${clipMarked(String(row.text ?? ""), 80)}`);
			return {
				memoryId: id,
				title,
				currentVersion: current,
				versions,
				total: versions.length,
				message: `「${title || id}」共 ${versions.length} 个版本（当前 v${current}）${noHistory}：\n${lines.join("\n") || "（无历史行）"}`
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
						return `- 【${i.title}】${count} 个会话${i.model ? " · " + i.model : ""}${tags}${i.summary ? "：" + clipMarked(i.summary, 80) : ""}`;
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
							lines.push(`${index + 1}. ${row.status === "dispatched" ? "✅" : "❌"} ${clipMarked(String(row.task ?? ""), 40)}${row.branchSessionId ? ` → ${row.branchSessionId}` : ""}`);
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
				const { scanWorkspace, filemapEntries } = await import("./filemap-MJ8pEDq8.js").then((n) => n.n);
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
				const { buildExport } = await import("./export-DDAzZlQr.js").then((n) => n.n);
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
		description: "重复工作的固化入口（R50/R52 单一能力：知识面 .dsh/capabilities/<name>.md + 执行面 sm_cap_<name>）：① 列出待接受提案、能力与仅知识草稿；② accept/decline 处理提案（接受后创建能力；高置信入口草稿必须人工「启用执行」才会 runnable）；③ register 注册/更新能力：给 entry 产可执行能力（固定入口，默认预演、写操作 confirm=true），不给 entry 则仅知识（六节知识面文件，事实块自动维护；会话里用 sm_cap_doc 读取）；④ enabled + name 同时启停知识面与执行面；⑤ refresh-builtin 刷新内置能力与健康度；⑥ cleanup 清理历史工具序列行/待处理提案/宽泛序列信号并归档工具序列壳子 skill（幂等、可回滚）。执行面绝不自动执行；能力连续失败时更新事实块/文档而不是绕过闸门。" + CAPABILITY_ROUTING_RULES,
		parameters: {
			accept: {
				type: "boolean",
				description: "接受一个待处理提案（缺省第一个；可用 name 指定）"
			},
			decline: {
				type: "boolean",
				description: "拒绝一个待处理提案（缺省第一个；可用 name 指定）"
			},
			register: {
				type: "boolean",
				description: "注册/更新能力：给 entry 产可执行能力；不给 entry 产仅知识能力"
			},
			skill: {
				type: "boolean",
				description: "register 时强制仅知识（即使给了 entry 也不注册执行面）"
			},
			body: {
				type: "string",
				description: "知识面正文（Markdown 六节）；缺省生成骨架。事实块由插件自动维护，块外散文保留"
			},
			whenToUse: {
				type: "string",
				description: "保留参数（R48 兼容）：知识面何时加载由 description 表达"
			},
			enabled: {
				type: "boolean",
				description: "配合 name：同时启用/停用知识面与执行面"
			},
			name: {
				type: "string",
				description: "逻辑名（字母/数字/-/_，如 git-sync-supermemory）：工具名派生 sm_cap_git_sync_supermemory，知识面文件派生 <名称>.md"
			},
			title: {
				type: "string",
				description: "标题（人类可读）"
			},
			description: {
				type: "string",
				description: "路由描述（知识面/执行面共用）：写清「何时用/何时优先用它」，这是模型路由依据，短而具体"
			},
			entry: {
				type: "string",
				description: "入口命令，如 \"pnpm git:sync\"（固定入口，不接受任意参数透传）"
			},
			doc: {
				type: "string",
				description: "文档路径（相对仓库根），如 \"docs/git-sync.md\""
			},
			scope: {
				type: "string",
				description: "适用范围：入口命令的执行目录，如 \"F:\\10-SuperMemory\"（通常是仓库根）"
			},
			runnable: {
				type: "boolean",
				description: "是否允许执行；缺省 true（有 entry 时）"
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
			},
			refreshBuiltin: {
				type: "boolean",
				description: "刷新内置能力：store 缺失则播种、旧于内置版本则升级（现场更新保留），并返回差异报告与各能力健康度（含执行/加载次数与转化率）"
			},
			cleanup: {
				type: "boolean",
				description: "R50 清理：退役历史工具序列行（不注册）、清空待处理提案、清理宽泛序列信号、归档工具序列壳子 skill（移到 <skills 根>-archive，可回滚）；幂等"
			},
			changelog: {
				type: "string",
				description: "register 同名更新时的一行变更说明（写入 changelog，最新在前；缺省自动生成）"
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
							"refreshed",
							"cleaned",
							"error"
						],
						required: true
					},
					archived: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: {
									type: "string",
									required: true
								},
								root: {
									type: "string",
									required: true
								},
								archivePath: {
									type: "string",
									required: true
								}
							},
							additionalProperties: false
						}
					},
					archivedCount: { type: "integer" },
					archivedSkills: { type: "integer" },
					retiredComposites: { type: "integer" },
					clearedProposals: { type: "integer" },
					prunedSignals: { type: "integer" },
					pendingBefore: { type: "integer" },
					pendingAfter: { type: "integer" },
					expiredProposals: { type: "integer" },
					retired: {
						type: "array",
						items: { type: "string" }
					},
					archiveRoots: {
						type: "array",
						items: {
							type: "object",
							properties: {
								root: {
									type: "string",
									required: true
								},
								scanned: { type: "integer" },
								archived: { type: "integer" }
							},
							additionalProperties: false
						}
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
					proposals: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: {
									type: "string",
									required: true
								},
								title: { type: "string" },
								description: {
									type: "string",
									required: true
								},
								version: { type: "integer" },
								taskKey: { type: "string" },
								source: { type: "string" },
								entryDraft: { type: "string" },
								entryVerified: { type: "boolean" },
								expiresAt: { type: "integer" }
							},
							additionalProperties: false
						}
					},
					units: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: {
									type: "string",
									required: true
								},
								name: {
									type: "string",
									required: true
								},
								logicalName: {
									type: "string",
									required: true
								},
								kind: {
									type: "string",
									required: true
								},
								title: { type: "string" },
								description: { type: "string" },
								badges: {
									type: "array",
									items: { type: "string" }
								},
								entry: { type: "string" },
								entryDraft: { type: "string" },
								entryVerified: { type: "boolean" },
								doc: { type: "string" },
								scope: { type: "string" },
								runnable: { type: "boolean" },
								enabled: { type: "boolean" },
								status: { type: "string" },
								version: { type: "integer" },
								loadCount: { type: "integer" },
								runCount: { type: "integer" },
								loadsToRuns: { type: "number" },
								successRate: { type: "number" },
								successCount: { type: "integer" },
								failCount: { type: "integer" },
								consecutiveFailures: { type: "integer" },
								lastStatus: { type: "string" },
								skillPath: { type: "string" },
								source: { type: "string" },
								taskKey: { type: "string" },
								builtin: { type: "boolean" },
								notes: {
									type: "array",
									items: { type: "string" }
								}
							},
							additionalProperties: false
						}
					},
					tool: { type: "string" },
					message: { type: "string" },
					entryDraft: { type: "boolean" },
					capabilities: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: {
									type: "string",
									required: true
								},
								logicalName: { type: "string" },
								title: { type: "string" },
								entry: { type: "string" },
								doc: { type: "string" },
								scope: { type: "string" },
								runnable: { type: "boolean" },
								dryRunArg: { type: "string" },
								writeConfirm: { type: "boolean" },
								status: { type: "string" },
								useCount: { type: "integer" },
								runCount: { type: "integer" },
								loadCount: { type: "integer" },
								loadsToRuns: { type: "number" },
								version: { type: "integer" },
								lastStatus: { type: "string" },
								live: { type: "boolean" },
								entryDraft: { type: "string" },
								entryVerified: { type: "boolean" }
							},
							additionalProperties: false
						}
					},
					skills: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: {
									type: "string",
									required: true
								},
								title: { type: "string" },
								description: {
									type: "string",
									required: true
								},
								version: { type: "integer" },
								useCount: { type: "integer" },
								loadCount: { type: "integer" },
								enabled: { type: "boolean" },
								status: { type: "string" },
								path: { type: "string" },
								source: { type: "string" },
								occurrences: { type: "integer" }
							},
							additionalProperties: false
						}
					},
					builtin: {
						type: "object",
						properties: {
							seeded: {
								type: "array",
								items: { type: "string" }
							},
							upgraded: {
								type: "array",
								items: { type: "string" }
							},
							current: {
								type: "array",
								items: { type: "string" }
							},
							localNewer: {
								type: "array",
								items: { type: "string" }
							},
							otherWorkspace: { type: "integer" },
							health: {
								type: "array",
								items: {
									type: "object",
									properties: {
										name: {
											type: "string",
											required: true
										},
										kind: { type: "string" },
										builtin: { type: "boolean" },
										builtinVersion: { type: "integer" },
										version: { type: "integer" },
										entry: { type: "string" },
										entryDraft: { type: "string" },
										entryVerified: { type: "boolean" },
										runCount: { type: "integer" },
										loadCount: { type: "integer" },
										loadsToRuns: { type: "number" },
										successRate: { type: "number" },
										useCount: { type: "integer" },
										successCount: { type: "integer" },
										failCount: { type: "integer" },
										consecutiveFailures: { type: "integer" },
										lastStatus: { type: "string" },
										docMissing: { type: "boolean" },
										scopeMissing: { type: "boolean" },
										live: { type: "boolean" },
										notes: {
											type: "array",
											items: { type: "string" }
										}
									},
									additionalProperties: false
								}
							}
						},
						additionalProperties: false
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "refreshed") {
					const b = v.builtin;
					const parts = [v.message ?? "已刷新内置能力。"];
					if (b) {
						if (b.seeded.length) parts.push("播种：" + b.seeded.join("、"));
						if (b.upgraded.length) parts.push("升级：" + b.upgraded.join("、"));
						if (b.current.length) parts.push("已最新：" + b.current.join("、"));
						if (b.localNewer.length) parts.push("现场更新（保留）：" + b.localNewer.join("、"));
						for (const h of b.health) {
							const head = "- " + h.name + (h.builtin ? "（内置）" : "") + " v" + (h.version ?? 0) + "：执行 " + (h.runCount ?? h.useCount ?? 0) + " / 加载 " + (h.loadCount ?? 0) + "（转化率 " + (h.loadsToRuns ?? 0) + "，成功率 " + (h.successRate ?? 0) + "，连续失败 " + (h.consecutiveFailures ?? 0) + "）";
							parts.push(head + (h.notes && h.notes.length ? "\n  " + h.notes.join("\n  ") : ""));
						}
					}
					return [{
						type: "text",
						text: parts.join("\n")
					}];
				}
				if (v.status === "cleaned") {
					const archived = v.archived ?? [];
					const counts = [];
					const skillCount = v.archivedSkills ?? v.archivedCount ?? archived.length;
					if (skillCount > 0) counts.push("归档壳子 skill " + skillCount + " 个");
					if ((v.retiredUnits ?? 0) > 0) counts.push("退役已收编壳子单元 " + (v.retiredUnits ?? 0) + " 个" + (v.retiredUnitNames?.length ? "（" + v.retiredUnitNames.join("、") + "）" : ""));
					if ((v.retiredComposites ?? 0) > 0) counts.push("退役历史工具序列行 " + (v.retiredComposites ?? 0) + " 个" + (v.retired?.length ? "（" + v.retired.join("、") + "）" : ""));
					if ((v.clearedProposals ?? 0) > 0) counts.push("清空待处理提案 " + (v.clearedProposals ?? 0) + " 条");
					if ((v.expiredProposals ?? 0) > 0) counts.push("过期提案 " + (v.expiredProposals ?? 0) + " 条");
					if ((v.prunedSignals ?? 0) > 0) counts.push("清理宽泛序列信号 " + (v.prunedSignals ?? 0) + " 条");
					const head = counts.length > 0 ? "已清理：" + counts.join("；") + "。" : "没有需要清理的自动生成物（人工/manual 能力与知识面未改动）。";
					const tail = "pending " + (v.pendingBefore ?? 0) + " → " + (v.pendingAfter ?? 0);
					const lines = archived.map((entry) => "- " + entry.name + " → " + entry.archivePath + "（原根：" + entry.root + "）");
					return [{
						type: "text",
						text: [head + " " + tail, ...lines.length > 0 ? ["归档明细（未删除，可在 <skills 根>-archive 回滚；manifest 已记录原名/时间/原因）：", ...lines] : []].join("\n")
					}];
				}
				if (v.status === "listed") {
					const proposals = (v.proposals ?? []).map((p) => "- " + p.name + "：" + p.description + (p.entryDraft ? "（入口草稿 " + p.entryDraft + "，未验证）" : "（仅知识）"));
					const units = (v.units ?? []).map((u) => "- " + u.name + " [" + (u.kind === "knowledge" ? "仅知识" : u.kind === "capability" ? "可执行" : "提案") + "]" + (u.badges ?? []).map((badge) => " [" + badge + "]").join("") + " v" + (u.version ?? 1) + "：执行 " + (u.runCount ?? 0) + " / 加载 " + (u.loadCount ?? 0) + "（转化率 " + (u.loadsToRuns ?? 0) + "，成功率 " + (u.successRate ?? 0) + "）" + (u.lastStatus ? "，最后 " + u.lastStatus : "") + (u.entry ? "，入口 " + u.entry : "") + (u.entryDraft ? "，入口草稿 " + u.entryDraft + "（未验证）" : ""));
					const parts = [];
					if (proposals.length > 0) parts.push("待接受提案：\n" + proposals.join("\n"));
					if (units.length > 0) parts.push("能力（知识面 + 执行面）：\n" + units.join("\n"));
					return [{
						type: "text",
						text: parts.length > 0 ? parts.join("\n\n") : "（没有待接受提案，也没有已注册的能力或知识草稿）"
					}];
				}
				if (v.status === "accepted") return [{
					type: "text",
					text: "已接受提案：" + (v.tool ?? "") + "。" + (v.entryDraft ? "入口草稿未验证：请在面板点「启用执行」后才会 runnable=true。" : "已创建仅知识能力。")
				}];
				if (v.status === "registered") return [{
					type: "text",
					text: v.message ?? "已注册能力 " + (v.tool ?? "") + "。"
				}];
				if (v.status === "declined") return [{
					type: "text",
					text: "已拒绝该提案。"
				}];
				if (v.status === "none") return [{
					type: "text",
					text: "（没有待接受的提案）"
				}];
				return [{
					type: "text",
					text: v.message ?? "操作失败。"
				}];
			}
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			const workspaceKey = cwd ? workspaceKeyOf(cwd) : void 0;
			const { capabilityRows, capabilityHealthOf, capabilityLogicalName, capabilityToolName, isShellUnit, mergeBuiltinCapabilities, registerCapability, registerCapabilityTool, liveCapabilityNames, setCapabilityEnabled, acceptProposal, declineProposal, pendingProposalsOf } = await import("./capability-CerjsIyB.js").then((n) => n.l);
			if (args.refreshBuiltin) {
				const report = await mergeBuiltinCapabilities(store, { logger: deps.logger });
				for (const changed of report.changed) {
					const current = capabilityRows(store).find((entry) => entry.record.name === changed.record.name);
					if (current && current.record.kind === "capability" && current.record.entry && current.record.runnable !== false) try {
						await registerCapabilityTool(ctx, store, current, current.row.workspaceKey);
					} catch {}
				}
				const health = capabilityHealthOf(store, workspaceKey);
				const otherWorkspace = Math.max(0, capabilityRows(store).filter((entry) => entry.record.kind !== "proposal").length - health.length);
				deps.logger.info("supermemory: refresh-builtin (seeded " + report.seeded.length + ", upgraded " + report.upgraded.length + ", current " + report.current.length + ")");
				return {
					status: "refreshed",
					message: "内置能力已刷新：播种 " + report.seeded.length + "、升级 " + report.upgraded.length + "、已最新 " + report.current.length + "、现场更新保留 " + report.localNewer.length + "。" + (otherWorkspace > 0 ? "另有 " + otherWorkspace + " 个能力属于其他工作区，本工作区不暴露。" : ""),
					builtin: {
						seeded: report.seeded,
						upgraded: report.upgraded,
						current: report.current,
						localNewer: report.localNewer,
						health: health.map((h) => ({
							name: h.name,
							kind: h.kind,
							builtin: h.builtin,
							...h.builtinVersion !== void 0 ? { builtinVersion: h.builtinVersion } : {},
							version: h.version,
							entry: h.entry,
							...h.entryDraft ? { entryDraft: h.entryDraft } : {},
							entryVerified: h.entryVerified,
							runCount: h.runCount,
							loadCount: h.loadCount,
							loadsToRuns: h.loadsToRuns,
							successRate: h.successRate,
							useCount: h.runCount,
							successCount: h.successCount,
							failCount: h.failCount,
							consecutiveFailures: h.consecutiveFailures,
							...h.lastStatus ? { lastStatus: h.lastStatus } : {},
							docMissing: h.docMissing,
							scopeMissing: h.scopeMissing,
							live: h.live,
							notes: h.notes
						}))
					}
				};
			}
			if (args.cleanup) {
				const { cleanupToolize } = await import("./toolize-D1gmjN2c.js");
				const { discoverSkillRoots } = await import("./skill-forge-DHxPo_w6.js").then((n) => n.y);
				const result = await cleanupToolize({
					store,
					roots: discoverSkillRoots({
						store,
						cwd,
						dshHome: process.env.DSH_HOME
					}),
					dropPending: true
				});
				deps.logger.info("supermemory: cleanup retired " + result.retiredCount + " legacy sequence row(s), cleared " + result.clearedProposals + " proposal(s), archived " + result.archivedCount + " shell skill(s)");
				return {
					status: "cleaned",
					message: "已清理：退役历史工具序列行 " + result.retiredCount + "，清空待处理提案 " + result.clearedProposals + "，归档壳子 skill " + result.archivedCount + "（扫描 " + result.scannedSkills + " 个文件）。",
					archived: result.archived.map((entry) => ({
						name: entry.name,
						root: entry.root,
						archivePath: entry.archivePath
					})),
					archivedCount: result.archivedCount,
					archivedSkills: result.archivedCount,
					retiredUnits: result.retiredShellUnits,
					retiredUnitNames: result.retiredShellNames,
					retiredComposites: result.retiredCount,
					clearedProposals: result.clearedProposals,
					prunedSignals: result.prunedSignals,
					pendingBefore: result.pendingBefore,
					pendingAfter: result.pendingAfter,
					expiredProposals: result.expiredProposals,
					retired: result.retired.map((item) => item.name),
					archiveRoots: result.archiveRoots.map((root) => ({
						root: root.root,
						scanned: root.scanned,
						archived: root.archived
					}))
				};
			}
			if (args.enabled !== void 0 && args.name && !args.register && !args.accept && !args.decline && !args.refreshBuiltin && !args.body && !args.description && !args.entry && !args.skill) {
				const logical = capabilityLogicalName(String(args.name));
				const target = capabilityRows(store, workspaceKey).find((entry) => entry.record.name === logical || entry.id === String(args.name));
				if (!target) return {
					status: "error",
					message: "找不到该能力：" + args.name
				};
				const result = await setCapabilityEnabled(ctx, store, target.id, Boolean(args.enabled));
				if (result.status === "error") return {
					status: "error",
					message: result.message
				};
				deps.logger.info("supermemory: capability " + target.record.name + (args.enabled ? " enabled" : " disabled"));
				return {
					status: "registered",
					tool: target.record.name,
					message: result.message
				};
			}
			if (args.register) {
				if (!args.name || !args.description) return {
					status: "error",
					message: "register 需要 name 与 description（description 是模型路由依据，写清「何时用」）。"
				};
				const wantKnowledge = args.skill === true || !args.entry;
				const ws = workspaceKey ?? (args.scope ? workspaceKeyOf(args.scope) : void 0);
				const result = await registerCapability(ctx, store, {
					name: String(args.name),
					...args.title ? { title: args.title } : {},
					description: String(args.description),
					...wantKnowledge ? {} : { entry: String(args.entry) },
					...args.doc ? { doc: args.doc } : {},
					...args.scope ? { scope: args.scope } : {},
					...args.runnable !== void 0 ? { runnable: args.runnable } : {},
					...args.dryRunArg ? { dryRunArg: args.dryRunArg } : {},
					...args.writeConfirm !== void 0 ? { writeConfirm: args.writeConfirm } : {},
					...args.tags ? { tags: args.tags } : {},
					...args.body ? { body: args.body } : {},
					...args.changelog ? { changelog: args.changelog } : {},
					source: "manual"
				}, ws);
				if (result.status === "error") return {
					status: "error",
					message: result.message
				};
				deps.logger.info("supermemory: capability " + result.name + " registered via memory_toolize");
				return {
					status: "registered",
					tool: result.name,
					message: result.message
				};
			}
			const pending = pendingProposalsOf(store, workspaceKey);
			if (!args.accept && !args.decline) {
				const rows = capabilityRows(store, workspaceKey).filter((entry) => entry.record.kind !== "proposal" && !isShellUnit(entry.record));
				const health = new Map(capabilityHealthOf(store, workspaceKey).map((row) => [row.id, row]));
				const unitOf = (entry) => {
					const record = entry.record;
					const h = health.get(entry.id);
					const name = record.kind === "capability" ? capabilityToolName(record.name) : "sm-" + record.name;
					const badges = [
						record.kind === "capability" ? "可执行" : "仅知识",
						...record.source === "auto" ? ["自动"] : [],
						...entry.record.entryDraft && !entry.record.entryVerified ? ["入口待验证"] : []
					];
					return {
						id: entry.id,
						name,
						logicalName: record.name,
						kind: record.kind,
						title: record.title,
						description: record.description,
						badges,
						entry: record.entry,
						entryDraft: entry.record.entryDraft,
						entryVerified: entry.record.entryVerified,
						doc: record.doc,
						scope: record.scope,
						runnable: record.runnable !== false,
						enabled: record.enabled !== false,
						status: entry.row.status,
						version: record.version,
						loadCount: record.loadCount,
						runCount: record.runCount,
						loadsToRuns: h?.loadsToRuns ?? 0,
						successRate: h?.successRate ?? 0,
						successCount: record.successCount,
						failCount: record.failCount,
						consecutiveFailures: record.consecutiveFailures,
						...record.lastStatus ? { lastStatus: record.lastStatus } : {},
						skillPath: record.skillPath,
						source: record.source,
						...record.taskKey ? { taskKey: record.taskKey } : {},
						builtin: record.builtin,
						notes: h?.notes ?? []
					};
				};
				const units = rows.map(unitOf);
				return {
					status: "listed",
					proposals: pending.map((entry) => ({
						name: entry.record.name,
						title: entry.record.title,
						description: entry.record.description,
						version: entry.record.version,
						...entry.record.taskKey ? { taskKey: entry.record.taskKey } : {},
						source: entry.record.source,
						entryDraft: entry.record.entryDraft,
						entryVerified: entry.record.entryVerified,
						...entry.record.expiresAt !== void 0 ? { expiresAt: entry.record.expiresAt } : {}
					})),
					units,
					capabilities: units.filter((unit) => unit.kind === "capability").map((unit) => ({
						name: unit.name,
						logicalName: unit.logicalName,
						title: unit.title,
						entry: unit.entry,
						doc: unit.doc,
						scope: unit.scope,
						runnable: unit.runnable,
						dryRunArg: rows.find((entry) => entry.id === unit.id)?.record.dryRunArg,
						writeConfirm: Boolean(rows.find((entry) => entry.id === unit.id)?.record.writeConfirm),
						status: unit.status,
						useCount: unit.runCount,
						runCount: unit.runCount,
						loadCount: unit.loadCount,
						loadsToRuns: unit.loadsToRuns,
						version: unit.version,
						...unit.lastStatus ? { lastStatus: unit.lastStatus } : {},
						live: liveCapabilityNames().includes(unit.name),
						entryDraft: unit.entryDraft,
						entryVerified: unit.entryVerified
					})),
					skills: units.map((unit) => ({
						name: "sm-" + unit.logicalName,
						title: unit.title,
						description: unit.description,
						version: unit.version,
						useCount: unit.loadCount,
						loadCount: unit.loadCount,
						enabled: unit.enabled,
						status: unit.status,
						path: unit.skillPath,
						source: unit.source,
						occurrences: 1
					}))
				};
			}
			if (pending.length === 0) return { status: "none" };
			const logical = args.name ? capabilityLogicalName(String(args.name)) : void 0;
			const target = (logical ? pending.find((entry) => entry.record.name === logical) : void 0) ?? pending[0];
			if (args.decline) {
				const result = await declineProposal(store, target.id);
				if (result.status === "error") return {
					status: "error",
					message: result.message
				};
				return { status: "declined" };
			}
			const result = await acceptProposal(ctx, store, target.id);
			if (result.status === "error") return {
				status: "error",
				message: result.message
			};
			deps.logger.info("supermemory: accepted proposal " + (result.name ?? target.record.name));
			return {
				status: "accepted",
				...result.name ? { tool: result.name } : {},
				message: result.message,
				entryDraft: Boolean(result.entryDraft)
			};
		}
	})));
	disposers.push(ctx.tools.register(tools.defineTool({
		name: "sm_cap_doc",
		description: "按需读取一个固化能力的知识面正文（SuperMemory 单能力：知识面 + 执行面 sm_cap_*）。仅在中枢/分支会话需要具体步骤、判断标准或失败坑时调用；能力索引卡里的 name 直接填进来。可选 section 只返回某个「## 小节」。只返回 enabled 且可读取的能力；停用/不存在会明确报错。R55 职责边界：本工具对中枢只读（判断能力是否适用）；执行面 sm_cap_* 在中枢被 HUB_CAPABILITY_EXEC_DENIED 拒绝，要用 memory_dispatch 派发到分支执行。普通会话（非中枢/非分支）调用会被明确拒绝。不要用宿主 skill 工具加载固化能力——第三方 skill 才走 skill 目录。成功加载会给该能力 loadCount+1。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "能力逻辑名（如 git-sync-supermemory），或 sm_cap_* / sm-* 形式"
			},
			section: {
				type: "string",
				description: "可选：只取某个二级小节（如「关键坑」「验证方式」）"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["ok", "error"],
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					name: { type: "string" },
					title: { type: "string" },
					body: { type: "string" },
					factsBlock: { type: "string" },
					entry: { type: "string" },
					scope: { type: "string" },
					dryRunArg: { type: "string" },
					writeConfirm: { type: "boolean" },
					whenToUse: { type: "string" },
					loadCount: { type: "integer" },
					headings: {
						type: "array",
						items: { type: "string" }
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				if (v.status === "error") return [{
					type: "text",
					text: "能力加载失败：" + String(v.message ?? "未知错误")
				}];
				const head = "能力：" + (v.name ?? "") + (v.title ? "（" + v.title + "）" : "") + "\n" + (v.whenToUse ? "何时用：" + v.whenToUse + "\n" : "") + (v.entry ? "执行面：" + v.entry + "\n" : "执行面：仅知识\n");
				const facts = v.factsBlock ? "\n\n" + v.factsBlock : "";
				return [{
					type: "text",
					text: head + "\n" + String(v.body ?? "") + facts
				}];
			}
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd;
			const workspaceKey = cwd ? workspaceKeyOf(cwd) : void 0;
			const { loadCapabilityDoc } = await import("./capability-CerjsIyB.js").then((n) => n.l);
			const result = await loadCapabilityDoc(store, workspaceKey, String(args.name ?? ""), typeof args.section === "string" && args.section.trim() ? args.section : void 0);
			if (result.status === "error") return {
				status: "error",
				message: result.message,
				...result.headings ? { headings: result.headings } : {}
			};
			return {
				status: "ok",
				message: result.message,
				name: result.name,
				title: result.title,
				body: result.body,
				factsBlock: result.factsBlock,
				entry: result.entry,
				scope: result.scope,
				dryRunArg: result.dryRunArg,
				writeConfirm: result.writeConfirm,
				whenToUse: result.whenToUse,
				loadCount: result.loadCount,
				...result.headings ? { headings: result.headings } : {}
			};
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
			const now = Date.now();
			const title = text(body.title).slice(0, 48) || deriveTitle(memText);
			const keywords = mergeTags(normalizeTags(list(body.keywords)), tagsOfBody(memText));
			const stableKey = text(body.key) || void 0;
			if (stableKey) {
				const sameKey = findMemoryByKey(store, ws, stableKey);
				if (sameKey) {
					if (memoryContentUnchanged(sameKey[1], {
						title,
						text: memText,
						tags: keywords
					})) return sendJson(res, 200, {
						ok: true,
						id: sameKey[0],
						message: `该 key 已存相同内容，未重复写入（当前 v${sameKey[1].version ?? 1}）。`
					});
					const assignment = await resolveCollectionForEntry(store, ws, {
						title,
						keywords,
						text: memText
					}, {
						now,
						...ctx ? { deps: {
							ctx,
							logger
						} } : {}
					});
					if ("error" in assignment) return fail(assignment.error);
					const result = await updateMemoryVersioned(store, ws, sameKey[0], {
						title,
						text: memText,
						tags: keywords,
						...assignment.collectionId ? { collectionId: assignment.collectionId } : {}
					}, now);
					if (!result) return fail("key 对应的记忆不存在");
					if (result.status === "unchanged") return sendJson(res, 200, {
						ok: true,
						id: sameKey[0],
						message: `该 key 已存相同内容，未重复写入（当前 v${result.version}）。`
					});
					if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now);
					return sendJson(res, 200, {
						ok: true,
						id: sameKey[0],
						message: `已更新到 v${result.version}（旧版本已归档）。`
					});
				}
			}
			const assignment = await resolveCollectionForEntry(store, ws, {
				title,
				keywords,
				text: memText
			}, {
				now,
				...ctx ? { deps: {
					ctx,
					logger
				} } : {}
			});
			if ("error" in assignment) return fail(assignment.error);
			const id = await createMemoryVersioned(store, ws, {
				title,
				text: memText,
				tags: keywords,
				...stableKey ? { key: stableKey } : {},
				...assignment.collectionId ? { collectionId: assignment.collectionId } : {},
				sourceSessionId: text(body.sessionId) || "webui",
				sourceSeq: 0
			}, now);
			if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now);
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
			const result = await updateMemoryVersioned(store, ws, id, {
				...memText ? { text: memText } : {},
				...body.title !== void 0 ? { title: text(body.title).slice(0, 48) || deriveTitle(memText || existing.text) } : {},
				...body.keywords !== void 0 ? { tags: mergeTags(normalizeTags(list(body.keywords)), tagsOfBody(memText || existing.text)) } : {},
				...body.key !== void 0 ? { key: text(body.key) || void 0 } : {}
			});
			if (!result) return fail("记忆不存在");
			logger.info(`supermemory: webui updated memory ${id} -> v${result.version}`);
			return sendJson(res, 200, {
				ok: true,
				version: result.version
			});
		}
		case "memory/history": {
			const id = text(body.id);
			const existing = store.memories.get(id);
			if (!existing || existing.workspaceKey !== ws) return fail("记忆不存在");
			return sendJson(res, 200, {
				ok: true,
				id,
				versions: memoryHistoryOf(store, id).map((row) => ({
					version: row.version,
					updatedAt: row.updatedAt,
					title: row.title ?? "",
					tags: [...row.tags ?? []],
					text: row.text,
					changeType: row.changeType,
					...row.collectionId ? { collectionId: row.collectionId } : {}
				}))
			});
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
			if (!record) return fail("能力不存在");
			if (!toolRowInWorkspace(record, ws)) return fail("能力不属于当前工作区");
			const parsed = readCapabilityRow(record, id);
			if (!parsed) return fail("能力定义损坏，无法执行");
			if (parsed.record.kind !== "capability" || !parsed.record.entry) return fail("该能力仅知识，没有执行面");
			const result = runCapability(parsed.record, {
				...body.dryRun === void 0 ? {} : { dryRun: Boolean(body.dryRun) },
				...body.confirm === void 0 ? {} : { confirm: Boolean(body.confirm) }
			});
			if (result.status !== "needs-confirm") await bumpCapabilityRun(store, id, result);
			logger.info(`supermemory: webui ran capability ${parsed.record.name} (${result.status}, exit ${result.exitCode ?? "-"})`);
			return sendJson(res, 200, {
				ok: true,
				...result
			});
		}
		case "tool/enable-entry": {
			if (!ctx) return fail("宿主上下文不可用，无法启用执行。");
			const id = text(body.id);
			const existing = store.toolMemory.get(id);
			if (!existing) return fail("能力不存在");
			if (!toolRowInWorkspace(existing, ws)) return fail("能力不属于当前工作区");
			const result = await enableCapabilityEntryDraft(ctx, store, id);
			if (result.status === "error") return fail(result.message);
			return sendJson(res, 200, {
				ok: true,
				message: result.message
			});
		}
		case "proposal/accept": {
			if (!ctx) return fail("宿主上下文不可用，无法接受提案。");
			const id = text(body.id);
			const existing = store.toolMemory.get(id);
			if (!existing) return fail("提案不存在");
			if (!toolRowInWorkspace(existing, ws)) return fail("提案不属于当前工作区");
			const result = await acceptProposal(ctx, store, id);
			if (result.status === "error") return fail(result.message);
			return sendJson(res, 200, {
				ok: true,
				message: result.message,
				id: result.id,
				entryDraft: Boolean(result.entryDraft)
			});
		}
		case "proposal/decline": {
			const id = text(body.id);
			const existing = store.toolMemory.get(id);
			if (!existing) return fail("提案不存在");
			if (!toolRowInWorkspace(existing, ws)) return fail("提案不属于当前工作区");
			const result = await declineProposal(store, id);
			if (result.status === "error") return fail(result.message);
			return sendJson(res, 200, {
				ok: true,
				message: result.message
			});
		}
		case "tool/status": {
			if (!ctx) return fail("宿主上下文不可用，无法修改工具状态。");
			const id = text(body.id);
			const status = body.status === "active" || body.status === "retired" ? body.status : void 0;
			if (!status) return fail("status 必须是 active 或 retired");
			const existing = store.toolMemory.get(id);
			if (!existing) return fail("能力不存在");
			if (!toolRowInWorkspace(existing, ws)) return fail("能力不属于当前工作区");
			const result = await setCapabilityEnabled(ctx, store, id, status === "active");
			if (result.status === "error") return fail(result.message);
			logger.info(`supermemory: webui capability ${id} -> ${status}`);
			return sendJson(res, 200, {
				ok: true,
				message: result.message
			});
		}
		case "tool/delete": {
			if (!ctx) return fail("宿主上下文不可用，无法删除工具。");
			const id = text(body.id);
			const existing = store.toolMemory.get(id);
			if (!existing) return fail("能力不存在");
			if (!toolRowInWorkspace(existing, ws)) return fail("能力不属于当前工作区");
			const result = await deleteCapability(ctx, store, id);
			if (result.status === "error") return fail(result.message);
			logger.info(`supermemory: webui deleted capability ${id}`);
			return sendJson(res, 200, {
				ok: true,
				message: result.message
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
/**
* A3: 一条 tool_memory 行是否属于当前工作区。能力按行级归属或 scope 推导
* （composite.capabilityAppliesToWorkspace 同一语义）；序列组合工具无归属
* 无 scope = 全局。
*/
function toolRowInWorkspace(record, ws) {
	const parsed = readCapabilityRow(record);
	if (!parsed) return true;
	return capabilityAppliesToWorkspace(parsed.record, ws, record.workspaceKey);
}
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
	const memoryCollections = [];
	for (const [id, c] of store.memoryCollections?.entries() ?? []) {
		if (c.workspaceKey !== ws) continue;
		memoryCollections.push({
			id,
			...c
		});
	}
	memoryCollections.sort((a, b) => b.updatedAt - a.updatedAt);
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
		if (!toolRowInWorkspace(t, ws)) continue;
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
		memoryCollections,
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
// src/hub-role-text.ts
/**
* R55: the hub session's role prompt, kept in its own module so the wording is
* testable without importing the host runtime (index.ts owns the plugin boot).
*
* Injected ONLY when the initiating agent is a hub of its workspace (a
* top-level session that belongs to no topic set). Branches must never receive
* this text, or they would refuse the very work they were dispatched to do.
*
* Deliberately a SOFT convention: the hub keeps read-only tools; the runtime
* guard (role-guard.ts) is the hard layer. R55 adds the capability-check step:
* read the knowledge face with memory_toolize + sm_cap_doc, then DISPATCH the
* execution — a hub calling sm_cap_* is refused with HUB_CAPABILITY_EXEC_DENIED.
* @module supermemory/hub-role-text
*/
const HUB_ROLE_TEXT = [
	injectionTitle("hubRole"),
	"- 你是中枢会话：只做判断、派发（memory_dispatch）与汇总（收到 relay 结果后转述给用户）。",
	"- 不要直接读改文件、执行命令、跑构建或长篇推理——这些操作交给分支会话完成；你的价值是定义清楚任务与边界，再整合结果。",
	"- 工具白名单（默认拒绝）：你只能调用白名单内的工具；不在名单内的（含未来新增工具）会被运行时直接拒绝，需要某项时可在超级记忆面板「中枢权限」页签勾选启用（保存后下一个工具调用即生效）。",
	"- 派发时先设定能力：要改代码/跑命令用 capabilities=full；只审阅用 read；纯代码编辑用 read-write；汇总/轻量核对用 minimal。",
	"- 需求多或复杂（多个独立子任务、多个方向调研、互相可并行的修复）时，用 memory_dispatch 的 tasks[] 一次拆成多个分支并行协同：",
	"  每个任务一个独立分支，全部到达终态后只回送一次汇总，失败成员会单独标注；不要把一个可拆分的大任务塞进单个分支串行做。",
	"  并行组里的每个任务必须自包含（写清目标、范围、验收），彼此不要依赖同一文件的并发修改。",
	"- 系统上下文会注入「" + injectionTitle("branch") + "」卡：它列出你已拉起的分支（标题/标签/状态/话题集/是否被多个中枢共享），本轮 recall 命中话题集时还带出该话题集下的分支清单（标题/标签/状态/最后活动）；先看它再决定派发。",
	"- 分支归属话题集，可被同一话题集下的其他中枢复用/共享：继续同一条分支用 mode=continue（忙则排队），新任务用 mode=auto（复用空闲分支，否则新建）。",
	"- 不要为同一件工作反复新建分支造成重复/分裂；已完成或空闲的分支优先续派。",
	"- 系统上下文会注入「" + injectionTitle("capability") + "」卡（仅中枢/分支会话）：只列能力名、何时用与徽标；需要具体步骤/坑时调用 sm_cap_doc（name 即卡里的能力名），不要用宿主 skill 工具加载固化能力。第三方 skill（ego-browser/office 等）仍走宿主 skill 目录。",
	"- 每轮对话按这条路由检索再动手：① 先读 recall 卡里的相关记忆（历史结论/约定/构建命令/文件用途）；② 列出并匹配话题集（注入卡带出命中话题集的标题/标签）；③ 按话题集检索其下分支会话（标题/标签/状态/最后活动——注入卡已带出，面板/管理台可看全部）；④ 最后才决定复用（memory_dispatch mode=continue/auto 续派空闲分支）还是新建（mode=new）。",
	"- 能力检查（R55）：动手前先用 memory_toolize 看 units（名称/徽标/何时用/入口是否待验证），需要细节时用 sm_cap_doc 读取知识面正文判断是否适用；sm_cap_doc 对中枢只读。",
	"- 确认要执行能力时不要自己调用 sm_cap_*（中枢执行会被 HUB_CAPABILITY_EXEC_DENIED 拒绝）：用 memory_dispatch 派发到分支，任务文本里写明能力名 + 是否先预演 + 写操作需 confirm=true；分支回报后你只做汇总。",
	"- 命中话题集时把任务派到该话题集（派发时显式 topicSetId 或 sticky 路由都会解析），不要重新检索一遍、更不要另起炉灶。",
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
// src/role-guard.ts
/** Exact refusal for a branch that tries to reload this plugin. */
const BRANCH_RELOAD_DENIED = "分支会话不能重载插件，请由中枢会话执行（plugin_manager 的禁用/启用会终止当前分支）。";
/** Exact refusal for a non-branch, non-hub session that tries plugin management. */
const NON_HUB_RELOAD_DENIED = "只有中枢会话可以重载插件，请由中枢会话执行（当前会话不是中枢）。";
/** Exact guidance for a hub whose tool is not on the whitelist (R36). */
function hubToolNotAllowed(toolName) {
	return "该工具「" + toolName + "」不在中枢白名单中：可在超级记忆面板「中枢权限」页签勾选启用（中枢默认拒绝白名单以外的工具，未来新增工具同样默认拒绝）。中枢只做派发与收线，执行请用 memory_dispatch 派发给分支。";
}
/**
* R55: exact refusal for a hub that tries to RUN a capability. Deliberately
* distinct from the generic allowlist wording (which suggests ticking a panel
* checkbox): there is no checkbox that makes a hub run a capability — the tool
* is hidden from the hub's surface and the only correct move is to dispatch.
*/
function hubCapabilityExecDenied(toolName) {
	return "中枢不能执行固化能力；请用 memory_dispatch 派发到分支，任务里写明能力名、是否先预演、写操作需 confirm=true。（被拒绝的工具：" + toolName + "）";
}
/**
* R55: exact refusal for an ordinary (non-hub, non-branch) session reading a
* capability knowledge face. The tool stays registered on purpose so the model
* gets this explanation instead of a bare `UNKNOWN_TOOL`.
*/
const CAPABILITY_DOC_ROLE_DENIED = "固化能力知识面（sm_cap_doc）只允许中枢/分支会话读取：当前会话既不是中枢也不是分支，不能读取能力正文；请在对应话题集的中枢或分支会话中查看（普通会话仍可使用宿主 skill 目录里的第三方 skill）。";
/** Structured identity name recorded on every denial (ToolErrorInfo.name). */
const GUARD_ERROR_NAME = "supermemory:role-guard";
/** Build one denial (one place for the name/code shape). */
function guardDenial(reason, code) {
	return {
		reason,
		info: {
			name: GUARD_ERROR_NAME,
			code
		}
	};
}
/** `plugin_manager` actions that change the profile (all non-list actions). */
const PLUGIN_MANAGEMENT_PURE_ACTIONS = /* @__PURE__ */ new Set([
	"list_plugins",
	"list_bundles",
	"list_version_exemptions"
]);
/**
* R35: the old exported `isBranchSession` projection was removed. Production had
* no caller, but its export invited a SECOND branch authority next to
* {@link resolveRole} — exactly the drift that left route.ts missing
* `dispatches.branchSessionId`. Callers use `resolveRole(store, agent).role`
* directly (route.ts, panel badge, dispatch, guard).
*/
/** Whether a tool call is a profile mutation through the host plugin manager. */
function isPluginManagementMutation(toolName, args) {
	if (toolName !== "plugin_manager") return false;
	const action = typeof args === "object" && args !== null ? String(args.action ?? "") : "";
	return !PLUGIN_MANAGEMENT_PURE_ACTIONS.has(action);
}
/**
* The pure, TOTAL guard decision.
*
* @param store - durable plugin store (undefined until the domain opens).
* @param agent - the Agent on whose behalf the call runs.
* @param toolName - the model-facing tool name.
* @param args - parsed tool arguments.
* @param warn - optional warning sink (a store/role/policy failure is logged,
*   never silent). The decision still returns: plugin_manager stays denied,
*   every other tool stays allowed.
* @returns a structured denial, or undefined to allow the call.
*/
function roleGuardDecision(store, agent, toolName, args, warn) {
	if (!store) return void 0;
	let role = "other";
	try {
		const resolution = resolveRole(store, agent);
		role = resolution.role;
		if (resolution.reason === "resolution-error") warn?.("supermemory: role guard resolution failed (store read); ordinary tools stay allowed, plugin_manager stays denied");
	} catch (error) {
		try {
			warn?.("supermemory: role guard resolution failed; plugin_manager stays denied, other tools allowed: " + String(error).slice(0, 160));
		} catch {}
		return isPluginManagementMutation(toolName, args) ? guardDenial(NON_HUB_RELOAD_DENIED, "NON_HUB_RELOAD_DENIED") : void 0;
	}
	if (toolName === "sm_cap_doc") {
		if (role !== "hub" && role !== "branch") return guardDenial(CAPABILITY_DOC_ROLE_DENIED, "CAPABILITY_DOC_ROLE_DENIED");
		return;
	}
	if (role === "hub" && isCapabilityExecutionTool(toolName)) return guardDenial(hubCapabilityExecDenied(toolName), "HUB_CAPABILITY_EXEC_DENIED");
	if (toolName === "plugin_manager" && isPluginManagementMutation(toolName, args)) {
		if (role === "branch") return guardDenial(BRANCH_RELOAD_DENIED, "BRANCH_RELOAD_DENIED");
		if (role !== "hub") return guardDenial(NON_HUB_RELOAD_DENIED, "NON_HUB_RELOAD_DENIED");
	}
	if (role === "hub") {
		if (!isHubAllowedTool(toolName, readHubPolicy(store, agentWorkspaceKey(agent), warn))) return guardDenial(hubToolNotAllowed(toolName), "HUB_TOOL_NOT_IN_ALLOWLIST");
	}
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
* maintenance loop and the boot cleanup never disagree).
*
* R49: the pair below governs PENDING PROPOSALS ONLY. No configuration value
* can make the automatic entrances register a composite anymore — that path was
* removed, and memory_toolize accept / register are the only two entrances.
*/
function toolizeConfig(config) {
	return {
		enabled: config.maintenance.autoComposite || config.maintenance.autoToolize,
		autoSkill: config.maintenance.autoSkill,
		skillMinSessions: config.maintenance.skillMinSessions,
		skillRecencyDays: config.maintenance.skillRecencyDays,
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
		capabilityIndex: Schema.object({
			enabled: Schema.boolean().description("R52：中枢/分支会话注入「可用能力」索引卡（默认开；正文用 sm_cap_doc 按需读取，不进入 available_skills）").default(true),
			maxItems: Schema.natural().description("能力索引卡最多几条（默认 8，硬上限 8）").default(8),
			maxChars: Schema.natural().description("能力索引卡字符预算（遵守 R47 裁剪与省略标记）").default(1600)
		}).description("可用能力索引卡参数").default({}),
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
		autoSkill: Schema.boolean().description("R45/R48：重复任务自动沉淀为 DSH skill（写入 <仓库>/.dsh/skills，模型目录可路由；默认开。任务级签名 + 跨会话阈值，宁可不生成也不生成工具序列壳子）").default(true),
		skillMinSessions: Schema.natural().description("R48：同一任务签名至少跨几个会话/派发才自动生成 skill（默认 2；同会话重复不算）").default(2),
		skillRecencyDays: Schema.natural().description("R48：任务签名的时间衰减窗口（天）：超过这么多天没再出现的任务不再自动新增/升版（默认 30）").default(30),
		autoComposite: Schema.boolean().description("R49：允许把「有业务对象」的重复工具序列记为待接受提议（默认关；宽泛工具序列如 run_code>run_code 一律不生成候选）。无论开关如何，阈值跨越/启动扫尾/过程内重复都不会自动注册组合工具——组合工具只能由用户显式 memory_toolize accept 或 register 产生").default(false),
		autoToolize: Schema.boolean().description("需求 B 的旧开关（向后兼容的 autoComposite 别名）：true 也只生成待接受提议，不注册组合工具").default(false),
		toolizeCooldownMs: Schema.natural().description("（R49 停用，保留键兼容旧配置）自动注册已移除，不存在自动固化冷却").default(6e4),
		toolizeMax: Schema.natural().description("（R49 停用，保留键兼容旧配置）显式 accept 不受数量上限约束").default(8),
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
const PROMPT_TEXT = [
	injectionTitle("pluginPrompt"),
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
	"- 对话中可能出现 " + injectionTitle("memory") + " / " + injectionTitle("topic") + " / " + injectionTitle("topicCandidate") + " 注入卡片：仅供参考，",
	"  与用户当前指令冲突时以当前指令为准；" + injectionTitle("topicCandidate") + " 只是候选列表，不代表已切换话题。"
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
	if (store) {
		backfillHubRecords(store, logger).catch((error) => {
			logger.warn("supermemory: hub record backfill failed: " + String(error).slice(0, 160));
		});
		mergeLockedHubPolicies(store).then((result) => {
			if (result.updated > 0) logger.info("supermemory: merged locked hub policy entries into " + result.updated + " workspace row(s): " + result.added.join(", "));
		}).catch((error) => {
			logger.warn("supermemory: hub policy locked-entry merge failed: " + String(error).slice(0, 160));
		});
	}
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
	ctx.effect(() => {
		const tools = ctx.tools;
		const markGuard = (patch) => {
			try {
				const current = store?.meta.get("role-guard") ?? {};
				store?.meta.put("role-guard", {
					...current,
					...patch
				}).catch(() => {});
			} catch {}
		};
		if (typeof tools.guard !== "function") {
			logger.warn("supermemory: [ALERT] ctx.tools.guard unavailable; hub/branch runtime guard NOT installed (host limitation)");
			markGuard({
				roleGuardFailedAt: Date.now(),
				roleGuardVersion: 4,
				roleGuardError: "ctx.tools.guard unavailable"
			});
			return () => {};
		}
		try {
			const dispose = tools.guard((exec) => roleGuardDecision(store, exec.agent, exec.name, exec.arguments, (message) => logger.warn(message)));
			markGuard({
				roleGuardInstalledAt: Date.now(),
				roleGuardVersion: 4
			});
			return dispose;
		} catch (error) {
			logger.warn("supermemory: [ALERT] ctx.tools.guard registration failed; hub/branch runtime guard NOT installed: " + String(error).slice(0, 200));
			markGuard({
				roleGuardFailedAt: Date.now(),
				roleGuardVersion: 4,
				roleGuardError: String(error).slice(0, 300)
			});
			return () => {};
		}
	}, "supermemory: role guard");
	const tracker = createTracker();
	ctx.effect(() => attachPreStep(ctx, store, {
		enabled: true,
		maxItems: config.recall.maxItems,
		minScore: config.recall.minScore,
		halfLifeDays: config.recall.halfLifeDays,
		maxChars: config.recall.maxChars,
		injectStyle: config.recall.injectStyle,
		capabilityIndex: config.recall.capabilityIndex,
		repeat: config.recall.repeat,
		tracker
	}, logger), "supermemory: pre-step");
	ctx.effect(() => attachToolActivity(ctx, store, tracker, {
		repeat: config.recall.repeat,
		nearMissHint: config.maintenance.nearMissHint
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
			const { cleanupToolize, sweepTaskProposals } = await import("./toolize-D1gmjN2c.js");
			const { discoverSkillRoots } = await import("./skill-forge-DHxPo_w6.js").then((n) => n.y);
			const toolize = toolizeConfig(config);
			const cleanup = await cleanupToolize({
				store,
				roots: discoverSkillRoots({
					store,
					cwd: process.cwd(),
					dshHome: process.env.DSH_HOME
				}),
				dropPending: false
			});
			if (cleanup.retiredCount > 0) logger.info("supermemory: retired " + cleanup.retiredCount + " legacy auto sequence composite(s): " + cleanup.retired.map((item) => item.name).join(", "));
			if (cleanup.clearedProposals > 0 || cleanup.prunedSignals > 0) logger.info("supermemory: proposal cleanup cleared " + cleanup.clearedProposals + " pending, pruned " + cleanup.prunedSignals + " broad sequence signal(s)");
			if (cleanup.archivedCount > 0) logger.info("supermemory: archived " + cleanup.archivedCount + " legacy shell skill(s) under " + cleanup.archiveRoots.filter((root) => root.archived > 0).map((root) => root.root).join(", "));
			if (cleanup.retiredShellUnits > 0) logger.info("supermemory: retired " + cleanup.retiredShellUnits + " adopted shell unit(s): " + cleanup.retiredShellNames.join(", "));
			await sweepTaskProposals(store, toolize, logger);
			const { rebuildCapabilities } = await import("./capability-CerjsIyB.js").then((n) => n.l);
			const count = await rebuildCapabilities(ctx, store);
			if (count > 0) logger.info("supermemory: rebuilt " + count + " capability tool(s) (sm_cap_*)");
		} catch (error) {
			logger.warn(`supermemory: capability rebuild failed: ${String(error).slice(0, 200)}`);
		}
	})();
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
		autoToolize: config.maintenance.autoComposite || config.maintenance.autoToolize,
		autoSkill: config.maintenance.autoSkill,
		skillMinSessions: config.maintenance.skillMinSessions,
		skillRecencyDays: config.maintenance.skillRecencyDays,
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
		migrateHubSessionTitles({
			ctx,
			store,
			logger
		}).catch((error) => {
			logger.warn("supermemory: hub title migration failed: " + String(error).slice(0, 160));
		}).then(() => migrateHubSessionRecords({
			ctx,
			store,
			logger,
			workspaceKeys: knownWorkspaceKeys(store)
		})).catch((error) => {
			logger.warn("supermemory: hub record migration failed: " + String(error).slice(0, 160));
		});
		const titleDeps = {
			ctx,
			store,
			logger
		};
		ctx.effect(() => attachSessionTitles(titleDeps), "supermemory: session-titles");
		startupSessionTitles(titleDeps).catch((error) => {
			logger.warn("supermemory: session-title startup pass failed: " + String(error).slice(0, 200));
		});
		applyMemoryOrganize(store, workspaceKeyOf(PLUGIN_REPO_ROOT), { logger }).catch((error) => {
			logger.warn("supermemory: memory organize failed: " + String(error).slice(0, 200));
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
		const restoreTimers = [];
		const runBranchRestore = (label) => {
			restoreBranchSessions({
				ctx,
				store: releaseStore,
				logger
			}).then((outcome) => {
				if (outcome.resumed.length > 0 || outcome.failed.length > 0 || outcome.live.length > 0) logger.info(renderBranchRestoreSummary(outcome) + "（" + label + "）");
			}).catch((error) => {
				logger.warn("supermemory: branch restore failed: " + String(error).slice(0, 160));
			});
		};
		restoreTimers.push(setTimeout(() => runBranchRestore("启动恢复"), 5e3));
		restoreTimers.push(setTimeout(() => runBranchRestore("启动补恢复"), 35e3));
		ctx.effect(() => () => {
			for (const timer of restoreTimers) clearTimeout(timer);
		}, "supermemory: branch-restore");
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
