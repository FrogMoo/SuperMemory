import { a as __exportAll, i as loadHostModule, t as newId } from "./store-BoAQ0oHo.js";
// src/composite.ts
var composite_exports = /* @__PURE__ */ __exportAll({
	compileComposite: () => compileComposite,
	parseArgs: () => parseArgs,
	persistComposite: () => persistComposite,
	rebuildComposites: () => rebuildComposites,
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
	return {
		name: `sm_composite_${signal.pattern.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 24) || "seq"}`,
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
async function persistComposite(store, spec, signalKey) {
	const id = newId("tm");
	const record = {
		kind: "composite",
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
async function rebuildComposites(ctx, store) {
	let registered = 0;
	for (const [, record] of [...store.toolMemory.entries()]) {
		if (record.kind !== "composite" || record.status !== "active" || !record.entry) continue;
		try {
			await registerComposite(ctx, store, JSON.parse(record.entry));
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
	if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) return {
		status: "error",
		message: "工具定义缺少步骤，无法编辑。"
	};
	const next = {
		...spec,
		...patch.description !== void 0 ? { description: String(patch.description).slice(0, 500) } : {},
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
	if (next.steps.length === 0 || next.steps.some((step) => !step.tool)) return {
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
			description: next.description
		}));
		return {
			status: "ok",
			message: `已停用组合工具 ${next.name}（重启后不会重新注册）。`,
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
		description: next.description,
		entry: JSON.stringify(next),
		status: "active"
	}));
	return {
		status: "ok",
		message: `已更新组合工具 ${next.name}。`,
		id
	};
}
/**
* Composite near-miss hints moved to src/activity.ts: tools/post-execute can
* carry additionalContexts for the next request, tools/pre-execute cannot.
*/
export { persistComposite as a, liveCompositeSpecs as i, composite_exports as n, registerComposite as o, editCompositeTool as r, compileComposite as t };
