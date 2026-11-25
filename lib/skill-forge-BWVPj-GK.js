import { t as __exportAll } from "./rolldown-runtime-BJohB4LM.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
const MAX_FILES = 10;
const MAX_COMMANDS = 8;
const MAX_OBJECTS = 3;
const TOOL_NAMES = /* @__PURE__ */ new Set([
	"bash",
	"read",
	"write",
	"edit",
	"grep",
	"glob",
	"run_code",
	"run-code",
	"run",
	"tool",
	"tools",
	"todo_write",
	"todo",
	"skill",
	"present",
	"web_search",
	"web_fetch",
	"memory_recall",
	"memory_remember",
	"memory_dispatch",
	"memory_relay",
	"memory_toolize",
	"memory_ui",
	"memory_scan",
	"memory_topicsets",
	"memoryset",
	"plugin_manager"
]);
const STOP_WORDS = /* @__PURE__ */ new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"when",
	"then",
	"than",
	"into",
	"over",
	"under",
	"about",
	"after",
	"before",
	"while",
	"where",
	"which",
	"what",
	"who",
	"how",
	"why",
	"all",
	"any",
	"each",
	"every",
	"some",
	"not",
	"but",
	"but",
	"can",
	"could",
	"should",
	"would",
	"will",
	"must",
	"need",
	"needs",
	"needed",
	"use",
	"used",
	"using",
	"make",
	"makes",
	"made",
	"get",
	"gets",
	"got",
	"set",
	"sets",
	"run",
	"runs",
	"ran",
	"task",
	"tasks",
	"work",
	"works",
	"thing",
	"things",
	"case",
	"cases",
	"way",
	"ways",
	"file",
	"files",
	"path",
	"paths",
	"line",
	"lines",
	"code",
	"true",
	"false",
	"null",
	"http",
	"https",
	"json",
	"stdio",
	"stdout",
	"stderr",
	"exit",
	"note",
	"notes",
	"bash",
	"shell",
	"command",
	"commands",
	"cmd",
	"pnpm",
	"npm",
	"yarn",
	"node",
	"git",
	"cd",
	"ls",
	"cat",
	"sed",
	"grep",
	"awk",
	"find",
	"echo",
	"head",
	"tail",
	"wc",
	"mkdir",
	"src",
	"lib",
	"dist",
	"build",
	"docs",
	"scripts",
	"test",
	"tests",
	"index",
	"main"
]);
/** Names that can never be an object of a readable task skill. */
const GENERIC_OBJECTS = /* @__PURE__ */ new Set([
	"bash",
	"shell",
	"command",
	"commands",
	"cmd",
	"tool",
	"tools",
	"flow",
	"seq",
	"sequence",
	"run",
	"code",
	"run-code",
	"read",
	"write",
	"edit",
	"grep",
	"glob",
	"task",
	"work",
	"file",
	"files",
	"path",
	"paths",
	"src",
	"lib",
	"dist",
	"build",
	"docs",
	"scripts",
	"test",
	"tests",
	"index",
	"main",
	"package-json",
	"tsconfig",
	"readme",
	"changelog",
	"license",
	"install",
	"dev",
	"start",
	"tmp",
	"temp",
	"output",
	"assets"
]);
/**
* Action words are NOT objects: a task named 「修复 X」 must not become
* `fix-fix-x`. These tokens are dropped from text-object candidates.
*/
const VERB_TOKENS = /* @__PURE__ */ new Set([
	"fix",
	"fixing",
	"repair",
	"debug",
	"add",
	"adding",
	"implement",
	"create",
	"build",
	"refactor",
	"restructure",
	"rework",
	"rewrite",
	"migrate",
	"cleanup",
	"clean",
	"archive",
	"remove",
	"delete",
	"release",
	"publish",
	"packageing",
	"ship",
	"sync",
	"push",
	"pull",
	"commit",
	"rebase",
	"verify",
	"test",
	"validate",
	"smoke",
	"check",
	"review",
	"audit",
	"inspect",
	"merge",
	"integrate",
	"configure",
	"config",
	"enable",
	"disable",
	"update",
	"refresh",
	"upgrade",
	"bump",
	"investigate",
	"analyze",
	"analyse",
	"compare",
	"diff",
	"diagnose",
	"run",
	"runs",
	"build",
	"built",
	"use",
	"using",
	"make",
	"change"
]);
/**
* Context/architecture words: useful for retrieval, but never the task's
* object when a concrete domain noun exists (repo name, client/server half).
*/
const CONTEXT_OBJECT_NAMES = /* @__PURE__ */ new Set([
	"supermemory",
	"dsh-supermemory",
	"dsh",
	"client",
	"server",
	"frontend",
	"backend"
]);
const GENERIC_FILE_NAMES = /* @__PURE__ */ new Set([
	"index",
	"main",
	"package",
	"package-lock",
	"pnpm-lock",
	"tsconfig",
	"readme",
	"changelog",
	"license",
	"vite",
	"tsdown",
	"vitest",
	"eslint",
	"prettier",
	"config",
	"types",
	"type",
	"utils",
	"util",
	"helper",
	"helpers",
	"common",
	"constants",
	"consts",
	"env",
	"gitignore",
	"node_modules",
	"dist",
	"lib",
	"src",
	"scripts",
	"test",
	"tests",
	"docs",
	"build",
	"out",
	"tmp",
	"temp",
	"output",
	"assets",
	"public",
	"coverage",
	"skill",
	"skills",
	"session"
]);
/**
* Chinese NOUNS → stable English object slugs (longest phrase wins).
* Action words belong to VERB_RULES; keeping them out of this table is what
* stops names like `release-release-pack`.
*/
const OBJECT_LEXICON = [
	["发布资产", "release-assets"],
	["版本控制", "version-control"],
	["组合工具", "composite"],
	["固化能力", "capability"],
	["话题集", "topicset"],
	["工作区", "workspace"],
	["管理台", "webui"],
	["页签", "tab"],
	["标签", "tag"],
	["面板", "panel"],
	["记忆", "memory"],
	["版本", "version"],
	["分支", "branch"],
	["会话", "session"],
	["中枢", "hub"],
	["派发", "dispatch"],
	["技能", "skill"],
	["固化", "toolize"],
	["能力", "capability"],
	["检索", "recall"],
	["召回", "recall"],
	["注入", "inject"],
	["路由", "route"],
	["仓库", "repo"],
	["文档", "docs"],
	["脚本", "script"],
	["依赖", "deps"],
	["闸门", "gate"],
	["回归", "regression"],
	["设置", "settings"],
	["压缩包", "package"],
	["安装包", "package"],
	["包体", "package"],
	["双远端", "dual-remote"]
];
/** Verb rules: first matching rule wins (specific before broad). */
const VERB_RULES = [
	{
		re: /重构|改造|重排|调整|迁移|切换|替换|改成|改为|改名|改/,
		verb: "refactor",
		zh: "改造"
	},
	{
		re: /清理|归档|删除|移除|清掉|清空|干掉/,
		verb: "cleanup",
		zh: "清理"
	},
	{
		re: /发布|发版|打包|出包|上传|发包/,
		verb: "release",
		zh: "发布"
	},
	{
		re: /同步|推送|提交|双推|拉取|合并远端/,
		verb: "sync",
		zh: "同步"
	},
	{
		re: /验证|测试|回归|闸门|跑闸门|自测/,
		verb: "verify",
		zh: "验证"
	},
	{
		re: /审查|评审|审阅|检查|核对|复核/,
		verb: "review",
		zh: "审查"
	},
	{
		re: /合并|整合|归并|汇总/,
		verb: "merge",
		zh: "合并"
	},
	{
		re: /实现|新增|增加|添加|加入|加上|编写|开发|补上|补齐/,
		verb: "add",
		zh: "实现"
	},
	{
		re: /修复|修正|修改|修|排查|诊断|定位|解决|处理|修掉|搞掉|搞定/,
		verb: "fix",
		zh: "修复"
	},
	{
		re: /配置|设置|开启|关闭|打开|启用|停用/,
		verb: "config",
		zh: "配置"
	},
	{
		re: /更新|刷新|升级|升版/,
		verb: "update",
		zh: "更新"
	},
	{
		re: /说明|文档|记录|写文档/,
		verb: "docs",
		zh: "说明"
	},
	{
		re: /调研|分析|确认|评估|比较|对比/,
		verb: "investigate",
		zh: "调研"
	}
];
const ENGLISH_VERBS = [
	[
		/\b(refactor|restructure|rework|rewrite|reorgani[sz]e|migrate|switch)\b/i,
		"refactor",
		"改造"
	],
	[
		/\b(cleanup|clean-up|archive|remove|delete|prune|purge)\b/i,
		"cleanup",
		"清理"
	],
	[
		/\b(release|publish|package|bundle|ship)\b/i,
		"release",
		"发布"
	],
	[
		/\b(sync|push|pull|commit|rebase|merge-remote)\b/i,
		"sync",
		"同步"
	],
	[
		/\b(verify|test|validate|smoke|check|gate)\b/i,
		"verify",
		"验证"
	],
	[
		/\b(review|audit|inspect)\b/i,
		"review",
		"审查"
	],
	[
		/\b(merge|integrate|consolidate)\b/i,
		"merge",
		"合并"
	],
	[
		/\b(add|implement|create|build|introduce|support)\b/i,
		"add",
		"实现"
	],
	[
		/\b(fix|repair|debug|diagnose|resolve|patch|correct)\b/i,
		"fix",
		"修复"
	],
	[
		/\b(configure|config|setting|enable|disable|toggle)\b/i,
		"config",
		"配置"
	],
	[
		/\b(update|refresh|upgrade|bump)\b/i,
		"update",
		"更新"
	],
	[
		/\b(docs?|document|documentation|readme)\b/i,
		"docs",
		"说明"
	],
	[
		/\b(investigate|analyze|analyse|compare|diff|diagnose)\b/i,
		"investigate",
		"调研"
	]
];
const WRAPPER_COMMANDS = /* @__PURE__ */ new Set([
	"bash",
	"sh",
	"zsh",
	"cmd",
	"powershell",
	"pwsh",
	"wsl"
]);
const INSPECT_COMMANDS = /* @__PURE__ */ new Set([
	"cd",
	"ls",
	"dir",
	"cat",
	"sed",
	"awk",
	"grep",
	"rg",
	"find",
	"head",
	"tail",
	"wc",
	"which",
	"where",
	"pwd",
	"echo",
	"printf",
	"env",
	"export",
	"set",
	"test",
	"true",
	"false",
	"sleep",
	"date",
	"touch",
	"stat",
	"file",
	"du",
	"df",
	"tree",
	"type",
	"more",
	"less"
]);
const GENERIC_SCRIPTS = /* @__PURE__ */ new Set([
	"typecheck",
	"build",
	"smoke",
	"test",
	"tests",
	"lint",
	"format",
	"install",
	"dev",
	"start",
	"clean",
	"check",
	"tsdown",
	"tsc",
	"vitest",
	"prepare",
	"prepublish",
	"release:dry",
	"pack",
	"release",
	"publish",
	"bundle",
	"ship"
]);
const WINDOWS_PATH_RE = /(?:[A-Za-z]:[\\/])[^\s'"`,;:)\]}]+/g;
const FILE_PATH_RE = /(?:[\w.@+-]+[\\/])*[\w@.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|ps1|html|css|scss|toml|lock|py|go|rs|java|kt|tgz|zip|svg|png|jpg)\b/gi;
const POSIX_PATH_RE = /(?:^|[\s'"`(=])((?:\.{0,2}\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+|[\w.@%+-]+\/[\w.@%+-]+(?:\/[\w.@%+-]+)*)/g;
const ASCII_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]+)*/g;
/** Position of a needle in a text (9999 = not mentioned). */
function positionIn(text, needle) {
	if (!text || !needle) return 9999;
	const pos = text.toLowerCase().indexOf(needle.toLowerCase());
	return pos < 0 ? 9999 : pos;
}
/** Trim and collapse whitespace. */
function clean(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim();
}
function looksLikeUrl(value) {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /(?:^|[^\w])(?:https?|ftp):\/\//i.test(value);
}
/** Normalize a path-looking string (posix separators, no quotes, no drive tail). */
function normalizePathText(value) {
	let out = clean(value).replace(/^['"`]+|['"`]+$/g, "");
	if (looksLikeUrl(out)) return "";
	out = out.replace(/\\/g, "/");
	out = out.replace(/#L\d+(-L?\d+)?$/i, "");
	out = out.replace(/^file:\/\//i, "");
	out = out.replace(/[),.;]+$/g, "");
	return out.trim();
}
function basenameOf(path) {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}
function stemOf(file) {
	return file.replace(/\.[a-z0-9]+$/i, "");
}
function isAbsolutePath(path) {
	return /^[A-Za-z]:\//.test(path) || path.startsWith("/");
}
function isGenericName(name) {
	return GENERIC_FILE_NAMES.has(name.toLowerCase()) || name.length < 3;
}
function slugify(text, max = 32) {
	return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}
/** Every path-looking token in one text (task, command or argument). */
function extractPathTokens(text) {
	const raw = String(text ?? "");
	if (!raw) return [];
	const out = /* @__PURE__ */ new Set();
	for (const match of raw.matchAll(WINDOWS_PATH_RE)) {
		const path = normalizePathText(match[0]);
		if (path) out.add(path);
	}
	for (const match of raw.matchAll(FILE_PATH_RE)) {
		const path = normalizePathText(match[0]);
		if (path && !looksLikeUrl(path)) out.add(path);
	}
	for (const match of raw.matchAll(POSIX_PATH_RE)) {
		const path = normalizePathText(match[1] ?? "");
		if (path && !looksLikeUrl(path) && path.includes("/")) out.add(path);
	}
	return [...out].slice(0, 40);
}
/** Command families observed in bash-like arguments. */
function extractCommandFamilies(samples) {
	const commands = /* @__PURE__ */ new Set();
	const objects = /* @__PURE__ */ new Map();
	const addObject = (slug, display, source, score) => {
		const key = slug.toLowerCase();
		if (!key || GENERIC_OBJECTS.has(key) || VERB_TOKENS.has(key)) return;
		const existing = objects.get(key);
		if (!existing || existing.score < score) objects.set(key, {
			slug: key,
			score,
			source,
			display,
			pos: 9999
		});
	};
	for (const sample of samples) sample.tools.forEach((tool, index) => {
		if (tool !== "bash" && tool !== "terminal" && tool !== "shell") return;
		const args = sample.args[index] ?? {};
		const command = typeof args.command === "string" ? args.command : "";
		if (!command) return;
		for (const family of commandFamiliesOf(command)) commands.add(family.family);
		for (const object of commandObjectsOf(command)) addObject(object.slug, object.display, "command", object.score);
	});
	return {
		commands: [...commands].slice(0, MAX_COMMANDS),
		objects: [...objects.values()]
	};
}
function stripCommandPrefix(segment) {
	let out = segment.trim();
	out = out.replace(/^(?:sudo|time|env\s+[\w-]+=\S*)\s+/gi, "");
	out = out.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
	return out.trim();
}
/** Split one shell command into (normalized) simple command segments. */
function commandSegments(command) {
	return String(command ?? "").split(/&&|\|\||;|\n|\|/).map((part) => stripCommandPrefix(part)).filter(Boolean);
}
function commandFamilyOf(segment) {
	const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^["']|["']$/g, "")) ?? [];
	if (words.length === 0) return void 0;
	const executable = basenameOf(words[0].replace(/\\\\/g, "/")).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
	if (!executable) return void 0;
	if (WRAPPER_COMMANDS.has(executable) || INSPECT_COMMANDS.has(executable)) return void 0;
	if (executable === "pnpm" || executable === "npm" || executable === "yarn" || executable === "bun") {
		let script = words[1] ?? "";
		if (script === "run" || script === "exec" || script === "dlx") script = words[2] ?? "";
		if (!script) return { family: executable };
		const slug = slugify(script.replace(/^:/, ""), 28);
		const generic = GENERIC_SCRIPTS.has(slug) || script.startsWith("-");
		return {
			family: executable + " " + script,
			...slug && !generic ? { object: {
				slug,
				display: script,
				score: 2
			} } : {}
		};
	}
	if (executable === "node" || executable === "tsx" || executable === "ts-node") {
		const script = words.slice(1).find((word) => !word.startsWith("-")) ?? "";
		if (!script) return { family: executable };
		const file = basenameOf(script.replace(/\\\\/g, "/"));
		const name = stemOf(file);
		return {
			family: executable + " " + file,
			...name && !isGenericName(name) ? { object: {
				slug: slugify(name, 32),
				display: name,
				score: 2
			} } : {}
		};
	}
	if (executable === "git") {
		const sub = words.slice(1).find((word) => !word.startsWith("-")) ?? "";
		if (!sub) return { family: "git" };
		return { family: "git " + sub };
	}
	if (executable === "gh") {
		const sub = words.slice(1).filter((word) => !word.startsWith("-")).slice(0, 2).join(" ");
		return { family: sub ? "gh " + sub : "gh" };
	}
	return { family: executable };
}
function commandFamiliesOf(command) {
	return commandSegments(command).map((segment) => commandFamilyOf(segment)).filter((value) => Boolean(value));
}
function commandObjectsOf(command) {
	const out = [];
	for (const family of commandFamiliesOf(command)) if (family.object) out.push({
		slug: family.object.slug,
		score: family.object.score,
		source: "command",
		display: family.object.display,
		pos: 9999
	});
	return out;
}
/** Files/directories + object candidates from every recorded argument/command. */
function extractFileFacts(samples) {
	const files = /* @__PURE__ */ new Set();
	const dirs = /* @__PURE__ */ new Set();
	const objects = /* @__PURE__ */ new Map();
	const addObject = (slug, display, source, score, pos = 9999) => {
		const key = slug.toLowerCase();
		if (!key || GENERIC_OBJECTS.has(key) || VERB_TOKENS.has(key)) return;
		const existing = objects.get(key);
		if (!existing || existing.score < score || existing.score === score && pos < existing.pos) objects.set(key, {
			slug: key,
			score,
			source,
			display,
			pos: Math.min(existing?.pos ?? 9999, pos)
		});
	};
	const considerPath = (raw, taskText = "") => {
		const path = normalizePathText(raw);
		if (!path || looksLikeUrl(path) || path.length > 240) return;
		const display = isAbsolutePath(path) ? basenameOf(path) : path;
		if (/\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|ps1|html|css|scss|toml|lock|py|go|rs|tgz|zip)$/i.test(path)) {
			files.add(display);
			const base = basenameOf(path);
			const name = stemOf(base).toLowerCase();
			if (/\.(?:tgz|zip|tar|gz|7z)$/i.test(path)) addObject("package", stemOf(base), "file", 3, positionIn(taskText, base));
			else if (!isGenericName(name)) addObject(slugify(name, 32), stemOf(base), "file", 3, positionIn(taskText, base));
		}
		const dirParts = path.split("/").filter(Boolean).filter((part) => !/^[A-Za-z]:$/.test(part)).slice(0, -1);
		for (const dir of dirParts.slice(-3)) {
			const lowered = dir.toLowerCase();
			if (isGenericName(lowered) || lowered.startsWith(".")) continue;
			dirs.add(dir);
			addObject(slugify(dir, 28), dir, "dir", 2, positionIn(taskText, dir));
		}
	};
	for (const sample of samples) {
		const taskText = sample.task ?? "";
		sample.tools.forEach((tool, index) => {
			const args = sample.args[index] ?? {};
			for (const key of [
				"file_path",
				"path",
				"cwd",
				"directory",
				"pattern",
				"glob",
				"description"
			]) {
				const value = args[key];
				if (typeof value === "string" && value.length > 0) for (const token of extractPathTokens(value)) considerPath(token, taskText);
			}
			if (typeof args.command === "string") for (const token of extractPathTokens(args.command)) considerPath(token, taskText);
		});
		if (sample.task) for (const token of extractPathTokens(sample.task)) considerPath(token, sample.task);
	}
	return {
		files: [...files].slice(0, MAX_FILES),
		dirs: [...dirs].slice(0, 6),
		objects: [...objects.values()]
	};
}
/** Domain-noun objects from the task text (Chinese lexicon + ASCII identifiers). */
function extractTextObjects(text) {
	const raw = String(text ?? "");
	const objects = /* @__PURE__ */ new Map();
	const keywords = /* @__PURE__ */ new Set();
	const add = (slug, display, score, pos) => {
		const key = slug.toLowerCase();
		if (!key || GENERIC_OBJECTS.has(key) || STOP_WORDS.has(key) || VERB_TOKENS.has(key)) return;
		const weight = CONTEXT_OBJECT_NAMES.has(key) ? Math.min(score, 1) : score;
		const existing = objects.get(key);
		if (!existing || existing.score < weight || existing.score === weight && pos < existing.pos) objects.set(key, {
			slug: key,
			score: weight,
			source: "text",
			display,
			pos
		});
		if (keywords.size < 12) keywords.add(display);
	};
	for (const [term, slug] of OBJECT_LEXICON) {
		const pos = raw.indexOf(term);
		if (pos >= 0) add(slug, slug, term.length >= 4 ? 3 : 2, pos);
	}
	for (const match of raw.matchAll(ASCII_TOKEN_RE)) {
		const token = match[0].replace(/\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|ps1|html|css|scss|toml)$/i, "");
		if (token.length < 3 || token.length > 40) continue;
		if (/^[rv]?\d+(?:\.\d+)*$/i.test(token)) continue;
		const lowered = token.toLowerCase();
		if (STOP_WORDS.has(lowered) || TOOL_NAMES.has(lowered) || VERB_TOKENS.has(lowered)) continue;
		const identifier = /[-_.:]/.test(token);
		const slug = slugify(token, 36);
		if (!slug) continue;
		add(slug, token, identifier ? 3 : 2, match.index ?? 9999);
	}
	return {
		objects: [...objects.values()],
		keywords: [...keywords]
	};
}
/**
* Pick the verb from the EARLIEST match in the task text (ties go to the more
* specific rule), then fall back to command/tool evidence. Earliest-match
* matters: 「修X，改为Y」 is a fix task, not a refactor task.
*/
function detectTaskVerb(text, tools, commands) {
	const raw = String(text ?? "");
	let best;
	VERB_RULES.forEach((rule, rank) => {
		const match = rule.re.exec(raw);
		if (!match || match.index < 0) return;
		if (!best || match.index < best.index || match.index === best.index && rank < best.rank) best = {
			index: match.index,
			verb: rule.verb,
			zh: rule.zh,
			rank
		};
	});
	ENGLISH_VERBS.forEach(([re, verb, zh], rank) => {
		const match = re.exec(raw);
		if (!match || match.index < 0) return;
		if (!best || match.index < best.index || match.index === best.index && rank < best.rank) best = {
			index: match.index,
			verb,
			zh,
			rank
		};
	});
	if (best !== void 0) return {
		verb: best.verb,
		verbZh: best.zh,
		fromText: true
	};
	const joined = commands.join(" ");
	if (/\bgit\s+(?:push|commit|rebase|fetch|pull)\b/.test(joined) || /git:sync/.test(joined)) return {
		verb: "sync",
		verbZh: "同步",
		fromText: false
	};
	if (/\bpnpm\s+(?:build|tsdown)\b|\btsdown\b/.test(joined)) return {
		verb: "build",
		verbZh: "构建",
		fromText: false
	};
	if (/\bpnpm\s+(?:typecheck|smoke|test|lint)\b|\btsc\b/.test(joined)) return {
		verb: "verify",
		verbZh: "验证",
		fromText: false
	};
	if (/\b(?:tar|zip|7z|gzip)\b|\bgh release\b/.test(joined)) return {
		verb: "release",
		verbZh: "发布",
		fromText: false
	};
	if (tools.some((tool) => tool === "edit" || tool === "write")) return {
		verb: "fix",
		verbZh: "修复",
		fromText: false
	};
	if (tools.some((tool) => tool === "read" || tool === "grep" || tool === "glob")) return {
		verb: "review",
		verbZh: "审查",
		fromText: false
	};
}
function sortObjects(objects) {
	const byScore = [...objects].sort((left, right) => right.score - left.score || left.pos - right.pos || right.slug.length - left.slug.length || left.slug.localeCompare(right.slug));
	const out = [];
	for (const candidate of byScore) if (!out.some((existing) => existing.slug === candidate.slug || existing.slug.split("-").includes(candidate.slug) || candidate.slug.split("-").includes(existing.slug))) out.push(candidate);
	return out;
}
/** Extract a stable task signature; undefined means "not worth a skill". */
/** First non-empty line, clipped: a dispatch/user request states its topic there. */
function taskHeadline(task) {
	return (String(task ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "").slice(0, 180).trim();
}
function extractTaskSignature(input) {
	const rawTask = String(input.task ?? "");
	const task = clean(rawTask);
	const tools = (input.tools ?? []).filter((tool) => typeof tool === "string" && tool.length > 0);
	if (tools.length < 2) return void 0;
	if (task.length < 6) return void 0;
	const samples = [{
		...input,
		tools,
		args: input.args ?? []
	}];
	const headline = taskHeadline(rawTask);
	const headlineText = extractTextObjects(headline);
	const fullText = extractTextObjects(task);
	const text = headlineText.objects.some((object) => object.score >= 2) ? headlineText : fullText;
	const fileFacts = extractFileFacts(samples);
	const commandFacts = extractCommandFamilies(samples);
	let verb = detectTaskVerb(headline, tools, commandFacts.commands) ?? detectTaskVerb(task, tools, commandFacts.commands);
	if (!verb) return void 0;
	const artifactFile = fileFacts.files.find((file) => /\.(?:tgz|zip|7z|tar\.gz)$/i.test(file));
	if (artifactFile && /release|发布|发版|打包|发包/i.test(task)) verb = {
		verb: "release",
		verbZh: "发布",
		fromText: true
	};
	const textObjects = sortObjects(text.objects).filter((object) => object.score >= 2);
	const evidenceObjects = sortObjects([...fileFacts.objects, ...commandFacts.objects]).filter((object) => object.score >= 2);
	const chosen = textObjects.length > 0 ? textObjects : evidenceObjects;
	if (chosen.length === 0) return void 0;
	let objects = chosen.slice(0, MAX_OBJECTS);
	if (verb.verb === "release" && artifactFile) {
		const ext = artifactFile.toLowerCase().endsWith(".tar.gz") ? "tar-gz" : artifactFile.toLowerCase().split(".").pop() ?? "";
		const artifactObjects = [{
			slug: "package",
			score: 3,
			source: "file",
			display: "package",
			pos: 9999
		}, ...ext && /^[a-z0-9]{2,8}$/.test(ext) ? [{
			slug: ext,
			score: 2,
			source: "file",
			display: ext,
			pos: 9999
		}] : []];
		const artifactSlugs = new Set(artifactObjects.map((object) => object.slug));
		objects = [...artifactObjects, ...objects.filter((object) => !artifactSlugs.has(object.slug))].slice(0, MAX_OBJECTS);
	}
	const primary = objects[0];
	const dimensions = new Set(objects.map((object) => object.source));
	if (evidenceObjects.some((object) => object.slug.includes(primary.slug) || primary.slug.includes(object.slug))) dimensions.add("file");
	if (commandFacts.commands.length > 0) dimensions.add("command");
	let score = 0;
	if (task.length >= 8) score += 2;
	if (verb.fromText) score += 2;
	score += Math.min(3, primary.score + (primary.score >= 3 ? 1 : 0));
	if (dimensions.size >= 2) score += 2;
	if (commandFacts.commands.some(isVerificationCommand)) score += 1;
	if (objects.length >= 2) score += 1;
	const confidence = Math.min(1, score / 11);
	if (confidence < .5) return void 0;
	const key = verb.verb + "/" + primary.slug;
	const nameBase = [verb.verb, ...objects.slice(0, 2).map((object) => object.slug)].join("-");
	const title = verb.verbZh + " " + objects.slice(0, 2).map((object) => object.display).join(" / ");
	const keywords = [.../* @__PURE__ */ new Set([...objects.map((object) => object.display), ...text.keywords])].slice(0, 8);
	return {
		key,
		verb: verb.verb,
		verbZh: verb.verbZh,
		object: primary.slug,
		objects: objects.map((object) => object.slug),
		nameBase,
		title,
		files: fileFacts.files,
		dirs: fileFacts.dirs,
		commands: commandFacts.commands,
		keywords,
		hasTaskText: true,
		confidence
	};
}
/** Verification-flavoured command families (used by the body + confidence). */
function isVerificationCommand(family) {
	return /\b(?:pnpm|npm|yarn)\s+(?:typecheck|build|smoke|test|lint|check)\b|\btsc\b|\bvitest\b|\bnode\s+scripts\/[\w.-]*smoke/i.test(family);
}
/** True when the name only talks about a tool flow (defensive check). */
function looksLikeToolFlowName(name) {
	const lowered = String(name ?? "").toLowerCase();
	if (/^(?:sm-)?(?:ws[a-z0-9]{5}-)?flow(?:-|$)/.test(lowered)) return true;
	return /(?:^|-)(?:bash|read|write|edit|grep|glob|run-code|run_code|tool)(?:-|$)/.test(lowered);
}
/** Token similarity of two skill names (0..1); used to drop near duplicates. */
function taskNameSimilarity(left, right) {
	const tokens = (name) => {
		const parts = String(name ?? "").toLowerCase().split("-").filter(Boolean);
		const out = /* @__PURE__ */ new Set();
		for (const part of parts) {
			if (part === "sm" || /^ws[a-z0-9]{5}$/.test(part)) continue;
			out.add(part);
		}
		return out;
	};
	const a = tokens(left);
	const b = tokens(right);
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const token of a) if (b.has(token)) inter += 1;
	return inter / Math.max(a.size, b.size);
}
// src/skill-forge.ts
/**
* Skill forge (R45 / R48): repeated WORK becomes a REAL DSH skill.
*
* 背景：P3 把重复流程编译成 `sm_composite_*` 组合工具——「按什么顺序调哪些
* 工具」。R45 把沉淀改到 DSH 的 skill 机制（`<project>/.dsh/skills/<name>/SKILL.md`，
* 项目根判定见 dsh-skill-filesystem：最近含 `.git` 的祖先），但自动生成退化成
* 了按工具序列命名（`sm-flow-bash-bash-…`）：没有对象、没有参数、没有坑，还会
* 挤占 available_skills 的路由注意力。
*
* R48 起识别的主体是「做过的事」，不是「连续调了哪些工具」：
* - 任务签名来自任务/派发文本（动词 + 对象）、真实文件/目录族、命令家族与关键
*   参数（`pnpm git:sync`、`pnpm typecheck`、`git push`…）；
* - 同一任务签名跨 ≥N 次、≥2 个会话/派发才产出草稿；工具序列只作为正文里
*   的历史事实，不参与命名与聚合；
* - 名称是 `sm-<verb>-<object>`（`fix-skill-forge`、`sync-gitee-github`），
*   描述写「做什么任务时加载」，正文六节全部来自真实样本，缺信息写「待补充」；
* - 历史遗留的工具序列壳子由 archiveShellSkills 归档（不删除，写 manifest）。
*
* 文件是事实来源（重启后仍在），tool_memory 的 kind='skill' 行只承载版本号、
* 使用计数与启用状态（不新增存储表，旧介质保持 v1 兼容）。同名更新 = version+1
* 并保留 changelog；内容完全一致 = 幂等不升版；检测到人工编辑 = 只更新统计，
* 绝不覆盖正文。
* @module supermemory/skill-forge
*/
var skill_forge_exports = /* @__PURE__ */ __exportAll({
	bumpSkillUse: () => bumpSkillUse,
	discoverSkillRoots: () => discoverSkillRoots,
	draftSkillFromManual: () => draftSkillFromManual,
	listSkills: () => listSkills,
	persistSkillDraft: () => persistSkillDraft,
	resolveSkillRoot: () => resolveSkillRoot,
	setSkillEnabled: () => setSkillEnabled,
	syncRepeatedTransactions: () => syncRepeatedTransactions,
	workspaceSkillToken: () => workspaceSkillToken
});
/** Kebab-case contract enforced by the host skill registry. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Changelog bound (newest first), same spirit as capabilities. */
const SKILL_CHANGELOG_MAX = 20;
/** Reserved frontmatter keys (host ignores unknown metadata keys). */
const META = {
	version: "sm-version",
	updatedAt: "sm-updated-at",
	source: "sm-source",
	occurrences: "sm-occurrences",
	taskKey: "sm-task-key",
	renderedHash: "sm-rendered-hash",
	changelog: "sm-changelog",
	enabled: "sm-enabled"
};
/** Short deterministic hash (FNV-1a, base36) for stable names. */
function shortHash(text, length = 6) {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(36).padStart(Math.max(1, Math.min(8, length)), "0").slice(0, length);
}
/** Lower-case ASCII slug; empty when the source has no ASCII letters/digits. */
function kebabCase(text, max = 40) {
	const slug = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length <= max) return slug;
	const cut = slug.slice(0, max);
	const boundary = cut.lastIndexOf("-");
	return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/g, "");
}
/** Clamp a name to the host's 64-ish practical bound without splitting a word. */
function clampName(name, max = 64) {
	if (name.length <= max) return name;
	const cut = name.slice(0, max);
	const boundary = cut.lastIndexOf("-");
	return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/g, "");
}
/** True when the name satisfies the host's kebab-case contract. */
function isSkillName(name) {
	return SKILL_NAME_RE.test(name) && name.startsWith("sm-");
}
/** `sm-<verb>-<object>` — stable for one repeated TASK (never a tool flow). */
function skillNameForTask(signature, sharedToken) {
	return clampName(kebabCase("sm-" + (sharedToken ? sharedToken + "-" : "") + signature.nameBase, 64), 64);
}
/**
* Readability gate: a task skill name must talk about an OBJECT, not a tool
* flow. Legacy shells (`sm-flow-bash-bash-…`) and names built only from tool
* words are rejected outright.
*/
function isReadableTaskSkillName(name) {
	if (!isSkillName(name)) return false;
	if (looksLikeToolFlowName(name)) return false;
	const segments = name.replace(/^sm-/, "").replace(/^ws[a-z0-9]{5}-/, "").split("-").filter(Boolean);
	return segments.length >= 2 && segments.some((segment) => segment.length >= 3);
}
/** `sm-cap-<capability-name>` — stable for one capability registration. */
function skillNameForCapability(name, sharedToken) {
	const slug = kebabCase(name, 32) || "capability";
	return clampName("sm-" + (sharedToken ? sharedToken + "-cap-" : "cap-") + slug);
}
/** Name token that keeps the shared user-level skill dir workspace-isolated. */
function workspaceSkillToken(workspaceKey) {
	return "ws" + shortHash(workspaceKey, 5);
}
/** Parse durable task samples (broken/legacy entries skipped). */
function parseTaskSamples(raw) {
	const out = [];
	for (const entry of raw) try {
		const parsed = JSON.parse(entry);
		if (parsed && Array.isArray(parsed.tools) && Array.isArray(parsed.args)) out.push(parsed);
	} catch {}
	return out;
}
function countMapPush(map, value, max = 160) {
	if (typeof value !== "string") return;
	const text = value.replace(/\s+/g, " ").trim();
	if (!text || text.length > max) return;
	map.set(text, (map.get(text) ?? 0) + 1);
}
function topEntries(map, limit) {
	return [...map.entries()].slice(0, limit).map(([value, count]) => ({
		value,
		count
	}));
}
/** One sample's fact extraction (exported for smoke assertions). */
function workflowFacts(samples) {
	const commands = /* @__PURE__ */ new Map();
	const files = /* @__PURE__ */ new Map();
	const patterns = /* @__PURE__ */ new Map();
	const taskTexts = /* @__PURE__ */ new Set();
	for (const sample of samples) {
		if (typeof sample.task === "string" && sample.task.trim()) {
			const task = sample.task.replace(/\s+/g, " ").trim();
			if (task) taskTexts.add(task.slice(0, 200));
		}
		sample.tools.forEach((tool, index) => {
			const args = sample.args[index] ?? {};
			if (tool === "bash" || tool === "terminal" || tool === "shell") countMapPush(commands, args.command);
			if (tool === "grep" || tool === "glob") countMapPush(patterns, args.pattern, 120);
			if (tool === "read" || tool === "edit" || tool === "write") {
				const path = args.file_path ?? args.path;
				countMapPush(files, path, 200);
			}
		});
	}
	for (const file of extractFileFacts(samples).files) if (!files.has(file)) files.set(file, 1);
	const commandFamilies = extractCommandFamilies(samples).commands;
	const commandEntries = topEntries(commands, 8);
	const fileEntries = topEntries(files, 10);
	return {
		commands: commandEntries.map((entry) => entry.value),
		files: fileEntries.map((entry) => entry.value),
		patterns: topEntries(patterns, 6).map((entry) => entry.value),
		taskTexts: [...taskTexts].slice(-4),
		commandCounts: commandEntries.map((entry) => ({
			command: entry.value,
			count: entry.count
		})),
		fileCounts: fileEntries.map((entry) => ({
			file: entry.value,
			count: entry.count
		})),
		commandFamilies
	};
}
/**
* Routing description: short, specific, "when to load", never a tool order.
* Statistics deliberately stay OUT of the description/body so repeated
* detection of the same facts stays byte-identical (frontmatter occurrences
* carries the counters instead).
*/
function taskSkillDescription(signature, facts) {
	const scope = facts.files.length > 0 ? "涉及 " + facts.files.slice(0, 2).join("、") : signature.commands.length > 0 ? "常用命令 " + signature.commands.slice(0, 2).join("、") : "任务对象 " + signature.objects.join("、");
	return clipDescription("当任务属于「" + signature.title + "」这一类（" + scope + "）时加载：真实步骤、关键坑与验证方式（任务级经验，不是工具序列）。");
}
/** Routing hint for the catalog (frontmatter whenToUse). */
function taskSkillWhenToUse(signature) {
	return "任务文本与对象和「" + signature.title + "」相近时加载；只是工具顺序相同、任务对象不同，不要套用。";
}
function confidenceWord(confidence) {
	if (confidence >= .8) return "高";
	if (confidence >= .6) return "中";
	return "低";
}
function code(text) {
	return "`" + text.replace(/`/g, "\\`") + "`";
}
/**
* Markdown body for one repeated TASK. The six required sections are built
* from recorded commands/files/requests; anything the samples do not justify
* says 「待补充」 instead of inventing a trap or a step.
*/
function renderTaskSkillBody(draft, signature, samples, meta) {
	const facts = workflowFacts(samples);
	const tools = new Set(samples.flatMap((sample) => sample.tools));
	const verification = facts.commands.filter((command) => extractCommandFamilies([{
		tools: ["bash"],
		args: [{ command }]
	}]).commands.some((family) => /typecheck|build|smoke|test|lint|check/i.test(family)));
	const lines = [];
	lines.push("# " + draft.title);
	lines.push("");
	lines.push("> 由 SuperMemory 从重复任务自动沉淀（任务级经验，不是工具序列）。可以手工编辑：再次识别到同一任务时只更新统计，不会覆盖人工修改。");
	lines.push("> 置信度：" + confidenceWord(signature.confidence) + "（样本信息" + (signature.confidence >= .8 ? "充分" : "有限，缺的细节标为「待补充」") + "）。");
	lines.push("");
	lines.push("## 何时用（触发条件）");
	lines.push("");
	lines.push("- 任务属于「" + draft.title + "」这一类" + (facts.files.length > 0 ? "，通常涉及 " + facts.files.slice(0, 3).map(code).join("、") : "") + "。");
	if (facts.taskTexts.length > 0) {
		lines.push("- 历史请求样本（原样截取，用于判断是否同类）：");
		for (const task of facts.taskTexts) lines.push("  - 「" + task.slice(0, 90) + (task.length > 90 ? "…" : "") + "」");
	} else lines.push("- 待补充：样本没有记录任务文本，无法判断触发条件。");
	if (facts.commandFamilies.length > 0) lines.push("- 历史命令家族：" + facts.commandFamilies.slice(0, 5).map(code).join("、") + "。");
	lines.push("- 只是工具顺序相同、任务对象不同（不同仓库/目录/文件族）时不要套用。");
	lines.push("");
	lines.push("## 决策清单");
	lines.push("");
	let step = 1;
	if (facts.files.length > 0) {
		lines.push(step + ". 先核对当前实现/现状：读 " + facts.files.slice(0, 3).map(code).join("、") + "，确认这次改动是否落在同一对象上。");
		step += 1;
	} else {
		lines.push(step + ". 待补充：样本没有记录具体文件；先定位这次任务的真实对象，再决定是否复用。");
		step += 1;
	}
	if (facts.commands.length > 0) {
		lines.push(step + ". 需要执行命令时优先复用历史命令形态：" + facts.commands.slice(0, 3).map(code).join("、") + "；先确认它们对当前目录/分支仍然成立。");
		step += 1;
	} else {
		lines.push(step + ". 待补充：样本没有记录可复用命令。");
		step += 1;
	}
	lines.push(step + ". 中途出现失败或与样本不同的分支时，按「关键坑」停下判断，不要机械跑完整个步骤。");
	step += 1;
	lines.push(step + ". 完成后按「验证方式」核对，并把新发现的坑补进本文件（同名更新会升版并保留 changelog）。");
	lines.push("");
	lines.push("## 步骤纲要");
	lines.push("");
	let outline = 1;
	if (facts.files.length > 0) {
		lines.push(outline + ". 读取/定位：" + facts.files.slice(0, 3).map((file) => code(file)).join("、") + "。");
		outline += 1;
	}
	if (facts.commandCounts.length > 0) {
		lines.push(outline + ". 执行/修改：按历史命令形态推进，样本中的命令：");
		for (const entry of facts.commandCounts.slice(0, 6)) lines.push("   - " + code(entry.command));
		outline += 1;
	}
	if (verification.length > 0) {
		lines.push(outline + ". 验证：" + [...new Set(verification)].slice(0, 4).map(code).join("、") + "。");
		outline += 1;
	}
	if (outline === 1) lines.push("1. 待补充：样本没有记录文件、命令或验证步骤，无法给出可复用纲要。");
	lines.push("");
	lines.push("## 关键坑");
	lines.push("");
	const repeated = facts.commandCounts.filter((entry) => entry.count >= 2);
	for (const entry of repeated.slice(0, 3)) lines.push("- " + code(entry.command) + " 在样本里多次出现：重跑前先确认上一次是否失败/是否幂等，不要为了「重试」重复有副作用的命令。");
	if (tools.has("edit") || tools.has("write")) lines.push("- 样本里有精确编辑：先读目标文件，再只改必要片段，避免整文件覆盖并行改动。");
	if (tools.has("grep") || tools.has("glob")) lines.push("- 检索空结果不等于不存在：换关键词，或直接读目标文件核对。");
	if (repeated.length === 0) lines.push("- 待补充：样本没有记录失败与回退细节，不要臆造具体报错或解决方式。");
	lines.push("- 把 skill 当成免确认的写操作快捷方式：写操作仍需按原流程确认与验证。");
	lines.push("");
	lines.push("## 验证方式");
	lines.push("");
	if (verification.length > 0) lines.push("- 历史样本实际跑过的验证命令：" + [...new Set(verification)].slice(0, 5).map(code).join("、") + "。");
	else lines.push("- 待补充：历史样本没有记录验证命令；按仓库约定跑 typecheck / 相关 smoke 并记录结果。");
	lines.push("- 用可观察结果核对（命令 exit code、文件内容、测试输出），不要凭印象宣称完成。");
	lines.push("");
	lines.push("## 反例（不要这样用）");
	lines.push("");
	lines.push("- 只是工具序列相同（例如同样是 read → edit → bash）但任务对象不同：这不是同一件事，不要加载。");
	lines.push("- 一次性任务、或目标文件/目录族明显不同：按新情况判断，不要套历史步骤。");
	lines.push("- 把 skill 当捷径跳过验证或用户确认：步骤可以复用，闸门不能跳过。");
	lines.push("");
	lines.push("## 调用与命中统计");
	lines.push("");
	lines.push("- 任务出现次数：由插件写入 frontmatter 的 sm-occurrences（面板可见）。");
	lines.push("- 模型加载次数：由插件在调用 skill 工具时累加（面板「设置 → 已生成的 skills」）。");
	lines.push("- 最近识别时间：见 frontmatter 的 sm-updated-at（插件更新，正文不随时间变化）。");
	return lines.join("\n");
}
/** Neutral six-section skeleton for a skill without sampled facts (manual). */
function renderSkillBody(draft) {
	const facts = draft.facts ?? {
		commands: [],
		files: [],
		patterns: []
	};
	const lines = [];
	lines.push("# " + draft.title);
	lines.push("");
	lines.push("> " + (draft.source.kind === "manual" ? "手工登记的 skill。" : "由 SuperMemory 生成的 skill。") + "可以手工编辑：再次识别到同一任务时只更新统计，不会覆盖人工修改。");
	lines.push("");
	lines.push("## 何时用（触发条件）");
	lines.push("");
	lines.push("- " + (draft.description || "待补充：写清什么任务下加载它。"));
	lines.push("");
	lines.push("## 决策清单");
	lines.push("");
	lines.push("1. 待补充：先确认这次任务与 skill 描述是否同类。");
	lines.push("2. 待补充：列出执行前必须核对的事实。");
	lines.push("");
	lines.push("## 步骤纲要");
	lines.push("");
	if (facts.commands.length === 0 && facts.files.length === 0) lines.push("1. 待补充：样本不足，没有可复用的步骤。");
	else {
		let index = 1;
		for (const file of facts.files) lines.push(index++ + ". 读取/定位 " + code(file) + "。");
		for (const command of facts.commands) lines.push(index++ + ". 执行 " + code(command) + "。");
	}
	lines.push("");
	lines.push("## 关键坑");
	lines.push("");
	lines.push("- 待补充：样本不足，未记录失败与回退细节。");
	lines.push("");
	lines.push("## 验证方式");
	lines.push("");
	lines.push("- 待补充：写清可观察的验证命令与预期结果。");
	lines.push("");
	lines.push("## 反例（不要这样用）");
	lines.push("");
	lines.push("- 一次性任务或对象不同：不要套用。");
	return lines.join("\n");
}
/** Full SKILL.md text: YAML frontmatter + body. */
function renderSkillMarkdown(draft, meta) {
	const q = (value) => JSON.stringify(String(value ?? ""));
	return [
		"---",
		"name: " + draft.name,
		"description: " + q(clipDescription(draft.description)),
		...draft.whenToUse ? ["whenToUse: " + q(clipDescription(draft.whenToUse))] : [],
		"disable-model-invocation: " + String(!meta.enabled),
		META.enabled + ": " + String(meta.enabled),
		META.version + ": " + String(meta.version),
		META.updatedAt + ": " + String(meta.updatedAt),
		META.source + ": " + q(draft.source.kind),
		META.occurrences + ": " + String(Math.max(0, draft.source.occurrences)),
		...draft.taskKey ? [META.taskKey + ": " + q(draft.taskKey)] : [],
		META.renderedHash + ": " + q(meta.renderedHash),
		META.changelog + ": " + JSON.stringify(meta.changelog.slice(0, SKILL_CHANGELOG_MAX)),
		"---",
		"",
		draft.body.trim(),
		""
	].join("\n");
}
/** Description clamp shared by the catalog and the panel. */
function clipDescription(text, max = 500) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return flat.slice(0, Math.max(1, max - 1)).replace(/[\s,，;；]\S*$/, "") + "…";
}
/** Parse one SKILL.md (missing/invalid metadata never throws). */
function parseSkillMarkdown(text, fallbackName = "") {
	const raw = String(text ?? "");
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (!match) return void 0;
	const fields = /* @__PURE__ */ new Map();
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const str = (key) => {
		const value = fields.get(key);
		if (value === void 0) return void 0;
		if (value.startsWith("\"")) try {
			return String(JSON.parse(value));
		} catch {
			return value.replace(/^"|"$/g, "");
		}
		return value;
	};
	const num = (key, fallback) => {
		const value = Number(fields.get(key));
		return Number.isFinite(value) ? value : fallback;
	};
	const name = str("name") ?? fallbackName;
	const description = str("description");
	if (!name || !SKILL_NAME_RE.test(name) || description === void 0) return void 0;
	let changelog = [];
	const rawChangelog = fields.get(META.changelog);
	if (rawChangelog) try {
		const parsed = JSON.parse(rawChangelog);
		if (Array.isArray(parsed)) changelog = parsed.map((entry) => String(entry)).slice(0, SKILL_CHANGELOG_MAX);
	} catch {}
	return {
		name,
		description,
		...str("whenToUse") ? { whenToUse: str("whenToUse") } : {},
		enabled: fields.get("disable-model-invocation") !== "true" && fields.get(META.enabled) !== "false",
		version: num(META.version, 1),
		updatedAt: num(META.updatedAt, 0),
		...str(META.source) ? { source: str(META.source) } : {},
		occurrences: num(META.occurrences, 0),
		...str(META.taskKey) ? { taskKey: str(META.taskKey) } : {},
		...str(META.renderedHash) ? { renderedHash: str(META.renderedHash) } : {},
		changelog,
		body: raw.slice(match[0].length).trim()
	};
}
/** Content hash used to detect human edits (body only; metadata excluded). */
function skillContentHash(description, body) {
	return shortHash(description.trim() + "\0" + body.trim(), 8);
}
/** Nearest ancestor containing `.git` (the host's project-root rule). */
function findProjectRoot(cwd) {
	let dir = resolve(cwd);
	for (let depth = 0; depth < 24; depth += 1) {
		try {
			if (existsSync(join(dir, ".git"))) return dir;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
/**
* Resolve the skill root for one workspace.
*
* Priority mirrors the host provider: `<projectRoot>/.dsh/skills` (rank 100) is
* workspace-scoped, so a git workspace needs no name prefix. Without a git
* root the user-level `<dshHome>/skills` is shared by every workspace, so
* generated names carry a workspace token (isolation by namespace).
*/
function resolveSkillRoot(cwd, dshHome) {
	const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const projectRoot = cwd ? findProjectRoot(cwd) : void 0;
	if (projectRoot) return {
		root: join(projectRoot, ".dsh", "skills"),
		scope: "project",
		shared: false,
		note: "项目级 skill 目录（<仓库根>/.dsh/skills，宿主本地发现的最高优先级，按工作区隔离）"
	};
	return {
		root: join(home, "skills"),
		scope: "user",
		shared: true,
		note: "用户级 skill 目录（<DSH_HOME>/skills；无 git 工作区共用，靠 sm-ws<token>- 前缀隔离）"
	};
}
/** Durable row key for one generated skill. */
function skillRowKey(workspaceKey, name) {
	return "ws/" + workspaceKey + "/skill/" + name;
}
/** Recover the task signature stored in one durable task signal. */
function signatureFromSignal(signal, samples) {
	const withTask = [...samples].reverse().find((sample) => typeof sample.task === "string" && sample.task.trim().length >= 6);
	if (!withTask) return void 0;
	const signature = extractTaskSignature({
		task: withTask.task,
		tools: samples.flatMap((sample) => sample.tools),
		args: samples.flatMap((sample) => sample.args)
	});
	if (!signature) return void 0;
	if (signal.pattern.startsWith("task:") && signal.pattern.slice(5) !== signature.key) return void 0;
	return signature;
}
/**
* Build a draft from one repeated TASK signal. The tool sequence in the signal
* is evidence for the body only — the name/description/aggregation all come
* from the task signature.
*/
function draftSkillFromTaskSignal(signal, samples, options = {}) {
	const signature = options.signature ?? signatureFromSignal(signal, samples);
	if (!signature) return void 0;
	const name = skillNameForTask(signature, options.sharedToken);
	if (!isReadableTaskSkillName(name)) return void 0;
	const facts = workflowFacts(samples);
	const occurrences = Math.max(1, signal.count);
	const sessions = Math.max(1, options.sessions ?? signal.sessions?.length ?? 1);
	const description = taskSkillDescription(signature, facts);
	const draft = {
		name,
		title: signature.title,
		description,
		whenToUse: taskSkillWhenToUse(signature),
		tags: [
			"skill",
			"task",
			...signature.keywords
		].slice(0, 8),
		body: "",
		taskKey: signature.key,
		source: {
			kind: "task",
			key: "task/" + signature.key,
			label: signature.title,
			occurrences,
			sessions
		},
		facts: {
			commands: facts.commands,
			files: facts.files,
			patterns: facts.patterns,
			taskTexts: facts.taskTexts,
			commandCounts: facts.commandCounts,
			fileCounts: facts.fileCounts
		}
	};
	draft.body = renderTaskSkillBody(draft, signature, samples, {
		occurrences,
		sessions
	});
	return draft;
}
/** Build a routing skill for a repeated CAPABILITY execution (task type). */
function draftSkillFromCapability(spec, useCount, options = {}) {
	const name = String(spec.name ?? "").trim();
	if (!name) return void 0;
	const title = String(spec.title ?? name);
	const entry = String(spec.entry ?? "").trim();
	const label = title;
	const whenToUse = "再次遇到「" + title + "」类重复事务、且已有能力入口 " + (entry || name) + " 时加载；先预演、再按写操作确认规则实跑。";
	const description = clipDescription("遇到「" + title + "」类重复工作时加载：入口 " + (entry || name) + "、预演/确认规则、关键坑与验证方式（已反复执行）。");
	const facts = {
		commands: entry ? [entry] : [],
		files: [],
		patterns: []
	};
	const body = [
		"# " + title,
		"",
		"> 由 SuperMemory 从重复执行的能力沉淀（已反复执行）。能力本身仍由 sm_composite_* 工具一键执行；本 skill 说明何时优先用它、以及失败时怎么判断。",
		"",
		"## 何时用（触发条件）",
		"",
		"- 任务属于「" + title + "」这一类，且已有能力入口 `" + (entry || name) + "`。",
		"- 需要先看计划、再决定是否真实执行（默认预演）。",
		"",
		"## 决策清单",
		"",
		"1. 先运行能力默认预演（" + (spec.dryRunArg || "若定义") + "），看输出与退出码。",
		"2. " + (spec.writeConfirm ? "真实执行可能写远端/改状态：必须显式 confirm=true；不要绕过确认。" : "确认预演结果符合预期后再实跑。"),
		"3. 连续失败时不要手敲同一串命令绕过能力：用 memory_toolize register 同名更新能力或修订文档（version+1、changelog 记录原因）。",
		"4. 完成后按「验证方式」核对，并把新坑补进 " + (spec.doc || "文档") + "。",
		"",
		"## 步骤纲要",
		"",
		"1. `" + (entry || name) + "` — 入口命令（在 " + (spec.scope || "适用范围") + " 内执行）。",
		"2. 预演 → 确认 → 实跑；失败按「关键坑」处理。",
		"",
		"## 关键坑",
		"",
		"- 能力未生效时先确认当前工作区在适用范围（" + (spec.scope || "未声明") + "）内。",
		"- 预演参数缺失而能力标记了写操作确认时，能力会拒绝预演；这不是故障。",
		"- 不要为了「快」跳过 dry-run 或 confirm 闸门。",
		"",
		"## 验证方式",
		"",
		"- 看能力返回的 exitCode / stdout / stderr，而不是只看「命令似乎跑了」。",
		"- 文档与现状不符时更新 " + (spec.doc || "文档") + " 并升版。",
		"",
		"## 反例（不要这样用）",
		"",
		"- 一次性任务或不同工作区：不要套用本 skill 的入口。",
		"- 能力连续失败仍反复执行：先更新能力定义或文档，不要绕过。",
		"",
		"## 调用与命中统计",
		"",
		"- 能力执行次数：" + Math.max(1, useCount) + "。",
		"- 模型加载次数：由插件在 skill 工具调用时累加。"
	].join("\n");
	return {
		name: skillNameForCapability(name, options.sharedToken),
		title,
		description,
		whenToUse,
		tags: [
			"skill",
			"capability",
			...spec.scope ? [kebabCase(spec.scope, 20)].filter(Boolean) : []
		],
		body,
		facts,
		source: {
			kind: "capability",
			key: "capability/" + name,
			label,
			occurrences: Math.max(1, useCount)
		}
	};
}
/** Distinct sessions/dispatches recorded for one task signal. */
function signalSessionCount(signal, samples = []) {
	const recorded = signal.sessions ?? [];
	if (recorded.length > 0) return recorded.length;
	const fromSamples = samples.map((sample) => sample.sessionId).filter((value) => Boolean(value));
	return new Set(fromSamples).size;
}
/**
* Repeated-TASK detection (R48). Only `task:<signature>` signals qualify:
* legacy `<tool>><tool>` signals are deliberately ignored, which is what stops
* the plugin from regenerating `sm-flow-bash-bash-…` shells after cleanup.
* Capability rows remain a task-level path (sm-cap-*).
*/
function detectRepeatedTransactions(store, workspaceKey, options) {
	const threshold = Math.max(1, options.threshold);
	const capThreshold = Math.max(1, options.capabilityThreshold ?? threshold);
	const minSessions = Math.max(1, options.minSessions ?? 2);
	const now = options.now ?? Date.now();
	const recencyMs = Math.max(0, options.recencyDays ?? 30) * 864e5;
	const existing = options.root ? readSkillFiles(options.root) : [];
	const candidates = [];
	for (const [, signal] of store.signals.entries()) {
		if (signal.workspaceKey !== workspaceKey) continue;
		if (!signal.pattern.startsWith("task:")) continue;
		if (signal.count < threshold) continue;
		if (recencyMs > 0 && now - signal.lastSeen > recencyMs) continue;
		const samples = parseTaskSamples(signal.samples ?? []);
		const sessions = signalSessionCount(signal, samples);
		if (sessions < minSessions) continue;
		const draft = draftSkillFromTaskSignal(signal, samples, {
			...options.sharedToken ? { sharedToken: options.sharedToken } : {},
			sessions
		});
		if (draft) candidates.push(draft);
	}
	for (const [, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite") continue;
		if (record.status !== "active" || record.useCount < capThreshold) continue;
		let spec;
		try {
			spec = JSON.parse(record.entry);
		} catch {
			continue;
		}
		if (spec.kind !== "capability") continue;
		if (record.workspaceKey && record.workspaceKey !== workspaceKey) continue;
		const draft = draftSkillFromCapability(spec, record.useCount, { sharedToken: options.sharedToken });
		if (draft) candidates.push(draft);
	}
	candidates.sort((left, right) => right.source.occurrences - left.source.occurrences);
	const accepted = [];
	const names = new Set(existing.map((entry) => entry.name));
	const tokenOf = (name) => /^sm-(ws[a-z0-9]{5})-/.exec(name)?.[1];
	for (const candidate of candidates) {
		if (candidate.source.kind === "task" && !isReadableTaskSkillName(candidate.name)) continue;
		const candidateToken = tokenOf(candidate.name);
		const byTaskKey = candidate.taskKey ? existing.find((entry) => {
			if (entry.parsed.taskKey !== candidate.taskKey) return false;
			const fileToken = tokenOf(entry.name);
			return !candidateToken || !fileToken || candidateToken === fileToken;
		}) : void 0;
		if (byTaskKey) {
			accepted.push({
				...candidate,
				name: byTaskKey.name
			});
			continue;
		}
		const draft = candidate;
		if (names.has(draft.name)) continue;
		const draftToken = candidateToken;
		if ([...names].some((name) => {
			const otherToken = tokenOf(name);
			if (draftToken && otherToken && draftToken !== otherToken) return false;
			return taskNameSimilarity(name, draft.name) >= .85;
		})) continue;
		names.add(draft.name);
		accepted.push(draft);
	}
	return accepted;
}
/** Read every generated skill bundle under one root. */
function readSkillFiles(root) {
	const out = [];
	if (!existsSync(root)) return out;
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.startsWith("sm-")) continue;
		const dir = join(root, entry);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const file = join(dir, "SKILL.md");
		if (!existsSync(file)) continue;
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const parsed = parseSkillMarkdown(text, entry);
		if (!parsed) continue;
		out.push({
			name: parsed.name,
			path: file,
			parsed
		});
	}
	return out;
}
/** Atomic-ish write: temp file in the same directory, then rename. */
function writeFileAtomic(file, text) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = file + ".tmp-" + process.pid + "-" + Date.now().toString(36);
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}
/** Find one generated skill by name under a root. */
function findSkillFile(root, name) {
	if (!isSkillName(name)) return void 0;
	const file = join(root, name, "SKILL.md");
	if (!existsSync(file)) return void 0;
	try {
		const parsed = parseSkillMarkdown(readFileSync(file, "utf8"), name);
		return parsed ? {
			path: file,
			parsed
		} : void 0;
	} catch {
		return;
	}
}
/**
* Write/update one skill. The FILE is authoritative; the store row only mirrors
* version/useCount/status.
*
* - created: first write, version 1;
* - unchanged: identical description+body → no write, no version bump (幂等);
* - preserved: the current body differs from what we generated last time
*   (human edit) → keep the human body, update statistics only;
* - updated: content changed by a newer draft → version+1 + changelog.
*/
async function persistSkillDraft(store, workspaceKey, draft, options) {
	if (!isSkillName(draft.name)) return {
		status: "error",
		name: draft.name,
		version: 0,
		message: "skill 名不是合法 kebab-case：" + draft.name
	};
	const now = options.now ?? Date.now();
	const key = skillRowKey(workspaceKey, draft.name);
	const row = store.toolMemory.get(key);
	const existing = findSkillFile(options.root, draft.name);
	const body = draft.body.trim();
	const description = clipDescription(draft.description);
	const nextHash = skillContentHash(description, body);
	let version = Math.max(existing?.parsed.version ?? 0, 1);
	let changelog = existing?.parsed.changelog ?? [];
	const useCount = row?.useCount ?? 0;
	const path = join(options.root, draft.name, "SKILL.md");
	if (existing) {
		if (existing.parsed.description === description && existing.parsed.body === body) {
			if (existing.parsed.occurrences !== Math.max(0, draft.source.occurrences)) try {
				writeFileAtomic(path, renderSkillMarkdown({
					...draft,
					description
				}, {
					version,
					updatedAt: now,
					renderedHash: nextHash,
					changelog,
					enabled: existing.parsed.enabled
				}));
			} catch {}
			await putSkillRow(store, key, workspaceKey, draft, path, useCount, version, row?.createdAt ?? now, existing.parsed.enabled ? "active" : "retired");
			return {
				status: "unchanged",
				name: draft.name,
				version,
				path,
				message: "内容相同，未升版。"
			};
		}
		if (Boolean(existing.parsed.renderedHash) && existing.parsed.renderedHash !== skillContentHash(existing.parsed.description, existing.parsed.body)) {
			await putSkillRow(store, key, workspaceKey, {
				...draft,
				description: existing.parsed.description
			}, path, useCount, version, row?.createdAt ?? now, existing.parsed.enabled ? "active" : "retired");
			return {
				status: "preserved",
				name: draft.name,
				version,
				path,
				message: "检测到人工编辑，保留正文，仅更新统计。"
			};
		}
		version += 1;
		changelog = [versionLine(version, options.changelog ?? "重复事务有新样本，刷新生成内容"), ...changelog].slice(0, SKILL_CHANGELOG_MAX);
	} else {
		version = Math.max(1, version);
		changelog = [versionLine(version, options.changelog ?? "首次生成（" + draft.source.label + "，出现 " + draft.source.occurrences + " 次）"), ...changelog].slice(0, SKILL_CHANGELOG_MAX);
	}
	try {
		writeFileAtomic(path, renderSkillMarkdown({
			...draft,
			description
		}, {
			version,
			updatedAt: now,
			renderedHash: nextHash,
			changelog,
			enabled: true
		}));
	} catch (error) {
		return {
			status: "error",
			name: draft.name,
			version,
			path,
			message: "写入 SKILL.md 失败：" + String(error).slice(0, 160)
		};
	}
	await putSkillRow(store, key, workspaceKey, draft, path, useCount, version, row?.createdAt ?? now, "active");
	return {
		status: existing ? "updated" : "created",
		name: draft.name,
		version,
		path,
		message: existing ? "已升版。" : "已生成。"
	};
}
function versionLine(version, note) {
	return "v" + version + ": " + note;
}
/** Upsert the durable mirror row (kind='skill'; never touched by composites). */
async function putSkillRow(store, key, workspaceKey, draft, path, useCount, version, createdAt, status) {
	const row = {
		workspaceKey,
		kind: "skill",
		title: draft.title,
		tags: draft.tags.slice(0, 8),
		trigger: draft.source.key ?? "skill/" + draft.name,
		description: clipDescription(draft.description),
		entry: path,
		useCount,
		status,
		createdAt
	};
	await store.toolMemory.put(key, row);
}
/** Auto-generated files only (manual register never consumes the cap). */
function countAutoSkills(entries, sharedToken) {
	return entries.filter((entry) => entry.parsed.source !== "manual" && (!sharedToken || entry.name.startsWith("sm-" + sharedToken + "-"))).length;
}
/**
* Sync every detected repeated TASK into skill files. Returns the drafts and
* per-draft results; one broken skill never blocks the rest. The per-root cap
* counts AUTO skills only and is checked for NEW names (updates always pass).
*/
async function syncRepeatedTransactions(store, workspaceKey, scope, options) {
	const sharedToken = scope.shared ? workspaceSkillToken(workspaceKey) : void 0;
	const existing = readSkillFiles(scope.root);
	const drafts = detectRepeatedTransactions(store, workspaceKey, {
		threshold: options.threshold,
		...options.capabilityThreshold !== void 0 ? { capabilityThreshold: options.capabilityThreshold } : {},
		...options.minSessions !== void 0 ? { minSessions: options.minSessions } : {},
		...options.recencyDays !== void 0 ? { recencyDays: options.recencyDays } : {},
		...options.now !== void 0 ? { now: options.now } : {},
		...sharedToken ? { sharedToken } : {},
		root: scope.root
	});
	const results = [];
	let fileCount = countAutoSkills(existing, sharedToken);
	for (const draft of drafts) try {
		if (!findSkillFile(scope.root, draft.name)) {
			if (fileCount >= 8) continue;
			fileCount += 1;
		}
		results.push(await persistSkillDraft(store, workspaceKey, draft, {
			root: scope.root,
			...options.now !== void 0 ? { now: options.now } : {}
		}));
	} catch (error) {
		results.push({
			status: "error",
			name: draft.name,
			version: 0,
			message: String(error).slice(0, 160)
		});
	}
	return {
		drafts,
		results
	};
}
/** Durable signal key for one task signature. */
function taskSignalKey(workspaceKey, signatureKey) {
	return "ws/" + workspaceKey + "/task/" + signatureKey;
}
/** Only keep arguments the body can actually use; never store result blobs. */
function compactArgs(args) {
	const out = {};
	for (const key of [
		"command",
		"description",
		"file_path",
		"path",
		"pattern",
		"glob",
		"cwd",
		"query",
		"name"
	]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0 && value.length <= 400) out[key] = value;
	}
	return out;
}
function uniqueCompact(values, cap) {
	const out = [];
	for (const value of values) {
		if (!value || out.includes(value)) continue;
		out.push(value);
	}
	return out.slice(-cap);
}
/**
* Record ONE task occurrence for this workspace. Unlike the old tool-sequence
* counter, the key is `<verb>/<object>` — different tool orders of the same
* task land on the same signal and therefore merge into one skill.
*/
async function recordTaskObservation(store, workspaceKey, observation, options = {}) {
	if (!workspaceKey || workspaceKey === "unknown") return void 0;
	const signature = extractTaskSignature(observation);
	if (!signature) return void 0;
	const now = options.now ?? Date.now();
	const key = signature.key;
	const signalKey = taskSignalKey(workspaceKey, key);
	const existing = store.signals.get(signalKey);
	const sample = {
		tools: observation.tools.slice(0, 60),
		args: observation.args.slice(0, 60).map(compactArgs),
		...observation.task ? { task: observation.task.replace(/\s+/g, " ").slice(0, 2e3) } : {},
		...observation.sessionId ? { sessionId: observation.sessionId } : {},
		...observation.dispatchId ? { dispatchId: observation.dispatchId } : {},
		...observation.topicSetId ? { topicSetId: observation.topicSetId } : {},
		at: now
	};
	const samples = [...existing?.samples ?? [], JSON.stringify(sample)].slice(-5);
	const sessions = uniqueCompact([...existing?.sessions ?? [], observation.sessionId], 20);
	const dispatches = uniqueCompact([...existing?.dispatches ?? [], observation.dispatchId], 10);
	const count = (existing?.count ?? 0) + 1;
	const signal = {
		workspaceKey,
		pattern: "task:" + key,
		count,
		lastSeen: now,
		examples: [...existing?.examples ?? [], signature.title].slice(-3),
		sequence: observation.tools.slice(0, 8),
		samples,
		sessions,
		dispatches
	};
	await store.signals.put(signalKey, signal);
	const threshold = Math.max(1, options.threshold ?? 3);
	const minSessions = Math.max(1, options.minSessions ?? 2);
	return {
		signature,
		key,
		count,
		sessions: sessions.length,
		crossed: count >= threshold && sessions.length >= minSessions
	};
}
/**
* Persist the skill for one crossed task signal (runtime hook + tests).
* Re-runs detection so cap / similarity / recency rules stay in ONE place.
*/
async function persistTaskSkillForSignature(store, workspaceKey, signatureKey, options) {
	if (!workspaceKey || workspaceKey === "unknown") return void 0;
	const scope = options.root ? {
		root: options.root,
		scope: "project",
		shared: Boolean(options.shared),
		note: ""
	} : resolveSkillRoot(workspaceKey);
	const sharedToken = scope.shared ? workspaceSkillToken(workspaceKey) : void 0;
	const draft = detectRepeatedTransactions(store, workspaceKey, {
		threshold: options.threshold,
		...options.minSessions !== void 0 ? { minSessions: options.minSessions } : {},
		...options.recencyDays !== void 0 ? { recencyDays: options.recencyDays } : {},
		...options.now !== void 0 ? { now: options.now } : {},
		...sharedToken ? { sharedToken } : {},
		root: scope.root
	}).find((candidate) => candidate.taskKey === signatureKey);
	if (!draft) return void 0;
	if (!findSkillFile(scope.root, draft.name)) {
		if (countAutoSkills(readSkillFiles(scope.root), sharedToken) >= 8) return void 0;
	}
	return persistSkillDraft(store, workspaceKey, draft, {
		root: scope.root,
		...options.now !== void 0 ? { now: options.now } : {}
	});
}
/**
* Legacy shell detection (R48 cleanup): an auto-generated skill whose NAME or
* DESCRIPTION is just a tool order. Manual/capability skills never qualify.
*/
function isShellSkill(parsed) {
	if (parsed.source !== "sequence") return false;
	if (/^sm-(?:ws[a-z0-9]{5}-)?flow(?:-|$)/.test(parsed.name)) return true;
	const description = String(parsed.description ?? "");
	return /当任务需要按/.test(description) && /的顺序反复处理同类改动/.test(description);
}
/** Archive directory is a SIBLING of the skill root: <root>-archive. */
function archiveDirForRoot(root) {
	return root + "-archive";
}
function readArchiveManifest(file) {
	if (!existsSync(file)) return {
		version: 1,
		entries: []
	};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && Array.isArray(parsed.entries)) return {
			version: 1,
			entries: parsed.entries
		};
	} catch {}
	return {
		version: 1,
		entries: []
	};
}
/**
* Archive auto-generated tool-sequence shells under every given root.
*
* - moves `<root>/<name>` to `<root>-archive/<name>` (never deletes);
* - appends a manifest entry (name/time/reason/version/description/from);
* - retires the mirror tool_memory row when a store is supplied;
* - IDEMPOTENT: a second run finds no shell skills and archives 0.
*/
async function archiveShellSkills(options) {
	const now = options.now ?? Date.now();
	const dryRun = Boolean(options.dryRun);
	const archived = [];
	const rootReports = [];
	let totalScanned = 0;
	for (const root of [...new Set(options.roots)]) {
		const entries = readSkillFiles(root);
		const report = {
			root,
			scanned: entries.length,
			archived: 0,
			skippedManual: 0,
			skippedOther: 0
		};
		totalScanned += entries.length;
		const archiveDir = archiveDirForRoot(root);
		const toArchive = [];
		for (const entry of entries) {
			if (!isShellSkill(entry.parsed)) {
				if (entry.parsed.source === "manual") report.skippedManual += 1;
				else report.skippedOther += 1;
				continue;
			}
			toArchive.push({
				name: entry.name,
				parsed: entry.parsed,
				from: dirname(entry.path)
			});
		}
		if (toArchive.length === 0) {
			rootReports.push(report);
			continue;
		}
		if (!dryRun) mkdirSync(archiveDir, { recursive: true });
		const manifestFile = join(archiveDir, "manifest.json");
		const manifest = readArchiveManifest(manifestFile);
		for (const item of toArchive) {
			let target = join(archiveDir, item.name);
			if (existsSync(target)) target = join(archiveDir, item.name + "-dup-" + shortHash(root + ":" + now + ":" + item.name, 4));
			if (!dryRun) try {
				renameSync(item.from, target);
			} catch {
				report.skippedOther += 1;
				continue;
			}
			const record = {
				root,
				name: item.name,
				from: item.from,
				archivePath: target,
				version: item.parsed.version,
				description: item.parsed.description,
				archivedAt: now,
				reason: "自动生成的工具序列壳子（R48 清理：归档保留，可回滚）"
			};
			archived.push(record);
			report.archived += 1;
			manifest.entries.push({
				name: record.name,
				archivePath: record.archivePath,
				version: record.version,
				description: record.description,
				archivedAt: record.archivedAt,
				reason: record.reason,
				from: record.from
			});
			if (options.store !== void 0) await retireSkillRow(options.store, item.from);
		}
		if (!dryRun && manifest.entries.length > 0) try {
			writeFileAtomic(manifestFile, JSON.stringify({
				version: 1,
				entries: manifest.entries.slice(-500)
			}, null, 2));
		} catch {}
		rootReports.push(report);
	}
	return {
		archived,
		roots: rootReports,
		totalScanned,
		totalArchived: archived.length,
		dryRun
	};
}
/** Retire the durable mirror row of an archived skill (best effort). */
async function retireSkillRow(store, fromDir) {
	const marker = normalizeDir(fromDir) + "/";
	for (const [key, row] of store.toolMemory.entries()) {
		if (row.kind !== "skill") continue;
		const entry = normalizeDir(row.entry);
		if (entry !== normalizeDir(join(fromDir, "SKILL.md")) && !entry.startsWith(marker)) continue;
		try {
			await store.toolMemory.update(key, (record) => ({
				...record,
				status: "retired"
			}));
		} catch {}
	}
}
function normalizeDir(path) {
	return resolve(String(path ?? "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
/**
* Every skill root this machine is likely to have used: <DSH_HOME>/skills plus
* `<project>/.dsh/skills` for every workspace key found in the store and the
* caller's cwd. Missing roots are ignored.
*/
function discoverSkillRoots(options = {}) {
	const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const workspaces = /* @__PURE__ */ new Set();
	if (options.cwd) workspaces.add(resolve(options.cwd));
	for (const workspace of options.workspaces ?? []) if (workspace) workspaces.add(workspace);
	const store = options.store;
	if (store) for (const table of [
		"memories",
		"signals",
		"toolMemory",
		"filemap",
		"topicsets"
	]) {
		const handle = store[table];
		if (!handle || typeof handle.entries !== "function") continue;
		try {
			for (const [, row] of handle.entries()) {
				const workspaceKey = row?.workspaceKey;
				if (typeof workspaceKey === "string" && workspaceKey.length > 0) workspaces.add(workspaceKey);
			}
		} catch {}
	}
	const roots = /* @__PURE__ */ new Set();
	roots.add(join(dshHome, "skills"));
	for (const workspace of workspaces) {
		const projectRoot = findProjectRoot(workspace) ?? (existsSync(join(workspace, ".git")) ? workspace : void 0);
		if (projectRoot) roots.add(join(projectRoot, ".dsh", "skills"));
	}
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const root of roots) {
		let key;
		try {
			key = normalizeDir(root);
		} catch {
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			if (existsSync(root) && statSync(root).isDirectory()) out.push(root);
		} catch {}
	}
	return out.sort();
}
/** List generated skills of one workspace (files first, store row overlaid). */
function listSkills(store, workspaceKey, scope) {
	const token = scope.shared ? workspaceSkillToken(workspaceKey) : void 0;
	const views = [];
	for (const entry of readSkillFiles(scope.root)) {
		if (token && !entry.name.startsWith("sm-" + token + "-")) continue;
		const key = skillRowKey(workspaceKey, entry.name);
		const row = store.toolMemory.get(key);
		views.push({
			name: entry.parsed.name,
			title: row?.title || entry.parsed.name,
			description: entry.parsed.description,
			...entry.parsed.whenToUse ? { whenToUse: entry.parsed.whenToUse } : {},
			version: entry.parsed.version,
			useCount: row?.useCount ?? 0,
			enabled: entry.parsed.enabled,
			status: row?.status === "retired" ? "retired" : "active",
			path: entry.path,
			...entry.parsed.source ? { source: entry.parsed.source } : {},
			occurrences: entry.parsed.occurrences,
			updatedAt: entry.parsed.updatedAt,
			changelog: entry.parsed.changelog
		});
	}
	return views.sort((left, right) => left.name.localeCompare(right.name));
}
/** Rewrite one file's frontmatter in place (body preserved). */
function rewriteFrontmatter(file, parsed, patch) {
	const version = parsed.version + 1;
	const changelog = [versionLine(version, patch.changelogLine ?? "更新 skill 元数据"), ...parsed.changelog].slice(0, SKILL_CHANGELOG_MAX);
	const description = clipDescription(patch.description ?? parsed.description);
	const renderedHash = parsed.renderedHash ?? skillContentHash(description, parsed.body);
	const text = renderSkillMarkdown({
		name: parsed.name,
		title: parsed.name,
		description,
		...patch.whenToUse ?? parsed.whenToUse ? { whenToUse: patch.whenToUse ?? parsed.whenToUse } : {},
		tags: [],
		body: parsed.body,
		...parsed.taskKey ? { taskKey: parsed.taskKey } : {},
		source: {
			kind: parsed.source ?? "manual",
			label: parsed.source ?? "manual",
			occurrences: parsed.occurrences
		}
	}, {
		version,
		updatedAt: Date.now(),
		renderedHash,
		changelog,
		enabled: patch.enabled ?? parsed.enabled
	});
	writeFileAtomic(file, text);
	const reparsed = parseSkillMarkdown(text, parsed.name);
	if (!reparsed) throw new Error("回写后的 SKILL.md 解析失败");
	return reparsed;
}
/** Enable/disable one generated skill (host honors disable-model-invocation). */
async function setSkillEnabled(store, workspaceKey, scope, name, enabled) {
	if (!isSkillName(name)) return {
		status: "error",
		name,
		version: 0,
		message: "skill 名不合法：" + name
	};
	const found = findSkillFile(scope.root, name);
	if (!found) return {
		status: "error",
		name,
		version: 0,
		message: "找不到该 skill 文件：" + name
	};
	try {
		const parsed = rewriteFrontmatter(found.path, found.parsed, {
			enabled,
			changelogLine: enabled ? "启用（模型可见）" : "停用（模型不可见）"
		});
		const key = skillRowKey(workspaceKey, name);
		if (store.toolMemory.get(key)) await store.toolMemory.update(key, (record) => ({
			...record,
			status: enabled ? "active" : "retired"
		}));
		return {
			status: "updated",
			name,
			version: parsed.version,
			path: found.path,
			message: enabled ? "已启用。" : "已停用。"
		};
	} catch (error) {
		return {
			status: "error",
			name,
			version: 0,
			message: "更新失败：" + String(error).slice(0, 160)
		};
	}
}
/** Update the routing description of one generated skill. */
async function updateSkillDescription(store, workspaceKey, scope, name, description) {
	if (!isSkillName(name)) return {
		status: "error",
		name,
		version: 0,
		message: "skill 名不合法：" + name
	};
	const found = findSkillFile(scope.root, name);
	if (!found) return {
		status: "error",
		name,
		version: 0,
		message: "找不到该 skill 文件：" + name
	};
	try {
		const parsed = rewriteFrontmatter(found.path, found.parsed, {
			description,
			changelogLine: "更新路由描述（description）"
		});
		const key = skillRowKey(workspaceKey, name);
		if (store.toolMemory.get(key)) await store.toolMemory.update(key, (record) => ({
			...record,
			description: parsed.description
		}));
		return {
			status: "updated",
			name,
			version: parsed.version,
			path: found.path,
			message: "描述已更新。"
		};
	} catch (error) {
		return {
			status: "error",
			name,
			version: 0,
			message: "更新失败：" + String(error).slice(0, 160)
		};
	}
}
/**
* Count one model-side skill load (called from the tools/post-execute hook when
* the `skill` tool runs with one of our names). Best-effort.
*/
async function bumpSkillUse(store, workspaceKey, name) {
	const key = skillRowKey(workspaceKey, name);
	const row = store.toolMemory.get(key);
	if (!row || row.kind !== "skill") return false;
	await store.toolMemory.update(key, (record) => ({
		...record,
		useCount: record.useCount + 1
	}));
	return true;
}
/**
* Build one manual skill draft from memory_toolize.register. The body is the
* caller's guidance; when absent, a skeleton with the required sections is
* produced so the file is still a usable skill rather than an empty stub.
*/
function draftSkillFromManual(input, options = {}) {
	const slug = kebabCase(input.name.replace(/^sm-/, ""), 32) || "skill";
	const name = clampName("sm-" + (options.sharedToken ? options.sharedToken + "-" : "") + slug);
	const title = String(input.title ?? "").trim() || input.name;
	const description = clipDescription(input.description);
	const body = String(input.body ?? "").trim();
	const facts = {
		commands: [],
		files: [],
		patterns: []
	};
	return {
		name,
		title,
		description,
		...input.whenToUse ? { whenToUse: clipDescription(input.whenToUse) } : {},
		tags: (input.tags && input.tags.length > 0 ? input.tags : ["skill", "manual"]).slice(0, 8),
		body: body || renderSkillBody({
			name,
			title,
			description,
			tags: [],
			body: "",
			source: {
				kind: "manual",
				label: "手工登记",
				occurrences: 1
			},
			facts
		}),
		source: {
			kind: "manual",
			label: "手工登记",
			occurrences: 1
		},
		facts
	};
}
export { resolveSkillRoot as a, updateSkillDescription as c, recordTaskObservation as i, listSkills as n, setSkillEnabled as o, persistTaskSkillForSignature as r, skill_forge_exports as s, archiveShellSkills as t };
