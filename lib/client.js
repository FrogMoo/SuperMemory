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
			param("key", true),
			param("title", true),
			param("tags", true)
		]),
		method("updateMemory", [
			param("cwd"),
			param("id"),
			param("text"),
			param("key", true),
			param("title", true),
			param("tags", true)
		]),
		method("deleteMemory", [param("cwd"), param("id")]),
		method("setMemoryStatus", [
			param("cwd"),
			param("id"),
			param("status")
		]),
		method("listMemoryCollections", [param("cwd")]),
		method("listMemoriesByCollection", [
			param("cwd"),
			param("collectionId"),
			param("query", true),
			param("limit", true)
		]),
		method("getMemoryDetail", [param("cwd"), param("id")]),
		method("getHubPolicy", [param("cwd")]),
		method("setHubPolicy", [param("cwd"), param("patch")]),
		method("cleanupStaleHubPolicy", [param("cwd")]),
		method("getModelDefaults", [param("cwd")]),
		method("setModelDefaults", [param("cwd"), param("patch")]),
		method("listSkills", [param("cwd")]),
		method("updateSkill", [
			param("cwd"),
			param("name"),
			param("patch")
		]),
		method("createTopicSet", [
			param("cwd"),
			param("title"),
			param("tags", true),
			param("summary", true)
		]),
		method("suggestMemoryShape", [param("text")]),
		method("listHubSessions", [param("cwd")]),
		method("listHubBranches", [
			param("cwd"),
			param("hubSessionId"),
			param("limit", true)
		]),
		method("listAllTopicSets", [param("cwd")]),
		method("listAllBranches", [
			param("cwd"),
			param("topicSetId", true),
			param("limit", true)
		]),
		method("readSessionMessages", [param("sessionId"), param("limit", true)]),
		method("sendSessionMessage", [param("sessionId"), param("text")]),
		method("updateTopicSetSummary", [
			param("id"),
			param("summary"),
			param("tags", true)
		]),
		method("createTopicSetSession", [
			param("cwd"),
			param("topicSetIds"),
			param("options", true),
			param("firstMessage", true)
		]),
		method("createHubSession", [
			param("cwd"),
			param("options", true),
			param("firstMessage", true)
		]),
		method("listAgentPresets", []),
		method("listModelCatalog", []),
		method("listPermissions", []),
		method("followupTopicSet", [
			param("cwd"),
			param("topicSetId"),
			param("text")
		]),
		method("listTools", [param("cwd", true)]),
		method("editTool", [param("id"), param("patch")]),
		method("deleteTool", [param("id")]),
		method("runTool", [param("id"), param("options", true)]),
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
	"tab.sets": "话题集",
	"tab.memories": "记忆",
	"tab.branches": "分支会话",
	"tab.settings": "设置",
	"tab.tools": "固化能力",
	"settings.policy.title": "中枢权限（白名单，默认拒绝）",
	"settings.models.title": "默认模型",
	"settings.models.hint": "只影响新建会话：中枢默认用于新建中枢会话；分支默认用于新派发分支（话题集/分支级覆盖仍优先）。",
	"settings.models.hub": "中枢会话模型",
	"settings.models.branch": "分支会话模型",
	"settings.models.follow": "跟随默认（宿主链路）",
	"settings.models.save": "保存默认模型",
	"settings.models.reset": "恢复默认设置",
	"settings.models.precedence": "优先级：分支级覆盖 > 话题集默认 > 分支会话默认 > 中枢当前模型 > 宿主默认；新建中枢：显式选择 > 中枢默认 > 宿主默认。",
	"settings.skills.title": "已生成的 skills",
	"settings.skills.hint": "重复事务会自动沉淀为 DSH skill（文件写在 <仓库>/.dsh/skills，重启后仍在）。目录只展示「何时用」；正文由 skill 工具按需加载。可改路由描述或停用；同名更新会升版并保留 changelog，人工编辑的正文不会被覆盖。",
	"settings.skills.empty": "还没有生成的 skill：重复流程达到阈值后自动生成，或用 memory_toolize register 手工登记。",
	"settings.skills.uses": "加载 {count} 次",
	"settings.skills.save": "保存描述",
	"settings.skills.enable": "启用",
	"settings.skills.disable": "停用",
	"settings.skills.disabled": "已停用",
	"sets.search": "按标题或标签搜索话题集…",
	"sets.clear": "清空",
	"sets.stats": "显示 {shown} / {total} 个话题集",
	"sets.empty": "（没有匹配的话题集）",
	"sets.empty.hint": "新建话题集后，把同类会话与它们的记忆收在一起。",
	"sets.created": "已创建",
	"sets.sessions": "{count} 个会话",
	"sets.live": "{count} 个在线",
	"sets.open": "进入",
	"sets.noBody": "（暂无正文/梗概）",
	"sets.archived": "已归档",
	"hub.current": "当前会话",
	"hub.active": "活跃话题集",
	"hub.none": "（未激活）",
	"hub.activate": "激活",
	"hub.topicSets": "话题集",
	"hub.empty": "当前工作区还没有话题集。",
	"hub.empty.hint": "在中枢会话里派发第一个任务后，这里会出现对应的话题集。",
	"side.title": "中枢会话（发现视图）",
	"side.authority": "发现视图：按会话形状列出可打开的顶层会话，不代表角色权限；会话角色由插件正证据判定（hub 记录 / 话题集 root / 派发记录）。",
	"side.count": "{count} 个",
	"side.empty": "还没有中枢会话",
	"side.empty.hint": "判断与汇总留在这里，读写与命令交给分支。",
	"side.new": "＋ 新中枢会话",
	"side.running": "运行中",
	"side.current": "当前",
	"side.branches": "{count} 个关联分支（{working} 个工作中）",
	"branches.title": "关联分支",
	"branches.empty": "本会话还没有拉起分支。",
	"branches.empty.hint": "派发任务后，这里会显示它拉起的每个分支：名称、状态、所属话题集与共享它的中枢数。",
	"branches.working": "工作中",
	"branches.idle": "空闲",
	"branches.failed": "失败待处理",
	"branches.shared": "与 {count} 个中枢共享",
	"branches.set": "话题集「{title}」",
	"branches.ownSet": "所属话题集",
	"branches.noSet": "无话题集",
	"branches.dispatches": "{count} 次派发",
	"branches.group": "并行组",
	"branches.ago.just": "刚刚",
	"branches.ago.min": "{count} 分钟前",
	"branches.ago.hour": "{count} 小时前",
	"branches.ago.day": "{count} 天前",
	"branches.search": "搜索标题 / 标签 / 分支 id / 话题集…",
	"branches.stats": "显示 {shown} / {total} 个分支会话",
	"hub.counts": "记忆 {memories} · 需求 {requirements} · 梗概 {episodes} · 进行中派发 {dispatches}",
	"hub.refresh": "刷新",
	"hub.openSession": "打开会话",
	"hub.allBranches": "全部分支会话",
	"hub.allBranches.filter": "按话题集筛选",
	"hub.allBranches.allSets": "全部话题集",
	"hub.allBranches.empty": "（没有分支会话）",
	"hub.allBranches.hint": "派发任务后，这里会列出跨话题集的全部分支：标题、标签、状态与最后活动。",
	"topic.members": "分支会话",
	"topic.noMembers": "（暂无分支会话）",
	"topic.reply": "回复到话题集",
	"topic.reply.placeholder": "输入要送入话题集分支的内容…",
	"topic.reply.send": "发送",
	"topic.summary": "梗概",
	"topic.summary.save": "保存梗概",
	"topic.create": "新建话题集",
	"topic.create.placeholder": "新话题集标题",
	"topic.back": "返回话题集页签",
	"memory.search": "按标题、标签或正文搜索…",
	"memory.title": "标题",
	"memory.tags": "标签",
	"memory.body": "正文",
	"memory.empty": "（没有匹配的记忆）",
	"memory.empty.hint": "记忆由中枢/分支在会话中写入（memory_remember），这里只浏览与管理。",
	"memory.locate": "定位会话",
	"memory.edit": "编辑",
	"memory.save": "保存",
	"memory.cancel": "取消",
	"memory.delete": "删除",
	"memory.deleteConfirm": "确认删除",
	"memory.disable": "停用",
	"memory.enable": "启用",
	"memory.status": "状态",
	"memory.source": "来源会话",
	"memory.group.ungrouped": "未归集",
	"memory.group.count": "{count} 条",
	"memory.collection.search": "按标题或标签搜索记忆集合…",
	"memory.collection.open": "打开这个记忆集合的条目",
	"memory.collection.empty": "（没有匹配的记忆集合）",
	"memory.collection.empty.hint": "写入一条记忆后，这里会出现它的记忆集合卡片；点卡片看里面的条目。",
	"memory.detail.open": "打开这条记忆的详情与历史版本",
	"memory.back": "返回",
	"memory.updated": "更新",
	"memory.history": "历史版本",
	"memory.history.none": "（这条记忆还没有历史版本行）",
	"memory.history.toggle": "展开/收起这个版本的完整内容",
	"memory.history.create": "新建",
	"memory.history.update": "更新",
	"memory.history.migrate": "迁移",
	"tool.empty": "（暂无固化能力；可手动注册，重复流程出现 3 次后也会自动提议固化）",
	"tool.empty.hint": "固化能力 = 入口命令 + 文档 + 适用范围，可一键执行（默认预演，写操作需确认）；重复流程也会自动固化为序列。",
	"tool.steps": "步骤",
	"tool.params": "参数",
	"tool.uses": "使用次数",
	"tool.live": "已注册",
	"tool.offline": "未注册",
	"tool.retire": "停用",
	"tool.enable": "启用",
	"tool.delete": "删除",
	"tool.deleteConfirm": "确认删除",
	"tool.desc.save": "保存",
	"tool.desc.edit": "编辑标题/标签/简介",
	"tool.kind.capability": "能力",
	"tool.kind.sequence": "序列",
	"tool.detail.toggle": "点击展开/收起能力详情",
	"tool.detail.kind": "类型",
	"tool.detail.version": "版本",
	"tool.detail.builtin": "内置 v{version}",
	"tool.detail.created": "增加时间",
	"tool.detail.lastUsed": "最后使用",
	"tool.detail.entry": "入口命令",
	"tool.detail.doc": "文档",
	"tool.detail.scope": "适用范围",
	"tool.detail.route": "路由描述",
	"tool.detail.run": "执行方式",
	"tool.detail.noRun": "仅作路由/文档存在，不执行",
	"tool.detail.dryRun": "默认预演",
	"tool.detail.realRun": "直接执行",
	"tool.detail.confirm": "真实执行需 confirm",
	"tool.detail.stats": "使用统计",
	"tool.detail.success": "成功",
	"tool.detail.fail": "失败",
	"tool.detail.streak": "连续失败",
	"tool.detail.last": "最近一次",
	"tool.detail.ok": "成功",
	"tool.detail.failed": "失败",
	"tool.detail.preview": "预演",
	"tool.detail.lastSummary": "最近结果",
	"tool.detail.health": "健康信号",
	"tool.detail.missing": "（缺失）",
	"launch.title": "快速新建会话",
	"launch.workspace": "工作区",
	"launch.preset": "Agent 模式",
	"launch.model": "模型",
	"launch.permission": "权限",
	"launch.default": "跟随默认",
	"launch.defaultMark": "默认",
	"launch.sets": "话题集（可多选）",
	"launch.start": "创建中枢会话",
	"launch.startSets": "创建话题集会话",
	"launch.hint": "不选话题集即创建普通中枢会话；选中后创建绑定这些话题集的新会话。",
	"launch.needWorkspace": "请先选择工作区。",
	"composer.title": "中枢会话",
	"composer.desc": "说清要中枢做什么；会话在后台新建并立刻送达，不跳页。",
	"composer.placeholder": "例如：整理这个仓库的记忆，并派发一个分支去补测试…",
	"composer.start": "开始对话",
	"composer.createOnly": "仅创建会话",
	"composer.createOnly.hint": "只建会话，先不发消息",
	"composer.hint": "Ctrl/Cmd + Enter 发送",
	"composer.newSet": "＋新话题集",
	"composer.setsEmpty": "当前工作区还没有话题集",
	"composer.open": "打开会话",
	"composer.dismiss": "收起",
	"composer.receipt.hub": "中枢会话",
	"composer.receipt.sets": "话题集会话",
	"newSession.create": "新建话题集…",
	"workspace.label": "工作区",
	"side.set": "话题集",
	"topic.root": "中枢",
	"topic.branch": "分支",
	"chat.live": "运行中",
	"chat.cold": "未运行",
	"chat.empty": "（还没有可显示的消息）",
	"chat.empty.hint": "在下方输入并发送，消息会直接进入该会话；回复会自动刷新。",
	"chat.placeholder": "输入消息，直接送入该会话…",
	"chat.send": "发送",
	"chat.refresh": "刷新",
	"chat.open": "在 DSH 打开",
	"chat.truncated": "仅显示最近消息",
	"chat.hint": "Ctrl/Cmd + Enter 发送；面板会轮询该会话的新回复。",
	"chat.you": "你",
	"chat.assistant": "助手",
	"chat.tool": "工具",
	"memory.modal.title": "编辑记忆",
	"memory.modal.hint": "只写结论性、可复用的事实/决策；过程步骤留在会话里。标题与标签用于检索。",
	"hubPolicy.model": "白名单 {count} 项 · 默认拒绝白名单以外的工具",
	"hubPolicy.hint": "中枢会话只能调用白名单内的工具；不在名单内的一律拒绝，未来新增的未知工具同样默认拒绝。目录每次打开/刷新都从运行时重新生成，保存后下一个工具调用即生效。",
	"hubPolicy.source.stored": "工作区自定义",
	"hubPolicy.source.default": "内置默认",
	"hubPolicy.reset": "恢复默认",
	"hubPolicy.save": "保存",
	"hubPolicy.loading": "（正在读取白名单…）",
	"hubPolicy.loading.hint": "读取失败时会回退内置默认白名单，派发链路不受影响。",
	"hubPolicy.locked": "锁定",
	"hubPolicy.locked.tip": "核心锁定项：派发/收线/提问/运行码传输，取消会导致中枢无法派发，因此不可关闭。",
	"hubPolicy.risk": "实操",
	"hubPolicy.risk.tip": "实操执行类工具：中枢本该派发给分支执行，勾选即允许中枢亲自执行。",
	"hubPolicy.note.pluginManager": "关掉后中枢也不能重载插件（需在宿主插件页操作）。",
	"hubPolicy.custom.placeholder": "添加自定义工具名（未知工具默认拒绝，可在此放行）",
	"hubPolicy.custom.add": "添加",
	"hubPolicy.catalog.dynamic": "动态目录",
	"hubPolicy.catalog.fallback": "内置回退",
	"hubPolicy.catalog.meta": "工具 {tools} 项 / {groups} 组",
	"hubPolicy.refresh": "刷新目录",
	"hubPolicy.lastRefresh": "上次刷新 {time}",
	"hubPolicy.search.placeholder": "搜索工具名或描述（跨来源分组）",
	"hubPolicy.empty": "没有匹配的工具",
	"hubPolicy.empty.hint": "换个关键词，或点「刷新目录」重新读取运行时工具。",
	"hubPolicy.group.count": "{count} 项",
	"hubPolicy.group.enabled": "已启用 {enabled}",
	"hubPolicy.group.match": "匹配 {count} / 共 {total}",
	"hubPolicy.group.expand": "展开该来源",
	"hubPolicy.group.collapse": "折叠该来源",
	"hubPolicy.inferred": "来源为推断",
	"hubPolicy.inferred.tip": "宿主工具定义不含来源字段；分组按命名前缀与插件归属推断（可解释、非精确）。若宿主未来声明来源，该组会自动改为「宿主声明」。",
	"hubPolicy.source.supermemory": "SuperMemory 插件",
	"hubPolicy.source.composite": "固化能力（SuperMemory）",
	"hubPolicy.source.schedule": "调度",
	"hubPolicy.source.hostSession": "宿主会话工具",
	"hubPolicy.source.host": "宿主内置 / 未归属",
	"hubPolicy.source.mcp": "MCP · {server}",
	"hubPolicy.synthetic": "合成",
	"hubPolicy.synthetic.tip": "不在全局注册面（宿主保留名 / agent 级注册 / 会话级 API），但中枢会话实际可用；永不判失效，清理不会移除。",
	"hubPolicy.catalog.synthetic": "合成 {count} 项",
	"hubPolicy.group.stale": "已失效条目",
	"hubPolicy.stale.tip": "白名单中存在、但当前运行时已不存在的条目（插件卸载/改名）。一键清理会先保存当前白名单，再按运行时移除这些条目；锁定项永不移除。",
	"hubPolicy.stale.badge": "失效",
	"hubPolicy.stale.clean": "一键清理（{count}）",
	"hubPolicy.viaPrefix": "前缀放行",
	"hubPolicy.viaPrefix.tip": "该项由前缀规则放行；要移出白名单请取消同组的前缀条目。",
	"badge.hubSet": "话题集",
	"badge.hubSet.tip": "中枢会话属于话题集 · {title}",
	"badge.branch": "分支",
	"badge.tip": "话题集分支 · {title}",
	"badge.hub": "中枢",
	"badge.hub.tip": "SuperMemory 中枢会话",
	"error.load": "加载失败",
	"error.retry": "重试",
	"error.generic": "操作失败",
	"ok.saved": "已保存",
	"chat.card.from": "来自 {session} 的执行请求",
	"chat.card.kind.hub": "中枢派发",
	"chat.card.kind.branch": "分支回报",
	"chat.card.kind.group": "并行组回报",
	"chat.card.kind.system": "系统通知",
	"chat.card.task": "任务",
	"chat.card.topicSet": "话题集",
	"chat.card.capability": "能力档位",
	"chat.card.dispatch": "派发回执",
	"chat.card.sourceId": "来源会话",
	"chat.card.expand": "展开详情",
	"chat.card.collapse": "收起",
	"chat.card.empty": "（无正文）"
};
const en = {
	"panel": "SuperMemory",
	"panel.title": "SuperMemory",
	"tab.hub": "Hub session",
	"tab.sets": "Topic sets",
	"tab.memories": "Memories",
	"tab.branches": "Branches",
	"tab.settings": "Settings",
	"tab.tools": "Fixated capabilities",
	"settings.policy.title": "Hub permissions (whitelist, default deny)",
	"settings.models.title": "Default models",
	"settings.models.hint": "Affects NEW sessions only: the hub default names new hub sessions; the branch default names new dispatches (topic-set/branch overrides still win).",
	"settings.models.hub": "Hub session model",
	"settings.models.branch": "Branch session model",
	"settings.models.follow": "Follow default (host chain)",
	"settings.models.save": "Save default models",
	"settings.models.reset": "Restore defaults",
	"settings.models.precedence": "Precedence: branch override > topic-set default > branch default > hub current model > host default; new hub: explicit choice > hub default > host default.",
	"settings.skills.title": "Generated skills",
	"settings.skills.hint": "Repeated work is fixated into DSH skills (files under <repo>/.dsh/skills, survive restarts). The catalog shows only \"when to use\"; the skill tool loads the body on demand. You can edit the routing description or disable one; same-name updates bump the version and keep the changelog, and human-edited bodies are never overwritten.",
	"settings.skills.empty": "No skills yet: repeated flows are fixated past the threshold, or register one manually with memory_toolize register.",
	"settings.skills.uses": "loaded {count} times",
	"settings.skills.save": "Save description",
	"settings.skills.enable": "Enable",
	"settings.skills.disable": "Disable",
	"settings.skills.disabled": "disabled",
	"sets.search": "Search topic sets by title or tag…",
	"sets.clear": "Clear",
	"sets.stats": "Showing {shown} of {total} topic sets",
	"sets.empty": "(no matching topic sets)",
	"sets.empty.hint": "Create a topic set to collect related sessions and their memories.",
	"sets.created": "Created",
	"sets.sessions": "{count} sessions",
	"sets.live": "{count} live",
	"sets.open": "Open",
	"sets.noBody": "(no body yet)",
	"sets.archived": "archived",
	"hub.current": "Current session",
	"hub.active": "Active topic set",
	"hub.none": "(none)",
	"hub.activate": "Activate",
	"hub.topicSets": "Topic sets",
	"hub.empty": "No topic sets in this workspace yet.",
	"hub.empty.hint": "Dispatch the first task from a hub session and its topic set appears here.",
	"side.title": "Hub sessions (discovery)",
	"side.authority": "Discovery view: lists openable top-level sessions by shape, not role authority. Roles come from positive plugin marks (hub record / topic-set root / dispatch).",
	"side.count": "{count}",
	"side.empty": "No hub sessions yet",
	"side.empty.hint": "Keep judgement and summaries here; files and commands go to branches.",
	"side.new": "+ New hub session",
	"side.running": "live",
	"side.current": "current",
	"side.branches": "{count} linked branches ({working} working)",
	"branches.title": "Linked branches",
	"branches.empty": "This hub has not started any branch yet.",
	"branches.empty.hint": "After a dispatch, every branch this hub started appears here: name, state, owning topic set, and how many hubs share it.",
	"branches.working": "working",
	"branches.idle": "idle",
	"branches.failed": "failed",
	"branches.shared": "shared with {count} hub(s)",
	"branches.set": "set「{title}」",
	"branches.ownSet": "owning set",
	"branches.noSet": "no set",
	"branches.dispatches": "{count} dispatches",
	"branches.group": "parallel group",
	"branches.ago.just": "just now",
	"branches.ago.min": "{count} min ago",
	"branches.ago.hour": "{count} h ago",
	"branches.ago.day": "{count} d ago",
	"branches.search": "Search title / tags / branch id / topic set…",
	"branches.stats": "Showing {shown} of {total} branch sessions",
	"hub.counts": "{memories} memories · {requirements} requirements · {episodes} episodes · {dispatches} running dispatches",
	"hub.refresh": "Refresh",
	"hub.openSession": "Open session",
	"hub.allBranches": "All branch sessions",
	"hub.allBranches.filter": "Filter by topic set",
	"hub.allBranches.allSets": "All topic sets",
	"hub.allBranches.empty": "(no branch sessions)",
	"hub.allBranches.hint": "After a dispatch this lists every branch across topic sets: title, tags, status and last activity.",
	"topic.members": "Branch sessions",
	"topic.noMembers": "(no branch sessions)",
	"topic.reply": "Reply into topic set",
	"topic.reply.placeholder": "Text to deliver to the topic-set branch…",
	"topic.reply.send": "Send",
	"topic.summary": "Summary",
	"topic.summary.save": "Save summary",
	"topic.create": "New topic set",
	"topic.create.placeholder": "New topic set title",
	"topic.back": "Back to topic sets",
	"memory.search": "Search title, tags or body…",
	"memory.title": "Title",
	"memory.tags": "Tags",
	"memory.body": "Body",
	"memory.empty": "(no matching memories)",
	"memory.empty.hint": "Memories are written in the conversation (memory_remember); this tab browses and manages them.",
	"memory.locate": "Locate session",
	"memory.edit": "Edit",
	"memory.save": "Save",
	"memory.cancel": "Cancel",
	"memory.delete": "Delete",
	"memory.deleteConfirm": "Confirm delete",
	"memory.disable": "Disable",
	"memory.enable": "Enable",
	"memory.status": "Status",
	"memory.source": "Source session",
	"memory.group.ungrouped": "Ungrouped",
	"memory.group.count": "{count} entries",
	"memory.collection.search": "Search memory collections by title or tags…",
	"memory.collection.open": "Open the entries of this memory collection",
	"memory.collection.empty": "(no matching memory collections)",
	"memory.collection.empty.hint": "Remember a fact and its collection card appears here; open a card to see its entries.",
	"memory.detail.open": "Open this memory's detail and version history",
	"memory.back": "Back",
	"memory.updated": "Updated",
	"memory.history": "Version history",
	"memory.history.none": "(this memory has no history rows yet)",
	"memory.history.toggle": "Expand/collapse this version's full content",
	"memory.history.create": "created",
	"memory.history.update": "updated",
	"memory.history.migrate": "migrated",
	"tool.empty": "(no fixated capabilities; register one manually, or a flow repeated 3 times is proposed automatically)",
	"tool.empty.hint": "A capability = entry command + doc + scope, one-click runnable (dry-run by default); repeated flows also auto-fixate into sequences.",
	"tool.steps": "Steps",
	"tool.params": "Parameters",
	"tool.uses": "Uses",
	"tool.live": "registered",
	"tool.offline": "not registered",
	"tool.retire": "Retire",
	"tool.enable": "Enable",
	"tool.delete": "Delete",
	"tool.deleteConfirm": "Confirm delete",
	"tool.desc.save": "Save",
	"tool.desc.edit": "Edit title/tags/description",
	"tool.kind.capability": "capability",
	"tool.kind.sequence": "sequence",
	"tool.detail.toggle": "Expand/collapse the capability detail",
	"tool.detail.kind": "Kind",
	"tool.detail.version": "Version",
	"tool.detail.builtin": "builtin v{version}",
	"tool.detail.created": "Created",
	"tool.detail.lastUsed": "Last used",
	"tool.detail.entry": "Entry",
	"tool.detail.doc": "Doc",
	"tool.detail.scope": "Scope",
	"tool.detail.route": "Routing",
	"tool.detail.run": "Execution",
	"tool.detail.noRun": "routing/doc only, never executes",
	"tool.detail.dryRun": "dry-run first",
	"tool.detail.realRun": "runs directly",
	"tool.detail.confirm": "confirm required",
	"tool.detail.stats": "Usage",
	"tool.detail.success": "ok",
	"tool.detail.fail": "fail",
	"tool.detail.streak": "consecutive failures",
	"tool.detail.last": "last run",
	"tool.detail.ok": "succeeded",
	"tool.detail.failed": "failed",
	"tool.detail.preview": "dry-run",
	"tool.detail.lastSummary": "Last result",
	"tool.detail.health": "Health",
	"tool.detail.missing": "(missing)",
	"launch.title": "Quick new session",
	"launch.workspace": "Workspace",
	"launch.preset": "Agent mode",
	"launch.model": "Model",
	"launch.permission": "Permission",
	"launch.default": "Default",
	"launch.defaultMark": "default",
	"launch.sets": "Topic sets (multi-select)",
	"launch.start": "Create hub session",
	"launch.startSets": "Create topic-set session",
	"launch.hint": "Leave empty for a plain hub session; selected sets bind the new session to them.",
	"launch.needWorkspace": "Pick a workspace first.",
	"composer.title": "Hub conversation",
	"composer.desc": "Say what the hub should do; the session is created and the message delivered in place.",
	"composer.placeholder": "e.g. tidy this repo’s memories and dispatch a branch to add tests…",
	"composer.start": "Start conversation",
	"composer.createOnly": "Create only",
	"composer.createOnly.hint": "Create the session without sending a message",
	"composer.hint": "Ctrl/Cmd + Enter to send",
	"composer.newSet": "+ New topic set",
	"composer.setsEmpty": "No topic sets in this workspace yet",
	"composer.open": "Open session",
	"composer.dismiss": "Dismiss",
	"composer.receipt.hub": "Hub session",
	"composer.receipt.sets": "Topic-set session",
	"newSession.create": "New topic set…",
	"workspace.label": "Workspace",
	"side.set": "topic set",
	"topic.root": "hub",
	"topic.branch": "branch",
	"chat.live": "live",
	"chat.cold": "not running",
	"chat.empty": "(no messages yet)",
	"chat.empty.hint": "Type below and send: the message goes straight into this session and replies refresh automatically.",
	"chat.placeholder": "Message this session…",
	"chat.send": "Send",
	"chat.refresh": "Refresh",
	"chat.open": "Open in DSH",
	"chat.truncated": "recent messages only",
	"chat.hint": "Ctrl/Cmd + Enter sends; the panel polls the session for new replies.",
	"chat.you": "You",
	"chat.assistant": "Assistant",
	"chat.tool": "Tool",
	"memory.modal.title": "Edit memory",
	"memory.modal.hint": "Record conclusions only: reusable facts/decisions. Keep process steps in the conversation; title and tags are the index.",
	"hubPolicy.model": "{count} whitelisted · everything else denied by default",
	"hubPolicy.hint": "A hub may call only whitelisted tools; anything else is denied, including future tools nobody reviewed yet. The catalog is regenerated from the runtime on every open/refresh; a save takes effect on the next tool call.",
	"hubPolicy.source.stored": "Workspace custom",
	"hubPolicy.source.default": "Built-in default",
	"hubPolicy.reset": "Restore default",
	"hubPolicy.save": "Save",
	"hubPolicy.loading": "(reading the whitelist…)",
	"hubPolicy.loading.hint": "A read failure falls back to the built-in default; the dispatch link is never broken.",
	"hubPolicy.locked": "Locked",
	"hubPolicy.locked.tip": "Core locked entry: dispatch / relay / user question / the run_code transport. Removing it would leave a hub unable to dispatch, so it cannot be switched off.",
	"hubPolicy.risk": "Hands-on",
	"hubPolicy.risk.tip": "Hands-on execution tool: a hub is supposed to dispatch these to a branch. Enabling one lets the hub do the work itself.",
	"hubPolicy.note.pluginManager": "Switching this off also stops a hub from reloading the plugin (use the host plugin page).",
	"hubPolicy.custom.placeholder": "Add a custom tool name (unknown tools are denied until whitelisted here)",
	"hubPolicy.custom.add": "Add",
	"hubPolicy.catalog.dynamic": "Dynamic catalog",
	"hubPolicy.catalog.fallback": "Built-in fallback",
	"hubPolicy.catalog.meta": "{tools} tools / {groups} groups",
	"hubPolicy.refresh": "Refresh catalog",
	"hubPolicy.lastRefresh": "Last refreshed {time}",
	"hubPolicy.search.placeholder": "Search tool names or descriptions (across source groups)",
	"hubPolicy.empty": "No matching tools",
	"hubPolicy.empty.hint": "Try another keyword, or press \"Refresh catalog\" to re-read the runtime tools.",
	"hubPolicy.group.count": "{count} entries",
	"hubPolicy.group.enabled": "{enabled} enabled",
	"hubPolicy.group.match": "{count} of {total} match",
	"hubPolicy.group.expand": "Expand this source",
	"hubPolicy.group.collapse": "Collapse this source",
	"hubPolicy.inferred": "Source inferred",
	"hubPolicy.inferred.tip": "Host tool definitions carry no source field, so groups are inferred from naming prefixes and plugin ownership (explainable, not exact). If a host ever declares a source, that group switches to \"declared\" automatically.",
	"hubPolicy.source.supermemory": "SuperMemory plugin",
	"hubPolicy.source.composite": "Composite capabilities (SuperMemory)",
	"hubPolicy.source.schedule": "Scheduling",
	"hubPolicy.source.hostSession": "Host session tools",
	"hubPolicy.source.host": "Host built-in / unattributed",
	"hubPolicy.source.mcp": "MCP · {server}",
	"hubPolicy.synthetic": "synthetic",
	"hubPolicy.synthetic.tip": "Not on the global registration surface (host-reserved name / agent-scope registration / session-level API), yet callable from a hub session. Never stale and never removed by cleanup.",
	"hubPolicy.catalog.synthetic": "{count} synthetic",
	"hubPolicy.group.stale": "Stale entries",
	"hubPolicy.stale.tip": "Whitelisted names that no longer exist at runtime (uninstalled or renamed tools). \"Clean up\" first saves the current whitelist, then removes them; locked entries are never removed.",
	"hubPolicy.stale.badge": "stale",
	"hubPolicy.stale.clean": "Clean up ({count})",
	"hubPolicy.viaPrefix": "via prefix",
	"hubPolicy.viaPrefix.tip": "This tool is allowed by a prefix rule; remove the prefix entry in this group to take it out of the whitelist.",
	"badge.hubSet": "Topic set",
	"badge.hubSet.tip": "Hub session of a topic set · {title}",
	"badge.branch": "Branch",
	"badge.tip": "Topic-set branch · {title}",
	"badge.hub": "Hub",
	"badge.hub.tip": "SuperMemory hub session",
	"error.load": "Load failed",
	"error.retry": "Retry",
	"error.generic": "Operation failed",
	"ok.saved": "Saved",
	"chat.card.from": "Execution requested by {session}",
	"chat.card.kind.hub": "Hub dispatch",
	"chat.card.kind.branch": "Branch report",
	"chat.card.kind.group": "Parallel group report",
	"chat.card.kind.system": "System notice",
	"chat.card.task": "Task",
	"chat.card.topicSet": "Topic set",
	"chat.card.capability": "Capability",
	"chat.card.dispatch": "Dispatch receipt",
	"chat.card.sourceId": "Source session",
	"chat.card.expand": "Expand details",
	"chat.card.collapse": "Collapse",
	"chat.card.empty": "(no text)"
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
// src/client/open-dispatch.ts
const listeners$1 = /* @__PURE__ */ new Set();
/** The receipt a not-yet-mounted panel should show on mount. */
let pending;
/**
* Deliver one receipt to every live listener (each mounted panel page) and
* keep it for the next mount when nobody is listening yet. One throwing
* listener never blocks the others.
*/
function publishHubReceipt(receipt) {
	if (listeners$1.size === 0) pending = receipt;
	for (const listener of [...listeners$1]) try {
		listener(receipt);
	} catch {}
}
/**
* Subscribe to receipts. Returns the unsubscribe function; call it from the
* effect cleanup so a remount never leaks a listener.
*/
function subscribeHubReceipt(listener) {
	listeners$1.add(listener);
	return () => {
		listeners$1.delete(listener);
	};
}
/**
* Take the receipt published before this panel mounted (and clear it, so a
* later remount never shows a stale creation). Undefined when there is none.
*/
function takePendingHubReceipt() {
	const receipt = pending;
	pending = void 0;
	return receipt;
}
// src/rail-selection.ts
/**
* @param view - current panel view.
* @param hubSessionId - the rail row being tested.
* @param shellSessionId - the host session the panel was opened for.
* @returns true for exactly one row in any given state.
*/
function isRailCurrent(view, hubSessionId, shellSessionId) {
	if (view.kind === "chat") return !!view.id && view.id === hubSessionId;
	return !!shellSessionId && shellSessionId === hubSessionId;
}
// src/client/panel-page.tsx
/**
* SuperMemory main panel (the `main` slot keyed by panel id 'supermemory').
* Level 1 shows the hub session and the workspace's topic sets; level 2
* opens one topic set (its branch sessions, reply box and summary); the
* Memories tab is two levels (R30 需求②): 记忆集卡片 → 集合内条目（带版本
* 徽标）→ 记忆详情（完整正文 + 历史版本）；the Tools tab lists and edits
* composite tools (R6) with their lifecycle timestamps (R28 需求②).
* @module supermemory/client/panel-page
*/
/**
* R22 需求③: one composite tool / capability rendered as readable detail rows.
* Every field comes from the host (panel.listTools now ships routeNote /
* builtin / scopeMissing / docMissing / notes); a missing field is simply
* omitted — never printed as "undefined".
*/
function capabilityDetail(tool, t) {
	const rows = [];
	const row = (key, label, value) => {
		rows.push((0, react.createElement)("div", {
			key,
			className: "sm-kv"
		}, (0, react.createElement)("span", {
			key: "k",
			className: "sm-kv-k"
		}, label), (0, react.createElement)("span", {
			key: "v",
			className: "sm-kv-v"
		}, value)));
	};
	const code = (key, value) => (0, react.createElement)("code", {
		key,
		className: "sm-code"
	}, value);
	row("kind", t("tool.detail.kind"), tool.kind === "capability" ? t("tool.kind.capability") : t("tool.kind.sequence"));
	if (tool.version !== void 0) row("version", t("tool.detail.version"), `v${tool.version}` + (tool.builtin && tool.builtinVersion !== void 0 ? ` · ${t("tool.detail.builtin", { version: tool.builtinVersion })}` : ""));
	if (tool.createdAt !== void 0 || tool.usage?.lastUsedAt !== void 0) {
		row("created", t("tool.detail.created"), fmtTime(tool.createdAt));
		row("lastUsed", t("tool.detail.lastUsed"), fmtTime(tool.usage?.lastUsedAt));
	}
	if (tool.entry) row("entry", t("tool.detail.entry"), code("code", tool.entry));
	if (tool.doc) row("doc", t("tool.detail.doc"), (0, react.createElement)("span", null, code("code", tool.doc), tool.docMissing ? (0, react.createElement)("span", {
		key: "w",
		className: "sm-warn"
	}, t("tool.detail.missing")) : null));
	if (tool.scope) row("scope", t("tool.detail.scope"), (0, react.createElement)("span", null, code("code", tool.scope), tool.scopeMissing ? (0, react.createElement)("span", {
		key: "w",
		className: "sm-warn"
	}, t("tool.detail.missing")) : null));
	if (tool.routeNote) row("route", t("tool.detail.route"), tool.routeNote);
	if (tool.kind === "capability") {
		const how = tool.runnable === false ? t("tool.detail.noRun") : [tool.dryRunArg ? `${t("tool.detail.dryRun")}（${tool.dryRunArg}）` : t("tool.detail.realRun"), tool.writeConfirm ? t("tool.detail.confirm") : null].filter(Boolean).join(" · ");
		row("run", t("tool.detail.run"), how);
	}
	const usage = tool.usage;
	const stats = [
		`${t("tool.uses")} ${tool.useCount}`,
		usage ? `${t("tool.detail.success")} ${usage.successCount} / ${t("tool.detail.fail")} ${usage.failCount}` : null,
		usage && usage.consecutiveFailures >= 2 ? `${t("tool.detail.streak")} ${usage.consecutiveFailures}` : null,
		usage?.lastStatus ? `${t("tool.detail.last")} ${usage.lastStatus === "completed" ? t("tool.detail.ok") : t("tool.detail.failed")}${usage.lastDryRun ? `（${t("tool.detail.preview")}）` : ""}` : null
	].filter(Boolean).join(" · ");
	row("stats", t("tool.detail.stats"), stats);
	if (usage?.lastSummary) row("lastSummary", t("tool.detail.lastSummary"), usage.lastSummary);
	if (tool.notes && tool.notes.length > 0) rows.push((0, react.createElement)("div", {
		key: "notes",
		className: "sm-kv"
	}, (0, react.createElement)("span", {
		key: "k",
		className: "sm-kv-k"
	}, t("tool.detail.health")), (0, react.createElement)("ul", {
		key: "v",
		className: "sm-kv-v sm-notes"
	}, tool.notes.map((note, index) => (0, react.createElement)("li", { key: index }, note)))));
	if (tool.steps.length > 0) row("steps", t("tool.steps"), tool.steps.join(" → "));
	if (tool.parameters.length > 0) row("params", t("tool.params"), tool.parameters.join("、"));
	return rows;
}
const PANEL_CSS = `
/* R18 需求⑥: 8px grid, 10px cards, hover lift, underline tabs, compact head.
   Every colour rides the host theme vocabulary (--dsw-alias-*), never a
   hardcoded palette: the panel must follow light/dark like the shell. */
.sm-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-base,#151517);font-size:13px}
.sm-panel *{box-sizing:border-box}
.sm-shell{display:flex;height:100%;min-height:0;width:100%}

/* ---- R41: settings section headings (默认模型 / 中枢权限) ---- */
.sm-section-title{font-size:11px;font-weight:600;letter-spacing:.04em;opacity:.6;margin:4px 0 0}

/* ---- left rail: hub sessions (R18 需求①) ---- */
.sm-side{display:flex;flex-direction:column;gap:8px;width:232px;flex:none;min-height:0;padding:12px 8px;border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-1,#1c1c1e)}
.sm-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px;font-size:11px;font-weight:600;letter-spacing:.04em;opacity:.55}
.sm-side-count{font-weight:400;letter-spacing:0}
.sm-side-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px}
.sm-hub{display:flex;align-items:center;gap:6px;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.sm-hub:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.sm-hub[data-current="true"]{border-color:var(--dsw-alias-link,#7aaaff);background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 14%,transparent)}
.sm-hub-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-hub-meta{font-size:9px;opacity:.6;flex:none;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-hub-set{color:var(--dsw-alias-link,#7aaaff);opacity:.85}
.sm-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent)}
.sm-side-empty{padding:10px 8px;font-size:11px;line-height:1.5;opacity:.5}
.sm-side-foot{margin-top:auto;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.sm-newhub{width:100%;justify-content:center}

/* ---- right body ---- */
.sm-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.sm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.sm-brand{font-size:13px;font-weight:650;letter-spacing:.01em}
.sm-head-sub{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.sm-pills{display:flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap}
.sm-pill{padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));font-size:10px;line-height:16px;opacity:.75;white-space:nowrap}
.sm-tabs{display:flex;align-items:stretch;gap:4px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));overflow-x:auto}
.sm-tab{padding:8px 10px;border:none;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:inherit;opacity:.62;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap;margin-bottom:-1px;transition:opacity .12s ease,border-color .12s ease}
.sm-tab:hover{opacity:.9;background:transparent}
.sm-tab[data-active="true"]{opacity:1;border-bottom-color:var(--dsw-alias-link,#7aaaff);font-weight:600;background:transparent}
.sm-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 20px}

/* ---- surfaces ---- */
.sm-card{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,#1f1f21);transition:border-color .12s ease,box-shadow .12s ease}
.sm-card:hover,.sm-item:hover{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.2))}
.sm-card h3{margin:0 0 6px;font-size:12.5px;font-weight:600;opacity:.9}
.sm-item{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,#1f1f21);transition:border-color .12s ease,transform .12s ease,box-shadow .12s ease}
.sm-item[data-clickable="true"]{cursor:pointer}
.sm-item[data-clickable="true"]:hover{border-color:var(--dsw-alias-link,#7aaaff);box-shadow:0 2px 10px rgba(0,0,0,.18)}
/* R36 需求②: 「中枢权限」开关行——label 即整行，checkbox 与标题同一基线；
   锁定行置灰且禁点，风险/锁定徽标跟在标题后。 */
.sm-item:has(> input[type="checkbox"]){display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer}
.sm-item:has(> input[type="checkbox"]:disabled){opacity:.62;cursor:not-allowed}
.sm-item > input[type="checkbox"]{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-link,#7aaaff);cursor:inherit}
.sm-item .sm-title{font-weight:600;font-size:12.5px}
.sm-item .sm-sub{opacity:.58;font-size:11px;margin-top:2px;word-break:break-all}
.sm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sm-muted{opacity:.58;font-size:11px}
.sm-list{display:flex;flex-direction:column;gap:8px}

/* ---- buttons: three levels (primary / secondary / danger), two sizes ---- */
.sm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:inherit;cursor:pointer;font-size:12px;font-family:inherit;line-height:1.4;transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.sm-btn:hover{border-color:var(--dsw-alias-link,#7aaaff)}
.sm-btn[data-size="sm"]{padding:3px 8px;font-size:11px;border-radius:7px}
.sm-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill,#f9fafb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#0f1115);font-weight:600}
.sm-btn[data-variant="primary"]:hover{background:var(--dsw-alias-button-primary-hover,#ebeef2);border-color:transparent}
.sm-btn[data-variant="danger"]{border-color:var(--dsw-alias-state-error-primary,#f25a5a);color:var(--dsw-alias-state-error-primary,#f25a5a);background:transparent}
.sm-btn[data-variant="danger"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f25a5a) 12%,transparent)}
.sm-btn:disabled{opacity:.45;cursor:default}

/* ---- fields ---- */
.sm-input,.sm-select,.sm-textarea{width:100%;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font-size:12px;font-family:inherit}
.sm-input:focus,.sm-select:focus,.sm-textarea:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-textarea{min-height:56px;resize:vertical;line-height:1.5}
.sm-field{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.sm-field .sm-field-label{font-size:11px;opacity:.55}
.sm-check{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:8px;cursor:pointer;font-size:12px}
.sm-check:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.sm-form{display:flex;gap:8px;margin-bottom:8px}
.sm-form .sm-input{flex:1}
.sm-form-col{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.sm-form-row{display:flex;gap:8px;flex-wrap:wrap}
.sm-form-row .sm-input{flex:1;min-width:120px}
.sm-form-label{font-size:11px;opacity:.55}
.sm-back{margin-bottom:8px}

/* ---- feedback ---- */
.sm-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.sm-error{color:var(--dsw-alias-state-error-primary,#f25a5a);font-size:12px;padding:8px 0}
.sm-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px;padding:4px 0}
.sm-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));opacity:.8;margin-right:4px}
.sm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:28px 12px;text-align:center;opacity:.6}
.sm-empty-art{opacity:.5;margin-bottom:2px}
.sm-empty-label{font-size:12px}
.sm-empty-hint{font-size:11px;opacity:.75;max-width:280px;line-height:1.5}
.sm-shape-hint{font-size:11px;opacity:.55;margin-top:-2px}

/* ---- composer (hub tab) ---- */
.sm-composer{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:12px;padding:14px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1,#1f1f21)}
.sm-composer-head{margin-bottom:10px}
.sm-composer-title{margin:0 0 4px;font-size:16px;font-weight:650}
.sm-composer-desc{margin:0;font-size:11.5px;opacity:.58;line-height:1.55}
.sm-composer-input{width:100%;min-height:92px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font-size:13px;font-family:inherit;resize:vertical;line-height:1.55}
.sm-composer-input:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-composer-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.sm-composer-opts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sm-opt{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;background:transparent;font-size:11px}
.sm-opt-label{opacity:.55;font-size:11px;white-space:nowrap}
.sm-opt-select{border:none;background:transparent;color:inherit;font-size:11px;padding:1px 2px;max-width:160px}
.sm-opt-select:focus{outline:none}
.sm-composer-sets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.sm-chip{padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;color:inherit;font-size:11px;cursor:pointer;font-family:inherit}
.sm-chip:hover{border-color:var(--dsw-alias-link,#7aaaff)}
.sm-chip[data-active="true"]{border-color:var(--dsw-alias-link,#7aaaff);background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 14%,transparent)}
.sm-chip[data-dashed="true"]{border-style:dashed;opacity:.75}
.sm-set-created{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;font-size:11px;opacity:.85}
.sm-receipt{border:1px solid var(--dsw-alias-link,#7aaaff);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 8%,transparent)}
.sm-receipt .sm-sub{margin-top:4px}

/* ---- retrieval shape: title + tags + body ---- */
.sm-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.sm-tag{padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));font-size:10px;opacity:.85;line-height:16px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-tag[data-hit="true"]{border-color:var(--dsw-alias-link,#7aaaff);color:var(--dsw-alias-link,#7aaaff);opacity:1}
.sm-body-text{margin-top:4px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sm-body-text[data-open="true"]{-webkit-line-clamp:unset;overflow:visible}

/* ---- R22: 派发卡片（需求②）与能力详情（需求③） ---- */
.sm-dispatch h3{margin:0}
.sm-dispatch .sm-composer-opts{margin-top:8px}
.sm-dispatch .sm-actions{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.sm-caret{flex:none;width:10px;font-size:10px;opacity:.55;text-align:center}
.sm-detail{display:flex;flex-direction:column;gap:3px;margin:8px 0 2px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
.sm-kv{display:flex;align-items:flex-start;gap:8px;font-size:11.5px;line-height:1.65}
.sm-kv-k{flex:none;width:74px;opacity:.55}
.sm-kv-v{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
.sm-code{display:inline-block;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#2c2c2e);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;word-break:break-all}
.sm-notes{margin:0;padding-left:15px}
.sm-warn{margin-left:4px;font-size:10.5px;color:var(--dsw-alias-state-error-primary,#f25a5a)}
/* ---- R39: dynamic hub-policy catalog (source groups, collapse, stale) ---- */
.sm-chevbtn{flex:none;background:none;border:0;padding:0;margin:0;color:inherit;font:inherit;font-size:11px;opacity:.6;cursor:pointer;line-height:1}
.sm-chevbtn:hover{opacity:1}
.sm-desc{flex:1 1 100%;font-size:11px;line-height:1.5;opacity:.58;word-break:break-word;margin-top:2px}
.sm-warnbox{margin-top:6px;padding:6px 9px;border:1px solid var(--dsw-alias-state-warning-primary,#e8a33d);border-radius:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warning-primary,#e8a33d);word-break:break-word}

/* ---- R19: global workspace selector, in-panel chat, memory modal ---- */
.sm-ws{display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.9;min-width:0}
.sm-ws-select{max-width:280px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;background:transparent;color:inherit;font-size:11px;padding:2px 7px;font-family:inherit}
.sm-ws-select:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-chat{display:flex;flex-direction:column;gap:8px}
.sm-chat-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));margin-bottom:4px}
.sm-msg{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1f1f21)}
.sm-msg[data-role="user"]{border-color:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 7%,transparent)}
.sm-msg[data-role="tool"]{opacity:.72}
.sm-msg-role{font-size:10px;opacity:.55;letter-spacing:.04em}
.sm-msg-text{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.6}
.sm-msg[data-role="tool"] .sm-msg-text{font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.sm-chat-bar{display:flex;align-items:flex-end;gap:8px;margin-top:8px}
.sm-chat-bar textarea{flex:1;min-height:60px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font-family:inherit;font-size:12.5px;resize:vertical;line-height:1.5}
.sm-chat-bar textarea:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.52)}
.sm-modal{width:min(560px,100%);max-height:82vh;overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1f1f21);box-shadow:0 18px 48px rgba(0,0,0,.4)}
.sm-modal h3{margin:0 0 10px;font-size:14px;font-weight:650}
.sm-modal-hint{font-size:11px;opacity:.58;line-height:1.55;margin:-4px 0 10px}

/* ---- narrow windows: the rail folds into a horizontal strip ---- */
@media (max-width:760px){
  .sm-shell{flex-direction:column}
  .sm-side{width:auto;flex:none;flex-direction:row;align-items:center;gap:8px;padding:8px;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));overflow:hidden}
  .sm-side-head{padding:0;white-space:nowrap}
  .sm-side-count{display:none}
  .sm-side-list{flex-direction:row;overflow-x:auto;overflow-y:hidden;gap:6px;min-width:0}
  .sm-hub{width:auto;max-width:180px;flex:none}
  .sm-side-foot{margin:0;padding:0;border:none;flex:none}
  .sm-newhub{width:auto;white-space:nowrap}
  .sm-body{padding:10px 12px 16px}
}
`;
let cssInstalled$1 = false;
function installCss$1() {
	if (cssInstalled$1 || typeof document === "undefined") return;
	cssInstalled$1 = true;
	const style = document.createElement("style");
	style.setAttribute("data-plugin", "dsh-supermemory");
	style.textContent = PANEL_CSS;
	document.head.append(style);
}
function Button(props) {
	return (0, react.createElement)("button", {
		type: "button",
		className: ["sm-btn", props.className].filter(Boolean).join(" "),
		"data-variant": props.variant,
		"data-size": props.size,
		disabled: props.disabled,
		title: props.title,
		onClick: props.onClick
	}, props.label);
}
/**
* R18 需求⑥: illustration-style empty state. A tiny inline SVG (drawn with the
* theme's own label colour) replaces the bare "暂无" line everywhere.
*/
function EmptyState(props) {
	return (0, react.createElement)("div", { className: "sm-empty" }, (0, react.createElement)("svg", {
		key: "art",
		className: "sm-empty-art",
		width: 48,
		height: 48,
		viewBox: "0 0 48 48",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.6,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
		focusable: false
	}, (0, react.createElement)("rect", {
		key: "a",
		x: 9,
		y: 13,
		width: 30,
		height: 23,
		rx: 4
	}), (0, react.createElement)("path", {
		key: "b",
		d: "M9 20h30"
	}), (0, react.createElement)("circle", {
		key: "c",
		cx: 15,
		cy: 17,
		r: 1.4,
		fill: "currentColor",
		stroke: "none"
	}), (0, react.createElement)("path", {
		key: "d",
		d: "M16 27h12"
	}), (0, react.createElement)("path", {
		key: "e",
		d: "M16 31h8"
	})), (0, react.createElement)("div", {
		key: "label",
		className: "sm-empty-label"
	}, props.label), props.hint ? (0, react.createElement)("div", {
		key: "hint",
		className: "sm-empty-hint"
	}, props.hint) : null);
}
/** R19 协同②: coarse relative time for branch cards, localized (no date lib). */
function branchAgo(at, t) {
	if (!Number.isFinite(at) || at <= 0) return "—";
	const delta = Math.max(0, Date.now() - at);
	if (delta < 6e4) return t("branches.ago.just");
	if (delta < 36e5) return t("branches.ago.min", { count: Math.floor(delta / 6e4) });
	if (delta < 864e5) return t("branches.ago.hour", { count: Math.floor(delta / 36e5) });
	return t("branches.ago.day", { count: Math.floor(delta / 864e5) });
}
/**
* R28 需求②: local YYYY-MM-DD HH:mm for the capability lifecycle timestamps
* (增加时间 / 最后使用). A missing or nonsensical value renders '—' — the host
* ships these fields from R28 on, older hosts simply leave them undefined.
*/
function fmtTime(at) {
	if (at === void 0 || !Number.isFinite(at) || at <= 0) return "—";
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
* R19 协同②: the hub's linked branches. One card, every consumer (hub tab and
* the in-panel chat of a hub) passes its own rows; a branch row opens that
* branch's conversation in the panel.
*/
function BranchList(props) {
	const rows = Array.isArray(props.rows) ? props.rows : [];
	const { t, onOpen } = props;
	return (0, react.createElement)("div", {
		key: "branches",
		className: "sm-card"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-row"
	}, (0, react.createElement)("h3", { key: "title" }, t("branches.title")), (0, react.createElement)("span", {
		key: "count",
		className: "sm-badge"
	}, String(rows.length))), rows.length === 0 ? (0, react.createElement)(EmptyState, {
		key: "empty",
		label: t("branches.empty"),
		hint: props.compact ? void 0 : t("branches.empty.hint")
	}) : (0, react.createElement)("div", {
		key: "list",
		className: "sm-list"
	}, rows.map((row) => (0, react.createElement)("div", {
		key: row.branchSessionId,
		className: "sm-item",
		"data-clickable": "true",
		title: `${row.title} · ${row.branchSessionId}`,
		onClick: () => onOpen(row.branchSessionId)
	}, (0, react.createElement)("div", {
		key: "row",
		className: "sm-row"
	}, (0, react.createElement)("span", {
		key: "title",
		className: "sm-title"
	}, row.title), (0, react.createElement)("span", {
		key: "state",
		className: "sm-badge",
		"data-state": row.status
	}, t(`branches.${row.status}`)), row.shared ? (0, react.createElement)("span", {
		key: "shared",
		className: "sm-badge",
		title: row.hubs.join("、")
	}, t("branches.shared", { count: row.hubs.length - 1 })) : null, row.groupId ? (0, react.createElement)("span", {
		key: "grp",
		className: "sm-badge"
	}, t("branches.group")) : null), (0, react.createElement)("div", {
		key: "meta",
		className: "sm-sub"
	}, `${row.topicSetTitle ? t("branches.set", { title: row.topicSetTitle }) : t("branches.noSet")} · ${branchAgo(row.lastActivityAt, t)} · ${t("branches.dispatches", { count: row.dispatches })}`), row.tags && row.tags.length > 0 ? tagChips(row.tags) : null, (0, react.createElement)("div", {
		key: "id",
		className: "sm-sub"
	}, row.branchSessionId)))));
}
/** Tag chips: the record's index fields, rendered beside the title. */
function tagChips(tags, needle = "") {
	const list = (tags ?? []).filter(Boolean);
	if (list.length === 0) return null;
	const lowered = needle.trim().toLowerCase();
	return (0, react.createElement)("div", { className: "sm-tags" }, list.map((tag) => (0, react.createElement)("span", {
		key: tag,
		className: "sm-tag",
		"data-hit": String(lowered.length > 0 && tag.toLowerCase().includes(lowered)),
		title: tag
	}, tag)));
}
/** Split a tag input ("a，b c" / "a,b") into the array the host expects. */
function splitTags(raw) {
	return String(raw ?? "").split(/[,，、;；\s]+/).map((tag) => tag.trim()).filter(Boolean);
}
/** Client-side title fallback for records written before titles existed. */
function deriveTitleClient(body) {
	const clean = String(body ?? "").replace(/\s+/g, " ").trim();
	if (!clean) return "";
	const clause = clean.split(/[。！？；;.!?]/)[0]?.trim() || clean;
	return clause.length <= 48 ? clause : `${clause.slice(0, 47)}…`;
}
/** The SuperMemory main panel page. */
function SupermemoryPanelPage(props) {
	installCss$1();
	const { t, api } = props;
	const [view, setView] = (0, react.useState)({ kind: "hub" });
	const [hub, setHub] = (0, react.useState)();
	const [memoryCollections, setMemoryCollections] = (0, react.useState)([]);
	const [collectionMemories, setCollectionMemories] = (0, react.useState)([]);
	const [memoryDetail, setMemoryDetail] = (0, react.useState)();
	const [hubPolicy, setHubPolicy] = (0, react.useState)();
	const [hubPolicyDraft, setHubPolicyDraft] = (0, react.useState)();
	const [hubPolicyCustom, setHubPolicyCustom] = (0, react.useState)("");
	const [hubPolicyQuery, setHubPolicyQuery] = (0, react.useState)("");
	const [hubPolicyCollapsed, setHubPolicyCollapsed] = (0, react.useState)([]);
	const [modelDefaults, setModelDefaults] = (0, react.useState)();
	const [hubModelDraft, setHubModelDraft] = (0, react.useState)("");
	const [skills, setSkills] = (0, react.useState)([]);
	const [skillDrafts, setSkillDrafts] = (0, react.useState)({});
	const [branchModelDraft, setBranchModelDraft] = (0, react.useState)("");
	const [tools, setTools] = (0, react.useState)([]);
	const [loading, setLoading] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)();
	const [notice, setNotice] = (0, react.useState)();
	const [query, setQuery] = (0, react.useState)("");
	const [memoryQuery, setMemoryQuery] = (0, react.useState)("");
	const [setsQuery, setSetsQuery] = (0, react.useState)("");
	const [reply, setReply] = (0, react.useState)("");
	const [summaryDraft, setSummaryDraft] = (0, react.useState)();
	const [summaryTagsDraft, setSummaryTagsDraft] = (0, react.useState)();
	const [editingMemory, setEditingMemory] = (0, react.useState)();
	const [editingTool, setEditingTool] = (0, react.useState)();
	const [confirmDeleteTool, setConfirmDeleteTool] = (0, react.useState)();
	const [expandedTool, setExpandedTool] = (0, react.useState)();
	const [confirmDeleteMemory, setConfirmDeleteMemory] = (0, react.useState)();
	const [expandedVersion, setExpandedVersion] = (0, react.useState)();
	const [presets, setPresets] = (0, react.useState)([]);
	const [catalog, setCatalog] = (0, react.useState)();
	const [permissions, setPermissions] = (0, react.useState)();
	const [workspacePath, setWorkspacePath] = (0, react.useState)("");
	const [launchPreset, setLaunchPreset] = (0, react.useState)("");
	const [launchModel, setLaunchModel] = (0, react.useState)("");
	const [launchPermission, setLaunchPermission] = (0, react.useState)("");
	const [launchSets, setLaunchSets] = (0, react.useState)([]);
	const [launchSelected, setLaunchSelected] = (0, react.useState)([]);
	const [launchNewTitle, setLaunchNewTitle] = (0, react.useState)("");
	const [launching, setLaunching] = (0, react.useState)(false);
	const [composerText, setComposerText] = (0, react.useState)("");
	const [showNewSet, setShowNewSet] = (0, react.useState)(false);
	const [receipt, setReceipt] = (0, react.useState)();
	const [hubs, setHubs] = (0, react.useState)([]);
	const [hubBranches, setHubBranches] = (0, react.useState)([]);
	const [chatBranches, setChatBranches] = (0, react.useState)([]);
	const [allSets, setAllSets] = (0, react.useState)([]);
	const [allBranches, setAllBranches] = (0, react.useState)([]);
	const [branchFilter, setBranchFilter] = (0, react.useState)("");
	const [branchQuery, setBranchQuery] = (0, react.useState)("");
	const [createdSet, setCreatedSet] = (0, react.useState)();
	const [chatData, setChatData] = (0, react.useState)();
	const [chatDraft, setChatDraft] = (0, react.useState)("");
	const [chatSending, setChatSending] = (0, react.useState)(false);
	const [chatError, setChatError] = (0, react.useState)();
	const workspaces = props.useWorkspaces((state) => state.items);
	const sessionId = props.useSessions((state) => {
		for (const session of Object.values(state.byId)) if ((session.retainedBy?.mainView ?? 0) > 0) return session.id;
		return "";
	});
	const sessionCwd = props.useSessions((state) => {
		for (const session of Object.values(state.byId)) if ((session.retainedBy?.mainView ?? 0) > 0) return String(session.header?.cwd ?? "");
		return "";
	});
	const cwd = (0, react.useMemo)(() => workspacePath || sessionCwd || workspaces[0]?.path || "", [
		workspacePath,
		sessionCwd,
		workspaces
	]);
	(0, react.useEffect)(() => {
		if (workspacePath) {
			if (workspaces.length === 0 || workspaces.some((workspace) => workspace.path === workspacePath)) return;
		}
		let remembered = "";
		try {
			remembered = localStorage.getItem("sm-panel-ws") || "";
		} catch {}
		const known = (path) => workspaces.length === 0 || workspaces.some((workspace) => workspace.path === path);
		const next = remembered && known(remembered) ? remembered : sessionCwd || workspaces[0]?.path || "";
		if (next) setWorkspacePath(next);
	}, [
		sessionCwd,
		workspacePath,
		workspaces
	]);
	const [lastSessionCwd, setLastSessionCwd] = (0, react.useState)("");
	(0, react.useEffect)(() => {
		if (!sessionCwd) return;
		if (lastSessionCwd && lastSessionCwd !== sessionCwd) setWorkspacePath(sessionCwd);
		if (sessionCwd !== lastSessionCwd) setLastSessionCwd(sessionCwd);
	}, [sessionCwd, lastSessionCwd]);
	/** Switch the panel's one workspace and reset every workspace-scoped view. */
	const changeWorkspace = (0, react.useCallback)((path) => {
		if (!path || path === workspacePath) return;
		setWorkspacePath(path);
		try {
			localStorage.setItem("sm-panel-ws", path);
		} catch {}
		setHub(void 0);
		setHubs([]);
		setHubBranches([]);
		setChatBranches([]);
		setAllSets([]);
		setAllBranches([]);
		setBranchFilter("");
		setLaunchSelected([]);
		setLaunchSets([]);
		setReceipt(void 0);
		setCreatedSet(void 0);
		setTools([]);
		setMemoryCollections([]);
		setCollectionMemories([]);
		setMemoryDetail(void 0);
		setChatData(void 0);
		setChatDraft("");
		setChatError(void 0);
		setView({ kind: "hub" });
	}, [workspacePath]);
	const refreshHub = (0, react.useCallback)(async () => {
		if (!cwd) return;
		setLoading(true);
		setError(void 0);
		try {
			const [state, hubRows, branchRows, setRows, allBranchRows] = await Promise.all([
				api.loadHub(cwd, sessionId),
				api.listHubSessions(cwd).then((rows) => rows, () => []),
				sessionId ? api.listHubBranches(cwd, sessionId).then((rows) => rows, () => []) : Promise.resolve([]),
				api.listAllTopicSets(cwd).then((rows) => rows, () => []),
				api.listAllBranches(cwd).then((rows) => rows, () => [])
			]);
			setHub(state);
			setHubs(hubRows);
			setHubBranches(branchRows);
			setAllSets(setRows);
			setAllBranches(allBranchRows);
			api.invalidateBadges();
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
	const refreshMemoryCollections = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			setMemoryCollections(await api.listMemoryCollections(cwd));
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const refreshCollectionMemories = (0, react.useCallback)(async (collectionId) => {
		if (!cwd) return;
		try {
			setCollectionMemories(await api.listMemoriesByCollection(cwd, collectionId, query.trim() || void 0));
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		query,
		t
	]);
	const refreshMemoryDetail = (0, react.useCallback)(async (id) => {
		if (!cwd) return;
		try {
			setMemoryDetail(await api.getMemoryDetail(cwd, id));
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const refreshModelDefaults = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			const view = await api.getModelDefaults(cwd);
			setModelDefaults(view);
			setHubModelDraft(view.hub ? `${view.hub.provider}/${view.hub.model}` : "");
			setBranchModelDraft(view.branch ? `${view.branch.provider}/${view.branch.model}` : "");
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const refreshSkills = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			const rows = await api.listSkills(cwd);
			setSkills(rows);
			setSkillDrafts(Object.fromEntries(rows.map((row) => [row.name, row.description])));
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const refreshHubPolicy = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			const view = await api.getHubPolicy(cwd);
			setHubPolicy(view);
			setHubPolicyDraft({
				tools: [...view.tools],
				prefixes: [...view.prefixes]
			});
			setHubPolicyCustom("");
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const refreshHubPolicyCatalog = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			const view = await api.getHubPolicy(cwd);
			setHubPolicy(view);
			setHubPolicyDraft((draft) => draft ?? {
				tools: [...view.tools],
				prefixes: [...view.prefixes]
			});
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const refreshMemoryViews = (0, react.useCallback)(() => {
		if (view.kind === "memory-collection") refreshCollectionMemories(view.id);
		else if (view.kind === "memory-detail") refreshMemoryDetail(view.id);
		else refreshMemoryCollections();
		refreshHub();
	}, [
		view,
		refreshCollectionMemories,
		refreshMemoryDetail,
		refreshMemoryCollections,
		refreshHub
	]);
	const openMemoryDetail = (0, react.useCallback)((id) => {
		setExpandedVersion(void 0);
		setMemoryDetail(void 0);
		setView({
			kind: "memory-detail",
			id
		});
	}, []);
	const backFromMemoryDetail = (0, react.useCallback)(() => {
		setExpandedVersion(void 0);
		setView({
			kind: "memory-collection",
			id: memoryDetail?.view.collectionId ?? ""
		});
	}, [memoryDetail]);
	const refreshTools = (0, react.useCallback)(async () => {
		if (!cwd) return;
		try {
			setTools(await api.listTools(cwd));
		} catch (loadError) {
			setError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	(0, react.useEffect)(() => {
		refreshHub();
	}, [refreshHub]);
	(0, react.useEffect)(() => {
		if (view.kind === "memories") refreshMemoryCollections();
	}, [view, refreshMemoryCollections]);
	(0, react.useEffect)(() => {
		if (view.kind === "memory-collection") refreshCollectionMemories(view.id);
	}, [view, refreshCollectionMemories]);
	(0, react.useEffect)(() => {
		if (view.kind === "memory-detail") refreshMemoryDetail(view.id);
	}, [view, refreshMemoryDetail]);
	(0, react.useEffect)(() => {
		if (view.kind === "settings") {
			refreshHubPolicy();
			refreshModelDefaults();
			refreshSkills();
		}
	}, [
		view,
		refreshHubPolicy,
		refreshSkills
	]);
	(0, react.useEffect)(() => {
		if (view.kind === "tools") refreshTools();
	}, [view, refreshTools]);
	(0, react.useEffect)(() => {
		if (view.kind !== "branches" || !cwd) return;
		if (allBranches.length > 0) return;
		api.listAllBranches(cwd).then(setAllBranches, () => []);
	}, [
		view,
		cwd,
		api,
		allBranches.length
	]);
	(0, react.useEffect)(() => {
		const show = (incoming) => {
			setView({ kind: "hub" });
			setReceipt(incoming);
			refreshHub();
		};
		const unsubscribe = subscribeHubReceipt(show);
		const pending = takePendingHubReceipt();
		if (pending) show(pending);
		return unsubscribe;
	}, [refreshHub]);
	const loadChat = (0, react.useCallback)(async (id) => {
		try {
			const [data, branches] = await Promise.all([api.readSessionMessages(id, 80), cwd ? api.listHubBranches(cwd, id).then((rows) => rows, () => []) : Promise.resolve([])]);
			setChatData(data);
			setChatBranches(branches);
			setChatError(void 0);
		} catch (loadError) {
			setChatError(`${t("error.load")}: ${String(loadError instanceof Error ? loadError.message : loadError)}`);
		}
	}, [
		api,
		cwd,
		t
	]);
	const openChat = (0, react.useCallback)((id) => {
		setChatData(void 0);
		setChatDraft("");
		setChatError(void 0);
		setView({
			kind: "chat",
			id
		});
	}, []);
	(0, react.useEffect)(() => {
		if (view.kind !== "chat") return;
		const id = view.id;
		loadChat(id);
		const timer = setInterval(() => {
			if (typeof document === "undefined" || !document.hidden) loadChat(id);
		}, 2500);
		return () => clearInterval(timer);
	}, [loadChat, view]);
	const sendChat = async (id) => {
		const text = chatDraft.trim();
		if (!text) return;
		setChatSending(true);
		setChatError(void 0);
		try {
			const result = await api.sendSessionMessage(id, text);
			if (result.status === "ok") {
				setChatDraft("");
				await loadChat(id);
			} else setChatError(result.message);
		} catch (sendError) {
			setChatError(`${t("error.generic")}: ${String(sendError instanceof Error ? sendError.message : sendError)}`);
		} finally {
			setChatSending(false);
		}
	};
	(0, react.useEffect)(() => {
		let alive = true;
		api.listAgentPresets().then((rows) => {
			if (alive) setPresets(rows);
		}, () => {});
		api.listModelCatalog().then((rows) => {
			if (alive) setCatalog(rows);
		}, () => {});
		api.listPermissions().then((rows) => {
			if (alive) setPermissions(rows);
		}, () => {});
		return () => {
			alive = false;
		};
	}, [api]);
	(0, react.useEffect)(() => {
		if (!cwd) return;
		let alive = true;
		api.loadTopicSets(cwd).then((rows) => {
			if (!alive) return;
			setLaunchSets(rows);
			setLaunchSelected((current) => current.filter((id) => rows.some((row) => row.id === id)));
		}, () => {
			if (alive) setLaunchSets([]);
		});
		return () => {
			alive = false;
		};
	}, [api, cwd]);
	const launchCwd = cwd;
	const launchCreateSet = async () => {
		const title = launchNewTitle.trim();
		if (!title || !launchCwd) return;
		setError(void 0);
		try {
			const created = await api.createTopicSet(launchCwd, title);
			if (created.status !== "ok" || !created.id) {
				setError(created.message);
				return;
			}
			const id = created.id;
			setLaunchNewTitle("");
			const rows = await api.loadTopicSets(launchCwd);
			setLaunchSets(rows);
			setLaunchSelected((current) => current.includes(id) ? current : [...current, id]);
			const createdRow = rows.find((row) => row.id === id);
			setCreatedSet(createdRow ? {
				title: createdRow.title,
				tags: createdRow.tags
			} : {
				title: created.message,
				tags: []
			});
			refreshHub();
		} catch (createError) {
			setError(`${t("error.generic")}: ${String(createError instanceof Error ? createError.message : createError)}`);
		}
	};
	/**
	* 需求②: one click on 「＋ 新中枢会话」 (the panel rail) creates the hub session
	* immediately — no form, no type picker — and renders the same in-place
	* receipt as the shell's 新建会话 entry.
	*
	* Defaults: the panel's current workspace; host defaults for agent preset /
	* model / permission (no options passed, so the host applies its own);
	* NO topic set, because a hub session owns none by definition — the dispatch
	* card still picks the sticky / automatically matched set when dispatching.
	*/
	const createHubNow = (0, react.useCallback)(async () => {
		if (!launchCwd) {
			setError(t("launch.needWorkspace"));
			return;
		}
		setLaunching(true);
		setError(void 0);
		setNotice(void 0);
		try {
			const result = await api.createHubSession(launchCwd, {}, "");
			if (result.status === "ok" && result.id) {
				setView({ kind: "hub" });
				setReceipt({
					id: result.id,
					message: result.message,
					kind: "hub"
				});
				setComposerText("");
				refreshHub();
			} else setError(result.message);
		} catch (createError) {
			setError(`${t("error.generic")}: ${String(createError instanceof Error ? createError.message : createError)}`);
		} finally {
			setLaunching(false);
		}
	}, [
		api,
		launchCwd,
		refreshHub,
		t
	]);
	const startLaunch = async (mode = "chat") => {
		if (!launchCwd) {
			setError(t("launch.needWorkspace"));
			return;
		}
		const text = composerText.trim();
		if (mode === "chat" && !text) return;
		setLaunching(true);
		setError(void 0);
		setNotice(void 0);
		try {
			const options = {};
			if (launchPreset) options.agentPreset = launchPreset;
			if (launchModel) {
				const slash = launchModel.indexOf("/");
				if (slash > 0) options.model = {
					provider: launchModel.slice(0, slash),
					model: launchModel.slice(slash + 1)
				};
			}
			if (launchPermission) options.permission = launchPermission;
			const ids = launchSelected;
			const opening = mode === "chat" ? text : "";
			const result = ids.length > 0 ? await api.createTopicSetSession(launchCwd, ids, options, opening) : await api.createHubSession(launchCwd, options, opening);
			if (result.status === "ok" && result.id) {
				setComposerText("");
				setReceipt({
					id: result.id,
					message: result.message,
					kind: ids.length > 0 ? "sets" : "hub"
				});
				refreshHub();
			} else setError(result.message);
		} catch (launchError) {
			setError(`${t("error.generic")}: ${String(launchError instanceof Error ? launchError.message : launchError)}`);
		} finally {
			setLaunching(false);
		}
	};
	const filteredBranchRows = (0, react.useMemo)(() => {
		const needle = branchQuery.trim().toLowerCase();
		return allBranches.filter((row) => {
			if (branchFilter && row.topicSetId !== branchFilter) return false;
			if (!needle) return true;
			return [
				row.title,
				row.branchSessionId,
				row.topicSetTitle ?? "",
				...row.tags ?? []
			].join(" ").toLowerCase().includes(needle);
		});
	}, [
		allBranches,
		branchFilter,
		branchQuery
	]);
	const filteredSets = (0, react.useMemo)(() => {
		const needle = setsQuery.trim().toLowerCase();
		const rows = hub?.topicSets ?? [];
		if (!needle) return rows;
		const inIndex = (topicSet) => topicSet.title.toLowerCase().includes(needle) || topicSet.tags.some((tag) => tag.toLowerCase().includes(needle));
		return [...rows.filter(inIndex), ...rows.filter((topicSet) => !inIndex(topicSet) && topicSet.summary.toLowerCase().includes(needle))];
	}, [hub, setsQuery]);
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
			if (result && result.status === "ok") api.invalidateBadges();
			after?.();
		} catch (actionError) {
			setError(`${t("error.generic")}: ${String(actionError instanceof Error ? actionError.message : actionError)}`);
		}
	};
	const tabActive = (kind) => {
		if (view.kind === kind) return true;
		if (kind === "hub") return view.kind === "chat";
		if (kind === "sets") return view.kind === "topic";
		if (kind === "memories") return view.kind === "memory-collection" || view.kind === "memory-detail";
		return false;
	};
	const tabProps = (kind) => ({
		"data-active": String(tabActive(kind)),
		className: "sm-tab",
		onClick: () => setView(kind === "hub" ? { kind: "hub" } : kind === "sets" ? { kind: "sets" } : kind === "branches" ? { kind: "branches" } : kind === "memories" ? { kind: "memories" } : kind === "settings" ? { kind: "settings" } : { kind: "tools" })
	});
	const hubView = [
		(0, react.createElement)("div", {
			key: "composer",
			className: "sm-card sm-dispatch"
		}, (0, react.createElement)("div", {
			key: "head",
			className: "sm-row"
		}, (0, react.createElement)("h3", { key: "title" }, t("composer.title")), (0, react.createElement)("span", {
			key: "desc",
			className: "sm-muted"
		}, t("composer.desc"))), (0, react.createElement)("textarea", {
			key: "input",
			className: "sm-textarea",
			rows: 3,
			value: composerText,
			placeholder: t("composer.placeholder"),
			onChange: (event) => setComposerText(event.target.value),
			onKeyDown: (event) => {
				if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					startLaunch("chat");
				}
			}
		}), (0, react.createElement)("div", {
			key: "opts",
			className: "sm-composer-opts"
		}, (0, react.createElement)("label", {
			key: "ws",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("launch.workspace")), (0, react.createElement)("select", {
			key: "select",
			className: "sm-opt-select",
			value: launchCwd,
			onChange: (event) => changeWorkspace(event.target.value)
		}, workspaces.length === 0 ? (0, react.createElement)("option", {
			key: "current",
			value: launchCwd
		}, launchCwd || "—") : [...launchCwd && !workspaces.some((workspace) => workspace.path === launchCwd) ? [(0, react.createElement)("option", {
			key: "current",
			value: launchCwd
		}, launchCwd)] : [], ...workspaces.map((workspace) => (0, react.createElement)("option", {
			key: workspace.id,
			value: workspace.path
		}, workspace.title || workspace.path))])), (0, react.createElement)("label", {
			key: "preset",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("launch.preset")), (0, react.createElement)("select", {
			key: "select",
			className: "sm-opt-select",
			value: launchPreset,
			onChange: (event) => setLaunchPreset(event.target.value)
		}, (0, react.createElement)("option", {
			key: "default",
			value: ""
		}, t("launch.default")), presets.map((preset) => (0, react.createElement)("option", {
			key: preset.id,
			value: preset.id,
			title: preset.description || void 0
		}, (preset.name || preset.id) + (preset.isDefault ? `（${t("launch.defaultMark")}）` : ""))))), (0, react.createElement)("label", {
			key: "model",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("launch.model")), (0, react.createElement)("select", {
			key: "select",
			className: "sm-opt-select",
			value: launchModel,
			onChange: (event) => setLaunchModel(event.target.value)
		}, (0, react.createElement)("option", {
			key: "default",
			value: ""
		}, t("launch.default")), (catalog?.models ?? []).map((model) => (0, react.createElement)("option", {
			key: `${model.provider}/${model.id}`,
			value: `${model.provider}/${model.id}`,
			title: model.name || void 0
		}, `${model.provider}/${model.id}`)))), (0, react.createElement)("label", {
			key: "permission",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("launch.permission")), (0, react.createElement)("select", {
			key: "select",
			className: "sm-opt-select",
			value: launchPermission,
			onChange: (event) => setLaunchPermission(event.target.value)
		}, (0, react.createElement)("option", {
			key: "default",
			value: "",
			title: (permissions?.options ?? []).find((option) => option.value === permissions?.defaultPreset)?.description || void 0
		}, permissions?.defaultPreset ? `${t("launch.default")}（${permissions.defaultPreset}）` : t("launch.default")), (permissions?.options ?? []).map((option) => (0, react.createElement)("option", {
			key: option.value,
			value: option.value,
			title: option.description || void 0
		}, option.name || option.value))))), (0, react.createElement)("div", {
			key: "sets",
			className: "sm-composer-sets"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("launch.sets")), launchSets.length === 0 ? (0, react.createElement)("span", {
			key: "empty",
			className: "sm-muted"
		}, t("composer.setsEmpty")) : launchSets.map((topicSet) => (0, react.createElement)("button", {
			key: topicSet.id,
			type: "button",
			className: "sm-chip",
			"data-active": String(launchSelected.includes(topicSet.id)),
			onClick: () => setLaunchSelected((current) => current.includes(topicSet.id) ? current.filter((entry) => entry !== topicSet.id) : [...current, topicSet.id])
		}, topicSet.title)), (0, react.createElement)("button", {
			key: "new",
			type: "button",
			className: "sm-chip",
			"data-dashed": "true",
			onClick: () => setShowNewSet((value) => !value)
		}, t("composer.newSet"))), showNewSet ? (0, react.createElement)("div", {
			key: "newset",
			className: "sm-form",
			style: {
				marginTop: 8,
				marginBottom: 0
			}
		}, (0, react.createElement)("input", {
			key: "input",
			className: "sm-input",
			value: launchNewTitle,
			placeholder: t("newSession.create"),
			onChange: (event) => setLaunchNewTitle(event.target.value)
		}), (0, react.createElement)(Button, {
			key: "add",
			label: t("topic.create"),
			disabled: !launchNewTitle.trim() || !launchCwd,
			onClick: () => void launchCreateSet()
		})) : null, createdSet ? (0, react.createElement)("div", {
			key: "createdSet",
			className: "sm-set-created"
		}, (0, react.createElement)("span", {
			key: "badge",
			className: "sm-badge"
		}, t("sets.created")), (0, react.createElement)("span", { key: "title" }, createdSet.title), createdSet.tags.length > 0 ? tagChips(createdSet.tags) : null) : null, (0, react.createElement)("div", {
			key: "actions",
			className: "sm-actions"
		}, (0, react.createElement)(Button, {
			key: "send",
			variant: "primary",
			label: t("composer.start"),
			disabled: launching || !composerText.trim() || !launchCwd,
			onClick: () => void startLaunch("chat")
		}), (0, react.createElement)(Button, {
			key: "createOnly",
			label: t("composer.createOnly"),
			title: t("composer.createOnly.hint"),
			disabled: launching || !launchCwd,
			onClick: () => void startLaunch("bare")
		}), (0, react.createElement)("span", {
			key: "hint",
			className: "sm-muted"
		}, t("composer.hint")))),
		receipt ? (0, react.createElement)("div", {
			key: "receipt",
			className: "sm-receipt"
		}, (0, react.createElement)("div", {
			key: "row",
			className: "sm-row"
		}, (0, react.createElement)("span", {
			key: "mark",
			className: "sm-badge"
		}, receipt.kind === "sets" ? t("composer.receipt.sets") : t("composer.receipt.hub")), (0, react.createElement)("span", { key: "text" }, receipt.message)), (0, react.createElement)("div", {
			key: "meta",
			className: "sm-sub"
		}, receipt.id), (0, react.createElement)("div", {
			key: "actions",
			className: "sm-actions"
		}, receipt.id ? (0, react.createElement)(Button, {
			key: "open",
			label: t("composer.open"),
			onClick: () => api.openSession(receipt.id)
		}) : null, (0, react.createElement)(Button, {
			key: "dismiss",
			label: t("composer.dismiss"),
			onClick: () => setReceipt(void 0)
		}))) : null,
		BranchList({
			rows: hubBranches,
			t,
			onOpen: openChat
		}),
		(0, react.createElement)("div", {
			key: "current",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, t("hub.current")), (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-muted" }, sessionId || "—"), (0, react.createElement)(Button, {
			key: "refresh",
			label: t("hub.refresh"),
			onClick: () => void refreshHub()
		})))
	];
	const branchesView = [
		(0, react.createElement)("div", {
			key: "filters",
			className: "sm-form"
		}, (0, react.createElement)("label", {
			key: "set",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "text",
			className: "sm-opt-label"
		}, t("hub.allBranches.filter")), (0, react.createElement)("select", {
			key: "select",
			className: "sm-opt-select",
			value: branchFilter,
			onChange: (event) => setBranchFilter(event.target.value)
		}, (0, react.createElement)("option", {
			key: "all",
			value: ""
		}, t("hub.allBranches.allSets")), allSets.map((topicSet) => (0, react.createElement)("option", {
			key: topicSet.id,
			value: topicSet.id
		}, topicSet.title)))), (0, react.createElement)("input", {
			key: "search",
			className: "sm-input",
			value: branchQuery,
			placeholder: t("branches.search"),
			onChange: (event) => setBranchQuery(event.target.value)
		}), (0, react.createElement)(Button, {
			key: "clear",
			label: t("sets.clear"),
			onClick: () => {
				setBranchFilter("");
				setBranchQuery("");
			}
		})),
		(0, react.createElement)("div", {
			key: "stats",
			className: "sm-muted"
		}, t("branches.stats", {
			shown: filteredBranchRows.length,
			total: allBranches.length
		})),
		(0, react.createElement)("div", {
			key: "list",
			className: "sm-list"
		}, filteredBranchRows.length === 0 ? (0, react.createElement)(EmptyState, {
			key: "empty",
			label: t("hub.allBranches.empty"),
			hint: t("hub.allBranches.hint")
		}) : filteredBranchRows.map((row) => (0, react.createElement)("div", {
			key: row.branchSessionId,
			className: "sm-item",
			"data-clickable": "true",
			title: `${row.title} · ${row.branchSessionId}`,
			onClick: () => openChat(row.branchSessionId)
		}, (0, react.createElement)("div", {
			key: "row",
			className: "sm-row"
		}, (0, react.createElement)("span", {
			key: "title",
			className: "sm-title"
		}, row.title), (0, react.createElement)("span", {
			key: "state",
			className: "sm-badge",
			"data-state": row.status
		}, t(`branches.${row.status}`)), row.shared ? (0, react.createElement)("span", {
			key: "shared",
			className: "sm-badge",
			title: row.hubs.join("、")
		}, t("branches.shared", { count: row.hubs.length - 1 })) : null, row.groupId ? (0, react.createElement)("span", {
			key: "grp",
			className: "sm-badge"
		}, t("branches.group")) : null), (0, react.createElement)("div", {
			key: "meta",
			className: "sm-sub"
		}, `${row.topicSetTitle ? t("branches.set", { title: row.topicSetTitle }) : t("branches.noSet")} · ${branchAgo(row.lastActivityAt, t)} · ${t("branches.dispatches", { count: row.dispatches })}`), row.tags && row.tags.length > 0 ? tagChips(row.tags) : null, (0, react.createElement)("div", {
			key: "id",
			className: "sm-sub"
		}, row.branchSessionId))))
	];
	const setsView = [
		(0, react.createElement)("div", {
			key: "search",
			className: "sm-form"
		}, (0, react.createElement)("input", {
			key: "input",
			className: "sm-input",
			value: setsQuery,
			placeholder: t("sets.search"),
			onChange: (event) => setSetsQuery(event.target.value)
		}), (0, react.createElement)(Button, {
			key: "clear",
			label: t("sets.clear"),
			onClick: () => setSetsQuery("")
		})),
		(0, react.createElement)("div", {
			key: "stats",
			className: "sm-muted"
		}, t("sets.stats", {
			shown: filteredSets.length,
			total: hub?.topicSets.length ?? 0
		})),
		(0, react.createElement)("div", {
			key: "list",
			className: "sm-list"
		}, filteredSets.length === 0 ? (0, react.createElement)(EmptyState, {
			key: "empty",
			label: t("sets.empty"),
			hint: t("sets.empty.hint")
		}) : filteredSets.map((topicSet) => (0, react.createElement)("div", {
			key: topicSet.id,
			className: "sm-item",
			"data-clickable": "true",
			onClick: () => {
				setView({
					kind: "topic",
					id: topicSet.id
				});
				setSummaryDraft(void 0);
				setSummaryTagsDraft(void 0);
				setReply("");
			}
		}, (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-title" }, topicSet.title), hub?.activeTopicSetId === topicSet.id ? (0, react.createElement)("span", {
			key: "a",
			className: "sm-badge"
		}, t("hub.active")) : null, (0, react.createElement)("span", {
			key: "n",
			className: "sm-badge"
		}, t("sets.sessions", { count: topicSet.sessions })), topicSet.live > 0 ? (0, react.createElement)("span", {
			key: "l",
			className: "sm-badge"
		}, t("sets.live", { count: topicSet.live })) : null, topicSet.model ? (0, react.createElement)("span", {
			key: "m",
			className: "sm-badge"
		}, topicSet.model) : null), tagChips(topicSet.tags), (0, react.createElement)("div", { className: "sm-body-text" }, topicSet.summary || t("sets.noBody")), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
			key: "act",
			label: t("hub.activate"),
			onClick: (event) => {
				event.stopPropagation();
				run(async () => api.activate(sessionId, topicSet.id), () => void refreshHub());
			}
		}), (0, react.createElement)(Button, {
			key: "open",
			label: t("sets.open"),
			onClick: (event) => {
				event.stopPropagation();
				setView({
					kind: "topic",
					id: topicSet.id
				});
				setReply("");
			}
		})))))
	];
	const topicView = currentTopicSet ? [
		(0, react.createElement)(Button, {
			key: "back",
			className: "sm-back",
			label: t("topic.back"),
			onClick: () => setView({ kind: "sets" })
		}),
		(0, react.createElement)("div", {
			key: "card",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, currentTopicSet.title), tagChips(currentTopicSet.tags), (0, react.createElement)("div", {
			className: "sm-row",
			style: { marginTop: 6 }
		}, (0, react.createElement)(Button, {
			key: "act",
			variant: "primary",
			label: t("hub.activate"),
			onClick: () => void run(async () => api.activate(sessionId, currentTopicSet.id), () => void refreshHub())
		}), (0, react.createElement)("span", {
			key: "n",
			className: "sm-badge"
		}, t("sets.sessions", { count: currentTopicSet.sessions })), currentTopicSet.model ? (0, react.createElement)("span", {
			key: "m",
			className: "sm-badge"
		}, currentTopicSet.model) : null)),
		(0, react.createElement)("div", {
			key: "members",
			className: "sm-card"
		}, (0, react.createElement)("h3", null, t("topic.members")), currentTopicSet.branches.length === 0 ? (0, react.createElement)(EmptyState, { label: t("topic.noMembers") }) : (0, react.createElement)("div", { className: "sm-list" }, currentTopicSet.branches.map((branch) => (0, react.createElement)("div", {
			key: branch.sessionId,
			className: "sm-item",
			"data-clickable": "true",
			onClick: () => openChat(branch.sessionId)
		}, (0, react.createElement)("div", { className: "sm-row" }, (0, react.createElement)("span", { className: "sm-title" }, branch.title || branch.sessionId.slice(0, 12)), (0, react.createElement)("span", {
			key: "k",
			className: "sm-badge"
		}, branch.kind === "fork" ? t("topic.branch") : t("topic.root")), (0, react.createElement)("span", {
			key: "s",
			className: "sm-badge"
		}, branch.status), branch.kind === "fork" && branch.topicSetTitle ? (0, react.createElement)("span", {
			key: "own",
			className: "sm-badge",
			title: t("branches.ownSet")
		}, branch.topicSetTitle) : null, branch.kind === "fork" && (branch.hubs ?? 0) > 1 ? (0, react.createElement)("span", {
			key: "sh",
			className: "sm-badge"
		}, t("branches.shared", { count: (branch.hubs ?? 1) - 1 })) : null, branch.model ? (0, react.createElement)("span", {
			key: "m",
			className: "sm-badge"
		}, branch.model) : null), (0, react.createElement)("div", { className: "sm-sub" }, branch.sessionId), branch.task ? (0, react.createElement)("div", {
			key: "task",
			className: "sm-sub"
		}, `任务：${branch.task}`) : null, branch.tags && branch.tags.length > 0 ? tagChips(branch.tags) : null)))),
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
		}, (0, react.createElement)("h3", null, t("topic.summary")), (0, react.createElement)("div", { className: "sm-form-label" }, t("memory.tags")), (0, react.createElement)("input", {
			key: "tags",
			className: "sm-input",
			value: (summaryTagsDraft ?? currentTopicSet.tags).join("，"),
			placeholder: t("memory.tags.placeholder"),
			onChange: (event) => setSummaryTagsDraft(String(event.target.value).split(/[,，、;；\s]+/).map((tag) => tag.trim()).filter(Boolean))
		}), (0, react.createElement)("div", {
			key: "bodyLabel",
			className: "sm-form-label",
			style: { marginTop: 6 }
		}, t("memory.body")), (0, react.createElement)("textarea", {
			key: "input",
			className: "sm-textarea",
			value: summaryDraft ?? currentTopicSet.summary,
			onChange: (event) => setSummaryDraft(event.target.value)
		}), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
			key: "save",
			label: t("topic.summary.save"),
			onClick: () => void run(async () => api.updateTopicSetSummary(currentTopicSet.id, (summaryDraft ?? currentTopicSet.summary).slice(0, 500), summaryTagsDraft ?? currentTopicSet.tags), () => {
				setSummaryDraft(void 0);
				setSummaryTagsDraft(void 0);
				refreshHub();
			})
		})))
	] : (0, react.createElement)(EmptyState, {
		key: "missing",
		label: t("hub.empty"),
		hint: t("hub.empty.hint")
	});
	const memoryEntryRow = (memory) => (0, react.createElement)("div", {
		key: memory.id,
		className: "sm-item"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-row",
		"data-clickable": "true",
		title: t("memory.detail.open"),
		style: { cursor: "pointer" },
		onClick: () => openMemoryDetail(memory.id)
	}, (0, react.createElement)("span", {
		key: "title",
		className: "sm-title"
	}, memory.title || deriveTitleClient(memory.text)), (0, react.createElement)("span", {
		key: "ver",
		className: "sm-badge"
	}, `v${memory.version ?? 1}`), (0, react.createElement)("span", {
		key: "st",
		className: "sm-badge"
	}, memory.status)), tagChips(memory.tags, query), (0, react.createElement)("div", { className: "sm-body-text" }, memory.text), (0, react.createElement)("div", { className: "sm-sub" }, `${t("memory.updated")}：${fmtTime(memory.updatedAt)}`, ` · ${t("memory.source")}：${memory.sourceSessionId || "—"}`), (0, react.createElement)("div", { className: "sm-actions" }, memory.sourceSessionId ? (0, react.createElement)(Button, {
		key: "loc",
		label: t("memory.locate"),
		onClick: () => api.openSession(memory.sourceSessionId)
	}) : null, (0, react.createElement)(Button, {
		key: "edit",
		label: t("memory.edit"),
		onClick: () => setEditingMemory({
			id: memory.id,
			title: memory.title,
			tags: memory.tags,
			text: memory.text,
			key: memory.key
		})
	}), (0, react.createElement)(Button, {
		key: "toggle",
		label: memory.status === "active" ? t("memory.disable") : t("memory.enable"),
		onClick: () => void run(async () => api.setMemoryStatus(cwd, memory.id, memory.status === "active" ? "superseded" : "active"), () => void refreshMemoryViews())
	}), confirmDeleteMemory === memory.id ? (0, react.createElement)(Button, {
		key: "delYes",
		variant: "danger",
		label: t("memory.deleteConfirm"),
		onClick: () => void run(async () => api.deleteMemory(cwd, memory.id), () => {
			setConfirmDeleteMemory(void 0);
			refreshMemoryViews();
		})
	}) : (0, react.createElement)(Button, {
		key: "del",
		variant: "danger",
		label: t("memory.delete"),
		onClick: () => setConfirmDeleteMemory(memory.id)
	}), confirmDeleteMemory === memory.id ? (0, react.createElement)(Button, {
		key: "delNo",
		label: t("memory.cancel"),
		onClick: () => setConfirmDeleteMemory(void 0)
	}) : null));
	const filteredCollections = (0, react.useMemo)(() => {
		const needle = memoryQuery.trim().toLowerCase();
		if (!needle) return memoryCollections;
		return memoryCollections.filter((collection) => collection.title.toLowerCase().includes(needle) || collection.tags.some((tag) => tag.toLowerCase().includes(needle)));
	}, [memoryCollections, memoryQuery]);
	const collectionCard = (collection) => (0, react.createElement)("div", {
		key: collection.id || "ungrouped",
		className: "sm-card",
		"data-clickable": "true",
		title: t("memory.collection.open"),
		style: { cursor: "pointer" },
		onClick: () => setView({
			kind: "memory-collection",
			id: collection.id
		})
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-row"
	}, (0, react.createElement)("h3", { key: "title" }, collection.title), (0, react.createElement)("span", {
		key: "count",
		className: "sm-badge"
	}, t("memory.group.count", { count: collection.count }))), tagChips(collection.tags), (0, react.createElement)("div", {
		key: "meta",
		className: "sm-sub"
	}, `${t("memory.updated")}：${fmtTime(collection.latestUpdatedAt)}`));
	const collectionList = filteredCollections.length === 0 ? (0, react.createElement)(EmptyState, {
		key: "empty",
		label: t("memory.collection.empty"),
		hint: t("memory.collection.empty.hint")
	}) : (0, react.createElement)("div", {
		key: "cards",
		className: "sm-list"
	}, filteredCollections.map(collectionCard));
	const currentCollection = view.kind === "memory-collection" ? memoryCollections.find((collection) => collection.id === view.id) : void 0;
	const memoryCollectionView = (0, react.createElement)("div", { key: "mc" }, (0, react.createElement)("div", {
		key: "crumb",
		className: "sm-row"
	}, (0, react.createElement)(Button, {
		key: "back",
		label: t("memory.back"),
		onClick: () => setView({ kind: "memories" })
	}), (0, react.createElement)("span", {
		key: "path",
		className: "sm-muted"
	}, `${t("tab.memories")} / ${currentCollection?.title ?? (view.kind === "memory-collection" ? view.id : "")}`)), (0, react.createElement)("div", {
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
		onClick: () => {
			if (view.kind === "memory-collection") refreshCollectionMemories(view.id);
		}
	})), collectionMemories.length === 0 ? (0, react.createElement)(EmptyState, {
		key: "empty",
		label: t("memory.empty"),
		hint: t("memory.empty.hint")
	}) : (0, react.createElement)("div", {
		key: "list",
		className: "sm-list"
	}, collectionMemories.map(memoryEntryRow)));
	const detail = memoryDetail;
	const detailVersions = detail?.versions ?? [];
	const expandedVersionKey = expandedVersion;
	const memoryDetailView = detail ? (0, react.createElement)("div", { key: "md" }, (0, react.createElement)("div", {
		key: "crumb",
		className: "sm-row"
	}, (0, react.createElement)(Button, {
		key: "back",
		label: t("memory.back"),
		onClick: () => backFromMemoryDetail()
	}), (0, react.createElement)("span", {
		key: "path",
		className: "sm-muted"
	}, `${t("tab.memories")} / ${detail.view.collectionTitle || t("memory.group.ungrouped")} / ${detail.view.title || deriveTitleClient(detail.view.text)}`)), (0, react.createElement)("div", {
		key: "head",
		className: "sm-row"
	}, (0, react.createElement)("span", {
		key: "title",
		className: "sm-title"
	}, detail.view.title || deriveTitleClient(detail.view.text)), (0, react.createElement)("span", {
		key: "ver",
		className: "sm-badge"
	}, `v${detail.view.version ?? 1}`), (0, react.createElement)("span", {
		key: "st",
		className: "sm-badge"
	}, detail.view.status)), tagChips(detail.view.tags, query), (0, react.createElement)("div", {
		key: "body",
		className: "sm-body-text"
	}, detail.view.text), (0, react.createElement)("div", {
		key: "meta",
		className: "sm-sub"
	}, `${t("memory.updated")}：${fmtTime(detail.view.updatedAt)}`, detail.view.key ? ` · key ${detail.view.key}` : "", detail.view.sourceSessionId ? ` · ${t("memory.source")}：${detail.view.sourceSessionId}` : ""), (0, react.createElement)("div", {
		key: "actions",
		className: "sm-actions"
	}, (0, react.createElement)(Button, {
		key: "edit",
		label: t("memory.edit"),
		onClick: () => setEditingMemory({
			id: detail.view.id,
			title: detail.view.title,
			tags: detail.view.tags,
			text: detail.view.text,
			key: detail.view.key
		})
	}), (0, react.createElement)(Button, {
		key: "toggle",
		label: detail.view.status === "active" ? t("memory.disable") : t("memory.enable"),
		onClick: () => void run(async () => api.setMemoryStatus(cwd, detail.view.id, detail.view.status === "active" ? "superseded" : "active"), () => void refreshMemoryViews())
	}), confirmDeleteMemory === detail.view.id ? (0, react.createElement)(Button, {
		key: "delYes",
		variant: "danger",
		label: t("memory.deleteConfirm"),
		onClick: () => void run(async () => api.deleteMemory(cwd, detail.view.id), () => {
			setConfirmDeleteMemory(void 0);
			setView({
				kind: "memory-collection",
				id: detail.view.collectionId ?? ""
			});
		})
	}) : (0, react.createElement)(Button, {
		key: "del",
		variant: "danger",
		label: t("memory.delete"),
		onClick: () => setConfirmDeleteMemory(detail.view.id)
	}), confirmDeleteMemory === detail.view.id ? (0, react.createElement)(Button, {
		key: "delNo",
		label: t("memory.cancel"),
		onClick: () => setConfirmDeleteMemory(void 0)
	}) : null), (0, react.createElement)("div", {
		key: "history",
		className: "sm-form-col"
	}, (0, react.createElement)("div", {
		key: "label",
		className: "sm-form-label"
	}, `${t("memory.history")}（${detailVersions.length}）`), detailVersions.length === 0 ? (0, react.createElement)("div", {
		key: "none",
		className: "sm-muted"
	}, t("memory.history.none")) : (0, react.createElement)("div", {
		key: "rows",
		className: "sm-list"
	}, detailVersions.map((row) => {
		const rowKey = `${detail.view.id}:${row.version}`;
		const open = expandedVersionKey === rowKey;
		return (0, react.createElement)("div", {
			key: rowKey,
			className: "sm-item"
		}, (0, react.createElement)("div", {
			key: "head",
			className: "sm-row",
			"data-clickable": "true",
			title: t("memory.history.toggle"),
			style: { cursor: "pointer" },
			onClick: () => setExpandedVersion(open ? void 0 : rowKey)
		}, (0, react.createElement)("span", {
			key: "caret",
			className: "sm-caret"
		}, open ? "▾" : "▸"), (0, react.createElement)("span", {
			key: "ver",
			className: "sm-badge"
		}, `v${row.version}`), (0, react.createElement)("span", {
			key: "type",
			className: "sm-badge"
		}, t(`memory.history.${row.changeType}`)), (0, react.createElement)("span", {
			key: "title",
			className: "sm-title"
		}, row.title || "—"), (0, react.createElement)("span", {
			key: "at",
			className: "sm-sub"
		}, fmtTime(row.updatedAt))), tagChips(row.tags), open ? (0, react.createElement)("div", {
			key: "text",
			className: "sm-body-text"
		}, row.text) : null);
	})))) : (0, react.createElement)(EmptyState, {
		key: "missing",
		label: t("memory.empty"),
		hint: t("memory.empty.hint")
	});
	const hubPolicySelected = (name, prefix = false) => {
		if (!hubPolicyDraft) return false;
		return prefix ? hubPolicyDraft.prefixes.includes(name) : hubPolicyDraft.tools.includes(name);
	};
	const hubPolicyToggle = (name, prefix = false) => {
		if (!hubPolicyDraft) return;
		if (prefix) {
			const has = hubPolicyDraft.prefixes.includes(name);
			setHubPolicyDraft({
				...hubPolicyDraft,
				prefixes: has ? hubPolicyDraft.prefixes.filter((entry) => entry !== name) : [...hubPolicyDraft.prefixes, name]
			});
			return;
		}
		const has = hubPolicyDraft.tools.includes(name);
		setHubPolicyDraft({
			...hubPolicyDraft,
			tools: has ? hubPolicyDraft.tools.filter((entry) => entry !== name) : [...hubPolicyDraft.tools, name]
		});
	};
	const hubPolicyAddCustom = () => {
		const name = hubPolicyCustom.trim();
		if (!name || !hubPolicyDraft) return;
		if (!hubPolicyDraft.tools.includes(name)) setHubPolicyDraft({
			...hubPolicyDraft,
			tools: [...hubPolicyDraft.tools, name]
		});
		setHubPolicyCustom("");
	};
	/** R39: 当前草稿是否通过前缀规则覆盖了某工具（此时单项开关由前缀决定）。 */
	const hubPolicyPrefixCovered = (name) => Boolean(hubPolicyDraft && !hubPolicyDraft.tools.includes(name) && hubPolicyDraft.prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix)));
	/** R39: 已知来源 id 本地化；未知来源（含宿主声明的来源名）直接用宿主 label。 */
	const hubPolicyGroupLabel = (group) => {
		if (group.id === "stale") return t("hubPolicy.group.stale");
		if (group.id === "source:supermemory") return t("hubPolicy.source.supermemory");
		if (group.id === "source:composite") return t("hubPolicy.source.composite");
		if (group.id === "source:schedule") return t("hubPolicy.source.schedule");
		if (group.id === "source:host-session") return t("hubPolicy.source.hostSession");
		if (group.id === "source:host") return t("hubPolicy.source.host");
		if (group.id.startsWith("source:mcp:")) return t("hubPolicy.source.mcp", { server: group.id.slice(11) });
		return group.label;
	};
	const hubPolicyCount = hubPolicyDraft ? hubPolicyDraft.tools.length + hubPolicyDraft.prefixes.length : 0;
	const hubPolicyNeedle = hubPolicyQuery.trim().toLowerCase();
	const hubPolicyFiltered = (hubPolicy?.catalog ?? []).map((group) => {
		const label = hubPolicyGroupLabel(group);
		return {
			group,
			items: hubPolicyNeedle.length > 0 && (label.toLowerCase().includes(hubPolicyNeedle) || group.label.toLowerCase().includes(hubPolicyNeedle)) ? group.items : group.items.filter((item) => hubPolicyNeedle.length === 0 || item.name.toLowerCase().includes(hubPolicyNeedle) || (item.description ?? "").toLowerCase().includes(hubPolicyNeedle))
		};
	}).filter((row) => row.items.length > 0);
	const toggleHubPolicyGroup = (id) => {
		setHubPolicyCollapsed((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
	};
	/** R39: 一键清理 —— 先保存当前草稿（不丢未保存勾选），再由宿主按运行时清理。 */
	const cleanHubPolicyStale = () => void run(async () => {
		if (!hubPolicyDraft) return {
			status: "error",
			message: t("hubPolicy.loading")
		};
		const saved = await api.setHubPolicy(cwd, {
			tools: hubPolicyDraft.tools,
			prefixes: hubPolicyDraft.prefixes
		});
		if (saved.status !== "ok") return saved;
		return api.cleanupStaleHubPolicy(cwd);
	}, () => void refreshHubPolicy());
	const hubPolicySwitch = (entry) => {
		const locked = entry.locked === true || (hubPolicy?.locked ?? []).includes(entry.name);
		const prefixCovered = !locked && entry.prefix !== true && hubPolicyPrefixCovered(entry.name);
		const checked = locked || prefixCovered || hubPolicySelected(entry.name, entry.prefix === true);
		const disabled = locked || prefixCovered;
		const title = locked ? t("hubPolicy.locked.tip") : prefixCovered ? t("hubPolicy.viaPrefix.tip") : entry.risk === true ? t("hubPolicy.risk.tip") : entry.description;
		return (0, react.createElement)("label", {
			key: `${entry.source}:${entry.name}`,
			className: "sm-item",
			"data-locked": String(disabled),
			title
		}, (0, react.createElement)("input", {
			key: "box",
			type: "checkbox",
			checked,
			disabled,
			onChange: () => hubPolicyToggle(entry.name, entry.prefix === true)
		}), (0, react.createElement)("span", {
			key: "name",
			className: "sm-title"
		}, entry.prefix === true ? `${entry.name}*` : entry.name), locked ? (0, react.createElement)("span", {
			key: "lock",
			className: "sm-badge"
		}, t("hubPolicy.locked")) : null, prefixCovered ? (0, react.createElement)("span", {
			key: "prefix",
			className: "sm-badge"
		}, t("hubPolicy.viaPrefix")) : null, entry.risk === true ? (0, react.createElement)("span", {
			key: "risk",
			className: "sm-badge"
		}, t("hubPolicy.risk")) : null, entry.synthetic === true ? (0, react.createElement)("span", {
			key: "synthetic",
			className: "sm-badge",
			title: t("hubPolicy.synthetic.tip")
		}, t("hubPolicy.synthetic")) : null, entry.stale === true ? (0, react.createElement)("span", {
			key: "stale",
			className: "sm-badge"
		}, t("hubPolicy.stale.badge")) : null, entry.noteKey === "pluginManager" && !locked ? (0, react.createElement)("span", {
			key: "note",
			className: "sm-sub"
		}, t("hubPolicy.note.pluginManager")) : null, entry.description ? (0, react.createElement)("div", {
			key: "desc",
			className: "sm-desc"
		}, entry.description) : null);
	};
	const hubPolicyGroupCard = (group, items) => {
		const collapsed = hubPolicyCollapsed.includes(group.id);
		const enabled = group.items.filter((item) => item.locked === true || hubPolicySelected(item.name, item.prefix === true) || item.prefix !== true && hubPolicyPrefixCovered(item.name)).length;
		const isStale = group.kind === "stale";
		return (0, react.createElement)("div", {
			key: group.id,
			className: "sm-card"
		}, (0, react.createElement)("div", {
			key: "head",
			className: "sm-row"
		}, (0, react.createElement)("button", {
			key: "chev",
			type: "button",
			className: "sm-chevbtn",
			title: collapsed ? t("hubPolicy.group.expand") : t("hubPolicy.group.collapse"),
			onClick: () => toggleHubPolicyGroup(group.id)
		}, collapsed ? "▸" : "▾"), (0, react.createElement)("h3", {
			key: "title",
			style: { margin: 0 }
		}, hubPolicyGroupLabel(group)), group.inferred ? (0, react.createElement)("span", {
			key: "inferred",
			className: "sm-badge",
			title: t("hubPolicy.inferred.tip")
		}, t("hubPolicy.inferred")) : null, group.synthetic === true ? (0, react.createElement)("span", {
			key: "synthetic",
			className: "sm-badge",
			title: t("hubPolicy.synthetic.tip")
		}, t("hubPolicy.synthetic")) : null, (0, react.createElement)("span", {
			key: "count",
			className: "sm-badge"
		}, hubPolicyNeedle.length > 0 ? t("hubPolicy.group.match", {
			count: items.length,
			total: group.total
		}) : t("hubPolicy.group.count", { count: group.total })), (0, react.createElement)("span", {
			key: "enabled",
			className: "sm-badge"
		}, t("hubPolicy.group.enabled", { enabled })), isStale ? (0, react.createElement)(Button, {
			key: "clean",
			size: "sm",
			label: t("hubPolicy.stale.clean", { count: group.items.length }),
			title: t("hubPolicy.stale.tip"),
			disabled: group.items.every((item) => item.locked === true),
			onClick: () => cleanHubPolicyStale()
		}) : null), group.hint && !collapsed ? (0, react.createElement)("div", {
			key: "hint",
			className: "sm-muted"
		}, group.hint) : null, collapsed ? null : (0, react.createElement)("div", {
			key: "rows",
			className: "sm-list"
		}, items.map(hubPolicySwitch)));
	};
	const hubPolicyView = !hubPolicy || !hubPolicyDraft ? (0, react.createElement)(EmptyState, {
		key: "loading",
		label: t("hubPolicy.loading"),
		hint: t("hubPolicy.loading.hint")
	}) : (0, react.createElement)("div", { key: "hp" }, (0, react.createElement)("div", {
		key: "head",
		className: "sm-card"
	}, (0, react.createElement)("div", {
		key: "line",
		className: "sm-row"
	}, (0, react.createElement)("span", {
		key: "model",
		className: "sm-title"
	}, t("hubPolicy.model", { count: hubPolicyCount })), (0, react.createElement)("span", {
		key: "source",
		className: "sm-badge"
	}, hubPolicy.source === "stored" ? t("hubPolicy.source.stored") : t("hubPolicy.source.default")), (0, react.createElement)("span", {
		key: "mode",
		className: "sm-badge"
	}, hubPolicy.catalogMeta.mode === "fallback" ? t("hubPolicy.catalog.fallback") : t("hubPolicy.catalog.dynamic"))), (0, react.createElement)("div", {
		key: "meta",
		className: "sm-muted"
	}, t("hubPolicy.catalog.meta", {
		tools: hubPolicy.catalogMeta.toolCount,
		groups: hubPolicy.catalogMeta.groupCount
	}), hubPolicy.catalogMeta.syntheticCount > 0 ? " · " + t("hubPolicy.catalog.synthetic", { count: hubPolicy.catalogMeta.syntheticCount }) : "", " · ", t("hubPolicy.lastRefresh", { time: fmtTime(hubPolicy.catalogMeta.generatedAt) })), hubPolicy.catalogMeta.warning ? (0, react.createElement)("div", {
		key: "warning",
		className: "sm-warnbox"
	}, hubPolicy.catalogMeta.warning) : null, (0, react.createElement)("div", {
		key: "hint",
		className: "sm-muted"
	}, t("hubPolicy.hint")), (0, react.createElement)("div", {
		key: "actions",
		className: "sm-actions"
	}, (0, react.createElement)(Button, {
		key: "reset",
		label: t("hubPolicy.reset"),
		onClick: () => void run(async () => api.setHubPolicy(cwd, { reset: true }), () => void refreshHubPolicy())
	}), (0, react.createElement)(Button, {
		key: "save",
		variant: "primary",
		label: t("hubPolicy.save"),
		onClick: () => void run(async () => api.setHubPolicy(cwd, {
			tools: hubPolicyDraft.tools,
			prefixes: hubPolicyDraft.prefixes
		}), () => void refreshHubPolicy())
	})), (0, react.createElement)("div", {
		key: "search",
		className: "sm-form"
	}, (0, react.createElement)("input", {
		key: "searchInput",
		className: "sm-input",
		value: hubPolicyQuery,
		placeholder: t("hubPolicy.search.placeholder"),
		onChange: (event) => setHubPolicyQuery(event.target.value)
	}), (0, react.createElement)(Button, {
		key: "refresh",
		label: t("hubPolicy.refresh"),
		onClick: () => void refreshHubPolicyCatalog()
	})), (0, react.createElement)("div", {
		key: "add",
		className: "sm-form"
	}, (0, react.createElement)("input", {
		key: "input",
		className: "sm-input",
		value: hubPolicyCustom,
		placeholder: t("hubPolicy.custom.placeholder"),
		onChange: (event) => setHubPolicyCustom(event.target.value),
		onKeyDown: (event) => {
			if (event.key === "Enter") hubPolicyAddCustom();
		}
	}), (0, react.createElement)(Button, {
		key: "addBtn",
		label: t("hubPolicy.custom.add"),
		onClick: () => hubPolicyAddCustom()
	}))), hubPolicyFiltered.length === 0 ? (0, react.createElement)(EmptyState, {
		key: "noMatch",
		label: t("hubPolicy.empty"),
		hint: t("hubPolicy.empty.hint")
	}) : (0, react.createElement)("div", {
		key: "groups",
		className: "sm-list"
	}, hubPolicyFiltered.map((row) => hubPolicyGroupCard(row.group, row.items))));
	const memoriesView = [(0, react.createElement)("div", {
		key: "search",
		className: "sm-form"
	}, (0, react.createElement)("input", {
		key: "input",
		className: "sm-input",
		value: memoryQuery,
		placeholder: t("memory.collection.search"),
		onChange: (event) => setMemoryQuery(event.target.value)
	}), (0, react.createElement)(Button, {
		key: "go",
		label: t("hub.refresh"),
		onClick: () => void refreshMemoryCollections()
	})), collectionList];
	const toolsView = [(0, react.createElement)("div", {
		key: "list",
		className: "sm-list"
	}, tools.length === 0 ? (0, react.createElement)(EmptyState, {
		key: "empty",
		label: t("tool.empty"),
		hint: t("tool.empty.hint")
	}) : tools.map((tool) => (0, react.createElement)("div", {
		key: tool.id,
		className: "sm-item"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-row",
		"data-clickable": "true",
		title: t("tool.detail.toggle"),
		style: { cursor: "pointer" },
		onClick: () => setExpandedTool(expandedTool === tool.id ? void 0 : tool.id)
	}, (0, react.createElement)("span", {
		key: "caret",
		className: "sm-caret"
	}, expandedTool === tool.id ? "▾" : "▸"), (0, react.createElement)("span", {
		key: "title",
		className: "sm-title"
	}, tool.title || tool.name), (0, react.createElement)("span", {
		key: "kind",
		className: "sm-badge"
	}, tool.kind === "capability" ? t("tool.kind.capability") : t("tool.kind.sequence")), (0, react.createElement)("span", {
		key: "status",
		className: "sm-badge"
	}, tool.status), (0, react.createElement)("span", {
		key: "live",
		className: "sm-badge"
	}, tool.live ? t("tool.live") : t("tool.offline"))), tagChips(tool.tags), expandedTool === tool.id ? (0, react.createElement)("div", {
		key: "detail",
		className: "sm-detail"
	}, capabilityDetail(tool, t)) : null, editingTool && editingTool.id === tool.id ? (0, react.createElement)("div", { key: "edit" }, (0, react.createElement)("div", {
		key: "title",
		className: "sm-form-row"
	}, (0, react.createElement)("input", {
		key: "t",
		className: "sm-input",
		value: editingTool.title,
		placeholder: t("memory.title.placeholder"),
		onChange: (event) => setEditingTool({
			...editingTool,
			title: event.target.value
		})
	}), (0, react.createElement)("input", {
		key: "tags",
		className: "sm-input",
		value: editingTool.tags.join("，"),
		placeholder: t("memory.tags.placeholder"),
		onChange: (event) => setEditingTool({
			...editingTool,
			tags: splitTags(event.target.value)
		})
	})), (0, react.createElement)("textarea", {
		key: "input",
		className: "sm-textarea",
		value: editingTool.description,
		onChange: (event) => setEditingTool({
			...editingTool,
			description: event.target.value
		})
	}), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
		key: "save",
		variant: "primary",
		label: t("tool.desc.save"),
		onClick: () => void run(async () => api.editTool(tool.id, {
			title: editingTool.title,
			tags: editingTool.tags,
			description: editingTool.description
		}), () => {
			setEditingTool(void 0);
			refreshTools();
		})
	}), (0, react.createElement)(Button, {
		key: "cancel",
		label: t("memory.cancel"),
		onClick: () => setEditingTool(void 0)
	}))) : (0, react.createElement)("div", { key: "desc" }, (0, react.createElement)("div", { className: "sm-body-text" }, tool.description || "—"), (0, react.createElement)("div", { className: "sm-actions" }, (0, react.createElement)(Button, {
		key: "edit",
		label: t("tool.desc.edit"),
		onClick: () => setEditingTool({
			id: tool.id,
			title: tool.title,
			tags: tool.tags,
			description: tool.description
		})
	}), tool.status === "active" ? (0, react.createElement)(Button, {
		key: "retire",
		variant: "danger",
		label: t("tool.retire"),
		onClick: () => void run(async () => api.editTool(tool.id, { status: "retired" }), () => void refreshTools())
	}) : (0, react.createElement)(Button, {
		key: "enable",
		variant: "primary",
		label: t("tool.enable"),
		onClick: () => void run(async () => api.editTool(tool.id, { status: "active" }), () => void refreshTools())
	}), confirmDeleteTool === tool.id ? (0, react.createElement)(Button, {
		key: "delYes",
		variant: "danger",
		label: t("tool.deleteConfirm"),
		onClick: () => void run(async () => api.deleteTool(tool.id), () => {
			setConfirmDeleteTool(void 0);
			refreshTools();
			refreshHub();
		})
	}) : (0, react.createElement)(Button, {
		key: "del",
		variant: "danger",
		label: t("tool.delete"),
		onClick: () => setConfirmDeleteTool(tool.id)
	}), confirmDeleteTool === tool.id ? (0, react.createElement)(Button, {
		key: "delNo",
		label: t("memory.cancel"),
		onClick: () => setConfirmDeleteTool(void 0)
	}) : null)), (0, react.createElement)("div", { className: "sm-sub" }, `${t("tool.steps")}：${tool.steps.join(" → ") || "—"}`), (0, react.createElement)("div", { className: "sm-sub" }, `${t("tool.params")}：${tool.parameters.join("、") || "—"} · ${t("tool.uses")}：${tool.useCount}`), tool.version !== void 0 || tool.usage?.lastStatus || tool.createdAt !== void 0 || tool.usage?.lastUsedAt !== void 0 ? (0, react.createElement)("div", {
		key: "capmeta",
		className: "sm-sub"
	}, `${tool.version !== void 0 ? `版本 v${tool.version} · ` : ""}` + (tool.usage?.lastStatus ? `最近执行 ${tool.usage.lastStatus === "completed" ? "成功" : "失败"}${tool.usage.lastDryRun ? "（预演）" : ""} · 成功 ${tool.usage.successCount}/失败 ${tool.usage.failCount}` + (tool.usage.consecutiveFailures >= 2 ? ` · 连续失败 ${tool.usage.consecutiveFailures}` : "") : "") + (tool.createdAt !== void 0 || tool.usage?.lastUsedAt !== void 0 ? `${tool.version !== void 0 || tool.usage?.lastStatus ? " · " : ""}${t("tool.detail.created")} ${fmtTime(tool.createdAt)} · ${t("tool.detail.lastUsed")} ${fmtTime(tool.usage?.lastUsedAt)}` : "")) : null)))];
	const chatView = view.kind === "chat" ? (0, react.createElement)("div", {
		key: "chat",
		className: "sm-chat"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-chat-head"
	}, (0, react.createElement)("span", {
		key: "title",
		className: "sm-title"
	}, chatData?.title || view.id.slice(-8)), chatData?.live ? (0, react.createElement)("span", {
		key: "live",
		className: "sm-badge"
	}, t("chat.live")) : (0, react.createElement)("span", {
		key: "cold",
		className: "sm-badge"
	}, t("chat.cold")), chatData?.truncated ? (0, react.createElement)("span", {
		key: "tr",
		className: "sm-badge"
	}, t("chat.truncated")) : null, (0, react.createElement)("span", {
		key: "grow",
		style: { flex: 1 }
	}), (0, react.createElement)(Button, {
		key: "refresh",
		size: "sm",
		label: t("chat.refresh"),
		onClick: () => void loadChat(view.id)
	}), (0, react.createElement)(Button, {
		key: "open",
		size: "sm",
		label: t("chat.open"),
		onClick: () => api.openSession(view.id)
	})), chatError ? (0, react.createElement)("div", {
		key: "err",
		className: "sm-error"
	}, chatError) : null, chatData?.note ? (0, react.createElement)("div", {
		key: "note",
		className: "sm-muted"
	}, chatData.note) : null, chatBranches.length > 0 ? BranchList({
		rows: chatBranches,
		t,
		onOpen: openChat,
		compact: true
	}) : null, (chatData?.messages ?? []).length === 0 && !chatData?.note ? (0, react.createElement)(EmptyState, {
		key: "empty",
		label: t("chat.empty"),
		hint: t("chat.empty.hint")
	}) : (0, react.createElement)("div", {
		key: "msgs",
		className: "sm-list"
	}, (chatData?.messages ?? []).map((message) => (0, react.createElement)("div", {
		key: `${message.role}-${message.seq}`,
		className: "sm-msg",
		"data-role": message.role
	}, (0, react.createElement)("span", {
		key: "role",
		className: "sm-msg-role"
	}, message.role === "user" ? t("chat.you") : message.role === "assistant" ? t("chat.assistant") : t("chat.tool")), (0, react.createElement)("div", {
		key: "text",
		className: "sm-msg-text"
	}, message.text)))), (0, react.createElement)("div", {
		key: "bar",
		className: "sm-chat-bar"
	}, (0, react.createElement)("textarea", {
		key: "input",
		className: "sm-textarea",
		value: chatDraft,
		rows: 3,
		placeholder: t("chat.placeholder"),
		onChange: (event) => setChatDraft(event.target.value),
		onKeyDown: (event) => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				sendChat(view.id);
			}
		}
	}), (0, react.createElement)(Button, {
		key: "send",
		variant: "primary",
		label: t("chat.send"),
		disabled: chatSending || !chatDraft.trim(),
		onClick: () => void sendChat(view.id)
	})), (0, react.createElement)("div", {
		key: "hint",
		className: "sm-muted"
	}, t("chat.hint"))) : null;
	const modelDefaultsCard = () => {
		const choices = catalog?.models ?? [];
		const known = (value) => choices.some((model) => `${model.provider}/${model.id}` === value);
		const select = (key, value, onChange) => (0, react.createElement)("select", {
			key,
			className: "sm-opt-select",
			value,
			onChange: (event) => onChange(String(event.target.value))
		}, (0, react.createElement)("option", {
			key: "follow",
			value: ""
		}, t("settings.models.follow")), choices.map((model) => {
			const id = `${model.provider}/${model.id}`;
			return (0, react.createElement)("option", {
				key: id,
				value: id,
				title: model.name || void 0
			}, id);
		}), value && !known(value) ? (0, react.createElement)("option", {
			key: "custom",
			value
		}, value) : null);
		const saveDefaults = () => void run(async () => {
			const parse = (text) => {
				const slash = text.indexOf("/");
				return slash > 0 ? {
					provider: text.slice(0, slash),
					model: text.slice(slash + 1)
				} : null;
			};
			return api.setModelDefaults(cwd, {
				hub: hubModelDraft ? parse(hubModelDraft) : null,
				branch: branchModelDraft ? parse(branchModelDraft) : null
			});
		}, () => void refreshModelDefaults());
		return (0, react.createElement)("div", {
			key: "models",
			className: "sm-card"
		}, (0, react.createElement)("div", {
			key: "head",
			className: "sm-row"
		}, (0, react.createElement)("h3", { key: "title" }, t("settings.models.title")), (0, react.createElement)("span", {
			key: "source",
			className: "sm-badge"
		}, modelDefaults?.source === "stored" ? t("hubPolicy.source.stored") : t("hubPolicy.source.default"))), (0, react.createElement)("div", {
			key: "hint",
			className: "sm-muted"
		}, t("settings.models.hint")), (0, react.createElement)("div", {
			key: "form",
			className: "sm-form"
		}, (0, react.createElement)("label", {
			key: "hub",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("settings.models.hub")), select("hub", hubModelDraft, setHubModelDraft)), (0, react.createElement)("label", {
			key: "branch",
			className: "sm-opt"
		}, (0, react.createElement)("span", {
			key: "label",
			className: "sm-opt-label"
		}, t("settings.models.branch")), select("branch", branchModelDraft, setBranchModelDraft))), (0, react.createElement)("div", {
			key: "actions",
			className: "sm-actions"
		}, (0, react.createElement)(Button, {
			key: "save",
			variant: "primary",
			label: t("settings.models.save"),
			disabled: !cwd,
			onClick: saveDefaults
		}), (0, react.createElement)(Button, {
			key: "reset",
			label: t("settings.models.reset"),
			disabled: !cwd,
			onClick: () => void run(async () => api.setModelDefaults(cwd, { reset: true }), () => void refreshModelDefaults())
		})), (0, react.createElement)("div", {
			key: "precedence",
			className: "sm-desc"
		}, t("settings.models.precedence")));
	};
	const skillsCard = () => (0, react.createElement)("div", {
		key: "skills",
		className: "sm-card"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-row"
	}, (0, react.createElement)("h3", { key: "title" }, t("settings.skills.title")), (0, react.createElement)("span", {
		key: "count",
		className: "sm-badge"
	}, String(skills.length))), (0, react.createElement)("div", {
		key: "hint",
		className: "sm-muted"
	}, t("settings.skills.hint")), skills.length === 0 ? (0, react.createElement)("div", {
		key: "empty",
		className: "sm-muted"
	}, t("settings.skills.empty")) : (0, react.createElement)("div", {
		key: "list",
		className: "sm-form"
	}, skills.map((skill) => (0, react.createElement)("div", {
		key: skill.name,
		className: "sm-form-row"
	}, (0, react.createElement)("div", {
		key: "meta",
		className: "sm-desc"
	}, (0, react.createElement)("strong", null, skill.name), " ", (0, react.createElement)("span", {
		key: "ver",
		className: "sm-badge"
	}, "v" + skill.version), " ", (0, react.createElement)("span", {
		key: "uses",
		className: "sm-muted"
	}, t("settings.skills.uses", { count: skill.useCount })), skill.enabled ? null : (0, react.createElement)("span", {
		key: "off",
		className: "sm-badge"
	}, t("settings.skills.disabled"))), (0, react.createElement)("input", {
		key: "desc",
		className: "sm-input",
		value: skillDrafts[skill.name] ?? skill.description,
		onChange: (event) => setSkillDrafts((draft) => ({
			...draft,
			[skill.name]: String(event.target.value)
		}))
	}), (0, react.createElement)(Button, {
		key: "save",
		label: t("settings.skills.save"),
		disabled: !cwd,
		onClick: () => void run(async () => api.updateSkill(cwd, skill.name, { description: skillDrafts[skill.name] ?? skill.description }), () => void refreshSkills())
	}), (0, react.createElement)(Button, {
		key: "toggle",
		label: skill.enabled ? t("settings.skills.disable") : t("settings.skills.enable"),
		disabled: !cwd,
		onClick: () => void run(async () => api.updateSkill(cwd, skill.name, { enabled: !skill.enabled }), () => void refreshSkills())
	})))));
	const settingsView = (0, react.createElement)("div", { key: "settings" }, modelDefaultsCard(), skillsCard(), (0, react.createElement)("div", {
		key: "policyTitle",
		className: "sm-section-title"
	}, t("settings.policy.title")), hubPolicyView);
	const body = view.kind === "hub" ? hubView : view.kind === "sets" ? setsView : view.kind === "topic" ? topicView : view.kind === "branches" ? branchesView : view.kind === "memories" ? memoriesView : view.kind === "memory-collection" ? memoryCollectionView : view.kind === "memory-detail" ? memoryDetailView : view.kind === "settings" ? settingsView : view.kind === "chat" ? chatView : toolsView;
	const sideRail = (0, react.createElement)("aside", {
		key: "side",
		className: "sm-side"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-side-head",
		title: t("side.authority")
	}, (0, react.createElement)("span", { key: "title" }, t("side.title")), (0, react.createElement)("span", {
		key: "count",
		className: "sm-side-count"
	}, t("side.count", { count: hubs.length }))), hubs.length === 0 ? (0, react.createElement)("div", {
		key: "empty",
		className: "sm-side-empty"
	}, `${t("side.empty")} · ${t("side.empty.hint")}`) : (0, react.createElement)("div", {
		key: "list",
		className: "sm-side-list"
	}, hubs.map((hubRow) => {
		const current = isRailCurrent(view, hubRow.sessionId, sessionId);
		return (0, react.createElement)("button", {
			key: hubRow.sessionId,
			type: "button",
			className: "sm-hub",
			"data-current": String(current),
			title: `${hubRow.title}${hubRow.topicSetTitle ? ` · 话题集 ${hubRow.topicSetTitle}` : ""} · ${hubRow.sessionId}`,
			onClick: () => openChat(hubRow.sessionId)
		}, hubRow.live ? (0, react.createElement)("span", {
			key: "dot",
			className: "sm-dot",
			title: t("side.running")
		}) : null, (0, react.createElement)("span", {
			key: "title",
			className: "sm-hub-title"
		}, hubRow.title || hubRow.sessionId.slice(-4)), hubRow.topicSetTitle ? (0, react.createElement)("span", {
			key: "set",
			className: "sm-hub-meta sm-hub-set",
			title: `${t("badge.hubSet.tip", { title: hubRow.topicSetTitle })}`
		}, hubRow.topicSetTitle) : null, hubRow.branches > 0 ? (0, react.createElement)("span", {
			key: "branches",
			className: "sm-hub-meta",
			title: t("side.branches", {
				count: hubRow.branches,
				working: hubRow.workingBranches
			})
		}, hubRow.workingBranches > 0 ? `${hubRow.branches}·${hubRow.workingBranches}` : String(hubRow.branches)) : null, current ? (0, react.createElement)("span", {
			key: "cur",
			className: "sm-hub-meta"
		}, t("side.current")) : null);
	})), (0, react.createElement)("div", {
		key: "foot",
		className: "sm-side-foot"
	}, (0, react.createElement)(Button, {
		key: "new",
		className: "sm-newhub",
		size: "sm",
		label: t("side.new"),
		title: t("composer.title"),
		disabled: launching,
		onClick: () => {
			createHubNow();
		}
	})));
	const bodyScroll = (0, react.createElement)("div", {
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
	}, notice) : null, body);
	const wsOptions = workspaces.map((workspace) => ({
		path: workspace.path,
		label: workspace.title || workspace.path
	}));
	if (cwd && !wsOptions.some((option) => option.path === cwd)) wsOptions.unshift({
		path: cwd,
		label: cwd
	});
	const memoryModal = editingMemory ? (0, react.createElement)("div", {
		key: "memory-modal",
		className: "sm-modal-backdrop",
		onClick: () => setEditingMemory(void 0)
	}, (0, react.createElement)("div", {
		key: "dialog",
		className: "sm-modal",
		role: "dialog",
		"aria-modal": "true",
		onClick: (event) => event.stopPropagation()
	}, (0, react.createElement)("h3", { key: "title" }, t("memory.modal.title")), (0, react.createElement)("p", {
		key: "hint",
		className: "sm-modal-hint"
	}, t("memory.modal.hint")), (0, react.createElement)("div", {
		key: "meta",
		className: "sm-form-row"
	}, (0, react.createElement)("input", {
		key: "t",
		className: "sm-input",
		value: editingMemory.title,
		placeholder: t("memory.title.placeholder"),
		onChange: (event) => setEditingMemory({
			...editingMemory,
			title: event.target.value
		})
	}), (0, react.createElement)("input", {
		key: "tags",
		className: "sm-input",
		value: editingMemory.tags.join("，"),
		placeholder: t("memory.tags.placeholder"),
		onChange: (event) => setEditingMemory({
			...editingMemory,
			tags: splitTags(event.target.value)
		})
	})), (0, react.createElement)("textarea", {
		key: "body",
		className: "sm-textarea",
		value: editingMemory.text,
		placeholder: t("memory.new.placeholder"),
		onChange: (event) => setEditingMemory({
			...editingMemory,
			text: event.target.value
		})
	}), (0, react.createElement)("div", {
		key: "actions",
		className: "sm-actions"
	}, (0, react.createElement)(Button, {
		key: "save",
		variant: "primary",
		label: t("memory.save"),
		onClick: () => void run(async () => api.updateMemory(cwd, editingMemory.id, editingMemory.text, editingMemory.key, editingMemory.title, editingMemory.tags), () => {
			setEditingMemory(void 0);
			refreshMemoryViews();
		})
	}), (0, react.createElement)(Button, {
		key: "cancel",
		label: t("memory.cancel"),
		onClick: () => setEditingMemory(void 0)
	})))) : null;
	const main = (0, react.createElement)("main", {
		key: "main",
		className: "sm-main"
	}, (0, react.createElement)("div", {
		key: "head",
		className: "sm-head"
	}, (0, react.createElement)("span", {
		key: "brand",
		className: "sm-brand"
	}, t("panel.title")), wsOptions.length > 0 ? (0, react.createElement)("label", {
		key: "ws",
		className: "sm-ws"
	}, (0, react.createElement)("span", {
		key: "label",
		className: "sm-opt-label"
	}, t("workspace.label")), (0, react.createElement)("select", {
		key: "select",
		className: "sm-ws-select",
		value: cwd,
		title: cwd,
		onChange: (event) => changeWorkspace(event.target.value)
	}, wsOptions.map((option) => (0, react.createElement)("option", {
		key: option.path,
		value: option.path
	}, option.label)))) : hub ? (0, react.createElement)("span", {
		key: "sub",
		className: "sm-head-sub"
	}, hub.workspaceKey) : null, hub ? (0, react.createElement)("div", {
		key: "pills",
		className: "sm-pills"
	}, (0, react.createElement)("span", {
		key: "sets",
		className: "sm-pill"
	}, `${t("tab.sets")} ${hub.topicSets.length}`), (0, react.createElement)("span", {
		key: "mem",
		className: "sm-pill"
	}, `${t("tab.memories")} ${hub.counts.memories}`), (0, react.createElement)("span", {
		key: "tools",
		className: "sm-pill"
	}, `${t("tab.tools")} ${hub.counts.tools}`)) : null), (0, react.createElement)("div", {
		key: "tabs",
		className: "sm-tabs"
	}, (0, react.createElement)("button", {
		key: "hub",
		...tabProps("hub")
	}, t("tab.hub")), (0, react.createElement)("button", {
		key: "sets",
		...tabProps("sets")
	}, t("tab.sets")), (0, react.createElement)("button", {
		key: "branches",
		...tabProps("branches")
	}, t("tab.branches")), (0, react.createElement)("button", {
		key: "memories",
		...tabProps("memories")
	}, t("tab.memories")), (0, react.createElement)("button", {
		key: "tools",
		...tabProps("tools")
	}, t("tab.tools")), (0, react.createElement)("button", {
		key: "settings",
		...tabProps("settings")
	}, t("tab.settings"))), bodyScroll);
	return (0, react.createElement)("div", {
		className: "sm-panel",
		"data-sm-panel": "true"
	}, (0, react.createElement)("div", {
		key: "shell",
		className: "sm-shell"
	}, sideRail, main), memoryModal);
}
// src/client/new-session.tsx
/**
* New-session entry (需求①: 「新会话」 must have an immediate, visible effect).
*
* The click on the shell's 新建会话 control (sidebar header / sidebar new-session
* row / a workspace row's 新会话 action) now CREATES a hub session right away
* with host defaults — current workspace, default agent preset / model /
* permission, no topic set (a hub session owns no set; the panel's dispatch
* card still picks the sticky/auto set when dispatching) — and hands the
* receipt to the panel, which renders it in place (message + session id +
* 「打开会话」). No choice dialog, no type picker, no waiting for a form: one
* click, one session.
*
* Why an interceptor instead of a slot: this shell exposes no "new session
* action" slot to replace (the verified vocabulary is sidebar.panellist /
* sidebar.session.row.leading / sidebar.workspaces.session.row.action /
* sidebar.footer.action — the sidebar's own 新建会话 row renders
* `sidebar.session.action`, which ADDS a control instead of replacing it), so
* the entry lives in `shell.overlay` (a global render slot) and installs a
* capture-phase document listener that matches the control by accessible name
* (aria-label / title / text). Capture runs before the shell's own bubble
* handler, so a matched click never creates the shell's plain session behind
* the panel.
*
* Degradation is explicit and never a dead button: without the panel api, a
* resolvable workspace, or a matching label, the click is NOT prevented and the
* shell's own new-session flow runs untouched. If the session was created but
* the panel could not be revealed (no layout service), the created session is
* opened directly so the click still has a visible result.
*
* R43 ①: two surfaces are skipped because they are OUR OWN and merely contain
* matching text — the panel (`[data-sm-panel]`, whose in-panel controls act
* locally) and a SuperMemory chat card (`[data-supermemory-card]`), whose head
* button's accessible name is 「来自 <来源会话> 的执行请求」 and therefore
* matches the pattern whenever the source session is named 「新会话」.
* @module supermemory/client/new-session
*/
/**
* The shell's New-session control, in the shipped zh and en dictionaries plus
* the plausible variants (the sidebar uses 新建会话 / New session, a workspace
* row uses 在“…”中新建会话).
*/
const NEW_SESSION_CONTROL = /(新建|新的?)\s*会话|新建对话|新对话|new\s+(session|chat|conversation)/i;
/** Whether an accessible name/value describes the shell's New-session control. */
function isNewSessionControl(value) {
	if (!value) return false;
	if (PER_WORKSPACE_ACTION.test(value.trim())) return false;
	return NEW_SESSION_CONTROL.test(value);
}
/**
* A workspace ROW's own action ("在“X”中新建会话" / New session in "X"): that
* control belongs to one workspace the overlay cannot see, so it keeps the
* shell's own behaviour — intercepting it here would create the session in the
* MAIN-VIEW workspace instead of the clicked one. Only the global 新建会话
* control (sidebar header / new-session row / brand) is ours.
*/
const PER_WORKSPACE_ACTION = /^在.*中\s*(新建|新的?)\s*(会话|对话)/;
/** The New-session entry: an interceptor that renders nothing. */
function NewSessionChoice(props) {
	const api = props.api;
	const cwd = props.cwd;
	const selectPanel = props.selectPanel;
	(0, react.useEffect)(() => {
		if (typeof document === "undefined") return;
		const onCapture = (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest("[data-sm-panel]") !== null) return;
			if (target.closest("[data-supermemory-card]") !== null) return;
			const control = target.closest("button, [role=\"button\"], a");
			if (control === null) return;
			if (!isNewSessionControl([
				control.getAttribute("aria-label"),
				control.getAttribute("title"),
				control.textContent
			].filter((value) => typeof value === "string").join(" "))) return;
			if (typeof api?.createHubSession !== "function") return;
			const workspace = typeof cwd === "function" ? String(cwd() ?? "") : "";
			if (!workspace) return;
			event.preventDefault();
			event.stopPropagation();
			const panelOpened = typeof selectPanel === "function" && selectPanel() === true;
			api.createHubSession(workspace, {}, "").then((result) => {
				if (result && result.status === "ok" && result.id) {
					publishHubReceipt({
						id: result.id,
						message: result.message,
						kind: "hub"
					});
					if (!panelOpened) api.openSession?.(result.id);
					return;
				}
				publishHubReceipt({
					id: "",
					message: result?.message || "创建中枢会话失败",
					kind: "hub"
				});
				if (!panelOpened) api.startSession?.();
			}).catch((error) => {
				publishHubReceipt({
					id: "",
					message: "创建中枢会话失败：" + String(error instanceof Error ? error.message : error),
					kind: "hub"
				});
				if (!panelOpened) api.startSession?.();
			});
		};
		document.addEventListener("click", onCapture, true);
		return () => document.removeEventListener("click", onCapture, true);
	}, [
		api,
		cwd,
		selectPanel
	]);
	return null;
}
// src/client/session-badge.tsx
/**
* Sidebar session-row badge (GUI 问题③, R31 需求②): marks the sessions this
* plugin knows about, so a hub session, the branches it dispatched to and a
* topic-set hub stay distinguishable in the left sidebar.
*
* Seated in `sidebar.session.row.trailing`. The host gates that cell by
* `!row.blank` only (upstream in dsh-client-ui-workspace's Rows component:
* the trailing `rowResting` span wraps the time label, the slot render and the
* pin mark, all inside `{!row.blank && …}`), so the badge stays visible while
* the session runs and in approval states. It USED to sit in
* `sidebar.session.row.leading`, whose gate is
* `!row.archived && !row.blank && (showStatus ? <SessionStatusDots/> : renderSlot(...))`
* with `showStatus = primary status is not idle` — a busy row kept its status
* dot in that cell and the badge disappeared (the 「运行中隐藏」 report). The
* trailing slot has no other registrant in the host bundle (verified in
* app.asar). Known limitation, unchanged by the move: a blank row (no first
* message) renders neither cell, so a brand-new empty hub session shows no
* badge until it has a message.
*
* R19 需求③④ + R31 需求②: four kinds are projected by the host
* `sessionBadge()` and rendered here —
* - `branch` (a plugin-minted `branch-*`/`fork-*` session, or a fork member):
*   the work branch badge. A fresh dispatch is recorded as `kind:'root'`, so
*   the id prefix — not the member kind — decides this case;
* - `hub-set` (a HOST session that is the set's root member, e.g. the session
*   `createTopicSetSession` created): a 「话题集」 badge carrying the set name,
*   so a topic-set hub is no longer mislabelled as a branch (the R18
*   conflation) and is not left unmarked;
* - `hub` (R31 需求②; R35 tightened): a session with a POSITIVE `hub_sessions`
*   record — the same mark resolveRole trusts. The old `session-*` id-shape
*   guess is gone (a stale/foreign session-* id must not claim 「中枢」);
* - `none` (R31 需求②: a plugin branch that has not joined a set yet, an
*   ordinary session, or an id the plugin cannot classify): renders nothing.
* The badge is a projection of host membership and positive hub records; it
* never fabricates one when the read fails.
* @module supermemory/client/session-badge
*/
const BADGE_CSS = [
	".sm-sb-badge{display:inline-flex;align-items:center;gap:3px;flex:none;box-sizing:border-box;height:16px;padding:0 6px 0 4px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:10px;line-height:14px;opacity:.8;cursor:default;user-select:none;vertical-align:middle}",
	".sm-sb-badge:hover{opacity:1}",
	".sm-sb-badge[data-kind=\"hub-set\"]{color:var(--dsw-alias-link,#7aaaff);border-color:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 45%,transparent)}",
	".sm-sb-badge[data-kind=\"hub\"]{color:var(--dsw-alias-state-done-primary,#8b5cf6);border-color:color-mix(in srgb,var(--dsw-alias-state-done-primary,#8b5cf6) 45%,transparent)}",
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
const badgeCache = /* @__PURE__ */ new Map();
/** Negative (`hub`/`none`) answers expire fast; a later dispatch may add the member. */
const HUB_BADGE_TTL_MS = 8e3;
/** Mounted rows subscribe here so invalidateBadge() updates them immediately. */
const listeners = /* @__PURE__ */ new Set();
function readBadgeCache(sessionId) {
	const entry = badgeCache.get(sessionId);
	if (!entry) return void 0;
	if (entry.badge.kind === "branch") return entry.badge;
	return Date.now() - entry.at < HUB_BADGE_TTL_MS ? entry.badge : void 0;
}
/**
* Drop the cached membership for one session (or every session) and re-render
* the mounted badges.
*
* Called after a panel hub refresh and after a dispatch receipt: both are
* moments when a session may have just joined a topic set.
*/
function invalidateBadge(sessionId) {
	if (sessionId) badgeCache.delete(sessionId);
	else badgeCache.clear();
	for (const listener of [...listeners]) try {
		listener();
	} catch {}
}
/**
* Render the badge for one session row.
* @returns the badge for a topic-set branch / topic-set hub / plugin hub,
* null for an unclassified session (`none`) or an unreadable row.
*/
function SupermemorySessionBadge(props) {
	installCss();
	const t = typeof props.t === "function" ? props.t : (key) => key;
	const { api, sessionId } = props;
	const [badge, setBadge] = (0, react.useState)(() => readBadgeCache(sessionId));
	const [revision, setRevision] = (0, react.useState)(0);
	(0, react.useEffect)(() => {
		const listener = () => {
			setBadge(readBadgeCache(sessionId));
			setRevision((value) => value + 1);
		};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, [sessionId]);
	(0, react.useEffect)(() => {
		let alive = true;
		try {
			const cached = readBadgeCache(sessionId);
			if (cached !== void 0) {
				setBadge(cached);
				return () => {
					alive = false;
				};
			}
			api.sessionBadge(sessionId).then((result) => {
				badgeCache.set(sessionId, {
					badge: result,
					at: Date.now()
				});
				if (alive) setBadge(result);
			}, () => {});
		} catch {}
		return () => {
			alive = false;
		};
	}, [
		api,
		sessionId,
		revision
	]);
	if (!badge || badge.kind === "none") return null;
	const isBranch = badge.kind === "branch";
	const isHub = badge.kind === "hub";
	const stop = (event) => {
		event.stopPropagation();
	};
	const glyph = isBranch ? (0, react.createElement)("svg", {
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
	})) : isHub ? (0, react.createElement)("svg", {
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
	}, (0, react.createElement)("circle", {
		key: "a",
		cx: 12,
		cy: 12,
		r: 2.4
	}), (0, react.createElement)("path", {
		key: "b",
		d: "M12 3.2v2.6"
	}), (0, react.createElement)("path", {
		key: "c",
		d: "M12 18.2v2.6"
	}), (0, react.createElement)("path", {
		key: "d",
		d: "M3.2 12h2.6"
	}), (0, react.createElement)("path", {
		key: "e",
		d: "M18.2 12h2.6"
	}), (0, react.createElement)("path", {
		key: "f",
		d: "M5.8 5.8l1.9 1.9"
	}), (0, react.createElement)("path", {
		key: "g",
		d: "M16.3 16.3l1.9 1.9"
	}), (0, react.createElement)("path", {
		key: "h",
		d: "M18.2 5.8l-1.9 1.9"
	}), (0, react.createElement)("path", {
		key: "i",
		d: "M7.7 16.3l-1.9 1.9"
	})) : (0, react.createElement)("svg", {
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
		d: "M4 7a8 5 0 1 0 16 0 8 5 0 1 0-16 0"
	}), (0, react.createElement)("path", {
		key: "b",
		d: "M4 7v6a8 5 0 0 0 16 0V7"
	}));
	return (0, react.createElement)("span", {
		key: "badge",
		className: "sm-sb-badge",
		"data-kind": badge.kind,
		title: isBranch ? t("badge.tip", { title: badge.topicSetTitle }) : isHub ? t("badge.hub.tip") : t("badge.hubSet.tip", { title: badge.topicSetTitle }),
		onClick: stop
	}, glyph, (0, react.createElement)("span", { key: "text" }, isBranch ? t("badge.branch") : isHub ? t("badge.hub") : t("badge.hubSet")));
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function text(value) {
	return typeof value === "string" ? value : "";
}
/** Last four characters of an id (the documented title fallback). */
function idTail(id) {
	const value = text(id).trim();
	return value.length > 4 ? value.slice(-4) : value;
}
/** Parse the plugin's source marker; null for every message the card must not own. */
function cardMetaOf(source) {
	const shaped = record(source);
	if (!shaped) return null;
	const form = text(shaped.form);
	const isRelay = text(shaped.kind) === "supermemory" && form === "relay";
	if (!isRelay && !(form === "supermemory-dispatch")) return null;
	const rawKind = text(shaped.fromKind);
	return {
		kind: rawKind === "hub" || rawKind === "branch" || rawKind === "group" || rawKind === "system" ? rawKind : isRelay ? "branch" : "hub",
		fromSessionId: text(shaped.fromSessionId),
		fromTitle: text(shaped.fromTitle),
		task: text(shaped.task),
		topicSetTitle: text(shaped.topicSetTitle),
		capability: text(shaped.capability),
		dispatchId: text(shaped.dispatchId),
		groupId: text(shaped.groupId),
		status: text(shaped.status)
	};
}
/**
* The source label the card title uses: the sender's session title, else the
* id's last four characters, else a neutral placeholder (never an empty title).
*/
function cardSourceLabel(meta) {
	const title = text(meta.fromTitle).trim();
	if (title) return title;
	return idTail(meta.fromSessionId) || "未知会话";
}
// src/client/chat-card.tsx
/**
* R32 需求③——render hub↔branch requests as ONE collapsible card in both
* directions, titled "来自 <来源会话> 的执行请求".
*
* Why a client slot and not just the host card:
*   - the host's turn-trigger card derives its title only from \`source.kind\`
*     ("收到执行请求") and a branch's first dispatch input is a \`user\` message
*     (R25 recency), so neither direction carries the sender's name;
*   - the plugin owns the messages that carry its marker (\\`chat-card.ts\\`), so it
*     shadows the two keyed cells (\`user\`, \`turn-trigger\`) at priority -100 and
*     delegates EVERY other message back to the host's shipped renderer via
*     \`entries()\`. Other triggers (goal/subagent/schedule/...) are untouched.
*
* The slot machinery is DSH's documented replacement path for a keyed cell;
* only the client bundle is replaced here, the host checkout is never edited.
* @module supermemory/client/chat-card
*/
/**
* The host locale namespace the keyed chat cells are registered under. The
* shipped renderers' `t` comes from the registration's `locale` option, so a
* shadowing cell that omits it hands the host renderer `t === undefined`.
*/
const CHAT_LOCALE_NS = "chat";
/**
* Delegation props for the host's shipped renderer.
*
* The shipped UserMessageNodeView needs `t` (from `locale`) and
* `renderSlotChain` (from a declared child, or an injected no-op); the
* turn-trigger/context views need `t`. The host injects both through our
* registration, but a shell that binds our cell without the locale/child face
* must not turn every ordinary message into a crashed slot entry, so fill the
* missing two defensively. A no-op `renderSlotChain` drops the
* `conversation.chat.user.before` decoration of a delegated user message —
* documented in DEV-NOTES §43.
*/
function delegationProps(props, env) {
	const next = { ...props };
	if (typeof next.t !== "function" && env) next.t = env.t;
	if (typeof next.renderSlotChain !== "function") next.renderSlotChain = () => null;
	return next;
}
const CSS_ID = "supermemory-chat-card-css";
/** One translator bound at render time (locale switches take effect). */
function translator(ctx) {
	return (key, params) => {
		try {
			return ctx.locale.bind(NS)(key, params);
		} catch {
			return key;
		}
	};
}
/** Find the host's shipped renderer for one keyed cell (skip our own entry). */
function findOriginal(ctx, key, ours) {
	try {
		const candidates = (ctx.slots.entries?.("conversation.chat.node") ?? []).filter((entry) => entry.options?.key === key && entry.options?.id !== ours && entry.component !== void 0).sort((left, right) => (left.options?.priority ?? 0) - (right.options?.priority ?? 0));
		if (candidates.length > 0) return candidates[0].component;
	} catch {}
}
/** The text of a message's content blocks (the model-facing body). */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const shaped = block;
		if (shaped.type === "text" && typeof shaped.text === "string" && shaped.text) parts.push(shaped.text);
	}
	return parts.join("\n");
}
/** Clock label for the card header (never a locale-dependent title). */
function clockText(time) {
	if (typeof time !== "number" || !Number.isFinite(time)) return "";
	try {
		return new Date(time).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit"
		});
	} catch {
		return "";
	}
}
/** One field row, rendered only when the source actually carries it. */
function fieldRow(label, value, key) {
	if (!value) return null;
	return (0, react.createElement)("div", {
		key,
		className: "sm-chat-card-field"
	}, (0, react.createElement)("dt", {
		key: "k",
		className: "sm-chat-card-field-k"
	}, label), (0, react.createElement)("dd", {
		key: "v",
		className: "sm-chat-card-field-v"
	}, value));
}
/** The collapsible card itself. */
function SupermemoryCard(props) {
	const { meta, node, env } = props;
	const [open, setOpen] = (0, react.useState)(false);
	const t = env?.t ?? ((key) => key);
	const title = t("chat.card.from", { session: cardSourceLabel(meta) });
	const kind = t("chat.card.kind." + meta.kind);
	const body = contentText(node?.data?.content);
	const time = clockText(node?.data?.time);
	const receipt = [meta.dispatchId, meta.status].filter(Boolean).join(" · ");
	const toggle = (event) => {
		try {
			event?.stopPropagation?.();
		} catch {}
		setOpen((value) => !value);
	};
	return (0, react.createElement)("section", {
		className: "sm-chat-card",
		"data-supermemory-card": meta.kind
	}, (0, react.createElement)("button", {
		key: "head",
		type: "button",
		className: "sm-chat-card-head",
		"aria-expanded": String(open),
		"aria-label": t(open ? "chat.card.collapse" : "chat.card.expand"),
		onClick: toggle
	}, (0, react.createElement)("span", {
		key: "dot",
		className: "sm-chat-card-dot",
		"aria-hidden": "true"
	}, "↔"), (0, react.createElement)("span", {
		key: "title",
		className: "sm-chat-card-title"
	}, title), (0, react.createElement)("span", {
		key: "kind",
		className: "sm-chat-card-badge"
	}, kind), time ? (0, react.createElement)("time", {
		key: "time",
		className: "sm-chat-card-time"
	}, time) : null, (0, react.createElement)("span", {
		key: "chevron",
		className: "sm-chat-card-chevron",
		"aria-hidden": "true"
	}, open ? "▴" : "▾")), open ? (0, react.createElement)("div", {
		key: "body",
		className: "sm-chat-card-body"
	}, (0, react.createElement)("dl", {
		key: "fields",
		className: "sm-chat-card-fields"
	}, fieldRow(t("chat.card.task"), meta.task, "task"), fieldRow(t("chat.card.topicSet"), meta.topicSetTitle, "set"), fieldRow(t("chat.card.capability"), meta.capability, "cap"), fieldRow(t("chat.card.dispatch"), receipt, "receipt"), meta.groupId ? fieldRow(t("chat.card.kind.group"), meta.groupId, "group") : null, fieldRow(t("chat.card.sourceId"), meta.fromSessionId, "source")), body ? (0, react.createElement)("pre", {
		key: "text",
		className: "sm-chat-card-text"
	}, body) : (0, react.createElement)("div", {
		key: "empty",
		className: "sm-chat-card-empty"
	}, t("chat.card.empty"))) : null);
}
/**
* Build the keyed-cell component for one host node kind.
* Card-marked messages render the card; everything else is delegated to the
* host's shipped renderer, so no other user/trigger message changes.
*/
function createCardComponent(key, ours) {
	return function SupermemoryChatNodeCard(props) {
		const env = props.smCardEnv;
		const node = props.node;
		const meta = cardMetaOf(node?.data?.source);
		if (!meta) {
			const Original = env?.findOriginal(key, ours);
			if (Original !== void 0) return (0, react.createElement)(Original, delegationProps(props, env));
			const fallback = contentText(node?.data?.content);
			return fallback ? (0, react.createElement)("div", {
				key: "fallback",
				className: "sm-chat-card-fallback"
			}, (0, react.createElement)("pre", {
				key: "text",
				className: "sm-chat-card-text"
			}, fallback)) : null;
		}
		return (0, react.createElement)(SupermemoryCard, {
			meta,
			env,
			node
		});
	};
}
/** Register one cell (called for both directions). */
function registerCell(ctx, key) {
	const id = "supermemory-chat-card-" + key;
	return ctx.slots.register({
		name: "conversation.chat.node",
		key,
		id,
		priority: -100,
		locale: CHAT_LOCALE_NS,
		inject: () => ({
			smCardEnv: {
				t: translator(ctx),
				findOriginal: (target, ours) => findOriginal(ctx, target, ours)
			},
			...key === "user" || key === "steering" ? { renderSlotChain: () => null } : {}
		})
	}, createCardComponent(key, id));
}
/** Inject the card stylesheet once per page. */
function ensureCss() {
	if (typeof document === "undefined") return;
	if (document.getElementById(CSS_ID)) return;
	const style = document.createElement("style");
	style.id = CSS_ID;
	style.textContent = `
.sm-chat-card{margin:6px 0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));overflow:hidden;font-size:12.5px}
.sm-chat-card-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sm-chat-card-head:hover{background:rgba(255,255,255,.04)}
.sm-chat-card-dot{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));font-size:11px;opacity:.85}
.sm-chat-card-title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-chat-card-badge{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));opacity:.8}
.sm-chat-card-time{flex:none;margin-left:auto;font-size:11px;opacity:.55}
.sm-chat-card-chevron{flex:none;font-size:11px;opacity:.6}
.sm-chat-card-body{padding:0 12px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sm-chat-card-fields{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:8px 0}
.sm-chat-card-field{display:contents}
.sm-chat-card-field-k{opacity:.6;white-space:nowrap}
.sm-chat-card-field-v{min-width:0;word-break:break-word}
.sm-chat-card-text{margin:0;padding:8px;border-radius:8px;background:rgba(0,0,0,.18);white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.5}
.sm-chat-card-empty{opacity:.6;padding:6px 0}
.sm-chat-card-fallback{margin:6px 0}
`;
	document.head.append(style);
}
/**
* Mount the two shadowing card cells.
*
* If the shell does not expose raw registrations, the plugin deliberately does
* NOT shadow anything: replacing a cell without a way to delegate would blank
* every ordinary user message. That degradation is logged (never silent).
* @param ctx - browser root context.
*/
function attachChatCards(ctx) {
	if (typeof ctx.slots.entries !== "function") {
		console.warn("supermemory: conversation.chat.node entries() unavailable; hub/branch chat card not mounted");
		return;
	}
	ensureCss();
	ctx.effect(() => ctx.slots.inject("conversation.chat.node", () => {
		const disposers = [
			"user",
			"steering",
			"turn-trigger",
			"context"
		].map((cell) => registerCell(ctx, cell));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}), "supermemory: chat card");
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
		createMemory: (cwd, text, key, title, tags) => call("createMemory", cwd, text, key, title, tags),
		updateMemory: (cwd, id, text, key, title, tags) => call("updateMemory", cwd, id, text, key, title, tags),
		deleteMemory: (cwd, id) => call("deleteMemory", cwd, id),
		setMemoryStatus: (cwd, id, status) => call("setMemoryStatus", cwd, id, status),
		listMemoryCollections: (cwd) => call("listMemoryCollections", cwd),
		listMemoriesByCollection: (cwd, collectionId, query) => call("listMemoriesByCollection", cwd, collectionId, query, 200),
		getMemoryDetail: (cwd, id) => call("getMemoryDetail", cwd, id),
		getHubPolicy: (cwd) => call("getHubPolicy", cwd),
		setHubPolicy: (cwd, patch) => call("setHubPolicy", cwd, patch),
		cleanupStaleHubPolicy: (cwd) => call("cleanupStaleHubPolicy", cwd),
		getModelDefaults: (cwd) => call("getModelDefaults", cwd),
		setModelDefaults: (cwd, patch) => call("setModelDefaults", cwd, patch),
		listSkills: (cwd) => call("listSkills", cwd),
		updateSkill: (cwd, name, patch) => call("updateSkill", cwd, name, patch),
		createTopicSet: (cwd, title, tags, summary) => call("createTopicSet", cwd, title, tags, summary),
		listHubSessions: (cwd) => call("listHubSessions", cwd),
		listHubBranches: (cwd, hubSessionId, limit) => call("listHubBranches", cwd, hubSessionId, limit),
		listAllTopicSets: (cwd) => call("listAllTopicSets", cwd),
		listAllBranches: (cwd, topicSetId, limit) => call("listAllBranches", cwd, topicSetId, limit),
		readSessionMessages: (sessionId, limit) => call("readSessionMessages", sessionId, limit),
		sendSessionMessage: (sessionId, text) => call("sendSessionMessage", sessionId, text),
		suggestMemoryShape: (text) => call("suggestMemoryShape", text),
		invalidateBadges: (sessionId) => {
			invalidateBadge(sessionId);
		},
		activate: async (sessionId, topicSetId) => call("activate", sessionId, topicSetId),
		updateTopicSetSummary: (id, summary, tags) => call("updateTopicSetSummary", id, summary, tags),
		createTopicSetSession: (cwd, ids, options, firstMessage) => call("createTopicSetSession", cwd, ids, options, firstMessage),
		createHubSession: (cwd, options, firstMessage) => call("createHubSession", cwd, options, firstMessage),
		followupTopicSet: (cwd, topicSetId, text) => call("followupTopicSet", cwd, topicSetId, text),
		listTools: (cwd) => call("listTools", cwd),
		editTool: (id, patch) => call("editTool", id, patch),
		deleteTool: (id) => call("deleteTool", id),
		listAgentPresets: () => call("listAgentPresets"),
		listModelCatalog: () => call("listModelCatalog"),
		listPermissions: () => call("listPermissions"),
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
* Resolve the workspace a click-created hub session should live in.
*
* The MAIN-VIEW session's own cwd wins: with more than one workspace open,
* `workspaces.items[0].path` points the session (and every later write) at the
* wrong project. Both services are optional seams: an older shell simply
* yields '' and the New-session entry then leaves the click to the shell
* instead of creating a session in an unknown workspace.
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
* Open the SuperMemory panel in the shell's main column — the same
* `layout.selectPanel(PANEL_ID)` call the shell's plugin-manager makes.
*
* The shell provides the layout service as a reflected value and its own
* plugins read it as `ctx.layout`; `ctx.get('layout')` is the abstracted form.
* Both are tried, because the reflected property is the verified one while
* `get` keeps this working if the property is renamed. Returns false when
* neither is usable, so the caller can fall back to opening the created
* session directly — never a dead click.
*/
function selectSuperPanel(ctx) {
	try {
		const layout = ctx.layout ?? ctx.get("layout");
		const select = layout?.selectPanel;
		if (typeof select !== "function") return false;
		Promise.resolve(select.call(layout, PANEL_ID)).catch(() => {
			try {
				ctx.get("uiWorkspace")?.startSession();
			} catch {}
		});
		return true;
	} catch {
		return false;
	}
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
		attachChatCards(ctx);
	} catch (error) {
		console.error("supermemory: chat card registration failed", error);
	}
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
	contribute("new-session entry", () => {
		ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
			name: "shell.overlay",
			id: "supermemory-new-session",
			order: 30,
			locale: NS,
			inject: () => ({
				api,
				cwd: () => resolveCwd(ctx),
				selectPanel: () => selectSuperPanel(ctx)
			})
		}, NewSessionChoice)), "supermemory: new-session entry");
	});
	contribute("session badge", () => {
		ctx.effect(() => ctx.slots.inject("sidebar.session.row.trailing", () => ctx.slots.register({
			name: "sidebar.session.row.trailing",
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
