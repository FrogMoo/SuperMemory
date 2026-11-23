import { t as newId } from "./store-DZJW6hvc.js";
import { d as updateMember, t as addMember } from "./topicsets-Dlsn-ahx.js";
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
// src/memory-versions.ts
/** True when this store can persist memory history rows. */
function memoryVersionsSupported(store) {
	const table = store?.memoryVersions;
	return !!table && typeof table.put === "function" && typeof table.entries === "function";
}
/** 当前记忆的版本号（旧记录没有 version 字段时读作 1，与 zod 默认值一致）。 */
function currentVersionOf(memory) {
	const version = Number(memory?.version);
	return Number.isInteger(version) && version > 0 ? version : 1;
}
/**
* 版本化创建：写入 memories 行（version=1）并归档一条 v1 历史
* （changeType 'create'）。返回新记忆 id；没有历史表时只写 memories 行。
*/
async function createMemoryVersioned(store, workspaceKey, input, now = Date.now()) {
	const memoryId = newId("mem");
	const memory = {
		workspaceKey,
		title: input.title ?? "",
		text: input.text,
		keywords: [...input.tags ?? []],
		...input.key ? { key: input.key } : {},
		...input.collectionId ? { collectionId: input.collectionId } : {},
		sourceSessionId: input.sourceSessionId,
		sourceSeq: input.sourceSeq,
		status: "active",
		version: 1,
		createdAt: now,
		updatedAt: now
	};
	await store.memories.put(memoryId, memory);
	await archiveVersion(store, {
		workspaceKey,
		memoryId,
		version: 1,
		title: memory.title,
		text: memory.text,
		tags: memory.keywords,
		collectionId: input.collectionId,
		updatedAt: now,
		changeType: "create"
	});
	return memoryId;
}
function sameText(left, right) {
	return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}
function sameTags(left, right) {
	const a = (left ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
	const b = (right ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
	if (a.length !== b.length) return false;
	const set = new Set(b);
	return a.every((tag) => set.has(tag));
}
/** 内容是否变化（正文/标题/标签/集合任一不同即算变化，集合变更也记入历史）。 */
function contentChanged(memory, patch) {
	if (patch.text !== void 0 && !sameText(memory.text, patch.text)) return true;
	if (patch.title !== void 0 && (patch.title ?? "") !== (memory.title ?? "")) return true;
	if (patch.tags !== void 0 && !sameTags(memory.keywords, patch.tags)) return true;
	if (patch.collectionId !== void 0 && (patch.collectionId ?? "") !== (memory.collectionId ?? "")) return true;
	if (patch.key !== void 0 && (patch.key ?? "") !== (memory.key ?? "")) return true;
	return false;
}
/**
* 内容三要素（标题/正文/标签）是否都没变——集合归属另算。
*
* 写路径用它做「幂等快速判定」：内容没变时不必去解析集合归属，否则一次
* 完全相同内容的重写可能顺手新建一个空集合（记忆却没被挂上去）。
*/
function memoryContentUnchanged(memory, patch) {
	if (patch.text !== void 0 && !sameText(memory.text, patch.text)) return false;
	if (patch.title !== void 0 && (patch.title ?? "") !== (memory.title ?? "")) return false;
	if (patch.tags !== void 0 && !sameTags(memory.keywords, patch.tags)) return false;
	return true;
}
/**
* 版本化就地更新：同 key 不同内容时直接改当前记忆并 version+1，把新版本整体
* 归档进 memory_versions（旧版本从它创建/上一次更新起就已在档）。
*
* 幂等：内容完全相同 → 不升版、不写历史（status 'unchanged'）。
* 记忆不存在 / 不属于该工作区时返回 undefined（调用方自行报错）。
*/
async function updateMemoryVersioned(store, workspaceKey, memoryId, patch, now = Date.now()) {
	const memory = store.memories.get(memoryId);
	if (!memory || memory.workspaceKey !== workspaceKey) return void 0;
	const version = currentVersionOf(memory);
	if (!contentChanged(memory, patch)) return {
		status: "unchanged",
		version,
		memoryId
	};
	const next = {
		...memory,
		...patch.text !== void 0 ? { text: patch.text } : {},
		...patch.title !== void 0 ? { title: patch.title } : {},
		...patch.tags !== void 0 ? { keywords: [...patch.tags] } : {},
		...patch.collectionId !== void 0 ? patch.collectionId ? { collectionId: patch.collectionId } : { collectionId: void 0 } : {},
		...patch.key !== void 0 ? patch.key ? { key: patch.key } : { key: void 0 } : {},
		version: version + 1,
		updatedAt: now
	};
	await store.memories.update(memoryId, () => next);
	await archiveVersion(store, {
		workspaceKey,
		memoryId,
		version: next.version,
		title: next.title,
		text: next.text,
		tags: next.keywords,
		collectionId: next.collectionId,
		updatedAt: now,
		changeType: "update"
	});
	return {
		status: "updated",
		version: next.version,
		memoryId
	};
}
/** 归档一条历史版本（内部入口；没有历史表时静默跳过）。 */
async function archiveVersion(store, row) {
	const table = store.memoryVersions;
	if (!table) return;
	const record = {
		workspaceKey: row.workspaceKey,
		memoryId: row.memoryId,
		version: row.version,
		title: row.title ?? "",
		text: row.text,
		tags: [...row.tags ?? []],
		...row.collectionId ? { collectionId: row.collectionId } : {},
		updatedAt: row.updatedAt,
		changeType: row.changeType
	};
	await table.put(newId("memv"), record);
}
/** 一条记忆的全部历史版本（按版本号升序；没有历史表时返回空数组）。 */
function memoryHistoryOf(store, memoryId) {
	const table = store.memoryVersions;
	if (!table) return [];
	const rows = [];
	for (const [, row] of table.entries()) {
		if (row.memoryId !== memoryId) continue;
		rows.push(row);
	}
	rows.sort((a, b) => a.version - b.version || a.updatedAt - b.updatedAt);
	return rows;
}
/** 同一工作区、active、带该 key 的记忆（用于「同 key → 就地更新」判定）。 */
function findMemoryByKey(store, workspaceKey, key) {
	for (const entry of store.memories.entries()) {
		const [id, memory] = entry;
		if (memory.workspaceKey !== workspaceKey || memory.status !== "active") continue;
		if (memory.key !== key) continue;
		return [id, memory];
	}
}
/**
* 惰性迁移：给「没有任何历史行」的旧记忆补一条 v1 历史（changeType 'migrate'），
* 不改写正文/标题/标签/集合，也不动 version（旧记录读时即 version=1）。
*
* 判重按 memoryId 查历史表，所以天然幂等：新写入的记忆create 时已在档，
* 不会重复补；可以像 migrateFlatMemories 一样在 recall/remember 前调用。
*/
async function migrateMemoryVersions(store, workspaceKey, now = Date.now()) {
	const table = store.memoryVersions;
	if (!table) return { migrated: 0 };
	const seen = /* @__PURE__ */ new Set();
	for (const [, row] of table.entries()) {
		if (row.workspaceKey !== workspaceKey) continue;
		seen.add(row.memoryId);
	}
	let migrated = 0;
	for (const [id, memory] of store.memories.entries()) {
		if (memory.workspaceKey !== workspaceKey) continue;
		if (seen.has(id)) continue;
		await archiveVersion(store, {
			workspaceKey,
			memoryId: id,
			version: currentVersionOf(memory),
			title: memory.title ?? "",
			text: memory.text,
			tags: memory.keywords ?? [],
			collectionId: memory.collectionId,
			updatedAt: memory.updatedAt ?? now,
			changeType: "migrate"
		});
		migrated += 1;
	}
	return { migrated };
}
export { memoryHistoryOf as a, updateMemoryVersioned as c, clipEllipsis as d, currentSessionTitle as f, sessionTitleFor as h, memoryContentUnchanged as i, applySessionTitle as l, firstLine as m, currentVersionOf as n, memoryVersionsSupported as o, ensureMemberTitle as p, findMemoryByKey as r, migrateMemoryVersions as s, createMemoryVersioned as t, cleanTitleText as u };
