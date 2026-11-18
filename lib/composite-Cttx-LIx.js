import { a as __exportAll, i as loadHostModule, t as newId } from "./store-DmWKwFTx.js";
import { i as normalizeTags, n as deriveTitle } from "./retrieval-CyfG1iBH.js";
import { spawnSync } from "node:child_process";
// src/composite.ts
/**
* Composite tools (P3 / §2.3): repeated tool sequences become ONE call.
*
* The maintenance loop counts tool-call sequence signatures; past the
* threshold the plugin PROPOSES固化 at the next user interaction (never
* interrupting). On confirmation the sequence is compiled into a composite
* tool whose varying arguments become parameters, registered through the
* host's `defineTool` and persisted in the `tool_memory` table — so a restart
* rebuilds the registration from durable JSON.
*
* Nested dispatch reuses `ctx.tools.execute`, so member calls keep the full
* pre/post-execute policy chain, guards and durable tool/result events.
*
* R22 能力（capability）：同一张表也承载"固化的能力"——入口命令 + 文档 +
* 适用范围 + 路由描述 + 可一键执行（见文末 capability 区）。序列回答"按什么
* 顺序调哪些工具"，能力回答"这件事现在怎么做"，由 memory_toolize register
* 录入、rebuildComposites 重建、管理台一键执行（默认预演，写操作二次确认）。
* @module supermemory/composite
*/
var composite_exports = /* @__PURE__ */ __exportAll({
	capabilityRecordsOf: () => capabilityRecordsOf,
	compileComposite: () => compileComposite,
	liveCompositeSpecs: () => liveCompositeSpecs,
	parseArgs: () => parseArgs,
	persistComposite: () => persistComposite,
	rebuildComposites: () => rebuildComposites,
	registerCapability: () => registerCapability,
	registerComposite: () => registerComposite
});
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
/**
* Compile a composite spec from a signal's recorded samples: steps come from
* the latest sample; parameters are the scalar arguments that varied.
*/
function compileComposite(signal, samples) {
	const latest = samples[samples.length - 1] ?? {
		tools: [],
		args: []
	};
	const steps = latest.tools.map((tool, index) => ({
		tool,
		arguments: parseArgs(latest.args[index])
	}));
	const parameters = [];
	steps.forEach((step, stepIndex) => {
		for (const [key, value] of Object.entries(step.arguments)) {
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
			if (samples.some((sample) => {
				const other = parseArgs(sample.args[stepIndex])[key];
				return other !== void 0 && other !== value;
			})) parameters.push({
				name: `p${stepIndex}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_"),
				step: stepIndex,
				key,
				description: `${step.tool} 的 ${key}`
			});
		}
	});
	const name = `sm_composite_${signal.pattern.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24) || "seq"}`;
	return {
		name,
		title: deriveTitle(`组合工具：${latest.tools.join(" → ")}`, name),
		tags: normalizeTags([...new Set(latest.tools)]),
		description: `组合工具：${latest.tools.join(" → ")}（由重复流程 ${signal.count} 次后固化）`,
		steps,
		parameters
	};
}
/** Live composite registrations: spec name -> disposer (for edit/re-register). */
const liveComposites = /* @__PURE__ */ new Map();
/** Names of currently registered composite tools (for panel liveness). */
const liveCompositeSpecs = /* @__PURE__ */ new Set();
/** Increment one composite's durable use counter (matched by spec name). */
function bumpCompositeUse(store, name) {
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		try {
			if (JSON.parse(record.entry).name !== name) continue;
		} catch {
			continue;
		}
		store.toolMemory.update(id, (r) => ({
			...r,
			useCount: r.useCount + 1
		})).catch(() => {});
		return;
	}
}
/** Register one composite tool; returns its disposer. */
async function registerComposite(ctx, store, spec) {
	const previous = liveComposites.get(spec.name);
	if (previous) {
		try {
			previous();
		} catch {}
		liveComposites.delete(spec.name);
		liveCompositeSpecs.delete(spec.name);
	}
	const tools = await loadHostModule("@deepseek-ai/dsh-tools");
	if (spec.kind === "capability" && spec.entry) {
		const capSpec = spec;
		const disposer = ctx.tools.register(tools.defineTool(capabilityToolDef(store, capSpec)));
		liveComposites.set(spec.name, disposer);
		liveCompositeSpecs.add(spec.name);
		return disposer;
	}
	const steps = spec.steps.map((step) => ({
		tool: step.tool,
		arguments: parseArgs(step.arguments)
	}));
	const properties = {};
	for (const parameter of spec.parameters) properties[parameter.name] = {
		type: "string",
		description: parameter.description
	};
	const disposer = ctx.tools.register(tools.defineTool({
		name: spec.name,
		description: spec.description + "（一次调用完成整个确定性子序列）",
		parameters: properties,
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: ["completed", "failed"],
						required: true
					},
					steps: {
						type: "integer",
						required: true
					},
					summary: {
						type: "string",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.summary ?? "")
			}]
		},
		async execute(args, exec) {
			const texts = [];
			let completed = 0;
			for (const [index, step] of steps.entries()) {
				const arguments_ = { ...step.arguments };
				for (const parameter of spec.parameters) {
					if (parameter.step !== index) continue;
					const override = args[parameter.name];
					if (override !== void 0) arguments_[parameter.key] = override;
				}
				try {
					const result = (await ctx.tools.execute({
						calls: [{
							callId: `${spec.name}:${index}`,
							name: step.tool,
							arguments: arguments_
						}],
						signal: exec.signal,
						...exec.agent ? { agent: exec.agent } : {},
						...exec.toolSet !== void 0 ? { toolSet: exec.toolSet } : {}
					})).results[0];
					if (result?.isError) return {
						status: "failed",
						steps: completed,
						summary: `第 ${index + 1} 步 ${step.tool} 失败：${result.content?.map((c) => c.text ?? "").join("") || "未知错误"}`
					};
					completed++;
					texts.push(`${step.tool} ✓`);
				} catch (error) {
					return {
						status: "failed",
						steps: completed,
						summary: `第 ${index + 1} 步 ${step.tool} 异常：${String(error).slice(0, 160)}`
					};
				}
			}
			bumpCompositeUse(store, spec.name);
			return {
				status: "completed",
				steps: completed,
				summary: `${spec.description}：${texts.join("，")}`
			};
		}
	}));
	liveComposites.set(spec.name, disposer);
	liveCompositeSpecs.add(spec.name);
	return disposer;
}
/** Persist a composite spec into tool_memory (durable definition JSON). */
async function persistComposite(store, spec, signalKey, workspaceKey) {
	const id = newId("tm");
	const record = {
		kind: "composite",
		...workspaceKey ? { workspaceKey } : {},
		title: spec.title ?? deriveTitle(spec.description, spec.name),
		tags: normalizeTags(spec.tags ?? spec.name),
		trigger: signalKey,
		description: spec.description,
		entry: JSON.stringify(spec),
		useCount: 0,
		status: "active"
	};
	await store.toolMemory.put(id, record);
	return id;
}
/** Rebuild-register every active composite from durable JSON (P3 restart). */
async function rebuildComposites(ctx, store, deps) {
	const register = deps?.register ?? registerComposite;
	let registered = 0;
	for (const [, record] of [...store.toolMemory.entries()]) {
		if (record.kind !== "composite" || record.status !== "active" || !record.entry) continue;
		try {
			await register(ctx, store, JSON.parse(record.entry));
			registered++;
		} catch {}
	}
	return registered;
}
/**
* R6: edit one composite tool in place. Applies the patch to the durable
* definition, re-registers the tool (so the model sees the new description
* and behaviour immediately) and persists the change. The tool NAME is
* stable — renaming a registered tool is not supported.
*/
async function editCompositeTool(ctx, store, id, patch) {
	const record = store.toolMemory.get(id);
	if (!record || record.kind !== "composite") return {
		status: "error",
		message: "组合工具不存在。"
	};
	let spec;
	try {
		spec = JSON.parse(record.entry);
	} catch {
		return {
			status: "error",
			message: "工具定义损坏，无法编辑。"
		};
	}
	if (!spec) return {
		status: "error",
		message: "工具定义损坏，无法编辑。"
	};
	if (spec.kind === "capability") {
		if (!spec.entry) return {
			status: "error",
			message: "能力定义缺少入口命令，无法编辑。"
		};
	} else if (!Array.isArray(spec.steps) || spec.steps.length === 0) return {
		status: "error",
		message: "工具定义缺少步骤，无法编辑。"
	};
	const next = {
		...spec,
		...patch.title !== void 0 ? { title: String(patch.title).slice(0, 80) } : {},
		...patch.tags !== void 0 ? { tags: normalizeTags(patch.tags) } : {},
		...patch.description !== void 0 ? { description: String(patch.description).slice(0, 500) } : {},
		...patch.entry !== void 0 ? { entry: String(patch.entry).slice(0, 300) } : {},
		...patch.doc !== void 0 ? { doc: String(patch.doc).slice(0, 300) } : {},
		...patch.scope !== void 0 ? { scope: String(patch.scope).slice(0, 300) } : {},
		...patch.runnable !== void 0 ? { runnable: Boolean(patch.runnable) } : {},
		...patch.dryRunArg !== void 0 ? { dryRunArg: String(patch.dryRunArg).slice(0, 80) } : {},
		...patch.writeConfirm !== void 0 ? { writeConfirm: Boolean(patch.writeConfirm) } : {},
		...patch.routeNote !== void 0 ? { routeNote: String(patch.routeNote).slice(0, 500) } : {},
		...patch.steps !== void 0 ? { steps: patch.steps.map((step) => ({
			tool: String(step.tool ?? ""),
			arguments: parseArgs(step.arguments ?? {})
		})) } : {},
		...patch.parameters !== void 0 ? { parameters: patch.parameters.map((p) => ({
			name: String(p.name ?? ""),
			step: Number(p.step) || 0,
			key: String(p.key ?? ""),
			description: String(p.description ?? "")
		})) } : {}
	};
	if (next.kind !== "capability" && (next.steps.length === 0 || next.steps.some((step) => !step.tool))) return {
		status: "error",
		message: "步骤不能为空，且每步都需要工具名。"
	};
	if (patch.status !== void 0 && patch.status !== "active" && patch.status !== "retired") return {
		status: "error",
		message: "status 仅支持 active / retired。"
	};
	if (patch.status === "retired") {
		const dispose = liveComposites.get(next.name);
		if (dispose) try {
			dispose();
		} catch {}
		liveComposites.delete(next.name);
		liveCompositeSpecs.delete(next.name);
		await store.toolMemory.update(id, (r) => ({
			...r,
			status: "retired",
			description: next.description,
			entry: JSON.stringify(next),
			...next.title !== void 0 ? { title: next.title } : {},
			...next.tags !== void 0 ? { tags: next.tags } : {}
		}));
		return {
			status: "ok",
			message: `已停用${next.kind === "capability" ? "能力" : "组合工具"} ${next.name}（重启后不会重新注册）。`,
			id
		};
	}
	try {
		const previous = liveComposites.get(next.name);
		if (previous) try {
			previous();
		} catch {}
		liveComposites.delete(next.name);
		liveCompositeSpecs.delete(next.name);
		const dispose = await registerComposite(ctx, store, next);
		liveComposites.set(next.name, dispose);
		liveCompositeSpecs.add(next.name);
	} catch (error) {
		return {
			status: "error",
			message: `重新注册失败：${String(error).slice(0, 200)}`
		};
	}
	await store.toolMemory.update(id, (r) => ({
		...r,
		title: next.title ?? r.title,
		tags: next.tags ?? r.tags,
		description: next.description,
		entry: JSON.stringify(next),
		status: "active"
	}));
	return {
		status: "ok",
		message: `已更新${next.kind === "capability" ? "能力" : "组合工具"} ${next.name}。`,
		id
	};
}
/**
* R6+: delete one composite tool for good. Unregisters the live tool when it
* is registered, drops the durable definition, and drops the sequence signal
* that created it — so the same flow must cross the threshold AGAIN before a
* new composite may be registered (a delete is not a silent retire).
*/
async function deleteCompositeTool(ctx, store, id) {
	const record = store.toolMemory.get(id);
	if (!record || record.kind !== "composite") return {
		status: "error",
		message: "组合工具不存在。"
	};
	let name = id;
	try {
		name = JSON.parse(record.entry).name ?? id;
	} catch {}
	const dispose = liveComposites.get(name);
	if (dispose) try {
		dispose();
	} catch {}
	liveComposites.delete(name);
	liveCompositeSpecs.delete(name);
	await store.toolMemory.delete(id);
	if (record.trigger) try {
		await store.signals.delete(record.trigger);
	} catch {}
	return {
		status: "ok",
		message: `已删除组合工具 ${name}。`,
		id
	};
}
/** 合法逻辑名：字母/数字/-/_，≤41 字符（工具名再派生 sm_composite_ 前缀）。 */
function isValidCapabilityName(name) {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(name);
}
/** 逻辑名 → 注册工具名（沿用 sm_composite_ 命名约定）。 */
function capabilityToolName(name) {
	return "sm_composite_" + (String(name).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "capability");
}
/** Build + validate one capability spec (pure: no host, no IO). */
function buildCapabilitySpec(input) {
	const name = String(input.name ?? "").trim();
	if (!isValidCapabilityName(name)) return {
		status: "error",
		message: "能力名称只能包含字母/数字/-/_（≤41 字符）且以字母或数字开头。"
	};
	const entry = String(input.entry ?? "").trim();
	if (!entry) return {
		status: "error",
		message: "入口命令（entry）不能为空。"
	};
	if (entry.length > 300) return {
		status: "error",
		message: "入口命令过长（≤300 字符）。"
	};
	const description = String(input.description ?? "").trim();
	if (!description) return {
		status: "error",
		message: "描述不能为空（模型靠它路由到本能力）。"
	};
	if (description.length > 500) return {
		status: "error",
		message: "描述过长（≤500 字符）。"
	};
	const toolName = capabilityToolName(name);
	return {
		status: "ok",
		spec: {
			name: toolName,
			kind: "capability",
			title: String(input.title ?? "").trim().slice(0, 80) || deriveTitle(description, toolName),
			tags: normalizeTags(input.tags ?? [name]),
			description,
			steps: [],
			parameters: [],
			entry,
			runnable: input.runnable === void 0 ? true : Boolean(input.runnable),
			...String(input.doc ?? "").trim() ? { doc: String(input.doc).trim().slice(0, 300) } : {},
			...String(input.scope ?? "").trim() ? { scope: String(input.scope).trim().slice(0, 300) } : {},
			...String(input.dryRunArg ?? "").trim() ? { dryRunArg: String(input.dryRunArg).trim().slice(0, 80) } : {},
			...input.writeConfirm !== void 0 ? { writeConfirm: Boolean(input.writeConfirm) } : {},
			...String(input.routeNote ?? "").trim() ? { routeNote: String(input.routeNote).trim().slice(0, 500) } : {}
		}
	};
}
/** 输出截断：工具结果/HTTP 响应都不该无上限增长。 */
const CAP_OUTPUT_CLIP = 8e3;
/** 默认超时：同步子进程，120s 足够一次同步/构建类命令。 */
const CAP_TIMEOUT_MS = 12e4;
function clipCapOutput(text) {
	return text.length > CAP_OUTPUT_CLIP ? text.slice(0, CAP_OUTPUT_CLIP) + `\n…（输出过长已截断，原 ${text.length} 字符）` : text;
}
/**
* Execute one capability's entry command inside its scope directory.
*
* 安全闸：① runnable=false 直接拒绝；② 定义了 dryRunArg 且调用方未显式关闭时
* 默认预演；③ writeConfirm 能力的真实执行必须 confirm=true，否则返回
* needs-confirm 且不执行。
*/
function runCapability(spec, options = {}) {
	if (spec.kind !== "capability" || !spec.entry) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun: false,
		command: "",
		summary: "不是可执行的能力定义（缺少 entry）。"
	};
	if (spec.runnable === false) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun: Boolean(options.dryRun),
		command: spec.entry,
		summary: "该能力未开放执行（runnable=false）。"
	};
	const dryRun = options.dryRun !== void 0 ? Boolean(options.dryRun) : options.confirm === true ? false : Boolean(spec.dryRunArg);
	const command = dryRun && spec.dryRunArg ? `${spec.entry} ${spec.dryRunArg}` : spec.entry;
	if (dryRun && spec.writeConfirm && !spec.dryRunArg) return {
		status: "failed",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun,
		command,
		summary: "该能力标记了写操作确认（writeConfirm）但未定义预演参数（dryRunArg），无法预演；确认执行请显式传 confirm=true。"
	};
	if (!dryRun && spec.writeConfirm && options.confirm !== true) return {
		status: "needs-confirm",
		stdout: "",
		stderr: "",
		durationMs: 0,
		dryRun,
		command,
		summary: `该能力真实执行可能写远端/改状态（writeConfirm）：确认执行请显式传 confirm=true；只要预演可保持缺省（自动追加 ${spec.dryRunArg ?? "预演参数"}）。`
	};
	const started = Date.now();
	const child = spawnSync(command, {
		shell: true,
		cwd: spec.scope && spec.scope.trim() ? spec.scope : process.cwd(),
		encoding: "utf8",
		timeout: CAP_TIMEOUT_MS,
		maxBuffer: 16777216,
		env: process.env
	});
	const durationMs = Date.now() - started;
	const stdout = clipCapOutput(String(child.stdout ?? ""));
	const stderr = clipCapOutput(String(child.stderr ?? ""));
	const exitCode = typeof child.status === "number" ? child.status : void 0;
	return {
		status: Boolean(child.error) || exitCode === void 0 ? "failed" : exitCode === 0 ? "completed" : "failed",
		exitCode,
		stdout,
		stderr,
		durationMs,
		dryRun,
		command,
		summary: `${command} → ${child.error ? `启动失败：${String(child.error).slice(0, 120)}` : `exit ${exitCode}`}（${dryRun ? "预演" : "实跑"}，${durationMs}ms）`
	};
}
/**
* The model-visible tool definition of one capability. The description carries
* the routing note (when to prefer it), the entry command, the dry-run default
* and the write-confirm rule, so the model never has to guess the semantics.
*/
function capabilityToolDef(store, spec) {
	const semantics = "（能力：在适用范围 " + (spec.scope || "当前目录") + " 内执行入口命令 `" + spec.entry + "`；" + (spec.dryRunArg ? `默认追加预演参数 ${spec.dryRunArg}（只读不改）；` : "") + (spec.writeConfirm ? "真实执行可能写远端/改状态：confirm=true 表示确认真实执行（自动脱离预演缺省）；" : "") + (spec.doc ? `详细流程见 ${spec.doc}；` : "") + (spec.runnable === false ? "当前未开放执行。" : "") + "返回 exitCode/stdout/stderr/durationMs。）";
	return {
		name: spec.name,
		description: spec.description + (spec.routeNote ? "。" + spec.routeNote : "") + semantics,
		parameters: {
			dryRun: {
				type: "boolean",
				description: "true=强制预演；缺省时若能力定义了预演参数（dryRunArg）则自动预演"
			},
			confirm: {
				type: "boolean",
				description: "真实执行写操作能力（writeConfirm）时的二次确认，必须为 true"
			}
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"completed",
							"failed",
							"needs-confirm"
						],
						required: true
					},
					exitCode: { type: "integer" },
					stdout: { type: "string" },
					stderr: { type: "string" },
					durationMs: { type: "integer" },
					dryRun: { type: "boolean" },
					command: { type: "string" },
					summary: {
						type: "string",
						required: true
					}
				},
				additionalProperties: false
			},
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: (v.status === "needs-confirm" ? "需要确认：" : "") + String(v.summary ?? "")
				}];
			}
		},
		async execute(args, _exec) {
			const result = runCapability(spec, {
				...typeof args.dryRun === "boolean" ? { dryRun: args.dryRun } : {},
				...typeof args.confirm === "boolean" ? { confirm: args.confirm } : {}
			});
			if (result.status !== "needs-confirm") bumpCompositeUse(store, spec.name);
			return result;
		}
	};
}
/** Default seam: the real host registry and the real durable table. */
function defaultCapabilityDeps() {
	return {
		register: registerComposite,
		persist: persistComposite,
		toolExists: (ctx, name) => Boolean(ctx.tools.get(name))
	};
}
/** Dispose one live registration by tool name (best-effort; re-register replaces). */
function disposeComposite(name) {
	const dispose = liveComposites.get(name);
	if (dispose) try {
		dispose();
	} catch {}
	liveComposites.delete(name);
	liveCompositeSpecs.delete(name);
}
/**
* Register one capability: validate → durable-record lookup (same tool name =
* UPDATE in place, so re-registering the seed is idempotent) → host-tool
* conflict check (only for NEW names) → register the live tool → persist.
*/
async function registerCapability(ctx, store, input, workspaceKey, deps) {
	const built = buildCapabilitySpec(input);
	if (built.status === "error") return {
		status: "error",
		message: built.message
	};
	const spec = built.spec;
	const seam = deps ?? defaultCapabilityDeps();
	let existingId;
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		try {
			if (JSON.parse(record.entry).name === spec.name) {
				existingId = id;
				break;
			}
		} catch {}
	}
	if (!existingId) try {
		if (seam.toolExists(ctx, spec.name)) return {
			status: "error",
			message: `工具名 ${spec.name} 已被占用（宿主已有同名工具）。`
		};
	} catch {}
	const hasRegistry = typeof ctx.tools?.register === "function";
	try {
		if (existingId) {
			disposeComposite(spec.name);
			if (hasRegistry) await seam.register(ctx, store, spec);
			await store.toolMemory.update(existingId, (r) => ({
				...r,
				title: spec.title ?? r.title,
				tags: spec.tags ?? r.tags,
				description: spec.description,
				entry: JSON.stringify(spec),
				...workspaceKey ? { workspaceKey } : {}
			}));
			return {
				status: "ok",
				message: `已更新能力 ${spec.name}（入口 ${spec.entry}）。`,
				id: existingId,
				name: spec.name
			};
		}
		if (hasRegistry) await seam.register(ctx, store, spec);
		const id = await seam.persist(store, spec, "capability/" + spec.name, workspaceKey);
		return {
			status: "ok",
			message: hasRegistry ? `已注册能力 ${spec.name}（入口 ${spec.entry}${spec.dryRunArg ? `，默认预演 ${spec.dryRunArg}` : ""}${spec.writeConfirm ? "，写操作需 confirm=true" : ""}）。` : `已保存能力 ${spec.name}（宿主未提供工具注册器，重启/重载后生效）。`,
			id,
			name: spec.name
		};
	} catch (error) {
		return {
			status: "error",
			message: `注册失败：${String(error).slice(0, 200)}`
		};
	}
}
/** Every durable capability record (broken JSON skipped) — for list surfaces. */
function capabilityRecordsOf(store) {
	const out = [];
	for (const [id, record] of store.toolMemory.entries()) {
		if (record.kind !== "composite" || !record.entry) continue;
		try {
			const spec = JSON.parse(record.entry);
			if (spec?.kind !== "capability" || !spec.entry) continue;
			out.push({
				id,
				spec,
				useCount: record.useCount,
				status: record.status
			});
		} catch {}
	}
	return out;
}
export { editCompositeTool as a, registerCapability as c, deleteCompositeTool as i, registerComposite as l, compileComposite as n, liveCompositeSpecs as o, composite_exports as r, persistComposite as s, bumpCompositeUse as t, runCapability as u };
