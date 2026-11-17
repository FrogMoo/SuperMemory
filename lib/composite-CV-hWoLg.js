import { i as loadHostModule, t as newId } from "./store-DegBEROs.js";
// src/composite.ts
/** Signature key for one tool sequence. */
function sequenceKey(workspaceKey, tools) {
	return `ws/${workspaceKey}/seq/${tools.join(">")}`;
}
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
/** Register one composite tool; returns its disposer. */
async function registerComposite(ctx, store, spec) {
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
	return ctx.tools.register(tools.defineTool({
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
			return {
				status: "completed",
				steps: completed,
				summary: `${spec.description}：${texts.join("，")}`
			};
		}
	}));
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
* Pre-execute soft hint (§2.3): when the model is about to call the FIRST
* tool of a known composite by hand, attach a gentle note. Additive only —
* the waterfall decision is passed through untouched.
*/
function attachCompositeHint(ctx, store) {
	return ctx.on("tools/pre-execute", async (exec, next) => {
		const decision = await next();
		if (decision.kind !== "allow") return decision;
		try {
			const name = exec.name;
			if (!name) return decision;
			for (const [, record] of store.toolMemory.entries()) {
				if (record.kind !== "composite" || record.status !== "active" || !record.entry) continue;
				const spec = JSON.parse(record.entry);
				if (spec.steps[0]?.tool !== name) continue;
				const hint = (await loadHostModule("@deepseek-ai/dsh-llm")).createUserMessage({
					content: [{
						type: "text",
						text: `[SuperMemory 提示] 检测到重复流程：可直接调用组合工具 ${spec.name} 一次完成（${spec.steps.map((s) => s.tool).join(" → ")}）。`
					}],
					source: {
						kind: "supermemory",
						form: "notice",
						summary: "组合工具提示"
					}
				});
				return {
					...decision,
					additionalContexts: [...decision.additionalContexts ?? [], hint]
				};
			}
		} catch {}
		return decision;
	});
}
export { attachCompositeHint, compileComposite, parseArgs, persistComposite, rebuildComposites, registerComposite, sequenceKey };
