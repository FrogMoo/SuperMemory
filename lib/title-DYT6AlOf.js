import { d as updateMember, t as addMember } from "./topicsets-D82ygniT.js";
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
export { ensureMemberTitle as a, currentSessionTitle as i, cleanTitleText as n, firstLine as o, clipEllipsis as r, sessionTitleFor as s, applySessionTitle as t };
