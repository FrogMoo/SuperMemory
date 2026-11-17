import { a as __exportAll, r as workspaceKeyOf } from "./store-B1V4Vset.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
// src/filemap.ts
/**
* Project file map (P2): `/memory scan` walks the workspace, annotates files
* with a rule-based role, and invalidates stale entries by hash. The point is
* the P2 acceptance "新会话能答『这个文件干什么』": filemap entries join the
* recall ranking alongside memories/episodes/requirements.
*
* Annotation is rule-based by design: subagent-parallel LLM annotation only
* covers the skeleton (entry points, manifests, configs) and stays optional,
* so a scan never depends on an LLM being available.
* @module supermemory/filemap
*/
var filemap_exports = /* @__PURE__ */ __exportAll({
	filemapEntries: () => filemapEntries,
	scanWorkspace: () => scanWorkspace
});
const SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	".probe",
	"dist",
	"out",
	"build",
	".next",
	".turbo",
	"target",
	"_dsh_src",
	".obsidian",
	"Backup"
]);
const MAX_FILES = 600;
const MAX_BYTES = 524288;
/** Role inference from path and extension (rule-based skeleton). */
function roleOf(relPath) {
	const name = relPath.split(/[\\/]/).pop() ?? relPath;
	const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
	if (/^(package\.json|pnpm-lock\.yaml|tsconfig.*\.json|tsdown\.config\.ts|vite\.config\.ts)$/.test(name)) return "构建/依赖清单";
	if (/^README(\.\w+)?\.md$/i.test(name)) return "项目说明";
	if (/^cordis\.(patch\.)?ya?ml$/i.test(name)) return "插件组合层";
	if (name === "DEV-NOTES.md") return "开发运维笔记";
	if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") return "源码";
	if (ext === "js" || ext === "mjs" || ext === "cjs") return "脚本/产物";
	if (ext === "md" || ext === "markdown") return "文档";
	if (ext === "json" || ext === "jsonc" || ext === "yaml" || ext === "yml" || ext === "toml") return "配置";
	if (ext === "svg" || ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif") return "图片";
	if (ext === "py") return "Python";
	if (ext === "sh" || ext === "bash" || ext === "ps1" || ext === "cmd" || ext === "bat") return "脚本";
	if (ext === "log" || ext === "jsonl") return "日志/数据";
	return "其他";
}
/** D4 key encoding: ws/<workspaceKey hash>/<path hash>-<path-safe>. */
function filemapKey(workspaceKey, relPath) {
	return `ws/${createHash("sha1").update(workspaceKey).digest("hex").slice(0, 16)}/${createHash("sha1").update(relPath).digest("hex").slice(0, 12)}-${relPath.replace(/[\\/:*?"<>|]+/g, "_")}`;
}
/** Walk the workspace and refresh the filemap; returns counts. */
async function scanWorkspace(store, cwd) {
	const workspaceKey = workspaceKeyOf(cwd);
	const root = resolve(cwd);
	const files = [];
	let truncated = false;
	const walk = (dir, depth) => {
		if (depth > 6) {
			truncated = true;
			return;
		}
		if (files.length >= MAX_FILES) {
			truncated = true;
			return;
		}
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (files.length >= MAX_FILES) {
				truncated = true;
				return;
			}
			const full = join(dir, name);
			let isDir = false;
			let size = 0;
			try {
				const st = statSync(full);
				isDir = st.isDirectory();
				size = st.size;
			} catch {
				continue;
			}
			if (isDir) {
				if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
				walk(full, depth + 1);
			} else if (size <= MAX_BYTES) files.push(relative(root, full));
		}
	};
	walk(root, 0);
	const now = Date.now();
	let added = 0;
	let updated = 0;
	let stale = 0;
	const seenKeys = /* @__PURE__ */ new Set();
	for (const rel of files) {
		const posix = rel.replace(/\\/g, "/");
		const key = filemapKey(workspaceKey, posix);
		seenKeys.add(key);
		let hash;
		try {
			hash = createHash("sha1").update(readFileSync(join(root, rel))).digest("hex").slice(0, 16);
		} catch {
			hash = void 0;
		}
		const existing = store.filemap.get(key);
		if (!existing) {
			const entry = {
				workspaceKey,
				path: posix,
				role: roleOf(posix),
				summary: "",
				keywords: keywordsOfPath(posix),
				hash,
				annotatedAt: now
			};
			await store.filemap.put(key, entry);
			added++;
		} else {
			if (existing.hash !== hash) stale++;
			await store.filemap.update(key, (r) => ({
				...r,
				path: posix,
				hash,
				role: roleOf(posix),
				annotatedAt: now
			}));
			if (existing.hash === hash && existing.role !== roleOf(posix)) updated++;
		}
	}
	if (!truncated) for (const [key, entry] of [...store.filemap.entries()]) {
		if (entry.workspaceKey !== workspaceKey) continue;
		if (seenKeys.has(key)) continue;
		await store.filemap.delete(key);
		stale++;
	}
	return {
		scanned: files.length,
		added,
		updated,
		stale
	};
}
function keywordsOfPath(relPath) {
	const tokens = relPath.toLowerCase().split(/[\\/._\-]+/).filter((t) => t.length >= 2);
	return [...new Set(tokens)].slice(0, 12);
}
/** Filemap entries of one workspace, with readable paths. */
function filemapEntries(store, workspaceKey) {
	const out = [];
	for (const entry of store.filemap.entries()) if (entry[1].workspaceKey === workspaceKey) out.push(entry);
	return out;
}
export { filemap_exports as n, scanWorkspace as r, filemapEntries as t };
