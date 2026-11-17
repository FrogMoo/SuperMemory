window.__ModuleLoader__.load({id:"dsh-supermemory",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
// src/client/remote.ts
/**
* Client half of the SuperMemory panel wire contract. Mirrors the host-side
* PANEL_DESCRIPTORS in src/panel.ts (registered through
* ctx.get('typert').register with face 'host'); mounted here so the browser can call the
* panel service. The id set must stay identical on both halves —
* scripts/mechanism-smoke.mjs asserts that parity.
* Shape follows the dsh-ops runtime-host pattern ({package, descriptors}).
* @module supermemory/client/remote
*/
/** Passthrough codec: values are plain JSON produced by the host service. */
const jsonCodec = (symbol) => ({
	mode: "strict",
	typeSymbol: `dsh-supermemory#${symbol}`,
	create: () => ({ parse: (value) => value })
});
const param = (name, optional = false) => ({
	name,
	wire: name,
	source: "json",
	...optional ? { acceptsUndefined: true } : {},
	codec: jsonCodec(name)
});
const method = (name, parameters = []) => ({
	id: `dsh-supermemory#supermemoryPanel/${name}`,
	service: "supermemoryPanel",
	namespace: "supermemoryPanel",
	method: name,
	invocation: { kind: "direct" },
	result: jsonCodec(`${name}:result`),
	parameters
});
/** The mountable contribution for `ctx.remote.$mount`. */
const PANEL_REMOTE = Object.freeze({
	package: "dsh-supermemory",
	descriptors: Object.freeze([
		method("listTopicSets", [param("cwd")]),
		method("activate", [param("sessionId"), param("topicSetId")]),
		method("activeTopicSet", [param("sessionId")]),
		method("hubState", [param("cwd"), param("sessionId")]),
		method("listMemories", [
			param("cwd"),
			param("query", true),
			param("limit", true)
		]),
		method("createMemory", [
			param("cwd"),
			param("text"),
			param("key", true)
		]),
		method("updateMemory", [
			param("cwd"),
			param("id"),
			param("text"),
			param("key", true)
		]),
		method("deleteMemory", [param("cwd"), param("id")]),
		method("setMemoryStatus", [
			param("cwd"),
			param("id"),
			param("status")
		]),
		method("createTopicSet", [param("cwd"), param("title")]),
		method("updateTopicSetSummary", [param("id"), param("summary")]),
		method("createTopicSetSession", [param("cwd"), param("topicSetIds")]),
		method("followupTopicSet", [
			param("cwd"),
			param("topicSetId"),
			param("text")
		]),
		method("listTools", []),
		method("editTool", [param("id"), param("patch")]),
		method("sessionBadge", [param("sessionId")])
	])
});
// src/client/locales.ts
/** SuperMemory panel dictionaries (namespace `supermemory`). */
const NS = "supermemory";
const zh = {
	"panel": "超级记忆",
	"panel.title": "超级记忆",
	"tab.hub": "中枢会话",
	"tab.memories": "记忆",
	"tab.tools": "组合工具",
	"hub.current": "当前会话",
	"hub.active": "活跃话题集",
	"hub.none": "（未激活）",
	"hub.activate": "激活",
	"hub.topicSets": "话题集",
	"hub.empty": "当前工作区还没有话题集。",
	"hub.counts": "记忆 {memories} · 需求 {requirements} · 梗概 {episodes} · 进行中派发 {dispatches}",
	"hub.refresh": "刷新",
	"hub.openSession": "打开会话",
	"topic.members": "分支会话",
	"topic.noMembers": "（暂无分支会话）",
	"topic.reply": "回复到话题集",
	"topic.reply.placeholder": "输入要送入话题集分支的内容…",
	"topic.reply.send": "发送",
	"topic.summary": "梗概",
	"topic.summary.save": "保存梗概",
	"topic.create": "新建话题集",
	"topic.create.placeholder": "新话题集标题",
	"topic.back": "返回中枢",
	"memory.search": "搜索记忆…",
	"memory.new": "新增记忆",
	"memory.new.placeholder": "要记住的事实（简洁自包含）",
	"memory.add": "记住",
	"memory.empty": "（没有匹配的记忆）",
	"memory.locate": "定位会话",
	"memory.edit": "编辑",
	"memory.save": "保存",
	"memory.cancel": "取消",
	"memory.delete": "删除",
	"memory.disable": "停用",
	"memory.enable": "启用",
	"memory.status": "状态",
	"memory.source": "来源会话",
	"tool.empty": "（暂无组合工具；重复流程出现 3 次后会提议固化）",
	"tool.steps": "步骤",
	"tool.params": "参数",
	"tool.uses": "使用次数",
	"tool.live": "已注册",
	"tool.offline": "未注册",
	"tool.retire": "停用",
	"tool.desc.save": "保存简介",
	"tool.desc.edit": "编辑简介",
	"newSession.title": "新建会话",
	"newSession.hub": "中枢会话",
	"newSession.hub.desc": "普通新对话（默认行为）",
	"newSession.topic": "话题集会话",
	"newSession.topic.desc": "绑定到选定话题集的新对话",
	"newSession.pick": "选择话题集（可多选）",
	"newSession.create": "新建话题集…",
	"newSession.start": "开始",
	"newSession.cancel": "取消",
	"badge.branch": "分支",
	"badge.tip": "话题集分支 · {title}",
	"error.load": "加载失败",
	"error.retry": "重试",
	"error.generic": "操作失败",
	"ok.saved": "已保存"
};
const en = {
	"panel": "SuperMemory",
	"panel.title": "SuperMemory",
	"tab.hub": "Hub session",
	"tab.memories": "Memories",
	"tab.tools": "Composite tools",
	"hub.current": "Current session",
	"hub.active": "Active topic set",
	"hub.none": "(none)",
	"hub.activate": "Activate",
	"hub.topicSets": "Topic sets",
	"hub.empty": "No topic sets in this workspace yet.",
	"hub.counts": "{memories} memories · {requirements} requirements · {episodes} episodes · {dispatches} running dispatches",
	"hub.refresh": "Refresh",
	"hub.openSession": "Open session",
	"topic.members": "Branch sessions",
	"topic.noMembers": "(no branch sessions)",
	"topic.reply": "Reply into topic set",
	"topic.reply.placeholder": "Text to deliver to the topic-set branch…",
	"topic.reply.send": "Send",
	"topic.summary": "Summary",
	"topic.summary.save": "Save summary",
	"topic.create": "New topic set",
	"topic.create.placeholder": "New topic set title",
	"topic.back": "Back to hub",
	"memory.search": "Search memories…",
	"memory.new": "New memory",
	"memory.new.placeholder": "Fact to remember (concise, self-contained)",
	"memory.add": "Remember",
	"memory.empty": "(no matching memories)",
	"memory.locate": "Locate session",
	"memory.edit": "Edit",
	"memory.save": "Save",
	"memory.cancel": "Cancel",
	"memory.delete": "Delete",
	"memory.disable": "Disable",
	"memory.enable": "Enable",
	"memory.status": "Status",
	"memory.source": "Source session",
	"tool.empty": "(no composite tools; a repeated flow is proposed after 3 occurrences)",
	"tool.steps": "Steps",
	"tool.params": "Parameters",
	"tool.uses": "Uses",
	"tool.live": "registered",
	"tool.offline": "not registered",
	"tool.retire": "Retire",
	"tool.desc.save": "Save description",
	"tool.desc.edit": "Edit description",
	"newSession.title": "New session",
	"newSession.hub": "Hub session",
	"newSession.hub.desc": "Plain new conversation (default)",
	"newSession.topic": "Topic-set session",
	"newSession.topic.desc": "New conversation bound to the selected topic sets",
	"newSession.pick": "Pick topic sets (multi-select)",
	"newSession.create": "New topic set…",
	"newSession.start": "Start",
	"newSession.cancel": "Cancel",
	"badge.branch": "Branch",
	"badge.tip": "Topic-set branch · {title}",
	"error.load": "Load failed",
	"error.retry": "Retry",
	"error.generic": "Operation failed",
	"ok.saved": "Saved"
};
// src/client/icon.tsx
/** Decorative glyph for the SuperMemory sidebar panel row. */
/**
* Render the SuperMemory mark at the size the sidebar asks for.
* @param props - the sidebar's icon share: requested edge and active state.
* @returns decorative inline SVG.
*/
function SupermemoryIcon(props) {
	const size = props.size ?? 18;
	const stroke = props.active ? "currentColor" : "currentColor";
	return (0, react.createElement)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke,
		strokeWidth: 1.6,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
		focusable: false
	}, (0, react.createElement)("path", {
		key: "a",
		d: "M12 3a7 7 0 0 0-7 7c0 1.6.5 3 1.4 4.2L12 21l5.6-6.8A7 7 0 0 0 12 3z"
	}), (0, react.createElement)("path", {
		key: "b",
		d: "M9.5 10.5a2.5 2.5 0 1 1 3.4 2.33c-.78.35-1.4 1-1.4 1.92"
	}), (0, react.createElement)("circle", {
		key: "c",
		cx: 11.5,
		cy: 16.4,
		r: .4,
		fill: stroke,
		stroke: "none"
	}));
}
// src/client/panel-page.tsx
/**
* SuperMemory main panel (the `main` slot keyed by panel id 'supermemory').
* Level 1 shows the hub session and the workspace's topic sets; level 2
* opens one topic set (its branch sessions, reply box and summary); the
* Memories tab browses/edits memories and locates their source sessions;
* the Tools tab lists and edits composite tools (R6).
* @module supermemory/client/panel-page
*/
const PANEL_CSS = `
.sm-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsh-color-text,#e8e8ea);background:var(--dsh-color-bg,#17171a);font-size:13px}
.sm-panel *{box-sizing:border-box}
.sm-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsh-color-border,#2c2c31)}
.sm-head h1{font-size:15px;margin:0;font-weight:600}
.sm-counts{margin-left:auto;opacity:.65;font-size:11px}
.sm-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--dsh-color-border,#2c2c31)}
.sm-tab{padding:6px 12px;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;border-radius:6px 6px 0 0;font-size:12px}
.sm-tab[data-active="true"]{opacity:1;background:var(--dsh-color-bg-soft,#1f1f24);font-weight:600}
.sm-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.sm-card{border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--dsh-color-bg-soft,#1c1c20)}
.sm-card h3{margin:0 0 4px;font-size:13px}
.sm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sm-muted{opacity:.6;font-size:11px}
.sm-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#222228);color:inherit;cursor:pointer;font-size:12px}
.sm-btn:hover{border-color:var(--dsh-color-primary,#5b8def)}
.sm-btn[data-variant="primary"]{background:var(--dsh-color-primary,#3d6fd8);border-color:transparent;color:#fff}
.sm-btn[data-variant="danger"]{border-color:#a8443c;color:#e0736a}
.sm-btn:disabled{opacity:.45;cursor:default}
.sm-input{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#121215);color:inherit;font-size:12px;font-family:inherit}
.sm-textarea{width:100%;min-height:56px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#121215);color:inherit;font-size:12px;font-family:inherit;resize:vertical}
.sm-list{display:flex;flex-direction:column;gap:6px}
.sm-item{border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;padding:8px 10px;background:var(--dsh-color-bg-soft,#1c1c20)}
.sm-item[data-clickable="true"]{cursor:pointer}
.sm-item[data-clickable="true"]:hover{border-color:var(--dsh-color-primary,#5b8def)}
.sm-item .sm-title{font-weight:600;font-size:12.5px}
.sm-item .sm-sub{opacity:.6;font-size:11px;margin-top:2px;word-break:break-all}
.sm-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.sm-error{color:#e0736a;font-size:12px;padding:8px 0}
.sm-ok{color:#6fbf73;font-size:12px;padding:4px 0}
.sm-badge{display:inline-block;padding:1px 6px;border-radius:99px;font-size:10px;border:1px solid var(--dsh-color-border,#3a3a42);opacity:.8;margin-right:4px}
.sm-empty{opacity:.55;padding:16px 0;text-align:center}
.sm-form{display:flex;gap:6px;margin-bottom:10px}
.sm-form .sm-input{flex:1}
.sm-back{margin-bottom:8px}
`;
let cssInstalled$2 = false;
function installCss$2() {
	if (cssInstalled$2 || typeof document === "undefined") return;
	cssInstalled$2 = true;
	const style = document.createElement("style");
	style.setAttribute("data-plugin", "dsh-supermemory");
	style.textContent = PANEL_CSS;
	document.head.append(style);
}
function Button(props) {
	return (0, react.createElement)("button", {
		type: "button",
		className: "sm-btn",
		"data-variant": props.variant,
		disabled: props.disabled,
		title: props.title,
		onClick: props.onClick
	}, props.label);
}
/** The SuperMemory main panel page. */
function SupermemoryPanelPage(props) {
	installCss$2();
	const { t, api } = props;
	const [view, setView] = (0, react.useState)({ kind: "hub" });
	const [hub, setHub] = (0, react.useState)();
	const [memories, setMemories] = (0, react.useState)([]);
	const [tools, setTools] = (0, react.useState)([]);
	const [loading, setLoading] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)();
	const [notice, setNotice] = (0, react.useState)();
	const [query, setQuery] = (0, react.useState)("");
	const [newMemory, setNewMemory] = (0, react.useState)("");
	const [newTopicTitle, setNewTopicTitle] = (0, react.useState)("");
	const [reply, setReply] = (0, react.useState)("");
	const [summaryDraft, setSummaryDraft] = (0, react.useState)();
	const [editingMemory, setEditingMemory] = (0, react.useState)();
	const [editingTool, setEditingTool] = (0, react.useState)();
	const workspaces = props.useWorkspaces((state) => state.items);
	const sessionId = props.useSessions((state) => {
		for (const session of Object.values(state.byId)) if ((session.retainedBy?.mainView ?? 0) > 0) return session.id;
		return "";
	});
	const sessionCwd = props.useSessions((state) => {
		for (const session of Object.values(state.byId)) if ((session.retainedBy?.mainView ?? 0) > 0) return String(session.header?.cwd ?? "");
		return "";
	});
	const cwd = (0, react.useMemo)(() => sessionCwd || workspaces[0]?.path || "", [sessionCwd, workspaces]);
	const refreshHub = (0, react.useCallback)(async () => {
		if (!cwd) return;
		setLoading(true);
		setError(void 0);
		try {
			const state = await api.loadHub(cwd, sessionId);
			setHub(state);
			setMemories(state.memories);
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		} finally {
			setLoading(false);
		}
	}, [
		api,
		cwd,
		sessionId,
		t
	]);
	const refreshMemories = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			setMemories(await api.listMemories(cwd, query.trim() || void 0));
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		query,
		t
	]);
	const refreshTools = (0, react.useCallback)(async () => {
		try {
			setTools(await api.listTools());
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [api, t]);
	(0, react.useEffect)(() => {
		refreshHub();
	}, [refreshHub]);
	(0, react.useEffect)(() => {
		if (view.kind === "memories") refreshMemories();
	}, [view, refreshMemories]);
	(0, react.useEffect)(() => {
		if (view.kind === "tools") refreshTools();
	}, [view, refreshTools]);
	const activeTopicSet = hub?.topicSets.find((topicSet) => topicSet.id === hub.activeTopicSetId);
	const currentTopicSet = view.kind === "topic" ? hub?.topicSets.find((topicSet) => topicSet.id === view.id) : void 0;
	const run = async (action, after) => {
		setNotice(void 0);
		setError(void 0);
		try {
			const result = await action();
			if (result === true) {
				setNotice(t("ok.saved"));
				after?.();
				return;
			}
			if (result && result.status === "ok") setNotice(result.message);
			else if (result) setError(result.message);
			after?.();
		} catch (actionError) {
			setError(`${t("error.generic")}: ${String(actionError instanceof Error ? actionError.message : actionError)}`);
		}
	};
	const tabProps = (kind) => ({
		"data-active": String(view.kind === kind),
		className: "sm-tab",
		onClick: () => setView(kind === "hub" ? { kind: "hub" } : kind === "memories" ? { kind: "memories" } : kind === "tools" ? { kind: "tools" } : { kind: "hub" })
	});
	const hubView = [
		(0, react.createElement)("div", {
			key: "current",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, t("hub.current")), (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-muted" }, sessionId || "—"), (0, react.createElement)(Button, {
			key: "refresh",
			label: t("hub.refresh"),
			onClick: () => void refreshHub()
		})), (0, react.createElement)("div", {
			className: "sm-row",
			style: { marginTop: 6 }
		}, (0, react.createElement)("span", { className: "sm-muted" }, `${t("hub.active")}：`), activeTopicSet ? (0, react.createElement)(Button, {
			key: "open",
			label: activeTopicSet.title,
			onClick: () => setView({
				kind: "topic",
				id: activeTopicSet.id
			})
		}) : (0, react.createElement)("span", { className: "sm-muted" }, t("hub.none")))),
		(0, react.createElement)("div", {
			key: "new",
			className: "sm-form"
		}, (0, react.createElement)("input", {
			key: "input",
			className: "sm-input",
			value: newTopicTitle,
			placeholder: t("topic.create.placeholder"),
			onChange: (event) => setNewTopicTitle(event.target.value)
		}), (0, react.createElement)(Button, {
			key: "add",
			variant: "primary",
			label: t("topic.create"),
			disabled: !newTopicTitle.trim(),
			onClick: () => void run(async () => api.createTopicSet(cwd, newTopicTitle.trim()), () => {
				setNewTopicTitle("");
				refreshHub();
			})
		})),
		(0, react.createElement)("div", {
			key: "list",
			className: "sm-list"
		}, (hub?.topicSets ?? []).length === 0 ? (0, react.createElement)("div", {
			key: "empty",
			className: "sm-empty"
		}, t("hub.empty")) : (hub?.topicSets ?? []).map((topicSet) => (0, react.createElement)("div", {
			key: topicSet.id,
			className: "sm-item",
			"data-clickable": "true",
			onClick: () => {
				setView({
					kind: "topic",
					id: topicSet.id
				});
				setSummaryDraft(void 0);
				setReply("");
			}
		}, (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-title" }, topicSet.title), hub?.activeTopicSetId === topicSet.id ? (0, react.createElement)("span", {
			key: "b",
			className: "sm-badge"
		}, t("hub.active")) : null, topicSet.model ? (0, react.createElement)("span", {
			key: "m",
			className: "sm-badge"
		}, topicSet.model) : null), (0, react.createElement)("div", { className: "sm-sub" }, topicSet.summary || "—"), (0, react.createElement)("div", { className: "sm-sub" }, `${t("topic.members")}：${topicSet.branches.length}`), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
			key: "act",
			label: t("hub.activate"),
			onClick: (event) => {
				event.stopPropagation();
				run(async () => api.activate(sessionId, topicSet.id), () => void refreshHub());
			}
		})))))
	];
	const topicView = currentTopicSet ? [
		(0, react.createElement)(Button, {
			key: "back",
			className: "sm-back",
			label: t("topic.back"),
			onClick: () => setView({ kind: "hub" })
		}),
		(0, react.createElement)("div", {
			key: "card",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, currentTopicSet.title), (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)(Button, {
			key: "act",
			variant: "primary",
			label: t("hub.activate"),
			onClick: () => void run(async () => api.activate(sessionId, currentTopicSet.id), () => void refreshHub())
		}), currentTopicSet.model ? (0, react.createElement)("span", {
			key: "m",
			className: "sm-badge"
		}, currentTopicSet.model) : null)),
		(0, react.createElement)("div", {
			key: "members",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, t("topic.members")), currentTopicSet.branches.length === 0 ? (0, react.createElement)("div", { className: "sm-empty" }, t("topic.noMembers")) : (0, react.createElement)("div", { className: "sm-list" }, currentTopicSet.branches.map((branch) => (0, react.createElement)("div", {
			key: branch.sessionId,
			className: "sm-item",
			"data-clickable": "true",
			onClick: () => api.openSession(branch.sessionId)
		}, (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-title" }, branch.title || branch.sessionId.slice(0, 12)), (0, react.createElement)("span", {
			key: "s",
			className: "sm-badge"
		}, branch.status), branch.model ? (0, react.createElement)("span", {
			key: "m",
			className: "sm-badge"
		}, branch.model) : null), (0, react.createElement)("div", { className: "sm-sub" }, branch.sessionId))))),
		(0, react.createElement)("div", {
			key: "reply",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, t("topic.reply")), (0, react.createElement)("textarea", {
			key: "input",
			className: "sm-textarea",
			value: reply,
			placeholder: t("topic.reply.placeholder"),
			onChange: (event) => setReply(event.target.value)
		}), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
			key: "send",
			variant: "primary",
			label: t("topic.reply.send"),
			disabled: !reply.trim(),
			onClick: () => void run(async () => api.followupTopicSet(cwd, currentTopicSet.id, reply.trim()), () => {
				hub?.topicSets.find((topicSet) => topicSet.id === currentTopicSet.id);
				setReply("");
			})
		}))),
		(0, react.createElement)("div", {
			key: "summary",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, t("topic.summary")), (0, react.createElement)("textarea", {
			key: "input",
			className: "sm-textarea",
			value: summaryDraft ?? currentTopicSet.summary,
			onChange: (event) => setSummaryDraft(event.target.value)
		}), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
			key: "save",
			label: t("topic.summary.save"),
			onClick: () => void run(async () => api.updateTopicSetSummary(currentTopicSet.id, (summaryDraft ?? currentTopicSet.summary).slice(0, 500)), () => {
				setSummaryDraft(void 0);
				refreshHub();
			})
		})))
	] : (0, react.createElement)("div", {
		key: "missing",
		className: "sm-empty"
	}, t("hub.empty"));
	const memoriesView = [
		(0, react.createElement)("div", {
			key: "search",
			className: "sm-form"
		}, (0, react.createElement)("input", {
			key: "input",
			className: "sm-input",
			value: query,
			placeholder: t("memory.search"),
			onChange: (event) => setQuery(event.target.value)
		}), (0, react.createElement)(Button, {
			key: "go",
			label: t("hub.refresh"),
			onClick: () => void refreshMemories()
		})),
		(0, react.createElement)("div", {
			key: "new",
			className: "sm-form"
		}, (0, react.createElement)("input", {
			key: "input",
			className: "sm-input",
			value: newMemory,
			placeholder: t("memory.new.placeholder"),
			onChange: (event) => setNewMemory(event.target.value)
		}), (0, react.createElement)(Button, {
			key: "add",
			variant: "primary",
			label: t("memory.add"),
			disabled: !newMemory.trim(),
			onClick: () => void run(async () => api.createMemory(cwd, newMemory.trim()), () => {
				setNewMemory("");
				refreshMemories();
			})
		})),
		(0, react.createElement)("div", {
			key: "list",
			className: "sm-list"
		}, memories.length === 0 ? (0, react.createElement)("div", {
			key: "empty",
			className: "sm-empty"
		}, t("memory.empty")) : memories.map((memory) => editingMemory && editingMemory.id === memory.id ? (0, react.createElement)("div", {
			key: memory.id,
			className: "sm-item"
		}, (0, react.createElement)("textarea", {
			key: "input",
			className: "sm-textarea",
			value: editingMemory.text,
			onChange: (event) => setEditingMemory({
				id: memory.id,
				text: event.target.value
			})
		}), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
			key: "save",
			variant: "primary",
			label: t("memory.save"),
			onClick: () => void run(async () => api.updateMemory(cwd, memory.id, editingMemory.text), () => {
				setEditingMemory(void 0);
				refreshMemories();
			})
		}), (0, react.createElement)(Button, {
			key: "cancel",
			label: t("memory.cancel"),
			onClick: () => setEditingMemory(void 0)
		}))) : (0, react.createElement)("div", {
			key: memory.id,
			className: "sm-item"
		}, (0, react.createElement)("div", { className: "sm-title" }, memory.text), (0, react.createElement)("div", { className: "sm-sub" }, (0, react.createElement)("span", {
			key: "st",
			className: "sm-badge"
		}, memory.status), `${t("memory.source")}：${memory.sourceSessionId || "—"}`), (0, react.createElement)("div", { className: "sm-actions" }, memory.sourceSessionId ? (0, react.createElement)(Button, {
			key: "loc",
			label: t("memory.locate"),
			onClick: () => api.openSession(memory.sourceSessionId)
		}) : null, (0, react.createElement)(Button, {
			key: "edit",
			label: t("memory.edit"),
			onClick: () => setEditingMemory({
				id: memory.id,
				text: memory.text
			})
		}), (0, react.createElement)(Button, {
			key: "toggle",
			label: memory.status === "active" ? t("memory.disable") : t("memory.enable"),
			onClick: () => void run(async () => api.setMemoryStatus(cwd, memory.id, memory.status === "active" ? "superseded" : "active"), () => void refreshMemories())
		}), (0, react.createElement)(Button, {
			key: "del",
			variant: "danger",
			label: t("memory.delete"),
			onClick: () => void run(async () => api.deleteMemory(cwd, memory.id), () => void refreshMemories())
		})))))
	];
	const toolsView = [(0, react.createElement)("div", {
		key: "list",
		className: "sm-list"
	}, tools.length === 0 ? (0, react.createElement)("div", {
		key: "empty",
		className: "sm-empty"
	}, t("tool.empty")) : tools.map((tool) => (0, react.createElement)("div", {
		key: tool.id,
		className: "sm-item"
	}, (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-title" }, tool.name), (0, react.createElement)("span", { className: "sm-badge" }, tool.status), (0, react.createElement)("span", { className: "sm-badge" }, tool.live ? t("tool.live") : t("tool.offline"))), editingTool && editingTool.id === tool.id ? (0, react.createElement)("div", { key: "edit" }, (0, react.createElement)("textarea", {
		key: "input",
		className: "sm-textarea",
		value: editingTool.description,
		onChange: (event) => setEditingTool({
			id: tool.id,
			description: event.target.value
		})
	}), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
		key: "save",
		variant: "primary",
		label: t("tool.desc.save"),
		onClick: () => void run(async () => api.editTool(tool.id, { description: editingTool.description }), () => {
			setEditingTool(void 0);
			refreshTools();
		})
	}), (0, react.createElement)(Button, {
		key: "cancel",
		label: t("memory.cancel"),
		onClick: () => setEditingTool(void 0)
	}))) : (0, react.createElement)("div", { key: "desc" }, (0, react.createElement)("div", { className: "sm-sub" }, `${t("tool.desc.edit")}：${tool.description || "—"}`), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
		key: "edit",
		label: t("tool.desc.edit"),
		onClick: () => setEditingTool({
			id: tool.id,
			description: tool.description
		})
	}), tool.status === "active" ? (0, react.createElement)(Button, {
		key: "retire",
		variant: "danger",
		label: t("tool.retire"),
		onClick: () => void run(async () => api.editTool(tool.id, { status: "retired" }), () => void refreshTools())
	}) : null)), (0, react.createElement)("div", { className: "sm-sub" }, `${t("tool.steps")}：${tool.steps.join(" → ") || "—"}`), (0, react.createElement)("div", { className: "sm-sub" }, `${t("tool.params")}：${tool.parameters.join("、") || "—"} · ${t("tool.uses")}：${tool.useCount}`))))];
	const body = view.kind === "hub" ? hubView : view.kind === "topic" ? topicView : view.kind === "memories" ? memoriesView : toolsView;
	return (0, react.createElement)("div", {
		className: "sm-panel",
		"data-sm-panel": "true"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-head"
	}, (0, react.createElement)("h1", null, t("panel.title")), hub ? (0, react.createElement)("span", {
		key: "counts",
		className: "sm-counts"
	}, t("hub.counts", hub.counts)) : null), (0, react.createElement)("div", {
		key: "tabs",
		className: "sm-tabs"
	}, (0, react.createElement)("button", {
		key: "hub",
		...tabProps("hub")
	}, t("tab.hub")), (0, react.createElement)("button", {
		key: "memories",
		...tabProps("memories")
	}, t("tab.memories")), (0, react.createElement)("button", {
		key: "tools",
		...tabProps("tools")
	}, t("tab.tools"))), (0, react.createElement)("div", {
		key: "body",
		className: "sm-body"
	}, loading ? (0, react.createElement)("div", {
		key: "loading",
		className: "sm-muted"
	}, "…") : null, error ? (0, react.createElement)("div", {
		key: "error",
		className: "sm-error"
	}, error) : null, notice ? (0, react.createElement)("div", {
		key: "notice",
		className: "sm-ok"
	}, notice) : null, body));
}
// src/client/new-session.tsx
/**
* New-session choice layer (R3): offers 中枢会话 (the shell's plain new session)
* or 话题集会话 (a fresh session bound to one or more topic sets, created
* host-side and opened immediately).
*
* Mounted in `shell.overlay` (a global render slot) because this shell exposes
* no sidebar "new session action" slot to hook into — the verified sidebar slot
* vocabulary is sidebar.panellist / sidebar.session.row.leading /
* sidebar.workspaces.session.row.action / sidebar.footer.action. The component
* therefore installs a capture-phase document listener and intercepts the click
* on the shell's 新建会话 control by its accessible name (aria-label / title /
* text). If that label is renamed upstream the listener never matches, nothing
* is prevented, and the shell's default plain new session keeps working — the
* failure mode is a missing dialog, never a dead button.
* @module supermemory/client/new-session
*/
const CHOICE_CSS = [
	".sm-ns-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}",
	".sm-ns-card{width:380px;max-width:92vw;max-height:70vh;overflow:auto;border-radius:12px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#1c1c20);color:var(--dsh-color-text,#e8e8ea);padding:16px;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,.5)}",
	".sm-ns-card h2{margin:0 0 12px;font-size:15px}",
	".sm-ns-option{display:flex;gap:8px;align-items:flex-start;padding:10px;border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;margin-bottom:8px;cursor:pointer}",
	".sm-ns-option[data-active=\"true\"]{border-color:var(--dsh-color-primary,#5b8def)}",
	".sm-ns-option .sm-ns-name{font-weight:600}",
	".sm-ns-option .sm-ns-desc{opacity:.6;font-size:11px;margin-top:2px}",
	".sm-ns-list{max-height:180px;overflow:auto;border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;padding:6px;margin:8px 0}",
	".sm-ns-check{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer}",
	".sm-ns-check:hover{background:var(--dsh-color-bg-soft,#222228)}",
	".sm-ns-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}",
	".sm-ns-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#222228);color:inherit;cursor:pointer;font-size:12px}",
	".sm-ns-btn[data-variant=\"primary\"]{background:var(--dsh-color-primary,#3d6fd8);border-color:transparent;color:#fff}",
	".sm-ns-btn:disabled{opacity:.45;cursor:default}",
	".sm-ns-input{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#121215);color:inherit;font-size:12px;font-family:inherit}",
	".sm-ns-error{color:#e0736a;font-size:12px;margin-top:6px}"
].join("\n");
let cssInstalled$1 = false;
function installCss$1() {
	if (cssInstalled$1 || typeof document === "undefined") return;
	cssInstalled$1 = true;
	const style = document.createElement("style");
	style.setAttribute("data-plugin", "dsh-supermemory");
	style.textContent = CHOICE_CSS;
	document.head.append(style);
}
/**
* The shell's New-session control, in the shipped zh and en dictionaries plus
* the plausible variants. Matched against aria-label + title + textContent.
*/
const NEW_SESSION_CONTROL = /(新建|新的?)\s*会话|新建对话|新对话|new\s+(session|chat|conversation)/i;
/** Whether an accessible name/value describes the shell's New-session control. */
function isNewSessionControl(value) {
	if (!value) return false;
	return NEW_SESSION_CONTROL.test(value);
}
/** The New-session choice layer. */
function NewSessionChoice(props) {
	installCss$1();
	const t = typeof props.t === "function" ? props.t : (key) => key;
	const { api } = props;
	const [open, setOpen] = (0, react.useState)(false);
	const [choice, setChoice] = (0, react.useState)("hub");
	const [topicSets, setTopicSets] = (0, react.useState)([]);
	const [selected, setSelected] = (0, react.useState)([]);
	const [newTitle, setNewTitle] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)();
	const cwd = typeof props.cwd === "function" ? props.cwd() : "";
	const openDialog = (0, react.useCallback)(() => {
		setOpen(true);
		setError(void 0);
		setChoice("hub");
		setSelected([]);
		setNewTitle("");
		api.loadTopicSets(cwd).then(setTopicSets, () => setTopicSets([]));
	}, [api, cwd]);
	(0, react.useEffect)(() => {
		if (typeof document === "undefined" || !api) return;
		const onCapture = (event) => {
			if (open) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(".sm-ns-backdrop") !== null) return;
			if (target.closest("[data-sm-panel]") !== null) return;
			const control = target.closest("button, [role=\"button\"], a");
			if (control === null) return;
			if (!isNewSessionControl([
				control.getAttribute("aria-label"),
				control.getAttribute("title"),
				control.textContent
			].filter((value) => typeof value === "string").join(" "))) return;
			event.preventDefault();
			event.stopPropagation();
			openDialog();
		};
		document.addEventListener("click", onCapture, true);
		return () => document.removeEventListener("click", onCapture, true);
	}, [
		api,
		open,
		openDialog
	]);
	(0, react.useEffect)(() => {
		if (!open) return;
		const onKey = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);
	const toggle = (id) => {
		setSelected((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
	};
	const start = async () => {
		setBusy(true);
		setError(void 0);
		try {
			if (choice === "hub") {
				api.startSession();
				setOpen(false);
				return;
			}
			let ids = selected;
			if (newTitle.trim()) {
				const created = await api.createTopicSet(cwd, newTitle.trim());
				if (created.status !== "ok" || !created.id) {
					setError(created.message);
					return;
				}
				ids = [...ids, created.id];
			}
			if (ids.length === 0) {
				setError(t("newSession.pick"));
				return;
			}
			const result = await api.createTopicSetSession(cwd, ids);
			if (result.status !== "ok" || !result.id) {
				setError(result.message);
				return;
			}
			api.openSession(result.id);
			setOpen(false);
		} catch (startError) {
			setError(String(startError instanceof Error ? startError.message : startError));
		} finally {
			setBusy(false);
		}
	};
	if (!open) return null;
	return (0, react.createElement)("div", {
		key: "backdrop",
		className: "sm-ns-backdrop",
		"data-sm-panel": "true",
		onClick: (event) => {
			if (event.target === event.currentTarget) setOpen(false);
		}
	}, (0, react.createElement)("div", {
		key: "card",
		className: "sm-ns-card",
		role: "dialog",
		"aria-modal": true
	}, (0, react.createElement)("h2", { key: "title" }, t("newSession.title")), (0, react.createElement)("div", {
		key: "hub",
		className: "sm-ns-option",
		"data-active": String(choice === "hub"),
		onClick: () => setChoice("hub")
	}, (0, react.createElement)("input", {
		key: "radio",
		type: "radio",
		checked: choice === "hub",
		onChange: () => setChoice("hub")
	}), (0, react.createElement)("div", { key: "text" }, (0, react.createElement)("div", {
		key: "name",
		className: "sm-ns-name"
	}, t("newSession.hub")), (0, react.createElement)("div", {
		key: "desc",
		className: "sm-ns-desc"
	}, t("newSession.hub.desc")))), (0, react.createElement)("div", {
		key: "topic",
		className: "sm-ns-option",
		"data-active": String(choice === "topic"),
		onClick: () => setChoice("topic")
	}, (0, react.createElement)("input", {
		key: "radio",
		type: "radio",
		checked: choice === "topic",
		onChange: () => setChoice("topic")
	}), (0, react.createElement)("div", { key: "text" }, (0, react.createElement)("div", {
		key: "name",
		className: "sm-ns-name"
	}, t("newSession.topic")), (0, react.createElement)("div", {
		key: "desc",
		className: "sm-ns-desc"
	}, t("newSession.topic.desc")))), choice === "topic" ? (0, react.createElement)("div", { key: "picker" }, (0, react.createElement)("div", {
		key: "label",
		className: "sm-ns-desc"
	}, t("newSession.pick")), (0, react.createElement)("div", {
		key: "list",
		className: "sm-ns-list"
	}, topicSets.length === 0 ? (0, react.createElement)("div", {
		key: "empty",
		className: "sm-ns-desc"
	}, t("hub.empty")) : topicSets.map((topicSet) => (0, react.createElement)("label", {
		key: topicSet.id,
		className: "sm-ns-check"
	}, (0, react.createElement)("input", {
		key: "box",
		type: "checkbox",
		checked: selected.includes(topicSet.id),
		onChange: () => toggle(topicSet.id)
	}), (0, react.createElement)("span", { key: "name" }, topicSet.title)))), (0, react.createElement)("input", {
		key: "newTitle",
		className: "sm-ns-input",
		value: newTitle,
		placeholder: t("newSession.create"),
		onChange: (event) => setNewTitle(event.target.value)
	})) : null, error ? (0, react.createElement)("div", {
		key: "error",
		className: "sm-ns-error"
	}, error) : null, (0, react.createElement)("div", {
		key: "actions",
		className: "sm-ns-actions"
	}, (0, react.createElement)("button", {
		key: "cancel",
		className: "sm-ns-btn",
		onClick: () => setOpen(false)
	}, t("newSession.cancel")), (0, react.createElement)("button", {
		key: "start",
		className: "sm-ns-btn",
		"data-variant": "primary",
		disabled: busy,
		onClick: () => void start()
	}, t("newSession.start")))));
}
// src/client/session-badge.tsx
/**
* Sidebar session-row branch badge (GUI 问题③): marks the sessions that belong to
* a SuperMemory topic set, so a hub session and the branch sessions it dispatched
* to are visually distinguishable in the left sidebar.
*
* Seated in `sidebar.session.row.leading` — the same slot the host package
* dsh-client-ui-schedule uses for its clock mark (id 'schedule-mark', order 10).
* The shell renders that cell only for a non-archived, non-blank row whose primary
* status is idle; a busy/approval row keeps its own status dot in the same cell
* (upstream gating in dsh-client-ui-workspace's Rows component, verified
* 2026-11-18: `!row.archived && !row.blank && (showStatus ? dots : renderSlot(...))`).
*
* The badge is a pure projection of host topic-set membership: it reads
* `supermemoryPanel.sessionBadge(sessionId)` once per mount (module-level cache),
* renders nothing for a hub session, and never fabricates a badge when the read
* fails.
* @module supermemory/client/session-badge
*/
const BADGE_CSS = [
	".sm-sb-badge{display:inline-flex;align-items:center;gap:3px;flex:none;box-sizing:border-box;height:16px;padding:0 6px 0 4px;border-radius:99px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg-soft,#222228);color:var(--dsh-color-text,#c9c9d1);font-size:10px;line-height:14px;opacity:.8;cursor:default;user-select:none;vertical-align:middle}",
	".sm-sb-badge:hover{opacity:1}",
	".sm-sb-badge svg{display:block;flex:none}"
].join("\n");
let cssInstalled = false;
function installCss() {
	if (cssInstalled || typeof document === "undefined") return;
	cssInstalled = true;
	const style = document.createElement("style");
	style.setAttribute("data-plugin", "dsh-supermemory");
	style.textContent = BADGE_CSS;
	document.head.append(style);
}
/**
* Module-level cache keyed by session id. Membership changes only when a topic
* set gains/loses a member or is archived, and rows unmount while scrolling or
* filtering, so one read per id keeps the sidebar cheap.
*/
const badgeCache = /* @__PURE__ */ new Map();
/**
* Render the branch badge for one session row.
* @returns the badge for a topic-set branch, null for a hub session.
*/
function SupermemorySessionBadge(props) {
	installCss();
	const t = typeof props.t === "function" ? props.t : (key) => key;
	const { api, sessionId } = props;
	const [badge, setBadge] = (0, react.useState)(() => badgeCache.get(sessionId));
	(0, react.useEffect)(() => {
		let alive = true;
		try {
			const cached = badgeCache.get(sessionId);
			if (cached !== void 0) {
				setBadge(cached);
				return () => {
					alive = false;
				};
			}
			api.sessionBadge(sessionId).then((result) => {
				badgeCache.set(sessionId, result);
				if (alive) setBadge(result);
			}, () => {});
		} catch {}
		return () => {
			alive = false;
		};
	}, [api, sessionId]);
	if (!badge || badge.kind !== "branch") return null;
	return (0, react.createElement)("span", {
		key: "badge",
		className: "sm-sb-badge",
		title: t("badge.tip", { title: badge.topicSetTitle }),
		onClick: (event) => {
			event.stopPropagation();
		}
	}, (0, react.createElement)("svg", {
		key: "glyph",
		width: 12,
		height: 12,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.8,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
		focusable: false
	}, (0, react.createElement)("path", {
		key: "a",
		d: "M6 3v12"
	}), (0, react.createElement)("circle", {
		key: "b",
		cx: 18,
		cy: 6,
		r: 3
	}), (0, react.createElement)("circle", {
		key: "c",
		cx: 6,
		cy: 18,
		r: 3
	}), (0, react.createElement)("path", {
		key: "d",
		d: "M18 9a9 9 0 0 1-9 9"
	})), (0, react.createElement)("span", { key: "text" }, t("badge.branch")));
}
// src/client/index.ts
const name = "dsh-supermemory-client";
/** Services this client half needs. */
const inject = [
	"slots",
	"locale",
	"remote",
	"uiWorkspace"
];
/** The panel id shared by the sidebar launcher and the main-slot key. */
const PANEL_ID = "supermemory";
/** Unwrap one RemoteResult, throwing a readable error on failure. */
function unwrap(result) {
	if (result.ok) return result.value;
	const failure = result.error;
	throw new Error(failure?.message ?? "remote call failed");
}
/**
* Build the panel API the components use: every host-panel call goes through
* the mounted remote namespace; navigation goes through uiWorkspace.
*/
function buildApi(ctx) {
	let namespace;
	try {
		namespace = ctx.get("remote.supermemoryPanel");
	} catch {
		namespace = void 0;
	}
	if (!namespace) return void 0;
	const call = async (method, ...args) => {
		const fn = namespace[method];
		if (typeof fn !== "function") throw new Error(`supermemoryPanel.${method} unavailable`);
		return unwrap(await fn(...args));
	};
	return {
		loadHub: (cwd, sessionId) => call("hubState", cwd, sessionId),
		listMemories: (cwd, query) => call("listMemories", cwd, query, 200),
		createMemory: (cwd, text, key) => call("createMemory", cwd, text, key),
		updateMemory: (cwd, id, text, key) => call("updateMemory", cwd, id, text, key),
		deleteMemory: (cwd, id) => call("deleteMemory", cwd, id),
		setMemoryStatus: (cwd, id, status) => call("setMemoryStatus", cwd, id, status),
		createTopicSet: (cwd, title) => call("createTopicSet", cwd, title),
		activate: async (sessionId, topicSetId) => call("activate", sessionId, topicSetId),
		updateTopicSetSummary: (id, summary) => call("updateTopicSetSummary", id, summary),
		createTopicSetSession: (cwd, ids) => call("createTopicSetSession", cwd, ids),
		followupTopicSet: (cwd, topicSetId, text) => call("followupTopicSet", cwd, topicSetId, text),
		listTools: () => call("listTools"),
		editTool: (id, patch) => call("editTool", id, patch),
		sessionBadge: (sessionId) => call("sessionBadge", sessionId),
		openSession: (sessionId) => {
			ctx.get("uiWorkspace")?.openSession(sessionId);
		},
		startSession: () => {
			ctx.get("uiWorkspace")?.startSession();
		},
		loadTopicSets: (cwd) => call("listTopicSets", cwd)
	};
}
/**
* Resolve the workspace path the New-session dialog should create sessions in.
*
* The MAIN-VIEW session own cwd wins: with more than one workspace open,
* `workspaces.items[0].path` points the dialog — and every write it triggers —
* at the wrong project (the same trap fixed in panel-page.tsx). The row shape
* is the client `sessions` list snapshot (`cwd`, or `header.cwd` on rows that
* only carry a header); `workspaces.list` is the fallback, and '' lets the host
* resolve its default workspace.
*/
function resolveCwd(ctx) {
	try {
		const byId = ctx.get("sessions")?.list?.getSnapshot?.()?.byId ?? {};
		for (const session of Object.values(byId)) {
			if ((session?.retainedBy?.mainView ?? 0) <= 0) continue;
			const cwd = session.cwd ?? session.header?.cwd;
			if (typeof cwd === "string" && cwd) return cwd;
		}
	} catch {}
	try {
		const items = ctx.get("workspaces")?.list?.getSnapshot?.()?.items ?? [];
		for (const item of items) if (typeof item?.path === "string" && item.path) return item.path;
	} catch {}
	return "";
}
/**
* Register the SuperMemory surfaces. Every registration is defensive: a
* failure in one contribution must not take down the others (or the boot).
* @param ctx - browser root context.
*/
async function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "supermemory: dictionaries");
	try {
		const remote = ctx.get("remote");
		if (remote && typeof remote.$mount === "function") await remote.$mount(PANEL_REMOTE);
	} catch (error) {
		console.error("supermemory: panel remote mount failed", error);
	}
	const api = buildApi(ctx);
	if (!api) {
		console.error("supermemory: panel remote unavailable; the panel stays empty");
		return;
	}
	const t = (key, params) => {
		return ctx.locale.bind(NS)(key, params);
	};
	const contribute = (label, attach) => {
		try {
			attach();
		} catch (error) {
			console.error(`supermemory: ${label} registration failed`, error);
		}
	};
	contribute("panel launcher", () => {
		ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
			name: "sidebar.panellist",
			id: PANEL_ID,
			order: 25,
			locale: NS,
			label: () => t("panel")
		}, SupermemoryIcon)), "supermemory: panel launcher");
	});
	contribute("panel page", () => {
		ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
			name: "main",
			key: PANEL_ID,
			locale: NS,
			inject: () => ({ api })
		}, SupermemoryPanelPage)), "supermemory: panel page");
	});
	contribute("new-session choice", () => {
		ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
			name: "shell.overlay",
			id: "supermemory-new-session",
			order: 30,
			locale: NS,
			inject: () => ({
				api,
				cwd: () => resolveCwd(ctx)
			})
		}, NewSessionChoice)), "supermemory: new-session choice");
	});
	contribute("session badge", () => {
		ctx.effect(() => ctx.slots.inject("sidebar.session.row.leading", () => ctx.slots.register({
			name: "sidebar.session.row.leading",
			id: "supermemory-branch",
			order: 30,
			locale: NS,
			inject: () => ({ api })
		}, SupermemorySessionBadge)), "supermemory: session badge");
	});
}
exports.apply = apply;
exports.inject = inject;
exports.name = name;

return module.exports}});
